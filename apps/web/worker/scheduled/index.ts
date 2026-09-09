import type { EpochMillis } from '@ypr/domain'
import { DEFAULT_PROFILE_ID, DISCOVERY_SEARCH_BUDGET } from '@ypr/domain'
import type { Env } from '../env.js'
import { backfillThumbnails, runDiscovery, syncSubscriptions } from '../services/discovery/index.js'
import { reconcileJobs } from '../services/model/reconcile.js'
import { submitScoring } from '../services/model/score.js'
import { NotEnoughRatings, submitTraining } from '../services/model/train.js'
import { backupToR2 } from '../services/backup/export.js'
import { purgeExpiredStates } from '../services/youtube/oauth.js'
import { listProfiles, loadSettings, readMarker, writeMarker } from '../db/settings.js'
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
  /** Absent on work that is not per-profile, such as reconciling the job ledger. */
  profileId?: string
  detail: unknown
}

/**
 * The search allowance one profile may spend today.
 *
 * `api_quota_usage` is keyed by day and operation, not by profile, and that is correct:
 * the quota belongs to the API key, which every profile shares. But it means an
 * undivided budget is spent by whichever profile the loop reaches first, and the others
 * find nothing left — one account's recommendations grow while the other's stand still.
 *
 * Dividing it means both move every day, more slowly. At least one call each, so a
 * third profile does not silently reduce everyone to zero.
 */
function searchBudgetPerProfile(env: Env, profileCount: number): number {
  const ceiling = Number(env.DISCOVERY_SEARCH_BUDGET ?? DISCOVERY_SEARCH_BUDGET)
  return Math.max(1, Math.floor(ceiling / Math.max(1, profileCount)))
}

export async function runScheduled(env: Env, now: EpochMillis): Promise<ScheduledSummary[]> {
  const hour = new Date(now).getUTCHours()
  const day = new Date(now).getUTCDay()
  const summaries: ScheduledSummary[] = []

  // Cheap, and worth doing on every run: expired redirect state is a table that only
  // ever grows otherwise.
  await purgeExpiredStates(env.DB, now)

  const profiles = await listProfiles(env.DB)
  // A database with no profile row yet still has work to do on the default one — the
  // row is written by the first request, and the cron can fire before that.
  const targets = profiles.length > 0 ? profiles : [DEFAULT_PROFILE_ID]

  for (const profileId of targets) {
    if (hour === 0 || hour === 12) {
      summaries.push({
        task: 'subscriptions',
        profileId,
        detail: await refreshSubscriptions(env, profileId, now),
      })
    }

    if (hour === 6) {
      summaries.push({
        task: 'discovery',
        profileId,
        detail: await runDiscovery(env, profileId, now, {
          lanes: ['related', 'explore'],
          searchBudget: searchBudgetPerProfile(env, targets.length),
        }),
      })
      // New candidates are unscored, and an unscored video ranks as merely average. This
      // is what turns a discovery run into something the feed can act on.
      summaries.push({ task: 'scoring', profileId, detail: await scoreQuietly(env, profileId, now) })
    }

    // Weekly, on Sunday, alongside the job check.
    if (day === 0 && hour === 18) {
      summaries.push({ task: 'retrain', profileId, detail: await maybeRetrain(env, profileId, now) })
      summaries.push({ task: 'backup', profileId, detail: await backupToR2(env, profileId, now) })
    }
  }

  // Once, not per profile: the catalog is shared, and a row missing its thumbnail is
  // missing it for everyone.
  if (hour === 12) {
    summaries.push({ task: 'thumbnails', detail: await backfillThumbnails(env, now) })
  }

  // Once, not per profile: the job ledger is shared, and reconciliation works on rows
  // rather than on a profile's data.
  if (hour === 18) {
    summaries.push({ task: 'jobs', detail: await reconcileJobs(env, now) })
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
