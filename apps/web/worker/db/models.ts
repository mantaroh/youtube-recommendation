import type {
  EpochMillis,
  ModelVersion,
  ModelVersionMetadata,
  ModelVersionStatus,
  RecommendationScore,
} from '@ypr/domain'
import { modelVersionName } from '@ypr/domain'

/**
 * Model versions and cached predictions (design sections 13, 14 and 48).
 *
 * A training run never overwrites the live model. It creates a new version, and the
 * switch happens as a single status change once the run has succeeded — so a failed
 * run leaves the feed exactly as it was rather than degrading it.
 */

interface ModelRow {
  id: string
  profile_id: string
  version: number
  training_event_count: number | null
  status: string
  created_at: number
  activated_at: number | null
  metadata_json: string | null
}

function toModelVersion(row: ModelRow): ModelVersion {
  let metadata: ModelVersionMetadata = {}
  if (row.metadata_json) {
    try {
      metadata = JSON.parse(row.metadata_json) as ModelVersionMetadata
    } catch {
      metadata = {}
    }
  }
  return {
    id: row.id,
    profileId: row.profile_id,
    version: row.version,
    trainingEventCount: row.training_event_count,
    status: row.status as ModelVersionStatus,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    metadata,
  }
}

export async function nextVersionNumber(db: D1Database, profileId: string): Promise<number> {
  const row = await db
    .prepare('SELECT MAX(version) AS max FROM model_versions WHERE profile_id = ?1')
    .bind(profileId)
    .first<{ max: number | null }>()
  return (row?.max ?? 0) + 1
}

export async function createModelVersion(
  db: D1Database,
  input: {
    id: string
    profileId: string
    version: number
    trainingEventCount: number
    now: EpochMillis
  },
): Promise<ModelVersion> {
  await db
    .prepare(
      `INSERT INTO model_versions
         (id, profile_id, version, training_event_count, status, created_at, activated_at, metadata_json)
       VALUES (?1, ?2, ?3, ?4, 'training', ?5, NULL, '{}')`,
    )
    .bind(input.id, input.profileId, input.version, input.trainingEventCount, input.now)
    .run()

  return {
    id: input.id,
    profileId: input.profileId,
    version: input.version,
    trainingEventCount: input.trainingEventCount,
    status: 'training',
    createdAt: input.now,
    activatedAt: null,
    metadata: {},
  }
}

export async function setModelStatus(
  db: D1Database,
  id: string,
  status: ModelVersionStatus,
  options: { now: EpochMillis; metadata?: ModelVersionMetadata } = { now: Date.now() },
): Promise<void> {
  const activatedAt = status === 'active' ? options.now : null
  await db
    .prepare(
      `UPDATE model_versions
       SET status = ?2,
           activated_at = COALESCE(?3, activated_at),
           metadata_json = COALESCE(?4, metadata_json)
       WHERE id = ?1`,
    )
    .bind(id, status, activatedAt, options.metadata ? JSON.stringify(options.metadata) : null)
    .run()
}

/**
 * Promote a trained model to live.
 *
 * The previous active version becomes `superseded` in the same batch, so there is no
 * instant at which the feed can see two active models or none — the property design
 * section 48 calls the atomic switch.
 */
/**
 * `trainedEventCount` is what the engine actually learned from, and it is written here
 * because it is usually not what the row already says.
 *
 * The count stored when the job was queued describes what was asked for. A training job
 * assembles its ratings when it is *taken*, so a job that waited for the machine to be
 * free trains on anything rated in the meantime — a row read 32 while the model behind
 * it had learned from 35. That is the right behaviour for the training set and the wrong
 * number to leave in the ledger, since the ledger is what says how much evidence a
 * model rests on.
 */
export async function activateModel(
  db: D1Database,
  profileId: string,
  id: string,
  now: EpochMillis,
  metadata?: ModelVersionMetadata,
  trainedEventCount?: number,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        `UPDATE model_versions SET status = 'superseded'
         WHERE profile_id = ?1 AND status = 'active' AND id <> ?2`,
      )
      .bind(profileId, id),
    db
      .prepare(
        `UPDATE model_versions
         SET status = 'active',
             activated_at = ?3,
             metadata_json = COALESCE(?4, metadata_json),
             training_event_count = COALESCE(?5, training_event_count)
         WHERE id = ?2 AND profile_id = ?1`,
      )
      .bind(profileId, id, now, metadata ? JSON.stringify(metadata) : null, trainedEventCount ?? null),
  ])
}

export async function activeModel(db: D1Database, profileId: string): Promise<ModelVersion | null> {
  const row = await db
    .prepare(
      `SELECT * FROM model_versions
       WHERE profile_id = ?1 AND status = 'active'
       ORDER BY version DESC LIMIT 1`,
    )
    .bind(profileId)
    .first<ModelRow>()
  return row ? toModelVersion(row) : null
}

export async function listModelVersions(
  db: D1Database,
  profileId: string,
  limit = 20,
): Promise<ModelVersion[]> {
  const { results } = await db
    .prepare('SELECT * FROM model_versions WHERE profile_id = ?1 ORDER BY version DESC LIMIT ?2')
    .bind(profileId, limit)
    .all<ModelRow>()
  return (results ?? []).map(toModelVersion)
}

export async function getModelVersion(db: D1Database, id: string): Promise<ModelVersion | null> {
  const row = await db.prepare('SELECT * FROM model_versions WHERE id = ?1').bind(id).first<ModelRow>()
  return row ? toModelVersion(row) : null
}

// ---------------------------------------------------------------------------
// Cached predictions
// ---------------------------------------------------------------------------

export async function saveScores(
  db: D1Database,
  profileId: string,
  modelVersion: string,
  scores: Array<{ videoId: string; score: number }>,
  now: EpochMillis,
): Promise<number> {
  if (scores.length === 0) return 0
  // D1 caps a batch, and a rescore covers up to two thousand videos (design section
  // 32), so the writes are chunked rather than sent as one statement list.
  const CHUNK = 100
  let written = 0
  for (let offset = 0; offset < scores.length; offset += CHUNK) {
    const chunk = scores.slice(offset, offset + CHUNK)
    await db.batch(
      chunk.map((entry) =>
        db
          .prepare(
            `INSERT INTO recommendation_scores (profile_id, video_id, model_version, score, scored_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(profile_id, video_id, model_version) DO UPDATE SET
               score = excluded.score,
               scored_at = excluded.scored_at`,
          )
          .bind(profileId, entry.videoId, modelVersion, entry.score, now),
      ),
    )
    written += chunk.length
  }
  return written
}

export async function scoresFor(
  db: D1Database,
  profileId: string,
  modelVersion: string,
): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      'SELECT video_id, score FROM recommendation_scores WHERE profile_id = ?1 AND model_version = ?2',
    )
    .bind(profileId, modelVersion)
    .all<{ video_id: string; score: number }>()
  const map = new Map<string, number>()
  for (const row of results ?? []) map.set(row.video_id, row.score)
  return map
}

export async function listScores(
  db: D1Database,
  profileId: string,
  modelVersion: string,
  limit: number,
): Promise<RecommendationScore[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM recommendation_scores
       WHERE profile_id = ?1 AND model_version = ?2
       ORDER BY score DESC LIMIT ?3`,
    )
    .bind(profileId, modelVersion, limit)
    .all<{
      profile_id: string
      video_id: string
      model_version: string
      score: number
      scored_at: number
    }>()
  return (results ?? []).map((row) => ({
    profileId: row.profile_id,
    videoId: row.video_id,
    modelVersion: row.model_version,
    score: row.score,
    scoredAt: row.scored_at,
  }))
}

/**
 * Videos the current model has never been asked about.
 *
 * Restricted to a recent window and a hard ceiling, because scoring is the part that
 * costs GPU minutes and an unbounded backlog would quietly turn a two-minute run into
 * an hour-long one (design section 32).
 */
export async function unscoredVideoIds(
  db: D1Database,
  profileId: string,
  modelVersion: string,
  options: { publishedAfter: EpochMillis; limit: number },
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT v.id AS id
       FROM videos v
       LEFT JOIN recommendation_scores s
         ON s.video_id = v.id AND s.profile_id = ?1 AND s.model_version = ?2
       WHERE s.video_id IS NULL
         AND COALESCE(v.published_at, v.discovered_at) >= ?3
         -- Not scored because never offered. Three thousand of the three thousand
         -- eight hundred waiting were shorts, and scoring one costs about half a minute.
         --
         -- An unknown duration counts as long, matching listCandidates: a video that
         -- would be offered has to be scorable, or the feed shows it with no prediction
         -- behind it forever.
         AND COALESCE(v.duration_seconds, 181) > 180
         -- This profile's candidates, not the catalog's. Missed when the pool was split
         -- per profile: scoring read the videos table and so spent one account's nights on the
         -- other's videos — two hundred and twenty-eight of nine hundred and nineteen,
         -- at half a minute each. The score is written under the right profile either
         -- way, so nothing leaked; the work simply went to the wrong feed.
         AND EXISTS (
           SELECT 1 FROM profile_candidates pc
            WHERE pc.video_id = v.id AND pc.profile_id = ?1
         )
       ORDER BY COALESCE(v.published_at, v.discovered_at) DESC
       LIMIT ?4`,
    )
    .bind(profileId, modelVersion, options.publishedAfter, options.limit)
    .all<{ id: string }>()
  return (results ?? []).map((row) => row.id)
}

export { modelVersionName }
