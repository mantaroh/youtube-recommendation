import type { SourceChannel, SourceItem } from '@ypr/domain'

/**
 * A thin YouTube Data API v3 client.
 *
 * Two things it deliberately keeps separate. First, authentication: reading the
 * user's own subscriptions needs an OAuth token, while everything else works with an
 * API key, and using the token where a key would do would attach the user's identity
 * to requests that do not need it. Second, cost: `search.list` draws on an allowance a
 * hundred times smaller than the rest, so it is the only method here that reports its
 * cost separately (design section 42).
 */

const API_ROOT = 'https://www.googleapis.com/youtube/v3'

/** Quota units, from the published cost table. */
export const QUOTA_COST = {
  /** `videos.list`, `playlistItems.list`, `subscriptions.list`, `channels.list`. */
  list: 1,
  /** `search.list`, which also draws on a separate 100-call daily allowance. */
  search: 100,
} as const

export interface YouTubeCredentials {
  apiKey?: string
  /** Present only for calls that act as the user, such as `subscriptions.list`. */
  accessToken?: string
}

export interface YouTubeClientOptions extends YouTubeCredentials {
  fetchImpl?: typeof fetch
}

export interface RequestTally {
  /** Ordinary calls made, at one unit each. */
  list: number
  /** `search.list` calls made, against the scarce allowance. */
  search: number
}

export class YouTubeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'YouTubeError'
  }
}

export class YouTubeClient {
  readonly tally: RequestTally = { list: 0, search: 0 }

  private readonly fetchImpl: typeof fetch

  constructor(private readonly credentials: YouTubeClientOptions) {
    this.fetchImpl = credentials.fetchImpl ?? fetch
  }

  /**
   * The user's own subscriptions (design section 16).
   *
   * The only call here that needs the OAuth token, and the reason the token exists at
   * all. `mine=true` is what makes it the *user's* list rather than a public one.
   */
  async listSubscriptions(limit = 200): Promise<SourceChannel[]> {
    if (!this.credentials.accessToken) {
      throw new YouTubeError('subscriptions require a connected YouTube account', 401)
    }

    const channels: SourceChannel[] = []
    let pageToken: string | undefined

    while (channels.length < limit) {
      const params: Record<string, string> = {
        part: 'snippet',
        mine: 'true',
        maxResults: String(Math.min(50, limit - channels.length)),
      }
      if (pageToken) params.pageToken = pageToken

      const payload = await this.get<SubscriptionListResponse>('subscriptions', params, 'list', true)
      for (const entry of payload.items ?? []) {
        const externalId = entry.snippet?.resourceId?.channelId
        if (!externalId) continue
        channels.push({
          externalId,
          title: entry.snippet?.title ?? externalId,
          thumbnailUrl: pickThumbnail(entry.snippet?.thumbnails),
          uploadsPlaylistId: uploadsPlaylistId(externalId),
        })
      }
      pageToken = payload.nextPageToken
      if (!pageToken) break
    }

    return channels
  }

  /**
   * Newest uploads from a channel.
   *
   * A channel's uploads playlist id is its channel id with `UC` swapped for `UU`, so
   * this needs no `channels.list` lookup, and it costs one unit rather than the
   * hundred that `search.list?channelId=` would cost for the same answer.
   */
  async listChannelUploads(channelExternalId: string, maxResults = 10): Promise<string[]> {
    const playlistId = uploadsPlaylistId(channelExternalId)
    if (!playlistId) return []

    const payload = await this.get<PlaylistItemListResponse>('playlistItems', {
      part: 'contentDetails',
      playlistId,
      maxResults: String(Math.min(50, Math.max(1, maxResults))),
    }, 'list')

    const ids: string[] = []
    for (const entry of payload.items ?? []) {
      if (entry.contentDetails?.videoId) ids.push(entry.contentDetails.videoId)
    }
    return ids
  }

  /** Full metadata for ids found elsewhere. Fifty per call, one unit each. */
  async listVideos(externalIds: string[]): Promise<SourceItem[]> {
    const items: SourceItem[] = []
    for (let offset = 0; offset < externalIds.length; offset += 50) {
      const batch = externalIds.slice(offset, offset + 50)
      const payload = await this.get<VideoListResponse>('videos', {
        part: 'snippet,contentDetails,statistics',
        id: batch.join(','),
        maxResults: '50',
      }, 'list')
      for (const resource of payload.items ?? []) {
        const item = toSourceItem(resource)
        if (item) items.push(item)
      }
    }
    return items
  }

  /**
   * The public popularity chart. Costs one unit, not a search, because it is a
   * `videos.list` call with a `chart` parameter.
   */
  async listMostPopular(regionCode: string, categoryId: string, maxResults = 50): Promise<SourceItem[]> {
    try {
      const payload = await this.get<VideoListResponse>('videos', {
        part: 'snippet,contentDetails,statistics',
        chart: 'mostPopular',
        regionCode,
        videoCategoryId: categoryId,
        maxResults: String(Math.min(50, Math.max(1, maxResults))),
      }, 'list')
      const items: SourceItem[] = []
      for (const resource of payload.items ?? []) {
        const item = toSourceItem(resource)
        if (item) items.push(item)
      }
      return items
    } catch (error) {
      // Which region and category pairs are charted varies and changes over time. A
      // 404 means "nothing to fetch here", which is not a fault worth propagating.
      if (error instanceof YouTubeError && error.status === 404) return []
      throw error
    }
  }

  /**
   * Search. The expensive one: a hundred quota units and one of a hundred daily search
   * calls, which is why every caller has to pass through the quota ledger first.
   *
   * It returns ids only. `search.list` snippets are abbreviated and carry no duration
   * or view count, so the results are hydrated with `listVideos` at one unit per fifty.
   */
  async searchIds(term: string, options: SearchOptions = {}): Promise<string[]> {
    const params: Record<string, string> = {
      part: 'id',
      q: term,
      type: 'video',
      maxResults: String(Math.min(50, Math.max(1, options.maxResults ?? 25))),
      order: options.order ?? 'relevance',
    }
    if (options.publishedAfter) params.publishedAfter = options.publishedAfter
    if (options.regionCode) params.regionCode = options.regionCode
    if (options.relevanceLanguage) params.relevanceLanguage = options.relevanceLanguage

    const payload = await this.get<SearchListResponse>('search', params, 'search')
    const ids: string[] = []
    for (const entry of payload.items ?? []) {
      if (entry.id?.videoId) ids.push(entry.id.videoId)
    }
    return ids
  }

  private async get<T>(
    path: string,
    params: Record<string, string>,
    cost: keyof RequestTally,
    asUser = false,
  ): Promise<T> {
    const url = new URL(`${API_ROOT}/${path}`)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (asUser && this.credentials.accessToken) {
      headers.Authorization = `Bearer ${this.credentials.accessToken}`
    } else if (this.credentials.apiKey) {
      url.searchParams.set('key', this.credentials.apiKey)
    } else if (this.credentials.accessToken) {
      headers.Authorization = `Bearer ${this.credentials.accessToken}`
    } else {
      throw new YouTubeError('no YouTube credentials configured', 401)
    }

    this.tally[cost] += 1
    const response = await this.fetchImpl(url.toString(), { headers })
    if (!response.ok) {
      throw new YouTubeError(`${path}: ${await describeFailure(response)}`, response.status)
    }
    return (await response.json()) as T
  }
}

export interface SearchOptions {
  maxResults?: number
  publishedAfter?: string
  order?: 'relevance' | 'date' | 'viewCount'
  regionCode?: string
  relevanceLanguage?: string
}

/** `UC…` identifies the channel, `UU…` its uploads playlist. */
export function uploadsPlaylistId(channelExternalId: string): string | undefined {
  if (!channelExternalId.startsWith('UC') || channelExternalId.length < 3) return undefined
  return `UU${channelExternalId.slice(2)}`
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

/**
 * A short reason from a failed response.
 *
 * The raw body is a multi-line JSON document; pasting it whole into an error list
 * buries the one sentence that says what went wrong.
 */
async function describeFailure(response: Response): Promise<string> {
  const body = await response.text().catch(() => '')
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    if (parsed.error?.message) return `${response.status} ${parsed.error.message}`
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return `${response.status} ${body.replace(/\s+/g, ' ').slice(0, 160)}`
}

function toSourceItem(resource: VideoResource): SourceItem | undefined {
  if (!resource.id) return undefined
  const snippet = resource.snippet ?? {}
  return {
    externalId: resource.id,
    title: snippet.title ?? '',
    description: snippet.description ?? '',
    channelExternalId: snippet.channelId ?? '',
    channelTitle: snippet.channelTitle ?? '',
    thumbnailUrl: pickThumbnail(snippet.thumbnails),
    publishedAt: snippet.publishedAt ?? null,
    durationSeconds: parseIso8601Duration(resource.contentDetails?.duration),
    viewCount: resource.statistics?.viewCount ? Number(resource.statistics.viewCount) : null,
    tags: snippet.tags ?? [],
    officialCategoryId: snippet.categoryId ?? null,
  }
}

function pickThumbnail(thumbnails: ThumbnailMap | undefined): string | null {
  return (
    thumbnails?.medium?.url ?? thumbnails?.high?.url ?? thumbnails?.default?.url ?? null
  )
}

// ---------------------------------------------------------------------------
// Response shapes, narrowed to the fields actually read
// ---------------------------------------------------------------------------

interface ThumbnailMap {
  default?: { url?: string }
  medium?: { url?: string }
  high?: { url?: string }
}

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
    thumbnails?: ThumbnailMap
  }
  contentDetails?: { duration?: string }
  statistics?: { viewCount?: string }
}

interface VideoListResponse {
  items?: VideoResource[]
}

interface PlaylistItemListResponse {
  items?: Array<{ contentDetails?: { videoId?: string } }>
}

interface SearchListResponse {
  items?: Array<{ id?: { videoId?: string } }>
}

interface SubscriptionListResponse {
  nextPageToken?: string
  items?: Array<{
    snippet?: {
      title?: string
      thumbnails?: ThumbnailMap
      resourceId?: { channelId?: string }
    }
  }>
}
