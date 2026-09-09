import type { SourceItem } from '@ypr/domain'
import { addSubscriptions, upsertChannels, upsertVideos } from '../db/videos.js'

/**
 * Rows for tests to work against.
 *
 * Written through the same upsert functions the ingest path uses rather than with raw
 * INSERTs, so that a change to how a video is stored is exercised by every test rather
 * than only by the one that covers ingest.
 */

export interface SeedVideoOptions {
  id: string
  title?: string
  channelExternalId?: string
  channelTitle?: string
  /** Subscribed by `profileId`, which is the default profile unless given. */
  subscribed?: boolean
  profileId?: string
  publishedAt?: number
  viewCount?: number
  tags?: string[]
  description?: string
  now?: number
}

export async function seedVideo(db: D1Database, options: SeedVideoOptions): Promise<string> {
  const externalId = options.id.replace(/^youtube:/, '')
  const channelExternalId = options.channelExternalId ?? 'UCdefault'
  const now = options.now ?? 1_700_000_000_000

  await upsertChannels(
    db,
    'youtube',
    [
      {
        externalId: channelExternalId,
        title: options.channelTitle ?? channelExternalId,
        thumbnailUrl: null,
      },
    ],
  )

  // Following is a profile's relation to the channel, not a property of it
  // (migration 0008), so it is written separately from the channel row.
  if (options.subscribed) {
    await addSubscriptions(db, options.profileId ?? 'default', [`youtube:${channelExternalId}`], now)
  }

  const item: SourceItem = {
    externalId,
    title: options.title ?? `Video ${externalId}`,
    description: options.description ?? '',
    channelExternalId,
    channelTitle: options.channelTitle ?? channelExternalId,
    thumbnailUrl: null,
    publishedAt: new Date(options.publishedAt ?? now).toISOString(),
    durationSeconds: 600,
    viewCount: options.viewCount ?? 1_000,
    tags: options.tags ?? [],
    officialCategoryId: '28',
  }

  await upsertVideos(db, 'youtube', [item], { now })
  return `youtube:${externalId}`
}

export async function seedProfile(db: D1Database, profileId: string): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES (?1, ?1, 0)')
    .bind(profileId)
    .run()
}

/** A `fetch` that answers from a table of URL fragments, and fails loudly otherwise. */
export function stubFetch(routes: Array<[string | RegExp, unknown, number?]>): typeof fetch {
  const calls: string[] = []
  const impl = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    calls.push(url)
    for (const [pattern, body, status] of routes) {
      const matches = typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)
      if (matches) {
        return new Response(JSON.stringify(body), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
        })
      }
    }
    throw new Error(`no stub for ${url}`)
  }) as typeof fetch & { calls: string[] }
  impl.calls = calls
  return impl
}
