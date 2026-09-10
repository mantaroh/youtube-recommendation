import { describe, expect, it } from 'vitest'
import type { RatingValue } from '@ypr/domain'
import type { Env } from '../env.js'
import { appendRating } from '../db/ratings.js'
import { channelInterests, interestTerms } from '../services/discovery/keywords.js'
import { expandFromLikedChannels, interleaveTerms } from '../services/discovery/index.js'
import { markChannelsFetched } from '../db/videos.js'
import { createTestDatabase } from './d1.js'
import { seedVideo, stubFetch } from './fixtures.js'

/**
 * Finding channels like the ones already liked.
 *
 * The case that prompted it: a reader rating `ゆる民俗学ラジオ` well had never been
 * offered `ゆる言語学ラジオ`, because nothing had ever searched for it. The search lane
 * pools every rating into one ranking and takes the top few terms, so fifteen ratings on
 * one taste take every query and five on another take none — not fewer, none.
 */

const NOW = 1_700_000_000_000

function envWith(db: D1Database): Env {
  return { DB: db, YOUTUBE_API_KEY: 'test-key', DISCOVERY_SEARCH_BUDGET: '30' } as Env
}

async function rate(db: D1Database, id: string, channel: string, rating: RatingValue, index: number) {
  await seedVideo(db, { id, channelExternalId: channel, channelTitle: channel, title: `${channel} video ${index}` })
  await appendRating(db, {
    id: `e-${id}`,
    profileId: 'default',
    videoId: id,
    rating,
    createdAt: NOW + index,
  })
}

describe('splitting terms by channel', () => {
  /**
   * The real mechanism, measured rather than assumed.
   *
   * `interestTerms` weights a tag twice as heavily as a word from a title, and the
   * educational channel this reader rates does not tag its videos at all — five ratings,
   * five with no tags. So it contributed almost nothing to the pooled ranking while a
   * channel that tags every upload filled it, and every search the system had ever run
   * was about the tagged taste.
   *
   * It was never a question of which taste had more ratings.
   */
  it('rescues a channel that tags nothing, which the pooled ranking loses', () => {
    const rated = [
      ...Array.from({ length: 6 }, (_, index) => ({
        title: `stream ${index}`,
        tags: ['vtuber', 'clip', 'stream'],
        channelId: 'youtube:UCvtuber',
        channelTitle: 'Some VTuber',
        rating: 5,
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        title: `民俗学ラジオ ${index}`,
        tags: [],
        channelId: 'youtube:UCfolk',
        channelTitle: 'Folklore Radio',
        rating: 5,
      })),
    ]

    // Tagged terms take the top of the pooled ranking; the untagged channel's name is
    // nowhere in it, because a channel name is not a term the pooled ranking collects.
    const pooled = interestTerms(rated, 5)
    expect(pooled).toContain('vtuber')
    expect(pooled.some((term) => term.toLowerCase().includes('folklore'))).toBe(false)

    // Per channel, the name is the first term — the strongest description of a channel
    // that exists, and the one a channel search matches on.
    const perChannel = channelInterests(rated)
    expect(perChannel).toHaveLength(2)
    const folklore = perChannel.find((entry) => entry.channelTitle === 'Folklore Radio')
    expect(folklore?.terms[0]).toBe('Folklore Radio')
  })

  it('ranks by how well liked, not by how often rated', () => {
    // Six ratings averaging 3 is a weaker claim than two averaging 5, and the pass only
    // asks about the first few.
    const rated = [
      ...Array.from({ length: 6 }, (_, index) => ({
        title: `ok ${index}`, tags: ['ok'], channelId: 'youtube:UCok', channelTitle: 'Fine', rating: 3,
      })),
      ...Array.from({ length: 2 }, (_, index) => ({
        title: `great ${index}`, tags: ['great'], channelId: 'youtube:UCgreat', channelTitle: 'Great', rating: 5,
      })),
    ]
    expect(channelInterests(rated)[0].channelTitle).toBe('Great')
  })

  it('ignores channels the reader said no to', () => {
    const rated = [
      { title: 'a', tags: [], channelId: 'youtube:UCbad', channelTitle: 'Disliked', rating: 1 },
      { title: 'b', tags: [], channelId: 'youtube:UCgood', channelTitle: 'Liked', rating: 4 },
    ]
    expect(channelInterests(rated).map((entry) => entry.channelTitle)).toEqual(['Liked'])
  })
})

describe('the expansion pass', () => {
  it('searches for channels and takes their uploads', async () => {
    const db = createTestDatabase()
    await rate(db, 'youtube:v1', 'UCfolk', 5, 1)

    const fetchImpl = stubFetch([
      ['type=channel', { items: [{ id: { channelId: 'UCneighbour' } }] }],
      ['playlistItems', { items: [{ contentDetails: { videoId: 'newvid' } }] }],
      ['/videos', {
        items: [{
          id: 'newvid',
          snippet: {
            title: 'A neighbouring show',
            description: '',
            channelId: 'UCneighbour',
            channelTitle: 'Neighbour',
            publishedAt: new Date(NOW).toISOString(),
            thumbnails: { high: { url: 'https://i.example.test/newvid.jpg' } },
            tags: [],
          },
          contentDetails: { duration: 'PT20M' },
          statistics: { viewCount: '10' },
        }],
      }],
    ])

    const summary = await expandFromLikedChannels(envWith(db), 'default', NOW, { fetchImpl })

    expect(summary.stored).toBe(1)
    // The channel's own name goes first: the strongest description of it that exists.
    // Its other terms follow as further queries, one search each.
    expect(summary.queries[0]).toBe('UCfolk')
    expect(summary.searchCalls).toBe(summary.queries.length)
  })

  it('says so rather than searching when nothing has been rated', async () => {
    const db = createTestDatabase()
    // No fetch stub: a call would throw rather than pass.
    const summary = await expandFromLikedChannels(envWith(db), 'default', NOW)
    expect(summary.errors).toEqual(['no highly rated channels yet: rate a few videos first'])
    expect(summary.searchCalls).toBe(0)
  })

  it('stops at the search allowance rather than spending past it', async () => {
    const db = createTestDatabase()
    for (let index = 0; index < 3; index++) {
      await rate(db, `youtube:v${index}`, `UCc${index}`, 5, index)
    }

    const fetchImpl = stubFetch([['type=channel', { items: [] }]])
    const summary = await expandFromLikedChannels(envWith(db), 'default', NOW, {
      searchBudget: 1,
      fetchImpl,
    })

    expect(summary.searchCalls).toBe(1)
    expect(summary.errors).toContain('search allowance spent')
  })
})

describe('spending the search allowance', () => {
  /**
   * The first version joined a channel's terms into one query. It read as economical and
   * found almost nothing: three searches, five videos, and the channel the reader was
   * missing still absent. `search` given four channel names matches none of them.
   */
  it('spends one term per query rather than joining them', () => {
    const queries = interleaveTerms([{ terms: ['Folklore Radio', 'folklore', 'radio'] }], 3)
    expect(queries).toEqual(['Folklore Radio', 'folklore', 'radio'])
  })

  it('takes one term from each channel before a second from any', () => {
    // The allowance runs out mid-list. In order, the best-liked channel would spend the
    // whole run and the others would go unasked — the failure this pass exists to fix.
    const queries = interleaveTerms(
      [
        { terms: ['A1', 'A2', 'A3'] },
        { terms: ['B1', 'B2'] },
        { terms: ['C1'] },
      ],
      5,
    )
    expect(queries).toEqual(['A1', 'B1', 'C1', 'A2', 'B2'])
  })

  it('does not spend two searches on the same term', () => {
    const queries = interleaveTerms([{ terms: ['same', 'x'] }, { terms: ['SAME', 'y'] }], 4)
    expect(queries).toEqual(['same', 'x', 'y'])
  })

  it('stops at the limit', () => {
    expect(interleaveTerms([{ terms: ['a', 'b', 'c'] }], 2)).toEqual(['a', 'b'])
    expect(interleaveTerms([], 3)).toEqual([])
  })
})

describe('which channels are worth walking', () => {
  /**
   * A channel row appears the moment one of its videos turns up in a search result. A
   * thousand of the seventeen hundred stored had never had their uploads read, and
   * skipping on "is in the catalog" threw away almost every channel the pass found.
   */
  it('walks a channel that is known but has never been read', async () => {
    const db = createTestDatabase()
    await rate(db, 'youtube:v1', 'UCfolk', 5, 1)
    // Known because one of its videos was seen, never walked.
    await seedVideo(db, { id: 'youtube:seen', channelExternalId: 'UCneighbour' })

    const fetchImpl = stubFetch([
      ['type=channel', { items: [{ id: { channelId: 'UCneighbour' } }] }],
      ['playlistItems', { items: [{ contentDetails: { videoId: 'fresh' } }] }],
      ['/videos', {
        items: [{
          id: 'fresh',
          snippet: {
            title: 'Something new',
            description: '',
            channelId: 'UCneighbour',
            channelTitle: 'Neighbour',
            publishedAt: new Date(NOW).toISOString(),
            thumbnails: { high: { url: 'https://i.example.test/fresh.jpg' } },
            tags: [],
          },
          contentDetails: { duration: 'PT20M' },
          statistics: { viewCount: '10' },
        }],
      }],
    ])

    const summary = await expandFromLikedChannels(envWith(db), 'default', NOW, { fetchImpl })
    expect(summary.stored).toBe(1)
  })

  it('leaves alone a channel whose uploads have been read', async () => {
    const db = createTestDatabase()
    await rate(db, 'youtube:v1', 'UCfolk', 5, 1)
    await seedVideo(db, { id: 'youtube:seen', channelExternalId: 'UCdone' })
    await markChannelsFetched(db, ['youtube:UCdone'], NOW)

    const fetchImpl = stubFetch([['type=channel', { items: [{ id: { channelId: 'UCdone' } }] }]])
    const summary = await expandFromLikedChannels(envWith(db), 'default', NOW, { fetchImpl })

    expect(summary.found).toBe(0)
    expect(summary.listCalls).toBe(0)
  })
})
