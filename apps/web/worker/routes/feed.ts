import { Hono } from 'hono'
import { feedQuerySchema } from '@ypr/domain'
import type { AppBindings } from './types.js'
import { buildFeed } from '../services/recommendation/feed.js'
import { recordImpressions } from '../db/ratings.js'

/**
 * `GET /api/feed` (design sections 33 and 40).
 *
 * Reads cached scores and returns. There is no GPU call on this path and no model in
 * the request, which is what lets the feed keep working while Runpod is asleep, down,
 * or has never been configured at all (design section 49).
 */
export const feedRoutes = new Hono<AppBindings>()

feedRoutes.get('/feed', async (context) => {
  const parsed = feedQuerySchema.safeParse({
    lane: context.req.query('lane'),
    limit: context.req.query('limit'),
  })
  if (!parsed.success) {
    return context.json({ error: 'invalid query', detail: parsed.error.flatten() }, 400)
  }

  const app = context.get('app')
  const feed = await buildFeed(app.env.DB, {
    profileId: app.profileId,
    now: app.now,
    ...(parsed.data.lane ? { lane: parsed.data.lane } : {}),
    ...(parsed.data.limit ? { limit: parsed.data.limit } : {}),
  })

  // Recorded after the feed is built, not when a card scrolls into view. The design's
  // `seen_penalty` is about not offering the same video every day; that is answered by
  // "was it in a feed", and a viewport-accurate answer would need the browser to report
  // back on every scroll for a penalty that does not need the precision.
  context.executionCtx.waitUntil(
    recordImpressions(
      app.env.DB,
      app.profileId,
      feed.items.map((item) => ({ videoId: item.video.id, lane: item.lane })),
      app.now,
    ),
  )

  return context.json(feed)
})
