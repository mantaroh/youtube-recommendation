import type { Env } from './env.js'

/**
 * Cloudflare Access (design section 43).
 *
 * Access sits in front of the whole application and puts a signed assertion on every
 * request that gets through. Verifying it here rather than trusting the header is what
 * makes the protection real: without a signature check, anyone who can reach the
 * Worker's origin directly can set the header themselves and walk in.
 *
 * The allow-list is checked as well as the signature. A valid Access token proves the
 * team's identity provider authenticated someone; it does not prove that someone is
 * the person this system belongs to.
 */

const HEADER = 'cf-access-jwt-assertion'

export interface AccessResult {
  ok: boolean
  email: string | null
  reason?: string
}

interface Jwk {
  kid: string
  kty: string
  alg?: string
  n: string
  e: string
}

/**
 * The signing keys, cached for the lifetime of the isolate.
 *
 * Access rotates these, and a fetch on every request would add a round trip to a hot
 * path. Rotation is slow enough that a miss on an unknown `kid` refetching is the only
 * invalidation needed.
 */
let cachedKeys: { teamDomain: string; keys: Map<string, CryptoKey> } | null = null

export async function verifyAccess(request: Request, env: Env): Promise<AccessResult> {
  const teamDomain = env.ACCESS_TEAM_DOMAIN
  const audience = env.ACCESS_AUD

  // Not configured: local development and the first deploy, before Access is in front
  // of the app. Refusing here would make the system unrunnable before it is protected,
  // so it is allowed through and the caller is told there is no identity.
  if (!teamDomain || !audience) return { ok: true, email: null, reason: 'access not configured' }

  const token = request.headers.get(HEADER) ?? cookieValue(request, 'CF_Authorization')
  if (!token) return { ok: false, email: null, reason: 'no Access assertion' }

  try {
    const payload = await verifyJwt(token, teamDomain, audience)
    const email = typeof payload.email === 'string' ? payload.email : null

    const allowed = (env.ACCESS_ALLOWED_EMAILS ?? '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)

    if (allowed.length > 0 && (!email || !allowed.includes(email.toLowerCase()))) {
      return { ok: false, email, reason: 'not on the allow list' }
    }

    return { ok: true, email }
  } catch (error) {
    return { ok: false, email: null, reason: error instanceof Error ? error.message : 'invalid token' }
  }
}

interface JwtPayload {
  aud?: string | string[]
  email?: string
  exp?: number
  iss?: string
  [key: string]: unknown
}

async function verifyJwt(token: string, teamDomain: string, audience: string): Promise<JwtPayload> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('malformed token')
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string]

  const header = JSON.parse(decodeSegment(encodedHeader)) as { kid?: string; alg?: string }
  if (header.alg !== 'RS256') throw new Error(`unexpected algorithm ${header.alg}`)
  if (!header.kid) throw new Error('token has no key id')

  const key = await signingKey(teamDomain, header.kid)
  const signed = new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  const signature = base64UrlToBytes(encodedSignature)

  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed)
  if (!valid) throw new Error('signature does not verify')

  const payload = JSON.parse(decodeSegment(encodedPayload)) as JwtPayload

  const audiences = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : []
  if (!audiences.includes(audience)) throw new Error('token is for a different application')

  if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) {
    throw new Error('token has expired')
  }

  const expectedIssuer = `https://${teamDomain}`
  if (payload.iss && payload.iss !== expectedIssuer) throw new Error('unexpected issuer')

  return payload
}

async function signingKey(teamDomain: string, kid: string): Promise<CryptoKey> {
  if (cachedKeys?.teamDomain === teamDomain) {
    const hit = cachedKeys.keys.get(kid)
    if (hit) return hit
  }

  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`)
  if (!response.ok) throw new Error(`could not fetch Access keys: ${response.status}`)
  const payload = (await response.json()) as { keys?: Jwk[] }

  const keys = new Map<string, CryptoKey>()
  for (const jwk of payload.keys ?? []) {
    if (jwk.kty !== 'RSA') continue
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        'jwk',
        { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      ),
    )
  }
  cachedKeys = { teamDomain, keys }

  const key = keys.get(kid)
  if (!key) throw new Error(`no Access key with id ${kid}`)
  return key
}

function decodeSegment(segment: string): string {
  return new TextDecoder().decode(base64UrlToBytes(segment))
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) return rest.join('=')
  }
  return null
}

/** Test seam: forget the cached signing keys. */
export function resetAccessKeyCache(): void {
  cachedKeys = null
}
