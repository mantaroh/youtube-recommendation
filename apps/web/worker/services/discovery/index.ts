import type { AppSettings, EpochMillis, Lane, SourceItem } from '@ypr/domain'
import {
  DISCOVERY_INTEREST_CLUSTERS,
  DISCOVERY_QUERIES_PER_INTEREST,
  DISCOVERY_SEARCH_BUDGET,
} from '@ypr/domain'
import type { Env } from '../../env.js'
import { splitList } from '../../env.js'
import { recordUsage, SearchBudget } from '../../db/quota.js'
import { loadSettings } from '../../db/settings.js'
import {
  channelsFromItems,
  listChannelsToRefresh,
  markChannelsFetched,
  setSubscribed,
  upsertChannels,
  upsertVideos,
} from '../../db/videos.js'
import { YouTubeClient, YouTubeError } from '../youtube/client.js'
import { youtubeCredentials } from '../youtube/credentials.js'
import { adjacentTopics, interestTerms, type RatedText } from './keywords.js'

/**
 * Candidate discovery (design sections 17 through 20).
 *
 * Three passes with different costs and different purposes:
 *
 * - Subscription, one quota unit per channel, walking uploads playlists. The cheapest
 *   and the highest priority (design section 18).
 * - Related, a hundred units per call, searching for what the user already rates
 *   highly (design section 19).
 * - Explore, the same price, searching one topic sideways from those (design section 20).
 *
 * The last two share a daily budget of thirty calls against an allowance of a hundred,
 * so that a manual search is always still possible (design section 42).
 */

export interface DiscoverySummary {
  lane: Lane
  queries: string[]
  found: number
  stored: number
  searchCalls: number
  listCalls: number
  errors: string[]
}

export interface DiscoveryResult {
  summaries: DiscoverySummary[]
  searchBudgetLeft: number
}

export async function runDiscovery(
  env: Env,
  profileId: string,
  now: EpochMillis,
  options: { lanes?: Lane[]; searchBudget?: number; fetchImpl?: typeof fetch } = {},
): Promise<DiscoveryResult> {
  const lanes = options.lanes ?? ['subscription', 'related', 'explore']
  const summaries: DiscoverySummary[] = []

  const budgetCeiling =
    options.searchBudget ?? Number(env.DISCOVERY_SEARCH_BUDGET ?? DISCOVERY_SEARCH_BUDGET)
  const budget = await SearchBudget.open(env.DB, budgetCeiling, now)

  if (lanes.includes('subscription')) {
    summaries.push(await discoverSubscriptions(env, profileId, now, options))
  }

  const settings = await loadSettings(env.DB, profileId)

  if (lanes.includes('related') || lanes.includes('explore')) {
    const seeds = await seedTerms(env.DB, profileId)

    if (lanes.includes('related')) {
      const terms = seeds.slice(0, DISCOVERY_QUERIES_PER_INTEREST * 2)
      summaries.push(await discoverBySearch(env, profileId, 'related', terms, budget, now, settings, options))
    }

    if (lanes.includes('explore')) {
      // The neighbour is the search query, so it has to be written in the language the
      // user actually watches. Seeds are often English even for a Japanese viewer,
      // because tags frequently are, which is why the setting decides rather than the
      // seeds alone.
      const preferred = settings.language === 'ja' ? 'ja' : 'latin'
      const terms = adjacentTopics(seeds, DISCOVERY_QUERIES_PER_INTEREST, preferred)
      summaries.push(await discoverBySearch(env, profileId, 'explore', terms, budget, now, settings, options))

      // The popularity chart costs one unit per region and category and no search call
      // at all, so it runs alongside the searches rather than instead of them. It is
      // also the only pass that works before anything has been rated: without it a new
      // installation discovers nothing until the first ratings exist.
      summaries.push(await discoverPopular(env, profileId, settings, now, options))
    }
  }

  const left = budget.left
  await budget.close()
  return { summaries, searchBudgetLeft: left }
}

/**
 * New uploads from subscribed channels (design section 18).
 *
 * A channel's uploads playlist costs one unit to read, so this walks a fixed number of
 * channels per run and rotates through them by staleness. Forty channels four times a
 * day is 160 units against an allowance of ten thousand.
 */
export async function discoverSubscriptions(
  env: Env,
  profileId: string,
  now: EpochMillis,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<DiscoverySummary> {
  const summary: DiscoverySummary = {
    lane: 'subscription',
    queries: [],
    found: 0,
    stored: 0,
    searchCalls: 0,
    listCalls: 0,
    errors: [],
  }

  const credentials = await youtubeCredentials(env, now, options.fetchImpl, profileId)
  if (!credentials.apiKey && !credentials.accessToken) {
    summary.errors.push('no YouTube credentials configured')
    return summary
  }

  const client = new YouTubeClient({
    ...credentials,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })

  const perRun = Number(env.CRAWL_CHANNELS_PER_RUN ?? '40')
  const perChannel = Number(env.CRAWL_UPLOADS_PER_CHANNEL ?? '5')
  const channels = await listChannelsToRefresh(env.DB, perRun)

  if (channels.length === 0) {
    summary.errors.push('no subscribed channels: connect a YouTube account first')
    return summary
  }

  const videoIds = new Set<string>()
  for (const channel of channels) {
    try {
      for (const id of await client.listChannelUploads(channel.externalId, perChannel)) {
        videoIds.add(id)
      }
    } catch (error) {
      // A deleted channel or hidden uploads is not a fault worth failing the run over.
      if (error instanceof YouTubeError && error.status === 404) continue
      summary.errors.push(`${channel.externalId}: ${describe(error)}`)
    }
  }

  const items = videoIds.size > 0 ? await client.listVideos([...videoIds]) : []
  summary.found = items.length
  summary.stored = await store(env, profileId, items, 'subscription')
  await markChannelsFetched(env.DB, channels.map((channel) => channel.id), now)

  summary.listCalls = client.tally.list
  await recordUsage(env.DB, 'list', client.tally.list, now)
  return summary
}

/**
 * The public popularity chart for the user's own region (design section 42's cheap half).
 *
 * A `videos.list` call with a `chart` parameter, so it costs one unit and never touches
 * the search allowance. It asks nothing about anyone's preferences — which is what makes
 * it the right pass to run when there are no preferences yet.
 */
export async function discoverPopular(
  env: Env,
  profileId: string,
  settings: AppSettings,
  now: EpochMillis,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<DiscoverySummary> {
  const summary: DiscoverySummary = {
    lane: 'explore',
    queries: [],
    found: 0,
    stored: 0,
    searchCalls: 0,
    listCalls: 0,
    errors: [],
  }

  const credentials = await youtubeCredentials(env, now, options.fetchImpl, profileId)
  if (!credentials.apiKey && !credentials.accessToken) {
    summary.errors.push('no YouTube credentials configured')
    return summary
  }

  const client = new YouTubeClient({
    ...credentials,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })

  // The configured region first, then whatever else `CRAWL_REGIONS` lists. Ordering
  // matters because the two overlap heavily and the first pass is the one whose videos
  // are stored with the earlier `discovered_at`.
  const regions = [settings.region, ...splitList(env.CRAWL_REGIONS, [])].filter(
    (region, index, all) => all.indexOf(region) === index,
  )
  const categories = splitList(env.CRAWL_CATEGORIES, ['28'])

  const items: SourceItem[] = []
  for (const region of regions) {
    for (const category of categories) {
      summary.queries.push(`${region}/${category}`)
      try {
        items.push(...(await client.listMostPopular(region, category)))
      } catch (error) {
        summary.errors.push(`${region}/${category}: ${describe(error)}`)
      }
    }
  }

  summary.found = items.length
  summary.stored = await store(env, profileId, items, 'explore', `chart:${regions.join(',')}`)
  summary.listCalls = client.tally.list
  await recordUsage(env.DB, 'list', client.tally.list, now)
  return summary
}

async function discoverBySearch(
  env: Env,
  profileId: string,
  lane: Lane,
  terms: string[],
  budget: SearchBudget,
  now: EpochMillis,
  settings: AppSettings,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<DiscoverySummary> {
  const summary: DiscoverySummary = {
    lane,
    queries: [],
    found: 0,
    stored: 0,
    searchCalls: 0,
    listCalls: 0,
    errors: [],
  }

  if (terms.length === 0) {
    summary.errors.push('no interest terms yet: rate a few videos first')
    return summary
  }

  const credentials = await youtubeCredentials(env, now, options.fetchImpl, profileId)
  if (!credentials.apiKey && !credentials.accessToken) {
    summary.errors.push('no YouTube credentials configured')
    return summary
  }

  const client = new YouTubeClient({
    ...credentials,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })

  const ids = new Set<string>()
  for (const term of terms) {
    // Checked before the call, not after. Finding out the allowance is gone by getting
    // a 403 means the call has already been spent (design section 42).
    if (!budget.take()) {
      summary.errors.push(`search budget exhausted before "${term}"`)
      break
    }
    summary.queries.push(term)
    try {
      const found = await client.searchIds(term, {
        maxResults: 25,
        // The explore lane asks for recent rather than most relevant: relevance to a
        // topic the user has never rated returns the same canonical videos every run.
        order: lane === 'explore' ? 'date' : 'relevance',
        publishedAfter: new Date(now - 90 * 86_400_000).toISOString(),
        // Both are relevance biases, not filters, so content in other languages still
        // appears. Omitting them lets YouTube infer a region from the caller's address,
        // which for a Worker is whichever Cloudflare edge took the request.
        regionCode: settings.region,
        relevanceLanguage: settings.language,
      })
      for (const id of found) ids.add(id)
    } catch (error) {
      summary.errors.push(`${term}: ${describe(error)}`)
    }
  }

  const items = ids.size > 0 ? await client.listVideos([...ids]) : []
  summary.found = items.length
  summary.stored = await store(env, profileId, items, lane, summary.queries.join(' | '))

  summary.searchCalls = client.tally.search
  summary.listCalls = client.tally.list
  await recordUsage(env.DB, 'list', client.tally.list, now)
  return summary
}

/**
 * Store what a pass found.
 *
 * Channels first: videos carry a foreign key to `channels`, and a search result from a
 * channel that is not yet a row would otherwise be rejected.
 */
async function store(
  env: Env,
  profileId: string,
  items: SourceItem[],
  lane: Lane,
  query?: string,
): Promise<number> {
  if (items.length === 0) return 0
  const now = Date.now()
  await upsertChannels(env.DB, 'youtube', channelsFromItems(items))
  return upsertVideos(env.DB, 'youtube', items, {
    now,
    profileId,
    discoveredBy: lane,
    ...(query ? { discoveryQuery: query } : {}),
  })
}

/**
 * Replace the stored subscription list with what YouTube reports (design section 16).
 *
 * Separate from the upload walk because it needs the OAuth token and the walk does
 * not, and because it should run rarely: subscriptions change on the scale of weeks.
 */
export async function syncSubscriptions(
  env: Env,
  profileId: string,
  now: EpochMillis,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<{ channels: number; errors: string[] }> {
  const credentials = await youtubeCredentials(env, now, options.fetchImpl, profileId)
  if (!credentials.accessToken) {
    return { channels: 0, errors: ['no YouTube account connected'] }
  }

  const client = new YouTubeClient({
    ...credentials,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  })

  try {
    const channels = await client.listSubscriptions()
    // The channel row and the subscription are written separately now: the first is a
    // catalog fact shared by every profile, the second belongs to this account alone.
    await upsertChannels(env.DB, 'youtube', channels)
    await setSubscribed(
      env.DB,
      profileId,
      channels.map((channel) => `youtube:${channel.externalId}`),
      now,
    )
    await recordUsage(env.DB, 'subscriptions', client.tally.list, now)
    return { channels: channels.length, errors: [] }
  } catch (error) {
    return { channels: 0, errors: [describe(error)] }
  }
}

/**
 * Seed terms for the search lanes.
 *
 * Drawn from what the user rates highly, capped at the ten interest clusters design
 * section 42 budgets for. Explicit interest controls with a boosted weight are added
 * ahead of them: a keyword the user typed is a stronger statement about what they want
 * than one inferred from tags.
 */
async function seedTerms(db: D1Database, profileId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT v.title AS title, v.metadata_json AS metadata_json, c.title AS channel_title,
              r.rating AS rating
       FROM rating_events r
       JOIN videos v ON v.id = r.video_id
       LEFT JOIN channels c ON c.id = v.channel_id
       WHERE r.profile_id = ?1 AND r.disabled_at IS NULL AND r.rating >= 3
       ORDER BY r.created_at DESC
       LIMIT 200`,
    )
    .bind(profileId)
    .all<{ title: string; metadata_json: string | null; channel_title: string | null; rating: number }>()

  const rated: RatedText[] = (results ?? []).map((row) => {
    let tags: string[] = []
    if (row.metadata_json) {
      try {
        tags = (JSON.parse(row.metadata_json) as { tags?: string[] }).tags ?? []
      } catch {
        tags = []
      }
    }
    return { title: row.title, tags, channelTitle: row.channel_title, rating: row.rating }
  })

  const { results: boosted } = await db
    .prepare(
      `SELECT keyword FROM interest_controls
       WHERE profile_id = ?1 AND weight > 1 AND (mute_until IS NULL OR mute_until < ?2)
       ORDER BY weight DESC LIMIT 5`,
    )
    .bind(profileId, Date.now())
    .all<{ keyword: string }>()

  const explicit = (boosted ?? []).map((row) => row.keyword.toLowerCase())
  const inferred = interestTerms(rated, DISCOVERY_INTEREST_CLUSTERS)

  const seen = new Set<string>()
  return [...explicit, ...inferred].filter((term) => {
    if (seen.has(term)) return false
    seen.add(term)
    return true
  })
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { splitList }
