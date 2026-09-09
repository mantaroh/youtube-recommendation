import type { GpuJob, ScoreBatchItem, ScoreBatchPayload, TrainPayload } from '@ypr/domain'
import { TRAIN_TIME_BUDGET_SECONDS } from '@ypr/domain'
import { loadVideosWithChannels } from '../../db/videos.js'
import { buildTrainingSet } from './train.js'
import { videoText } from './text.js'

/**
 * Rebuilds a job's payload when a runner comes to collect it.
 *
 * The alternative was storing the payload alongside the job. A training payload carries
 * the text of every rated video, so the ledger row would grow with the rating history —
 * for something the ids in `context_json` already describe. The retry path in
 * `reconcile.ts` reconstructs the same way, so this is the existing habit rather than a
 * new one.
 *
 * One consequence is worth stating. A training job assembles its set of ratings when it
 * is *taken*, not when it was queued, so a job that waited overnight trains on anything
 * rated in the meantime. That is the better model, but it does mean the hash that
 * deduplicated the job describes what was asked for rather than what was learned from.
 */
export class PayloadUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PayloadUnavailable'
  }
}

export async function buildJobPayload(db: D1Database, job: GpuJob): Promise<unknown> {
  const profileId = job.context.profileId
  if (!profileId) throw new PayloadUnavailable(`job ${job.id} has no profile in its context`)

  if (job.type === 'train') {
    const modelVersion = job.context.modelVersion
    if (!modelVersion) throw new PayloadUnavailable(`job ${job.id} has no model version`)

    const events = await buildTrainingSet(db, profileId)
    if (events.length === 0) throw new PayloadUnavailable(`job ${job.id} has nothing left to train on`)

    const payload: TrainPayload = {
      profile: profileId,
      modelVersion,
      events,
      timeBudgetSeconds: TRAIN_TIME_BUDGET_SECONDS,
    }
    return payload
  }

  if (job.type === 'score_batch') {
    const modelVersion = job.context.modelVersion
    const videoIds = job.context.videoIds ?? []
    if (!modelVersion) throw new PayloadUnavailable(`job ${job.id} has no model version`)
    if (videoIds.length === 0) throw new PayloadUnavailable(`job ${job.id} lists no videos`)

    const loaded = await loadVideosWithChannels(db, profileId, videoIds)
    if (loaded.length === 0) {
      // Every video in the batch has since been deleted. There is nothing to score, and
      // handing back an empty batch would have the runner do a round trip for nothing.
      throw new PayloadUnavailable(`job ${job.id} refers to videos that no longer exist`)
    }

    const items: ScoreBatchItem[] = loaded.map(({ video, channel }) => ({
      id: video.id,
      text: videoText(video, channel),
    }))

    const payload: ScoreBatchPayload = { profile: profileId, modelVersion, items }
    return payload
  }

  throw new PayloadUnavailable(`job ${job.id} is of a type this runner cannot be given: ${job.type}`)
}
