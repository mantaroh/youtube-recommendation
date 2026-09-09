import { describe, expect, it } from 'vitest'
import { JOB_LEASE_MINUTES } from '@ypr/domain'
import worker from '../index.js'
import type { Env } from '../env.js'
import { appendRating } from '../db/ratings.js'
import {
  claimNextJob,
  createJob,
  dropSupersededScoring,
  expireLeases,
  getJob,
  listJobs,
} from '../db/jobs.js'
import { activateModel, createModelVersion, listModelVersions } from '../db/models.js'
import { engineDescription, engineMode, enginePulls } from '../services/runpod/engine.js'
import { submitScoring } from '../services/model/score.js'
import { submitTraining } from '../services/model/train.js'
import { reconcileJobs } from '../services/model/reconcile.js'
import { createTestDatabase } from './d1.js'
import { seedVideo } from './fixtures.js'

/**
 * Collecting jobs instead of delivering them (docs/design/pull-engine.ja.md).
 *
 * The engine is never involved here. What is being tested is the handover: that two
 * runners cannot take the same job, that a runner which disappears does not strand the
 * work, and that the one route reachable without an Access session refuses everything
 * but the right token.
 */

const TOKEN = 'test-token-0123456789abcdef'

function pullEnv(db: D1Database): Env {
  return { DB: db, ENGINE_PULL_TOKEN: TOKEN } as Env
}

async function post(env: Env, path: string, body?: unknown, token: string | null = TOKEN) {
  return worker.fetch(
    new Request(`https://app.test${path}`, {
      method: 'POST',
      ...(token ? { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } } : {}),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
  )
}

async function seedQueuedScoreJob(db: D1Database, videoId = 'youtube:v1'): Promise<string> {
  await seedVideo(db, { id: videoId, title: 'Inside the scheduler' })
  await createModelVersion(db, {
    id: 'mv1',
    profileId: 'default',
    version: 1,
    trainingEventCount: 10,
    now: 1_700_000_000_000,
  })
  await activateModel(db, 'default', 'mv1', 1_700_000_000_000)

  const jobId = 'job-1'
  await createJob(db, {
    id: jobId,
    type: 'score_batch',
    payloadHash: 'hash-1',
    context: { profileId: 'default', modelVersion: 'model-1', videoIds: [videoId] },
    now: 1_700_000_000_000,
  })
  return jobId
}

describe('engine mode', () => {
  it('waits for a runner as soon as a token is set', () => {
    const env = { ENGINE_PULL_TOKEN: TOKEN } as Env
    expect(engineMode(env)).toBe('pull')
    expect(enginePulls(env)).toBe(true)
    expect(engineDescription(env)).toMatch(/runner/)
  })

  it('prefers waiting over spending when both are configured', () => {
    // Two engines set at once is a mistake rather than a choice, and of the two readings
    // the safe one is the one that does not submit anything to a paid endpoint.
    const env = {
      ENGINE_PULL_TOKEN: TOKEN,
      RUNPOD_API_KEY: 'k',
      RUNPOD_ENDPOINT_ID: 'e',
    } as Env
    expect(engineMode(env)).toBe('pull')
  })

  it('leaves the push modes alone', () => {
    expect(engineMode({ PREFERENCE_ENGINE_URL: 'http://127.0.0.1:9000' } as Env)).toBe('local')
    expect(engineMode({ RUNPOD_API_KEY: 'k', RUNPOD_ENDPOINT_ID: 'e' } as Env)).toBe('runpod')
    expect(engineMode({} as Env)).toBe('none')
  })
})

describe('claiming', () => {
  it('hands the same job to only one of two callers', async () => {
    const db = createTestDatabase()
    await seedQueuedScoreJob(db)

    const now = 1_700_000_100_000
    const first = await claimNextJob(db, { now, leaseMs: 60_000 })
    const second = await claimNextJob(db, { now, leaseMs: 60_000 })

    // D1 has no row locks; the claim is one statement precisely so this holds.
    expect(first?.id).toBe('job-1')
    expect(second).toBeNull()
  })

  it('counts a claim as an attempt and stamps a lease', async () => {
    const db = createTestDatabase()
    await seedQueuedScoreJob(db)

    const now = 1_700_000_100_000
    const claimed = await claimNextJob(db, { now, leaseMs: 60_000 })

    expect(claimed?.status).toBe('processing')
    expect(claimed?.attempts).toBe(1)
    expect(claimed?.leaseExpiresAt).toBe(now + 60_000)
  })

  it('takes the oldest first', async () => {
    const db = createTestDatabase()
    await seedQueuedScoreJob(db)
    await createJob(db, {
      id: 'job-2',
      type: 'score_batch',
      payloadHash: 'hash-2',
      context: { profileId: 'default', modelVersion: 'model-1', videoIds: ['youtube:v1'] },
      now: 1_700_000_500_000,
    })

    const claimed = await claimNextJob(db, { now: 1_700_000_900_000, leaseMs: 60_000 })
    expect(claimed?.id).toBe('job-1')
  })
})

describe('leases', () => {
  it('offers the work again when a runner goes away', async () => {
    const db = createTestDatabase()
    await seedQueuedScoreJob(db)

    const claimedAt = 1_700_000_100_000
    await claimNextJob(db, { now: claimedAt, leaseMs: 60_000 })

    // Still held while the lease stands.
    expect(await expireLeases(db, claimedAt + 30_000)).toBe(0)
    expect((await getJob(db, 'job-1'))?.status).toBe('processing')

    expect(await expireLeases(db, claimedAt + 90_000)).toBe(1)
    const returned = await getJob(db, 'job-1')
    expect(returned?.status).toBe('queued')
    expect(returned?.leaseExpiresAt).toBeNull()
    // The attempt is not given back, so a machine that keeps dying still runs out.
    expect(returned?.attempts).toBe(1)
  })

  it('recovers stranded work on the reconciliation pass', async () => {
    const db = createTestDatabase()
    const env = pullEnv(db)
    await seedQueuedScoreJob(db)

    const claimedAt = 1_700_000_100_000
    await claimNextJob(db, { now: claimedAt, leaseMs: JOB_LEASE_MINUTES * 60_000 })

    const summary = await reconcileJobs(env, claimedAt + JOB_LEASE_MINUTES * 60_000 + 1)

    expect(summary.errors).toEqual([])
    expect(summary.retried).toBe(1)
    expect((await getJob(db, 'job-1'))?.status).toBe('queued')
  })
})

describe('the collection routes', () => {
  it('refuses a request with no token, a wrong token, and says nothing useful either way', async () => {
    const db = createTestDatabase()
    const env = pullEnv(db)
    await seedQueuedScoreJob(db)

    const missing = await post(env, '/api/engine/claim', undefined, null)
    const wrong = await post(env, '/api/engine/claim', undefined, 'not-the-token-0123456789')

    expect(missing.status).toBe(403)
    expect(wrong.status).toBe(403)
    // The job is still there: a refused claim must not consume work.
    expect((await getJob(db, 'job-1'))?.status).toBe('queued')
  })

  it('does not exist at all outside pull mode', async () => {
    const db = createTestDatabase()
    const response = await post({ DB: db } as Env, '/api/engine/claim')
    expect(response.status).toBe(404)
  })

  it('hands out a payload assembled from the ids in the job', async () => {
    const db = createTestDatabase()
    const env = pullEnv(db)
    await seedQueuedScoreJob(db)

    const response = await post(env, '/api/engine/claim')
    expect(response.status).toBe(200)

    const body = (await response.json()) as {
      job: { id: string; operation: string; payload: { items: Array<{ id: string; text: string }> } } | null
    }
    expect(body.job?.id).toBe('job-1')
    expect(body.job?.operation).toBe('score_batch')
    // Rebuilt at claim time rather than stored when queued.
    expect(body.job?.payload.items[0]?.id).toBe('youtube:v1')
    expect(body.job?.payload.items[0]?.text).toContain('Inside the scheduler')
  })

  it('reports an empty queue rather than an error', async () => {
    const db = createTestDatabase()
    const response = await post(pullEnv(db), '/api/engine/claim')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ job: null })
  })

  it('applies a result and closes the job', async () => {
    const db = createTestDatabase()
    const env = pullEnv(db)
    await seedQueuedScoreJob(db)
    await post(env, '/api/engine/claim')

    const response = await post(env, '/api/engine/jobs/job-1/result', {
      modelVersion: 'model-1',
      items: [{ id: 'youtube:v1', score: 8.5 }],
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, scoresWritten: 1 })
    expect((await getJob(db, 'job-1'))?.status).toBe('completed')
  })

  it('refuses a result for work it no longer holds', async () => {
    const db = createTestDatabase()
    const env = pullEnv(db)
    await seedQueuedScoreJob(db)
    await claimNextJob(db, { now: 1_700_000_100_000, leaseMs: 1_000 })
    await expireLeases(db, 1_700_000_200_000)

    // The lease ran out and the job is somebody else's now; a late answer would
    // overwrite whatever the current claimant is about to report.
    const response = await post(env, '/api/engine/jobs/job-1/result', {
      modelVersion: 'model-1',
      items: [{ id: 'youtube:v1', score: 8.5 }],
    })

    expect(response.status).toBe(409)
  })

  it('records a failure the runner reports', async () => {
    const db = createTestDatabase()
    const env = pullEnv(db)
    await seedQueuedScoreJob(db)
    await post(env, '/api/engine/claim')

    const response = await post(env, '/api/engine/jobs/job-1/fail', { error: 'out of memory' })
    expect(response.status).toBe(200)

    const job = await getJob(db, 'job-1')
    expect(job?.status).toBe('failed')
    expect(job?.error).toBe('out of memory')
  })

  it('fails a job whose payload cannot be rebuilt instead of blocking the queue', async () => {
    const db = createTestDatabase()
    const env = pullEnv(db)
    await createJob(db, {
      id: 'job-broken',
      type: 'score_batch',
      payloadHash: 'hash-broken',
      context: { profileId: 'default', modelVersion: 'model-1', videoIds: ['youtube:gone'] },
      now: 1_700_000_000_000,
    })
    const goodId = await seedQueuedScoreJob(db)

    const response = await post(env, '/api/engine/claim')
    const body = (await response.json()) as { job: { id: string } | null }

    // The broken one is failed and the next is handed over in the same call.
    expect((await getJob(db, 'job-broken'))?.status).toBe('failed')
    expect(body.job?.id).toBe(goodId)
  })
})

describe('submitting in pull mode', () => {
  it('queues scoring without calling anything', async () => {
    const db = createTestDatabase()
    const env = pullEnv(db)
    await seedVideo(db, { id: 'youtube:v1' })
    await createModelVersion(db, {
      id: 'mv1',
      profileId: 'default',
      version: 1,
      trainingEventCount: 10,
      now: 1_700_000_000_000,
    })
    await activateModel(db, 'default', 'mv1', 1_700_000_000_000)

    // No fetch stub is supplied: a call to an engine would throw rather than pass.
    const submission = await submitScoring(env, 'default', 1_700_000_100_000, {
      videoIds: ['youtube:v1'],
    })

    expect(submission.jobIds).toHaveLength(1)
    const [job] = await listJobs(db)
    expect(job.status).toBe('queued')
    expect(job.runpodJobId).toBeNull()
  })

  it('queues training without calling anything', async () => {
    const db = createTestDatabase()
    const env = pullEnv(db)

    for (let index = 0; index < 12; index++) {
      const id = `youtube:v${index}`
      await seedVideo(db, { id, title: `Video ${index}` })
      await appendRating(db, {
        id: `e${index}`,
        profileId: 'default',
        videoId: id,
        rating: index % 2 === 0 ? 5 : 1,
        createdAt: 1_700_000_000_000 + index,
      })
    }

    const submission = await submitTraining(env, 'default', 1_700_000_100_000)

    expect(submission.jobId).toBeTruthy()
    const job = await getJob(db, submission.jobId)
    expect(job?.status).toBe('queued')
    expect(job?.runpodJobId).toBeNull()
  })
})

describe('activating a model', () => {
  /**
   * Six batches of a hundred ran overnight against a version training had already
   * replaced, and the feed could not read a single one of the rows they produced. The
   * queue outlives a retrain, so this is the ordinary case rather than a rare race.
   */
  it('discards queued batches that name the version being replaced', async () => {
    const db = createTestDatabase()

    for (const [id, version] of [
      ['old-a', 'model-1'],
      ['old-b', 'model-1'],
      ['new-a', 'model-2'],
    ] as const) {
      await createJob(db, {
        id,
        type: 'score_batch',
        payloadHash: `hash-${id}`,
        context: { profileId: 'default', modelVersion: version, videoIds: ['youtube:v1'] },
        now: 1_700_000_000_000,
      })
    }

    const dropped = await dropSupersededScoring(db, 'default', 'model-2')

    expect(dropped).toBe(2)
    expect((await listJobs(db)).map((job) => job.id).sort()).toEqual(['new-a'])
  })

  it('leaves a batch that is already in flight alone', async () => {
    const db = createTestDatabase()
    await createJob(db, {
      id: 'in-flight',
      type: 'score_batch',
      payloadHash: 'hash-in-flight',
      context: { profileId: 'default', modelVersion: 'model-1', videoIds: ['youtube:v1'] },
      now: 1_700_000_000_000,
    })
    // A runner holds a lease on it and will report a result; deleting the row underneath
    // would turn that report into an error for work that is merely obsolete.
    await claimNextJob(db, { now: 1_700_000_000_000, leaseMs: 60_000 })

    expect(await dropSupersededScoring(db, 'default', 'model-2')).toBe(0)
    expect(await getJob(db, 'in-flight')).not.toBeNull()
  })

  it('leaves another profile\'s queue alone', async () => {
    const db = createTestDatabase()
    await createJob(db, {
      id: 'other-profile',
      type: 'score_batch',
      payloadHash: 'hash-other',
      context: { profileId: 'someone-else', modelVersion: 'model-1', videoIds: ['youtube:v1'] },
      now: 1_700_000_000_000,
    })

    expect(await dropSupersededScoring(db, 'default', 'model-2')).toBe(0)
    expect(await getJob(db, 'other-profile')).not.toBeNull()
  })

  /**
   * The count written when the job was queued describes what was asked for. The set is
   * assembled when the job is taken, so an overnight wait means the model learned from
   * more than the row claims — 32 recorded against 35 learned from, in the run that
   * prompted this.
   */
  it('records what the engine trained on, not what was queued', async () => {
    const db = createTestDatabase()
    await createModelVersion(db, {
      id: 'mv2',
      profileId: 'default',
      version: 2,
      trainingEventCount: 32,
      now: 1_700_000_000_000,
    })

    await activateModel(db, 'default', 'mv2', 1_700_000_100_000, undefined, 35)

    const [model] = await listModelVersions(db, 'default')
    expect(model.trainingEventCount).toBe(35)
    expect(model.status).toBe('active')
  })

  it('keeps the queued count when the engine reports none', async () => {
    const db = createTestDatabase()
    await createModelVersion(db, {
      id: 'mv3',
      profileId: 'default',
      version: 3,
      trainingEventCount: 12,
      now: 1_700_000_000_000,
    })

    await activateModel(db, 'default', 'mv3', 1_700_000_100_000)

    const [model] = await listModelVersions(db, 'default')
    expect(model.trainingEventCount).toBe(12)
  })
})
