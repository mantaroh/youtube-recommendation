import type { EpochMillis, GpuJob } from '@ypr/domain'
import {
  MAX_JOB_ATTEMPTS,
  scoreBatchResultSchema,
  trainResultSchema,
} from '@ypr/domain'
import type { Env } from '../../env.js'
import { listRetryable, listUnfinished, markCompleted, markFailed, markSubmitted } from '../../db/jobs.js'
import { activateModel, saveScores, setModelStatus } from '../../db/models.js'
import { mapRunpodStatus } from '../runpod/client.js'
import { ENGINE_NOT_CONFIGURED, engineClient, engineConfigured } from '../runpod/engine.js'
import { submitScoring } from './score.js'

/**
 * Reconciling GPU jobs (design sections 29 and 48).
 *
 * The Worker submits and forgets; this is where the result is picked up. Everything a
 * completed job changes — a model becoming live, scores appearing in the cache — is
 * applied here rather than at submission time, because until the GPU has answered
 * there is nothing to apply.
 */

export interface ReconcileSummary {
  checked: number
  completed: number
  failed: number
  stillRunning: number
  retried: number
  scoresWritten: number
  activatedModels: string[]
  errors: string[]
}

export async function reconcileJobs(
  env: Env,
  now: EpochMillis,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<ReconcileSummary> {
  const summary: ReconcileSummary = {
    checked: 0,
    completed: 0,
    failed: 0,
    stillRunning: 0,
    retried: 0,
    scoresWritten: 0,
    activatedModels: [],
    errors: [],
  }

  if (!engineConfigured(env)) {
    summary.errors.push(ENGINE_NOT_CONFIGURED)
    return summary
  }

  const client = engineClient(env, options.fetchImpl)

  for (const job of await listUnfinished(env.DB)) {
    summary.checked += 1
    if (!job.runpodJobId) {
      // Recorded but never submitted: the Worker died between the two writes. Failing
      // it lets the retry path pick it up rather than leaving it queued forever.
      await markFailed(env.DB, job.id, 'never submitted to Runpod', now)
      summary.failed += 1
      continue
    }

    try {
      const status = await client.status<unknown>(job.runpodJobId)
      const mapped = mapRunpodStatus(status.status)

      if (mapped === 'queued' || mapped === 'processing') {
        summary.stillRunning += 1
        continue
      }

      if (mapped === 'failed') {
        await failJob(env, job, status.error ?? status.status, now)
        summary.failed += 1
        continue
      }

      const applied = await applyResult(env, job, status.output, now)
      summary.scoresWritten += applied.scoresWritten
      if (applied.activatedModel) summary.activatedModels.push(applied.activatedModel)
      await markCompleted(env.DB, job.id, now)
      summary.completed += 1
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      summary.errors.push(`${job.id}: ${message}`)
      await failJob(env, job, message, now)
      summary.failed += 1
    }
  }

  // Resubmit what is still worth another attempt. Retries happen on the polling pass
  // rather than immediately, so a Runpod outage backs off instead of hammering.
  for (const job of await listRetryable(env.DB, MAX_JOB_ATTEMPTS)) {
    if (job.type !== 'score_batch') continue
    const videoIds = job.context.videoIds ?? []
    const profileId = job.context.profileId
    if (!profileId || videoIds.length === 0) continue
    try {
      await submitScoring(env, profileId, now, {
        videoIds,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      })
      await markSubmitted(env.DB, job.id, job.runpodJobId ?? 'resubmitted', now)
      summary.retried += 1
    } catch (error) {
      summary.errors.push(`retry ${job.id}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return summary
}

async function failJob(env: Env, job: GpuJob, error: string, now: EpochMillis): Promise<void> {
  await markFailed(env.DB, job.id, error, now)
  // A training run that failed leaves a model version stuck in `training`. Marking it
  // failed is what keeps the list of versions honest about what happened.
  if (job.type === 'train' && job.context.modelVersionId) {
    await setModelStatus(env.DB, job.context.modelVersionId, 'failed', {
      now,
      metadata: { error: error.slice(0, 500) },
    })
  }
}

interface AppliedResult {
  scoresWritten: number
  activatedModel: string | null
}

async function applyResult(
  env: Env,
  job: GpuJob,
  output: unknown,
  now: EpochMillis,
): Promise<AppliedResult> {
  if (job.type === 'score_batch') {
    const parsed = scoreBatchResultSchema.safeParse(output)
    if (!parsed.success) throw new Error(`malformed score_batch result: ${parsed.error.message}`)
    const profileId = job.context.profileId
    if (!profileId) throw new Error('score_batch job has no profile in its context')
    const written = await saveScores(
      env.DB,
      profileId,
      parsed.data.modelVersion,
      parsed.data.items.map((item) => ({ videoId: item.id, score: item.score })),
      now,
    )
    return { scoresWritten: written, activatedModel: null }
  }

  if (job.type === 'train') {
    const parsed = trainResultSchema.safeParse(output)
    if (!parsed.success) throw new Error(`malformed train result: ${parsed.error.message}`)
    const { modelVersionId, profileId } = job.context
    if (!modelVersionId || !profileId) throw new Error('train job has no model version in its context')

    // The switch to the new model happens here, in one statement pair, and only once
    // the GPU has confirmed the model is on disk (design section 48).
    await activateModel(env.DB, profileId, modelVersionId, now, {
      modelPath: parsed.data.modelPath,
      trainedSeconds: parsed.data.trainedSeconds,
      ...(parsed.data.accuracy ? { accuracy: parsed.data.accuracy } : {}),
    })
    return { scoresWritten: 0, activatedModel: parsed.data.modelVersion }
  }

  // `embed_batch` and `describe_batch` have no consumer in V1: nothing in the ranking
  // path reads an embedding (design section 53). They are accepted and recorded so
  // that the job ledger stays complete.
  return { scoresWritten: 0, activatedModel: null }
}
