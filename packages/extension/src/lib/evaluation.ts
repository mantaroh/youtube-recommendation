import type { CatalogItem, RatingValue } from '@ypr/shared'
import { itemKey, parseItemKey } from '@ypr/shared'
import {
  compareArms,
  computeArmMetrics,
  metricsToCsv,
  type ArmMetrics,
  type ComparisonRow,
} from '@ypr/core'
import { getDb, type TrialRow } from './db.js'
import { ratingsByKey } from './events.js'
import { loadSubscribedChannelIds } from './feed.js'

/**
 * The comparison experiment (design section 9).
 *
 * Two lists are recorded each day — this recommender's and YouTube's own — and rated
 * afterwards without showing which produced which. Rating them with the source visible
 * would measure the expectation rather than the recommendation.
 */

export type Arm = 'own' | 'youtube'

/** JST day, matching the timezone used everywhere else in this project. */
export function jstDay(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo' }).format(now)
}

export async function recordTrial(
  arm: Arm,
  itemKeys: string[],
  now: Date = new Date(),
): Promise<TrialRow | undefined> {
  if (itemKeys.length === 0) return undefined
  const date = jstDay(now)
  const row: TrialRow = {
    id: `${date}:${arm}`,
    date,
    arm,
    itemKeys,
    recordedAt: now.toISOString(),
  }
  // One list per arm per day: re-recording would let a bad day be quietly retried.
  const existing = await getDb().trials.get(row.id)
  if (existing) return existing
  await getDb().trials.add(row)
  return row
}

export async function listTrials(): Promise<TrialRow[]> {
  return getDb().trials.orderBy('date').reverse().toArray()
}

export async function deleteTrial(id: string): Promise<void> {
  await getDb().trials.delete(id)
}

export interface EvaluationReport {
  metrics: ArmMetrics[]
  comparison: ComparisonRow[]
  trials: TrialRow[]
  /** Items in a trial whose metadata is not in the local store yet. */
  missingKeys: string[]
  /** Trial items still waiting for a rating, in an order that hides which arm they came from. */
  pending: CatalogItem[]
  csv: string
}

export async function buildEvaluationReport(): Promise<EvaluationReport> {
  const db = getDb()
  const [trials, ratings, subscribed] = await Promise.all([
    listTrials(),
    ratingsByKey(),
    loadSubscribedChannelIds(),
  ])

  const allKeys = [...new Set(trials.flatMap((trial) => trial.itemKeys))]
  const rows = await db.items.bulkGet(allKeys.map((key) => keyToPrimary(key)))
  const items = new Map<string, CatalogItem>()
  const missingKeys: string[] = []
  allKeys.forEach((key, index) => {
    const row = rows[index]
    if (row) items.set(key, row)
    else missingKeys.push(key)
  })

  const metrics = (['own', 'youtube'] as const).map((arm) => {
    const keys = trials.filter((trial) => trial.arm === arm).flatMap((trial) => trial.itemKeys)
    const known = keys.map((key) => items.get(key)).filter((item): item is CatalogItem => Boolean(item))
    const rated = keys
      .map((key) => ratings.get(key))
      .filter((rating): rating is RatingValue => rating !== undefined)

    return computeArmMetrics({
      arm,
      ratings: rated,
      categories: known.map((item) => item.officialCategoryId),
      channelIds: known.map((item) => item.channelId),
      subscribedChannelIds: subscribed,
      shown: keys.length,
    })
  })

  const pendingKeys = allKeys.filter((key) => items.has(key) && !ratings.has(key))

  return {
    metrics,
    comparison: compareArms(metrics[0], metrics[1]),
    trials,
    missingKeys,
    pending: shuffleStable(pendingKeys).map((key) => items.get(key)!),
    csv: metricsToCsv(metrics),
  }
}

/**
 * A fixed shuffle derived from the key itself.
 *
 * Ordering by anything the arms differ in — insertion order, date, id prefix — would let
 * the rater infer the source, which is exactly what the blind rating step is there to
 * prevent. Deriving it from the key keeps the order stable across reloads so the list
 * does not jump around while it is being worked through.
 */
export function shuffleStable(keys: string[]): string[] {
  return [...keys].sort((a, b) => hash(a) - hash(b) || a.localeCompare(b))
}

function hash(text: string): number {
  let value = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value >>> 0
}

function keyToPrimary(key: string): [string, string] {
  const ref = parseItemKey(key)
  return [ref.source, ref.externalId]
}

export function keysForVideoIds(videoIds: string[]): string[] {
  return videoIds.map((videoId) => itemKey({ source: 'youtube', externalId: videoId }))
}
