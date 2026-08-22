import { describe, expect, it } from 'vitest'
import {
  compareArms,
  computeArmMetrics,
  metricsToCsv,
  pearson,
  shannonEntropy,
  type ArmSample,
} from '../src/metrics.js'

const sample = (overrides: Partial<ArmSample> = {}): ArmSample => ({
  arm: 'own',
  ratings: [],
  categories: [],
  channelIds: [],
  subscribedChannelIds: new Set<string>(),
  shown: 0,
  ...overrides,
})

describe('entropy', () => {
  it('is zero when everything shares one category', () => {
    expect(shannonEntropy(['28', '28', '28'])).toBe(0)
  })

  it('is one bit for an even split between two categories', () => {
    expect(shannonEntropy(['28', '27'])).toBeCloseTo(1, 6)
  })

  it('rises as the spread widens', () => {
    const narrow = shannonEntropy(['28', '28', '28', '27'])
    const wide = shannonEntropy(['28', '27', '26', '24'])
    expect(wide).toBeGreaterThan(narrow)
  })

  it('answers zero for an empty list rather than failing', () => {
    expect(shannonEntropy([])).toBe(0)
  })
})

describe('arm metrics', () => {
  it('reports nothing rather than zero when nothing has been rated', () => {
    const metrics = computeArmMetrics(sample({ shown: 10, categories: ['28'], channelIds: ['UC_a'] }))
    expect(metrics.meanRating).toBeNull()
    expect(metrics.rejectionRate).toBeNull()
  })

  it('measures satisfaction and rejection separately', () => {
    const metrics = computeArmMetrics(
      sample({ ratings: [5, 4, 0, 3], shown: 4 }),
    )
    expect(metrics.meanRating).toBeCloseTo(3, 6)
    expect(metrics.rejectionRate).toBeCloseTo(0.25, 6)
  })

  it('counts a channel the user does not follow as novelty', () => {
    const metrics = computeArmMetrics(
      sample({
        channelIds: ['UC_known', 'UC_new', 'UC_new2', 'UC_known'],
        subscribedChannelIds: new Set(['UC_known']),
        shown: 4,
      }),
    )
    expect(metrics.newChannelShare).toBeCloseTo(0.5, 6)
  })

  it('flags a list dominated by one channel', () => {
    const concentrated = computeArmMetrics(
      sample({ channelIds: ['UC_a', 'UC_a', 'UC_a', 'UC_b'], shown: 4 }),
    )
    const spread = computeArmMetrics(
      sample({ channelIds: ['UC_a', 'UC_b', 'UC_c', 'UC_d'], shown: 4 }),
    )
    expect(concentrated.channelConcentration).toBeCloseTo(0.75, 6)
    expect(spread.channelConcentration).toBeCloseTo(0.25, 6)
  })

  it('separates a satisfying feed from a varied one', () => {
    // A narrow feed can score well on satisfaction alone, which is exactly why the
    // comparison reports more than one number.
    const narrow = computeArmMetrics(
      sample({ arm: 'narrow', ratings: [5, 5, 5], categories: ['28', '28', '28'], shown: 3 }),
    )
    const varied = computeArmMetrics(
      sample({ arm: 'varied', ratings: [4, 3, 5], categories: ['28', '27', '26'], shown: 3 }),
    )

    expect(narrow.meanRating!).toBeGreaterThan(varied.meanRating!)
    expect(varied.categoryEntropy).toBeGreaterThan(narrow.categoryEntropy)
  })
})

describe('comparison', () => {
  it('reports a delta only where both arms have a value', () => {
    const own = computeArmMetrics(sample({ arm: 'own', ratings: [5, 4], categories: ['28'], shown: 2 }))
    const baseline = computeArmMetrics(sample({ arm: 'youtube', categories: ['28'], shown: 2 }))

    const rows = compareArms(own, baseline)
    expect(rows.find((row) => row.metric === 'Mean rating')?.delta).toBeNull()
    expect(rows.find((row) => row.metric === 'Category entropy')?.delta).toBe(0)
  })
})

describe('correlation', () => {
  it('finds a perfect positive relationship', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 6)
  })

  it('finds a perfect negative relationship', () => {
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 6)
  })

  it('declines to answer when a series does not vary or is too short', () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull()
    expect(pearson([1], [1])).toBeNull()
  })
})

describe('export', () => {
  it('writes a header and one row per arm', () => {
    const csv = metricsToCsv([
      computeArmMetrics(sample({ arm: 'own', ratings: [5], categories: ['28'], shown: 1 })),
      computeArmMetrics(sample({ arm: 'youtube', ratings: [3], categories: ['27'], shown: 1 })),
    ])

    const lines = csv.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('mean_rating')
    expect(lines[1].startsWith('own,')).toBe(true)
    expect(lines[2].startsWith('youtube,')).toBe(true)
  })

  it('leaves an unmeasured value empty rather than writing a misleading zero', () => {
    const csv = metricsToCsv([computeArmMetrics(sample({ arm: 'own', shown: 5 }))])
    expect(csv.split('\n')[1]).toContain('own,5,0,,')
  })
})
