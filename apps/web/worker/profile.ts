import { DEFAULT_PROFILE_ID } from '@ypr/domain'
import type { Env } from './env.js'

/**
 * Which set of preferences a request belongs to (`docs/design/multi-profile.ja.md`).
 *
 * One person can hold several YouTube accounts whose subscriptions and history have
 * nothing to do with each other, and learning them as one preference lets the louder
 * account decide what the quieter one is shown. So each gets its own hostname, and the
 * hostname is what says which profile a request is for.
 *
 * The mapping is explicit rather than derived from the subdomain. Deriving it — taking
 * `work` out of `yt-work.example.com` — means any Host the Worker can be reached under
 * names a profile, and `ensureProfile` inserts on demand: a `workers.dev` subdomain, a
 * preview URL or a mistyped CNAME would quietly create an account with an empty history
 * and no way to notice. A table refuses that by omission.
 */

/** `{"yt.example.com":"default","yt-work.example.com":"work"}` */
type HostMap = Record<string, string>

function parseHostMap(raw: string | undefined): HostMap {
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const map: HostMap = {}
    for (const [host, profile] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof profile === 'string' && profile) map[host.toLowerCase()] = profile
    }
    return map
  } catch {
    // A malformed table falls back to the single default rather than refusing every
    // request. Getting the JSON wrong should not take the application off the air.
    return {}
  }
}

/**
 * The profile a request is for, from the host it arrived on.
 *
 * An unlisted host answers as the default profile rather than being refused, because the
 * `workers.dev` URL still works and there is no reason for this change to break it.
 * Access decides who may reach any of these hosts; this only decides whose data they see.
 */
export function profileForRequest(env: Env, requestUrl: string): string {
  const map = parseHostMap(env.PROFILE_HOSTS)
  let host: string
  try {
    host = new URL(requestUrl).host.toLowerCase()
  } catch {
    return DEFAULT_PROFILE_ID
  }
  return map[host] ?? DEFAULT_PROFILE_ID
}

/** Every profile the host table names, default included. Used to check the table. */
export function mappedProfiles(env: Env): string[] {
  const named = new Set<string>(Object.values(parseHostMap(env.PROFILE_HOSTS)))
  named.add(DEFAULT_PROFILE_ID)
  return [...named].sort()
}
