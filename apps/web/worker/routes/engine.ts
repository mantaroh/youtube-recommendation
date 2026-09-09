import { Hono } from 'hono'
import type { ClaimResponse, EpochMillis } from '@ypr/domain'
import { JOB_LEASE_MINUTES } from '@ypr/domain'
import type { Env } from '../env.js'
import { claimNextJob, getJob, markCompleted } from '../db/jobs.js'
import { applyResult, failJob } from '../services/model/reconcile.js'
import { buildJobPayload, PayloadUnavailable } from '../services/model/payload.js'
import { enginePulls } from '../services/runpod/engine.js'

/**
 * Where a runner comes to collect work (`docs/design/pull-engine.ja.md`).
 *
 * These three routes are the only part of the application reachable without an Access
 * session, so the surface is kept to exactly what a runner needs: take a job, report a
 * result, report a failure. There is no way from here to read the feed, the ratings or
 * the settings.
 *
 * That still means the bearer token is worth protecting. A claim returns the titles and
 * descriptions of rated videos, because that is what the engine learns from — so a
 * leaked token leaks those.
 */
export const engineRoutes = new Hono<{ Bindings: Env }>()

/**
 * Constant-time comparison.
 *
 * Comparing with `===` returns as soon as two bytes differ, and the time that takes is
 * measurable across enough requests. It is a small risk for a token nobody is
 * deliberately attacking, and a cheap one to remove.
 */
function tokenMatches(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false
  let difference = 0
  for (let index = 0; index < presented.length; index++) {
    difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  return difference === 0
}

engineRoutes.use('/engine/*', async (context, next) => {
  const expected = context.env.ENGINE_PULL_TOKEN
  // Not in pull mode: the routes do not exist rather than sit there refusing.
  if (!expected || !enginePulls(context.env)) return context.json({ error: 'not found' }, 404)

  const header = context.req.header('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
  // No reason is given: telling a caller whether the token was absent, the wrong length
  // or merely wrong is telling them how to get closer.
  if (!presented || !tokenMatches(presented, expected)) return context.json({ error: 'forbidden' }, 403)

  await next()
})

/** Takes the oldest queued job, or reports that there is none. */
engineRoutes.post('/engine/claim', async (context) => {
  const now: EpochMillis = Date.now()
  const leaseMs = JOB_LEASE_MINUTES * 60_000

  // A payload that cannot be assembled fails its job and the next one is tried, so a
  // single unbuildable job does not block the queue behind it.
  for (let attempt = 0; attempt < 5; attempt++) {
    const job = await claimNextJob(context.env.DB, { now, leaseMs })
    if (!job) return context.json<ClaimResponse>({ job: null })

    try {
      const payload = await buildJobPayload(context.env.DB, job)
      return context.json<ClaimResponse>({
        job: {
          id: job.id,
          operation: job.type === 'train' ? 'train' : 'score_batch',
          payload,
          leaseExpiresAt: now + leaseMs,
        },
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await failJob(context.env, job, message, now)
      if (!(error instanceof PayloadUnavailable)) throw error
    }
  }

  return context.json<ClaimResponse>({ job: null })
})

engineRoutes.post('/engine/jobs/:id/result', async (context) => {
  const now: EpochMillis = Date.now()
  const job = await getJob(context.env.DB, context.req.param('id'))
  if (!job) return context.json({ error: 'not found' }, 404)

  // A lease that expired was handed to somebody else. Accepting the late answer would
  // apply a result the current claimant is about to overwrite.
  if (job.status !== 'processing') {
    return context.json({ error: 'not held', status: job.status }, 409)
  }

  const output = await context.req.json().catch(() => null)
  if (output === null) return context.json({ error: 'malformed body' }, 400)

  try {
    const applied = await applyResult(context.env, job, output, now)
    await markCompleted(context.env.DB, job.id, now)
    return context.json({ ok: true, ...applied })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await failJob(context.env, job, message, now)
    return context.json({ error: message }, 400)
  }
})

engineRoutes.post('/engine/jobs/:id/fail', async (context) => {
  const now: EpochMillis = Date.now()
  const job = await getJob(context.env.DB, context.req.param('id'))
  if (!job) return context.json({ error: 'not found' }, 404)

  const body = (await context.req.json().catch(() => ({}))) as { error?: unknown }
  const message = typeof body.error === 'string' ? body.error : 'runner reported a failure'

  await failJob(context.env, job, message, now)
  return context.json({ ok: true })
})

/**
 * What the runner needs to know before it starts: is there anything to do at all.
 *
 * Broken down by profile because one runner serves all of them, and a total on its own
 * hides the case worth seeing — one account's queue draining while another's stands
 * still. It previously reported the default profile's name beside a count of every
 * profile's work, which was simply wrong once there was more than one.
 */
engineRoutes.get('/engine/status', async (context) => {
  const { results } = await context.env.DB.prepare(
    `SELECT COALESCE(json_extract(context_json, '$.profileId'), 'unknown') AS profile_id,
            type,
            COUNT(*) AS queued
       FROM gpu_jobs
      WHERE status = 'queued'
      GROUP BY profile_id, type`,
  ).all<{ profile_id: string; type: string; queued: number }>()

  const rows = results ?? []
  const byProfile: Record<string, Record<string, number>> = {}
  let queued = 0
  for (const row of rows) {
    byProfile[row.profile_id] ??= {}
    byProfile[row.profile_id][row.type] = row.queued
    queued += row.queued
  }

  return context.json({ queued, byProfile })
})
