/**
 * Everything the Worker is given at runtime.
 *
 * The secrets are listed in design section 43 and share one property: none of them is
 * ever sent to the browser. The SPA calls this Worker, and this Worker calls YouTube
 * and Runpod. There is no path by which a page can reach either directly.
 */
export interface Env {
  DB: D1Database
  /** Backups and exports (design sections 45 and 46). Optional in development. */
  BACKUPS?: R2Bucket
  /** The built SPA. Served for anything that is not `/api`. */
  ASSETS?: Fetcher

  // -- Secrets -------------------------------------------------------------

  /** Server-to-server YouTube calls that act as nobody in particular. */
  YOUTUBE_API_KEY?: string
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  /** Base64 AES-256 key wrapping the stored OAuth tokens (design section 16). */
  OAUTH_ENCRYPTION_KEY?: string
  RUNPOD_API_KEY?: string
  RUNPOD_ENDPOINT_ID?: string
  /**
   * An engine somewhere other than Runpod, e.g. `http://127.0.0.1:9000`.
   *
   * The GPU service speaks one envelope and three routes, none of them Runpod's own,
   * so the same container can be reached at a plain address. Set this and the Runpod
   * credentials become optional — which is what lets the whole job pipeline be
   * exercised on a machine with no GPU account at all.
   */
  PREFERENCE_ENGINE_URL?: string

  // -- Vars ----------------------------------------------------------------

  /** Cloudflare Access team domain, e.g. `example.cloudflareaccess.com`. */
  ACCESS_TEAM_DOMAIN?: string
  /** Access application audience tag. Without it, Access verification is not enforced. */
  ACCESS_AUD?: string
  /** Comma-separated list of addresses allowed through (design section 43). */
  ACCESS_ALLOWED_EMAILS?: string

  /** Absolute URL of `/api/auth/youtube/callback`, as registered with Google. */
  OAUTH_REDIRECT_URI?: string

  CRAWL_REGIONS?: string
  CRAWL_CATEGORIES?: string
  CRAWL_CHANNELS_PER_RUN?: string
  CRAWL_UPLOADS_PER_CHANNEL?: string
  /** `search.list` calls one discovery run may spend (design section 42). */
  DISCOVERY_SEARCH_BUDGET?: string
}

/** Request-scoped context shared by every route. */
export interface AppContext {
  env: Env
  /** Address Access authenticated, or `null` when Access is not configured. */
  identity: string | null
  profileId: string
  now: number
}

export function splitList(value: string | undefined, fallback: string[]): string[] {
  if (!value) return fallback
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  return parts.length > 0 ? parts : fallback
}
