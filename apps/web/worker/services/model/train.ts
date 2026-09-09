import type { EpochMillis, TrainPayload, TrainEvent } from '@ypr/domain'
import { modelVersionName, toEngineRating, TRAIN_TIME_BUDGET_SECONDS } from '@ypr/domain'
import type { Env } from '../../env.js'
import { createJob, findJobByHash, markSubmitted, payloadHash } from '../../db/jobs.js'
import { createModelVersion, nextVersionNumber } from '../../db/models.js'
import { currentRatings } from '../../db/ratings.js'
import { loadVideosWithChannels } from '../../db/videos.js'
import { ENGINE_NOT_CONFIGURED, engineClient, engineConfigured, enginePulls } from '../runpod/engine.js'
import { videoText } from './text.js'

/**
 * Submitting a training run (design sections 24 and 31).
 *
 * The training set is built from the *current* rating of each video, not from every
 * event. That is not a contradiction of the append-only rule: the log keeps both
 * ratings so that a change of mind stays visible, but a model trained on a rating the
 * user has since replaced would be learning something they no longer think. Design
 * section 11 makes exactly this distinction — keep both, treat the newest as current.
 */

export interface TrainSubmission {
  jobId: string
  modelVersionId: string
  modelVersion: string
  eventCount: number
  /** Set when an identical run was already in flight and this one was not submitted. */
  deduplicatedFrom?: string
}

export class NotEnoughRatings extends Error {
  constructor(readonly have: number, readonly need: number) {
    super(`training needs at least ${need} ratings, have ${have}`)
    this.name = 'NotEnoughRatings'
  }
}

/**
 * The floor below which a training run is not worth its GPU minutes.
 *
 * Ten is low: enough to be reached in one sitting, and enough for the engine to learn
 * a usable separation. Measured — twelve ratings produced a model that scored two
 * held-out items it should want at 9.65 and 9.04, and two it should not at 1.22 and
 * 1.21.
 *
 * An earlier run at the same twelve produced a model that predicted one constant for
 * everything, and the cause was not the rating count: that run had been cut off by too
 * short a time budget, reaching epoch 10 against this one's 44. See
 * `TRAIN_TIME_BUDGET_SECONDS`, and note that a truncated run still reports success.
 */
export const MIN_TRAINING_EVENTS = 10

export async function submitTraining(
  env: Env,
  profileId: string,
  now: EpochMillis,
  options: { fetchImpl?: typeof fetch; timeBudgetSeconds?: number } = {},
): Promise<TrainSubmission> {
  if (!engineConfigured(env)) throw new Error(ENGINE_NOT_CONFIGURED)

  const events = await buildTrainingSet(env.DB, profileId)
  if (events.length < MIN_TRAINING_EVENTS) {
    throw new NotEnoughRatings(events.length, MIN_TRAINING_EVENTS)
  }

  // The version number is deliberately not part of the hash. It is the *name of the
  // output*, not an input: the same ratings produce the same model whether it is
  // called `model-2` or `model-3`, and including it would mean a second press of
  // "retrain" never matched the first — which is the case the check exists for.
  const hash = await payloadHash({
    type: 'train',
    profileId,
    modelVersion: '',
    ids: events.map((event) => `${event.itemId}:${event.rating}`),
  })

  // The same ratings produce the same model, so a second press of "retrain" with
  // nothing rated in between is work already being done (design section 47).
  const existing = await findJobByHash(env.DB, hash)
  if (existing && existing.status !== 'failed') {
    return {
      jobId: existing.id,
      modelVersionId: existing.context.modelVersionId ?? '',
      modelVersion: existing.context.modelVersion ?? '',
      eventCount: events.length,
      deduplicatedFrom: existing.id,
    }
  }

  // Claimed only once the work is going ahead, so a deduplicated call does not burn a
  // version number on a run that never happens.
  const version = await nextVersionNumber(env.DB, profileId)
  const modelVersion = modelVersionName(version)

  const modelVersionId = crypto.randomUUID()
  await createModelVersion(env.DB, {
    id: modelVersionId,
    profileId,
    version,
    trainingEventCount: events.length,
    now,
  })

  const jobId = crypto.randomUUID()
  await createJob(env.DB, {
    id: jobId,
    type: 'train',
    payloadHash: hash,
    context: { profileId, modelVersion, modelVersionId },
    now,
  })

  // Nothing is sent anywhere when a runner collects the work instead. The job stays
  // queued, and its payload is assembled when someone comes for it.
  if (enginePulls(env)) {
    return { jobId, modelVersionId, modelVersion, eventCount: events.length }
  }

  const payload: TrainPayload = {
    profile: profileId,
    modelVersion,
    events,
    timeBudgetSeconds: options.timeBudgetSeconds ?? TRAIN_TIME_BUDGET_SECONDS,
  }

  const client = engineClient(env, options.fetchImpl)

  const runpodJobId = await client.run('train', payload)
  await markSubmitted(env.DB, jobId, runpodJobId, now)

  return { jobId, modelVersionId, modelVersion, eventCount: events.length }
}

/**
 * Every currently-held opinion, as text and a 0..10 rating.
 *
 * The doubling to Anagnorisis's scale happens here and nowhere else, so that what is
 * stored stays on the scale the user chose from and a change of engine cannot
 * reinterpret it.
 */
export async function buildTrainingSet(db: D1Database, profileId: string): Promise<TrainEvent[]> {
  const ratings = await currentRatings(db, profileId)
  if (ratings.size === 0) return []

  const events: TrainEvent[] = []
  for (const { video, channel } of await loadVideosWithChannels(db, profileId, [...ratings.keys()])) {
    const rating = ratings.get(video.id)
    if (rating === undefined) continue
    events.push({
      itemId: video.id,
      rating: toEngineRating(rating),
      description: videoText(video, channel),
    })
  }

  // Sorted by id so that the same set of ratings always produces the same payload, and
  // therefore the same hash. Without it, the idempotency check in design section 47
  // would depend on the order D1 happened to return rows in.
  events.sort((left, right) => (left.itemId < right.itemId ? -1 : left.itemId > right.itemId ? 1 : 0))
  return events
}
