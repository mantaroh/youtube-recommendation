import type { CatalogItem, ItemRef, Source } from './types.js'

/**
 * Replaceable inference backend (design section 7.1).
 *
 * Implementations can be Transformers.js in the browser, a local llama.cpp server, or
 * anything else that speaks these three methods. Nothing above this interface knows
 * which one is in use, so the system depends on no particular vendor.
 *
 * Query and passage embedding are separate methods on purpose: e5-family models need
 * `query: ` / `passage: ` prefixes, and that convention stays inside the implementation
 * (design section 7.2).
 */
export interface InferenceEngine {
  readonly modelId: string
  readonly dimensions: number
  /** Embed text that represents a user's information need. */
  embedQuery(texts: string[]): Promise<Float32Array[]>
  /** Embed text that represents a document. */
  embedPassage(texts: string[]): Promise<Float32Array[]>
  /** Optional generation, used only for cluster naming and explanation text (design section 4.6). */
  generate?(messages: ChatMessage[]): Promise<string>
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * Replaceable candidate store (design section 7.1).
 *
 * V1 ships `LocalVectorStore` only. Vectorize is deliberately not on the critical path,
 * because querying it with a preference vector would break the trust boundary
 * (design section 1.1).
 */
export interface CatalogVectorStore {
  upsert(entries: CatalogVectorEntry[]): Promise<void>
  query(vector: Float32Array, options: VectorQueryOptions): Promise<VectorMatch[]>
  size(): Promise<number>
}

export interface CatalogVectorEntry extends ItemRef {
  vector: Float32Array
  publishedAt: string
  channelId: string
}

export interface VectorQueryOptions {
  topK: number
  /** Exclude these keys (`source:externalId`) from the result. */
  excludeKeys?: Set<string>
  /** Only consider items from these channels. */
  channelIds?: Set<string>
  /** Only consider items published at or after this instant. */
  publishedAfter?: string
  /** Minimum cosine similarity. */
  minSimilarity?: number
}

export interface VectorMatch extends ItemRef {
  similarity: number
}

/**
 * Replaceable content source (design section 7.1). Adding Article / Podcast later means
 * adding an implementation here, not changing the preference model.
 */
export interface SourceAdapter {
  readonly source: Source
  /** New uploads from channels the user subscribes to. */
  listSubscriptionUpdates(options: SubscriptionUpdateOptions): Promise<CatalogItem[]>
  /** Search for unknown content. Queries are built locally and go straight to the source. */
  search(query: string, options: SearchOptions): Promise<CatalogItem[]>
  /** Fill in full metadata for ids discovered elsewhere. */
  hydrate(externalIds: string[]): Promise<CatalogItem[]>
  /** Channel ids the user subscribes to. */
  listSubscribedChannelIds(): Promise<string[]>
}

export interface SubscriptionUpdateOptions {
  publishedAfter: string
  maxPerChannel: number
  channelIds?: string[]
}

export interface SearchOptions {
  maxResults: number
  publishedAfter?: string
  /** Bias the request toward a popularity stratum where the source supports it. */
  order?: 'relevance' | 'date' | 'viewCount'
}
