import type { AppSettings, LaneMix, RankingWeights } from './types.js'

/**
 * Ranking weights (design section 33).
 *
 * `preference` is 0.65 as the design writes it. The rest are the amounts the bonuses
 * are worth *relative to a full-marks prediction*: with the prediction on a 0..10
 * scale, 0.65 * 10 = 6.5 is the ceiling the preference term can reach, so a
 * subscription bonus of 1.2 is worth roughly two rating points of prediction. Writing
 * them at this scale keeps the trade-off legible instead of hiding it in a
 * normalisation step.
 */
export const DEFAULT_WEIGHTS: RankingWeights = {
  preference: 0.65,
  subscriptionBonus: 1.2,
  freshnessBonus: 0.8,
  explicitInterestBonus: 1.5,
  explorationBonus: 0.6,
  seenPenalty: 2.0,
  mutedInterestPenalty: 6.0,
}

/** Initial lane mix (design section 17): 50 / 30 / 20. */
export const DEFAULT_LANE_MIX: LaneMix = {
  subscription: 0.5,
  related: 0.3,
  explore: 0.2,
}

export const DEFAULT_SETTINGS: AppSettings = {
  weights: DEFAULT_WEIGHTS,
  laneMix: DEFAULT_LANE_MIX,
  /** 50 items, matching the worked example in design section 34. */
  feedSize: 50,
  discovery: 0.5,
  /** No more than 3 videos from one channel per 20 shown (design section 35). */
  maxPerChannel: 3,
  freshnessHalfLifeDays: 7,
  retrainAfterRatings: 20,
  retrainAfterDays: 7,
}

/** Design section 35 states the diversity rule per 20 items, not per feed. */
export const DIVERSITY_WINDOW = 20

/**
 * Rescoring scope after a training run (design section 32): unwatched candidates from
 * the last 30 days, between 500 and 2000 of them.
 */
export const RESCORE_WINDOW_DAYS = 30
export const RESCORE_MIN_ITEMS = 500
export const RESCORE_MAX_ITEMS = 2000

/**
 * One Runpod request carries at most this many items. Larger batches raise the cost of
 * a retry without shortening the run, because the GPU work is linear in item count.
 */
export const SCORE_BATCH_SIZE = 250

/** A failed GPU job is resubmitted at most this many times (design section 48). */
export const MAX_JOB_ATTEMPTS = 3

/**
 * YouTube search quota (design section 42). `search.list` has its own allowance of 100
 * calls a day, and spending all of it leaves nothing for a manual search, so discovery
 * is capped well below the limit.
 */
export const SEARCH_QUOTA_PER_DAY = 100
export const DISCOVERY_SEARCH_BUDGET = 30
export const DISCOVERY_QUERIES_PER_INTEREST = 3
export const DISCOVERY_INTEREST_CLUSTERS = 10

/** Interest control weights the UI offers (design section 38). */
export const INTEREST_WEIGHT_STEPS = {
  boost: 1.3,
  reduce: 0.5,
  neutral: 1.0,
  mute: 0,
} as const

/** "30 day mute" from the preferences screen. */
export const MUTE_DAYS = 30
