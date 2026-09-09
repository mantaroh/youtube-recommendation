import { Hono } from 'hono'
import type { AppBindings } from './types.js'
import { oauthConfig } from '../services/youtube/credentials.js'
import {
  authorizationUrl,
  consumeState,
  createState,
  deleteToken,
  exchangeCode,
  loadToken,
  saveToken,
} from '../services/youtube/oauth.js'
import { syncSubscriptions } from '../services/discovery/index.js'

/**
 * YouTube OAuth (design sections 16 and 40).
 *
 * The browser is sent to Google and comes back here. It never sees a token: the
 * exchange happens on the Worker, the result is encrypted before it is written, and
 * what the SPA can learn is whether an account is connected and which scope it granted
 * (design section 16).
 */
export const authRoutes = new Hono<AppBindings>()

authRoutes.get('/auth/youtube', async (context) => {
  const app = context.get('app')
  const config = oauthConfig(app.env, new URL(context.req.url).origin)
  if (!config) {
    return context.json(
      {
        error:
          'OAuth is not configured: set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and OAUTH_ENCRYPTION_KEY',
      },
      503,
    )
  }

  const redirectTo = context.req.query('redirectTo') ?? '/settings'
  const state = await createState(app.env.DB, app.profileId, redirectTo, app.now)
  return context.redirect(authorizationUrl(config, state))
})

authRoutes.get('/auth/youtube/callback', async (context) => {
  const app = context.get('app')
  const config = oauthConfig(app.env, new URL(context.req.url).origin)
  if (!config) return context.json({ error: 'OAuth is not configured' }, 503)

  const error = context.req.query('error')
  if (error) return context.redirect(`/settings?youtube=${encodeURIComponent(error)}`)

  const code = context.req.query('code')
  const state = context.req.query('state')
  if (!code || !state) return context.json({ error: 'missing code or state' }, 400)

  // The state is held server-side and single-use, so a callback that was not started
  // by this application cannot be accepted.
  const claim = await consumeState(app.env.DB, state, app.now)
  if (!claim) return context.redirect('/settings?youtube=expired')

  try {
    const token = await exchangeCode(config, code, app.now)
    await saveToken(app.env.DB, claim.profileId, 'youtube', token, config.encryptionKey, app.now)

    // The subscription list is the reason the connection exists, so it is fetched
    // immediately rather than at the next scheduled run.
    context.executionCtx.waitUntil(
      syncSubscriptions(app.env, claim.profileId, app.now).then(() => undefined),
    )

    return context.redirect(`${claim.redirectTo ?? '/settings'}?youtube=connected`)
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'exchange failed'
    return context.redirect(`/settings?youtube=${encodeURIComponent(message)}`)
  }
})

authRoutes.get('/auth/youtube/status', async (context) => {
  const app = context.get('app')
  const config = oauthConfig(app.env, new URL(context.req.url).origin)
  if (!config) {
    return context.json({ configured: false, connected: false })
  }
  const token = await loadToken(app.env.DB, app.profileId, 'youtube', config.encryptionKey).catch(
    () => null,
  )
  return context.json({
    configured: true,
    connected: token !== null,
    scope: token?.scope ?? null,
    expiresAt: token?.expiresAt ?? null,
  })
})

authRoutes.delete('/auth/youtube', async (context) => {
  const app = context.get('app')
  await deleteToken(app.env.DB, app.profileId, 'youtube')
  return context.json({ connected: false })
})
