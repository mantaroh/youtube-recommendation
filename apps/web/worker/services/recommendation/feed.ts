import type { EpochMillis, Feed, FeedItem, Lane, RatingValue } from '@ypr/domain'
import { DIVERSITY_WINDOW, RESCORE_WINDOW_DAYS } from '@ypr/domain'
import { listInterests } from '../../db/interests.js'
import { activeModel, scoresFor } from '../../db/models.js'
import { currentRatings, seenCounts } from '../../db/ratings.js'
import { listCandidates, type VideoWithChannel } from '../../db/videos.js'
import { loadSettings } from '../../db/settings.js'
import { poolMean, scoreCandidate, type Candidate, type ScoredCandidate, type ScoringContext } from './rank.js'

/**
 * Feed assembly (design sections 33, 34 and 35).
 *
 * No GPU call happens here. The feed is built from `recommendation_scores`, which a
 * training or discovery run filled in earlier, so a request costs a few D1 queries and
 * works unchanged while Runpod is asleep or down (design sections 33 and 49).
 */

export interface BuildFeedOptions {
  profileId: string
  now: EpochMillis
  /** Restrict to one lane, for the "Subscriptions" and "Discover" tabs. */
  lane?: Lane
  limit?: number
}

export async function buildFeed(db: D1Database, options: BuildFeedOptions): Promise<Feed> {
  const { profileId, now } = options
  const settings = await loadSettings(db, profileId)
  const size = options.limit ?? settings.feedSize

  const model = await activeModel(db, profileId)
  const modelVersion = model ? `model-${model.version}` : null

  const [interests, ratings, seen, scores] = await Promise.all([
    listInterests(db, profileId),
    currentRatings(db, profileId),
    seenCounts(db, profileId),
    modelVersion ? scoresFor(db, profileId, modelVersion) : Promise.resolve(new Map<string, number>()),
  ])

  const ratedChannelIds = await ratedChannels(db, profileId)

  const context: ScoringContext = {
    settings,
    now,
    interests,
    scores,
    seen,
    ratedChannelIds,
    neutralScore: poolMean(scores),
  }

  const publishedAfter = now - RESCORE_WINDOW_DAYS * 86_400_000

  // Each lane draws from its own pool, so that a lane cannot be crowded out by a
  // neighbour that happens to have more candidates (design section 34).
  const [subscriptionPool, otherPool] = await Promise.all([
    listCandidates(db, {
      profileId,
      publishedAfter,
      limit: size * 6,
      subscribed: true,
      excludeRatedBy: profileId,
    }),
    listCandidates(db, {
      profileId,
      publishedAfter,
      limit: size * 10,
      subscribed: false,
      excludeRatedBy: profileId,
    }),
  ])

  const quotas = laneQuotas(size, settings.laneMix, options.lane)

  const subscription = rankPool(subscriptionPool, 'subscription', context)
  // Related and explore both draw from channels the user does not follow. They are
  // separated by how well the model already knows the channel: related is where the
  // prediction is confident, explore is where it has nothing to go on. Splitting them
  // this way is what keeps design section 34's promise that the videos the model
  // predicts most easily cannot take the whole feed.
  const others = rankPool(otherPool, 'related', context)
  const related = others.filter((item) => item.predictedScore !== null)
  const explore = others
    .filter((item) => item.predictedScore === null)
    .map((item) => ({ ...item, lane: 'explore' as Lane }))

  const picked = [
    ...take(subscription, quotas.subscription),
    ...take(related, quotas.related),
    ...take(explore, quotas.explore),
  ]

  // A lane that came up short leaves its slots to the others rather than shrinking the
  // feed. A half-empty feed is a worse answer than a differently balanced one.
  //
  // Only among lanes that were allotted slots, though: when the feed is filtered to
  // one lane, borrowing from the others would put back exactly what the filter asked
  // to exclude.
  const shortfall = size - picked.length
  if (shortfall > 0) {
    const chosen = new Set(picked.map((item) => item.video.id))
    const spare = [
      ...(quotas.subscription > 0 ? subscription : []),
      ...(quotas.related > 0 ? related : []),
      ...(quotas.explore > 0 ? explore : []),
    ]
      .filter((item) => !chosen.has(item.video.id))
      .sort((left, right) => right.score - left.score)
    picked.push(...spare.slice(0, shortfall))
  }

  const ordered = diversify(picked.sort((left, right) => right.score - left.score), settings.maxPerChannel)

  const laneCounts: Record<Lane, number> = { subscription: 0, related: 0, explore: 0 }
  for (const item of ordered) laneCounts[item.lane] += 1

  return {
    items: ordered.map((item) => toFeedItem(item, ratings.get(item.video.id) ?? null)),
    modelVersion,
    generatedAt: now,
    laneCounts,
  }
}

function toFeedItem(candidate: ScoredCandidate, rating: RatingValue | null): FeedItem {
  return {
    video: candidate.video,
    channel: candidate.channel,
    lane: candidate.lane,
    score: candidate.score,
    breakdown: candidate.breakdown,
    reasons: candidate.reasons,
    rating,
    predictedScore: candidate.predictedScore,
  }
}

function rankPool(pool: VideoWithChannel[], lane: Lane, context: ScoringContext): ScoredCandidate[] {
  const candidates: Candidate[] = pool.map(({ video, channel }) => ({ video, channel, lane }))
  return candidates
    .map((candidate) => scoreCandidate(candidate, context))
    .sort((left, right) => right.score - left.score)
}

function take(items: ScoredCandidate[], count: number): ScoredCandidate[] {
  return count <= 0 ? [] : items.slice(0, count)
}

/**
 * How many slots each lane gets (design sections 17 and 34).
 *
 * The worked example is a 50-item feed split 25 / 15 / 10, which is the 50 / 30 / 20
 * mix rounded. Rounding down and giving the remainder to the subscription lane keeps
 * the total exact without a lane silently gaining a slot it was not allotted.
 */
export function laneQuotas(
  size: number,
  mix: { subscription: number; related: number; explore: number },
  only?: Lane,
): Record<Lane, number> {
  if (only) {
    return {
      subscription: only === 'subscription' ? size : 0,
      related: only === 'related' ? size : 0,
      explore: only === 'explore' ? size : 0,
    }
  }

  const total = mix.subscription + mix.related + mix.explore || 1
  const related = Math.floor((size * mix.related) / total)
  const explore = Math.floor((size * mix.explore) / total)
  return { subscription: size - related - explore, related, explore }
}

/**
 * Diversity re-ranking (design section 35).
 *
 * At most `maxPerChannel` videos from one channel per window of twenty. Applied as a
 * deferral rather than a filter: a video that exceeds the cap is pushed back rather
 * than dropped, so a feed dominated by one prolific channel gets rearranged instead of
 * truncated.
 */
export function diversify(items: ScoredCandidate[], maxPerChannel: number): ScoredCandidate[] {
  const ordered: ScoredCandidate[] = []
  const deferred: ScoredCandidate[] = []

  for (const item of items) {
    const channelId = item.channel?.id ?? item.video.channelId ?? item.video.id
    const window = ordered.slice(Math.max(0, ordered.length - DIVERSITY_WINDOW))
    const inWindow = window.filter(
      (other) => (other.channel?.id ?? other.video.channelId ?? other.video.id) === channelId,
    ).length

    if (inWindow >= maxPerChannel) deferred.push(item)
    else ordered.push(item)
  }

  // Deferred items go to the end in score order. They are still the user's videos;
  // they simply lost the argument about where in the list they belong.
  return [...ordered, ...deferred]
}

async function ratedChannels(db: D1Database, profileId: string): Promise<Set<string>> {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT v.channel_id AS channel_id
       FROM rating_events r
       JOIN videos v ON v.id = r.video_id
       WHERE r.profile_id = ?1 AND r.disabled_at IS NULL AND v.channel_id IS NOT NULL`,
    )
    .bind(profileId)
    .all<{ channel_id: string }>()
  return new Set((results ?? []).map((row) => row.channel_id))
}
