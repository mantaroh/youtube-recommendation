import type { CatalogItem, InferenceEngine, SourceAdapter } from '@ypr/shared'
import { itemKey } from '@ypr/shared'
import { getDb, primaryKeyOf } from './db.js'
import { getSetting, setSetting, updateAppSettings } from './settings.js'
import { embeddingTextFor } from './sources/youtube/mapper.js'
import { resolveSource, type SourceMode } from './sources/factory.js'
import { readLedger } from './sources/youtube/quota.js'
import { QuotaExhaustedError } from './sources/youtube/client.js'
import { loadPreferenceContext } from './preference.js'

/**
 * Ingestion: fetch metadata, store it, embed it, and drop what has expired.
 *
 * This runs in the dashboard page rather than the background service worker. Embedding a
 * batch takes far longer than the idle timeout an MV3 service worker is allowed, and
 * WebGPU is not available to it; the background worker only schedules and nudges.
 */

const LAST_RUN_KEY = 'ingest.lastRunAt'
const EMBED_BATCH_SIZE = 16
/** How far back the first run looks when there is no previous run to continue from. */
const INITIAL_LOOKBACK_DAYS = 30
const MAX_PER_CHANNEL = 10

export interface IngestReport {
  mode: SourceMode
  reason?: string
  startedAt: string
  finishedAt: string
  channelCount: number
  fetchedItems: number
  newItems: number
  embedded: number
  purgedItems: number
  errors: string[]
  quota: { units: number; search: number }
}

export interface IngestOptions {
  engine: InferenceEngine
  now?: () => string
  adapter?: SourceAdapter
  mode?: SourceMode
  onProgress?: (message: string) => void
}

export async function runIngestion(options: IngestOptions): Promise<IngestReport> {
  const now = options.now ?? (() => new Date().toISOString())
  const startedAt = now()
  const errors: string[] = []
  const report = (message: string) => options.onProgress?.(message)

  let adapter = options.adapter
  let mode: SourceMode = options.mode ?? 'fixture'
  let reason: string | undefined
  if (!adapter) {
    const resolved = await resolveSource(now)
    adapter = resolved.adapter
    mode = resolved.mode
    reason = resolved.reason
  }

  const purgedItems = await purgeExpired(startedAt)
  if (purgedItems > 0) report(`Dropped ${purgedItems} expired items`)

  const publishedAfter = await resolvePublishedAfter(startedAt)
  let channelIds: string[] = []
  let fetched: CatalogItem[] = []

  try {
    report('Reading subscriptions')
    channelIds = await adapter.listSubscribedChannelIds()
    // Recorded in settings so the ranker knows which channels are followed without
    // depending on adapter-specific tables.
    await updateAppSettings({ subscribedChannelIds: channelIds })
    report(`Fetching new uploads from ${channelIds.length} channels`)
    fetched = await adapter.listSubscriptionUpdates({
      publishedAfter,
      maxPerChannel: MAX_PER_CHANNEL,
      channelIds,
    })
  } catch (error) {
    errors.push(describeError(error))
  }

  const newItems = await storeItems(fetched)
  report(`Stored ${fetched.length} items (${newItems} new)`)

  let embedded = 0
  try {
    embedded = await embedMissing(options.engine, report)
  } catch (error) {
    errors.push(describeError(error))
  }

  await setSetting(LAST_RUN_KEY, startedAt)
  const ledger = await readLedger(new Date(Date.parse(startedAt)))

  return {
    mode,
    ...(reason ? { reason } : {}),
    startedAt,
    finishedAt: now(),
    channelCount: channelIds.length,
    fetchedItems: fetched.length,
    newItems,
    embedded,
    purgedItems,
    errors,
    quota: { units: ledger.units, search: ledger.search },
  }
}

/** Interests searched per discovery run, and queries built from each (design section 6.1). */
const MAX_DISCOVERY_CLUSTERS = 10
const QUERIES_PER_CLUSTER = 3
const RESULTS_PER_QUERY = 25

export interface DiscoveryReport {
  queries: string[]
  fetchedItems: number
  newItems: number
  embedded: number
  /** True when the daily search budget ran out before every query was issued. */
  stoppedEarly: boolean
  errors: string[]
}

/**
 * Looks for videos outside the subscription lane, using the user's own interests as
 * queries.
 *
 * The queries are built here, on this machine, and go straight to YouTube. Routing them
 * through a server would hand over exactly the information this design keeps local, and
 * YouTube already knows what its own user searches for (design section 1.1).
 */
export async function runDiscovery(options: IngestOptions): Promise<DiscoveryReport> {
  const now = options.now ?? (() => new Date().toISOString())
  const report = (message: string) => options.onProgress?.(message)
  const errors: string[] = []

  let adapter = options.adapter
  if (!adapter) adapter = (await resolveSource(now)).adapter

  const { state } = await loadPreferenceContext({ now: now() })
  const active = state.clusters
    .filter((cluster) => cluster.activity > 0)
    .sort((a, b) => b.activity - a.activity)
    .slice(0, MAX_DISCOVERY_CLUSTERS)

  const queries = [...new Set(active.flatMap(queriesForLabel))]
  const collected: CatalogItem[] = []
  let stoppedEarly = false

  for (const query of queries) {
    try {
      report(`Searching: ${query}`)
      collected.push(...(await adapter.search(query, { maxResults: RESULTS_PER_QUERY })))
    } catch (error) {
      // A spent budget is an expected outcome, not a failure: the subscription lane does
      // not use search at all, so the feed still works.
      if (error instanceof QuotaExhaustedError) {
        stoppedEarly = true
        report('Daily search budget spent; stopping discovery here.')
        break
      }
      errors.push(describeError(error))
    }
  }

  const newItems = await storeItems(collected)
  const embedded = await embedMissing(options.engine, report)

  return { queries, fetchedItems: collected.length, newItems, embedded, stoppedEarly, errors }
}

function queriesForLabel(cluster: { label: string }): string[] {
  const terms = cluster.label
    .split('·')
    .map((term) => term.trim())
    .filter(Boolean)
  if (terms.length === 0) return []
  // The full label finds the topic; the individual terms reach the edges of it.
  return [terms.join(' '), ...terms.slice(0, QUERIES_PER_CLUSTER - 1)].slice(0, QUERIES_PER_CLUSTER)
}

/** Upserts catalog items, returning how many of them were previously unknown. */
export async function storeItems(items: CatalogItem[]): Promise<number> {
  if (items.length === 0) return 0
  const db = getDb()
  const keys = items.map(primaryKeyOf)
  const existing = await db.items.bulkGet(keys)
  const newCount = existing.filter((row) => row === undefined).length
  await db.items.bulkPut(items)
  return newCount
}

/**
 * Embeds every stored item that has no vector for the engine's current model.
 *
 * Keying on model id is what makes a model swap a re-computation rather than a data loss:
 * the ratings stay untouched and only the derived vectors are rebuilt (design section 2.1).
 */
export async function embedMissing(
  engine: InferenceEngine,
  report: (message: string) => void = () => {},
): Promise<number> {
  const db = getDb()
  const items = await db.items.toArray()
  const existing = await db.embeddings.toArray()
  const haveCurrentModel = new Set(
    existing.filter((row) => row.modelId === engine.modelId).map((row) => itemKey(row)),
  )

  const pending = items.filter((item) => !haveCurrentModel.has(itemKey(item)))
  if (pending.length === 0) return 0

  let embedded = 0
  for (let offset = 0; offset < pending.length; offset += EMBED_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + EMBED_BATCH_SIZE)
    const vectors = await engine.embedPassage(batch.map(embeddingTextFor))
    const generatedAt = new Date().toISOString()
    await db.embeddings.bulkPut(
      batch.map((item, index) => ({
        source: item.source,
        externalId: item.externalId,
        modelId: engine.modelId,
        generatedAt,
        vector: vectors[index],
      })),
    )
    embedded += batch.length
    report(`Embedded ${embedded}/${pending.length}`)
  }
  return embedded
}

/**
 * Deletes catalog metadata past its TTL along with the vectors derived from it
 * (design section 6.2). Ratings are ours and are never touched here.
 */
export async function purgeExpired(now: string): Promise<number> {
  const db = getDb()
  const expired = await db.items.where('expiresAt').belowOrEqual(now).toArray()
  if (expired.length === 0) return 0
  const keys = expired.map(primaryKeyOf)
  await db.items.bulkDelete(keys)
  await db.embeddings.bulkDelete(keys)
  return expired.length
}

async function resolvePublishedAfter(now: string): Promise<string> {
  const lastRun = await getSetting<string | null>(LAST_RUN_KEY, null)
  if (lastRun) return lastRun
  return new Date(Date.parse(now) - INITIAL_LOOKBACK_DAYS * 86_400_000).toISOString()
}

export async function getLastRunAt(): Promise<string | null> {
  return getSetting<string | null>(LAST_RUN_KEY, null)
}

export interface StoreStatus {
  items: number
  embeddings: number
  events: number
  ratings: number
  clusters: number
  channels: number
  lastRunAt: string | null
}

export async function getStoreStatus(): Promise<StoreStatus> {
  const db = getDb()
  const [items, embeddings, events, ratings, clusters, channels, lastRunAt] = await Promise.all([
    db.items.count(),
    db.embeddings.count(),
    db.events.count(),
    db.ratings.count(),
    db.clusters.count(),
    db.channels.count(),
    getLastRunAt(),
  ])
  return { items, embeddings, events, ratings, clusters, channels, lastRunAt }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
