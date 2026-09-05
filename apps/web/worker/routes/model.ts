import { Hono } from 'hono'
import { trainRequestSchema } from '@ypr/domain'
import type { AppBindings } from './types.js'
import { activeModel, listModelVersions } from '../db/models.js'
import { countRatingsSince } from '../db/ratings.js'
import { readMarker } from '../db/settings.js'
import { MIN_TRAINING_EVENTS, NotEnoughRatings, submitTraining } from '../services/model/train.js'
import { submitScoring } from '../services/model/score.js'
import { engineConfigured, engineDescription } from '../services/runpod/engine.js'

/**
 * Training and scoring (design sections 31, 32 and 40).
 *
 * Both routes submit and return. The GPU takes minutes and the Worker has seconds, so
 * what comes back is a job id, not a result (design section 29).
 */
export const modelRoutes = new Hono<AppBindings>()

modelRoutes.get('/model', async (context) => {
  const app = context.get('app')
  const [active, versions, lastTrainedAt] = await Promise.all([
    activeModel(app.env.DB, app.profileId),
    listModelVersions(app.env.DB, app.profileId),
    readMarker(app.env.DB, app.profileId, 'lastTrainedAt'),
  ])

  const ratingsSince = await countRatingsSince(app.env.DB, app.profileId, lastTrainedAt ?? 0)

  return context.json({
    active,
    versions,
    lastTrainedAt,
    ratingsSinceLastTraining: ratingsSince,
    minimumRatings: MIN_TRAINING_EVENTS,
    engineConfigured: engineConfigured(app.env),
    engine: engineDescription(app.env),
  })
})

modelRoutes.post('/model/train', async (context) => {
  const app = context.get('app')

  const parsed = trainRequestSchema.safeParse((await context.req.json().catch(() => ({}))) ?? {})
  if (!parsed.success) {
    return context.json({ error: 'invalid request', detail: parsed.error.flatten() }, 400)
  }

  try {
    const submission = await submitTraining(app.env, app.profileId, app.now, {
      ...(parsed.data.timeBudgetSeconds
        ? { timeBudgetSeconds: parsed.data.timeBudgetSeconds }
        : {}),
    })
    return context.json(submission, 202)
  } catch (error) {
    if (error instanceof NotEnoughRatings) {
      return context.json(
        { error: error.message, have: error.have, need: error.need },
        409,
      )
    }
    return context.json({ error: describe(error) }, 502)
  }
})

/**
 * Score the backlog against the live model.
 *
 * Runs on its own as well as after a training run, because discovery keeps adding
 * videos the current model has never been asked about, and those score as "unknown"
 * until this has been through them (design section 32).
 */
modelRoutes.post('/model/score', async (context) => {
  const app = context.get('app')
  try {
    return context.json(await submitScoring(app.env, app.profileId, app.now), 202)
  } catch (error) {
    return context.json({ error: describe(error) }, 502)
  }
})

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
