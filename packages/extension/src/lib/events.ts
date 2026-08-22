import type { AppEvent, ItemRef, Lane, NewEvent, RatingValue } from '@ypr/shared'
import { itemKey, newEventSchema } from '@ypr/shared'
import { getDb } from './db.js'

/**
 * Append-only event log (design section 2.1).
 *
 * Every write goes through `appendEvent`, which validates first. Nothing in the codebase
 * updates or deletes an event: "forget this interest" adds a tombstone rather than
 * removing history, which is what keeps time travel (design section 3.6) honest.
 */

export async function appendEvent(event: NewEvent): Promise<AppEvent> {
  const validated = newEventSchema.parse(event) as NewEvent
  const db = getDb()

  return db.transaction('rw', db.events, db.ratings, async () => {
    const seq = await db.events.add(validated)
    const stored = { ...validated, seq } as AppEvent

    // Keep the derived rating projection in step within the same transaction.
    if (stored.type === 'rating') {
      await db.ratings.put({
        source: stored.source,
        externalId: stored.externalId,
        rating: stored.rating,
        ratedAt: stored.ts,
      })
    }
    return stored
  })
}

/** Every event, in sequence order. Optionally truncated for a time-travel rebuild. */
export async function listEvents(options: { upToSeq?: number; upToTs?: string } = {}): Promise<AppEvent[]> {
  const db = getDb()
  let events = await db.events.orderBy('seq').toArray()
  if (options.upToSeq !== undefined) {
    events = events.filter((event) => event.seq <= options.upToSeq!)
  }
  if (options.upToTs !== undefined) {
    const cutoff = Date.parse(options.upToTs)
    events = events.filter((event) => Date.parse(event.ts) <= cutoff)
  }
  return events
}

export async function countEvents(): Promise<number> {
  return getDb().events.count()
}

/**
 * Record how much the user wants to see more of this kind of video (design section 5.1).
 * `0` is a real rating meaning "no more of this"; *unrated* is the absence of any event.
 */
export async function rateItem(ref: ItemRef, rating: RatingValue, now: string): Promise<AppEvent> {
  return appendEvent({
    type: 'rating',
    ts: now,
    source: ref.source,
    externalId: ref.externalId,
    rating,
  })
}

export async function recordWatch(
  ref: ItemRef,
  watchedSeconds: number,
  durationSeconds: number,
  now: string,
): Promise<AppEvent> {
  return appendEvent({
    type: 'watch',
    ts: now,
    source: ref.source,
    externalId: ref.externalId,
    watchedSeconds,
    durationSeconds,
  })
}

/** What the feed showed, so the choices can be evaluated offline later. */
export async function recordImpressions(
  entries: Array<{ ref: ItemRef; lane: Lane; position: number }>,
  now: string,
): Promise<void> {
  for (const entry of entries) {
    await appendEvent({
      type: 'impression',
      ts: now,
      source: entry.ref.source,
      externalId: entry.ref.externalId,
      lane: entry.lane,
      position: entry.position,
    })
  }
}

export async function currentRating(ref: ItemRef): Promise<RatingValue | undefined> {
  const row = await getDb().ratings.get([ref.source, ref.externalId])
  return row?.rating
}

export async function ratingsByKey(): Promise<Map<string, RatingValue>> {
  const rows = await getDb().ratings.toArray()
  return new Map(rows.map((row) => [itemKey(row), row.rating]))
}
