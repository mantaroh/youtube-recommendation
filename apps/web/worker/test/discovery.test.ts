import { describe, expect, it } from 'vitest'
import type { Env } from '../env.js'
import { adjacentTopics, interestTerms, splitTitle } from '../services/discovery/keywords.js'
import { runDiscovery, syncSubscriptions } from '../services/discovery/index.js'
import { jstDay, SearchBudget, usedToday } from '../db/quota.js'
import { listChannels } from '../db/videos.js'
import { appendRating } from '../db/ratings.js'
import { saveToken } from '../services/youtube/oauth.js'
import { createTestDatabase } from './d1.js'
import { seedVideo, stubFetch } from './fixtures.js'

/**
 * Discovery and the quota it spends (design sections 17 through 20 and 42).
 *
 * `search.list` costs one of a hundred calls a day and there is no way to ask what is
 * left, so the interesting behaviour here is the refusal: the budget is checked before
 * a call, not after it, because finding out afterwards means the call has already been
 * spent.
 */

const NOW = Date.parse('2026-08-24T00:00:00Z')
// 32 bytes, base64. Test material only.
const KEY = btoa('0123456789abcdef0123456789abcdef')

function envWith(db: D1Database): Env {
  return { DB: db, YOUTUBE_API_KEY: 'test-key' } as Env
}

describe('interest terms', () => {
  it('weights a tag above a title word, and a five above a three', () => {
    const terms = interestTerms(
      [
        { title: 'Something about caching', tags: ['kernel'], channelTitle: null, rating: 5 },
        { title: 'Caching explained', tags: [], channelTitle: null, rating: 3 },
      ],
      5,
    )
    expect(terms[0]).toBe('kernel')
  })

  it('ignores videos the user asked for less of', () => {
    // A rating of two says "less of this". Searching for its terms would be reading
    // the sign backwards.
    const terms = interestTerms(
      [{ title: 'Unboxing the new phone', tags: ['unboxing'], channelTitle: null, rating: 1 }],
      5,
    )
    expect(terms).toEqual([])
  })

  it('drops words that appear in every title and identify nothing', () => {
    const terms = interestTerms(
      [{ title: 'The best tutorial for you', tags: [], channelTitle: null, rating: 5 }],
      10,
    )
    expect(terms).not.toContain('the')
    expect(terms).not.toContain('tutorial')
    expect(terms).not.toContain('best')
  })

  it('keeps two-word phrases, which search very differently from single words', () => {
    expect(splitTitle('Inside the browser engine')).toContain('browser engine')
  })

  it('strips bracketed decoration from titles', () => {
    expect(splitTitle('Kernel scheduling [4K] (part 2)')).not.toContain('4K')
  })
})

describe('adjacent topics', () => {
  it('steps sideways rather than returning more of the same', () => {
    // Design section 20's own example: browser engine leads outward, not deeper.
    const topics = adjacentTopics(['firefox internals'], 5)
    expect(topics).toContain('operating system internals')
    expect(topics).not.toContain('firefox internals')
  })

  it('returns nothing when it has nothing to say about the seeds', () => {
    expect(adjacentTopics(['knitting patterns'], 5)).toEqual([])
  })

  it('does not suggest a neighbour the user is already deep in', () => {
    const topics = adjacentTopics(['browser engine', 'computer architecture'], 5)
    expect(topics).not.toContain('computer architecture')
  })
})

describe('the search budget', () => {
  it('refuses once the day’s allowance is spent', async () => {
    const db = createTestDatabase()
    const budget = await SearchBudget.open(db, 2, NOW)

    expect(budget.take()).toBe(true)
    expect(budget.take()).toBe(true)
    expect(budget.take()).toBe(false)

    await budget.close()
    expect(await usedToday(db, 'search', NOW)).toBe(2)
  })

  it('carries what was already spent today into a second run', async () => {
    const db = createTestDatabase()
    const first = await SearchBudget.open(db, 3, NOW)
    first.take()
    first.take()
    await first.close()

    const second = await SearchBudget.open(db, 3, NOW)
    expect(second.left).toBe(1)
  })

  it('keys the ledger to the JST day the user is living in', () => {
    // 09:00 JST on the 24th is 00:00 UTC on the 24th; 08:00 JST is still the 23rd UTC.
    expect(jstDay(Date.parse('2026-08-24T00:00:00Z'))).toBe('2026-08-24')
    expect(jstDay(Date.parse('2026-08-23T15:30:00Z'))).toBe('2026-08-24')
  })
})

describe('running discovery', () => {
  it('stops searching when the budget runs out, and says so', async () => {
    const db = createTestDatabase()
    const id = await seedVideo(db, { id: 'youtube:a', tags: ['kernel', 'linux', 'scheduling'] })
    await appendRating(db, { id: 'e1', profileId: 'default', videoId: id, rating: 5, createdAt: NOW })

    const fetchImpl = stubFetch([
      ['/search', { items: [{ id: { videoId: 'x1' } }] }],
      ['/videos', { items: [] }],
    ])

    const result = await runDiscovery(envWith(db), 'default', NOW, {
      lanes: ['related'],
      searchBudget: 1,
      fetchImpl,
    })

    const related = result.summaries.find((entry) => entry.lane === 'related')
    expect(related?.searchCalls).toBe(1)
    expect(related?.errors.some((error) => error.includes('budget exhausted'))).toBe(true)
  })

  it('says what is missing rather than failing silently with no ratings', async () => {
    const db = createTestDatabase()
    const result = await runDiscovery(envWith(db), 'default', NOW, { lanes: ['related'] })
    expect(result.summaries[0]?.errors[0]).toMatch(/rate a few videos/)
  })

  it('walks uploads playlists rather than searching per channel', async () => {
    // `search.list?channelId=` would answer the same question at a hundred times the
    // price, and exhaust the daily allowance after a hundred channels.
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:seed', channelExternalId: 'UCabc', subscribed: true })

    const fetchImpl = stubFetch([
      ['/playlistItems', { items: [{ contentDetails: { videoId: 'new1' } }] }],
      ['/videos', {
        items: [{
          id: 'new1',
          snippet: { title: 'New upload', channelId: 'UCabc', channelTitle: 'Deep Dives', publishedAt: '2026-08-20T00:00:00Z' },
          contentDetails: { duration: 'PT10M' },
          statistics: { viewCount: '12' },
        }],
      }],
    ])

    const result = await runDiscovery(envWith(db), 'default', NOW, {
      lanes: ['subscription'],
      fetchImpl,
    })

    const summary = result.summaries[0]
    expect(summary?.stored).toBe(1)
    expect(summary?.searchCalls).toBe(0)
    const urls = (fetchImpl as unknown as { calls: string[] }).calls
    expect(urls.some((url) => url.includes('/playlistItems'))).toBe(true)
    expect(urls.some((url) => url.includes('/search'))).toBe(false)
  })

  it('reports plainly when there are no subscribed channels to walk', async () => {
    const db = createTestDatabase()
    const result = await runDiscovery(envWith(db), 'default', NOW, { lanes: ['subscription'] })
    expect(result.summaries[0]?.errors[0]).toMatch(/no subscribed channels/)
  })
})

describe('syncing subscriptions', () => {
  it('replaces the list, so unsubscribing on YouTube reaches this system', async () => {
    const db = createTestDatabase()
    await seedVideo(db, { id: 'youtube:old', channelExternalId: 'UCold', subscribed: true })

    const env = {
      DB: db,
      GOOGLE_CLIENT_ID: 'id',
      GOOGLE_CLIENT_SECRET: 'secret',
      OAUTH_REDIRECT_URI: 'https://example.test/api/auth/youtube/callback',
      OAUTH_ENCRYPTION_KEY: KEY,
    } as Env
    await saveToken(
      db,
      'default',
      'youtube',
      { accessToken: 'token', refreshToken: null, scope: null, expiresAt: NOW + 3_600_000 },
      KEY,
      NOW,
    )

    const fetchImpl = stubFetch([
      ['/subscriptions', {
        items: [{ snippet: { title: 'Kept', resourceId: { channelId: 'UCkept' } } }],
      }],
    ])

    const result = await syncSubscriptions(env, 'default', NOW, { fetchImpl })

    expect(result.channels).toBe(1)
    const channels = await listChannels(db, 'default', { subscribedOnly: true })
    // A merge could never express a removal, so the list is replaced wholesale.
    expect(channels.map((channel) => channel.externalId)).toEqual(['UCkept'])
  })

  it('says the account is not connected rather than failing obscurely', async () => {
    const db = createTestDatabase()
    const result = await syncSubscriptions({ DB: db } as Env, 'default', NOW)
    expect(result.errors[0]).toMatch(/no YouTube account/)
  })
})

describe('when the popularity chart runs', () => {
  /**
   * The chart is the same chart for everyone, so running it for every profile fills each
   * of their pools with identical videos. Two accounts kept separate precisely to keep
   * two tastes apart had four hundred and fifteen candidates in common, and four hundred
   * and thirteen of them came from here — a quarter of the smaller pool.
   *
   * It stays for the case it was added for, which is the only one it answers well: a
   * profile that has rated nothing has no other way to discover anything.
   */
  it('runs for a profile that has rated nothing', async () => {
    const db = createTestDatabase()
    const fetchImpl = stubFetch([['chart=mostPopular', { items: [] }]])

    const result = await runDiscovery(envWith(db), 'default', NOW, {
      lanes: ['explore'],
      fetchImpl,
    })

    expect(result.summaries.some((s) => s.queries.some((q) => q.startsWith('JP/')))).toBe(true)
  })

  it('stops once the profile has ratings to work from', async () => {
    const db = createTestDatabase()
    for (let index = 0; index < 6; index++) {
      const id = `youtube:v${index}`
      await seedVideo(db, { id, title: `Browser engines ${index}`, tags: ['firefox', 'browser'] })
      await appendRating(db, {
        id: `e${index}`,
        profileId: 'default',
        videoId: id,
        rating: 5,
        createdAt: NOW + index,
      })
    }

    // Only search stubs: a chart call would have nothing to answer it and would throw.
    const fetchImpl = stubFetch([
      ['/search', { items: [] }],
      ['/videos', { items: [] }],
    ])

    const result = await runDiscovery(envWith(db), 'default', NOW, {
      lanes: ['explore'],
      fetchImpl,
    })

    expect(result.summaries.some((s) => s.queries.some((q) => q.startsWith('JP/')))).toBe(false)
  })
})
