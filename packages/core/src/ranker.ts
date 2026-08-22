import type {
  CatalogItem,
  InterestCluster,
  Lane,
  PopularityTier,
  PreferenceState,
  RankedItem,
  ScoreBreakdown,
  ScoreWeights,
} from '@ypr/shared'
import { itemKey } from '@ypr/shared'
import {
  DEFAULT_SCORE_WEIGHTS,
  FRESHNESS_HALF_LIFE_DAYS,
  KAPPA,
  MMR_LAMBDA,
  MMR_POOL_SIZE,
  PENALTY,
  POPULARITY_BOUNDS,
  POPULARITY_MIX,
  POPULARITY_PERCENTILE,
  SUBSCRIBED_CHANNEL_BONUS,
} from './constants.js'
import { decayAt } from './decay.js'
import {
  calibrate,
  calibrateSigned,
  quantile,
  similarityStats,
  type SimilarityStats,
} from './calibration.js'
import { cosine } from './vector.js'

/**
 * Ranking (design section 4).
 *
 * The score is a formula rather than a model call. That is a deliberate constraint: it
 * costs nothing to run, it produces the same answer twice, and — most importantly — it can
 * always be spelled out to the user, which a recommender they are supposed to own has to
 * be able to do (design section 4.6).
 */

export interface Candidate {
  item: CatalogItem
  /** Missing vectors are still rankable; they simply score 0 on every similarity term. */
  embedding?: Float32Array | undefined
}

export interface RankingContext {
  state: PreferenceState
  now: string
  weights?: ScoreWeights
  subscribedChannelIds?: ReadonlySet<string>
  /**
   * Similarity distribution per cluster across the whole candidate pool. Supplied by
   * `assembleFeed`; without it, scoring falls back to raw cosine, which is only
   * meaningful when comparing two candidates scored the same way.
   */
  similarityStats?: ReadonlyMap<string, SimilarityStats>
  /**
   * Membership sets built once per feed rather than per candidate. Scoring thousands of
   * candidates against thousands of ratings with a linear scan each time is quadratic;
   * `assembleFeed` fills these in, and `scoreCandidate` builds them on demand when it is
   * called on its own.
   */
  ratedKeySet?: ReadonlySet<string>
  seenKeySet?: ReadonlySet<string>
}

/** Attaches the membership sets a full feed build needs. */
export function withKeySets(context: RankingContext): RankingContext {
  if (context.ratedKeySet && context.seenKeySet) return context
  return {
    ...context,
    ratedKeySet: context.ratedKeySet ?? new Set(context.state.ratedKeys),
    seenKeySet: context.seenKeySet ?? new Set(context.state.seenKeys),
  }
}

export interface PopularityBounds {
  /** View count at or above which an item counts as established. */
  establishedFloor: number
}

/**
 * Where the popularity strata sit for this particular pool.
 *
 * Taken from the candidates rather than fixed, so "less watched than usual" means
 * something whatever the catalog contains. An absolute boundary of 5,000 views put 98% of
 * the deployed catalog into one stratum, which left the slots reserved for smaller videos
 * unfillable — the strata cannot correct a popularity bias they cannot see
 * (design addendum 2).
 */
export function computePopularityBounds(candidates: readonly Candidate[]): PopularityBounds {
  const views = candidates.map((candidate) => candidate.item.viewCount)
  return { establishedFloor: quantile(views, POPULARITY_PERCENTILE) }
}

/**
 * View count decides established; age decides which of the other two.
 *
 * Age stays absolute because it means the same thing everywhere — a two year old video is
 * old regardless of what else is in the pool — while a view count does not.
 */
export function popularityTier(
  item: CatalogItem,
  now: string,
  bounds?: PopularityBounds,
): PopularityTier {
  const floor = bounds?.establishedFloor ?? POPULARITY_BOUNDS.established
  if (item.viewCount >= floor) return 'established'
  const ageDays = (Date.parse(now) - Date.parse(item.publishedAt)) / 86_400_000
  return ageDays <= 90 ? 'emerging' : 'wildcard'
}

/** Channel affinity, smoothed so a single rating cannot make a channel look perfect. */
export function channelAffinity(
  item: CatalogItem,
  context: RankingContext,
): number {
  const affinity = context.state.channels[item.channelId]
  const smoothed = affinity ? affinity.weightSum / (affinity.ratedCount + KAPPA) : 0
  const bonus = context.subscribedChannelIds?.has(item.channelId) ? SUBSCRIBED_CHANNEL_BONUS : 0
  return smoothed + bonus
}

export function scoreCandidate(candidate: Candidate, context: RankingContext): ScoreBreakdown {
  const weights = context.weights ?? DEFAULT_SCORE_WEIGHTS
  const { item, embedding } = candidate
  const key = itemKey(item)

  let long = 0
  let short = 0
  let negative = 0
  let bestSimilarity = 0
  let topCluster: InterestCluster | undefined

  let bestRelative = 0
  /** Undefined until some interest has been compared against; see `explore` below. */
  let bestSignedRelative: number | undefined

  if (embedding) {
    for (const cluster of context.state.clusters) {
      // A forgotten interest neither attracts nor suppresses: the user asked for it to
      // stop influencing anything.
      if (cluster.forgotten) continue

      // Negative similarity means "points the other way", which is not evidence about
      // this topic at all, so it is floored rather than allowed to subtract.
      //
      // A similarity of zero is not skipped: it contributes nothing to the positive terms
      // anyway, but it is the strongest possible evidence of novelty, and skipping it left
      // a video orthogonal to every interest scoring zero on exploration.
      const similarity = Math.max(0, cosine(embedding, cluster.centroid))

      /**
       * The raw cosine is turned into a position within the candidate pool before it
       * reaches the score. A sentence encoder puts every pair in a narrow high band, so
       * the raw value says almost nothing on its own; what carries information is being
       * closer to this interest than the other candidates are (design addendum 1).
       */
      const stats = context.similarityStats?.get(cluster.id)
      const relative = stats ? calibrate(similarity, stats) : similarity
      const signedRelative = stats ? calibrateSigned(similarity, stats) : similarity

      const longTerm = cluster.activity * cluster.normalisedLong * relative
      if (longTerm > long) {
        long = longTerm
        topCluster = cluster
        bestRelative = relative
      }
      short = Math.max(short, cluster.activity * cluster.normalisedShort * relative)
      // Suppression survives a mute: muting hides an interest, it does not undo a dislike.
      negative = Math.max(negative, cluster.normalisedNegative * relative)
      if (similarity > bestSimilarity) bestSimilarity = similarity
      bestSignedRelative = Math.max(bestSignedRelative ?? 0, signedRelative)
    }
  }

  const channel = channelAffinity(item, context)
  // Nothing to be far from — no vector, or no interests yet — is not novelty.
  const explore = bestSignedRelative === undefined ? 0 : 1 - bestSignedRelative
  const freshness = decayAt(item.publishedAt, context.now, FRESHNESS_HALF_LIFE_DAYS)

  const rated = context.ratedKeySet ?? new Set(context.state.ratedKeys)
  const seen = context.seenKeySet ?? new Set(context.state.seenKeys)
  let penalty = 0
  if (rated.has(key)) penalty += PENALTY.rated
  if (seen.has(key)) penalty += PENALTY.seen

  const total =
    weights.channel * channel +
    weights.long * long +
    weights.short * short -
    weights.negative * negative +
    weights.explore * explore +
    weights.freshness * freshness -
    penalty

  return {
    channel,
    long,
    short,
    negative,
    explore,
    freshness,
    penalty,
    total,
    topClusterId: topCluster?.id ?? null,
    topClusterLabel: topCluster?.label ?? null,
    topClusterSimilarity: bestSimilarity,
    topClusterRelative: bestRelative,
  }
}

/**
 * Lane shares from the stable/discovery slider (design section 4.2).
 *
 * The point of the slider is that the trade-off between depth and discovery is the user's
 * call, made per session, rather than something the system decides on their behalf.
 */
export function laneShares(discovery: number): Record<Lane, number> {
  const clamped = Math.min(1, Math.max(0, discovery))
  return {
    subscription: 0.6 - 0.3 * clamped,
    related: 0.3,
    explore: 0.1 + 0.3 * clamped,
  }
}

export function laneQuotas(discovery: number, feedSize: number): Record<Lane, number> {
  const shares = laneShares(discovery)
  const quotas: Record<Lane, number> = {
    subscription: Math.round(feedSize * shares.subscription),
    related: Math.round(feedSize * shares.related),
    explore: Math.round(feedSize * shares.explore),
  }
  // Rounding can drift by an item or two; the surplus or shortfall goes to related, the
  // lane in the middle.
  const drift = feedSize - (quotas.subscription + quotas.related + quotas.explore)
  quotas.related = Math.max(0, quotas.related + drift)
  return quotas
}

interface ScoredCandidate {
  candidate: Candidate
  breakdown: ScoreBreakdown
  tier: PopularityTier
}

/**
 * Fills a lane, keeping the popularity strata in proportion (design section 4.3).
 *
 * A fixed "at least N views" rule would manufacture the popularity bias this project
 * exists to avoid: popular, therefore shown, therefore more popular. Reserving slots
 * instead means small and evergreen videos have somewhere to land without their view
 * count entering the score at all.
 */
function takeStratified(scored: ScoredCandidate[], quota: number): ScoredCandidate[] {
  if (quota <= 0) return []
  const byTier: Record<PopularityTier, ScoredCandidate[]> = {
    established: [],
    emerging: [],
    wildcard: [],
  }
  for (const entry of scored) byTier[entry.tier].push(entry)
  for (const tier of Object.keys(byTier) as PopularityTier[]) {
    byTier[tier].sort((a, b) => b.breakdown.total - a.breakdown.total)
  }

  // Largest remainder rather than independent rounding. Rounding each share on its own
  // drops the minority strata entirely at small quotas (20% of 2 rounds to zero), and the
  // slots then get back-filled by score — which hands them straight back to the popular
  // stratum, reintroducing exactly the bias the strata exist to prevent.
  const shares = (['established', 'emerging', 'wildcard'] as const).map((tier) => {
    const exact = quota * POPULARITY_MIX[tier]
    const floor = Math.floor(exact)
    return { tier, floor, remainder: exact - floor }
  })
  let allocated = shares.reduce((total, share) => total + share.floor, 0)
  for (const share of [...shares].sort((a, b) => b.remainder - a.remainder)) {
    if (allocated >= quota) break
    share.floor += 1
    allocated += 1
  }

  const selected: ScoredCandidate[] = []
  for (const share of shares) {
    selected.push(...byTier[share.tier].splice(0, share.floor))
  }

  // A stratum that could not fill its share hands the slots back to whatever is left,
  // so a thin catalog produces a short lane rather than an empty one.
  if (selected.length < quota) {
    const leftovers = [...byTier.established, ...byTier.emerging, ...byTier.wildcard].sort(
      (a, b) => b.breakdown.total - a.breakdown.total,
    )
    selected.push(...leftovers.slice(0, quota - selected.length))
  }
  return selected.slice(0, quota)
}

export interface AssembleInput extends RankingContext {
  candidates: Partial<Record<Lane, Candidate[]>>
  discovery: number
  feedSize: number
  mmrLambda?: number
}

/**
 * Builds the feed: score, fill each lane, then re-rank the result for diversity.
 */
/**
 * Similarity distribution of each interest across every candidate.
 *
 * Computed over the whole pool rather than per lane, so that a candidate's position means
 * the same thing whichever lane it arrived in.
 */
export function computeSimilarityStats(
  candidates: readonly Candidate[],
  clusters: readonly InterestCluster[],
): Map<string, SimilarityStats> {
  const stats = new Map<string, SimilarityStats>()
  const embeddings = candidates
    .map((candidate) => candidate.embedding)
    .filter((embedding): embedding is Float32Array => Boolean(embedding))

  for (const cluster of clusters) {
    if (cluster.forgotten) continue
    const values = embeddings.map((embedding) => Math.max(0, cosine(embedding, cluster.centroid)))
    stats.set(cluster.id, similarityStats(values))
  }
  return stats
}

export function assembleFeed(input: AssembleInput): RankedItem[] {
  const pool = [
    ...(input.candidates.subscription ?? []),
    ...(input.candidates.related ?? []),
    ...(input.candidates.explore ?? []),
  ]
  const context = {
    ...withKeySets(input),
    similarityStats: input.similarityStats ?? computeSimilarityStats(pool, input.state.clusters),
  } as AssembleInput
  const popularityBounds = computePopularityBounds(pool)
  const quotas = laneQuotas(input.discovery, input.feedSize)
  const chosen: Array<{ entry: ScoredCandidate; lane: Lane }> = []
  const taken = new Set<string>()

  // Subscription first: a video from a channel the user follows should be presented as
  // such, even if it would also qualify as a related or explore candidate.
  for (const lane of ['subscription', 'related', 'explore'] as const) {
    const laneCandidates = (context.candidates[lane] ?? []).filter(
      (candidate) => !taken.has(itemKey(candidate.item)),
    )
    const scored: ScoredCandidate[] = laneCandidates.map((candidate) => ({
      candidate,
      breakdown: scoreCandidate(candidate, context),
      tier: popularityTier(candidate.item, context.now, popularityBounds),
    }))

    const selected =
      lane === 'subscription'
        ? scored.sort((a, b) => b.breakdown.total - a.breakdown.total).slice(0, quotas[lane])
        : takeStratified(scored, quotas[lane])

    for (const entry of selected) {
      taken.add(itemKey(entry.candidate.item))
      chosen.push({ entry, lane })
    }
  }

  const reranked = mmrRerank(chosen, context.feedSize, context.mmrLambda ?? MMR_LAMBDA)

  return reranked.map(({ entry, lane }) => ({
    item: entry.candidate.item,
    lane,
    tier: entry.tier,
    score: entry.breakdown.total,
    breakdown: entry.breakdown,
  }))
}

/**
 * Maximal marginal relevance (design section 4.4).
 *
 * Scores are min-max normalised across the pool first. Without that, lambda would be
 * balancing a raw score against a cosine on a different scale, and the same lambda would
 * mean something different for every user.
 */
export function mmrRerank<T extends { entry: ScoredCandidate; lane: Lane }>(
  items: T[],
  limit: number,
  lambda = MMR_LAMBDA,
): T[] {
  const pool = [...items]
    .sort((a, b) => b.entry.breakdown.total - a.entry.breakdown.total)
    .slice(0, MMR_POOL_SIZE)
  if (pool.length <= 1) return pool.slice(0, limit)

  const totals = pool.map((item) => item.entry.breakdown.total)
  const lowest = Math.min(...totals)
  const highest = Math.max(...totals)
  const span = highest - lowest
  const normalised = new Map<T, number>()
  pool.forEach((item, index) => {
    normalised.set(item, span === 0 ? 1 : (totals[index] - lowest) / span)
  })

  const selected: T[] = []
  const remaining = new Set(pool)

  while (selected.length < Math.min(limit, pool.length) && remaining.size > 0) {
    let best: T | undefined
    let bestValue = -Infinity

    for (const item of remaining) {
      const embedding = item.entry.candidate.embedding
      let maxSimilarity = 0
      if (embedding) {
        for (const chosen of selected) {
          const other = chosen.entry.candidate.embedding
          if (!other) continue
          maxSimilarity = Math.max(maxSimilarity, cosine(embedding, other))
        }
      }
      const value = lambda * (normalised.get(item) ?? 0) - (1 - lambda) * maxSimilarity
      if (value > bestValue) {
        bestValue = value
        best = item
      }
    }

    if (!best) break
    remaining.delete(best)
    selected.push(best)
  }

  return selected
}
