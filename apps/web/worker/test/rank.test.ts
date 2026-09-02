import { describe, expect, it } from 'vitest'
import type { Channel, InterestControl, Video } from '@ypr/domain'
import { DEFAULT_SETTINGS } from '@ypr/domain'
import { freshness, matchInterests, poolMean, scoreCandidate, type ScoringContext } from '../services/recommendation/rank.js'

/**
 * The scoring function (design section 33).
 *
 * Every term is tested on its own, because the point of writing the score as a sum of
 * named terms rather than as a model call is that each one can be checked and
 * explained. A test that only asserted the total would give that up.
 */

const NOW = Date.parse('2026-08-24T00:00:00Z')

function video(overrides: Partial<Video> = {}): Video {
  return {
    id: 'youtube:a',
    source: 'youtube',
    externalId: 'a',
    channelId: 'youtube:UC1',
    title: 'Inside the Firefox rendering engine',
    description: '',
    thumbnailUrl: null,
    publishedAt: NOW,
    durationSeconds: 900,
    viewCount: 1_000,
    metadata: { tags: ['firefox', 'browser'], channelTitle: 'Deep Dives' },
    discoveredAt: NOW,
    refreshedAt: null,
    ...overrides,
  }
}

function channel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'youtube:UC1',
    source: 'youtube',
    externalId: 'UC1',
    title: 'Deep Dives',
    thumbnailUrl: null,
    subscribed: false,
    lastFetchedAt: null,
    ...overrides,
  }
}

function interest(overrides: Partial<InterestControl> = {}): InterestControl {
  return {
    id: 'i1',
    profileId: 'default',
    keyword: 'firefox',
    weight: 1,
    muteUntil: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

function context(overrides: Partial<ScoringContext> = {}): ScoringContext {
  return {
    settings: { ...DEFAULT_SETTINGS, discovery: 0 },
    now: NOW,
    interests: [],
    scores: new Map(),
    seen: new Map(),
    ratedChannelIds: new Set(['youtube:UC1']),
    neutralScore: 5,
    ...overrides,
  }
}

describe('the preference term', () => {
  it('is 0.65 of the predicted rating, as the design writes it', () => {
    const scored = scoreCandidate(
      { video: video(), channel: channel(), lane: 'related' },
      context({ scores: new Map([['youtube:a', 8]]) }),
    )
    expect(scored.breakdown.preference).toBeCloseTo(0.65 * 8)
    expect(scored.predictedScore).toBe(8)
  })

  it('uses the pool mean for a video the model has not scored', () => {
    // A fixed neutral would sit above or below the whole pool depending on how
    // generously the user rates, so an unscored video would either dominate the feed
    // or never appear in it.
    const scored = scoreCandidate(
      { video: video(), channel: channel(), lane: 'explore' },
      context({ neutralScore: 3.2 }),
    )
    expect(scored.breakdown.preference).toBeCloseTo(0.65 * 3.2)
    expect(scored.predictedScore).toBeNull()
  })

  it('takes the mean of what has actually been scored', () => {
    expect(poolMean(new Map([['a', 4], ['b', 6]]))).toBe(5)
    expect(poolMean(new Map())).toBe(5)
  })
})

describe('the bonuses and penalties', () => {
  it('adds the subscription bonus only for a subscribed channel', () => {
    const subscribed = scoreCandidate(
      { video: video(), channel: channel({ subscribed: true }), lane: 'subscription' },
      context(),
    )
    const not = scoreCandidate({ video: video(), channel: channel(), lane: 'related' }, context())

    expect(subscribed.breakdown.subscriptionBonus).toBeCloseTo(DEFAULT_WEIGHT('subscriptionBonus'))
    expect(not.breakdown.subscriptionBonus).toBe(0)
  })

  it('halves the freshness bonus every half-life', () => {
    const halfLife = DEFAULT_SETTINGS.freshnessHalfLifeDays
    const fresh = freshness(video(), NOW, halfLife)
    const oneHalfLifeOld = freshness(
      video({ publishedAt: NOW - halfLife * 86_400_000 }),
      NOW,
      halfLife,
    )
    expect(fresh).toBeCloseTo(1)
    expect(oneHalfLifeOld).toBeCloseTo(0.5)
  })

  it('never rewards a video published in the future more than one published now', () => {
    expect(freshness(video({ publishedAt: NOW + 86_400_000 }), NOW, 7)).toBeCloseTo(1)
  })

  it('grows the seen penalty with repeat showings and caps it', () => {
    const once = scoreCandidate(
      { video: video(), channel: channel(), lane: 'related' },
      context({ seen: new Map([['youtube:a', 1]]) }),
    )
    const many = scoreCandidate(
      { video: video(), channel: channel(), lane: 'related' },
      context({ seen: new Map([['youtube:a', 9]]) }),
    )
    expect(once.breakdown.seenPenalty).toBeGreaterThan(0)
    expect(many.breakdown.seenPenalty).toBeCloseTo(DEFAULT_WEIGHT('seenPenalty'))
    expect(many.breakdown.seenPenalty).toBeGreaterThan(once.breakdown.seenPenalty)
  })

  it('gives the exploration bonus for an unrated channel, scaled by the slider', () => {
    const unrated = { video: video(), channel: channel({ id: 'youtube:UCnew' }), lane: 'related' as const }

    const off = scoreCandidate(unrated, context({ settings: { ...DEFAULT_SETTINGS, discovery: 0 } }))
    const on = scoreCandidate(unrated, context({ settings: { ...DEFAULT_SETTINGS, discovery: 1 } }))

    expect(off.breakdown.explorationBonus).toBe(0)
    expect(on.breakdown.explorationBonus).toBeCloseTo(DEFAULT_WEIGHT('explorationBonus'))
  })

  it('sums to the total it reports', () => {
    const scored = scoreCandidate(
      { video: video(), channel: channel({ subscribed: true }), lane: 'subscription' },
      context({ scores: new Map([['youtube:a', 9]]), seen: new Map([['youtube:a', 2]]) }),
    )
    const { total, ...terms } = scored.breakdown
    const sum =
      terms.preference +
      terms.subscriptionBonus +
      terms.freshnessBonus +
      terms.explicitInterestBonus +
      terms.explorationBonus -
      terms.seenPenalty -
      terms.mutedInterestPenalty
    expect(total).toBeCloseTo(sum)
    expect(scored.score).toBeCloseTo(total)
  })
})

describe('interest controls', () => {
  it('contributes nothing at the neutral weight', () => {
    const match = matchInterests(
      { video: video(), channel: channel(), lane: 'related' },
      [interest({ weight: 1 })],
      NOW,
    )
    expect(match.matched).toEqual(['firefox'])
    expect(match.boost).toBe(0)
  })

  it('boosts above one and reduces below it', () => {
    const up = matchInterests({ video: video(), channel: channel(), lane: 'related' }, [interest({ weight: 1.4 })], NOW)
    const down = matchInterests({ video: video(), channel: channel(), lane: 'related' }, [interest({ weight: 0.5 })], NOW)
    expect(up.boost).toBeCloseTo(0.4)
    expect(down.boost).toBeCloseTo(-0.5)
  })

  it('applies a timed mute until it expires, then stops', () => {
    const control = interest({ weight: 1.5, muteUntil: NOW + 86_400_000 })
    const candidate = { video: video(), channel: channel(), lane: 'related' as const }

    expect(matchInterests(candidate, [control], NOW).muted).toBe(true)
    // Past the expiry the stored weight comes back, which is why the mute is a
    // separate column rather than a weight of zero written over it.
    const later = matchInterests(candidate, [control], NOW + 2 * 86_400_000)
    expect(later.muted).toBe(false)
    expect(later.boost).toBeCloseTo(0.5)
  })

  it('penalises a muted keyword heavily enough to sink the item', () => {
    const scored = scoreCandidate(
      { video: video(), channel: channel({ subscribed: true }), lane: 'subscription' },
      context({ interests: [interest({ weight: 0 })], scores: new Map([['youtube:a', 10]]) }),
    )
    expect(scored.breakdown.mutedInterestPenalty).toBeGreaterThan(0)
    expect(scored.score).toBeLessThan(
      scoreCandidate(
        { video: video(), channel: channel({ subscribed: true }), lane: 'subscription' },
        context({ scores: new Map([['youtube:a', 10]]) }),
      ).score,
    )
  })

  it('matches the channel name and the tags, not only the title', () => {
    const byChannel = matchInterests(
      { video: video({ title: 'Something else entirely' }), channel: channel(), lane: 'related' },
      [interest({ keyword: 'Deep Dives' })],
      NOW,
    )
    const byTag = matchInterests(
      { video: video({ title: 'Something else entirely' }), channel: channel(), lane: 'related' },
      [interest({ keyword: 'browser' })],
      NOW,
    )
    expect(byChannel.matched).toEqual(['Deep Dives'])
    expect(byTag.matched).toEqual(['browser'])
  })

  it('caps the boost so three keywords do not treble an item', () => {
    const match = matchInterests(
      { video: video({ metadata: { tags: ['firefox', 'browser', 'gecko'] } }), channel: channel(), lane: 'related' },
      [
        interest({ id: 'a', keyword: 'firefox', weight: 3 }),
        interest({ id: 'b', keyword: 'browser', weight: 3 }),
        interest({ id: 'c', keyword: 'gecko', weight: 3 }),
      ],
      NOW,
    )
    expect(match.boost).toBe(2)
  })
})

describe('recommendation reasons', () => {
  it('names the subscription and the interest that fired', () => {
    const scored = scoreCandidate(
      { video: video(), channel: channel({ subscribed: true }), lane: 'subscription' },
      context({ interests: [interest({ weight: 1.4 })], scores: new Map([['youtube:a', 9]]) }),
    )
    const kinds = scored.reasons.map((reason) => reason.kind)
    expect(kinds).toContain('subscribed_channel')
    expect(kinds).toContain('predicted_high')
    expect(scored.reasons.find((reason) => reason.kind === 'interest_boost')?.subject).toBe('firefox')
  })

  it('does not claim a high prediction when there is none', () => {
    const scored = scoreCandidate({ video: video(), channel: channel(), lane: 'explore' }, context())
    expect(scored.reasons.map((reason) => reason.kind)).not.toContain('predicted_high')
    expect(scored.reasons.map((reason) => reason.kind)).toContain('exploring')
  })
})

function DEFAULT_WEIGHT(key: keyof typeof DEFAULT_SETTINGS.weights): number {
  return DEFAULT_SETTINGS.weights[key]
}
