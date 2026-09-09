import { Hono } from 'hono'
import { discoveryRunRequestSchema, SEARCH_QUOTA_PER_DAY } from '@ypr/domain'
import type { AppBindings } from './types.js'
import { runDiscovery, syncSubscriptions } from '../services/discovery/index.js'
import { usedToday } from '../db/quota.js'
import { listChannels } from '../db/videos.js'

/**
 * Discovery (design sections 17 through 20, 40 and 42).
 *
 * Runs on demand as well as on the cron, because the first useful thing a new
 * installation can do is fill its catalog, and waiting six hours for a schedule is a
 * poor first impression.
 */
export const discoveryRoutes = new Hono<AppBindings>()

discoveryRoutes.post('/discovery/run', async (context) => {
  const app = context.get('app')
  const parsed = discoveryRunRequestSchema.safeParse(
    (await context.req.json().catch(() => ({}))) ?? {},
  )
  if (!parsed.success) {
    return context.json({ error: 'invalid request', detail: parsed.error.flatten() }, 400)
  }

  const result = await runDiscovery(app.env, app.profileId, app.now, {
    ...(parsed.data.lanes ? { lanes: parsed.data.lanes } : {}),
    ...(parsed.data.searchBudget !== undefined ? { searchBudget: parsed.data.searchBudget } : {}),
  })
  return context.json(result)
})

/** Pull the subscription list from YouTube and replace what is stored. */
discoveryRoutes.post('/discovery/subscriptions', async (context) => {
  const app = context.get('app')
  return context.json(await syncSubscriptions(app.env, app.profileId, app.now))
})

discoveryRoutes.get('/channels', async (context) => {
  const app = context.get('app')
  return context.json({ channels: await listChannels(app.env.DB, app.profileId) })
})

/** What is left of today's search allowance (design section 42). */
discoveryRoutes.get('/quota', async (context) => {
  const app = context.get('app')
  const [search, list] = await Promise.all([
    usedToday(app.env.DB, 'search', app.now),
    usedToday(app.env.DB, 'list', app.now),
  ])
  return context.json({
    search: { used: search, allowance: SEARCH_QUOTA_PER_DAY },
    list: { used: list },
  })
})
