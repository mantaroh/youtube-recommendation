import { describe, expect, it } from 'vitest'
import { INTEREST_WEIGHT_STEPS } from '@ypr/domain'
import { app } from '../index.js'
import type { Env } from '../env.js'
import { createTestDatabase } from './d1.js'
import { seedVideo } from './fixtures.js'
import { buildExport } from '../services/backup/export.js'
import { appendRating } from '../db/ratings.js'

/**
 * The API surface (design section 40), driven through the real Hono app.
 *
 * Routed rather than called directly, so that a route mounted at the wrong path or a
 * body that never gets validated shows up here rather than in the browser.
 */

const NOW = Date.parse('2026-08-24T00:00:00Z')

function envWith(db: D1Database): Env {
  return { DB: db } as Env
}

const executionContext = {
  waitUntil: (promise: Promise<unknown>) => {
    void promise
  },
  passThroughOnException: () => undefined,
} as unknown as ExecutionContext

async function call(env: Env, path: string, init?: RequestInit): Promise<Response> {
  return app.fetch(new Request(`https://example.test${path}`, init), env, executionContext)
}

describe('the feed route', () => {
  it('returns a feed and the model that scored it', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:a', publishedAt: NOW })

    const response = await call(envWith(db), '/api/feed')
    expect(response.status).toBe(200)

    const body = (await response.json()) as { items: unknown[]; modelVersion: string | null }
    expect(body.items).toHaveLength(1)
    expect(body.modelVersion).toBeNull()
  })

  it('refuses a lane it does not have', async () => {
    const db = createTestDatabase()
    const response = await call(envWith(db), '/api/feed?lane=nonsense')
    expect(response.status).toBe(400)
  })
})

describe('rating a video', () => {
  it('records the rating and returns the event', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:a' })

    const response = await call(envWith(db), '/api/videos/youtube:a/rating', {
      method: 'POST',
      body: JSON.stringify({ rating: 4 }),
    })

    expect(response.status).toBe(201)
    const body = (await response.json()) as { event: { rating: number } }
    expect(body.event.rating).toBe(4)
  })

  it('refuses a rating outside the scale', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:a' })

    const response = await call(envWith(db), '/api/videos/youtube:a/rating', {
      method: 'POST',
      body: JSON.stringify({ rating: 9 }),
    })
    expect(response.status).toBe(400)
  })

  it('says so plainly when the video is not in the catalog', async () => {
    const db = createTestDatabase()
    const response = await call(envWith(db), '/api/videos/youtube:missing/rating', {
      method: 'POST',
      body: JSON.stringify({ rating: 3 }),
    })
    expect(response.status).toBe(404)
  })

  it('returns the video with its rating history', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:a' })
    await call(envWith(db), '/api/videos/youtube:a/rating', {
      method: 'POST',
      body: JSON.stringify({ rating: 5 }),
    })

    const response = await call(envWith(db), '/api/videos/youtube:a')
    const body = (await response.json()) as { rating: number; history: unknown[] }
    expect(body.rating).toBe(5)
    expect(body.history).toHaveLength(1)
  })
})

describe('preferences', () => {
  it('creates an interest and adjusts it in place', async () => {
    const db = createTestDatabase()

    const created = await call(envWith(db), '/api/preferences', {
      method: 'POST',
      body: JSON.stringify({ keyword: 'firefox', weight: INTEREST_WEIGHT_STEPS.boost }),
    })
    expect(created.status).toBe(201)
    const { interest } = (await created.json()) as { interest: { id: string } }

    const updated = await call(envWith(db), `/api/preferences/${interest.id}`, {
      method: 'PUT',
      body: JSON.stringify({ weight: 0 }),
    })
    expect(updated.status).toBe(200)

    const list = await call(envWith(db), '/api/preferences')
    const body = (await list.json()) as { interests: Array<{ keyword: string; weight: number }> }
    // Adjusted, not duplicated: the same keyword twice would double its effect.
    expect(body.interests).toHaveLength(1)
    expect(body.interests[0]?.weight).toBe(0)
  })

  it('adjusts rather than duplicates when the same keyword is added twice', async () => {
    const db = createTestDatabase()
    for (const weight of [1.3, 0.5]) {
      await call(envWith(db), '/api/preferences', {
        method: 'POST',
        body: JSON.stringify({ keyword: 'linux', weight }),
      })
    }

    const list = await call(envWith(db), '/api/preferences')
    const body = (await list.json()) as { interests: Array<{ weight: number }> }
    expect(body.interests).toHaveLength(1)
    expect(body.interests[0]?.weight).toBe(0.5)
  })

  it('clamps the discovery slider to its range', async () => {
    const db = createTestDatabase()
    const response = await call(envWith(db), '/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ discovery: 4 }),
    })
    expect(response.status).toBe(400)
  })

  it('persists a setting that was accepted', async () => {
    const db = createTestDatabase()
    await call(envWith(db), '/api/settings', {
      method: 'PUT',
      body: JSON.stringify({ discovery: 0.8 }),
    })

    const response = await call(envWith(db), '/api/settings')
    const body = (await response.json()) as { discovery: number; feedSize: number }
    expect(body.discovery).toBe(0.8)
    // Untouched settings follow the defaults rather than freezing at whatever they
    // were when the screen was first opened.
    expect(body.feedSize).toBe(50)
  })
})

describe('the model route', () => {
  it('reports that nothing is trained and what is needed', async () => {
    const db = createTestDatabase()
    const response = await call(envWith(db), '/api/model')
    const body = (await response.json()) as {
      active: unknown
      minimumRatings: number
      runpodConfigured: boolean
    }
    expect(body.active).toBeNull()
    expect(body.minimumRatings).toBeGreaterThan(0)
    expect(body.runpodConfigured).toBe(false)
  })

  it('refuses to train with too few ratings, and says how many are needed', async () => {
    const db = createTestDatabase()
    const env = { DB: db, RUNPOD_API_KEY: 'k', RUNPOD_ENDPOINT_ID: 'e' } as Env
    await seedVideo(db, { id: 'youtube:a' })
    await appendRating(db, {
      id: 'e1', profileId: 'default', videoId: 'youtube:a', rating: 5, createdAt: NOW,
    })

    const response = await call(env, '/api/model/train', { method: 'POST' })
    expect(response.status).toBe(409)
    const body = (await response.json()) as { need: number; have: number }
    expect(body.have).toBe(1)
  })

  it('reports the missing configuration rather than failing obscurely', async () => {
    const db = createTestDatabase()
    const response = await call(envWith(db), '/api/model/score', { method: 'POST' })
    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: string }
    expect(body.error).toMatch(/Runpod is not configured/)
  })
})

describe('status and export', () => {
  it('reports what is configured and what is not', async () => {
    const db = createTestDatabase()
    const response = await call(envWith(db), '/api/status')
    const body = (await response.json()) as { configured: Record<string, boolean> }
    expect(body.configured.runpod).toBe(false)
    expect(body.configured.access).toBe(false)
  })

  it('exports the four files the design requires', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:a' })
    await appendRating(db, {
      id: 'e1', profileId: 'default', videoId: 'youtube:a', rating: 4, createdAt: NOW,
    })

    const bundle = await buildExport(envWith(db), 'default')
    expect(Object.keys(bundle).sort()).toEqual([
      'preferences.json',
      'ratings.jsonl',
      'settings.json',
      'subscriptions.json',
    ])

    const line = JSON.parse(bundle['ratings.jsonl']) as Record<string, unknown>
    expect(line.externalId).toBe('a')
    expect(line.rating).toBe(4)
    // ISO in the export, epoch in the database: this file is meant to be read by a
    // person years from now.
    expect(line.createdAt).toBe(new Date(NOW).toISOString())
    // Nothing derived: a score or a model version here would suggest the model is part
    // of what has to be preserved, and design section 45 says it is not.
    expect(line).not.toHaveProperty('score')
    expect(line).not.toHaveProperty('modelVersion')
  })

  it('serves one export file as a download', async () => {
    const db = createTestDatabase()
    const response = await call(envWith(db), '/api/export/ratings.jsonl')
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('ndjson')
    expect(response.headers.get('content-disposition')).toContain('ratings.jsonl')
  })

  it('refuses an export file it does not have', async () => {
    const db = createTestDatabase()
    const response = await call(envWith(db), '/api/export/passwords.txt')
    expect(response.status).toBe(404)
  })
})

describe('access control', () => {
  it('refuses every API route when Access is configured and no assertion is present', async () => {
    const db = createTestDatabase()
    const env = {
      DB: db,
      ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      ACCESS_AUD: 'aud-tag',
    } as Env

    for (const path of ['/api/feed', '/api/status', '/api/auth/youtube/callback?code=x&state=y']) {
      const response = await call(env, path)
      // The callback carries a code that can be exchanged for a token on the user's
      // account, so it is the one route that must not be left open.
      expect(response.status).toBe(403)
    }
  })

  it('allows requests through when Access is not configured yet', async () => {
    const db = createTestDatabase()
    const response = await call(envWith(db), '/api/status')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { identity: string | null }
    expect(body.identity).toBeNull()
  })
})
