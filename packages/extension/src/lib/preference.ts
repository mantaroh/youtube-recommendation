import type { CatalogItem, InterestCluster, PreferenceState } from '@ypr/shared'
import { itemKey } from '@ypr/shared'
import { buildPreferenceState } from '@ypr/core'
import { getDb } from './db.js'
import { listEvents } from './events.js'
import { appendEvent } from './events.js'
import { getAppSettings, getSetting, setSetting } from './settings.js'

/**
 * Builds the preference state from what is in the local store.
 *
 * The state is derived, never authoritative: it is thrown away and rebuilt whenever it is
 * needed. The `clusters` table is only a cache so the interest screen can paint before the
 * rebuild finishes.
 */

/** When set, the whole app behaves as it did at this instant (design section 3.6). */
export const AS_OF_KEY = 'preference.asOf'

export interface PreferenceContext {
  state: PreferenceState
  items: Map<string, CatalogItem>
  embeddings: Map<string, Float32Array>
  /** The instant being replayed, when the user has travelled back. */
  asOf: string | null
}

export async function getAsOf(): Promise<string | null> {
  return getSetting<string | null>(AS_OF_KEY, null)
}

export async function setAsOf(instant: string | null): Promise<void> {
  await setSetting(AS_OF_KEY, instant)
}

export async function loadPreferenceContext(
  options: { now?: string; modelId?: string } = {},
): Promise<PreferenceContext> {
  const db = getDb()
  const now = options.now ?? new Date().toISOString()
  const asOf = await getAsOf()
  const settings = await getAppSettings()

  const [events, embeddingRows, items] = await Promise.all([
    listEvents(),
    db.embeddings.toArray(),
    db.items.toArray(),
  ])

  // Vectors from an older model would sit in a different space, so they are ignored
  // rather than mixed in (design section 7.2).
  const modelId = options.modelId ?? dominantModelId(embeddingRows.map((row) => row.modelId))
  const embeddings = new Map<string, Float32Array>()
  let dimensions = 0
  for (const row of embeddingRows) {
    if (row.modelId !== modelId) continue
    embeddings.set(itemKey(row), row.vector)
    dimensions = row.vector.length
  }

  const itemsByKey = new Map(items.map((item) => [itemKey(item), item]))
  const texts = new Map(
    items.map((item) => [itemKey(item), `${item.title} ${item.tags.join(' ')}`]),
  )
  const channels = new Map(items.map((item) => [itemKey(item), item.channelId]))

  const state = buildPreferenceState({
    events,
    embeddings,
    texts,
    channels,
    now: asOf ?? now,
    modelId: modelId ?? 'none',
    dimensions: dimensions || 384,
    tau: settings.tau,
    kMax: settings.kMax,
    ...(asOf ? { upToTs: asOf } : {}),
  })

  // Only cache the present. A replayed past state is a view, not the current truth.
  if (!asOf) await cacheClusters(state.clusters)

  return { state, items: itemsByKey, embeddings, asOf }
}

async function cacheClusters(clusters: InterestCluster[]): Promise<void> {
  const db = getDb()
  await db.transaction('rw', db.clusters, async () => {
    await db.clusters.clear()
    await db.clusters.bulkPut(clusters)
  })
}

/** The model most vectors were produced with; a mixed store settles on the majority. */
function dominantModelId(modelIds: string[]): string | undefined {
  const counts = new Map<string, number>()
  for (const modelId of modelIds) counts.set(modelId, (counts.get(modelId) ?? 0) + 1)
  let best: string | undefined
  let bestCount = 0
  for (const [modelId, count] of counts) {
    if (count > bestCount) {
      best = modelId
      bestCount = count
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Interest edits. Each one is an event, so every edit is replayable and reversible.
// ---------------------------------------------------------------------------

export async function pinInterest(clusterId: string, pinned: boolean): Promise<void> {
  await appendEvent({
    type: 'interest_override',
    ts: new Date().toISOString(),
    clusterId,
    op: pinned ? 'pin' : 'unpin',
  })
}

export async function muteInterest(clusterId: string, days: number | null): Promise<void> {
  const now = new Date()
  await appendEvent({
    type: 'interest_override',
    ts: now.toISOString(),
    clusterId,
    ...(days === null
      ? { op: 'unmute' as const }
      : {
          op: 'mute' as const,
          untilTs: new Date(now.getTime() + days * 86_400_000).toISOString(),
        }),
  })
}

export async function forgetInterest(clusterId: string, forgotten: boolean): Promise<void> {
  await appendEvent({
    type: 'interest_override',
    ts: new Date().toISOString(),
    clusterId,
    op: forgotten ? 'forget' : 'restore',
  })
}

export async function setInterestStrength(clusterId: string, value: number): Promise<void> {
  await appendEvent({
    type: 'interest_override',
    ts: new Date().toISOString(),
    clusterId,
    op: 'set_strength',
    value: Math.min(1, Math.max(0, value)),
  })
}

export async function renameInterest(clusterId: string, label: string): Promise<void> {
  await appendEvent({
    type: 'interest_override',
    ts: new Date().toISOString(),
    clusterId,
    op: 'rename',
    label,
  })
}
