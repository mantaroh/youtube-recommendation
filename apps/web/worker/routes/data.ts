import { Hono } from 'hono'
import type { AppBindings } from './types.js'
import { backupToR2, buildExport } from '../services/backup/export.js'
import { countVideos, listChannels } from '../db/videos.js'
import { activeModel } from '../db/models.js'
import { listAllRatings } from '../db/ratings.js'
import { usedToday } from '../db/quota.js'
import { engineConfigured, engineDescription } from '../services/runpod/engine.js'

/**
 * Status, export and backup (design sections 45 and 46).
 *
 * The export routes exist because the design says the user must be able to take their
 * ratings and leave (section 45). That is not a feature bolted on at the end: it is
 * the statement that this system does not hold anyone's preferences hostage, and it
 * only means anything if it works.
 */
export const dataRoutes = new Hono<AppBindings>()

dataRoutes.get('/status', async (context) => {
  const app = context.get('app')
  const [videos, channels, ratings, model, searchUsed] = await Promise.all([
    countVideos(app.env.DB),
    listChannels(app.env.DB, app.profileId, { subscribedOnly: true }),
    listAllRatings(app.env.DB, app.profileId),
    activeModel(app.env.DB, app.profileId),
    usedToday(app.env.DB, 'search', app.now),
  ])

  return context.json({
    identity: app.identity,
    profileId: app.profileId,
    videos,
    subscribedChannels: channels.length,
    ratings: ratings.length,
    activeModel: model,
    searchCallsUsedToday: searchUsed,
    engine: engineDescription(app.env),
    configured: {
      youtubeApiKey: Boolean(app.env.YOUTUBE_API_KEY),
      oauth: Boolean(app.env.GOOGLE_CLIENT_ID && app.env.OAUTH_ENCRYPTION_KEY),
      engine: engineConfigured(app.env),
      backups: Boolean(app.env.BACKUPS),
      access: Boolean(app.env.ACCESS_TEAM_DOMAIN && app.env.ACCESS_AUD),
    },
  })
})

/** The four files design section 45 requires, as one JSON document. */
dataRoutes.get('/export', async (context) => {
  const app = context.get('app')
  return context.json(await buildExport(app.env, app.profileId))
})

/** One file at a time, for anyone who would rather pipe than parse. */
dataRoutes.get('/export/:file', async (context) => {
  const app = context.get('app')
  const bundle = await buildExport(app.env, app.profileId)
  const name = context.req.param('file') as keyof typeof bundle
  const body = bundle[name]
  if (body === undefined) return context.json({ error: 'unknown export file' }, 404)

  return new Response(body, {
    headers: {
      'content-type': name.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/json',
      'content-disposition': `attachment; filename="${name}"`,
    },
  })
})

dataRoutes.post('/backup', async (context) => {
  const app = context.get('app')
  return context.json(await backupToR2(app.env, app.profileId, app.now))
})
