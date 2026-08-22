import { Hono } from 'hono'
import { countItems, listSince, purgeExpired, upsertItems, type SyncCursor } from './catalog.js'
import { crawlMostPopular } from './youtube.js'

/**
 * The public catalog service.
 *
 * It answers one question — "what videos exist?" — and it is never told who is asking or
 * what they like. There is no request shape here that carries a preference vector, an
 * interest label or a user id, which is what makes it safe to run off the user's machine
 * (design section 1.1).
 *
 * The extension works without it. This service only saves every installation from
 * crawling the same public catalog and from holding an API key.
 */

export interface Env {
  DB: D1Database
  YOUTUBE_API_KEY?: string
  ADMIN_TOKEN?: string
  CRAWL_REGIONS?: string
  CRAWL_CATEGORIES?: string
}

const app = new Hono<{ Bindings: Env }>()

// The catalog is public data, so any origin may read it. Nothing here is user specific,
// so there is no cookie or credential to protect.
app.use('*', async (context, next) => {
  await next()
  context.res.headers.set('Access-Control-Allow-Origin', '*')
  context.res.headers.set('Access-Control-Allow-Headers', 'content-type')
})

app.get('/health', async (context) => {
  return context.json({ ok: true, items: await countItems(context.env.DB) })
})

/**
 * Incremental sync. Clients pass back the cursor from the previous page.
 *
 * Note what the request does *not* accept: no query vector, no interest, no user. A
 * client takes the catalog and does its own matching locally.
 */
app.get('/catalog/since', async (context) => {
  const updatedAt = context.req.query('updatedAt')
  const externalId = context.req.query('externalId')
  const limit = Number(context.req.query('limit') ?? '200')

  const cursor: SyncCursor | null =
    updatedAt !== undefined ? { updatedAt, externalId: externalId ?? '' } : null

  const page = await listSince(context.env.DB, cursor, Number.isFinite(limit) ? limit : 200)
  return context.json(page)
})

/** Manual crawl, for the first fill and for debugging. The cron does the same work. */
app.post('/admin/crawl', async (context) => {
  const expected = context.env.ADMIN_TOKEN
  if (!expected || context.req.header('authorization') !== `Bearer ${expected}`) {
    return context.json({ error: 'unauthorized' }, 401)
  }
  const result = await runCrawl(context.env, new Date().toISOString())
  return context.json(result)
})

export interface CrawlSummary {
  crawled: number
  stored: number
  purged: number
  requests: number
  errors: string[]
}

export async function runCrawl(env: Env, now: string): Promise<CrawlSummary> {
  const purged = await purgeExpired(env.DB, now)

  if (!env.YOUTUBE_API_KEY) {
    return { crawled: 0, stored: 0, purged, requests: 0, errors: ['YOUTUBE_API_KEY is not set'] }
  }

  const crawl = await crawlMostPopular({
    apiKey: env.YOUTUBE_API_KEY,
    regions: splitList(env.CRAWL_REGIONS, ['JP', 'US']),
    categories: splitList(env.CRAWL_CATEGORIES, ['28']),
    now,
  })

  const stored = await upsertItems(env.DB, crawl.items, now)
  return {
    crawled: crawl.items.length,
    stored,
    purged,
    requests: crawl.requests,
    errors: crawl.errors,
  }
}

function splitList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 0 ? parts : fallback
}

export default {
  fetch: app.fetch,

  /** Crawl and expiry sweep. The sweep runs even when the crawl cannot. */
  async scheduled(_event: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(runCrawl(env, new Date().toISOString()).then(() => undefined))
  },
}
