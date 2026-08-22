import { beforeEach, describe, expect, it } from 'vitest'
import {
  getCatalogEndpoint,
  pullSharedCatalog,
  setCatalogEndpoint,
} from '../src/lib/sources/sharedCatalog.js'
import { useFreshDb } from './helpers.js'

const NOW = '2026-08-22T00:00:00.000Z'

function catalogItem(externalId: string) {
  return {
    source: 'youtube',
    externalId,
    title: `Title ${externalId}`,
    description: '',
    tags: [],
    channelId: 'UC_x',
    channelTitle: 'Channel',
    officialCategoryId: '28',
    durationSeconds: 60,
    publishedAt: NOW,
    viewCount: 10,
    metadataFetchedAt: NOW,
    expiresAt: '2026-09-21T00:00:00.000Z',
    provenance: 'youtube_api',
  }
}

function jsonFetch(pages: Array<{ items: unknown[]; cursor: unknown; hasMore: boolean }>): {
  fetchImpl: typeof fetch
  urls: string[]
} {
  const urls: string[] = []
  let call = 0
  const fetchImpl = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    const page = pages[Math.min(call, pages.length - 1)]
    call += 1
    return new Response(JSON.stringify(page), { status: 200 })
  }) as unknown as typeof fetch
  return { fetchImpl, urls }
}

describe('shared catalog sync', () => {
  beforeEach(() => {
    useFreshDb()
  })

  it('does nothing when no endpoint is configured', async () => {
    const result = await pullSharedCatalog()
    expect(result).toEqual({ items: [], pages: 0, reachedEnd: true })
  })

  it('normalises a trailing slash on the endpoint', async () => {
    await setCatalogEndpoint('https://catalog.example.workers.dev/')
    expect(await getCatalogEndpoint()).toBe('https://catalog.example.workers.dev')
  })

  it('follows the cursor across pages and stops at the end', async () => {
    await setCatalogEndpoint('https://catalog.example.workers.dev')
    const { fetchImpl, urls } = jsonFetch([
      { items: [catalogItem('a')], cursor: { updatedAt: NOW, externalId: 'a' }, hasMore: true },
      { items: [catalogItem('b')], cursor: { updatedAt: NOW, externalId: 'b' }, hasMore: false },
    ])

    const result = await pullSharedCatalog({ fetchImpl })

    expect(result.items.map((item) => item.externalId)).toEqual(['a', 'b'])
    expect(result.reachedEnd).toBe(true)
    // The second request carries the cursor from the first, and nothing else.
    expect(urls[1]).toContain('externalId=a')
    for (const url of urls) {
      expect(url).not.toMatch(/interest|vector|user|rating/i)
    }
  })

  it('resumes from the stored cursor on the next run', async () => {
    await setCatalogEndpoint('https://catalog.example.workers.dev')
    const first = jsonFetch([
      { items: [catalogItem('a')], cursor: { updatedAt: NOW, externalId: 'a' }, hasMore: false },
    ])
    await pullSharedCatalog({ fetchImpl: first.fetchImpl })

    const second = jsonFetch([{ items: [], cursor: null, hasMore: false }])
    await pullSharedCatalog({ fetchImpl: second.fetchImpl })

    expect(second.urls[0]).toContain('externalId=a')
  })

  it('drops malformed entries rather than letting them into the store', async () => {
    await setCatalogEndpoint('https://catalog.example.workers.dev')
    const { fetchImpl } = jsonFetch([
      {
        items: [catalogItem('good'), { externalId: 'bad' }, null],
        cursor: null,
        hasMore: false,
      },
    ])

    const result = await pullSharedCatalog({ fetchImpl })
    expect(result.items.map((item) => item.externalId)).toEqual(['good'])
  })

  it('surfaces a failing catalog as an error instead of silently syncing nothing', async () => {
    await setCatalogEndpoint('https://catalog.example.workers.dev')
    const failing = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    await expect(pullSharedCatalog({ fetchImpl: failing })).rejects.toThrow(/503/)
  })

  it('forgets the cursor when the endpoint changes', async () => {
    await setCatalogEndpoint('https://one.workers.dev')
    const first = jsonFetch([
      { items: [catalogItem('a')], cursor: { updatedAt: NOW, externalId: 'a' }, hasMore: false },
    ])
    await pullSharedCatalog({ fetchImpl: first.fetchImpl })

    await setCatalogEndpoint('https://two.workers.dev')
    const second = jsonFetch([{ items: [], cursor: null, hasMore: false }])
    await pullSharedCatalog({ fetchImpl: second.fetchImpl })

    expect(second.urls[0]).not.toContain('externalId')
  })
})
