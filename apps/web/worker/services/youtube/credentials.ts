import type { EpochMillis } from '@ypr/domain'
import { DEFAULT_PROFILE_ID } from '@ypr/domain'
import type { Env } from '../../env.js'
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

export function oauthConfig(env: Env): OAuthConfig | null {
  if (
    !env.GOOGLE_CLIENT_ID ||
    !env.GOOGLE_CLIENT_SECRET ||
    !env.OAUTH_REDIRECT_URI ||
    !env.OAUTH_ENCRYPTION_KEY
  ) {
    return null
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.OAUTH_REDIRECT_URI,
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
      const token = await accessTokenFor(env.DB, profileId, 'youtube', config, now, fetchImpl ?? fetch)
      if (token) credentials.accessToken = token
    } catch {
      // A refresh that fails leaves the key path working. Subscriptions will report
      // "no account connected", which is the accurate description of the state.
    }
  }

  return credentials
}
