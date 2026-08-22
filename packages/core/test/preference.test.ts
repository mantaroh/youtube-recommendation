import { describe, expect, it } from 'vitest'
import type { AppEvent, RatingValue } from '@ypr/shared'
import { buildPreferenceState } from '../src/preference.js'
import { addDays } from '../src/decay.js'
import { PIN_MIN_ACTIVITY } from '../src/constants.js'

/**
 * The geometry is built by hand rather than run through an embedding model, so that a
 * failure here means the preference model is wrong rather than that a model moved.
 */
const DIMENSIONS = 4
const TOPIC = {
  browser: Float32Array.from([1, 0, 0, 0]),
  os: Float32Array.from([0, 1, 0, 0]),
  cooking: Float32Array.from([0, 0, 1, 0]),
}

const NOW = '2026-08-22T00:00:00.000Z'

interface Rating {
  id: string
  topic: keyof typeof TOPIC
  rating: RatingValue
  ts: string
  channelId?: string
}

function scenario(ratings: Rating[], extraEvents: AppEvent[] = []) {
  const embeddings = new Map<string, Float32Array>()
  const texts = new Map<string, string>()
  const channels = new Map<string, string>()
  const events: AppEvent[] = []

  ratings.forEach((entry, index) => {
    const key = `youtube:${entry.id}`
    embeddings.set(key, TOPIC[entry.topic])
    texts.set(key, `${entry.topic} internals deep dive`)
    channels.set(key, entry.channelId ?? `channel-${entry.topic}`)
    events.push({
      seq: index + 1,
      ts: entry.ts,
      type: 'rating',
      source: 'youtube',
      externalId: entry.id,
      rating: entry.rating,
    })
  })

  return { events: [...events, ...extraEvents], embeddings, texts, channels }
}

function build(input: ReturnType<typeof scenario>, overrides: { now?: string; upToTs?: string } = {}) {
  return buildPreferenceState({
    ...input,
    now: overrides.now ?? NOW,
    ...(overrides.upToTs ? { upToTs: overrides.upToTs } : {}),
    modelId: 'test',
    dimensions: DIMENSIONS,
  })
}

const byLabelId = (state: ReturnType<typeof build>, id: string) =>
  state.clusters.find((cluster) => cluster.id === id)

describe('clustering', () => {
  it('separates unrelated topics and groups related ones', () => {
    const state = build(
      scenario([
        { id: 'b1', topic: 'browser', rating: 5, ts: NOW },
        { id: 'b2', topic: 'browser', rating: 4, ts: NOW },
        { id: 'o1', topic: 'os', rating: 5, ts: NOW },
      ]),
    )

    expect(state.clusters).toHaveLength(2)
    const browser = byLabelId(state, 'c:youtube:b1')
    expect(browser?.memberIds).toEqual(['youtube:b1', 'youtube:b2'])
  })

  it('skips ratings whose item has no vector rather than guessing a position', () => {
    const input = scenario([{ id: 'b1', topic: 'browser', rating: 5, ts: NOW }])
    input.embeddings.delete('youtube:b1')

    const state = build(input)
    expect(state.clusters).toHaveLength(0)
    // The rating still counts for the channel and still marks the item as rated.
    expect(state.ratedKeys).toEqual(['youtube:b1'])
    expect(Object.values(state.channels)[0]?.ratedCount).toBe(1)
  })

  it('separates topics whose similarities all sit in a narrow high band', () => {
    // Reproduces what the real encoder produced: same-topic pairs near 0.86, different
    // topics near 0.77. A fixed threshold of 0.55 collapsed all of this into one interest.
    const dimensions = 24
    const encoderLike = (topic: number, index: number) => {
      const vector = new Float32Array(dimensions)
      vector[0] = 0.8775
      vector[1 + topic] = 0.3
      vector[8 + index] = 0.3742
      const length = Math.hypot(...vector)
      return vector.map((value) => value / length) as Float32Array
    }

    const embeddings = new Map<string, Float32Array>()
    const events: AppEvent[] = []
    for (let index = 0; index < 14; index++) {
      const id = `v${index}`
      embeddings.set(`youtube:${id}`, encoderLike(index < 7 ? 0 : 1, index))
      events.push({
        seq: index + 1,
        ts: NOW,
        type: 'rating',
        source: 'youtube',
        externalId: id,
        rating: 5,
      })
    }

    const built = buildPreferenceState({
      events,
      embeddings,
      now: NOW,
      modelId: 'test',
      dimensions,
    })

    expect(built.clusters).toHaveLength(2)
    // The threshold used has to sit inside the band, not at the configured 0.55.
    expect(built.effectiveTau).toBeGreaterThan(0.7)
    expect(built.effectiveTau).toBeLessThan(0.9)
  })

  it('is deterministic: the same log produces the same state', () => {
    const input = scenario([
      { id: 'b1', topic: 'browser', rating: 5, ts: NOW },
      { id: 'o1', topic: 'os', rating: 4, ts: NOW },
      { id: 'b2', topic: 'browser', rating: 0, ts: NOW },
    ])
    expect(JSON.stringify(build(input))).toBe(JSON.stringify(build(input)))
  })
})

describe('time decay', () => {
  it('lets a burst of interest fade out of the short-term mass', () => {
    const old = build(
      scenario([
        { id: 'b1', topic: 'browser', rating: 5, ts: addDays(NOW, -90) },
        { id: 'b2', topic: 'browser', rating: 5, ts: addDays(NOW, -88) },
      ]),
    )
    const fresh = build(
      scenario([
        { id: 'b1', topic: 'browser', rating: 5, ts: addDays(NOW, -2) },
        { id: 'b2', topic: 'browser', rating: 5, ts: NOW },
      ]),
    )

    const oldCluster = old.clusters[0]
    const freshCluster = fresh.clusters[0]

    // Long-term mass ignores time, so both look identical there.
    expect(oldCluster.massLong).toBeCloseTo(freshCluster.massLong, 6)
    // Short-term mass is what separates "used to care" from "cares now".
    expect(oldCluster.massShort).toBeLessThan(freshCluster.massShort * 0.05)
  })

  it('lets a lone interest go quiet as it ages instead of rescaling it back to full', () => {
    // Regression guard: normalising short-term mass against its own maximum would make a
    // single interest look permanently fresh, hiding decay entirely.
    const fresh = build(scenario([{ id: 'b1', topic: 'browser', rating: 5, ts: NOW }]))
    const stale = build(scenario([{ id: 'b1', topic: 'browser', rating: 5, ts: addDays(NOW, -180) }]))

    expect(fresh.clusters[0].activity).toBeGreaterThan(0.9)
    expect(stale.clusters[0].activity).toBeLessThan(0.65)
    expect(stale.clusters[0].normalisedShort).toBeLessThan(0.01)
  })

  it('keeps a dislike alive far longer than an enthusiasm', () => {
    const state = build(
      scenario([
        { id: 'c1', topic: 'cooking', rating: 0, ts: addDays(NOW, -60) },
        { id: 'c2', topic: 'cooking', rating: 5, ts: addDays(NOW, -60) },
      ]),
    )
    const cluster = state.clusters[0]
    // 60 days is one negative half-life but more than four short-term ones.
    expect(cluster.massNegative).toBeCloseTo(0.5, 2)
    expect(Math.abs(cluster.massShort)).toBeLessThan(0.06)
  })
})

describe('ratings', () => {
  it('gives a disliked topic negative long-term mass and no activity', () => {
    const state = build(
      scenario([
        { id: 'k1', topic: 'cooking', rating: 0, ts: NOW },
        { id: 'k2', topic: 'cooking', rating: 1, ts: NOW },
        { id: 'b1', topic: 'browser', rating: 5, ts: NOW },
      ]),
    )

    const cooking = byLabelId(state, 'c:youtube:k1')!
    expect(cooking.massLong).toBeLessThan(0)
    expect(cooking.massNegative).toBeGreaterThan(0)
    expect(cooking.activity).toBe(0)

    const browser = byLabelId(state, 'c:youtube:b1')!
    expect(browser.activity).toBeGreaterThan(0)
  })

  it('accumulates channel affinity with the sign of the ratings', () => {
    const state = build(
      scenario([
        { id: 'b1', topic: 'browser', rating: 5, ts: NOW, channelId: 'UC_a' },
        { id: 'b2', topic: 'browser', rating: 4, ts: NOW, channelId: 'UC_a' },
        { id: 'k1', topic: 'cooking', rating: 0, ts: NOW, channelId: 'UC_b' },
      ]),
    )

    expect(state.channels['UC_a']).toMatchObject({ ratedCount: 2 })
    expect(state.channels['UC_a'].weightSum).toBeCloseTo(1.5, 6)
    expect(state.channels['UC_b'].weightSum).toBeCloseTo(-1, 6)
  })
})

describe('user control over interests', () => {
  const base = () =>
    scenario([
      { id: 'b1', topic: 'browser', rating: 5, ts: NOW },
      { id: 'o1', topic: 'os', rating: 3, ts: NOW },
    ])

  const override = (seq: number, op: string, extra: Record<string, unknown> = {}): AppEvent =>
    ({
      seq,
      ts: NOW,
      type: 'interest_override',
      clusterId: 'c:youtube:b1',
      op,
      ...extra,
    }) as AppEvent

  it('silences a muted interest until the mute expires', () => {
    const input = base()
    input.events.push(override(10, 'mute', { untilTs: addDays(NOW, 30) }))

    const muted = build(input)
    expect(byLabelId(muted, 'c:youtube:b1')!.activity).toBe(0)

    const later = build(input, { now: addDays(NOW, 31) })
    expect(byLabelId(later, 'c:youtube:b1')!.activity).toBeGreaterThan(0)
  })

  it('holds a pinned interest above the floor regardless of decay', () => {
    const input = scenario([{ id: 'b1', topic: 'browser', rating: 5, ts: addDays(NOW, -300) }])
    input.events.push(override(10, 'pin'))

    const state = build(input)
    expect(byLabelId(state, 'c:youtube:b1')!.activity).toBeGreaterThanOrEqual(PIN_MIN_ACTIVITY)
  })

  it('unpins again when asked', () => {
    const input = scenario([{ id: 'b1', topic: 'browser', rating: 5, ts: addDays(NOW, -300) }])
    input.events.push(override(10, 'pin'), override(11, 'unpin'))
    expect(byLabelId(build(input), 'c:youtube:b1')!.activity).toBeLessThan(PIN_MIN_ACTIVITY)
  })

  it('forgets an interest without deleting the history behind it', () => {
    const input = base()
    input.events.push(override(10, 'forget'))

    const state = build(input)
    const cluster = byLabelId(state, 'c:youtube:b1')!
    expect(cluster.forgotten).toBe(true)
    expect(cluster.activity).toBe(0)
    // The ratings are still there; only the interest is suppressed.
    expect(cluster.memberIds).toContain('youtube:b1')
  })

  it('revives a forgotten interest when it is rated positively again', () => {
    const input = base()
    input.events.push(override(10, 'forget'))
    input.events.push({
      seq: 11,
      ts: NOW,
      type: 'rating',
      source: 'youtube',
      externalId: 'b9',
      rating: 5,
    })
    input.embeddings.set('youtube:b9', TOPIC.browser)

    const cluster = byLabelId(build(input), 'c:youtube:b1')!
    expect(cluster.forgotten).toBe(false)
    expect(cluster.activity).toBeGreaterThan(0)
  })

  it('applies an explicit strength and a rename', () => {
    const input = base()
    input.events.push(
      override(10, 'set_strength', { value: 1 }),
      override(11, 'rename', { label: 'Browser Engine' }),
    )

    const cluster = byLabelId(build(input), 'c:youtube:b1')!
    expect(cluster.label).toBe('Browser Engine')
    expect(cluster.labelSource).toBe('user')
    expect(cluster.explicitStrength).toBe(1)
  })

  it('names clusters after what makes them distinctive', () => {
    const state = build(
      scenario([
        { id: 'b1', topic: 'browser', rating: 5, ts: NOW },
        { id: 'o1', topic: 'os', rating: 5, ts: NOW },
      ]),
    )
    const labels = state.clusters.map((cluster) => cluster.label.toLowerCase())
    expect(labels.some((label) => label.includes('browser'))).toBe(true)
    expect(labels.some((label) => label.includes('cooking'))).toBe(false)
  })
})

describe('time travel', () => {
  it('rebuilds the state as it stood at a past instant', () => {
    const input = scenario([
      { id: 'b1', topic: 'browser', rating: 5, ts: '2026-03-01T00:00:00.000Z' },
      { id: 'k1', topic: 'cooking', rating: 5, ts: '2026-07-01T00:00:00.000Z' },
    ])

    const asOfApril = build(input, { now: '2026-04-01T00:00:00.000Z', upToTs: '2026-04-01T00:00:00.000Z' })
    expect(asOfApril.clusters).toHaveLength(1)
    expect(asOfApril.clusters[0].memberIds).toEqual(['youtube:b1'])

    expect(build(input).clusters).toHaveLength(2)
  })

  it('ignores an interest edit made after the instant being replayed', () => {
    const input = scenario([{ id: 'b1', topic: 'browser', rating: 5, ts: '2026-03-01T00:00:00.000Z' }])
    input.events.push({
      seq: 50,
      ts: '2026-07-01T00:00:00.000Z',
      type: 'interest_override',
      clusterId: 'c:youtube:b1',
      op: 'forget',
    } as AppEvent)

    const asOfApril = build(input, { now: '2026-04-01T00:00:00.000Z', upToTs: '2026-04-01T00:00:00.000Z' })
    expect(asOfApril.clusters[0].forgotten).toBe(false)
    expect(build(input).clusters[0].forgotten).toBe(true)
  })
})
