import { describe, expect, it } from 'vitest'
import {
  accessTokenFor,
  authorizationUrl,
  consumeState,
  createState,
  deleteToken,
  loadToken,
  open,
  purgeExpiredStates,
  saveToken,
  seal,
  YOUTUBE_SCOPE,
} from '../services/youtube/oauth.js'
import { createTestDatabase } from './d1.js'
import { stubFetch } from './fixtures.js'

/**
 * OAuth storage (design section 16).
 *
 * Three properties are load-bearing and all three are checked here: the ciphertext in
 * D1 is not the token, a fresh nonce is used every time, and a state parameter can
 * only be spent once.
 */

const NOW = Date.parse('2026-08-24T00:00:00Z')
// 32 bytes, base64. Test material only.
const KEY = btoa('0123456789abcdef0123456789abcdef')

const CONFIG = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'https://example.test/api/auth/youtube/callback',
  encryptionKey: KEY,
}

describe('the authorization request', () => {
  it('asks for read-only access and for a refresh token', () => {
    const url = new URL(authorizationUrl(CONFIG, 'state-1'))
    expect(url.searchParams.get('scope')).toBe(YOUTUBE_SCOPE)
    expect(url.searchParams.get('scope')).toContain('readonly')
    // Without both of these Google issues no refresh token, and the connection would
    // stop working an hour later.
    expect(url.searchParams.get('access_type')).toBe('offline')
    expect(url.searchParams.get('prompt')).toBe('consent')
    expect(url.searchParams.get('state')).toBe('state-1')
  })
})

describe('encryption at rest', () => {
  it('round-trips a token', async () => {
    const sealed = await seal('ya29.secret', KEY)
    expect(sealed.ciphertext).not.toContain('secret')
    expect(await open(sealed, KEY)).toBe('ya29.secret')
  })

  it('uses a fresh nonce every time', async () => {
    // Reusing a nonce under the same key is the one failure AES-GCM does not survive.
    const first = await seal('same', KEY)
    const second = await seal('same', KEY)
    expect(first.iv).not.toBe(second.iv)
    expect(first.ciphertext).not.toBe(second.ciphertext)
  })

  it('refuses a key that is not 32 bytes', async () => {
    await expect(seal('token', btoa('short'))).rejects.toThrow(/32 bytes/)
  })

  it('will not decrypt with the wrong key', async () => {
    const sealed = await seal('token', KEY)
    await expect(open(sealed, btoa('fedcba9876543210fedcba9876543210'))).rejects.toThrow()
  })
})

describe('token storage', () => {
  it('stores ciphertext, and returns the token only through the decrypting reader', async () => {
    const db = createTestDatabase()
    await saveToken(
      db,
      'default',
      'youtube',
      { accessToken: 'ya29.secret', refreshToken: '1//refresh', scope: YOUTUBE_SCOPE, expiresAt: NOW + 3_600_000 },
      KEY,
      NOW,
    )

    const row = await db
      .prepare('SELECT access_token, refresh_token FROM oauth_tokens WHERE profile_id = ?1')
      .bind('default')
      .first<{ access_token: string; refresh_token: string }>()
    expect(row?.access_token).not.toContain('ya29')
    expect(row?.refresh_token).not.toContain('refresh')

    const loaded = await loadToken(db, 'default', 'youtube', KEY)
    expect(loaded?.accessToken).toBe('ya29.secret')
    expect(loaded?.refreshToken).toBe('1//refresh')
  })

  it('keeps the refresh token when a refresh does not reissue one', async () => {
    const db = createTestDatabase()
    await saveToken(
      db,
      'default',
      'youtube',
      { accessToken: 'first', refreshToken: '1//refresh', scope: null, expiresAt: NOW - 1_000 },
      KEY,
      NOW,
    )

    const fetchImpl = stubFetch([
      ['oauth2.googleapis.com/token', { access_token: 'second', expires_in: 3600 }],
    ])

    const token = await accessTokenFor(db, 'default', 'youtube', CONFIG, NOW, fetchImpl)
    expect(token).toBe('second')

    // Google reissues the refresh token rarely. Dropping it would end the connection
    // at the next refresh.
    const stored = await loadToken(db, 'default', 'youtube', KEY)
    expect(stored?.refreshToken).toBe('1//refresh')
  })

  it('does not refresh a token that is still good', async () => {
    const db = createTestDatabase()
    await saveToken(
      db,
      'default',
      'youtube',
      { accessToken: 'good', refreshToken: '1//refresh', scope: null, expiresAt: NOW + 3_600_000 },
      KEY,
      NOW,
    )

    // Any call to the token endpoint would throw here, because nothing stubs it.
    const token = await accessTokenFor(db, 'default', 'youtube', CONFIG, NOW, stubFetch([]))
    expect(token).toBe('good')
  })

  it('reports no token rather than throwing when nothing is connected', async () => {
    const db = createTestDatabase()
    expect(await accessTokenFor(db, 'default', 'youtube', CONFIG, NOW)).toBeNull()
  })

  it('forgets a token on disconnect', async () => {
    const db = createTestDatabase()
    await saveToken(
      db, 'default', 'youtube',
      { accessToken: 'x', refreshToken: null, scope: null, expiresAt: null }, KEY, NOW,
    )
    await deleteToken(db, 'default', 'youtube')
    expect(await loadToken(db, 'default', 'youtube', KEY)).toBeNull()
  })
})

describe('the state parameter', () => {
  it('can only be spent once', async () => {
    const db = createTestDatabase()
    const state = await createState(db, 'default', '/settings', NOW)

    expect(await consumeState(db, state, NOW)).toEqual({ profileId: 'default', redirectTo: '/settings' })
    // A spent state left behind is what makes a replay possible.
    expect(await consumeState(db, state, NOW)).toBeNull()
  })

  it('rejects a state that has expired', async () => {
    const db = createTestDatabase()
    const state = await createState(db, 'default', null, NOW)
    expect(await consumeState(db, state, NOW + 20 * 60_000)).toBeNull()
  })

  it('rejects a state this application never issued', async () => {
    const db = createTestDatabase()
    expect(await consumeState(db, 'forged', NOW)).toBeNull()
  })

  it('sweeps expired rows so the table does not only grow', async () => {
    const db = createTestDatabase()
    await createState(db, 'default', null, NOW - 3_600_000)
    await purgeExpiredStates(db, NOW)

    const row = await db.prepare('SELECT COUNT(*) AS count FROM oauth_states').first<{ count: number }>()
    expect(row?.count).toBe(0)
  })
})
