import type { CatalogItem } from '@ypr/shared'
import { catalogItemSchema } from '@ypr/shared'
import { getSetting, setSetting } from '../settings.js'

/**
 * Optional sync with the shared public catalog (design section 1.1).
 *
 * The request carries a cursor and nothing else — no interest, no vector, no identifier.
 * The service cannot tell one client from another or infer what any of them likes, which
 * is the only reason it is acceptable for this part to live off the machine.
 *
 * It is entirely optional. With no endpoint configured the extension works from
 * subscriptions and its own searches.
 */

const ENDPOINT_KEY = 'catalog.endpoint'
const CURSOR_KEY = 'catalog.cursor'
const PAGE_SIZE = 200
/** Bound on one sync, so a large catalog cannot stall the run indefinitely. */
const MAX_PAGES = 25

interface Cursor {
  updatedAt: string
  externalId: string
}

export async function getCatalogEndpoint(): Promise<string> {
  return getSetting<string>(ENDPOINT_KEY, '')
}

export async function setCatalogEndpoint(endpoint: string): Promise<void> {
  await setSetting(ENDPOINT_KEY, endpoint.replace(/\/$/, ''))
  // A different catalog means the old cursor means nothing.
  await setSetting<Cursor | null>(CURSOR_KEY, null)
}

export interface SharedCatalogResult {
  items: CatalogItem[]
  pages: number
  reachedEnd: boolean
}

export async function pullSharedCatalog(
  options: { fetchImpl?: typeof fetch; onProgress?: (message: string) => void } = {},
): Promise<SharedCatalogResult> {
  const endpoint = await getCatalogEndpoint()
  if (!endpoint) return { items: [], pages: 0, reachedEnd: true }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
  let cursor = await getSetting<Cursor | null>(CURSOR_KEY, null)
  const items: CatalogItem[] = []
  let pages = 0
  let reachedEnd = false

  while (pages < MAX_PAGES) {
    const url = new URL(`${endpoint}/catalog/since`)
    url.searchParams.set('limit', String(PAGE_SIZE))
    if (cursor) {
      url.searchParams.set('updatedAt', cursor.updatedAt)
      url.searchParams.set('externalId', cursor.externalId)
    }

    const response = await fetchImpl(url.toString(), { headers: { Accept: 'application/json' } })
    if (!response.ok) {
      throw new Error(`Shared catalog responded ${response.status}`)
    }

    const payload = (await response.json()) as {
      items?: unknown[]
      cursor?: Cursor | null
      hasMore?: boolean
    }

    // The catalog is another party's output, so it is validated before it reaches the
    // store rather than trusted.
    for (const candidate of payload.items ?? []) {
      const parsed = catalogItemSchema.safeParse(candidate)
      if (parsed.success) items.push(parsed.data as CatalogItem)
    }

    pages += 1
    options.onProgress?.(`Shared catalog: ${items.length} items`)
    cursor = payload.cursor ?? cursor
    if (cursor) await setSetting<Cursor>(CURSOR_KEY, cursor)
    if (!payload.hasMore) {
      reachedEnd = true
      break
    }
  }

  return { items, pages, reachedEnd }
}
