import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@ypr/domain'
import { adjacentTopics, interestTerms, scriptOf, splitTitle } from '../services/discovery/keywords.js'
import { discoverPopular, runDiscovery } from '../services/discovery/index.js'
import { saveSettings } from '../db/settings.js'
import { appendRating } from '../db/ratings.js'
import type { Env } from '../env.js'
import { createTestDatabase } from './d1.js'
import { seedVideo, stubFetch } from './fixtures.js'

/**
 * Japanese content.
 *
 * The system reports in JST and is built for someone living in Japan, so a discovery
 * path that only works on English titles is a defect rather than a missing feature.
 * These cover the three places the language actually decides the outcome: segmentation,
 * the explore lane's query language, and what the search request tells YouTube.
 */

const NOW = Date.parse('2026-08-24T00:00:00Z')

function envWith(db: D1Database): Env {
  return { DB: db, YOUTUBE_API_KEY: 'test-key' } as Env
}

describe('segmentation', () => {
  it('splits a Japanese title into words instead of leaving it whole', () => {
    // Splitting on whitespace made the entire title one token, and searching for that
    // returns nothing while still costing one of a hundred daily calls.
    const terms = splitTitle('Linuxカーネルのスケジューラを読む')
    expect(terms).toContain('カーネル')
    expect(terms).toContain('スケジューラ')
    expect(terms).not.toContain('Linuxカーネルのスケジューラを読む')
  })

  it('drops particles rather than counting them as subjects', () => {
    const terms = splitTitle('ブラウザエンジンの内部構造について')
    expect(terms).not.toContain('の')
    expect(terms).not.toContain('について')
  })

  it('joins a Japanese pair without a space, because that is how it is written', () => {
    const terms = splitTitle('ブラウザ エンジン の話')
    expect(terms).toContain('ブラウザエンジン')
  })

  it('still keeps English pairs spaced', () => {
    expect(splitTitle('Inside the browser engine')).toContain('browser engine')
  })

  it('keeps two-character Japanese words that the Latin length rule would discard', () => {
    // 関数, 配列, 型 — most Japanese nouns are short, and a single minimum length for
    // both scripts either floods the list with Latin fragments or discards these.
    const terms = interestTerms(
      [{ title: '関数と配列の話', tags: [], channelTitle: null, rating: 5 }],
      10,
    )
    expect(terms).toContain('関数')
    expect(terms).toContain('配列')
  })

  it('produces usable search terms from a Japanese title', () => {
    const terms = interestTerms(
      [
        { title: 'Linuxカーネルのスケジューラを読む', tags: ['カーネル'], channelTitle: null, rating: 5 },
        { title: 'ブラウザエンジンの内部構造', tags: ['ブラウザ'], channelTitle: null, rating: 5 },
      ],
      10,
    )
    // Nothing in the list should be a whole sentence.
    for (const term of terms) expect(term.length).toBeLessThan(20)
    expect(terms).toContain('カーネル')
    expect(terms).toContain('ブラウザ')
  })

  it('drops Japanese format words the way it drops "tutorial"', () => {
    const terms = interestTerms(
      [{ title: 'カーネル解説動画 初心者向け', tags: [], channelTitle: null, rating: 5 }],
      10,
    )
    expect(terms).not.toContain('解説')
    expect(terms).not.toContain('動画')
    expect(terms).not.toContain('初心者')
    expect(terms).toContain('カーネル')
  })

  it('recognises which script it is looking at', () => {
    expect(scriptOf('カーネル')).toBe('ja')
    expect(scriptOf('計算機')).toBe('ja')
    expect(scriptOf('kernel')).toBe('latin')
  })
})

describe('the explore lane in Japanese', () => {
  it('returns neighbours, where it used to return nothing at all', () => {
    const topics = adjacentTopics(['カーネル', 'ブラウザ'], 5, 'ja')
    expect(topics.length).toBeGreaterThan(0)
    // The neighbour *is* the search query, so an English one on behalf of someone who
    // watches Japanese content returns videos they will not want.
    for (const topic of topics) expect(scriptOf(topic)).toBe('ja')
  })

  it('writes Japanese queries from English seeds when that is the setting', () => {
    // Tags are often English even on Japanese channels, so the seeds alone cannot
    // decide the language.
    const topics = adjacentTopics(['linux kernel'], 5, 'ja')
    expect(topics.length).toBeGreaterThan(0)
    expect(scriptOf(topics[0] as string)).toBe('ja')
  })

  it('still writes English queries for a Latin installation', () => {
    const topics = adjacentTopics(['linux kernel'], 5, 'latin')
    expect(topics).toContain('computer architecture')
  })

  it('follows the seed’s own script ahead of the preference', () => {
    const topics = adjacentTopics(['カーネル'], 5, 'latin')
    expect(scriptOf(topics[0] as string)).toBe('ja')
  })
})

describe('what the search request tells YouTube', () => {
  it('sends the configured region and language', async () => {
    const db = createTestDatabase()
    const id = await seedVideo(db, { id: 'youtube:a', tags: ['カーネル'] })
    await appendRating(db, { id: 'e1', profileId: 'default', videoId: id, rating: 5, createdAt: NOW })

    const fetchImpl = stubFetch([
      ['/search', { items: [] }],
      ['/videos', { items: [] }],
    ])

    await runDiscovery(envWith(db), 'default', NOW, {
      lanes: ['related'],
      searchBudget: 1,
      fetchImpl,
    })

    const search = (fetchImpl as unknown as { calls: string[] }).calls.find((url) =>
      url.includes('/search'),
    )
    expect(search).toBeDefined()
    const params = new URL(search as string).searchParams
    // Without these, YouTube infers a region from the Worker's egress address, which is
    // whichever Cloudflare edge took the request.
    expect(params.get('regionCode')).toBe('JP')
    expect(params.get('relevanceLanguage')).toBe('ja')
  })

  it('honours a setting other than the default', async () => {
    const db = createTestDatabase()
    await saveSettings(db, 'default', { region: 'US', language: 'en' }, NOW)
    const id = await seedVideo(db, { id: 'youtube:a', tags: ['kernel'] })
    await appendRating(db, { id: 'e1', profileId: 'default', videoId: id, rating: 5, createdAt: NOW })

    const fetchImpl = stubFetch([
      ['/search', { items: [] }],
      ['/videos', { items: [] }],
    ])

    await runDiscovery(envWith(db), 'default', NOW, {
      lanes: ['related'],
      searchBudget: 1,
      fetchImpl,
    })

    const search = (fetchImpl as unknown as { calls: string[] }).calls.find((url) =>
      url.includes('/search'),
    )
    const params = new URL(search as string).searchParams
    expect(params.get('regionCode')).toBe('US')
    expect(params.get('relevanceLanguage')).toBe('en')
  })
})

describe('the regional popularity chart', () => {
  it('asks for the configured region first', async () => {
    const db = createTestDatabase()
    const fetchImpl = stubFetch([['/videos', { items: [] }]])

    const summary = await discoverPopular(
      envWith(db),
      { ...DEFAULT_SETTINGS, region: 'JP' },
      NOW,
      { fetchImpl },
    )

    expect(summary.queries[0]).toMatch(/^JP\//)
    const first = (fetchImpl as unknown as { calls: string[] }).calls[0] as string
    expect(new URL(first).searchParams.get('regionCode')).toBe('JP')
  })

  it('costs no search calls at all', async () => {
    const db = createTestDatabase()
    const fetchImpl = stubFetch([['/videos', { items: [] }]])

    const summary = await discoverPopular(envWith(db), DEFAULT_SETTINGS, NOW, { fetchImpl })

    expect(summary.searchCalls).toBe(0)
    expect(summary.listCalls).toBeGreaterThan(0)
  })

  it('fills the catalog before anything has been rated', async () => {
    // Every other pass needs a seed. Without this one, a fresh installation with no
    // subscriptions and no ratings discovers nothing whatsoever.
    const db = createTestDatabase()
    const fetchImpl = stubFetch([
      ['/videos', {
        items: [{
          id: 'jp1',
          snippet: {
            title: '日本語の動画',
            channelId: 'UCjp',
            channelTitle: '日本語チャンネル',
            publishedAt: '2026-08-20T00:00:00Z',
          },
          contentDetails: { duration: 'PT12M' },
          statistics: { viewCount: '4321' },
        }],
      }],
    ])

    const result = await runDiscovery(envWith(db), 'default', NOW, {
      lanes: ['explore'],
      fetchImpl,
    })

    const chart = result.summaries.find((entry) => entry.queries.some((q) => q.includes('/')))
    expect(chart?.stored).toBe(1)

    const row = await db
      .prepare('SELECT title FROM videos WHERE id = ?1')
      .bind('youtube:jp1')
      .first<{ title: string }>()
    expect(row?.title).toBe('日本語の動画')
  })

  it('does not let one region without a chart stop the others', async () => {
    const db = createTestDatabase()
    const env = { ...envWith(db), CRAWL_REGIONS: 'JP,US', CRAWL_CATEGORIES: '28' } as Env
    const fetchImpl = stubFetch([
      [/regionCode=JP/, { error: { message: 'not found' } }, 404],
      ['/videos', { items: [] }],
    ])

    const summary = await discoverPopular(env, { ...DEFAULT_SETTINGS, region: 'JP' }, NOW, {
      fetchImpl,
    })

    // Which region and category pairs are charted varies and changes over time, so a
    // 404 means "nothing to fetch here" rather than a fault.
    expect(summary.errors).toEqual([])
    expect(summary.queries).toEqual(['JP/28', 'US/28'])
  })

  it('does not ask the same region twice when the setting is already in the list', async () => {
    const db = createTestDatabase()
    const env = { ...envWith(db), CRAWL_REGIONS: 'JP,US', CRAWL_CATEGORIES: '28' } as Env
    const fetchImpl = stubFetch([['/videos', { items: [] }]])

    const summary = await discoverPopular(env, { ...DEFAULT_SETTINGS, region: 'JP' }, NOW, {
      fetchImpl,
    })

    expect(summary.queries).toEqual(['JP/28', 'US/28'])
  })
})

describe('adjacency gaps found by real ratings', () => {
  it('has somewhere to go from VTuber and cover-song seeds', () => {
    // A live run seeded `vtuber` / `バーチャルyoutuber` and matched nothing, so the
    // explore lane offered a viewer of music videos a search for operating system
    // design. These are the entries that were missing.
    for (const seed of ['vtuber', 'バーチャルyoutuber', '歌ってみた', 'ボカロ']) {
      const topics = adjacentTopics([seed], 3, 'ja')
      expect(topics.length, `no neighbours for ${seed}`).toBeGreaterThan(0)
      for (const topic of topics) expect(scriptOf(topic)).toBe('ja')
    }
  })

  it('does not send a music viewer toward systems programming', () => {
    const topics = adjacentTopics(['vtuber', '歌ってみた'], 5, 'ja')
    expect(topics.join(' ')).not.toMatch(/オペレーティングシステム|アーキテクチャ/)
  })

  it('drops the quotative particle that reached a live search', () => {
    // 「って」 came out of the term extractor and was searched for, spending one of a
    // hundred daily calls on a term that matches everything.
    const terms = interestTerms(
      [{ title: 'これってすごいって話', tags: [], channelTitle: null, rating: 5 }],
      10,
    )
    expect(terms).not.toContain('って')
  })
})
