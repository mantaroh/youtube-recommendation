import { describe, expect, it } from 'vitest'
import type { Env } from '../env.js'
import { engineClient, engineConfigured, engineDescription } from '../services/runpod/engine.js'
import { MIN_TRAINING_EVENTS, submitTraining } from '../services/model/train.js'
import { reconcileJobs } from '../services/model/reconcile.js'
import { appendRating } from '../db/ratings.js'
import { activeModel } from '../db/models.js'
import { createTestDatabase } from './d1.js'
import { seedVideo, stubFetch } from './fixtures.js'

/**
 * Choosing an engine, and reaching one that is not Runpod.
 *
 * The point of the local engine is that it exercises the *same* pipeline: the ledger,
 * the polling pass, the idempotency check and the atomic model switch all have to
 * behave identically, or testing against it proves nothing about the deployed system.
 * These tests assert exactly that.
 */

const NOW = Date.parse('2026-08-24T00:00:00Z')

async function seedRatings(db: D1Database, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const id = await seedVideo(db, { id: `youtube:v${index}`, title: `Video ${index}` })
    await appendRating(db, {
      id: `e${index}`,
      profileId: 'default',
      videoId: id,
      rating: 4,
      createdAt: NOW - index,
    })
  }
}

describe('choosing an engine', () => {
  it('needs one of the two, and says which is missing', () => {
    expect(engineConfigured({} as Env)).toBe(false)
    expect(engineDescription({} as Env)).toBeNull()
    // Half of Runpod's credentials is not a configuration.
    expect(engineConfigured({ RUNPOD_API_KEY: 'k' } as Env)).toBe(false)
  })

  it('accepts a local engine with no Runpod account at all', () => {
    const env = { PREFERENCE_ENGINE_URL: 'http://127.0.0.1:9000' } as Env
    expect(engineConfigured(env)).toBe(true)
    expect(engineDescription(env)).toContain('local')
  })

  it('accepts Runpod when both halves are present', () => {
    const env = { RUNPOD_API_KEY: 'k', RUNPOD_ENDPOINT_ID: 'ep-1' } as Env
    expect(engineConfigured(env)).toBe(true)
    expect(engineDescription(env)).toContain('ep-1')
  })

  it('prefers the local engine when both are set', () => {
    // A developer with Runpod credentials in their environment and a local engine
    // running meant to use the local one; sending the job to the paid endpoint
    // instead is a surprise that costs money.
    const env = {
      PREFERENCE_ENGINE_URL: 'http://127.0.0.1:9000',
      RUNPOD_API_KEY: 'k',
      RUNPOD_ENDPOINT_ID: 'ep-1',
    } as Env
    expect(engineDescription(env)).toContain('local')
  })
})

describe('addressing the engine', () => {
  it('sends jobs to the local base URL rather than to Runpod', async () => {
    const fetchImpl = stubFetch([['/run', { id: 'local-1' }]])
    const client = engineClient(
      { PREFERENCE_ENGINE_URL: 'http://127.0.0.1:9000' } as Env,
      fetchImpl,
    )

    await client.run('train', { profile: 'default', modelVersion: 'model-1', events: [] })

    const calls = (fetchImpl as unknown as { calls: string[] }).calls
    expect(calls[0]).toBe('http://127.0.0.1:9000/run')
    expect(calls[0]).not.toContain('runpod.ai')
  })

  it('tolerates a trailing slash in the configured URL', async () => {
    const fetchImpl = stubFetch([['/status/', { id: 'j', status: 'COMPLETED' }]])
    const client = engineClient(
      { PREFERENCE_ENGINE_URL: 'http://127.0.0.1:9000/' } as Env,
      fetchImpl,
    )

    await client.status('j')
    expect((fetchImpl as unknown as { calls: string[] }).calls[0]).toBe(
      'http://127.0.0.1:9000/status/j',
    )
  })

  it('still nests under the endpoint id for Runpod', async () => {
    const fetchImpl = stubFetch([['/run', { id: 'r-1' }]])
    const client = engineClient({ RUNPOD_API_KEY: 'k', RUNPOD_ENDPOINT_ID: 'ep-1' } as Env, fetchImpl)

    await client.run('train', { profile: 'default', modelVersion: 'model-1', events: [] })
    expect((fetchImpl as unknown as { calls: string[] }).calls[0]).toBe(
      'https://api.runpod.ai/v2/ep-1/run',
    )
  })
})

describe('the pipeline against a local engine', () => {
  it('trains and activates a model with no Runpod credentials present', async () => {
    const db = createTestDatabase()
    await seedRatings(db, MIN_TRAINING_EVENTS + 2)
    const env = { DB: db, PREFERENCE_ENGINE_URL: 'http://127.0.0.1:9000' } as Env

    const submitted = stubFetch([['/run', { id: 'local-1' }]])
    const submission = await submitTraining(env, 'default', NOW, { fetchImpl: submitted })
    expect(submission.modelVersion).toBe('model-1')
    // Nothing is live until the engine confirms the model exists, local or not.
    expect(await activeModel(db, 'default')).toBeNull()

    const finished = stubFetch([
      ['/status/local-1', {
        id: 'local-1',
        status: 'COMPLETED',
        output: {
          modelVersion: 'model-1',
          modelPath: '/volume/model-1.pt',
          trainedEventCount: MIN_TRAINING_EVENTS + 2,
          trainedSeconds: 90,
        },
      }],
    ])
    const summary = await reconcileJobs(env, NOW + 1_000, { fetchImpl: finished })

    expect(summary.completed).toBe(1)
    expect((await activeModel(db, 'default'))?.version).toBe(1)
  })

  it('records a local engine failure the same way as a Runpod one', async () => {
    const db = createTestDatabase()
    await seedRatings(db, MIN_TRAINING_EVENTS + 2)
    const env = { DB: db, PREFERENCE_ENGINE_URL: 'http://127.0.0.1:9000' } as Env

    await submitTraining(env, 'default', NOW, { fetchImpl: stubFetch([['/run', { id: 'local-1' }]]) })

    const failed = stubFetch([
      ['/status/local-1', { id: 'local-1', status: 'FAILED', error: 'out of memory' }],
    ])
    const summary = await reconcileJobs(env, NOW + 1_000, { fetchImpl: failed })

    expect(summary.failed).toBe(1)
    expect(await activeModel(db, 'default')).toBeNull()
  })
})
