import type { EpochMillis, ScoreBatchItem, ScoreBatchPayload } from '@ypr/domain'
import { RESCORE_MAX_ITEMS, RESCORE_WINDOW_DAYS, SCORE_BATCH_SIZE } from '@ypr/domain'
import type { Env } from '../../env.js'
import { createJob, findJobByHash, markSubmitted, payloadHash } from '../../db/jobs.js'
import { activeModel, unscoredVideoIds } from '../../db/models.js'
import { loadVideosWithChannels } from '../../db/videos.js'
import { ENGINE_NOT_CONFIGURED, engineClient, engineConfigured, enginePulls } from '../runpod/engine.js'
import { videoText } from './text.js'

/**
 * Batch scoring (design section 32).
 *
 * Runs after a training run and after a discovery pass, never in the request path of a
 * feed. The feed reads `recommendation_scores`; if the GPU is asleep or Runpod is down,
 * the feed still builds from whatever was scored last (design section 49).
 */

export interface ScoreSubmission {
  jobIds: string[]
  modelVersion: string
  itemCount: number
  skipped: number
}

export async function submitScoring(
  env: Env,
  profileId: string,
  now: EpochMillis,
  options: {
    fetchImpl?: typeof fetch
    /** Score these ids instead of looking for unscored ones. */
    videoIds?: string[]
    limit?: number
  } = {},
): Promise<ScoreSubmission> {
  if (!engineConfigured(env)) throw new Error(ENGINE_NOT_CONFIGURED)

  const model = await activeModel(env.DB, profileId)
  if (!model) {
    throw new Error('no active model: train one before scoring')
  }
  const modelVersion = `model-${model.version}`

  const limit = Math.min(options.limit ?? RESCORE_MAX_ITEMS, RESCORE_MAX_ITEMS)
  const ids =
    options.videoIds ??
    (await unscoredVideoIds(env.DB, profileId, modelVersion, {
      publishedAfter: now - RESCORE_WINDOW_DAYS * 86_400_000,
      limit,
    }))

  if (ids.length === 0) {
    return { jobIds: [], modelVersion, itemCount: 0, skipped: 0 }
  }

  const loaded = await loadVideosWithChannels(env.DB, ids)
  const items: ScoreBatchItem[] = loaded.map(({ video, channel }) => ({
    id: video.id,
    text: videoText(video, channel),
  }))

  const pulls = enginePulls(env)
  const client = pulls ? null : engineClient(env, options.fetchImpl)

  const jobIds: string[] = []
  let skipped = 0

  // Split into batches rather than sending one large request. A failure costs one
  // batch instead of the whole rescore, and the GPU work is linear in item count, so
  // nothing is lost by dividing it.
  for (let offset = 0; offset < items.length; offset += SCORE_BATCH_SIZE) {
    const batch = items.slice(offset, offset + SCORE_BATCH_SIZE)
    const hash = await payloadHash({
      type: 'score_batch',
      profileId,
      modelVersion,
      ids: batch.map((item) => item.id),
    })

    const existing = await findJobByHash(env.DB, hash)
    if (existing && existing.status !== 'failed') {
      skipped += batch.length
      continue
    }

    const jobId = crypto.randomUUID()
    await createJob(env.DB, {
      id: jobId,
      type: 'score_batch',
      payloadHash: hash,
      context: { profileId, modelVersion, videoIds: batch.map((item) => item.id) },
      now,
    })

    // Queued and left alone when a runner collects the work; its payload is assembled
    // when someone comes for it.
    if (!pulls) {
      const payload: ScoreBatchPayload = { profile: profileId, modelVersion, items: batch }
      const runpodJobId = await client!.run('score_batch', payload)
      await markSubmitted(env.DB, jobId, runpodJobId, now)
    }
    jobIds.push(jobId)
  }

  return { jobIds, modelVersion, itemCount: items.length - skipped, skipped }
}
