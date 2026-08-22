import { describe, expect, it } from 'vitest'
import type { CatalogItem, PreferenceState } from '@ypr/shared'
import {
  assembleFeed,
  laneQuotas,
  laneShares,
  mmrRerank,
  popularityTier,
  scoreCandidate,
  type Candidate,
} from '../src/ranker.js'
import { DEFAULT_SCORE_WEIGHTS } from '../src/constants.js'
import { addDays } from '../src/decay.js'

const NOW = '2026-08-22T00:00:00.000Z'
const TOPIC = {
  browser: Float32Array.from([1, 0, 0, 0]),
  os: Float32Array.from([0, 1, 0, 0]),
  cooking: Float32Array.from([0, 0, 1, 0]),
}

function item(overrides: Partial<CatalogItem> & { externalId: string }): CatalogItem {
  return {
    source: 'youtube',
    title: overrides.externalId,
    description: '',
    tags: [],
    channelId: 'UC_default',
    channelTitle: '',
    officialCategoryId: '28',
    durationSeconds: 600,
    publishedAt: NOW,
    viewCount: 20_000,
    metadataFetchedAt: NOW,
    expiresAt: addDays(NOW, 30),
    provenance: 'fixture',
    ...overrides,
  }
}

function cluster(overrides: Partial<PreferenceState['clusters'][number]> & { id: string; centroid: Float32Array }) {
  return {
    label: overrides.id,
    labelSource: 'auto' as const,
    memberIds: [],
    massLong: 1,
    massShort: 1,
    massNegative: 0,
    normalisedLong: 1,
    normalisedShort: 1,
    normalisedNegative: 0,
    explicitStrength: null,
    pinned: false,
    mutedUntil: null,
    forgotten: false,
    activity: 1,
    updatedAt: NOW,
    ...overrides,
  }
}

function state(overrides: Partial<PreferenceState> = {}): PreferenceState {
  return {
    clusters: [],
    channels: {},
    ratedKeys: [],
    seenKeys: [],
    atSeq: 0,
    evaluatedAt: NOW,
    modelId: 'test',
    dimensions: 4,
    ...overrides,
  }
}

describe('scoring', () => {
  const liked = state({ clusters: [cluster({ id: 'browser', centroid: TOPIC.browser })] })

  it('rewards closeness to an active interest', () => {
    const near = scoreCandidate({ item: item({ externalId: 'a' }), embedding: TOPIC.browser }, {
      state: liked,
      now: NOW,
    })
    const far = scoreCandidate({ item: item({ externalId: 'b' }), embedding: TOPIC.cooking }, {
      state: liked,
      now: NOW,
    })

    expect(near.long).toBeCloseTo(1, 5)
    expect(far.long).toBe(0)
    expect(near.total).toBeGreaterThan(far.total)
    expect(near.topClusterLabel).toBe('browser')
  })

  it('scores novelty highest for what is furthest from every interest', () => {
    const unknown = scoreCandidate({ item: item({ externalId: 'x' }), embedding: TOPIC.cooking }, {
      state: liked,
      now: NOW,
    })
    expect(unknown.explore).toBeCloseTo(1, 5)
  })

  it('suppresses topics the user asked for less of', () => {
    const disliked = state({
      clusters: [
        cluster({
          id: 'cooking',
          centroid: TOPIC.cooking,
          massLong: -2,
          normalisedLong: 0,
          normalisedShort: 0,
          normalisedNegative: 1,
          activity: 0,
        }),
      ],
    })
    const scored = scoreCandidate({ item: item({ externalId: 'k' }), embedding: TOPIC.cooking }, {
      state: disliked,
      now: NOW,
    })

    expect(scored.negative).toBeCloseTo(1, 5)
    expect(scored.total).toBeLessThan(0)
  })

  it('lets a forgotten interest neither attract nor suppress', () => {
    const forgotten = state({
      clusters: [cluster({ id: 'browser', centroid: TOPIC.browser, forgotten: true, normalisedNegative: 1 })],
    })
    const scored = scoreCandidate({ item: item({ externalId: 'a' }), embedding: TOPIC.browser }, {
      state: forgotten,
      now: NOW,
    })
    expect(scored.long).toBe(0)
    expect(scored.negative).toBe(0)
  })

  it('keeps suppressing through a mute, because a mute is not a change of mind', () => {
    const muted = state({
      clusters: [
        cluster({
          id: 'cooking',
          centroid: TOPIC.cooking,
          activity: 0,
          mutedUntil: addDays(NOW, 30),
          normalisedNegative: 1,
        }),
      ],
    })
    const scored = scoreCandidate({ item: item({ externalId: 'k' }), embedding: TOPIC.cooking }, {
      state: muted,
      now: NOW,
    })
    expect(scored.long).toBe(0)
    expect(scored.negative).toBeCloseTo(1, 5)
  })

  it('smooths channel affinity so one rating cannot make a channel perfect', () => {
    const oneRating = state({ channels: { UC_a: { channelId: 'UC_a', weightSum: 1, ratedCount: 1 } } })
    const manyRatings = state({ channels: { UC_a: { channelId: 'UC_a', weightSum: 10, ratedCount: 10 } } })

    const single = scoreCandidate({ item: item({ externalId: 'a', channelId: 'UC_a' }) }, {
      state: oneRating,
      now: NOW,
    })
    const repeated = scoreCandidate({ item: item({ externalId: 'a', channelId: 'UC_a' }) }, {
      state: manyRatings,
      now: NOW,
    })

    expect(single.channel).toBeCloseTo(0.25, 5)
    expect(repeated.channel).toBeGreaterThan(single.channel)
    expect(repeated.channel).toBeLessThan(1)
  })

  it('adds a bonus for subscribed channels', () => {
    const scored = scoreCandidate({ item: item({ externalId: 'a', channelId: 'UC_a' }) }, {
      state: state(),
      now: NOW,
      subscribedChannelIds: new Set(['UC_a']),
    })
    expect(scored.channel).toBeCloseTo(0.5, 5)
  })

  it('penalises what has already been rated or shown', () => {
    const seenState = state({ ratedKeys: ['youtube:a'], seenKeys: ['youtube:a'] })
    const scored = scoreCandidate({ item: item({ externalId: 'a' }) }, { state: seenState, now: NOW })
    expect(scored.penalty).toBeCloseTo(1.9, 5)
  })

  it('decays freshness with a 30 day half-life', () => {
    const fresh = scoreCandidate({ item: item({ externalId: 'a' }) }, { state: state(), now: NOW })
    const month = scoreCandidate({ item: item({ externalId: 'b', publishedAt: addDays(NOW, -30) }) }, {
      state: state(),
      now: NOW,
    })
    expect(fresh.freshness).toBeCloseTo(1, 5)
    expect(month.freshness).toBeCloseTo(0.5, 5)
  })

  it('ranks an item with no vector without crashing', () => {
    const scored = scoreCandidate({ item: item({ externalId: 'a' }) }, { state: liked, now: NOW })
    expect(scored.long).toBe(0)
    expect(scored.explore).toBe(0)
    expect(Number.isFinite(scored.total)).toBe(true)
  })
})

describe('popularity strata', () => {
  it('splits on view count, with old and small counting as wildcard', () => {
    expect(popularityTier(item({ externalId: 'a', viewCount: 50_000 }), NOW)).toBe('established')
    expect(popularityTier(item({ externalId: 'b', viewCount: 100 }), NOW)).toBe('emerging')
    expect(
      popularityTier(item({ externalId: 'c', viewCount: 100, publishedAt: addDays(NOW, -200) }), NOW),
    ).toBe('wildcard')
  })
})

describe('lane shares', () => {
  it('moves from subscriptions toward exploration as the slider moves', () => {
    const stable = laneShares(0)
    const discovery = laneShares(1)

    expect(stable.subscription).toBeCloseTo(0.6, 5)
    expect(stable.explore).toBeCloseTo(0.1, 5)
    expect(discovery.subscription).toBeCloseTo(0.3, 5)
    expect(discovery.explore).toBeCloseTo(0.4, 5)
    for (const shares of [stable, discovery]) {
      expect(shares.subscription + shares.related + shares.explore).toBeCloseTo(1, 5)
    }
  })

  it('produces quotas that add up to the requested feed size', () => {
    for (const discovery of [0, 0.3, 0.5, 0.77, 1]) {
      for (const size of [10, 17, 40]) {
        const quotas = laneQuotas(discovery, size)
        expect(quotas.subscription + quotas.related + quotas.explore).toBe(size)
      }
    }
  })
})

describe('feed assembly', () => {
  const liked = state({
    clusters: [cluster({ id: 'browser', centroid: TOPIC.browser })],
    channels: { UC_sub: { channelId: 'UC_sub', weightSum: 4, ratedCount: 4 } },
  })

  const candidate = (id: string, topic: keyof typeof TOPIC, overrides: Partial<CatalogItem> = {}): Candidate => ({
    item: item({ externalId: id, ...overrides }),
    embedding: TOPIC[topic],
  })

  it('respects lane quotas and never repeats an item across lanes', () => {
    const shared = candidate('shared', 'browser', { channelId: 'UC_sub' })
    const feed = assembleFeed({
      state: liked,
      now: NOW,
      discovery: 0.5,
      feedSize: 6,
      candidates: {
        subscription: [shared, candidate('s2', 'browser', { channelId: 'UC_sub' })],
        related: [shared, candidate('r1', 'browser'), candidate('r2', 'browser')],
        explore: [candidate('e1', 'cooking'), candidate('e2', 'os')],
      },
    })

    const ids = feed.map((entry) => entry.item.externalId)
    expect(new Set(ids).size).toBe(ids.length)
    // A video from a followed channel is presented as such rather than as "related".
    expect(feed.find((entry) => entry.item.externalId === 'shared')?.lane).toBe('subscription')
  })

  it('draws from all three lanes rather than letting one crowd the feed out', () => {
    const feed = assembleFeed({
      state: liked,
      now: NOW,
      discovery: 0.5,
      feedSize: 9,
      candidates: {
        subscription: Array.from({ length: 6 }, (_, index) =>
          candidate(`s${index}`, 'browser', { channelId: 'UC_sub' }),
        ),
        related: Array.from({ length: 6 }, (_, index) => candidate(`r${index}`, 'browser')),
        explore: Array.from({ length: 6 }, (_, index) => candidate(`e${index}`, 'cooking')),
      },
    })

    expect(new Set(feed.map((entry) => entry.lane)).size).toBe(3)
    // The explore lane brings in something outside the user's established interests.
    expect(feed.some((entry) => entry.breakdown.explore > 0.9)).toBe(true)
  })

  it('gives small and evergreen videos a share instead of filtering them out', () => {
    const established = Array.from({ length: 20 }, (_, index) =>
      candidate(`big${index}`, 'browser', { viewCount: 500_000 }),
    )
    const small = Array.from({ length: 5 }, (_, index) =>
      candidate(`small${index}`, 'browser', { viewCount: 120 }),
    )

    const feed = assembleFeed({
      state: liked,
      now: NOW,
      discovery: 0.5,
      feedSize: 40,
      candidates: { related: [...established, ...small] },
    })

    expect(feed.some((entry) => entry.item.viewCount < 1000)).toBe(true)
  })

  it('still reserves a slot for a minority stratum when the lane is small', () => {
    // Independent rounding would give 20% of a three-slot lane zero slots.
    const established = Array.from({ length: 10 }, (_, index) =>
      candidate(`big${index}`, 'browser', { viewCount: 500_000 }),
    )
    const small = [candidate('small', 'browser', { viewCount: 120 })]

    const feed = assembleFeed({
      state: liked,
      now: NOW,
      discovery: 0,
      feedSize: 10,
      candidates: { related: [...established, ...small] },
    })

    expect(feed.some((entry) => entry.item.externalId === 'small')).toBe(true)
  })

  it('returns a short feed rather than an empty one when the catalog is thin', () => {
    const feed = assembleFeed({
      state: liked,
      now: NOW,
      discovery: 0.5,
      feedSize: 20,
      candidates: { related: [candidate('r1', 'browser')] },
    })
    expect(feed).toHaveLength(1)
  })
})

describe('MMR', () => {
  it('prefers a lower scoring item over a near-duplicate of what is already chosen', () => {
    const entries = [
      { lane: 'related' as const, entry: mmrEntry('a', TOPIC.browser, 1.0) },
      { lane: 'related' as const, entry: mmrEntry('a-dup', TOPIC.browser, 0.95) },
      { lane: 'related' as const, entry: mmrEntry('b', TOPIC.os, 0.6) },
    ]

    const reranked = mmrRerank(entries, 2, 0.5)
    expect(reranked.map((item) => item.entry.candidate.item.externalId)).toEqual(['a', 'b'])
  })

  it('keeps pure score order when lambda is 1', () => {
    const entries = [
      { lane: 'related' as const, entry: mmrEntry('a', TOPIC.browser, 1.0) },
      { lane: 'related' as const, entry: mmrEntry('a-dup', TOPIC.browser, 0.95) },
      { lane: 'related' as const, entry: mmrEntry('b', TOPIC.os, 0.6) },
    ]
    const reranked = mmrRerank(entries, 3, 1)
    expect(reranked.map((item) => item.entry.candidate.item.externalId)).toEqual(['a', 'a-dup', 'b'])
  })
})

function mmrEntry(id: string, embedding: Float32Array, total: number) {
  return {
    candidate: { item: item({ externalId: id }), embedding },
    tier: 'established' as const,
    breakdown: {
      channel: 0,
      long: total,
      short: 0,
      negative: 0,
      explore: 0,
      freshness: 0,
      penalty: 0,
      total,
      topClusterId: null,
      topClusterLabel: null,
      topClusterSimilarity: 0,
    },
  }
}

describe('default weights', () => {
  it('ships the implicit watch signal switched off', () => {
    expect(DEFAULT_SCORE_WEIGHTS.watch).toBe(0)
  })

  it('weights an explicit dislike above a similar positive match', () => {
    expect(DEFAULT_SCORE_WEIGHTS.negative).toBeGreaterThan(DEFAULT_SCORE_WEIGHTS.long)
  })
})
