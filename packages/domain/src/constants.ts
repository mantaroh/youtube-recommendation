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
  // The system reports in JST throughout, so its default audience is in Japan. Both
  // are settings rather than constants, because that default is an assumption about
  // one installation and not a property of the design.
  region: 'JP',
  language: 'ja',
  discovery: 0.5,
  /** No more than 3 videos from one channel per 20 shown (design section 35). */
  maxPerChannel: 3,
  freshnessHalfLifeDays: 7,
  retrainAfterRatings: 20,
  retrainAfterDays: 7,
}

/**
 * How long before showing a video again counts as showing it again.
 *
 * The `seen_penalty` exists to stop the same video being offered day after day
 * (design section 33). Counting every render instead means that opening a video and
 * pressing back demotes everything that was on screen — the penalty fires on ordinary
 * navigation rather than on the passage of days, and the feed shuffles under the
 * reader for no reason they can see.
 *
 * Six hours: long enough that a session of browsing counts once, short enough that
 * tomorrow's feed still knows what yesterday's showed.
 */
export const IMPRESSION_WINDOW_MS = 6 * 3_600_000

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
 * One engine request carries at most this many items. Larger batches raise the cost of
 * a retry without shortening the run, because the work is linear in item count.
 *
 * A hundred rather than the original 250, once the linearity was measured rather than
 * assumed. Embedding one video's text costs about 53ms per character on a CPU, and the
 * text is around 1400 characters, so an item is roughly 74 seconds: 250 of them is over
 * five hours, longer than the lease that is meant to cover a run and longer than a night
 * a machine is left to work. At a hundred a batch takes a little over two hours, which
 * fits inside both — and an interrupted batch throws away two hours rather than five.
 */
export const SCORE_BATCH_SIZE = 100

/**
 * Wall-clock ceiling on one training run.
 *
 * Upstream trains for 5001 epochs when given no limit, which on Runpod bills for every
 * minute of it. But this ceiling is not only a cost control, and getting it wrong is
 * not only expensive: **a run cut short still reports success.** It returns a model, a
 * high training accuracy and a completed job, and that model can be a single constant
 * — twelve ratings at a 240 second budget reached epoch 10 and predicted one number
 * for everything, while the same twelve at 600 seconds reached epoch 44 and separated
 * cleanly.
 *
 * Fifteen minutes is comfortable on a GPU and adequate on a CPU for a few hundred
 * ratings. If training ever has to be capped tighter than this, treat the resulting
 * model as suspect until something has checked that it discriminates.
 */
export const TRAIN_TIME_BUDGET_SECONDS = 900

/**
 * Videos this long or shorter are not part of this system.
 *
 * It began as a weight — shorts demoted, not removed — and the ratings said that was
 * too gentle. Twenty-eight ratings below three minutes averaged 1.2 against 3.3 above,
 * and eighty-two per cent of everything discovered fell below the line. A penalty still
 * spends the quota to fetch them, the storage to keep them and the hours to score them,
 * for a pile of candidates that exists to be pushed down.
 *
 * So it is a rule now, and a rule about the whole system rather than one reader's
 * preference: nothing shorter is stored, offered or scored. Three minutes is YouTube's
 * own line for a Short, inclusive — a video of exactly 3:00 is one.
 *
 * A video already rated keeps its row, because the rating is the one thing here that
 * cannot be rebuilt. It is simply never a candidate again.
 */
export const SHORT_MAX_SECONDS = 180

/** A failed GPU job is resubmitted at most this many times (design section 48). */
export const MAX_JOB_ATTEMPTS = 3

/**
 * YouTube search quota (design section 42). `search.list` has its own allowance of 100
 * calls a day, and spending all of it leaves nothing for a manual search, so discovery
 * is capped well below the limit.
 */
export const SEARCH_QUOTA_PER_DAY = 100

/**
 * Searches one expansion pass makes, and what it takes from each.
 *
 * Searches, not channels: one term per query. Joining a channel's terms into a single
 * query matches none of them well — three such searches returned five videos between
 * them — so the terms are spent one at a time, round-robin across the liked channels.
 *
 * A channel search costs what a video search costs: a hundred quota units and one of
 * the day's hundred calls. Five a run is a third of a profile's allowance and leaves
 * the rest to the video lanes. A term not spent today is still there tomorrow; this is
 * a standing habit, not a sweep.
 *
 * Ten channels back from each search, five uploads from each of those: enough to learn
 * that a channel exists and to put it in front of the reader to judge, not to ingest
 * its catalogue.
 */
export const CHANNEL_EXPANSION_PER_RUN = 5
export const CHANNELS_PER_EXPANSION = 10
export const UPLOADS_PER_FOUND_CHANNEL = 5
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

/**
 * How long a claimed job stays the claimant's to finish.
 *
 * Longer than a training run is expected to take, so a slow machine is not treated as a
 * dead one. Thirty minutes was a guess; the first real run on a CPU spent forty-four
 * minutes loading the embedding weights and had not started training, so the guess was
 * short enough to have expired mid-run and thrown the work away.
 *
 * Three hours is deliberately generous. The cost of a lease that is too long is waiting
 * before a genuinely dead claim is retried; the cost of one that is too short is losing
 * a run that was going to succeed. On a queue this size the first is barely a cost.
 */
export const JOB_LEASE_MINUTES = 180

/**
 * Videos one metadata-repair pass re-reads.
 *
 * `videos.list` takes fifty ids for one unit, so two hundred is four units against a
 * daily ten thousand — small enough to run unattended. The cap exists at all because a
 * repair with no bound is a repair that turns one cron tick into two thousand calls once
 * the catalog is large.
 */
export const THUMBNAIL_BACKFILL_PER_RUN = 200
