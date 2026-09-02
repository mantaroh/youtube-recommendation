import { describe, expect, it } from 'vitest'
import {
  appendRating,
  countRatingsSince,
  currentRatingFor,
  currentRatings,
  disableRating,
  listAllRatings,
  listRatingHistory,
  recordImpressions,
  seenCounts,
} from '../db/ratings.js'
import { createTestDatabase } from './d1.js'
import { seedVideo } from './fixtures.js'

/**
 * The rating log (design sections 10 and 11).
 *
 * This is the table the system exists to protect, so the tests are about the property
 * that makes it worth protecting: nothing here is ever overwritten, and the current
 * opinion is a query over the log rather than a column that got replaced.
 */

describe('rating events', () => {
  it('keeps both ratings when the same video is rated twice', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:a' })

    await appendRating(db, {
      id: 'e1',
      profileId: 'default',
      videoId: 'youtube:a',
      rating: 5,
      createdAt: 1_000,
    })
    await appendRating(db, {
      id: 'e2',
      profileId: 'default',
      videoId: 'youtube:a',
      rating: 2,
      createdAt: 2_000,
    })

    const history = await listRatingHistory(db, 'default', 'youtube:a')
    expect(history.map((event) => event.rating)).toEqual([2, 5])
    // The newest is the current one; the older survives so that a change of taste
    // stays legible later.
    expect(await currentRatingFor(db, 'default', 'youtube:a')).toBe(2)
  })

  it('treats a rating of zero as an opinion, not as unrated', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:a' })
    await seedVideo(db, { id: 'youtube:b' })

    await appendRating(db, {
      id: 'e1',
      profileId: 'default',
      videoId: 'youtube:a',
      rating: 0,
      createdAt: 1_000,
    })

    expect(await currentRatingFor(db, 'default', 'youtube:a')).toBe(0)
    expect(await currentRatingFor(db, 'default', 'youtube:b')).toBeNull()

    const current = await currentRatings(db, 'default')
    expect(current.get('youtube:a')).toBe(0)
    expect(current.has('youtube:b')).toBe(false)
  })

  it('falls back to the previous rating when the newest is retracted', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:a' })

    await appendRating(db, {
      id: 'e1', profileId: 'default', videoId: 'youtube:a', rating: 5, createdAt: 1_000,
    })
    await appendRating(db, {
      id: 'e2', profileId: 'default', videoId: 'youtube:a', rating: 1, createdAt: 2_000,
    })

    await disableRating(db, 'default', 'e2', 3_000)

    expect(await currentRatingFor(db, 'default', 'youtube:a')).toBe(5)
    // Retracting marks; it does not delete. Both rows are still there.
    expect((await listRatingHistory(db, 'default', 'youtube:a')).length).toBe(2)
    expect((await listAllRatings(db, 'default', { includeDisabled: true })).length).toBe(2)
    expect((await listAllRatings(db, 'default')).length).toBe(1)
  })

  it('counts only new, live ratings toward the retrain threshold', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:a' })
    await seedVideo(db, { id: 'youtube:b' })

    await appendRating(db, {
      id: 'e1', profileId: 'default', videoId: 'youtube:a', rating: 4, createdAt: 1_000,
    })
    await appendRating(db, {
      id: 'e2', profileId: 'default', videoId: 'youtube:b', rating: 3, createdAt: 5_000,
    })
    await disableRating(db, 'default', 'e2', 6_000)

    expect(await countRatingsSince(db, 'default', 0)).toBe(1)
    expect(await countRatingsSince(db, 'default', 2_000)).toBe(0)
  })

  it('does not read another profile’s ratings', async () => {
    const db = createTestDatabase()
    await db.prepare('INSERT INTO profiles (id, name, created_at) VALUES (?1, ?1, 0)').bind('other').run()
    await seedVideo(db, { id: 'youtube:a' })

    await appendRating(db, {
      id: 'e1', profileId: 'other', videoId: 'youtube:a', rating: 5, createdAt: 1_000,
    })

    expect(await currentRatingFor(db, 'default', 'youtube:a')).toBeNull()
    expect(await currentRatingFor(db, 'other', 'youtube:a')).toBe(5)
  })
})

describe('impressions', () => {
  it('counts repeat showings so the penalty can grow', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:a' })

    const entry = [{ videoId: 'youtube:a', lane: 'subscription' as const }]
    await recordImpressions(db, 'default', entry, 1_000)
    await recordImpressions(db, 'default', entry, 2_000)

    expect((await seenCounts(db, 'default')).get('youtube:a')).toBe(2)
  })

  it('records nothing for an empty feed', async () => {
    const db = createTestDatabase()
    await recordImpressions(db, 'default', [], 1_000)
    expect((await seenCounts(db, 'default')).size).toBe(0)
  })
})
