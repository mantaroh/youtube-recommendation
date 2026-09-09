import { describe, expect, it } from 'vitest'
import type { Env } from '../env.js'
import { ensureProfile } from '../db/settings.js'
import { getVideo, videosMissingThumbnails } from '../db/videos.js'
import { backfillThumbnails } from '../services/discovery/index.js'
import { createTestDatabase } from './d1.js'
import { seedVideo, stubFetch } from './fixtures.js'

/**
 * Repairing catalog rows that came over without a thumbnail.
 *
 * The part worth guarding is not the fetch. It is that a repair writes no candidacy:
 * re-reading a video already stored says nothing about whose feed it belongs in, and
 * getting that wrong would hand every mended row to whichever profile ran the pass —
 * silently, since a candidate that should not be there looks exactly like one that
 * should.
 */

const NOW = 1_700_000_000_000

function envWith(db: D1Database): Env {
  return { DB: db, YOUTUBE_API_KEY: 'test-key' } as Env
}

function videoListResponse(ids: string[]) {
  return {
    items: ids.map((id) => ({
      id,
      snippet: {
        title: `Video ${id}`,
        description: '',
        channelId: 'UCrepair',
        channelTitle: 'Repair',
        publishedAt: new Date(NOW).toISOString(),
        thumbnails: { high: { url: `https://i.example.test/${id}.jpg` } },
        tags: [],
      },
      contentDetails: { duration: 'PT10M' },
      statistics: { viewCount: '100' },
    })),
  }
}

describe('finding what is missing', () => {
  it('lists only the rows with no thumbnail', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:withpic' })
    await db.prepare("UPDATE videos SET thumbnail_url = 'https://x.test/a.jpg'").run()
    await seedVideo(db, { id: 'youtube:without' })

    expect(await videosMissingThumbnails(db, 10)).toEqual(['without'])
  })

  it('is bounded, so a large catalog does not become one enormous pass', async () => {
    const db = createTestDatabase()
    for (const id of ['a', 'b', 'c']) await seedVideo(db, { id: `youtube:${id}` })
    expect(await videosMissingThumbnails(db, 2)).toHaveLength(2)
  })
})

describe('the repair pass', () => {
  it('fills in the thumbnail', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:v1' })
    const fetchImpl = stubFetch([['/videos', videoListResponse(['v1'])]])

    const result = await backfillThumbnails(envWith(db), NOW, { fetchImpl })

    expect(result.refreshed).toBe(1)
    expect((await getVideo(db, 'youtube:v1'))?.thumbnailUrl).toBe('https://i.example.test/v1.jpg')
  })

  it('makes the mended row nobody\'s candidate', async () => {
    const db = createTestDatabase()
    await ensureProfile(db, 'private', NOW)
    // Seeded as the default profile's candidate, which is the state a carried-over row
    // is in: it belongs to one profile and the repair must not change that.
    await seedVideo(db, { id: 'youtube:v1' })
    const before = await db
      .prepare('SELECT profile_id FROM profile_candidates WHERE video_id = ?1')
      .bind('youtube:v1')
      .all<{ profile_id: string }>()

    await backfillThumbnails(envWith(db), NOW, {
      fetchImpl: stubFetch([['/videos', videoListResponse(['v1'])]]),
    })

    const after = await db
      .prepare('SELECT profile_id FROM profile_candidates WHERE video_id = ?1 ORDER BY profile_id')
      .bind('youtube:v1')
      .all<{ profile_id: string }>()
    expect(after.results).toEqual(before.results)
    expect(after.results?.map((row) => row.profile_id)).toEqual(['default'])
  })

  it('does nothing when there is nothing missing', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:v1' })
    await db.prepare("UPDATE videos SET thumbnail_url = 'https://x.test/a.jpg'").run()

    // No fetch stub: reaching the network here would throw rather than pass.
    expect(await backfillThumbnails(envWith(db), NOW)).toEqual({
      examined: 0,
      refreshed: 0,
      errors: [],
    })
  })

  it('reports rather than loops when every video has gone', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:deleted' })

    // A deleted video is simply absent from the response. Retrying would ask for the
    // same page forever, so the pass says so instead.
    const result = await backfillThumbnails(envWith(db), NOW, {
      fetchImpl: stubFetch([['/videos', { items: [] }]]),
    })

    expect(result.refreshed).toBe(0)
    expect(result.errors).toEqual(['none of the videos are still available'])
  })
})
