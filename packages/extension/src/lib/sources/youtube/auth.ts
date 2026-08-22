import { getSetting, setSetting } from '../../settings.js'

/**
 * OAuth for the YouTube Data API.
 *
 * Uses `identity.launchWebAuthFlow` rather than Chrome's `getAuthToken` so that the same
 * code path works in Firefox. The implicit flow is used because a browser extension
 * cannot keep a client secret; the resulting access token never leaves this machine.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const YOUTUBE_READONLY_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly'

const TOKEN_SETTING_KEY = 'youtube.token'
/** Refresh a little early so a long ingestion run cannot expire mid-flight. */
const EXPIRY_MARGIN_MS = 120_000

interface StoredToken {
  accessToken: string
  expiresAt: number
}

export interface YouTubeCredentials {
  clientId: string
  apiKey: string
}

/**
 * Credentials come from the options page, falling back to build-time environment
 * variables so a developer build can be wired up without clicking through the UI.
 * They are never sent anywhere except Google.
 */
export async function getCredentials(): Promise<YouTubeCredentials> {
  const stored = await getSetting<Partial<YouTubeCredentials>>('youtube.credentials', {})
  const env = import.meta.env as Record<string, string | undefined>
  return {
    clientId: stored.clientId || env.VITE_YT_CLIENT_ID || '',
    apiKey: stored.apiKey || env.VITE_YT_API_KEY || '',
  }
}

export async function setCredentials(credentials: YouTubeCredentials): Promise<void> {
  await setSetting('youtube.credentials', credentials)
}

export async function hasCredentials(): Promise<boolean> {
  const { clientId, apiKey } = await getCredentials()
  return Boolean(clientId && apiKey)
}

/** The URI that has to be registered on the OAuth client in Google Cloud. */
export function getRedirectUri(): string {
  return browser.identity.getRedirectURL()
}

export async function getAccessToken(options: { interactive?: boolean } = {}): Promise<string> {
  const cached = await getSetting<StoredToken | null>(TOKEN_SETTING_KEY, null)
  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
    return cached.accessToken
  }

  const { clientId } = await getCredentials()
  if (!clientId) {
    throw new Error('No OAuth client id configured. Set one on the options page.')
  }

  const url = new URL(AUTH_ENDPOINT)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('response_type', 'token')
  url.searchParams.set('redirect_uri', getRedirectUri())
  url.searchParams.set('scope', YOUTUBE_READONLY_SCOPE)
  url.searchParams.set('prompt', 'consent')

  const redirect = await browser.identity.launchWebAuthFlow({
    url: url.toString(),
    interactive: options.interactive ?? true,
  })
  if (!redirect) throw new Error('Authorization was dismissed before it completed.')

  const token = parseTokenFromRedirect(redirect)
  await setSetting<StoredToken>(TOKEN_SETTING_KEY, token)
  return token.accessToken
}

export async function signOut(): Promise<void> {
  await setSetting<StoredToken | null>(TOKEN_SETTING_KEY, null)
}

export async function isSignedIn(): Promise<boolean> {
  const cached = await getSetting<StoredToken | null>(TOKEN_SETTING_KEY, null)
  return Boolean(cached && cached.expiresAt > Date.now())
}

/** The implicit flow returns the token in the URL fragment. */
export function parseTokenFromRedirect(redirectUrl: string): StoredToken {
  const fragment = redirectUrl.includes('#') ? redirectUrl.slice(redirectUrl.indexOf('#') + 1) : ''
  const params = new URLSearchParams(fragment)
  const error = params.get('error')
  if (error) throw new Error(`Authorization failed: ${error}`)

  const accessToken = params.get('access_token')
  if (!accessToken) throw new Error('Authorization response carried no access token.')

  const expiresInSeconds = Number(params.get('expires_in') ?? '3600')
  return {
    accessToken,
    expiresAt: Date.now() + expiresInSeconds * 1000,
  }
}
