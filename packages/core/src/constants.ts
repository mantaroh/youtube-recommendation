import type { RatingValue, ScoreWeights } from '@ypr/shared'

/**
 * Tunable constants of the preference model.
 *
 * Everything here is a knob for experiments, which is why the values live in one file
 * rather than being scattered through the algorithms (design section 3.3).
 */

/**
 * Rating -> signed weight (design section 3.3).
 *
 * Anchored at 3 = "neutral". The negative side is asymmetric because the gap between
 * ☆1 and ☆0 ("no more of this") carries more meaning than the gap between ★4 and ★5.
 */
export const RATING_WEIGHTS: Record<RatingValue, number> = {
  0: -1.0,
  1: -0.6,
  2: -0.25,
  3: 0.0,
  4: 0.5,
  5: 1.0,
}

/** Half-life of short-term interest, in days (design section 3.4). */
export const H_SHORT_DAYS = 14

/** Half-life of negative interest, in days. Longer than the positive side on purpose. */
export const H_NEG_DAYS = 60

/** Half-life used by the freshness term, in days (design section 4.1). */
export const FRESHNESS_HALF_LIFE_DAYS = 30

/** Cosine threshold for assigning a rating to an existing cluster (design section 3.2). */
export const TAU = 0.55

/** Maximum number of clusters before the smallest one is merged away. */
export const K_MAX = 40

/** Bayesian smoothing constant for channel affinity (design section 4.1). */
export const KAPPA = 3

/** Trade-off between score and diversity in MMR (design section 4.4). */
export const MMR_LAMBDA = 0.7

/** MMR is applied to at most this many candidates (design section 4.4). */
export const MMR_POOL_SIZE = 300

/** Lower bound applied to `a_c` while a cluster is pinned (design section 3.5). */
export const PIN_MIN_ACTIVITY = 0.8

/**
 * Weights of the three components of cluster activity `a_c` (design section 3.5).
 * They sum to 1 so that `a_c` stays in [0, 1] before clamping.
 */
export const ACTIVITY_WEIGHTS = {
  long: 0.5,
  short: 0.35,
  explicit: 0.15,
} as const

/**
 * Default weights of the scoring function (design section 4.1, open issue 3).
 *
 * The negative term is heavier than the positive ones so that an explicit "no more of
 * this" outweighs a merely similar positive match. `watch` ships at 0: the implicit
 * signal is recorded from V1 but does not influence ranking until it is validated.
 */
export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  channel: 1.0,
  long: 1.0,
  short: 0.8,
  negative: 1.2,
  explore: 0.35,
  freshness: 0.25,
  watch: 0.0,
}

/** Constant bonus added to channel affinity for channels the user subscribes to. */
export const SUBSCRIBED_CHANNEL_BONUS = 0.5

/** Penalty applied to items the user already rated or already saw in the feed. */
export const PENALTY = {
  rated: 1.5,
  seen: 0.4,
} as const

/** Share of the related / explore lanes given to each popularity stratum (design section 4.3). */
export const POPULARITY_MIX = {
  established: 0.7,
  emerging: 0.2,
  wildcard: 0.1,
} as const

/**
 * View-count boundaries separating the popularity strata. These are stratum boundaries,
 * not a quality filter: nothing is excluded for being below them (design section 4.3).
 */
export const POPULARITY_BOUNDS = {
  /** At or above this many views an item counts as established. */
  established: 5000,
} as const

/** Default number of items in one feed build. */
export const DEFAULT_FEED_SIZE = 40

export const MILLISECONDS_PER_DAY = 86_400_000

/**
 * Standard deviations above typical pairwise similarity at which two rated items count
 * as belonging to the same interest (see calibration.ts). Expressed relative to the
 * observed distribution, so it holds wherever that distribution happens to sit.
 */
export const TAU_Z_SCORE = 1
