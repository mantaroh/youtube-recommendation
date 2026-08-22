import type { CatalogItem } from '@ypr/shared'

/**
 * Preference-independent crawl.
 *
 * The worker reads the most popular videos per region and category. That choice is not
 * incidental: it is a query that depends on nobody's preferences, so running it here
 * reveals nothing about any user. Anything that *does* depend on what someone likes —
 * subscriptions, interest searches — happens in the extension instead (design section 1.1).
 *
 * `chart=mostPopular` is a `videos.list` call, so it costs one unit and never touches the
 * separate `search.list` budget.
 */

const API_ROOT = 'https://www.googleapis.com/youtube/v3'
const METADATA_TTL_DAYS = 30

interface VideoResource {
  id?: string
  snippet?: {
    title?: string
    description?: string
    tags?: string[]
    channelId?: string
    channelTitle?: string
    categoryId?: string
    publishedAt?: string
  }
  contentDetails?: { duration?: string }
  statistics?: { viewCount?: string }
}

export interface CrawlOptions {
  apiKey: string
  regions: string[]
  categories: string[]
  maxResults?: number
  now: string
  fetchImpl?: typeof fetch
}

export interface CrawlResult {
  items: CatalogItem[]
  requests: number
  errors: string[]
}

export async function crawlMostPopular(options: CrawlOptions): Promise<CrawlResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const maxResults = Math.min(50, Math.max(1, options.maxResults ?? 50))
  const byId = new Map<string, CatalogItem>()
  const errors: string[] = []
  let requests = 0

  for (const region of options.regions) {
    for (const category of options.categories) {
      const url = new URL(`${API_ROOT}/videos`)
      url.searchParams.set('part', 'snippet,contentDetails,statistics')
      url.searchParams.set('chart', 'mostPopular')
      url.searchParams.set('regionCode', region)
      url.searchParams.set('videoCategoryId', category)
      url.searchParams.set('maxResults', String(maxResults))
      url.searchParams.set('key', options.apiKey)

      try {
        requests += 1
        const response = await fetchImpl(url.toString(), { headers: { Accept: 'application/json' } })
        if (!response.ok) {
          const body = await response.text().catch(() => '')
          errors.push(`${region}/${category}: ${response.status} ${body.slice(0, 200)}`)
          continue
        }
        const payload = (await response.json()) as { items?: VideoResource[] }
        for (const resource of payload.items ?? []) {
          const item = toCatalogItem(resource, options.now)
          // Regions overlap heavily; the same video should be stored once.
          if (item) byId.set(item.externalId, item)
        }
      } catch (error) {
        errors.push(`${region}/${category}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  return { items: [...byId.values()], requests, errors }
}

function toCatalogItem(resource: VideoResource, now: string): CatalogItem | undefined {
  if (!resource.id) return undefined
  const snippet = resource.snippet ?? {}
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
    publishedAt: snippet.publishedAt ?? now,
    viewCount: Number(resource.statistics?.viewCount ?? 0),
    metadataFetchedAt: now,
    expiresAt: new Date(Date.parse(now) + METADATA_TTL_DAYS * 86_400_000).toISOString(),
    provenance: 'youtube_api',
  }
}

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
