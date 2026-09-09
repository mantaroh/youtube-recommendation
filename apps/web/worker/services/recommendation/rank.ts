import type {
  AppSettings,
  Channel,
  EpochMillis,
  InterestControl,
  Lane,
  RecommendationReason,
  ScoreBreakdown,
  Video,
} from '@ypr/domain'
import { effectiveWeight } from '../../db/interests.js'

/**
 * The scoring function (design section 33).
 *
 * ```text
 * final_score = 0.65 * preference_score
 *             + subscription_bonus
 *             + freshness_bonus
 *             + explicit_interest_bonus
 *             + exploration_bonus
 *             - seen_penalty
 *             - muted_interest_penalty
 * ```
 *
 * A formula, not a model call. It costs nothing to run, gives the same answer twice,
 * and every term can be named to the user — which a recommender they are supposed to
 * own has to be able to do. The GPU contributes exactly one number to it,
 * `preference_score`, computed in advance (design section 33).
 */

export interface ScoringContext {
  settings: AppSettings
  now: EpochMillis
  interests: InterestControl[]
  /** Predicted ratings from the active model, keyed by video id. */
  scores: Map<string, number>
  /** How many times each video has already appeared in a feed. */
  seen: Map<string, number>
  /** Channel ids the user has rated at least one video from. */
  ratedChannelIds: ReadonlySet<string>
  /**
   * The prediction to assume for a video the model has not scored.
   *
   * Not a constant. A raw 5.0 would sit above or below the whole pool depending on how
   * generous the user's ratings happen to be, so an unscored video would either
   * dominate the feed or never appear. Taking the pool's own mean makes "unknown" mean
   * "average for this pool", which is the only honest reading of it.
   */
  neutralScore: number
}

export interface Candidate {
  video: Video
  channel: Channel | null
  lane: Lane
}

export interface ScoredCandidate extends Candidate {
  score: number
  breakdown: ScoreBreakdown
  reasons: RecommendationReason[]
  predictedScore: number | null
  matchedInterests: string[]
}

export function scoreCandidate(candidate: Candidate, context: ScoringContext): ScoredCandidate {
  const { settings, now } = context
  const weights = settings.weights

  const predicted = context.scores.get(candidate.video.id) ?? null
  const preference = weights.preference * (predicted ?? context.neutralScore)

  const subscribed = candidate.channel?.subscribed === true
  const subscriptionBonus = subscribed ? weights.subscriptionBonus : 0

  const freshnessBonus = weights.freshnessBonus * freshness(candidate.video, now, settings.freshnessHalfLifeDays)

  const interest = matchInterests(candidate, context.interests, now)
  const explicitInterestBonus = weights.explicitInterestBonus * interest.boost
  const mutedInterestPenalty = interest.muted ? weights.mutedInterestPenalty : 0

  // Exploration rewards channels the user has no opinion about yet, scaled by the
  // "known to explore" slider. Attaching it to the channel rather than to the lane is
  // what lets the slider mean something in the subscription lane too: a subscribed
  // channel that has never been rated is still unfamiliar ground.
  const unratedChannel = candidate.channel !== null && !context.ratedChannelIds.has(candidate.channel.id)
  const explorationBonus = unratedChannel ? weights.explorationBonus * settings.discovery : 0

  const shown = context.seen.get(candidate.video.id) ?? 0
  const seenPenalty = shown === 0 ? 0 : weights.seenPenalty * Math.min(1, shown / 3)

  /**
   * Length, which the model cannot see.
   *
   * What goes to the engine is the title, the channel, the tags and the description —
   * so a video being forty-five seconds long is not something it can learn from,
   * however many times the reader says no to one. On this installation that was
   * twenty-eight ratings averaging 1.2 against 3.3 for everything longer, teaching the
   * model nothing, while four videos in five in the catalog were short.
   *
   * A duration of null is not treated as short. An unknown length is missing evidence,
   * and charging a penalty for it would demote videos for not having been fetched
   * properly.
   */
  const duration = candidate.video.durationSeconds
  const isShort = duration !== null && duration <= settings.shortThresholdSeconds
  const shortPenalty = isShort ? weights.shortPenalty : 0

  const total =
    preference +
    subscriptionBonus +
    freshnessBonus +
    explicitInterestBonus +
    explorationBonus -
    seenPenalty -
    mutedInterestPenalty -
    shortPenalty

  const breakdown: ScoreBreakdown = {
    preference,
    subscriptionBonus,
    freshnessBonus,
    explicitInterestBonus,
    explorationBonus,
    seenPenalty,
    mutedInterestPenalty,
    shortPenalty,
    total,
  }

  return {
    ...candidate,
    score: total,
    breakdown,
    predictedScore: predicted,
    matchedInterests: interest.matched,
    reasons: explain(candidate, breakdown, {
      predicted,
      matchedInterests: interest.boosted,
      unratedChannel,
    }),
  }
}

/**
 * Exponential decay on age, halving every `halfLifeDays`.
 *
 * A step function ("published this week") would make a video worth less the moment a
 * clock ticked past midnight; decay makes the difference between a six-day-old and a
 * seven-day-old video small, which is what it actually is.
 */
export function freshness(video: Video, now: EpochMillis, halfLifeDays: number): number {
  const published = video.publishedAt ?? video.discoveredAt
  const ageDays = Math.max(0, (now - published) / 86_400_000)
  return Math.pow(2, -ageDays / Math.max(0.5, halfLifeDays))
}

interface InterestMatch {
  /** Net boost, where 1.0-weighted controls contribute nothing. */
  boost: number
  muted: boolean
  matched: string[]
  boosted: string[]
}

/**
 * Which interest controls this video matches.
 *
 * Substring matching over title, tags and channel name. It is crude, and deliberately
 * so for V1: the alternative is an embedding lookup, which would put a model call back
 * in the ranking path that design section 33 keeps it out of. The description is
 * excluded because it is mostly links and sponsor copy, and matching there produces
 * confident-looking reasons that are wrong.
 */
export function matchInterests(
  candidate: Candidate,
  interests: InterestControl[],
  now: EpochMillis,
): InterestMatch {
  if (interests.length === 0) return { boost: 0, muted: false, matched: [], boosted: [] }

  const haystack = [
    candidate.video.title,
    candidate.channel?.title ?? candidate.video.metadata.channelTitle ?? '',
    ...(candidate.video.metadata.tags ?? []),
  ]
    .join(' \n ')
    .toLowerCase()

  let boost = 0
  let muted = false
  const matched: string[] = []
  const boosted: string[] = []

  for (const control of interests) {
    const keyword = control.keyword.trim().toLowerCase()
    if (!keyword || !haystack.includes(keyword)) continue

    matched.push(control.keyword)
    const weight = effectiveWeight(control, now)

    if (weight === 0) {
      muted = true
      continue
    }
    // A weight of 1.0 is neutral, so it contributes nothing rather than a full bonus.
    boost += weight - 1
    if (weight > 1) boosted.push(control.keyword)
  }

  // Three boosted keywords on one video does not make it three times as wanted.
  return { boost: Math.max(-1, Math.min(2, boost)), muted, matched, boosted }
}

/**
 * The recommendation reasons (design section 39).
 *
 * Read off the terms of the scoring function rather than generated. That is the only
 * way the explanation can be true: it is the same arithmetic that produced the
 * ranking, not a plausible story told about it afterwards. No LLM is involved.
 */
function explain(
  candidate: Candidate,
  breakdown: ScoreBreakdown,
  extra: { predicted: number | null; matchedInterests: string[]; unratedChannel: boolean },
): RecommendationReason[] {
  const reasons: RecommendationReason[] = []

  if (breakdown.subscriptionBonus > 0) {
    const subject = candidate.channel?.title ?? candidate.video.metadata.channelTitle
    reasons.push({ kind: 'subscribed_channel', ...(subject ? { subject } : {}) })
  }

  // Seven out of ten on the "do you want more of this" axis, which is where a
  // prediction stops being a guess worth mentioning.
  if (extra.predicted !== null && extra.predicted >= 7) {
    reasons.push({ kind: 'predicted_high' })
  }

  for (const keyword of extra.matchedInterests) {
    reasons.push({ kind: 'interest_boost', subject: keyword })
  }

  if (breakdown.freshnessBonus > breakdown.total * 0.2 && breakdown.freshnessBonus > 0.4) {
    reasons.push({ kind: 'recently_published' })
  }

  if (candidate.lane === 'explore') {
    reasons.push({ kind: 'exploring' })
  } else if (extra.unratedChannel) {
    reasons.push({ kind: 'unrated_channel' })
  }

  return reasons
}

/** The mean of whatever the model has scored, or a neutral 5 when it has scored nothing. */
export function poolMean(scores: Map<string, number>): number {
  if (scores.size === 0) return 5
  let total = 0
  for (const score of scores.values()) total += score
  return total / scores.size
}
