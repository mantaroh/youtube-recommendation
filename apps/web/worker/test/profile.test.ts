import { describe, expect, it } from 'vitest'
import { DEFAULT_PROFILE_ID } from '@ypr/domain'
import type { Env } from '../env.js'
import { mappedProfiles, profileForRequest } from '../profile.js'

/**
 * Which account a request belongs to (`docs/design/multi-profile.ja.md`).
 *
 * Worth testing carefully for one reason: getting this wrong is silent. A request routed
 * to the wrong profile shows someone else's feed and writes ratings into it, and nothing
 * anywhere raises an error — the tables accept any profile id at all.
 */

const HOSTS = JSON.stringify({
  'yt.example.com': 'default',
  'yt-work.example.com': 'work',
})

function env(profileHosts?: string): Env {
  return { PROFILE_HOSTS: profileHosts } as Env
}

describe('resolving a profile from the host', () => {
  it('maps a listed host to its profile', () => {
    expect(profileForRequest(env(HOSTS), 'https://yt-work.example.com/api/status')).toBe('work')
    expect(profileForRequest(env(HOSTS), 'https://yt.example.com/api/status')).toBe('default')
  })

  it('ignores the case of the host', () => {
    // Hosts are case-insensitive, and a proxy is free to change the case. Treating
    // `YT-Work` as unlisted would silently serve the default profile's data.
    expect(profileForRequest(env(HOSTS), 'https://YT-Work.Example.com/api/status')).toBe('work')
  })

  it('keeps the port as part of the host', () => {
    // `wrangler dev` serves on localhost:8787, which is a distinct host from the
    // deployment and should not have to be spelled differently.
    const local = JSON.stringify({ 'localhost:8787': 'work' })
    expect(profileForRequest(env(local), 'http://localhost:8787/api/status')).toBe('work')
    expect(profileForRequest(env(local), 'http://localhost:3000/api/status')).toBe(DEFAULT_PROFILE_ID)
  })

  it('answers as the default profile for an unlisted host', () => {
    // The workers.dev URL still works and there is no reason for this to break it.
    expect(profileForRequest(env(HOSTS), 'https://something-else.workers.dev/api/status')).toBe(
      DEFAULT_PROFILE_ID,
    )
  })

  it('does not invent a profile from the subdomain', () => {
    // The reason the mapping is a table. `ensureProfile` inserts on demand, so deriving
    // `staging` from the host would create an account with an empty history the moment
    // anything reached the Worker under an unexpected name.
    expect(profileForRequest(env(HOSTS), 'https://yt-staging.example.com/api/status')).toBe(
      DEFAULT_PROFILE_ID,
    )
  })

  it('falls back to the default profile rather than failing on a malformed table', () => {
    // Getting the JSON wrong should degrade to one profile, not take the site off the air.
    expect(profileForRequest(env('not json at all'), 'https://yt.example.com/')).toBe(DEFAULT_PROFILE_ID)
    expect(profileForRequest(env('["yt.example.com"]'), 'https://yt.example.com/')).toBe(
      DEFAULT_PROFILE_ID,
    )
    expect(profileForRequest(env(undefined), 'https://yt.example.com/')).toBe(DEFAULT_PROFILE_ID)
  })

  it('skips entries whose profile is not a usable name', () => {
    const partly = JSON.stringify({ 'a.example.com': '', 'b.example.com': 12, 'c.example.com': 'ok' })
    expect(profileForRequest(env(partly), 'https://a.example.com/')).toBe(DEFAULT_PROFILE_ID)
    expect(profileForRequest(env(partly), 'https://b.example.com/')).toBe(DEFAULT_PROFILE_ID)
    expect(profileForRequest(env(partly), 'https://c.example.com/')).toBe('ok')
  })

  it('handles a request URL it cannot parse', () => {
    expect(profileForRequest(env(HOSTS), 'not-a-url')).toBe(DEFAULT_PROFILE_ID)
  })
})

describe('listing mapped profiles', () => {
  it('includes the default even when the table omits it', () => {
    expect(mappedProfiles(env(JSON.stringify({ 'yt-work.example.com': 'work' })))).toEqual([
      'default',
      'work',
    ])
  })

  it('does not repeat a profile that several hosts point at', () => {
    const shared = JSON.stringify({ 'a.example.com': 'work', 'b.example.com': 'work' })
    expect(mappedProfiles(env(shared))).toEqual(['default', 'work'])
  })
})
