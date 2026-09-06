import type { EpochMillis, GpuJob, GpuJobContext, GpuJobStatus, GpuJobType } from '@ypr/domain'

/**
 * The GPU job ledger (design sections 15, 29, 47 and 48).
 *
 * The Worker never waits on a GPU run. It records the job here, returns, and a cron
 * pass reconciles the result later. That is what keeps a request cheap while a
 * training run takes minutes, and it is also what makes the work survive a Worker
 * restart: the record of what was submitted is in the database, not in memory.
 */

interface JobRow {
  id: string
  type: string
  runpod_job_id: string | null
  status: string
  payload_hash: string | null
  created_at: number
  started_at: number | null
  completed_at: number | null
  error: string | null
  attempts: number
  context_json: string | null
  lease_expires_at: number | null
}

function toGpuJob(row: JobRow): GpuJob {
  let context: GpuJobContext = {}
  if (row.context_json) {
    try {
      context = JSON.parse(row.context_json) as GpuJobContext
    } catch {
      context = {}
    }
  }
  return {
    id: row.id,
    type: row.type as GpuJobType,
    runpodJobId: row.runpod_job_id,
    status: row.status as GpuJobStatus,
    payloadHash: row.payload_hash,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    attempts: row.attempts,
    leaseExpiresAt: row.lease_expires_at,
    context,
  }
}

/**
 * SHA-256 over the inputs that decide what a job computes (design section 47).
 *
 * Ids are sorted before hashing so that two batches containing the same videos in a
 * different order are recognised as the same work. Without that, a retry that happened
 * to reorder its input would pay for the whole batch again.
 */
export async function payloadHash(parts: {
  type: GpuJobType
  profileId: string
  modelVersion: string
  ids: string[]
}): Promise<string> {
  const canonical = JSON.stringify({
    type: parts.type,
    profile: parts.profileId,
    model: parts.modelVersion,
    ids: [...parts.ids].sort(),
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function findJobByHash(db: D1Database, hash: string): Promise<GpuJob | null> {
  const row = await db
    .prepare(
      `SELECT * FROM gpu_jobs
       WHERE payload_hash = ?1 AND status IN ('queued', 'processing', 'completed')
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(hash)
    .first<JobRow>()
  return row ? toGpuJob(row) : null
}

export async function createJob(
  db: D1Database,
  input: {
    id: string
    type: GpuJobType
    payloadHash: string
    context: GpuJobContext
    now: EpochMillis
  },
): Promise<GpuJob> {
  await db
    .prepare(
      `INSERT INTO gpu_jobs (id, type, runpod_job_id, status, payload_hash, created_at, attempts, context_json)
       VALUES (?1, ?2, NULL, 'queued', ?3, ?4, 0, ?5)`,
    )
    .bind(input.id, input.type, input.payloadHash, input.now, JSON.stringify(input.context))
    .run()

  return {
    id: input.id,
    type: input.type,
    runpodJobId: null,
    status: 'queued',
    payloadHash: input.payloadHash,
    createdAt: input.now,
    startedAt: null,
    completedAt: null,
    error: null,
    attempts: 0,
    leaseExpiresAt: null,
    context: input.context,
  }
}

export async function markSubmitted(
  db: D1Database,
  id: string,
  runpodJobId: string,
  now: EpochMillis,
): Promise<void> {
  await db
    .prepare(
      `UPDATE gpu_jobs
       SET runpod_job_id = ?2, status = 'processing', started_at = COALESCE(started_at, ?3), attempts = attempts + 1
       WHERE id = ?1`,
    )
    .bind(id, runpodJobId, now)
    .run()
}

export async function markCompleted(db: D1Database, id: string, now: EpochMillis): Promise<void> {
  await db
    .prepare(`UPDATE gpu_jobs SET status = 'completed', completed_at = ?2, error = NULL WHERE id = ?1`)
    .bind(id, now)
    .run()
}

export async function markFailed(
  db: D1Database,
  id: string,
  error: string,
  now: EpochMillis,
): Promise<void> {
  await db
    .prepare(`UPDATE gpu_jobs SET status = 'failed', completed_at = ?3, error = ?2 WHERE id = ?1`)
    .bind(id, error.slice(0, 500), now)
    .run()
}

/** Jobs the polling cron should reconcile (design section 29). */
export async function listUnfinished(db: D1Database, limit = 25): Promise<GpuJob[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM gpu_jobs
       WHERE status IN ('queued', 'processing')
       ORDER BY created_at ASC LIMIT ?1`,
    )
    .bind(limit)
    .all<JobRow>()
  return (results ?? []).map(toGpuJob)
}

/**
 * Failed jobs that are still worth another attempt (design section 48).
 *
 * `attempts` is the guard rather than a timestamp, because a job that fails for a
 * reason that will not change — a payload the GPU side rejects — would otherwise be
 * resubmitted forever at full price.
 */
export async function listRetryable(
  db: D1Database,
  maxAttempts: number,
  limit = 10,
): Promise<GpuJob[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM gpu_jobs
       WHERE status = 'failed' AND attempts < ?1
       ORDER BY created_at ASC LIMIT ?2`,
    )
    .bind(maxAttempts, limit)
    .all<JobRow>()
  return (results ?? []).map(toGpuJob)
}

export async function listJobs(db: D1Database, limit = 50): Promise<GpuJob[]> {
  const { results } = await db
    .prepare('SELECT * FROM gpu_jobs ORDER BY created_at DESC LIMIT ?1')
    .bind(limit)
    .all<JobRow>()
  return (results ?? []).map(toGpuJob)
}

export async function getJob(db: D1Database, id: string): Promise<GpuJob | null> {
  const row = await db.prepare('SELECT * FROM gpu_jobs WHERE id = ?1').bind(id).first<JobRow>()
  return row ? toGpuJob(row) : null
}

/**
 * Takes the oldest queued job, in one statement.
 *
 * D1 has no row locks, so reading a row and then updating it leaves a window in which
 * two runners see the same job as available. Doing both in one `UPDATE ... RETURNING`
 * closes it: SQLite applies a statement atomically, so exactly one caller can be the
 * one that changed the row from `queued`.
 *
 * `attempts` rises here rather than at submission, because in this model a claim *is*
 * the attempt.
 */
export async function claimNextJob(
  db: D1Database,
  options: { now: EpochMillis; leaseMs: number },
): Promise<GpuJob | null> {
  const row = await db
    .prepare(
      `UPDATE gpu_jobs
          SET status = 'processing',
              started_at = COALESCE(started_at, ?1),
              lease_expires_at = ?2,
              attempts = attempts + 1
        WHERE id = (
                SELECT id FROM gpu_jobs
                 WHERE status = 'queued'
                 ORDER BY created_at ASC
                 LIMIT 1
              )
          AND status = 'queued'
       RETURNING *`,
    )
    .bind(options.now, options.now + options.leaseMs)
    .first<JobRow>()

  return row ? toGpuJob(row) : null
}

/**
 * Returns work whose claimant went away.
 *
 * A runner that is switched off mid-job never reports anything, so without this the row
 * stays `processing` and the work is never done. `attempts` is left where it is, so a
 * job that keeps being claimed by a machine that keeps dying still runs out of attempts
 * rather than cycling forever.
 */
export async function expireLeases(db: D1Database, now: EpochMillis): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE gpu_jobs
          SET status = 'queued', lease_expires_at = NULL
        WHERE status = 'processing'
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ?1`,
    )
    .bind(now)
    .run()
  return result.meta?.changes ?? 0
}

/** Puts a failed job back in the queue for a runner to pick up again. */
export async function requeue(db: D1Database, id: string): Promise<void> {
  await db
    .prepare(
      `UPDATE gpu_jobs
          SET status = 'queued', lease_expires_at = NULL, error = NULL, completed_at = NULL
        WHERE id = ?1`,
    )
    .bind(id)
    .run()
}
