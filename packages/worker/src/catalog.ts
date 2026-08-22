import type { CatalogItem } from '@ypr/shared'

/**
 * D1 access for the public catalog.
 *
 * Everything is metadata about videos. There is deliberately no table here that could
 * hold a rating, a preference vector or anything else that says who wants what
 * (design section 1).
 */

export interface CatalogRow {
  source: string
  external_id: string
  title: string
  description: string
  tags: string
  channel_id: string
  channel_title: string
  official_category_id: string
  duration_seconds: number
  published_at: string
  view_count: number
  metadata_fetched_at: string
  expires_at: string
  provenance: string
  updated_at: string
}

export interface SyncCursor {
  updatedAt: string
  externalId: string
}

export interface CatalogPage {
  items: CatalogItem[]
  cursor: SyncCursor | null
  hasMore: boolean
}

export function rowToItem(row: CatalogRow): CatalogItem {
  return {
    source: 'youtube',
    externalId: row.external_id,
    title: row.title,
    description: row.description,
    tags: parseTags(row.tags),
    channelId: row.channel_id,
    channelTitle: row.channel_title,
    officialCategoryId: row.official_category_id,
    durationSeconds: row.duration_seconds,
    publishedAt: row.published_at,
    viewCount: row.view_count,
    metadataFetchedAt: row.metadata_fetched_at,
    expiresAt: row.expires_at,
    provenance: row.provenance === 'fixture' ? 'fixture' : 'youtube_api',
  }
}

function parseTags(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === 'string') : []
  } catch {
    return []
  }
}

export async function upsertItems(
  db: D1Database,
  items: CatalogItem[],
  updatedAt: string,
): Promise<number> {
  if (items.length === 0) return 0

  const statement = db.prepare(
    `INSERT INTO catalog_item (
       source, external_id, title, description, tags, channel_id, channel_title,
       official_category_id, duration_seconds, published_at, view_count,
       metadata_fetched_at, expires_at, provenance, updated_at
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
     ON CONFLICT (source, external_id) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       tags = excluded.tags,
       channel_id = excluded.channel_id,
       channel_title = excluded.channel_title,
       official_category_id = excluded.official_category_id,
       duration_seconds = excluded.duration_seconds,
       published_at = excluded.published_at,
       view_count = excluded.view_count,
       metadata_fetched_at = excluded.metadata_fetched_at,
       expires_at = excluded.expires_at,
       provenance = excluded.provenance,
       updated_at = excluded.updated_at`,
  )

  await db.batch(
    items.map((item) =>
      statement.bind(
        item.source,
        item.externalId,
        item.title,
        item.description,
        JSON.stringify(item.tags),
        item.channelId,
        item.channelTitle,
        item.officialCategoryId,
        item.durationSeconds,
        item.publishedAt,
        item.viewCount,
        item.metadataFetchedAt,
        item.expiresAt,
        item.provenance,
        updatedAt,
      ),
    ),
  )

  return items.length
}

/**
 * Pages through everything written since a cursor.
 *
 * The cursor is a pair, not just a timestamp: a batch write gives many rows the same
 * `updated_at`, and paging on the timestamp alone would skip whatever did not fit in the
 * first page of that batch.
 */
export async function listSince(
  db: D1Database,
  cursor: SyncCursor | null,
  limit: number,
): Promise<CatalogPage> {
  const capped = Math.min(500, Math.max(1, limit))
  const result = cursor
    ? await db
        .prepare(
          `SELECT * FROM catalog_item
           WHERE updated_at > ?1 OR (updated_at = ?1 AND external_id > ?2)
           ORDER BY updated_at, external_id
           LIMIT ?3`,
        )
        .bind(cursor.updatedAt, cursor.externalId, capped + 1)
        .all<CatalogRow>()
    : await db
        .prepare(`SELECT * FROM catalog_item ORDER BY updated_at, external_id LIMIT ?1`)
        .bind(capped + 1)
        .all<CatalogRow>()

  const rows = result.results ?? []
  const hasMore = rows.length > capped
  const page = hasMore ? rows.slice(0, capped) : rows
  const last = page[page.length - 1]

  return {
    items: page.map(rowToItem),
    cursor: last ? { updatedAt: last.updated_at, externalId: last.external_id } : cursor,
    hasMore,
  }
}

/** Deletes rows past their TTL. Required, not housekeeping (design section 6.2). */
export async function purgeExpired(db: D1Database, now: string): Promise<number> {
  const result = await db.prepare(`DELETE FROM catalog_item WHERE expires_at <= ?1`).bind(now).run()
  return result.meta?.changes ?? 0
}

/**
 * Channels in the catalog, least recently refreshed first.
 *
 * Ordering by the oldest `updated_at` among a channel's items gives rotation for free:
 * crawling a channel rewrites its rows with the current time, which sends it to the back
 * of the queue. No extra table, and no cursor that could drift out of step with the data.
 */
export async function listChannelsToRefresh(db: D1Database, limit: number): Promise<string[]> {
  const capped = Math.min(200, Math.max(1, limit))
  const result = await db
    .prepare(
      `SELECT channel_id, MIN(updated_at) AS oldest
       FROM catalog_item
       WHERE channel_id LIKE 'UC%'
       GROUP BY channel_id
       ORDER BY oldest ASC
       LIMIT ?1`,
    )
    .bind(capped)
    .all<{ channel_id: string }>()

  return (result.results ?? []).map((row) => row.channel_id)
}

export async function countItems(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS total FROM catalog_item`).first<{ total: number }>()
  return row?.total ?? 0
}
