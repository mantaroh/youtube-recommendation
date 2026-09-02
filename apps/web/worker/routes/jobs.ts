import { Hono } from 'hono'
import type { AppBindings } from './types.js'
import { getJob, listJobs } from '../db/jobs.js'
import { reconcileJobs } from '../services/model/reconcile.js'

/**
 * The GPU job ledger (design sections 15, 29 and 40).
 *
 * Visible to the user rather than hidden, because "the model has not updated yet" and
 * "the model failed to update" look identical from the feed, and only one of them is
 * worth doing something about.
 */
export const jobRoutes = new Hono<AppBindings>()

jobRoutes.get('/jobs', async (context) => {
  const app = context.get('app')
  return context.json({ jobs: await listJobs(app.env.DB) })
})

jobRoutes.get('/jobs/:id', async (context) => {
  const app = context.get('app')
  const job = await getJob(app.env.DB, context.req.param('id'))
  if (!job) return context.json({ error: 'not found' }, 404)
  return context.json({ job })
})

/**
 * Reconcile now instead of waiting for the cron.
 *
 * The cron runs every few hours, which is the right interval for something that costs
 * a Runpod API call per unfinished job. It is the wrong interval for someone watching
 * a training run they just started.
 */
jobRoutes.post('/jobs/poll', async (context) => {
  const app = context.get('app')
  return context.json(await reconcileJobs(app.env, app.now))
})
