import type { SourceAdapter } from '@ypr/shared'
import { YouTubeApiClient } from './youtube/client.js'
import { YouTubeSourceAdapter } from './youtube/adapter.js'
import { FixtureSourceAdapter } from './youtube/fixtures.js'
import { getAccessToken, getCredentials, isSignedIn } from './youtube/auth.js'

export type SourceMode = 'live' | 'fixture'

export interface ResolvedSource {
  adapter: SourceAdapter
  mode: SourceMode
  /** Why fixture mode was chosen, when it was. */
  reason?: string
}

/**
 * Picks the live adapter when credentials exist and the user is signed in, and the
 * fixture adapter otherwise.
 *
 * Falling back rather than failing is deliberate: the preference model, the interest
 * editor and the ranker are all worth exercising before anyone touches Google Cloud.
 */
export async function resolveSource(now: () => string = () => new Date().toISOString()): Promise<ResolvedSource> {
  const { clientId, apiKey } = await getCredentials()
  if (!clientId || !apiKey) {
    return {
      adapter: new FixtureSourceAdapter(now),
      mode: 'fixture',
      reason: 'No OAuth client id / API key configured.',
    }
  }
  if (!(await isSignedIn())) {
    return {
      adapter: new FixtureSourceAdapter(now),
      mode: 'fixture',
      reason: 'Not signed in to YouTube yet.',
    }
  }

  const client = new YouTubeApiClient({
    apiKey,
    getAccessToken: () => getAccessToken({ interactive: false }),
  })
  return { adapter: new YouTubeSourceAdapter(client, now), mode: 'live' }
}
