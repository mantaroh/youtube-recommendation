import type { CatalogItem, Lane, PreferenceState, RankedItem } from '@ypr/shared'
import { itemKey } from '@ypr/shared'
import { VectorIndex, assembleFeed, cosine, laneQuotas, type Candidate } from '@ypr/core'
import { getDb } from './db.js'
import { loadPreferenceContext } from './preference.js'
import { getAppSettings } from './settings.js'

/**
 * Candidate generation and feed assembly.
 *
 * Everything here runs against the local index. Nothing about what the user likes is sent
 * anywhere to produce these candidates, which is the whole point of keeping the catalog
 * local rather than querying a hosted vector service (design section 1.1).
 */

/** How many neighbours each active interest contributes to the related lane. */
const NEIGHBOURS_PER_CLUSTER = 40
/** Size of the explore pool drawn from the far end of the catalog. */
const EXPLORE_POOL = 120

export interface FeedResult {
  items: RankedItem[]
  state: PreferenceState
  quotas: Record<Lane, number>
  asOf: string | null
  /** Set when there is nothing to rank yet, with the reason. */
  emptyReason?: string
}

export async function buildFeed(options: { now?: string; feedSize?: number } = {}): Promise<FeedResult> {
  const now = options.now ?? new Date().toISOString()
  const settings = await getAppSettings()
  const feedSize = options.feedSize ?? settings.feedSize
  const context = await loadPreferenceContext({ now })
  const { state, items, embeddings, asOf } = context

  const subscribedChannelIds = await loadSubscribedChannelIds()
  const quotas = laneQuotas(settings.discovery, feedSize)

  if (items.size === 0) {
    return { items: [], state, quotas, asOf, emptyReason: 'Nothing has been fetched yet.' }
  }

  const index = new VectorIndex(state.dimensions, Math.max(16, embeddings.size))
  for (const [key, vector] of embeddings) index.upsert(key, vector)

  const candidates = collectCandidates({
    items,
    embeddings,
    index,
    state,
    subscribedChannelIds,
  })

  const candidateCount =
    (candidates.subscription?.length ?? 0) +
    (candidates.related?.length ?? 0) +
    (candidates.explore?.length ?? 0)

  if (candidateCount === 0) {
    // Distinguishing this from an empty catalog matters: the two need opposite actions,
    // and telling someone to rate more when they have already rated everything is worse
    // than saying nothing.
    return {
      items: [],
      state,
      quotas,
      asOf,
      emptyReason:
        state.ratedKeys.length >= items.size
          ? 'Everything in the local catalog has been rated. Fetch new uploads or look for unfamiliar videos on the Status tab.'
          : 'No candidates matched. Try moving the slider toward discovery, or fetch more videos.',
    }
  }

  const ranked = assembleFeed({
    state,
    now: asOf ?? now,
    weights: settings.scoreWeights,
    subscribedChannelIds,
    discovery: settings.discovery,
    feedSize,
    candidates,
  })

  return { items: ranked, state, quotas, asOf }
}

function collectCandidates(input: {
  items: Map<string, CatalogItem>
  embeddings: Map<string, Float32Array>
  index: VectorIndex
  state: PreferenceState
  subscribedChannelIds: Set<string>
}): Partial<Record<Lane, Candidate[]>> {
  const { items, embeddings, index, state, subscribedChannelIds } = input
  const rated = new Set(state.ratedKeys)

  const asCandidate = (key: string): Candidate | undefined => {
    const item = items.get(key)
    if (!item) return undefined
    return { item, embedding: embeddings.get(key) }
  }

  // Subscriptions: everything unrated from a channel the user follows.
  const subscription: Candidate[] = []
  for (const [key, item] of items) {
    if (rated.has(key)) continue
    if (subscribedChannelIds.has(item.channelId)) {
      const candidate = asCandidate(key)
      if (candidate) subscription.push(candidate)
    }
  }

  // Related: nearest neighbours of each interest that is currently active. A muted or
  // forgotten interest contributes nothing, which is what makes muting take effect
  // immediately rather than only lowering a score.
  const relatedKeys = new Set<string>()
  for (const cluster of state.clusters) {
    if (cluster.activity <= 0) continue
    for (const hit of index.search(cluster.centroid, {
      topK: NEIGHBOURS_PER_CLUSTER,
      filter: (key) => !rated.has(key) && !subscribedChannelIds.has(items.get(key)?.channelId ?? ''),
      minSimilarity: 0.2,
    })) {
      relatedKeys.add(hit.key)
    }
  }

  // Explore: the far end of the catalog. Ordering by *lowest* similarity to every
  // interest is what makes this lane genuinely different from "related", rather than
  // just more of the same with a lower score.
  const explorePool: Array<{ key: string; similarity: number }> = []
  for (const [key, vector] of embeddings) {
    if (rated.has(key) || relatedKeys.has(key)) continue
    const item = items.get(key)
    if (!item || subscribedChannelIds.has(item.channelId)) continue
    let best = 0
    for (const cluster of state.clusters) {
      if (cluster.forgotten) continue
      best = Math.max(best, cosine(vector, cluster.centroid))
    }
    explorePool.push({ key, similarity: best })
  }
  explorePool.sort((a, b) => a.similarity - b.similarity)

  return {
    subscription,
    related: [...relatedKeys].map(asCandidate).filter((entry): entry is Candidate => Boolean(entry)),
    explore: explorePool
      .slice(0, EXPLORE_POOL)
      .map((entry) => asCandidate(entry.key))
      .filter((entry): entry is Candidate => Boolean(entry)),
  }
}

/**
 * Subscribed channels come from settings, which every adapter updates on ingestion, with
 * the channel table as a fallback. The live adapter fills both; the fixture adapter has
 * no uploads playlists to record and fills only the former.
 */
export async function loadSubscribedChannelIds(): Promise<Set<string>> {
  const settings = await getAppSettings()
  if (settings.subscribedChannelIds.length > 0) return new Set(settings.subscribedChannelIds)
  const rows = await getDb().channels.filter((row) => row.subscribed).toArray()
  return new Set(rows.map((row) => row.channelId))
}

/** Every item key currently in the feed, for recording impressions. */
export function feedKeys(result: FeedResult): string[] {
  return result.items.map((entry) => itemKey(entry.item))
}
