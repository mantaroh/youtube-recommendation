import { Hono } from 'hono'
import { verifyAccess } from './access.js'
import type { AppContext, Env } from './env.js'
import { profileForRequest } from './profile.js'
import { ensureProfile } from './db/settings.js'
import type { AppBindings } from './routes/types.js'
import { authRoutes } from './routes/auth.js'
import { dataRoutes } from './routes/data.js'
import { engineRoutes } from './routes/engine.js'
import { discoveryRoutes } from './routes/discovery.js'
import { feedRoutes } from './routes/feed.js'
import { jobRoutes } from './routes/jobs.js'
import { modelRoutes } from './routes/model.js'
import { preferenceRoutes } from './routes/preferences.js'
import { videoRoutes } from './routes/videos.js'
import { runScheduled } from './scheduled/index.js'

/**
 * The application: SPA and API in one deployment (design section 5).
 *
 * Everything under `/api` is this Worker. Everything else is the built React app,
 * served from the assets binding. One deployment rather than two means the SPA and the
 * API share an origin, which in turn means Cloudflare Access protects both with one
 * policy and no cross-origin credentials are involved anywhere.
 */

const app = new Hono<AppBindings>()

/**
 * Access, then identity, then the request.
 *
 * The check is on every API route including the OAuth callback. That callback carries
 * a code that can be exchanged for a token on the user's account, so leaving it open
 * would put the one genuinely dangerous route outside the protection.
 */
app.use('/api/*', async (context, next) => {
  // The runner has no browser and therefore no Access session. Its three routes carry
  // their own bearer check instead (see routes/engine.ts), which is the one hole in
  // Access's coverage and is kept as small as it can be.
  if (context.req.path.startsWith('/api/engine/')) return next()

  const result = await verifyAccess(context.req.raw, context.env)
  if (!result.ok) {
    return context.json({ error: 'forbidden', reason: result.reason }, 403)
  }

  const now = Date.now()
  // The host says which of one person's YouTube accounts this is
  // (`docs/design/multi-profile.ja.md`). Every table is already keyed by profile, so
  // this is the whole of the routing.
  const profileId = profileForRequest(context.env, context.req.url)
  await ensureProfile(context.env.DB, profileId, now)

  const appContext: AppContext = {
    env: context.env,
    identity: result.email,
    profileId,
    now,
  }
  context.set('app', appContext)
  await next()
})

app.route('/api', feedRoutes)
app.route('/api', videoRoutes)
app.route('/api', preferenceRoutes)
app.route('/api', modelRoutes)
app.route('/api', discoveryRoutes)
app.route('/api', jobRoutes)
app.route('/api', authRoutes)
app.route('/api', dataRoutes)
app.route('/api', engineRoutes)


app.get('/api/health', (context) => context.json({ ok: true }))

app.onError((error, context) => {
  console.error('unhandled', error)
  return context.json({ error: error.message }, 500)
})

app.notFound((context) => {
  if (context.req.path.startsWith('/api')) return context.json({ error: 'not found' }, 404)
  // Anything else is a client-side route. The assets binding is configured to serve
  // `index.html` for unknown paths, so this is only reached in development.
  return context.text('not found', 404)
})

export default {
  fetch: app.fetch,

  /**
   * Scheduled work (design section 41).
   *
   * Wrapped so that one failing task cannot stop the others: a Runpod outage should
   * not also stop the subscription refresh.
   */
  async scheduled(_event: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(
      runScheduled(env, Date.now())
        .then((summaries) => {
          console.log('scheduled', JSON.stringify(summaries))
        })
        .catch((error: unknown) => {
          console.error('scheduled failed', error)
        }),
    )
  },
}

export { app }
