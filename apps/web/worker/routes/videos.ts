import { Hono } from 'hono'
import { rateRequestSchema } from '@ypr/domain'
import type { AppBindings } from './types.js'
import { appendRating, currentRatingFor, disableRating, listRatingHistory } from '../db/ratings.js'
import { getVideo, loadVideosWithChannels } from '../db/videos.js'
import { activeModel, scoresFor } from '../db/models.js'

/**
 * One video, and rating it (design sections 30, 37 and 40).
 *
 * Rating does not start a GPU run. It appends a row and returns; training happens
 * later, on a threshold or a schedule (design section 30). That is what makes the star
 * control feel immediate and what keeps a rating from costing GPU minutes.
 */
export const videoRoutes = new Hono<AppBindings>()

videoRoutes.get('/videos/:id', async (context) => {
  const app = context.get('app')
  const id = context.req.param('id')

  const [loaded] = await loadVideosWithChannels(app.env.DB, [id])
  if (!loaded) return context.json({ error: 'not found' }, 404)

  const model = await activeModel(app.env.DB, app.profileId)
  const modelVersion = model ? `model-${model.version}` : null
  const scores = modelVersion
    ? await scoresFor(app.env.DB, app.profileId, modelVersion)
    : new Map<string, number>()

  return context.json({
    video: loaded.video,
    channel: loaded.channel,
    rating: await currentRatingFor(app.env.DB, app.profileId, id),
    history: await listRatingHistory(app.env.DB, app.profileId, id),
    predictedScore: scores.get(id) ?? null,
    modelVersion,
  })
})

videoRoutes.post('/videos/:id/rating', async (context) => {
  const app = context.get('app')
  const id = context.req.param('id')

  const body = await context.req.json().catch(() => null)
  const parsed = rateRequestSchema.safeParse(body)
  if (!parsed.success) {
    return context.json({ error: 'invalid rating', detail: parsed.error.flatten() }, 400)
  }

  // A rating has a foreign key to `videos`, so a video that is not in the catalog
  // cannot be rated. Reporting that plainly is better than a constraint violation.
  const video = await getVideo(app.env.DB, id)
  if (!video) return context.json({ error: 'unknown video' }, 404)

  const event = await appendRating(app.env.DB, {
    id: crypto.randomUUID(),
    profileId: app.profileId,
    videoId: id,
    rating: parsed.data.rating,
    createdAt: app.now,
  })

  return context.json({ event }, 201)
})

/**
 * Retract one rating event.
 *
 * Not a delete: the row stays and is marked disabled, so the record of having held
 * that opinion survives changing your mind about it (design section 11).
 */
videoRoutes.delete('/videos/:id/rating/:eventId', async (context) => {
  const app = context.get('app')
  await disableRating(app.env.DB, app.profileId, context.req.param('eventId'), app.now)
  return context.json({
    rating: await currentRatingFor(app.env.DB, app.profileId, context.req.param('id')),
  })
})
