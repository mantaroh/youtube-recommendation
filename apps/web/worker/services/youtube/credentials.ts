import type { EpochMillis } from '@ypr/domain'
import { DEFAULT_PROFILE_ID } from '@ypr/domain'
import type { Env } from '../../env.js'
import { boundFetch } from '../../http.js'
import { accessTokenFor, type OAuthConfig } from './oauth.js'

/**
 * Which credential a YouTube call should use.
 *
 * The API key and the OAuth token are not interchangeable. The key identifies the
 * project; the token identifies the person. Sending the token where the key would do
 * attaches the user's account to a request that had no need of it, which is the sort
 * of leak that is invisible until it is not — so both are resolved here, once, and the
 * client decides per method which one applies.
 */

export interface ResolvedCredentials {
  apiKey?: string
  accessToken?: string
}

export const OAUTH_CALLBACK_PATH = '/api/auth/youtube/callback'

/**
 * `requestOrigin` is how one client secret serves several hostnames.
 *
 * Each YouTube account has its own host (`docs/design/multi-profile.ja.md`), and the
 * authorisation flow has to return to the host it started on, so the redirect URI cannot
 * be a single stored value. Deriving it from the request is safe because the two calls
 * that need it — building the authorisation URL and exchanging the code — happen on the
 * same host by construction: Google sends the browser back to the URI it was given.
 *
 * `refreshToken` does not send a redirect URI at all, which is why the paths with no
 * request behind them (the cron refreshing a token) are unaffected and can keep using
 * the stored value.
 *
 * Each host still has to be listed in Google Cloud Console as an authorised redirect
 * URI. Nothing here can arrange that, and without it the flow stops at
 * `redirect_uri_mismatch`.
 */
export function oauthConfig(env: Env, requestOrigin?: string): OAuthConfig | null {
  const redirectUri = requestOrigin ? `${requestOrigin}${OAUTH_CALLBACK_PATH}` : env.OAUTH_REDIRECT_URI
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !redirectUri || !env.OAUTH_ENCRYPTION_KEY) {
    return null
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri,
    encryptionKey: env.OAUTH_ENCRYPTION_KEY,
  }
}

export async function youtubeCredentials(
  env: Env,
  now: EpochMillis,
  fetchImpl?: typeof fetch,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<ResolvedCredentials> {
  const credentials: ResolvedCredentials = {}
  if (env.YOUTUBE_API_KEY) credentials.apiKey = env.YOUTUBE_API_KEY

  const config = oauthConfig(env)
  if (config) {
    try {
      const token = await accessTokenFor(env.DB, profileId, 'youtube', config, now, boundFetch(fetchImpl))
      if (token) credentials.accessToken = token
    } catch {
      // A refresh that fails leaves the key path working. Subscriptions will report
      // "no account connected", which is the accurate description of the state.
    }
  }

  return credentials
}
