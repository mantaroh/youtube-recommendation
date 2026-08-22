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

export interface ChannelUploadsOptions {
  apiKey: string
  /** Channels to walk, in the order they should be visited. */
  channelIds: string[]
  /** Newest uploads to take from each channel. */
  maxPerChannel?: number
  now: string
  fetchImpl?: typeof fetch
}

/**
 * Recent uploads from channels already in the catalog.
 *
 * `chart=mostPopular` can only ever return videos that are *already* popular, so a catalog
 * built from it alone cannot fill the emerging and evergreen slots the ranker reserves —
 * it supplies exactly the popularity bias section 4.3 exists to avoid. Walking a channel's
 * uploads reaches its newest videos, which have few views however large the channel is
 * (design addendum 2).
 *
 * Two properties make this the right mechanism rather than a search:
 *
 * - It asks nothing about anyone's preferences. The channels come from the public chart,
 *   not from any user, so this stays safe to run on a server.
 * - It costs one unit per channel and never touches the `search.list` budget, which is a
 *   hundred times scarcer. `search.list?channelId=...` would do the same job and exhaust
 *   that budget after a hundred channels.
 *
 * A channel's uploads playlist id is its channel id with the `UC` prefix replaced by `UU`,
 * so no `channels.list` lookup is needed either.
 */
export async function crawlChannelUploads(options: ChannelUploadsOptions): Promise<CrawlResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const maxResults = Math.min(50, Math.max(1, options.maxPerChannel ?? 5))

  const videoIds = new Set<string>()
  const errors: string[] = []
  const skipped: string[] = []
  let requests = 0

  for (const channelId of options.channelIds) {
    const playlistId = uploadsPlaylistId(channelId)
    if (!playlistId) {
      skipped.push(channelId)
      continue
    }

    const url = new URL(`${API_ROOT}/playlistItems`)
    url.searchParams.set('part', 'contentDetails')
    url.searchParams.set('playlistId', playlistId)
    url.searchParams.set('maxResults', String(maxResults))
    url.searchParams.set('key', options.apiKey)

    try {
      requests += 1
      const response = await fetchImpl(url.toString(), { headers: { Accept: 'application/json' } })
      if (response.status === 404) {
        // Deleted channel, or uploads hidden. Nothing to fetch, not a fault.
        skipped.push(channelId)
        continue
      }
      if (!response.ok) {
        errors.push(`${channelId}: ${response.status} ${await describeFailure(response)}`)
        continue
      }
      const payload = (await response.json()) as {
        items?: Array<{ contentDetails?: { videoId?: string } }>
      }
      for (const entry of payload.items ?? []) {
        if (entry.contentDetails?.videoId) videoIds.add(entry.contentDetails.videoId)
      }
    } catch (error) {
      errors.push(`${channelId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Playlist entries carry only an id, so the metadata has to be filled in.
  const filled = await hydrate([...videoIds], options.apiKey, options.now, fetchImpl)

  return {
    items: filled.items,
    requests: requests + filled.requests,
    errors: [...errors, ...filled.errors],
    skipped,
  }
}

/** `UC…` identifies the channel, `UU…` its uploads playlist. */
export function uploadsPlaylistId(channelId: string): string | undefined {
  if (!channelId.startsWith('UC') || channelId.length < 3) return undefined
  return `UU${channelId.slice(2)}`
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
