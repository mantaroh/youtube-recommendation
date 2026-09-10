import { describe, expect, it } from 'vitest'
import { SHORT_MAX_SECONDS } from '@ypr/domain'
import { DEFAULT_LANE_MIX } from '@ypr/domain'
import { buildFeed, diversify, laneQuotas } from '../services/recommendation/feed.js'
import { appendRating, recordImpressions } from '../db/ratings.js'
import { saveScores } from '../db/models.js'
import { createTestDatabase } from './d1.js'
import { seedVideo } from './fixtures.js'

/**
 * Feed assembly (design sections 33, 34 and 35).
 *
 * The property worth protecting here is the one design section 34 states outright:
 * the videos the model finds easiest to predict must not be able to take the whole
 * feed. Three lanes with their own quotas are how that is enforced, so the tests are
 * mostly about the quotas holding under pressure.
 */

const NOW = Date.parse('2026-08-24T00:00:00Z')

describe('lane quotas', () => {
  it('splits fifty into the design’s worked example of 25 / 15 / 10', () => {
    expect(laneQuotas(50, DEFAULT_LANE_MIX)).toEqual({
      subscription: 25,
      related: 15,
      explore: 10,
    })
  })

  it('accounts for every slot, whatever the rounding', () => {
    for (const size of [7, 13, 29, 47, 100]) {
      const quotas = laneQuotas(size, DEFAULT_LANE_MIX)
      expect(quotas.subscription + quotas.related + quotas.explore).toBe(size)
    }
  })

  it('gives the whole feed to one lane when the feed is filtered to it', () => {
    expect(laneQuotas(20, DEFAULT_LANE_MIX, 'explore')).toEqual({
      subscription: 0,
      related: 0,
      explore: 20,
    })
  })
})

describe('diversity re-ranking', () => {
  const item = (id: string, channelId: string, score: number) =>
    ({
      video: { id, channelId } as never,
      channel: { id: channelId } as never,
      lane: 'related' as const,
      score,
      breakdown: {} as never,
      reasons: [],
      predictedScore: null,
      matchedInterests: [],
    })

  it('defers rather than drops when one channel is over the cap', () => {
    const items = [
      item('v1', 'c1', 10),
      item('v2', 'c1', 9),
      item('v3', 'c1', 8),
      item('v4', 'c1', 7),
      item('v5', 'c2', 1),
    ]

    const ordered = diversify(items, 3)

    // Nothing is lost: a prolific channel gets rearranged, not truncated.
    expect(ordered.length).toBe(5)
    expect(ordered.map((entry) => entry.video.id)).toEqual(['v1', 'v2', 'v3', 'v5', 'v4'])
  })

  it('leaves an already diverse list alone', () => {
    const items = [item('v1', 'c1', 3), item('v2', 'c2', 2), item('v3', 'c3', 1)]
    expect(diversify(items, 3).map((entry) => entry.video.id)).toEqual(['v1', 'v2', 'v3'])
  })
})

describe('buildFeed', () => {
  it('keeps the lanes apart even when one pool is much larger', async () => {
    const db = createTestDatabase()

    // Two subscribed videos against thirty unsubscribed ones. Ranked on score alone,
    // the subscribed pair would be swamped.
    for (let index = 0; index < 2; index += 1) {
      await seedVideo(db, {
        id: `youtube:sub${index}`,
        channelExternalId: 'UCsub',
        subscribed: true,
        publishedAt: NOW - 86_400_000,
      })
    }
    for (let index = 0; index < 30; index += 1) {
      await seedVideo(db, {
        id: `youtube:other${index}`,
        channelExternalId: `UCother${index}`,
        subscribed: false,
        publishedAt: NOW - 86_400_000,
      })
    }

    const feed = await buildFeed(db, { profileId: 'default', now: NOW, limit: 20 })

    expect(feed.items.length).toBe(20)
    expect(feed.laneCounts.subscription).toBe(2)
    expect(feed.modelVersion).toBeNull()
  })

  it('does not offer a video that has already been rated', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:rated', publishedAt: NOW })
    await seedVideo(db, { id: 'youtube:unrated', publishedAt: NOW })

    await appendRating(db, {
      id: 'e1', profileId: 'default', videoId: 'youtube:rated', rating: 4, createdAt: NOW,
    })

    const feed = await buildFeed(db, { profileId: 'default', now: NOW })
    expect(feed.items.map((entry) => entry.video.id)).toEqual(['youtube:unrated'])
  })

  it('ranks by the cached score and reports which model produced it', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:low', channelExternalId: 'UCa', publishedAt: NOW })
    await seedVideo(db, { id: 'youtube:high', channelExternalId: 'UCb', publishedAt: NOW })

    await db
      .prepare(
        `INSERT INTO model_versions (id, profile_id, version, training_event_count, status, created_at, activated_at, metadata_json)
         VALUES ('m1', 'default', 4, 30, 'active', 1, 1, '{}')`,
      )
      .run()
    await saveScores(db, 'default', 'model-4', [
      { videoId: 'youtube:low', score: 1 },
      { videoId: 'youtube:high', score: 9 },
    ], NOW)

    const feed = await buildFeed(db, { profileId: 'default', now: NOW })

    expect(feed.modelVersion).toBe('model-4')
    expect(feed.items[0]?.video.id).toBe('youtube:high')
    expect(feed.items[0]?.predictedScore).toBe(9)
  })

  it('still builds a feed when nothing has ever been scored', async () => {
    // Design section 49: the feed is the part that has to keep working when the GPU
    // side is asleep, down, or has never been configured.
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:a', publishedAt: NOW })

    const feed = await buildFeed(db, { profileId: 'default', now: NOW })

    expect(feed.items.length).toBe(1)
    expect(feed.items[0]?.predictedScore).toBeNull()
    expect(feed.modelVersion).toBeNull()
  })

  it('pushes down a video the feed has shown repeatedly', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:seen', channelExternalId: 'UCa', publishedAt: NOW })
    await seedVideo(db, { id: 'youtube:fresh', channelExternalId: 'UCb', publishedAt: NOW })

    await recordImpressions(db, 'default', [{ videoId: 'youtube:seen', lane: 'related' }], NOW)
    await recordImpressions(db, 'default', [{ videoId: 'youtube:seen', lane: 'related' }], NOW)
    await recordImpressions(db, 'default', [{ videoId: 'youtube:seen', lane: 'related' }], NOW)

    const feed = await buildFeed(db, { profileId: 'default', now: NOW })
    expect(feed.items[0]?.video.id).toBe('youtube:fresh')
  })

  it('fills the feed from other lanes rather than returning a short one', async () => {
    // No subscribed channels at all, so the subscription lane cannot fill its quota.
    const db = createTestDatabase()
    for (let index = 0; index < 12; index += 1) {
      await seedVideo(db, {
        id: `youtube:v${index}`,
        channelExternalId: `UC${index}`,
        subscribed: false,
        publishedAt: NOW,
      })
    }

    const feed = await buildFeed(db, { profileId: 'default', now: NOW, limit: 10 })
    expect(feed.items.length).toBe(10)
    expect(feed.laneCounts.subscription).toBe(0)
  })

  it('restricts to one lane when asked', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:sub', channelExternalId: 'UCs', subscribed: true, publishedAt: NOW })
    await seedVideo(db, { id: 'youtube:other', channelExternalId: 'UCo', subscribed: false, publishedAt: NOW })

    const feed = await buildFeed(db, { profileId: 'default', now: NOW, lane: 'subscription' })
    expect(feed.items.map((entry) => entry.video.id)).toEqual(['youtube:sub'])
  })
})

describe('videos too short for this system', () => {
  /**
   * It began as a weight and the ratings said that was too gentle: twenty-eight ratings
   * below three minutes averaged 1.2 against 3.3 above, while eighty-two per cent of
   * everything discovered fell below the line. A penalty still pays to fetch, store and
   * score a pile of candidates that exists to be pushed down.
   *
   * So nothing shorter is stored, offered or scored. What is asserted here is absence.
   */
  it('are not offered, however new or popular', async () => {
    const db = createTestDatabase()
    await seedVideo(db, {
      id: 'youtube:short',
      durationSeconds: SHORT_MAX_SECONDS,
      viewCount: 10_000_000,
      publishedAt: NOW,
    })
    await seedVideo(db, { id: 'youtube:long', durationSeconds: SHORT_MAX_SECONDS + 1, publishedAt: NOW })

    const feed = await buildFeed(db, { profileId: 'default', now: NOW })

    // Three minutes exactly is a Short by YouTube's own line, and by this one.
    expect(feed.items.map((item) => item.video.id)).toEqual(['youtube:long'])
  })

  it('are not stored in the first place', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:short', durationSeconds: 60 })

    const row = await db.prepare('SELECT COUNT(*) AS n FROM videos').first<{ n: number }>()
    expect(row?.n).toBe(0)
  })

  it('keep their row when they have been rated', async () => {
    // The rating is the one thing here that cannot be rebuilt: a model can be retrained
    // from ratings, and ratings cannot be recovered from a model. So a rated short keeps
    // its row and simply stops being a candidate.
    const db = createTestDatabase()
    await db
      .prepare(
        `INSERT INTO videos (id, source, external_id, title, duration_seconds, discovered_at)
         VALUES ('youtube:rated', 'youtube', 'rated', 'An old favourite', 45, ?1)`,
      )
      .bind(NOW)
      .run()
    await appendRating(db, {
      id: 'e1',
      profileId: 'default',
      videoId: 'youtube:rated',
      rating: 5,
      createdAt: NOW,
    })

    const feed = await buildFeed(db, { profileId: 'default', now: NOW })
    expect(feed.items).toHaveLength(0)

    const kept = await db.prepare('SELECT COUNT(*) AS n FROM rating_events').first<{ n: number }>()
    expect(kept?.n).toBe(1)
  })
})
