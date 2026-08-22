import type { CatalogItem, Provenance } from '@ypr/shared'
import { z } from 'zod'

/**
 * Translation from YouTube API resources into our own catalog shape.
 *
 * Only the fields listed in design section 6.2 are kept: title, description, tags,
 * channel, official category, duration, publication time and view count. Nothing derived
 * from audiovisual content is read, and the official category is copied verbatim rather
 * than re-inferred.
 */

/** Unauthenticated API data must be refreshed or deleted within 30 days (design section 6.2). */
export const METADATA_TTL_DAYS = 30

export const videoResourceSchema = z.object({
  id: z.string(),
  snippet: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      channelId: z.string().optional(),
      channelTitle: z.string().optional(),
      categoryId: z.string().optional(),
      publishedAt: z.string().optional(),
    })
    .optional(),
  contentDetails: z.object({ duration: z.string().optional() }).optional(),
  statistics: z.object({ viewCount: z.string().optional() }).optional(),
})

export type VideoResource = z.infer<typeof videoResourceSchema>

/** Parses the ISO 8601 duration YouTube reports, e.g. `PT1H2M3S`. */
export function parseIso8601Duration(duration: string | undefined): number {
  if (!duration) return 0
  const match = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(duration)
  if (!match) return 0
  const [, days, hours, minutes, seconds] = match
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Math.round(Number(seconds ?? 0))
  )
}

export function toCatalogItem(
  resource: VideoResource,
  options: { fetchedAt: string; provenance?: Provenance },
): CatalogItem {
  const snippet = resource.snippet ?? {}
  const fetchedAt = options.fetchedAt
  const expiresAt = new Date(Date.parse(fetchedAt) + METADATA_TTL_DAYS * 86_400_000).toISOString()

  return {
    source: 'youtube',
    externalId: resource.id,
    title: snippet.title ?? '',
    description: snippet.description ?? '',
    tags: snippet.tags ?? [],
    channelId: snippet.channelId ?? '',
    channelTitle: snippet.channelTitle ?? '',
    officialCategoryId: snippet.categoryId ?? '',
    durationSeconds: parseIso8601Duration(resource.contentDetails?.duration),
    publishedAt: snippet.publishedAt ?? fetchedAt,
    viewCount: Number(resource.statistics?.viewCount ?? 0),
    metadataFetchedAt: fetchedAt,
    expiresAt,
    provenance: options.provenance ?? 'youtube_api',
  }
}

/**
 * The text that gets embedded.
 *
 * Title first and repeated once, because it carries most of the topical signal while the
 * description often trails into links and boilerplate; the description is truncated for
 * the same reason.
 */
export function embeddingTextFor(item: CatalogItem): string {
  const description = item.description.slice(0, 600)
  const parts = [item.title, item.title, item.channelTitle, item.tags.join(' '), description]
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n')
}

export function isExpired(item: CatalogItem, now: string): boolean {
  return Date.parse(item.expiresAt) <= Date.parse(now)
}
