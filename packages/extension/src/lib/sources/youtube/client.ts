import { z } from 'zod'
import { videoResourceSchema, type VideoResource } from './mapper.js'
import { reserve, type QuotaBucket } from './quota.js'

/**
 * Thin wrapper over the YouTube Data API v3.
 *
 * Everything here goes straight from this machine to Google. Search queries are built
 * from local interests and are deliberately not routed through any server of ours
 * (design section 1.1).
 *
 * `fetch` and the token provider are injected so the client can be exercised against
 * recorded fixtures under Node.
 */

const API_ROOT = 'https://www.googleapis.com/youtube/v3'

export interface YouTubeClientOptions {
  apiKey: string
  getAccessToken: () => Promise<string>
  fetchImpl?: typeof fetch
  /** Escape hatch for tests; production always accounts against the real ledger. */
  reserveQuota?: (bucket: QuotaBucket, amount: number) => Promise<boolean>
}

export class QuotaExhaustedError extends Error {
  constructor(readonly bucket: QuotaBucket) {
    super(`YouTube API budget exhausted for the day: ${bucket}`)
    this.name = 'QuotaExhaustedError'
  }
}

const subscriptionListSchema = z.object({
  nextPageToken: z.string().optional(),
  items: z
    .array(
      z.object({
        snippet: z
          .object({
            title: z.string().optional(),
            resourceId: z.object({ channelId: z.string().optional() }).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
})

const channelListSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        snippet: z.object({ title: z.string().optional() }).optional(),
        contentDetails: z
          .object({
            relatedPlaylists: z.object({ uploads: z.string().optional() }).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
})

const playlistItemListSchema = z.object({
  nextPageToken: z.string().optional(),
  items: z
    .array(
      z.object({
        contentDetails: z
          .object({
            videoId: z.string().optional(),
            videoPublishedAt: z.string().optional(),
          })
          .optional(),
      }),
    )
    .optional(),
})

const searchListSchema = z.object({
  items: z
    .array(z.object({ id: z.object({ videoId: z.string().optional() }).optional() }))
    .optional(),
})

const videoListSchema = z.object({ items: z.array(videoResourceSchema).optional() })

export interface SubscribedChannel {
  channelId: string
  title: string
}

export interface ChannelDetail {
  channelId: string
  title: string
  uploadsPlaylistId: string
}

export interface PlaylistVideo {
  videoId: string
  publishedAt: string
}

export class YouTubeApiClient {
  private readonly apiKey: string
  private readonly getAccessToken: () => Promise<string>
  private readonly fetchImpl: typeof fetch
  private readonly reserveQuota: (bucket: QuotaBucket, amount: number) => Promise<boolean>

  constructor(options: YouTubeClientOptions) {
    this.apiKey = options.apiKey
    this.getAccessToken = options.getAccessToken
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
    this.reserveQuota = options.reserveQuota ?? reserve
  }

  /** Channels the signed-in user subscribes to. Costs 1 unit per page of 50. */
  async listSubscriptions(): Promise<SubscribedChannel[]> {
    const channels: SubscribedChannel[] = []
    let pageToken: string | undefined
    do {
      const payload = await this.request(
        'subscriptions',
        {
          part: 'snippet',
          mine: 'true',
          maxResults: '50',
          ...(pageToken ? { pageToken } : {}),
        },
        { auth: true, bucket: 'units', cost: 1 },
      )
      const parsed = subscriptionListSchema.parse(payload)
      for (const item of parsed.items ?? []) {
        const channelId = item.snippet?.resourceId?.channelId
        if (channelId) channels.push({ channelId, title: item.snippet?.title ?? '' })
      }
      pageToken = parsed.nextPageToken
    } while (pageToken)
    return channels
  }

  /** Resolves the uploads playlist for each channel, 50 ids per call. */
  async listChannels(channelIds: string[]): Promise<ChannelDetail[]> {
    const details: ChannelDetail[] = []
    for (const batch of chunk(channelIds, 50)) {
      const payload = await this.request(
        'channels',
        { part: 'snippet,contentDetails', id: batch.join(','), maxResults: '50' },
        { auth: true, bucket: 'units', cost: 1 },
      )
      const parsed = channelListSchema.parse(payload)
      for (const item of parsed.items ?? []) {
        const uploads = item.contentDetails?.relatedPlaylists?.uploads
        if (uploads) {
          details.push({
            channelId: item.id,
            title: item.snippet?.title ?? '',
            uploadsPlaylistId: uploads,
          })
        }
      }
    }
    return details
  }

  async listPlaylistVideos(playlistId: string, maxResults: number): Promise<PlaylistVideo[]> {
    const payload = await this.request(
      'playlistItems',
      {
        part: 'contentDetails',
        playlistId,
        maxResults: String(Math.min(50, Math.max(1, maxResults))),
      },
      { auth: true, bucket: 'units', cost: 1 },
    )
    const parsed = playlistItemListSchema.parse(payload)
    const videos: PlaylistVideo[] = []
    for (const item of parsed.items ?? []) {
      const videoId = item.contentDetails?.videoId
      if (videoId) {
        videos.push({ videoId, publishedAt: item.contentDetails?.videoPublishedAt ?? '' })
      }
    }
    return videos
  }

  /** Searches for unknown videos. Accounted against the separate search budget. */
  async searchVideoIds(
    query: string,
    options: { maxResults?: number; order?: string; publishedAfter?: string } = {},
  ): Promise<string[]> {
    const payload = await this.request(
      'search',
      {
        part: 'id',
        type: 'video',
        q: query,
        maxResults: String(options.maxResults ?? 25),
        ...(options.order ? { order: options.order } : {}),
        ...(options.publishedAfter ? { publishedAfter: options.publishedAfter } : {}),
      },
      { auth: false, bucket: 'search', cost: 1 },
    )
    const parsed = searchListSchema.parse(payload)
    return (parsed.items ?? []).map((item) => item.id?.videoId).filter((id): id is string => Boolean(id))
  }

  /** Full metadata for up to 50 ids per call. */
  async listVideos(videoIds: string[]): Promise<VideoResource[]> {
    const resources: VideoResource[] = []
    for (const batch of chunk(videoIds, 50)) {
      const payload = await this.request(
        'videos',
        { part: 'snippet,contentDetails,statistics', id: batch.join(','), maxResults: '50' },
        { auth: false, bucket: 'units', cost: 1 },
      )
      resources.push(...(videoListSchema.parse(payload).items ?? []))
    }
    return resources
  }

  private async request(
    path: string,
    params: Record<string, string>,
    options: { auth: boolean; bucket: QuotaBucket; cost: number },
  ): Promise<unknown> {
    if (!(await this.reserveQuota(options.bucket, options.cost))) {
      throw new QuotaExhaustedError(options.bucket)
    }

    const url = new URL(`${API_ROOT}/${path}`)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)

    const headers: Record<string, string> = { Accept: 'application/json' }
    if (options.auth) {
      headers.Authorization = `Bearer ${await this.getAccessToken()}`
    } else {
      url.searchParams.set('key', this.apiKey)
    }

    const response = await this.fetchImpl(url.toString(), { headers })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`YouTube API ${path} failed: ${response.status} ${body.slice(0, 300)}`)
    }
    return response.json()
  }
}

function chunk<T>(values: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let i = 0; i < values.length; i += size) batches.push(values.slice(i, i + size))
  return batches
}
