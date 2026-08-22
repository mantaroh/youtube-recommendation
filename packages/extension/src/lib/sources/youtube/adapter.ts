import type {
  CatalogItem,
  SearchOptions,
  SourceAdapter,
  SubscriptionUpdateOptions,
} from '@ypr/shared'
import { getDb } from '../../db.js'
import { YouTubeApiClient } from './client.js'
import { toCatalogItem } from './mapper.js'

/**
 * `SourceAdapter` for YouTube (design section 7.1).
 *
 * Channel details are cached locally so a feed rebuild does not re-resolve every uploads
 * playlist, which is where the bulk of the daily unit cost would otherwise go.
 */
export class YouTubeSourceAdapter implements SourceAdapter {
  readonly source = 'youtube' as const

  constructor(
    private readonly client: YouTubeApiClient,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async listSubscribedChannelIds(): Promise<string[]> {
    const subscriptions = await this.client.listSubscriptions()
    const db = getDb()
    const known = await db.channels.toArray()
    const knownById = new Map(known.map((row) => [row.channelId, row]))

    const missing = subscriptions
      .map((subscription) => subscription.channelId)
      .filter((channelId) => !knownById.get(channelId)?.uploadsPlaylistId)

    const details = missing.length > 0 ? await this.client.listChannels(missing) : []
    const fetchedAt = this.now()

    await db.channels.bulkPut([
      ...details.map((detail) => ({
        channelId: detail.channelId,
        title: detail.title,
        uploadsPlaylistId: detail.uploadsPlaylistId,
        subscribed: true,
        fetchedAt,
      })),
      // Mark previously known channels as still subscribed.
      ...subscriptions
        .filter((subscription) => knownById.has(subscription.channelId))
        .map((subscription) => ({
          ...knownById.get(subscription.channelId)!,
          subscribed: true,
          title: subscription.title || knownById.get(subscription.channelId)!.title,
        })),
    ])

    // Channels that disappeared from the subscription list are no longer subscribed.
    const currentIds = new Set(subscriptions.map((subscription) => subscription.channelId))
    const unsubscribed = known.filter((row) => row.subscribed && !currentIds.has(row.channelId))
    if (unsubscribed.length > 0) {
      await db.channels.bulkPut(unsubscribed.map((row) => ({ ...row, subscribed: false })))
    }

    return [...currentIds]
  }

  async listSubscriptionUpdates(options: SubscriptionUpdateOptions): Promise<CatalogItem[]> {
    const db = getDb()
    const channelIds = options.channelIds ?? (await this.listSubscribedChannelIds())
    const rows = await db.channels.bulkGet(channelIds)

    const cutoff = Date.parse(options.publishedAfter)
    const videoIds: string[] = []

    for (const row of rows) {
      if (!row?.uploadsPlaylistId) continue
      const videos = await this.client.listPlaylistVideos(row.uploadsPlaylistId, options.maxPerChannel)
      for (const video of videos) {
        // An empty publishedAt means the playlist entry carried no date; keep it and let
        // the video resource supply the real one during hydration.
        if (!video.publishedAt || Date.parse(video.publishedAt) >= cutoff) {
          videoIds.push(video.videoId)
        }
      }
    }

    return this.hydrate(videoIds)
  }

  async search(query: string, options: SearchOptions): Promise<CatalogItem[]> {
    const ids = await this.client.searchVideoIds(query, {
      maxResults: options.maxResults,
      ...(options.order ? { order: options.order } : {}),
      ...(options.publishedAfter ? { publishedAfter: options.publishedAfter } : {}),
    })
    return this.hydrate(ids)
  }

  async hydrate(externalIds: string[]): Promise<CatalogItem[]> {
    const unique = [...new Set(externalIds)].filter(Boolean)
    if (unique.length === 0) return []
    const resources = await this.client.listVideos(unique)
    const fetchedAt = this.now()
    return resources.map((resource) => toCatalogItem(resource, { fetchedAt }))
  }
}
