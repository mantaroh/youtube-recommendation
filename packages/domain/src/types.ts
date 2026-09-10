/**
 * Core domain types.
 *
 * Design reference: docs/design/personal-recommender-v2.ja.md sections 8 through 15.
 *
 * `source` is a first-class key everywhere so that Podcast / RSS / Web sources can be
 * added later without touching a single table definition (design section 8). YouTube
 * ids never appear as a primary key on their own.
 */

/**
 * Milliseconds since the Unix epoch.
 *
 * Every timestamp column in D1 is `INTEGER` (design sections 9 through 15), so the
 * domain speaks the same unit rather than converting at each query. ISO strings appear
 * only where a person reads them: exports and the API's human-facing fields.
 */
export type EpochMillis = number

/** Content source. V1 only ships `youtube`, but nothing below assumes a single source. */
export type Source = 'youtube'

/**
 * Rating on the "how much do you want to see videos like this from now on?" axis
 * (design section 37). `0` means "no more of this" and is distinct from *unrated*,
 * which is the absence of a rating event rather than a zero.
 */
export type RatingValue = 0 | 1 | 2 | 3 | 4 | 5

/**
 * Anagnorisis rates on 0..10; this system asks for 0..5 because five stars is what a
 * person can answer without deliberating (design section 10).
 */
export function toEngineRating(rating: RatingValue): number {
  return rating * 2
}

/** The inverse, used when a predicted 0..10 score has to be shown as stars. */
export function fromEngineRating(score: number): number {
  return score / 2
}

/** Candidate lane (design section 17). */
export type Lane = 'subscription' | 'related' | 'explore'

/** Identity of a single piece of content, independent of any one platform. */
export interface ItemRef {
  source: Source
  externalId: string
}

// ---------------------------------------------------------------------------
// Stored entities (design sections 9 through 15)
// ---------------------------------------------------------------------------

/**
 * A profile owns ratings and interests. Single-user systems still get one, because
 * retrofitting a partition key onto an event log is far harder than carrying it from
 * the start (design section 9.1).
 */
export interface Profile {
  id: string
  name: string
  createdAt: EpochMillis
}

export const DEFAULT_PROFILE_ID = 'default'

export interface Channel {
  /** `${source}:${externalId}`. */
  id: string
  source: Source
  externalId: string
  title: string | null
  thumbnailUrl: string | null
  subscribed: boolean
  lastFetchedAt: EpochMillis | null
}

export interface Video {
  /** `${source}:${externalId}`. */
  id: string
  source: Source
  externalId: string
  /** Channel row id, not the platform's channel id. */
  channelId: string | null
  title: string
  description: string | null
  thumbnailUrl: string | null
  publishedAt: EpochMillis | null
  durationSeconds: number | null
  viewCount: number | null
  /** Anything source-specific that has no column of its own, as JSON. */
  metadata: VideoMetadata
  discoveredAt: EpochMillis
  refreshedAt: EpochMillis | null
}

/**
 * Source-specific fields. Kept in one JSON column rather than spread across nullable
 * columns, because what a Podcast source will want to record here is not knowable now.
 */
export interface VideoMetadata {
  tags?: string[]
  channelTitle?: string
  /** Official category id from the source. Never overwritten by our own inference. */
  officialCategoryId?: string
  /** Which discovery pass first produced this row, for quota accounting. */
  discoveredBy?: Lane
  /** Search term that surfaced it, when it came from a search rather than a channel. */
  discoveryQuery?: string
  [key: string]: unknown
}

/**
 * One rating, as it happened.
 *
 * Never updated (design section 11): re-rating the same video appends a second row, so
 * that "I liked this in April and cooled on it in August" stays legible. `disabledAt`
 * exists for retracting a misclick without rewriting history.
 */
export interface RatingEvent {
  id: string
  profileId: string
  videoId: string
  rating: RatingValue
  createdAt: EpochMillis
  disabledAt: EpochMillis | null
}

/**
 * A keyword the user has deliberately turned up or down (design section 12).
 *
 * This is not a model output and is not learned. It applies at ranking time, so a
 * change takes effect on the next feed rather than after the next training run.
 */
export interface InterestControl {
  id: string
  profileId: string
  keyword: string
  /** 1.0 is neutral. 0 mutes permanently; above 1 boosts. */
  weight: number
  /** Muted until this instant, then back to `weight`. Null means no timed mute. */
  muteUntil: EpochMillis | null
  createdAt: EpochMillis
  updatedAt: EpochMillis
}

export type ModelVersionStatus = 'training' | 'ready' | 'active' | 'failed' | 'superseded'

export interface ModelVersion {
  id: string
  profileId: string
  /** Monotonic per profile. `model-<version>` is the name the GPU side knows. */
  version: number
  trainingEventCount: number | null
  status: ModelVersionStatus
  createdAt: EpochMillis
  activatedAt: EpochMillis | null
  metadata: ModelVersionMetadata
}

export interface ModelVersionMetadata {
  /** Path the GPU side wrote the evaluator to, for auditing. */
  modelPath?: string
  trainedSeconds?: number
  /** Accuracy figures the trainer reported, if any. */
  accuracy?: Record<string, number>
  error?: string
  [key: string]: unknown
}

/** A cached prediction. GPU work is expensive, so nothing recomputes it per request. */
export interface RecommendationScore {
  profileId: string
  videoId: string
  /** `model-<version>`. */
  modelVersion: string
  /** Anagnorisis scale, 0..10. */
  score: number
  scoredAt: EpochMillis
}

export type GpuJobType = 'embed_batch' | 'describe_batch' | 'train' | 'score_batch'

export type GpuJobStatus = 'queued' | 'processing' | 'completed' | 'failed'

export interface GpuJob {
  id: string
  type: GpuJobType
  runpodJobId: string | null
  status: GpuJobStatus
  /** SHA-256 over profile, model version and input ids (design section 47). */
  payloadHash: string | null
  createdAt: EpochMillis
  startedAt: EpochMillis | null
  completedAt: EpochMillis | null
  error: string | null
  /**
   * When a claimed job stops being the claimant's to finish.
   * Null for jobs nobody has taken, and for the push model, which has no claim step.
   */
  leaseExpiresAt: EpochMillis | null
  /** How many times this job has been resubmitted (design section 48). */
  attempts: number
  /** Job-type specific context the completion handler needs, as JSON. */
  context: GpuJobContext
}

export interface GpuJobContext {
  profileId?: string
  modelVersion?: string
  modelVersionId?: string
  videoIds?: string[]
  [key: string]: unknown
}

// ---------------------------------------------------------------------------
// Ranking output (design sections 33, 34, 39)
// ---------------------------------------------------------------------------

/**
 * Every term of the scoring function, kept separately.
 *
 * The breakdown is not diagnostics: it is what the "why am I seeing this" panel is
 * built from (design section 39). A single collapsed number could not answer that
 * question without a model call, which the ranking path is not allowed to make.
 */
export interface ScoreBreakdown {
  /** `0.65 * preference_score`, where preference_score is the cached GPU prediction. */
  preference: number
  subscriptionBonus: number
  freshnessBonus: number
  explicitInterestBonus: number
  explorationBonus: number
  /** Subtracted, so this is reported as a positive magnitude. */
  seenPenalty: number
  /** Subtracted. */
  mutedInterestPenalty: number
  total: number
}

/** Machine-readable recommendation reason. The wording lives in the UI, not here. */
export interface RecommendationReason {
  kind:
    | 'subscribed_channel'
    | 'predicted_high'
    | 'interest_boost'
    | 'recently_published'
    | 'exploring'
    | 'unrated_channel'
  /** Keyword or channel title the reason refers to, when it has one. */
  subject?: string
}

export interface FeedItem {
  video: Video
  channel: Channel | null
  lane: Lane
  score: number
  breakdown: ScoreBreakdown
  reasons: RecommendationReason[]
  /** Latest rating for this video, or null when unrated. */
  rating: RatingValue | null
  /** The cached prediction this was ranked with, or null when the model has not seen it. */
  predictedScore: number | null
}

export interface Feed {
  items: FeedItem[]
  /** `model-<version>` the scores came from, or null when nothing has been trained. */
  modelVersion: string | null
  generatedAt: EpochMillis
  /** How many items each lane contributed, for the status screen. */
  laneCounts: Record<Lane, number>
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Ranking weights (design section 33). Exposed rather than hard-coded so that the mix
 * can be tuned without a deploy, and so that the numbers behind the feed stay
 * inspectable by the person the feed is for.
 */
export interface RankingWeights {
  preference: number
  subscriptionBonus: number
  freshnessBonus: number
  explicitInterestBonus: number
  explorationBonus: number
  seenPenalty: number
  mutedInterestPenalty: number
}

/** Lane mix (design sections 17 and 34). */
export interface LaneMix {
  subscription: number
  related: number
  explore: number
}

export interface AppSettings {
  weights: RankingWeights
  laneMix: LaneMix
  feedSize: number
  /**
   * ISO 3166-1 region the search and the popularity chart are asked about.
   *
   * Without it YouTube infers a region from the caller's address, which for a Worker is
   * whichever Cloudflare edge took the request — not where the person watching lives.
   */
  region: string
  /**
   * ISO 639-1 language the search is biased toward, and the script the explore lane
   * writes its queries in. A relevance bias, not a filter: content in other languages
   * still appears.
   */
  language: string
  /** "Known to Explore" slider in [0, 1] (design section 38). */
  discovery: number
  /** Maximum videos from one channel per feed (design section 35). */
  maxPerChannel: number
  /** Freshness half-life in days. */
  freshnessHalfLifeDays: number
  /** Ratings since the last training run that trigger a retrain (design section 31). */
  retrainAfterRatings: number
  /** Days since the last training run that trigger a retrain. */
  retrainAfterDays: number
}
