import type { EpochMillis, InterestControl } from '@ypr/domain'

/**
 * Interest controls (design section 12).
 *
 * These are the one part of the preference model the user writes directly. They are
 * applied at ranking time rather than folded into training, which is what makes
 * "quieten this for a month" take effect on the next feed instead of the next GPU run.
 */

interface InterestRow {
  id: string
  profile_id: string
  keyword: string
  weight: number
  mute_until: number | null
  created_at: number
  updated_at: number
}

function toInterestControl(row: InterestRow): InterestControl {
  return {
    id: row.id,
    profileId: row.profile_id,
    keyword: row.keyword,
    weight: row.weight,
    muteUntil: row.mute_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listInterests(db: D1Database, profileId: string): Promise<InterestControl[]> {
  const { results } = await db
    .prepare('SELECT * FROM interest_controls WHERE profile_id = ?1 ORDER BY weight DESC, keyword ASC')
    .bind(profileId)
    .all<InterestRow>()
  return (results ?? []).map(toInterestControl)
}

export async function getInterest(
  db: D1Database,
  profileId: string,
  id: string,
): Promise<InterestControl | null> {
  const row = await db
    .prepare('SELECT * FROM interest_controls WHERE profile_id = ?1 AND id = ?2')
    .bind(profileId, id)
    .first<InterestRow>()
  return row ? toInterestControl(row) : null
}

export interface UpsertInterestInput {
  id: string
  profileId: string
  keyword: string
  weight: number
  muteUntil: EpochMillis | null
  now: EpochMillis
}

/**
 * Create or adjust one control.
 *
 * Keyed on `(profile_id, keyword)` rather than the id, so that typing a keyword that
 * already exists adjusts it instead of creating a second row that would silently
 * double its effect.
 */
export async function upsertInterest(
  db: D1Database,
  input: UpsertInterestInput,
): Promise<InterestControl> {
  await db
    .prepare(
      `INSERT INTO interest_controls (id, profile_id, keyword, weight, mute_until, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
       ON CONFLICT(profile_id, keyword) DO UPDATE SET
         weight = excluded.weight,
         mute_until = excluded.mute_until,
         updated_at = excluded.updated_at`,
    )
    .bind(input.id, input.profileId, input.keyword, input.weight, input.muteUntil, input.now)
    .run()

  const row = await db
    .prepare('SELECT * FROM interest_controls WHERE profile_id = ?1 AND keyword = ?2')
    .bind(input.profileId, input.keyword)
    .first<InterestRow>()
  if (!row) throw new Error(`interest control vanished after upsert: ${input.keyword}`)
  return toInterestControl(row)
}

export async function deleteInterest(db: D1Database, profileId: string, id: string): Promise<void> {
  await db
    .prepare('DELETE FROM interest_controls WHERE profile_id = ?1 AND id = ?2')
    .bind(profileId, id)
    .run()
}

/**
 * The effective weight of a control right now.
 *
 * A timed mute is a mute that expires, so it has to be evaluated against the clock
 * rather than written into `weight` — writing it in would lose the value to restore.
 */
export function effectiveWeight(control: InterestControl, now: EpochMillis): number {
  if (control.muteUntil !== null && control.muteUntil > now) return 0
  return control.weight
}
