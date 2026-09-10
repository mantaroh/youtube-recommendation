import type { Channel, EpochMillis, Source, SourceChannel, SourceItem, Video, VideoMetadata } from '@ypr/domain'
import { itemKey } from '@ypr/domain'

/**
 * Channel and video rows.
 *
 * Ingestion is written as upserts keyed on `source:external_id` so that the same video
 * arriving from the subscription pass and from a search stores once. `discovered_at`
 * is preserved on conflict: when a video first became visible to this system is a fact
 * about the system, and refreshing its view count should not rewrite it.
 */

export interface IngestResult {
  channels: number
  videos: number
}

/**
 * The channel as a catalog fact: who it is, not who follows it.
 *
 * Following is a property of one YouTube account and lives in `profile_subscriptions`
 * (migration 0008). Keeping it out of here is what stops a search result — which says
 * nothing about whether anyone follows the channel it mentions — from being able to
 * change a subscription.
 */
export async function upsertChannels(
  db: D1Database,
  source: Source,
  channels: SourceChannel[],
): Promise<number> {
  if (channels.length === 0) return 0

  const statements = channels.map((channel) => {
    const id = itemKey({ source, externalId: channel.externalId })
    return db
      .prepare(
        // `last_fetched_at` is left null: it means "this channel's uploads have been
        // read", and knowing the channel exists is not that. Writing `now` here made a
        // newly subscribed channel indistinguishable from one just walked, and the
        // refresh goes least-recently-fetched first — so two hundred channels added by
        // a second account sorted behind every channel of the first and their uploads
        // were never fetched at all.
        `INSERT INTO channels (id, source, external_id, title, thumbnail_url, last_fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL)
         ON CONFLICT(id) DO UPDATE SET
           title = COALESCE(excluded.title, channels.title),
           thumbnail_url = COALESCE(excluded.thumbnail_url, channels.thumbnail_url)`,
      )
      .bind(id, source, channel.externalId, channel.title, channel.thumbnailUrl)
  })

  await db.batch(statements)
  return channels.length
}

export interface UpsertVideoOptions {
  now: EpochMillis
  /**
   * Whose discovery found these. The row itself is shared — the catalog holds one copy
   * of a video however many profiles reach it — but being *in* the catalog is not the
   * same as being a candidate for a profile's feed (migration 0010).
   *
   * Null for work that repairs the catalog rather than discovering anything: re-reading
   * a video already stored to fill in a column tells us nothing new about whose feed it
   * belongs in, and writing a candidacy there would quietly hand every mended row to
   * whichever profile happened to run the repair.
   */
  profileId: string | null
  /** Recorded in metadata so quota spend can be attributed to a lane afterwards. */
  discoveredBy?: VideoMetadata['discoveredBy']
  discoveryQuery?: string
}

/**
 * Marks videos as candidates for one profile.
 *
 * Separate from the video upsert so that a video already in the catalog, reached by a
 * second profile, becomes a candidate for it without rewriting the row.
 */
export async function addCandidates(
  db: D1Database,
  profileId: string,
  videoIds: string[],
  now: EpochMillis,
): Promise<void> {
  if (videoIds.length === 0) return
  // Statements per batch, not parameters per statement: each of these binds three, so
  // the hundred-parameter ceiling is nowhere near.
  const CHUNK = 100
  for (let offset = 0; offset < videoIds.length; offset += CHUNK) {
    await db.batch(
      videoIds.slice(offset, offset + CHUNK).map((id) =>
        db
          .prepare(
            `INSERT INTO profile_candidates (profile_id, video_id, discovered_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(profile_id, video_id) DO NOTHING`,
          )
          .bind(profileId, id, now),
      ),
    )
  }
}

export async function upsertVideos(
  db: D1Database,
  source: Source,
  items: SourceItem[],
  options: UpsertVideoOptions,
): Promise<number> {
  if (items.length === 0) return 0

  // The same video can arrive twice in one batch when two searches overlap. D1 runs a
  // batch as one transaction, and two conflicting upserts of the same key inside it
  // are wasted work, so collapse them first.
  const unique = new Map<string, SourceItem>()
  for (const item of items) unique.set(item.externalId, item)

  const statements = [...unique.values()].map((item) => {
    const metadata: VideoMetadata = {
      tags: item.tags,
      channelTitle: item.channelTitle,
      ...(item.officialCategoryId ? { officialCategoryId: item.officialCategoryId } : {}),
      ...(options.discoveredBy ? { discoveredBy: options.discoveredBy } : {}),
      ...(options.discoveryQuery ? { discoveryQuery: options.discoveryQuery } : {}),
    }
    return db
      .prepare(
        `INSERT INTO videos (
           id, source, external_id, channel_id, title, description, thumbnail_url,
           published_at, duration_seconds, view_count, metadata_json, discovered_at, refreshed_at
         )
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
         ON CONFLICT(id) DO UPDATE SET
           channel_id = COALESCE(excluded.channel_id, videos.channel_id),
           title = excluded.title,
           description = excluded.description,
           thumbnail_url = COALESCE(excluded.thumbnail_url, videos.thumbnail_url),
           published_at = COALESCE(excluded.published_at, videos.published_at),
           duration_seconds = COALESCE(excluded.duration_seconds, videos.duration_seconds),
           view_count = COALESCE(excluded.view_count, videos.view_count),
           metadata_json = excluded.metadata_json,
           refreshed_at = excluded.refreshed_at`,
      )
      .bind(
        itemKey({ source, externalId: item.externalId }),
        source,
        item.externalId,
        item.channelExternalId ? itemKey({ source, externalId: item.channelExternalId }) : null,
        item.title,
        item.description,
        item.thumbnailUrl,
        item.publishedAt ? Date.parse(item.publishedAt) : null,
        item.durationSeconds,
        item.viewCount,
        JSON.stringify(metadata),
        options.now,
      )
  })

  await db.batch(statements)

  // Written after the rows exist, because the candidacy has a foreign key to them.
  if (options.profileId !== null) {
    await addCandidates(
      db,
      options.profileId,
      [...unique.keys()].map((externalId) => itemKey({ source, externalId })),
      options.now,
    )
  }

  return unique.size
}

/**
 * Channels that would be recorded by an upsert but are not yet rows.
 *
 * Videos carry a foreign key to `channels`, so a search result from an unknown channel
 * has to create the channel first. It is created unsubscribed, because appearing in a
 * search result says nothing about whether the user follows it.
 */
export function channelsFromItems(items: SourceItem[]): SourceChannel[] {
  const byId = new Map<string, SourceChannel>()
  for (const item of items) {
    if (!item.channelExternalId) continue
    byId.set(item.channelExternalId, {
      externalId: item.channelExternalId,
      title: item.channelTitle,
      thumbnailUrl: null,
    })
  }
  return [...byId.values()]
}

export interface VideoRow {
  id: string
  source: string
  external_id: string
  channel_id: string | null
  title: string
  description: string | null
  thumbnail_url: string | null
  published_at: number | null
  duration_seconds: number | null
  view_count: number | null
  metadata_json: string | null
  discovered_at: number
  refreshed_at: number | null
}

export function toVideo(row: VideoRow): Video {
  return {
    id: row.id,
    source: row.source as Source,
    externalId: row.external_id,
    channelId: row.channel_id,
    title: row.title,
    description: row.description,
    thumbnailUrl: row.thumbnail_url,
    publishedAt: row.published_at,
    durationSeconds: row.duration_seconds,
    viewCount: row.view_count,
    metadata: parseMetadata(row.metadata_json),
    discoveredAt: row.discovered_at,
    refreshedAt: row.refreshed_at,
  }
}

function parseMetadata(json: string | null): VideoMetadata {
  if (!json) return {}
  try {
    return JSON.parse(json) as VideoMetadata
  } catch {
    // A row whose metadata cannot be parsed is still a usable video; the fields in
    // this column are all optional by construction.
    return {}
  }
}

export interface ChannelRow {
  id: string
  source: string
  external_id: string
  title: string | null
  thumbnail_url: string | null
  /**
   * Not a column any more (migration 0008). Every query that reports it joins
   * `profile_subscriptions` for one profile, so it always means "does *this* profile
   * follow it" rather than "does anyone".
   */
  subscribed: number
  last_fetched_at: number | null
}

export function toChannel(row: ChannelRow): Channel {
  return {
    id: row.id,
    source: row.source as Source,
    externalId: row.external_id,
    title: row.title,
    thumbnailUrl: row.thumbnail_url,
    subscribed: row.subscribed === 1,
    lastFetchedAt: row.last_fetched_at,
  }
}

export async function getVideo(db: D1Database, id: string): Promise<Video | null> {
  const row = await db.prepare('SELECT * FROM videos WHERE id = ?1').bind(id).first<VideoRow>()
  return row ? toVideo(row) : null
}

/**
 * Channels, with `subscribed` meaning "this profile follows it".
 *
 * `profileId` is required rather than optional. It was optional-by-omission before —
 * the flag was global — and that is exactly how one account's subscription list came to
 * be shown on another's feed.
 */
export async function listChannels(
  db: D1Database,
  profileId: string,
  options: { subscribedOnly?: boolean } = {},
): Promise<Channel[]> {
  const sql = options.subscribedOnly
    ? `SELECT c.*, 1 AS subscribed
         FROM channels c
         JOIN profile_subscriptions s ON s.channel_id = c.id AND s.profile_id = ?1
        ORDER BY c.title`
    : `SELECT c.*, CASE WHEN s.channel_id IS NULL THEN 0 ELSE 1 END AS subscribed
         FROM channels c
         LEFT JOIN profile_subscriptions s ON s.channel_id = c.id AND s.profile_id = ?1
        ORDER BY subscribed DESC, c.title`
  const { results } = await db.prepare(sql).bind(profileId).all<ChannelRow>()
  return (results ?? []).map(toChannel)
}

/**
 * Subscribed channels in staleness order.
 *
 * The refresh cron walks a fixed number of channels per run rather than all of them,
 * so the order decides which ones fall behind. Least-recently-fetched first means the
 * lag is spread evenly instead of concentrating on whichever channels sort last.
 */
export async function listChannelsToRefresh(db: D1Database, limit: number): Promise<Channel[]> {
  // Anyone's subscription, not one profile's. The videos this fetches go into the
  // shared catalog, so walking a channel once serves every profile that follows it —
  // and walking it per profile would spend the same quota several times over.
  const { results } = await db
    .prepare(
      `SELECT c.*, 1 AS subscribed
         FROM channels c
        WHERE EXISTS (SELECT 1 FROM profile_subscriptions s WHERE s.channel_id = c.id)
        ORDER BY COALESCE(c.last_fetched_at, 0) ASC
        LIMIT ?1`,
    )
    .bind(Math.max(1, limit))
    .all<ChannelRow>()
  return (results ?? []).map(toChannel)
}

export async function markChannelsFetched(
  db: D1Database,
  channelIds: string[],
  now: EpochMillis,
): Promise<void> {
  if (channelIds.length === 0) return
  await db.batch(
    channelIds.map((id) =>
      db.prepare('UPDATE channels SET last_fetched_at = ?2 WHERE id = ?1').bind(id, now),
    ),
  )
}

export async function setSubscribed(
  db: D1Database,
  profileId: string,
  channelIds: string[],
  now: EpochMillis,
): Promise<void> {
  // Replaced wholesale rather than merged: unsubscribing on YouTube has to be able to
  // reach this system, and a merge could never express a removal.
  //
  // Scoped to the profile, which is the whole point. The delete used to clear every row
  // in the table, so syncing a second account would have emptied the first one's list
  // on its way to writing its own.
  await db.batch([
    db.prepare('DELETE FROM profile_subscriptions WHERE profile_id = ?1').bind(profileId),
    ...subscribeStatements(db, profileId, channelIds, now),
  ])
}

/** Adds to a profile's subscriptions without disturbing what is already there. */
export async function addSubscriptions(
  db: D1Database,
  profileId: string,
  channelIds: string[],
  now: EpochMillis,
): Promise<void> {
  if (channelIds.length === 0) return
  await db.batch(subscribeStatements(db, profileId, channelIds, now))
}

function subscribeStatements(
  db: D1Database,
  profileId: string,
  channelIds: string[],
  now: EpochMillis,
): D1PreparedStatement[] {
  return channelIds.map((id) =>
    db
      .prepare(
        `INSERT INTO profile_subscriptions (profile_id, channel_id, subscribed_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(profile_id, channel_id) DO NOTHING`,
      )
      .bind(profileId, id, now),
  )
}

export async function countVideos(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM videos').first<{ count: number }>()
  return row?.count ?? 0
}

// ---------------------------------------------------------------------------
// Candidate loading
// ---------------------------------------------------------------------------

export interface VideoWithChannel {
  video: Video
  channel: Channel | null
}

interface JoinedRow extends VideoRow {
  c_id: string | null
  c_source: string | null
  c_external_id: string | null
  c_title: string | null
  c_thumbnail_url: string | null
  c_subscribed: number | null
  c_last_fetched_at: number | null
}

/**
 * The profile is `?1`, bound first by every caller of this fragment.
 *
 * The subscription bonus in the ranking reads `channel.subscribed`, so binding the
 * wrong profile here does not fail — it quietly ranks one account's feed by another
 * account's subscriptions.
 */
const JOIN_SELECT = `
  SELECT v.*,
         c.id AS c_id, c.source AS c_source, c.external_id AS c_external_id,
         c.title AS c_title, c.thumbnail_url AS c_thumbnail_url,
         CASE WHEN s.channel_id IS NULL THEN 0 ELSE 1 END AS c_subscribed,
         c.last_fetched_at AS c_last_fetched_at
  FROM videos v
  LEFT JOIN channels c ON c.id = v.channel_id
  LEFT JOIN profile_subscriptions s ON s.channel_id = c.id AND s.profile_id = ?1`

function toJoined(row: JoinedRow): VideoWithChannel {
  const video = toVideo(row)
  const channel = row.c_id
    ? toChannel({
        id: row.c_id,
        source: row.c_source ?? video.source,
        external_id: row.c_external_id ?? '',
        title: row.c_title,
        thumbnail_url: row.c_thumbnail_url,
        subscribed: row.c_subscribed ?? 0,
        last_fetched_at: row.c_last_fetched_at,
      })
    : null
  return { video, channel }
}

/**
 * Videos by id, with their channel.
 *
 * Chunked because SQLite caps bound parameters, and a rescore covers up to two
 * thousand ids (design section 32) — well past that ceiling.
 */
export async function loadVideosWithChannels(
  db: D1Database,
  profileId: string,
  ids: string[],
): Promise<VideoWithChannel[]> {
  // D1 numbers bound parameters `?1` to `?100` and refuses `?101`. The profile the join
  // needs takes the first, so ninety-nine ids fit, not a hundred.
  //
  // It was a hundred, from before the profile was bound at all, and adding it made every
  // full chunk one over. A scoring batch is exactly a hundred videos, so this was not an
  // edge case: it broke every score_batch claim with a 500 and cost a night's work
  // before anyone saw it.
  const CHUNK = 99
  const loaded: VideoWithChannel[] = []
  for (let offset = 0; offset < ids.length; offset += CHUNK) {
    const chunk = ids.slice(offset, offset + CHUNK)
    // `?1` is the profile the join needs, so the ids start at `?2`.
    const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ')
    const { results } = await db
      .prepare(`${JOIN_SELECT} WHERE v.id IN (${placeholders})`)
      .bind(profileId, ...chunk)
      .all<JoinedRow>()
    for (const row of results ?? []) loaded.push(toJoined(row))
  }
  return loaded
}

export interface CandidateQuery {
  /** Whose subscriptions decide the `subscribed` lane, and the ranking bonus. */
  profileId: string
  /** Only videos published (or, failing that, discovered) at or after this instant. */
  publishedAfter: EpochMillis
  limit: number
  /** Restrict to channels this profile follows, or exclude them. */
  subscribed?: boolean
  /** Videos this profile has already rated, which the feed does not need to offer again. */
  excludeRatedBy?: string
}

/**
 * The candidate pool for one lane.
 *
 * Rated videos are excluded at the query rather than filtered afterwards: a profile
 * with a thousand ratings would otherwise load a thousand rows on every feed build
 * only to drop them.
 */
export async function listCandidates(
  db: D1Database,
  query: CandidateQuery,
): Promise<VideoWithChannel[]> {
  // The profile is `?1` because `JOIN_SELECT` needs it there.
  const bindings: unknown[] = [query.profileId, query.publishedAfter]
  const conditions = [
    'COALESCE(v.published_at, v.discovered_at) >= ?2',
    // Being in the catalog is not being a candidate (migration 0010). The catalog is
    // shared so a video is stored once; the feed is not, so a video another profile's
    // discovery found is not offered here.
    'EXISTS (SELECT 1 FROM profile_candidates pc WHERE pc.video_id = v.id AND pc.profile_id = ?1)',
  ]

  if (query.subscribed !== undefined) {
    // Tested through the join rather than against the projected column: SQLite does not
    // reliably allow a select alias in `WHERE`.
    conditions.push(query.subscribed ? 's.channel_id IS NOT NULL' : 's.channel_id IS NULL')
  }
  if (query.excludeRatedBy) {
    bindings.push(query.excludeRatedBy)
    conditions.push(
      `NOT EXISTS (
         SELECT 1 FROM rating_events r
         WHERE r.video_id = v.id AND r.profile_id = ?${bindings.length} AND r.disabled_at IS NULL
       )`,
    )
  }

  bindings.push(query.limit)
  const { results } = await db
    .prepare(
      `${JOIN_SELECT}
       WHERE ${conditions.join(' AND ')}
       ORDER BY COALESCE(v.published_at, v.discovered_at) DESC
       LIMIT ?${bindings.length}`,
    )
    .bind(...bindings)
    .all<JoinedRow>()

  return (results ?? []).map(toJoined)
}

/**
 * Videos stored without a thumbnail, oldest first.
 *
 * Migration 0002 carried the catalog over from the first version with the column
 * hardcoded to null, and nothing re-reads a video it already has, so those rows had no
 * way to heal. Rows written since do carry one — the count was 1706 against 2188 — which
 * is why this looks for the gap rather than rewriting everything.
 *
 * Oldest first so that repeated runs make progress instead of returning the same page.
 */
export async function videosMissingThumbnails(db: D1Database, limit: number): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT external_id FROM videos
        WHERE thumbnail_url IS NULL
        ORDER BY discovered_at ASC
        LIMIT ?1`,
    )
    .bind(Math.max(1, limit))
    .all<{ external_id: string }>()
  return (results ?? []).map((row) => row.external_id)
}

/**
 * Records videos as candidates for whoever subscribes to the channel they came from.
 *
 * The upload walk reads the union of every profile's subscriptions, so that a channel
 * two profiles follow costs one fetch instead of two. What it must not do is hand the
 * result to whichever profile happened to run it: that put a hundred and ninety-five
 * videos from channels only the second account followed into the first account's feed,
 * and the same in reverse.
 *
 * Derived from the subscription rather than passed in, because the caller does not know
 * — it asked for a batch of channels and got back a pile of videos. The join is the only
 * place the answer exists.
 */
export async function addSubscriptionCandidates(
  db: D1Database,
  videoIds: string[],
  now: EpochMillis,
): Promise<number> {
  if (videoIds.length === 0) return 0
  // One bound parameter goes to `now`, so ninety-nine ids fit inside D1's hundred.
  const CHUNK = 99
  let written = 0
  for (let offset = 0; offset < videoIds.length; offset += CHUNK) {
    const chunk = videoIds.slice(offset, offset + CHUNK)
    const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ')
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO profile_candidates (profile_id, video_id, discovered_at)
         SELECT s.profile_id, v.id, ?1
           FROM videos v
           JOIN profile_subscriptions s ON s.channel_id = v.channel_id
          WHERE v.id IN (${placeholders})`,
      )
      .bind(now, ...chunk)
      .run()
    written += result.meta?.changes ?? 0
  }
  return written
}
