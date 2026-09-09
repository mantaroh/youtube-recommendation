import { describe, expect, it } from 'vitest'
import type { Video } from '@ypr/domain'
import type { Env } from '../env.js'
import { appendRating } from '../db/ratings.js'
import {
  activateModel,
  activeModel,
  createModelVersion,
  listModelVersions,
  nextVersionNumber,
  saveScores,
  scoresFor,
  unscoredVideoIds,
} from '../db/models.js'
import { createJob, findJobByHash, markFailed, markSubmitted, payloadHash } from '../db/jobs.js'
import { MIN_TRAINING_EVENTS, buildTrainingSet, submitTraining } from '../services/model/train.js'
import { submitScoring } from '../services/model/score.js'
import { reconcileJobs } from '../services/model/reconcile.js'
import { videoText } from '../services/model/text.js'
import { createTestDatabase } from './d1.js'
import { seedVideo, stubFetch } from './fixtures.js'

/**
 * Training, scoring and job reconciliation (design sections 24, 31, 32, 47 and 48).
 *
 * The GPU is never involved: Runpod is a stubbed `fetch`. What is being tested is the
 * bookkeeping around it, which is where the money and the correctness both are — an
 * idempotency check that does not deduplicate pays twice, and a model switch that is
 * not atomic degrades the feed.
 */

const NOW = Date.parse('2026-08-24T00:00:00Z')

function envWith(db: D1Database, fetchImpl?: typeof fetch): Env {
  return {
    DB: db,
    RUNPOD_API_KEY: 'test-key',
    RUNPOD_ENDPOINT_ID: 'test-endpoint',
    ...(fetchImpl ? {} : {}),
  } as Env
}

async function seedRatings(db: D1Database, count: number, rating = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const id = await seedVideo(db, {
      id: `youtube:v${index}`,
      title: `Video ${index}`,
      tags: ['kernel'],
    })
    await appendRating(db, {
      id: `e${index}`,
      profileId: 'default',
      videoId: id,
      rating: rating as never,
      createdAt: NOW - index,
    })
  }
}

describe('the training set', () => {
  it('doubles the 0..5 rating onto the engine’s 0..10 scale', async () => {
    const db = createTestDatabase()
    const id = await seedVideo(db, { id: 'youtube:a' })
    await appendRating(db, {
      id: 'e1', profileId: 'default', videoId: id, rating: 4, createdAt: NOW,
    })

    const events = await buildTrainingSet(db, 'default')
    expect(events).toHaveLength(1)
    expect(events[0]?.rating).toBe(8)
  })

  it('uses the current rating, not every rating ever given', async () => {
    // Design section 11 keeps both events so a change of taste stays visible. Training
    // on both would teach the model a rating the user has since replaced.
    const db = createTestDatabase()
    const id = await seedVideo(db, { id: 'youtube:a' })
    await appendRating(db, { id: 'e1', profileId: 'default', videoId: id, rating: 5, createdAt: 1_000 })
    await appendRating(db, { id: 'e2', profileId: 'default', videoId: id, rating: 1, createdAt: 2_000 })

    const events = await buildTrainingSet(db, 'default')
    expect(events).toHaveLength(1)
    expect(events[0]?.rating).toBe(2)
  })

  it('is ordered deterministically so the same ratings hash the same', async () => {
    const db = createTestDatabase()
    await seedRatings(db, 5)

    const first = await buildTrainingSet(db, 'default')
    const second = await buildTrainingSet(db, 'default')
    expect(first.map((event) => event.itemId)).toEqual(second.map((event) => event.itemId))
    expect(first.map((event) => event.itemId)).toEqual([...first.map((e) => e.itemId)].sort())
  })

  it('sends metadata and nothing else', async () => {
    // Design section 44: the GPU side is given text, and told nothing about who
    // produced it.
    const db = createTestDatabase()
    const id = await seedVideo(db, {
      id: 'youtube:a',
      title: 'Inside the kernel',
      channelTitle: 'Deep Dives',
      tags: ['linux', 'kernel'],
      description: 'A long look at scheduling.',
    })
    await appendRating(db, { id: 'e1', profileId: 'default', videoId: id, rating: 5, createdAt: NOW })

    const [event] = await buildTrainingSet(db, 'default')
    expect(event?.description).toContain('Inside the kernel')
    expect(event?.description).toContain('Deep Dives')
    expect(event?.description).toContain('linux')
    expect(event?.description).not.toContain('default')
  })
})

function sampleVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: 'youtube:a',
    source: 'youtube',
    externalId: 'a',
    channelId: null,
    title: 'Title',
    description: '',
    thumbnailUrl: null,
    publishedAt: NOW,
    durationSeconds: 600,
    viewCount: 1,
    metadata: {},
    discoveredAt: NOW,
    refreshedAt: null,
    ...overrides,
  }
}

describe('videoText', () => {
  it('truncates a very long description rather than sending it whole', () => {
    const text = videoText(
      {
        id: 'youtube:a',
        source: 'youtube',
        externalId: 'a',
        channelId: null,
        title: 'Title',
        description: 'x'.repeat(5_000),
        thumbnailUrl: null,
        publishedAt: NOW,
        durationSeconds: 60,
        viewCount: 1,
        metadata: {},
        discoveredAt: NOW,
        refreshedAt: null,
      },
      null,
    )
    // Anagnorisis runs a descriptor model over anything past its own threshold, and
    // that is the expensive path; truncating first keeps a two-thousand-item batch
    // from becoming two thousand generation runs.
    expect(text.length).toBeLessThan(1_500)
  })

  /**
   * Length was the one thing the ranking could see and the model could not. Ratings on
   * this installation split at three minutes — a mean of 1.2 below, 3.3 above — and none
   * of it could be learned, because the text carried no clue that a video was short.
   */
  it('tells the model how long the video is', () => {
    const text = videoText(sampleVideo({ durationSeconds: 45 }), null)
    expect(text).toContain('Length: 45 seconds (a short)')
  })

  it('names the band rather than only the number', () => {
    // The embedder reads text: "a short" means something in its vocabulary that 45
    // does not, and the band is what the preference is actually about.
    expect(videoText(sampleVideo({ durationSeconds: 150 }), null)).toContain('(a short)')
    expect(videoText(sampleVideo({ durationSeconds: 1_200 }), null)).toContain('(long)')
    expect(videoText(sampleVideo({ durationSeconds: 7_200 }), null)).toContain('(very long)')
    expect(videoText(sampleVideo({ durationSeconds: 400 }), null)).not.toContain('(')
  })

  it('says nothing when the length is unknown', () => {
    // Better silent than asserting a length that was never fetched.
    expect(videoText(sampleVideo({ durationSeconds: null }), null)).not.toContain('Length:')
  })

  it('puts the length before the description, which is the part that gets cut', () => {
    const text = videoText(
      sampleVideo({ durationSeconds: 30, description: 'x'.repeat(5_000) }),
      null,
    )
    expect(text.indexOf('Length:')).toBeLessThan(text.indexOf('xxxx'))
  })
})

describe('submitting a training run', () => {
  it('refuses when there are too few ratings to learn anything', async () => {
    const db = createTestDatabase()
    await seedRatings(db, 3)
    await expect(submitTraining(envWith(db), 'default', NOW)).rejects.toThrow(/at least/)
  })

  it('creates a version, queues a job, and records the Runpod id', async () => {
    const db = createTestDatabase()
    await seedRatings(db, MIN_TRAINING_EVENTS + 2)
    const fetchImpl = stubFetch([['/run', { id: 'runpod-1' }]])

    const submission = await submitTraining(envWith(db), 'default', NOW, { fetchImpl })

    expect(submission.modelVersion).toBe('model-1')
    expect(submission.eventCount).toBe(MIN_TRAINING_EVENTS + 2)

    const versions = await listModelVersions(db, 'default')
    expect(versions[0]?.status).toBe('training')
    // Nothing is live until the GPU says the model exists (design section 48).
    expect(await activeModel(db, 'default')).toBeNull()
  })

  it('does not pay twice for the same ratings', async () => {
    // Design section 47: a second press of "retrain" with nothing rated in between is
    // work already in flight.
    const db = createTestDatabase()
    await seedRatings(db, MIN_TRAINING_EVENTS + 2)
    const fetchImpl = stubFetch([['/run', { id: 'runpod-1' }]])

    const first = await submitTraining(envWith(db), 'default', NOW, { fetchImpl })
    const second = await submitTraining(envWith(db), 'default', NOW, { fetchImpl })

    expect(second.deduplicatedFrom).toBe(first.jobId)
    expect((fetchImpl as unknown as { calls: string[] }).calls.filter((url) => url.includes('/run')).length).toBe(1)
  })
})

describe('the job ledger', () => {
  it('hashes the same batch to the same value whatever the order', async () => {
    const a = await payloadHash({ type: 'score_batch', profileId: 'p', modelVersion: 'model-1', ids: ['b', 'a'] })
    const b = await payloadHash({ type: 'score_batch', profileId: 'p', modelVersion: 'model-1', ids: ['a', 'b'] })
    expect(a).toBe(b)
  })

  it('hashes a different model version differently', async () => {
    const a = await payloadHash({ type: 'score_batch', profileId: 'p', modelVersion: 'model-1', ids: ['a'] })
    const b = await payloadHash({ type: 'score_batch', profileId: 'p', modelVersion: 'model-2', ids: ['a'] })
    expect(a).not.toBe(b)
  })

  it('lets a failed job be resubmitted, unlike one that is still running', async () => {
    const db = createTestDatabase()
    const hash = await payloadHash({ type: 'train', profileId: 'p', modelVersion: 'model-1', ids: ['a'] })

    await createJob(db, { id: 'j1', type: 'train', payloadHash: hash, context: {}, now: NOW })
    expect(await findJobByHash(db, hash)).not.toBeNull()

    await markFailed(db, 'j1', 'out of memory', NOW)
    expect(await findJobByHash(db, hash)).toBeNull()
  })

  it('counts attempts so a hopeless job is eventually left alone', async () => {
    const db = createTestDatabase()
    await createJob(db, { id: 'j1', type: 'train', payloadHash: 'h', context: {}, now: NOW })
    await markSubmitted(db, 'j1', 'r1', NOW)
    await markSubmitted(db, 'j1', 'r2', NOW)

    const job = await findJobByHash(db, 'h')
    expect(job?.attempts).toBe(2)
  })
})

describe('reconciling a finished job', () => {
  it('activates the model only when training has actually succeeded', async () => {
    const db = createTestDatabase()
    const version = await createModelVersion(db, {
      id: 'm1', profileId: 'default', version: 1, trainingEventCount: MIN_TRAINING_EVENTS + 2, now: NOW,
    })
    await createJob(db, {
      id: 'j1',
      type: 'train',
      payloadHash: 'h',
      context: { profileId: 'default', modelVersion: 'model-1', modelVersionId: version.id },
      now: NOW,
    })
    await markSubmitted(db, 'j1', 'runpod-1', NOW)

    const fetchImpl = stubFetch([
      ['/status/runpod-1', {
        id: 'runpod-1',
        status: 'COMPLETED',
        output: {
          modelVersion: 'model-1',
          modelPath: '/runpod-volume/model-1.pt',
          trainedEventCount: MIN_TRAINING_EVENTS + 2,
          trainedSeconds: 42,
        },
      }],
    ])

    const summary = await reconcileJobs(envWith(db), NOW + 1_000, { fetchImpl })

    expect(summary.completed).toBe(1)
    expect(summary.activatedModels).toEqual(['model-1'])
    const active = await activeModel(db, 'default')
    expect(active?.version).toBe(1)
    expect(active?.metadata.trainedSeconds).toBe(42)
  })

  it('marks the version failed when the run failed, leaving the old model live', async () => {
    const db = createTestDatabase()
    await createModelVersion(db, { id: 'm1', profileId: 'default', version: 1, trainingEventCount: MIN_TRAINING_EVENTS + 2, now: NOW })
    await activateModel(db, 'default', 'm1', NOW)
    const next = await createModelVersion(db, {
      id: 'm2', profileId: 'default', version: 2, trainingEventCount: 20, now: NOW,
    })
    await createJob(db, {
      id: 'j2',
      type: 'train',
      payloadHash: 'h2',
      context: { profileId: 'default', modelVersion: 'model-2', modelVersionId: next.id },
      now: NOW,
    })
    await markSubmitted(db, 'j2', 'runpod-2', NOW)

    const fetchImpl = stubFetch([
      ['/status/runpod-2', { id: 'runpod-2', status: 'FAILED', error: 'CUDA out of memory' }],
    ])

    await reconcileJobs(envWith(db), NOW + 1_000, { fetchImpl })

    // Design section 49: a failed run leaves the feed exactly as it was.
    expect((await activeModel(db, 'default'))?.version).toBe(1)
    const versions = await listModelVersions(db, 'default')
    expect(versions.find((entry) => entry.version === 2)?.status).toBe('failed')
  })

  it('writes the returned scores into the cache', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:a' })
    await createJob(db, {
      id: 'j1',
      type: 'score_batch',
      payloadHash: 'h',
      context: { profileId: 'default', modelVersion: 'model-1', videoIds: ['youtube:a'] },
      now: NOW,
    })
    await markSubmitted(db, 'j1', 'runpod-1', NOW)

    const fetchImpl = stubFetch([
      ['/status/runpod-1', {
        id: 'runpod-1',
        status: 'COMPLETED',
        output: { modelVersion: 'model-1', items: [{ id: 'youtube:a', score: 8.75 }] },
      }],
    ])

    const summary = await reconcileJobs(envWith(db), NOW + 1_000, { fetchImpl })

    expect(summary.scoresWritten).toBe(1)
    expect((await scoresFor(db, 'default', 'model-1')).get('youtube:a')).toBe(8.75)
  })

  it('refuses output it cannot make sense of rather than storing nonsense', async () => {
    const db = createTestDatabase()
    await createJob(db, {
      id: 'j1',
      type: 'score_batch',
      payloadHash: 'h',
      context: { profileId: 'default', modelVersion: 'model-1', videoIds: ['youtube:a'] },
      now: NOW,
    })
    await markSubmitted(db, 'j1', 'runpod-1', NOW)

    const fetchImpl = stubFetch([
      ['/status/runpod-1', { id: 'runpod-1', status: 'COMPLETED', output: { nonsense: true } }],
    ])

    const summary = await reconcileJobs(envWith(db), NOW + 1_000, { fetchImpl })
    expect(summary.failed).toBe(1)
    expect(summary.scoresWritten).toBe(0)
  })

  it('leaves a job that is still running alone', async () => {
    const db = createTestDatabase()
    await createJob(db, { id: 'j1', type: 'train', payloadHash: 'h', context: {}, now: NOW })
    await markSubmitted(db, 'j1', 'runpod-1', NOW)

    const fetchImpl = stubFetch([['/status/runpod-1', { id: 'runpod-1', status: 'IN_PROGRESS' }]])
    const summary = await reconcileJobs(envWith(db), NOW + 1_000, { fetchImpl })

    expect(summary.stillRunning).toBe(1)
    expect(summary.completed).toBe(0)
  })
})

describe('choosing what to score', () => {
  it('picks only videos the live model has never been asked about', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:scored', publishedAt: NOW })
    await seedVideo(db, { id: 'youtube:new', publishedAt: NOW })
    await saveScores(db, 'default', 'model-1', [{ videoId: 'youtube:scored', score: 5 }], NOW)

    const ids = await unscoredVideoIds(db, 'default', 'model-1', {
      publishedAfter: NOW - 86_400_000,
      limit: 100,
    })
    expect(ids).toEqual(['youtube:new'])
  })

  it('ignores anything older than the rescoring window', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:old', publishedAt: NOW - 400 * 86_400_000 })

    const ids = await unscoredVideoIds(db, 'default', 'model-1', {
      publishedAfter: NOW - 30 * 86_400_000,
      limit: 100,
    })
    expect(ids).toEqual([])
  })

  it('refuses to score before anything has been trained', async () => {
    const db = createTestDatabase()
    await expect(submitScoring(envWith(db), 'default', NOW)).rejects.toThrow(/no active model/)
  })

  it('numbers versions from one and upward per profile', async () => {
    const db = createTestDatabase()
    expect(await nextVersionNumber(db, 'default')).toBe(1)
    await createModelVersion(db, { id: 'm1', profileId: 'default', version: 1, trainingEventCount: 1, now: NOW })
    expect(await nextVersionNumber(db, 'default')).toBe(2)
  })
})
