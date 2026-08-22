import type { RatingValue } from '@ypr/shared'

/**
 * Evaluation metrics (design section 9).
 *
 * These compare this recommender against the platform's own. Deliberately more than one
 * number: a feed can raise average satisfaction simply by narrowing, so satisfaction is
 * only meaningful next to diversity and novelty.
 */

export interface ArmSample {
  /** Which recommender produced the list. */
  arm: string
  /** Ratings given to the items shown, for those that were rated. */
  ratings: RatingValue[]
  /** Official category of every item shown, in order. */
  categories: string[]
  /** Channel of every item shown, in order. */
  channelIds: string[]
  /** Channels the user already follows, used to measure novelty. */
  subscribedChannelIds: ReadonlySet<string>
  /** How many items were shown, including unrated ones. */
  shown: number
}

export interface ArmMetrics {
  arm: string
  shown: number
  rated: number
  /** Mean rating, or null when nothing has been rated yet. */
  meanRating: number | null
  /** Share of shown-and-rated items marked "no more of this". */
  rejectionRate: number | null
  /** Shannon entropy over official categories, in bits. Higher means more varied. */
  categoryEntropy: number
  /** Share of items from channels the user does not follow. */
  newChannelShare: number
  /** Share of items whose channel appears only once in the list. */
  channelConcentration: number
}

export function computeArmMetrics(sample: ArmSample): ArmMetrics {
  const rated = sample.ratings.length
  const meanRating =
    rated === 0 ? null : sample.ratings.reduce<number>((total, rating) => total + rating, 0) / rated
  const rejections = sample.ratings.filter((rating) => rating === 0).length

  const unfollowed = sample.channelIds.filter(
    (channelId) => !sample.subscribedChannelIds.has(channelId),
  ).length

  const channelCounts = new Map<string, number>()
  for (const channelId of sample.channelIds) {
    channelCounts.set(channelId, (channelCounts.get(channelId) ?? 0) + 1)
  }
  const largestChannelShare =
    sample.channelIds.length === 0
      ? 0
      : Math.max(...channelCounts.values()) / sample.channelIds.length

  return {
    arm: sample.arm,
    shown: sample.shown,
    rated,
    meanRating,
    rejectionRate: rated === 0 ? null : rejections / rated,
    categoryEntropy: shannonEntropy(sample.categories),
    newChannelShare: sample.channelIds.length === 0 ? 0 : unfollowed / sample.channelIds.length,
    channelConcentration: largestChannelShare,
  }
}

/**
 * Shannon entropy in bits over a list of labels.
 *
 * Zero means every item shared one category; higher means the list spread out. Empty and
 * single-item lists are 0, which is the honest answer rather than undefined.
 */
export function shannonEntropy(labels: string[]): number {
  if (labels.length === 0) return 0
  const counts = new Map<string, number>()
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1)

  let entropy = 0
  for (const count of counts.values()) {
    const probability = count / labels.length
    entropy -= probability * Math.log2(probability)
  }
  return entropy
}

/**
 * Pearson correlation, or null when either series does not vary.
 *
 * Used to check whether interest activity actually tracks satisfaction over time — the
 * claim that decay models boredom is testable, and this is the test (design section 9).
 */
export function pearson(xs: number[], ys: number[]): number | null {
  const length = Math.min(xs.length, ys.length)
  if (length < 2) return null

  const meanX = xs.slice(0, length).reduce((total, value) => total + value, 0) / length
  const meanY = ys.slice(0, length).reduce((total, value) => total + value, 0) / length

  let covariance = 0
  let varianceX = 0
  let varianceY = 0
  for (let i = 0; i < length; i++) {
    const dx = xs[i] - meanX
    const dy = ys[i] - meanY
    covariance += dx * dy
    varianceX += dx * dx
    varianceY += dy * dy
  }

  if (varianceX === 0 || varianceY === 0) return null
  return covariance / Math.sqrt(varianceX * varianceY)
}

export interface ComparisonRow {
  metric: string
  own: number | null
  baseline: number | null
  /** Positive when the local recommender is ahead on this metric. */
  delta: number | null
}

/** Lays two arms side by side for reporting. */
export function compareArms(own: ArmMetrics, baseline: ArmMetrics): ComparisonRow[] {
  const rows: Array<[string, number | null, number | null]> = [
    ['Mean rating', own.meanRating, baseline.meanRating],
    ['Rejection rate', own.rejectionRate, baseline.rejectionRate],
    ['Category entropy', own.categoryEntropy, baseline.categoryEntropy],
    ['New channel share', own.newChannelShare, baseline.newChannelShare],
    ['Largest channel share', own.channelConcentration, baseline.channelConcentration],
  ]

  return rows.map(([metric, ownValue, baselineValue]) => ({
    metric,
    own: ownValue,
    baseline: baselineValue,
    delta: ownValue === null || baselineValue === null ? null : ownValue - baselineValue,
  }))
}

/** Comma-separated export, for taking the results somewhere else to analyse. */
export function metricsToCsv(rows: ArmMetrics[]): string {
  const header = [
    'arm',
    'shown',
    'rated',
    'mean_rating',
    'rejection_rate',
    'category_entropy',
    'new_channel_share',
    'largest_channel_share',
  ].join(',')

  const body = rows.map((row) =>
    [
      row.arm,
      row.shown,
      row.rated,
      row.meanRating ?? '',
      row.rejectionRate ?? '',
      row.categoryEntropy.toFixed(4),
      row.newChannelShare.toFixed(4),
      row.channelConcentration.toFixed(4),
    ].join(','),
  )

  return [header, ...body].join('\n')
}
