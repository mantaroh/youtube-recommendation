import type { AppSettings } from '@ypr/shared'
import { appSettingsSchema } from '@ypr/shared'
import { DEFAULT_FEED_SIZE, DEFAULT_SCORE_WEIGHTS, K_MAX, TAU } from '@ypr/core'
import { getDb } from './db.js'

/**
 * Key/value settings, stored in the same local database as everything else.
 *
 * Settings are configuration, not history: unlike events they can be overwritten freely.
 */

export const APP_SETTINGS_KEY = 'app.settings'

export const DEFAULT_APP_SETTINGS: AppSettings = {
  // Slightly toward the stable end by default; the user moves it (design section 4.2).
  discovery: 0.3,
  scoreWeights: { ...DEFAULT_SCORE_WEIGHTS },
  tau: TAU,
  kMax: K_MAX,
  feedSize: DEFAULT_FEED_SIZE,
  subscribedChannelIds: [],
}

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await getDb().settings.get(key)
  if (!row) return fallback
  return row.value as T
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await getDb().settings.put({ key, value })
}

export async function getAppSettings(): Promise<AppSettings> {
  const stored = await getSetting<Partial<AppSettings> | null>(APP_SETTINGS_KEY, null)
  if (!stored) return { ...DEFAULT_APP_SETTINGS }
  // Merge rather than replace, so a settings row written by an older build stays usable.
  const merged: AppSettings = {
    ...DEFAULT_APP_SETTINGS,
    ...stored,
    scoreWeights: { ...DEFAULT_APP_SETTINGS.scoreWeights, ...(stored.scoreWeights ?? {}) },
  }
  const parsed = appSettingsSchema.safeParse(merged)
  return parsed.success ? parsed.data : { ...DEFAULT_APP_SETTINGS }
}

export async function updateAppSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = { ...(await getAppSettings()), ...patch }
  const validated = appSettingsSchema.parse(next)
  await setSetting(APP_SETTINGS_KEY, validated)
  return validated
}
