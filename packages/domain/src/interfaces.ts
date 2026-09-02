import type { Channel, Lane, Source, Video } from './types.js'

/**
 * Replaceable content source (design section 52).
 *
 * Everything that knows YouTube exists lives behind this. Adding a Podcast or RSS
 * source later means writing another implementation, not editing the ranker, the
 * schema or the GPU service.
 */
export interface ContentSource {
  readonly source: Source

  /** Channels the authenticated user subscribes to. */
  getSubscriptions(): Promise<SourceChannel[]>

  /** Find content that is not already known. */
  discover(query: DiscoveryQuery): Promise<SourceItem[]>

  /** Full metadata for ids discovered elsewhere. */
  getItems(externalIds: string[]): Promise<SourceItem[]>
}

/**
 * A discovery request, expressed in terms every source can honour. `lane` travels with
 * it so that the quota ledger can tell an exploration query from a subscription
 * refresh without inspecting the text (design section 42).
 */
export interface DiscoveryQuery {
  lane: Lane
  /** Free-text search. Absent for a channel walk. */
  term?: string
  /** Restrict to these channels, by the source's own channel id. */
  channelExternalIds?: string[]
  maxResults: number
  /** ISO 8601. Only content published at or after this instant. */
  publishedAfter?: string
  order?: 'relevance' | 'date' | 'viewCount'
}

/** A channel as the source describes it, before it becomes a row. */
export interface SourceChannel {
  externalId: string
  title: string
  thumbnailUrl: string | null
  /** YouTube's uploads playlist, or whatever the source uses to walk recent items. */
  uploadsPlaylistId?: string
}

/** An item as the source describes it, before it becomes a row. */
export interface SourceItem {
  externalId: string
  title: string
  description: string
  channelExternalId: string
  channelTitle: string
  thumbnailUrl: string | null
  /** ISO 8601. */
  publishedAt: string | null
  durationSeconds: number | null
  viewCount: number | null
  tags: string[]
  officialCategoryId: string | null
}

/**
 * Replaceable preference engine, as the Worker sees it (design section 51).
 *
 * The Worker never imports anything from Anagnorisis. It submits jobs described in
 * these terms, and a different engine behind the same four methods would require no
 * change above this line.
 */
export interface PreferenceEngineClient {
  train(request: TrainRequest): Promise<{ runpodJobId: string }>
  scoreBatch(request: ScoreRequest): Promise<{ runpodJobId: string }>
}

export interface TrainRequest {
  profileId: string
  modelVersion: string
  events: Array<{ itemId: string; rating: number; description: string; ratedAt?: string }>
}

export interface ScoreRequest {
  profileId: string
  modelVersion: string
  items: Array<{ id: string; text: string }>
}

/** What a source adapter needs in order to turn its own items into rows. */
export interface ChannelResolver {
  /** Row id for a source channel, creating the row when it is new. */
  resolve(channel: SourceChannel): Promise<Channel>
}

export interface VideoWriter {
  upsert(videos: Video[]): Promise<number>
}
