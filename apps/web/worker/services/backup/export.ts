import type { EpochMillis } from '@ypr/domain'
import { parseItemKey, type RatingExportLine } from '@ypr/domain'
import type { Env } from '../../env.js'
import { listInterests } from '../../db/interests.js'
import { listAllRatings } from '../../db/ratings.js'
import { listChannels } from '../../db/videos.js'
import { loadSettings } from '../../db/settings.js'

/**
 * Export and backup (design sections 45 and 46).
 *
 * The exported ratings are deliberately free of anything derived: no predicted score,
 * no model version, no lane. What a person needs in order to walk away with their
 * preferences is what they rated and when, and adding the rest would suggest the model
 * is part of what has to be preserved when design section 45 says explicitly that it
 * is not — a model can be retrained from these lines, which is why they are the thing
 * worth keeping.
 *
 * The format is JSONL rather than one JSON array so that a partial file is still
 * readable and an append does not require rewriting what came before.
 */

export interface ExportBundle {
  'ratings.jsonl': string
  'preferences.json': string
  'subscriptions.json': string
  'settings.json': string
}

export async function buildExport(env: Env, profileId: string): Promise<ExportBundle> {
  const [ratings, interests, channels, settings] = await Promise.all([
    listAllRatings(env.DB, profileId, { includeDisabled: true }),
    listInterests(env.DB, profileId),
    listChannels(env.DB, profileId, { subscribedOnly: true }),
    loadSettings(env.DB, profileId),
  ])

  const lines = ratings.map((event): RatingExportLine => {
    const ref = parseItemKey(event.videoId)
    return {
      id: event.id,
      profileId: event.profileId,
      source: ref.source,
      externalId: ref.externalId,
      rating: event.rating,
      // ISO here, epoch in the database. This file is meant to be read by a person
      // years from now, and an epoch integer is not.
      createdAt: new Date(event.createdAt).toISOString(),
      disabledAt: event.disabledAt === null ? null : new Date(event.disabledAt).toISOString(),
    }
  })

  return {
    'ratings.jsonl': lines.map((line) => JSON.stringify(line)).join('\n'),
    'preferences.json': JSON.stringify(
      interests.map((control) => ({
        keyword: control.keyword,
        weight: control.weight,
        muteUntil: control.muteUntil === null ? null : new Date(control.muteUntil).toISOString(),
      })),
      null,
      2,
    ),
    'subscriptions.json': JSON.stringify(
      channels.map((channel) => ({
        source: channel.source,
        externalId: channel.externalId,
        title: channel.title,
      })),
      null,
      2,
    ),
    'settings.json': JSON.stringify(settings, null, 2),
  }
}

/**
 * Write the export to R2 under a dated prefix (design section 46).
 *
 * Dated rather than overwritten, because the failure a backup exists to survive is
 * usually not "the database is gone" but "something wrote nonsense to it and nobody
 * noticed for a week".
 */
export async function backupToR2(
  env: Env,
  profileId: string,
  now: EpochMillis,
): Promise<{ prefix: string; files: string[] } | { error: string }> {
  if (!env.BACKUPS) return { error: 'no R2 bucket bound' }

  const bundle = await buildExport(env, profileId)
  // JST, matching the rest of the system's reporting.
  const day = new Date(now + 9 * 3_600_000).toISOString().slice(0, 10)
  const prefix = `backup/${day}/${profileId}`

  const files: string[] = []
  for (const [name, body] of Object.entries(bundle)) {
    const key = `${prefix}/${name}`
    await env.BACKUPS.put(key, body, {
      httpMetadata: {
        contentType: name.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/json',
      },
    })
    files.push(key)
  }

  return { prefix, files }
}
