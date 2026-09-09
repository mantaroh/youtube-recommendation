import type { EpochMillis, Source } from '@ypr/domain'
import { boundFetch } from '../../http.js'

/**
 * Google OAuth, and the storage of what it returns (design section 16).
 *
 * Three rules shape this file, all from the design:
 *
 * - The token never reaches the browser. The redirect lands on the Worker, the
 *   exchange happens on the Worker, and the SPA only ever learns whether an account is
 *   connected.
 * - The token is encrypted before it is written. D1 holds ciphertext; the key lives in
 *   a Worker secret, so a copy of the database is not a copy of the account.
 * - The token is never sent to Runpod (design section 44). Nothing in the GPU path
 *   imports from here.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

/**
 * Read-only access to the user's own subscriptions, and nothing else.
 *
 * `youtube.readonly` is the narrowest scope that covers `subscriptions.list(mine=true)`.
 * The system never uploads, comments, or edits anything, so no write scope is asked for.
 */
export const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly'

/**
 * What is asked for at the consent screen: the read-only YouTube scope, plus enough to
 * learn which account said yes.
 *
 * `openid email` is there so the Settings screen can name the connected account. With
 * one profile the Access identity stood in for it; with a hostname per account, the
 * Access identity is the same on both and says nothing about which YouTube account each
 * is learning from.
 *
 * It costs no request: `openid` makes Google return an `id_token` alongside the access
 * token, and the address is inside it. It does cost a fresh consent — a widened scope is
 * a new grant — so an account connected under the old scope keeps working and has no
 * address recorded until it is connected again.
 */
export const REQUESTED_SCOPES = `${YOUTUBE_SCOPE} openid email`

export interface StoredToken {
  accessToken: string
  refreshToken: string | null
  scope: string | null
  expiresAt: EpochMillis | null
  /** The address that consented, when `openid` was granted. */
  accountEmail?: string | null
}

export interface OAuthConfig {
  clientId: string
  clientSecret: string
  redirectUri: string
  encryptionKey: string
}

export function authorizationUrl(config: OAuthConfig, state: string): string {
  const url = new URL(AUTH_ENDPOINT)
  url.searchParams.set('client_id', config.clientId)
  url.searchParams.set('redirect_uri', config.redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', REQUESTED_SCOPES)
  // A refresh token is only issued with both of these, and only on the first consent.
  // Without it the connection would quietly stop working after an hour.
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent')
  url.searchParams.set('state', state)

  // Note what is *not* set: `include_granted_scopes`. Incremental authorisation folds
  // every scope the user has already granted this client into the request, and Google
  // refuses to issue a YouTube scope in the same request as a Drive one — so a client
  // that has been used for anything else fails with `invalid_request` before the
  // consent screen appears.
  //
  // Nothing here wants it either. This system asks for exactly one scope and calls
  // exactly one method with it, so a token carrying other grants would be strictly
  // more access than the design permits (design section 16).

  return url.toString()
}

interface TokenResponse {
  access_token?: string
  refresh_token?: string
  /** Present when `openid` was among the granted scopes. */
  id_token?: string
  expires_in?: number
  scope?: string
  error?: string
  error_description?: string
}

/**
 * The address out of an `id_token`, without verifying its signature.
 *
 * Normally that would be indefensible. Here the token did not arrive from a browser or
 * a third party: it is the body of a TLS response from Google's own token endpoint, to
 * a request carrying this application's client secret. There is nowhere for a forged
 * one to have come from, and Google documents this as the case where verification is
 * unnecessary.
 *
 * Returns null on anything unexpected. A missing address is a blank field on a settings
 * screen; throwing here would fail a connection that is otherwise complete.
 */
export function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null
  const [, body] = idToken.split('.')
  if (!body) return null
  try {
    const json = atob(body.replace(/-/g, '+').replace(/_/g, '/'))
    const claims = JSON.parse(json) as { email?: unknown }
    return typeof claims.email === 'string' && claims.email ? claims.email : null
  } catch {
    return null
  }
}

export async function exchangeCode(
  config: OAuthConfig,
  code: string,
  now: EpochMillis,
  fetchImpl: typeof fetch = boundFetch(),
): Promise<StoredToken> {
  const payload = await postToken(
    {
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    },
    fetchImpl,
  )
  if (!payload.access_token) throw new Error('token exchange returned no access token')
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    scope: payload.scope ?? null,
    expiresAt: payload.expires_in ? now + payload.expires_in * 1000 : null,
    accountEmail: emailFromIdToken(payload.id_token),
  }
}

export async function refreshToken(
  config: OAuthConfig,
  refresh: string,
  now: EpochMillis,
  fetchImpl: typeof fetch = boundFetch(),
): Promise<StoredToken> {
  const payload = await postToken(
    {
      refresh_token: refresh,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
    },
    fetchImpl,
  )
  if (!payload.access_token) throw new Error('token refresh returned no access token')
  return {
    accessToken: payload.access_token,
    // Google does not reissue the refresh token on every refresh, so the old one is
    // carried forward. Dropping it here would end the connection at the next refresh.
    refreshToken: payload.refresh_token ?? refresh,
    scope: payload.scope ?? null,
    expiresAt: payload.expires_in ? now + payload.expires_in * 1000 : null,
  }
}

async function postToken(
  form: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<TokenResponse> {
  const response = await fetchImpl(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  })
  const payload = (await response.json().catch(() => ({}))) as TokenResponse
  if (!response.ok || payload.error) {
    throw new Error(
      `oauth ${response.status}: ${payload.error_description ?? payload.error ?? 'unknown error'}`,
    )
  }
  return payload
}

// ---------------------------------------------------------------------------
// Encryption at rest
// ---------------------------------------------------------------------------

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = base64ToBytes(base64Key)
  if (raw.byteLength !== 32) {
    throw new Error('OAUTH_ENCRYPTION_KEY must be 32 bytes, base64 encoded')
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export interface Sealed {
  ciphertext: string
  iv: string
}

export async function seal(plaintext: string, base64Key: string): Promise<Sealed> {
  const key = await importKey(base64Key)
  // A fresh 96-bit nonce per encryption. Reusing one under the same key is the single
  // failure AES-GCM does not tolerate, so it is generated here and never derived.
  const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(plaintext),
  )
  return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) }
}

export async function open(sealed: Sealed, base64Key: string): Promise<string> {
  const key = await importKey(base64Key)
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(sealed.iv) },
    key,
    base64ToBytes(sealed.ciphertext),
  )
  return new TextDecoder().decode(plaintext)
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

interface TokenRow {
  access_token: string
  refresh_token: string | null
  access_iv: string
  refresh_iv: string | null
  scope: string | null
  expires_at: number | null
  account_email: string | null
}

export async function saveToken(
  db: D1Database,
  profileId: string,
  source: Source,
  token: StoredToken,
  encryptionKey: string,
  now: EpochMillis,
): Promise<void> {
  const access = await seal(token.accessToken, encryptionKey)
  const refresh = token.refreshToken ? await seal(token.refreshToken, encryptionKey) : null

  await db
    .prepare(
      `INSERT INTO oauth_tokens
         (profile_id, source, access_token, refresh_token, access_iv, refresh_iv, scope, expires_at, account_email, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
       ON CONFLICT(profile_id, source) DO UPDATE SET
         access_token = excluded.access_token,
         access_iv = excluded.access_iv,
         refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
         refresh_iv = COALESCE(excluded.refresh_iv, oauth_tokens.refresh_iv),
         scope = excluded.scope,
         expires_at = excluded.expires_at,
         -- A refresh carries no id_token, so it must not blank an address already known.
         account_email = COALESCE(excluded.account_email, oauth_tokens.account_email),
         updated_at = excluded.updated_at`,
    )
    .bind(
      profileId,
      source,
      access.ciphertext,
      refresh?.ciphertext ?? null,
      access.iv,
      refresh?.iv ?? null,
      token.scope,
      token.expiresAt,
      token.accountEmail ?? null,
      now,
    )
    .run()
}

export async function loadToken(
  db: D1Database,
  profileId: string,
  source: Source,
  encryptionKey: string,
): Promise<StoredToken | null> {
  const row = await db
    .prepare('SELECT * FROM oauth_tokens WHERE profile_id = ?1 AND source = ?2')
    .bind(profileId, source)
    .first<TokenRow>()
  if (!row) return null

  return {
    accessToken: await open({ ciphertext: row.access_token, iv: row.access_iv }, encryptionKey),
    refreshToken:
      row.refresh_token && row.refresh_iv
        ? await open({ ciphertext: row.refresh_token, iv: row.refresh_iv }, encryptionKey)
        : null,
    scope: row.scope,
    expiresAt: row.expires_at,
    accountEmail: row.account_email,
  }
}

/**
 * The address of the connected account, without decrypting anything.
 *
 * The Settings screen wants to name the account and has no business handling the token
 * to do it, so this reads the one column rather than going through `loadToken`.
 */
export async function connectedAccountEmail(
  db: D1Database,
  profileId: string,
  source: Source,
): Promise<string | null> {
  const row = await db
    .prepare('SELECT account_email FROM oauth_tokens WHERE profile_id = ?1 AND source = ?2')
    .bind(profileId, source)
    .first<{ account_email: string | null }>()
  return row?.account_email ?? null
}

export async function deleteToken(db: D1Database, profileId: string, source: Source): Promise<void> {
  await db
    .prepare('DELETE FROM oauth_tokens WHERE profile_id = ?1 AND source = ?2')
    .bind(profileId, source)
    .run()
}

/**
 * A usable access token, refreshing first when the stored one is close to expiring.
 *
 * The minute of headroom matters: a token that expires while a subscription walk is
 * halfway through would fail the rest of the run, and the walk is the one call that
 * cannot be retried cheaply.
 */
export async function accessTokenFor(
  db: D1Database,
  profileId: string,
  source: Source,
  config: OAuthConfig,
  now: EpochMillis,
  fetchImpl: typeof fetch = boundFetch(),
): Promise<string | null> {
  const stored = await loadToken(db, profileId, source, config.encryptionKey)
  if (!stored) return null

  const expiringSoon = stored.expiresAt !== null && stored.expiresAt - now < 60_000
  if (!expiringSoon) return stored.accessToken
  if (!stored.refreshToken) return null

  const refreshed = await refreshToken(config, stored.refreshToken, now, fetchImpl)
  await saveToken(db, profileId, source, refreshed, config.encryptionKey, now)
  return refreshed.accessToken
}

// ---------------------------------------------------------------------------
// Redirect state
// ---------------------------------------------------------------------------

/** The state parameter, held server-side so a forged callback cannot be accepted. */
export async function createState(
  db: D1Database,
  profileId: string,
  redirectTo: string | null,
  now: EpochMillis,
): Promise<string> {
  const state = crypto.randomUUID()
  await db
    .prepare(
      `INSERT INTO oauth_states (state, profile_id, redirect_to, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(state, profileId, redirectTo, now, now + 10 * 60_000)
    .run()
  return state
}

export async function consumeState(
  db: D1Database,
  state: string,
  now: EpochMillis,
): Promise<{ profileId: string; redirectTo: string | null } | null> {
  const row = await db
    .prepare('SELECT profile_id, redirect_to, expires_at FROM oauth_states WHERE state = ?1')
    .bind(state)
    .first<{ profile_id: string; redirect_to: string | null; expires_at: number }>()
  // Deleted whether or not it was still valid: a state is single-use by definition,
  // and leaving a spent one behind is what makes a replay possible.
  await db.prepare('DELETE FROM oauth_states WHERE state = ?1').bind(state).run()
  if (!row || row.expires_at < now) return null
  return { profileId: row.profile_id, redirectTo: row.redirect_to }
}

export async function purgeExpiredStates(db: D1Database, now: EpochMillis): Promise<void> {
  await db.prepare('DELETE FROM oauth_states WHERE expires_at < ?1').bind(now).run()
}
