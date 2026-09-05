import type { EpochMillis, Lane, RatingEvent, RatingValue } from '@ypr/domain'
import { IMPRESSION_WINDOW_MS } from '@ypr/domain'

/**
 * Rating events (design sections 10 and 11).
 *
 * There is no update statement in this file, and that is the point. Re-rating appends;
 * retracting sets `disabled_at` on the row being retracted and leaves the rating
 * itself intact. "What do I think of this now" is a query over the log, not a column.
 */

interface RatingRow {
  id: string
  profile_id: string
  video_id: string
  rating: number
  created_at: number
  disabled_at: number | null
}

function toRatingEvent(row: RatingRow): RatingEvent {
  return {
    id: row.id,
    profileId: row.profile_id,
    videoId: row.video_id,
    rating: row.rating as RatingValue,
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
  }
}

export async function appendRating(
  db: D1Database,
  event: Omit<RatingEvent, 'disabledAt'>,
): Promise<RatingEvent> {
  await db
    .prepare(
      `INSERT INTO rating_events (id, profile_id, video_id, rating, created_at, disabled_at)
       VALUES (?1, ?2, ?3, ?4, ?5, NULL)`,
    )
    .bind(event.id, event.profileId, event.videoId, event.rating, event.createdAt)
    .run()
  return { ...event, disabledAt: null }
}

/** Retract one event without erasing it. */
export async function disableRating(
  db: D1Database,
  profileId: string,
  eventId: string,
  now: EpochMillis,
): Promise<void> {
  await db
    .prepare(
      `UPDATE rating_events SET disabled_at = ?3
       WHERE id = ?2 AND profile_id = ?1 AND disabled_at IS NULL`,
    )
    .bind(profileId, eventId, now)
    .run()
}

/**
 * The current rating for each video: the newest event that has not been retracted.
 *
 * Written as a correlated max rather than a window function because D1's SQLite build
 * handles this shape well and the result set is one row per rated video, which for a
 * personal system stays in the thousands.
 */
export async function currentRatings(
  db: D1Database,
  profileId: string,
): Promise<Map<string, RatingValue>> {
  const { results } = await db
    .prepare(
      `SELECT r.video_id AS video_id, r.rating AS rating
       FROM rating_events r
       WHERE r.profile_id = ?1
         AND r.disabled_at IS NULL
         AND r.created_at = (
           SELECT MAX(r2.created_at) FROM rating_events r2
           WHERE r2.profile_id = r.profile_id AND r2.video_id = r.video_id AND r2.disabled_at IS NULL
         )`,
    )
    .bind(profileId)
    .all<{ video_id: string; rating: number }>()

  const map = new Map<string, RatingValue>()
  for (const row of results ?? []) map.set(row.video_id, row.rating as RatingValue)
  return map
}

export async function currentRatingFor(
  db: D1Database,
  profileId: string,
  videoId: string,
): Promise<RatingValue | null> {
  const row = await db
    .prepare(
      `SELECT rating FROM rating_events
       WHERE profile_id = ?1 AND video_id = ?2 AND disabled_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(profileId, videoId)
    .first<{ rating: number }>()
  return row ? (row.rating as RatingValue) : null
}

export async function listRatingHistory(
  db: D1Database,
  profileId: string,
  videoId: string,
): Promise<RatingEvent[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM rating_events
       WHERE profile_id = ?1 AND video_id = ?2
       ORDER BY created_at DESC`,
    )
    .bind(profileId, videoId)
    .all<RatingRow>()
  return (results ?? []).map(toRatingEvent)
}

/** Every event, oldest first. Used by the export and by the training set builder. */
export async function listAllRatings(
  db: D1Database,
  profileId: string,
  options: { includeDisabled?: boolean } = {},
): Promise<RatingEvent[]> {
  const sql = options.includeDisabled
    ? 'SELECT * FROM rating_events WHERE profile_id = ?1 ORDER BY created_at ASC'
    : 'SELECT * FROM rating_events WHERE profile_id = ?1 AND disabled_at IS NULL ORDER BY created_at ASC'
  const { results } = await db.prepare(sql).bind(profileId).all<RatingRow>()
  return (results ?? []).map(toRatingEvent)
}

export async function countRatingsSince(
  db: D1Database,
  profileId: string,
  since: EpochMillis,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM rating_events
       WHERE profile_id = ?1 AND disabled_at IS NULL AND created_at > ?2`,
    )
    .bind(profileId, since)
    .first<{ count: number }>()
  return row?.count ?? 0
}

// ---------------------------------------------------------------------------
// Impressions
// ---------------------------------------------------------------------------

/**
 * Record that the feed showed these videos.
 *
 * Kept apart from ratings because being shown something and having an opinion about it
 * are different facts; merging them would make an ignored impression indistinguishable
 * from a deliberate zero.
 *
 * Counted at most once per `IMPRESSION_WINDOW_MS`. Without that, opening a video and
 * pressing back counts as a fresh showing of everything that was on screen, and the
 * `seen_penalty` demotes it — so the feed reorders itself as a *consequence of being
 * read*, which is not what design section 33 is asking for. Both columns move together
 * or neither does: advancing `shown_at` on an uncounted view would push the window
 * forward forever and a genuine second look, days later, would never register.
 */
export async function recordImpressions(
  db: D1Database,
  profileId: string,
  entries: Array<{ videoId: string; lane: Lane }>,
  now: EpochMillis,
): Promise<void> {
  if (entries.length === 0) return
  const counts = now - IMPRESSION_WINDOW_MS
  await db.batch(
    entries.map((entry) =>
      db
        .prepare(
          `INSERT INTO impressions (profile_id, video_id, lane, shown_at, shown_count)
           VALUES (?1, ?2, ?3, ?4, 1)
           ON CONFLICT(profile_id, video_id) DO UPDATE SET
             shown_count = impressions.shown_count
               + CASE WHEN impressions.shown_at <= ?5 THEN 1 ELSE 0 END,
             shown_at = CASE WHEN impressions.shown_at <= ?5 THEN excluded.shown_at
                             ELSE impressions.shown_at END,
             lane = excluded.lane`,
        )
        .bind(profileId, entry.videoId, entry.lane, now, counts),
    ),
  )
}

export async function seenCounts(db: D1Database, profileId: string): Promise<Map<string, number>> {
  const { results } = await db
    .prepare('SELECT video_id, shown_count FROM impressions WHERE profile_id = ?1')
    .bind(profileId)
    .all<{ video_id: string; shown_count: number }>()
  const map = new Map<string, number>()
  for (const row of results ?? []) map.set(row.video_id, row.shown_count)
  return map
}
