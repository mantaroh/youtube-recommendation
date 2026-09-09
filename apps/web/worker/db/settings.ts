import type { AppSettings, EpochMillis } from '@ypr/domain'
import { DEFAULT_SETTINGS } from '@ypr/domain'

/**
 * Per-profile settings.
 *
 * Stored as a patch over the defaults rather than a full document. A setting that has
 * never been touched then follows whatever the defaults become, instead of being
 * frozen at whatever they were the first time the settings screen was opened.
 */

const SETTINGS_KEY = 'app'

export async function loadSettings(db: D1Database, profileId: string): Promise<AppSettings> {
  const row = await db
    .prepare('SELECT value_json FROM settings WHERE profile_id = ?1 AND key = ?2')
    .bind(profileId, SETTINGS_KEY)
    .first<{ value_json: string }>()

  if (!row) return DEFAULT_SETTINGS

  try {
    const patch = JSON.parse(row.value_json) as Partial<AppSettings>
    return {
      ...DEFAULT_SETTINGS,
      ...patch,
      weights: { ...DEFAULT_SETTINGS.weights, ...(patch.weights ?? {}) },
      laneMix: { ...DEFAULT_SETTINGS.laneMix, ...(patch.laneMix ?? {}) },
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export async function saveSettings(
  db: D1Database,
  profileId: string,
  patch: Partial<AppSettings>,
  now: EpochMillis,
): Promise<AppSettings> {
  const current = await loadSettings(db, profileId)
  const merged: AppSettings = {
    ...current,
    ...patch,
    weights: { ...current.weights, ...(patch.weights ?? {}) },
    laneMix: { ...current.laneMix, ...(patch.laneMix ?? {}) },
  }

  await db
    .prepare(
      `INSERT INTO settings (profile_id, key, value_json, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(profile_id, key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    )
    .bind(profileId, SETTINGS_KEY, JSON.stringify(merged), now)
    .run()

  return merged
}

/** Bookkeeping the scheduler needs, kept beside the settings rather than in a table of one row. */
export async function readMarker(
  db: D1Database,
  profileId: string,
  key: string,
): Promise<number | null> {
  const row = await db
    .prepare('SELECT value_json FROM settings WHERE profile_id = ?1 AND key = ?2')
    .bind(profileId, `marker:${key}`)
    .first<{ value_json: string }>()
  if (!row) return null
  const parsed = Number(row.value_json)
  return Number.isFinite(parsed) ? parsed : null
}

export async function writeMarker(
  db: D1Database,
  profileId: string,
  key: string,
  value: number,
  now: EpochMillis,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (profile_id, key, value_json, updated_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(profile_id, key) DO UPDATE SET
         value_json = excluded.value_json,
         updated_at = excluded.updated_at`,
    )
    .bind(profileId, `marker:${key}`, String(value), now)
    .run()
}

export async function ensureProfile(
  db: D1Database,
  profileId: string,
  now: EpochMillis,
): Promise<void> {
  await db
    .prepare('INSERT OR IGNORE INTO profiles (id, name, created_at) VALUES (?1, ?1, ?2)')
    .bind(profileId, now)
    .run()
}

/**
 * Every profile that exists, oldest first.
 *
 * The host table in `PROFILE_HOSTS` says which profiles are *reachable*; this says which
 * ones have data. Scheduled work follows this one, because a profile whose hostname has
 * been taken away still has ratings and a model that should keep being maintained.
 */
export async function listProfiles(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT id FROM profiles ORDER BY created_at ASC, id ASC')
    .all<{ id: string }>()
  return (results ?? []).map((row) => row.id)
}
