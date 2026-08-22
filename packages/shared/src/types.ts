/**
 * Core domain types.
 *
 * Design reference: docs/design/personal-preference-model-youtube-recommender-v1.en.md
 * sections 2.2 (Events), 2.3 (Catalog items) and 3.5 (Cluster state).
 *
 * `source` is a first-class key everywhere so that Article / Podcast sources can be
 * added later without touching the preference model (design section 0).
 */

/** Content source. V1 only ships `youtube`, but the model never assumes a single source. */
export type Source = 'youtube'

/**
 * Rating on the "how much do you want to see videos like this from now on?" axis
 * (design section 5.1). `0` means "no more of this" and is distinct from *unrated*,
 * which is represented by the absence of a rating event.
 */
export type RatingValue = 0 | 1 | 2 | 3 | 4 | 5

/** Candidate lane (design section 4.2). */
export type Lane = 'subscription' | 'related' | 'explore'

/** Popularity stratum used for sampling inside the related / explore lanes (design section 4.3). */
export type PopularityTier = 'established' | 'emerging' | 'wildcard'

/** Identity of a single piece of content. */
export interface ItemRef {
  source: Source
  externalId: string
}

/**
 * Metadata obtained from an external service. Always carries a TTL: unauthenticated
 * API data must be deleted or refreshed within 30 days (design section 6.2).
 */
export interface CatalogItem extends ItemRef {
  title: string
  description: string
  tags: string[]
  channelId: string
  channelTitle: string
  /** Official category id from the source. Never overwritten by our own inference (design section 6.2). */
  officialCategoryId: string
  durationSeconds: number
  publishedAt: string
  viewCount: number
  metadataFetchedAt: string
  /** metadataFetchedAt + 30 days. */
  expiresAt: string
  provenance: Provenance
}

/**
 * Where the metadata came from. `fixture` marks recorded responses used by tests and
 * by development without credentials; it is never written by the live client.
 */
export type Provenance = 'youtube_api' | 'fixture'

/** An embedding of a catalog item, tagged with the model that produced it (design section 7.2). */
export interface EmbeddingRecord extends ItemRef {
  modelId: string
  generatedAt: string
  vector: Float32Array
}

/** Latest rating for an item, derived from the event log. */
export interface RatingRecord extends ItemRef {
  rating: RatingValue
  ratedAt: string
}

// ---------------------------------------------------------------------------
// Events — the source of truth (design section 2.1)
// ---------------------------------------------------------------------------

export interface EventBase {
  /** Monotonic sequence number assigned by the append-only store. */
  seq: number
  /** ISO 8601 timestamp. */
  ts: string
}

export interface RatingEvent extends EventBase, ItemRef {
  type: 'rating'
  rating: RatingValue
}

/**
 * Operations a user can perform on an interest cluster (design section 3.5).
 *
 * `unpin` / `unmute` / `restore` are not listed in the design document but are required
 * for any of the other operations to be reversible; see the implementation notes appendix.
 */
export type InterestOp =
  | 'pin'
  | 'unpin'
  | 'mute'
  | 'unmute'
  | 'forget'
  | 'restore'
  | 'set_strength'
  | 'rename'

export interface InterestOverrideEvent extends EventBase {
  type: 'interest_override'
  clusterId: string
  op: InterestOp
  /** Used by `set_strength`, in [0, 1]. */
  value?: number
  /** Used by `rename`. */
  label?: string
  /** Used by `mute`: the moment the mute expires. */
  untilTs?: string
}

/**
 * Implicit watch signal. Recorded from V1 but weighted 0 by default so that it can be
 * enabled retroactively without losing history (design section 2.2).
 */
export interface WatchEvent extends EventBase, ItemRef {
  type: 'watch'
  watchedSeconds: number
  durationSeconds: number
}

/** What the feed showed, so that offline evaluation is possible later (design section 4.5). */
export interface ImpressionEvent extends EventBase, ItemRef {
  type: 'impression'
  lane: Lane
  position: number
}

export type AppEvent = RatingEvent | InterestOverrideEvent | WatchEvent | ImpressionEvent

/** An event before the store has assigned it a sequence number. */
export type NewEvent =
  | Omit<RatingEvent, 'seq'>
  | Omit<InterestOverrideEvent, 'seq'>
  | Omit<WatchEvent, 'seq'>
  | Omit<ImpressionEvent, 'seq'>

// ---------------------------------------------------------------------------
// Derived state (design section 3)
// ---------------------------------------------------------------------------

/**
 * One interest, materialised from the event log. Every field shown in the "Manage
 * interests" screen corresponds to a term in the scoring function (design section 3.1).
 */
export interface InterestCluster {
  id: string
  label: string
  labelSource: 'auto' | 'user'
  /** L2-normalised centroid. */
  centroid: Float32Array
  memberIds: string[]
  /** Signed sum of rating weights, no decay. */
  massLong: number
  /** Signed sum of rating weights with `H_short` decay. */
  massShort: number
  /** Magnitude of negative ratings with `H_neg` decay. */
  massNegative: number
  /**
   * The three masses rescaled to [0, 1] across all clusters. The ranker uses these
   * directly, so it never has to know how many clusters there are or how heavy they get.
   */
  normalisedLong: number
  normalisedShort: number
  normalisedNegative: number
  /** User-set strength in [0, 1], or null when unset. */
  explicitStrength: number | null
  pinned: boolean
  /** ISO timestamp until which the cluster is muted, or null. */
  mutedUntil: string | null
  forgotten: boolean
  /** Normalised activity `a_c` in [0, 1], recomputed on every rebuild. */
  activity: number
  updatedAt: string
}

/** Per-channel affinity accumulator (design section 4.1). */
export interface ChannelAffinity {
  channelId: string
  /** Sum of rating weights across rated videos of this channel. */
  weightSum: number
  ratedCount: number
}

/** Everything the ranker needs, rebuilt deterministically from the event log. */
export interface PreferenceState {
  clusters: InterestCluster[]
  channels: Record<string, ChannelAffinity>
  /** Keys (`source:externalId`) that already carry a rating. */
  ratedKeys: string[]
  /** Keys that have been shown in the feed at least once. */
  seenKeys: string[]
  /** Sequence number of the last event folded into this state. */
  atSeq: number
  /** Instant the state was evaluated at; decay is relative to this. */
  evaluatedAt: string
  modelId: string
  dimensions: number
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Relative weights of the terms of the scoring function (design section 4.1). */
export interface ScoreWeights {
  channel: number
  long: number
  short: number
  negative: number
  explore: number
  freshness: number
  /** Weight of the implicit watch signal. 0 in V1 (design section 2.2). */
  watch: number
}

export interface AppSettings {
  /** "Stable ←→ discovery" slider in [0, 1] (design section 4.2). */
  discovery: number
  scoreWeights: ScoreWeights
  /** Cosine threshold for cluster assignment. */
  tau: number
  /** Maximum number of clusters. */
  kMax: number
  /** Number of videos requested per feed build. */
  feedSize: number
  subscribedChannelIds: string[]
}

// ---------------------------------------------------------------------------
// Ranking output
// ---------------------------------------------------------------------------

/** A scored candidate together with the reason it scored that way (design section 4.6). */
export interface ScoreBreakdown {
  channel: number
  long: number
  short: number
  negative: number
  explore: number
  freshness: number
  penalty: number
  total: number
  /** Cluster that produced the strongest long-term match, if any. */
  topClusterId: string | null
  topClusterLabel: string | null
  topClusterSimilarity: number
}

export interface RankedItem {
  item: CatalogItem
  lane: Lane
  tier: PopularityTier
  score: number
  breakdown: ScoreBreakdown
}
