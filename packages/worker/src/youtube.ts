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
  /**
   * Region and category pairs that have no popular chart at all. Not failures: which
   * combinations are charted varies by region and changes over time, so a 404 here says
   * "nothing to fetch", not "something is broken".
   */
  skipped: string[]
}

export async function crawlMostPopular(options: CrawlOptions): Promise<CrawlResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const maxResults = Math.min(50, Math.max(1, options.maxResults ?? 50))
  const byId = new Map<string, CatalogItem>()
  const errors: string[] = []
  const skipped: string[] = []
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
        if (response.status === 404) {
          // This region and category simply has no chart. Reporting it as an error every
          // run would make a normal outcome look like a fault.
          skipped.push(`${region}/${category}`)
          continue
        }
        if (!response.ok) {
          errors.push(`${region}/${category}: ${response.status} ${await describeFailure(response)}`)
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

  return { items: [...byId.values()], requests, errors, skipped }
}

export interface RecentCrawlOptions extends CrawlOptions {
  /** How far back to look. */
  days?: number
}

/**
 * Recent uploads, regardless of how popular they are.
 *
 * `chart=mostPopular` can only ever return established videos, so a catalog built from it
 * alone cannot fill the emerging and evergreen slots the ranker reserves — it supplies
 * exactly the popularity bias section 4.3 exists to avoid. Ordering by date instead spans
 * the whole range, and asks nothing about anyone's preferences (design addendum 2).
 *
 * One `search.list` call per region, which draws on a budget separate from everything else.
 */
export async function crawlRecentUploads(options: RecentCrawlOptions): Promise<CrawlResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const maxResults = Math.min(50, Math.max(1, options.maxResults ?? 25))
  const publishedAfter = new Date(
    Date.parse(options.now) - (options.days ?? 7) * 86_400_000,
  ).toISOString()

  const videoIds = new Set<string>()
  const errors: string[] = []
  const skipped: string[] = []
  let requests = 0

  /**
   * No category filter. Filtering by `videoCategoryId` here returned nothing at all
   * against the live API: category is sparsely populated in the search index, unlike in
   * the popular chart. It is no loss — this pass exists to reach videos of every
   * popularity level, not to cover categories, which the popular pass already does.
   */
  for (const region of options.regions) {
    const url = new URL(`${API_ROOT}/search`)
    url.searchParams.set('part', 'id')
    url.searchParams.set('type', 'video')
    url.searchParams.set('order', 'date')
    url.searchParams.set('regionCode', region)
    url.searchParams.set('publishedAfter', publishedAfter)
    url.searchParams.set('maxResults', String(maxResults))
    url.searchParams.set('key', options.apiKey)

    try {
      requests += 1
      const response = await fetchImpl(url.toString(), { headers: { Accept: 'application/json' } })
      if (response.status === 404) {
        skipped.push(region)
        continue
      }
      if (!response.ok) {
        errors.push(`${region}: ${response.status} ${await describeFailure(response)}`)
        continue
      }
      const payload = (await response.json()) as { items?: Array<{ id?: { videoId?: string } }> }
      for (const entry of payload.items ?? []) {
        if (entry.id?.videoId) videoIds.add(entry.id.videoId)
      }
    } catch (error) {
      errors.push(`${region}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Search results carry no statistics or duration, so the metadata has to be filled in.
  const filled = await hydrate([...videoIds], options.apiKey, options.now, fetchImpl)

  return {
    items: filled.items,
    requests: requests + filled.requests,
    errors: [...errors, ...filled.errors],
    skipped,
  }
}

async function hydrate(
  videoIds: string[],
  apiKey: string,
  now: string,
  fetchImpl: typeof fetch,
): Promise<{ items: CatalogItem[]; requests: number; errors: string[] }> {
  const items: CatalogItem[] = []
  const errors: string[] = []
  let requests = 0

  for (let offset = 0; offset < videoIds.length; offset += 50) {
    const batch = videoIds.slice(offset, offset + 50)
    const url = new URL(`${API_ROOT}/videos`)
    url.searchParams.set('part', 'snippet,contentDetails,statistics')
    url.searchParams.set('id', batch.join(','))
    url.searchParams.set('maxResults', '50')
    url.searchParams.set('key', apiKey)

    try {
      requests += 1
      const response = await fetchImpl(url.toString(), { headers: { Accept: 'application/json' } })
      if (!response.ok) {
        errors.push(`hydrate: ${response.status} ${await describeFailure(response)}`)
        continue
      }
      const payload = (await response.json()) as { items?: VideoResource[] }
      for (const resource of payload.items ?? []) {
        const item = toCatalogItem(resource, now)
        if (item) items.push(item)
      }
    } catch (error) {
      errors.push(`hydrate: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { items, requests, errors }
}

/**
 * A short reason from a failed response.
 *
 * The raw body is a multi-line JSON document; pasting it whole into an error list buries
 * the one sentence that says what went wrong.
 */
async function describeFailure(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    if (parsed.error?.message) return parsed.error.message
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return body.replace(/\s+/g, ' ').slice(0, 160)
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
