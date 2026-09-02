import type { EpochMillis } from '@ypr/domain'
import { DEFAULT_PROFILE_ID } from '@ypr/domain'
import type { Env } from '../env.js'
import { runDiscovery, syncSubscriptions } from '../services/discovery/index.js'
import { reconcileJobs } from '../services/model/reconcile.js'
import { submitScoring } from '../services/model/score.js'
import { NotEnoughRatings, submitTraining } from '../services/model/train.js'
import { backupToR2 } from '../services/backup/export.js'
import { purgeExpiredStates } from '../services/youtube/oauth.js'
import { loadSettings, readMarker, writeMarker } from '../db/settings.js'
import { countRatingsSince } from '../db/ratings.js'
import { activeModel } from '../db/models.js'

/**
 * Scheduled work (design section 41).
 *
 * Which task runs is decided from the hour rather than by registering five separate
 * cron expressions, because Cloudflare gives one `scheduled` handler for all of them
 * and dispatching on the expression string would tie the code to the exact text in
 * `wrangler.jsonc`.
 *
 * The design's timetable, in UTC:
 *
 * ```text
 * 00:00  subscriptions refresh
 * 06:00  interest-based discovery
 * 12:00  subscriptions refresh
 * 18:00  Runpod pending job check
 * weekly model retraining check
 * ```
 */

export interface ScheduledSummary {
  task: string
  detail: unknown
}

export async function runScheduled(env: Env, now: EpochMillis): Promise<ScheduledSummary[]> {
  const hour = new Date(now).getUTCHours()
  const day = new Date(now).getUTCDay()
  const summaries: ScheduledSummary[] = []
  const profileId = DEFAULT_PROFILE_ID

  // Cheap, and worth doing on every run: expired redirect state is a table that only
  // ever grows otherwise.
  await purgeExpiredStates(env.DB, now)

  if (hour === 0 || hour === 12) {
    summaries.push({ task: 'subscriptions', detail: await refreshSubscriptions(env, profileId, now) })
  }

  if (hour === 6) {
    summaries.push({
      task: 'discovery',
      detail: await runDiscovery(env, profileId, now, { lanes: ['related', 'explore'] }),
    })
    // New candidates are unscored, and an unscored video ranks as merely average. This
    // is what turns a discovery run into something the feed can act on.
    summaries.push({ task: 'scoring', detail: await scoreQuietly(env, profileId, now) })
  }

  if (hour === 18) {
    summaries.push({ task: 'jobs', detail: await reconcileJobs(env, now) })
  }

  // Weekly, on Sunday, alongside the job check.
  if (day === 0 && hour === 18) {
    summaries.push({ task: 'retrain', detail: await maybeRetrain(env, profileId, now) })
    summaries.push({ task: 'backup', detail: await backupToR2(env, profileId, now) })
  }

  return summaries
}

async function refreshSubscriptions(
  env: Env,
  profileId: string,
  now: EpochMillis,
): Promise<unknown> {
  // The subscription list itself changes on the scale of weeks; new uploads appear
  // hourly. Only the walk runs twice a day, and the list is pulled once.
  const synced = new Date(now).getUTCHours() === 0 ? await syncSubscriptions(env, profileId, now) : null
  const discovered = await runDiscovery(env, profileId, now, { lanes: ['subscription'] })
  return { synced, discovered }
}

/**
 * Retrain when there is enough new evidence, or when the model is old (design section 31).
 *
 * Both conditions matter. Twenty new ratings is a change of taste worth learning; a
 * week without any is a model that has stopped tracking a taste that has not stopped
 * moving. Neither alone catches both cases.
 */
async function maybeRetrain(env: Env, profileId: string, now: EpochMillis): Promise<unknown> {
  const settings = await loadSettings(env.DB, profileId)
  const lastTrainedAt = await readMarker(env.DB, profileId, 'lastTrainedAt')
  const model = await activeModel(env.DB, profileId)

  const newRatings = await countRatingsSince(env.DB, profileId, lastTrainedAt ?? 0)
  const staleDays = lastTrainedAt === null ? Infinity : (now - lastTrainedAt) / 86_400_000

  const enoughRatings = newRatings >= settings.retrainAfterRatings
  const oldEnough = model !== null && staleDays >= settings.retrainAfterDays
  const neverTrained = model === null

  if (!enoughRatings && !oldEnough && !neverTrained) {
    return { skipped: true, newRatings, staleDays }
  }

  try {
    const submission = await submitTraining(env, profileId, now)
    await writeMarker(env.DB, profileId, 'lastTrainedAt', now, now)
    return { submitted: true, ...submission }
  } catch (error) {
    if (error instanceof NotEnoughRatings) {
      return { skipped: true, reason: error.message }
    }
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Scoring is best-effort on a schedule.
 *
 * Runpod being unreachable should not fail a cron run that also refreshed
 * subscriptions successfully; the feed keeps working from the scores it already has
 * (design section 49).
 */
async function scoreQuietly(env: Env, profileId: string, now: EpochMillis): Promise<unknown> {
  try {
    return await submitScoring(env, profileId, now)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
