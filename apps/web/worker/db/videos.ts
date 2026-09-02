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

export async function upsertChannels(
  db: D1Database,
  source: Source,
  channels: SourceChannel[],
  options: { subscribed?: boolean; now: EpochMillis },
): Promise<number> {
  if (channels.length === 0) return 0

  const statements = channels.map((channel) => {
    const id = itemKey({ source, externalId: channel.externalId })
    // `subscribed` is only written when the caller is in a position to know. A search
    // result mentioning a channel says nothing about whether the user follows it, and
    // overwriting the flag there would silently unsubscribe them.
    if (options.subscribed === undefined) {
      return db
        .prepare(
          `INSERT INTO channels (id, source, external_id, title, thumbnail_url, subscribed, last_fetched_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
           ON CONFLICT(id) DO UPDATE SET
             title = COALESCE(excluded.title, channels.title),
             thumbnail_url = COALESCE(excluded.thumbnail_url, channels.thumbnail_url)`,
        )
        .bind(id, source, channel.externalId, channel.title, channel.thumbnailUrl, options.now)
    }
    return db
      .prepare(
        `INSERT INTO channels (id, source, external_id, title, thumbnail_url, subscribed, last_fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
           title = COALESCE(excluded.title, channels.title),
           thumbnail_url = COALESCE(excluded.thumbnail_url, channels.thumbnail_url),
           subscribed = excluded.subscribed,
           last_fetched_at = excluded.last_fetched_at`,
      )
      .bind(id, source, channel.externalId, channel.title, channel.thumbnailUrl, options.subscribed ? 1 : 0, options.now)
  })

  await db.batch(statements)
  return channels.length
}

export interface UpsertVideoOptions {
  now: EpochMillis
  /** Recorded in metadata so quota spend can be attributed to a lane afterwards. */
  discoveredBy?: VideoMetadata['discoveredBy']
  discoveryQuery?: string
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

export async function listChannels(db: D1Database, options: { subscribedOnly?: boolean } = {}): Promise<Channel[]> {
  const sql = options.subscribedOnly
    ? 'SELECT * FROM channels WHERE subscribed = 1 ORDER BY title'
    : 'SELECT * FROM channels ORDER BY subscribed DESC, title'
  const { results } = await db.prepare(sql).all<ChannelRow>()
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
  const { results } = await db
    .prepare(
      `SELECT * FROM channels
       WHERE subscribed = 1
       ORDER BY COALESCE(last_fetched_at, 0) ASC
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
  channelIds: string[],
  now: EpochMillis,
): Promise<void> {
  // Subscriptions are replaced wholesale rather than merged: unsubscribing on YouTube
  // has to be able to reach this system, and a merge could never express a removal.
  const statements = [db.prepare('UPDATE channels SET subscribed = 0 WHERE subscribed = 1')]
  for (const id of channelIds) {
    statements.push(
      db.prepare('UPDATE channels SET subscribed = 1, last_fetched_at = COALESCE(last_fetched_at, ?2) WHERE id = ?1').bind(id, now),
    )
  }
  await db.batch(statements)
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

const JOIN_SELECT = `
  SELECT v.*,
         c.id AS c_id, c.source AS c_source, c.external_id AS c_external_id,
         c.title AS c_title, c.thumbnail_url AS c_thumbnail_url,
         c.subscribed AS c_subscribed, c.last_fetched_at AS c_last_fetched_at
  FROM videos v
  LEFT JOIN channels c ON c.id = v.channel_id`

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
  ids: string[],
): Promise<VideoWithChannel[]> {
  const CHUNK = 100
  const loaded: VideoWithChannel[] = []
  for (let offset = 0; offset < ids.length; offset += CHUNK) {
    const chunk = ids.slice(offset, offset + CHUNK)
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(', ')
    const { results } = await db
      .prepare(`${JOIN_SELECT} WHERE v.id IN (${placeholders})`)
      .bind(...chunk)
      .all<JoinedRow>()
    for (const row of results ?? []) loaded.push(toJoined(row))
  }
  return loaded
}

export interface CandidateQuery {
  /** Only videos published (or, failing that, discovered) at or after this instant. */
  publishedAfter: EpochMillis
  limit: number
  /** Restrict to subscribed channels, or exclude them. */
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
  const conditions = ['COALESCE(v.published_at, v.discovered_at) >= ?1']
  const bindings: unknown[] = [query.publishedAfter]

  if (query.subscribed !== undefined) {
    bindings.push(query.subscribed ? 1 : 0)
    conditions.push(`COALESCE(c.subscribed, 0) = ?${bindings.length}`)
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
