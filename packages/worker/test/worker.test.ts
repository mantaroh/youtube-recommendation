import { describe, expect, it } from 'vitest'
import worker, { runCrawl, type Env } from '../src/index.js'
import { crawlMostPopular, crawlRecentUploads, parseIso8601Duration } from '../src/youtube.js'
import { upsertItems } from '../src/catalog.js'
import { createTestDatabase } from './d1.js'

const NOW = '2026-08-22T00:00:00.000Z'

function videoPayload(ids: string[]) {
  return {
    items: ids.map((id) => ({
      id,
      snippet: {
        title: `Title ${id}`,
        description: 'description',
        tags: ['tag'],
        channelId: 'UC_x',
        channelTitle: 'Channel',
        categoryId: '28',
        publishedAt: '2026-08-01T00:00:00.000Z',
      },
      contentDetails: { duration: 'PT10M' },
      statistics: { viewCount: '4321' },
    })),
  }
}

function stubFetch(handler: (url: string) => unknown): typeof fetch {
  return (async (input: RequestInfo | URL) =>
    new Response(JSON.stringify(handler(String(input))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch
}

describe('crawl', () => {
  it('collects each video once even when regions overlap', async () => {
    const result = await crawlMostPopular({
      apiKey: 'key',
      regions: ['JP', 'US'],
      categories: ['28'],
      now: NOW,
      fetchImpl: stubFetch(() => videoPayload(['a', 'b'])),
    })

    expect(result.requests).toBe(2)
    expect(result.items.map((item) => item.externalId).sort()).toEqual(['a', 'b'])
    expect(result.errors).toEqual([])
  })

  it('stamps a 30 day TTL on everything it collects', async () => {
    const result = await crawlMostPopular({
      apiKey: 'key',
      regions: ['JP'],
      categories: ['28'],
      now: NOW,
      fetchImpl: stubFetch(() => videoPayload(['a'])),
    })

    const item = result.items[0]
    expect((Date.parse(item.expiresAt) - Date.parse(item.metadataFetchedAt)) / 86_400_000).toBe(30)
  })

  it('treats a category with no chart as skipped rather than as a failure', async () => {
    // Which region and category pairs are charted varies and changes; a 404 means there is
    // nothing to fetch, and reporting it as an error every run would cry wolf.
    const noChart = (async (input: RequestInfo | URL) => {
      if (String(input).includes('videoCategoryId=27')) {
        return new Response(
          JSON.stringify({ error: { code: 404, message: 'Requested entity was not found.' } }),
          { status: 404 },
        )
      }
      return new Response(JSON.stringify(videoPayload(['a'])), { status: 200 })
    }) as unknown as typeof fetch

    const result = await crawlMostPopular({
      apiKey: 'key',
      regions: ['JP'],
      categories: ['28', '27'],
      now: NOW,
      fetchImpl: noChart,
    })

    expect(result.skipped).toEqual(['JP/27'])
    expect(result.errors).toEqual([])
    expect(result.items).toHaveLength(1)
  })

  it('reports the reason from a failure rather than the whole response body', async () => {
    const failing = (async () =>
      new Response(
        JSON.stringify({
          error: { code: 403, message: 'The request cannot be completed because you have exceeded your quota.' },
        }),
        { status: 403 },
      )) as unknown as typeof fetch

    const result = await crawlMostPopular({
      apiKey: 'key',
      regions: ['JP'],
      categories: ['28'],
      now: NOW,
      fetchImpl: failing,
    })

    expect(result.errors).toEqual(['JP/28: 403 The request cannot be completed because you have exceeded your quota.'])
  })

  it('records a failing region without abandoning the rest of the crawl', async () => {
    const failing = (async (input: RequestInfo | URL) => {
      if (String(input).includes('regionCode=JP')) {
        return new Response('quota exceeded', { status: 403 })
      }
      return new Response(JSON.stringify(videoPayload(['a'])), { status: 200 })
    }) as unknown as typeof fetch

    const result = await crawlMostPopular({
      apiKey: 'key',
      regions: ['JP', 'US'],
      categories: ['28'],
      now: NOW,
      fetchImpl: failing,
    })

    expect(result.errors).toHaveLength(1)
    expect(result.items).toHaveLength(1)
  })

  it('reads ISO 8601 durations', () => {
    expect(parseIso8601Duration('PT1H30M')).toBe(5400)
    expect(parseIso8601Duration(undefined)).toBe(0)
  })
})

describe('recent uploads crawl', () => {
  const searchThenHydrate = (ids: string[]) =>
    (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/search')) {
        return new Response(JSON.stringify({ items: ids.map((id) => ({ id: { videoId: id } })) }), {
          status: 200,
        })
      }
      return new Response(JSON.stringify(videoPayload(ids)), { status: 200 })
    }) as unknown as typeof fetch

  it('searches by date and fills in the metadata search does not return', async () => {
    const result = await crawlRecentUploads({
      apiKey: 'key',
      regions: ['JP'],
      categories: ['28'],
      now: NOW,
      fetchImpl: searchThenHydrate(['a', 'b']),
    })

    expect(result.items.map((item) => item.externalId).sort()).toEqual(['a', 'b'])
    // Search alone carries no duration or view count; those come from the second call.
    expect(result.items[0].durationSeconds).toBe(600)
    expect(result.items[0].viewCount).toBe(4321)
    expect(result.requests).toBe(2)
  })

  it('asks only for uploads inside the window', async () => {
    const urls: string[] = []
    const capture = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return new Response(JSON.stringify({ items: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await crawlRecentUploads({
      apiKey: 'key',
      regions: ['JP'],
      categories: ['28'],
      days: 7,
      now: NOW,
      fetchImpl: capture,
    })

    const publishedAfter = new URL(urls[0]).searchParams.get("publishedAfter")!
    expect(Date.parse(NOW) - Date.parse(publishedAfter)).toBe(7 * 86_400_000)
    expect(new URL(urls[0]).searchParams.get('order')).toBe('date')
  })

  it('makes no hydration call when nothing was found', async () => {
    const empty = (async () =>
      new Response(JSON.stringify({ items: [] }), { status: 200 })) as unknown as typeof fetch

    const result = await crawlRecentUploads({
      apiKey: 'key',
      regions: ['JP'],
      categories: ['28'],
      now: NOW,
      fetchImpl: empty,
    })

    expect(result.items).toEqual([])
    expect(result.requests).toBe(1)
  })

  it('reaches beyond the popular chart, which is what the strata need', async () => {
    // The point of the second pass: `chart=mostPopular` can only return established
    // videos, so the emerging and evergreen slots could never be filled from it.
    const unpopular = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/search')) {
        return new Response(JSON.stringify({ items: [{ id: { videoId: 'small' } }] }), { status: 200 })
      }
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'small',
              snippet: { title: 'A new upload', channelId: 'UC_x', publishedAt: NOW },
              contentDetails: { duration: 'PT5M' },
              statistics: { viewCount: '12' },
            },
          ],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const result = await crawlRecentUploads({
      apiKey: 'key',
      regions: ['JP'],
      categories: ['28'],
      now: NOW,
      fetchImpl: unpopular,
    })

    expect(result.items[0].viewCount).toBe(12)
  })
})

describe('scheduled work', () => {
  it('sweeps expired rows even when no API key is configured', async () => {
    const db = createTestDatabase()
    await upsertItems(
      db,
      [
        {
          source: 'youtube',
          externalId: 'expired',
          title: 't',
          description: '',
          tags: [],
          channelId: 'UC',
          channelTitle: 'C',
          officialCategoryId: '28',
          durationSeconds: 1,
          publishedAt: NOW,
          viewCount: 0,
          metadataFetchedAt: '2026-07-01T00:00:00.000Z',
          expiresAt: '2026-07-31T00:00:00.000Z',
          provenance: 'youtube_api',
        },
      ],
      NOW,
    )

    const summary = await runCrawl({ DB: db } as Env, NOW)

    expect(summary.purged).toBe(1)
    expect(summary.errors).toContain('YOUTUBE_API_KEY is not set')
  })
})

describe('http surface', () => {
  const env = (): Env => ({ DB: createTestDatabase(), ADMIN_TOKEN: 'secret' })

  it('reports health', async () => {
    const response = await worker.fetch(new Request('https://catalog.test/health'), env())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, items: 0 })
  })

  it('serves the catalog to any origin, since it holds nothing user specific', async () => {
    const response = await worker.fetch(new Request('https://catalog.test/catalog/since'), env())
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(await response.json()).toMatchObject({ items: [], hasMore: false })
  })

  it('refuses an unauthenticated crawl', async () => {
    const response = await worker.fetch(
      new Request('https://catalog.test/admin/crawl', { method: 'POST' }),
      env(),
    )
    expect(response.status).toBe(401)
  })

  it('accepts a crawl with the admin token', async () => {
    const response = await worker.fetch(
      new Request('https://catalog.test/admin/crawl', {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
      }),
      env(),
    )
    expect(response.status).toBe(200)
  })

  it('pages the catalog through a cursor', async () => {
    const bindings = env()
    await upsertItems(
      bindings.DB,
      Array.from({ length: 3 }, (_, index) => ({
        source: 'youtube' as const,
        externalId: `id-${index}`,
        title: 't',
        description: '',
        tags: [],
        channelId: 'UC',
        channelTitle: 'C',
        officialCategoryId: '28',
        durationSeconds: 1,
        publishedAt: NOW,
        viewCount: 0,
        metadataFetchedAt: NOW,
        expiresAt: '2026-12-01T00:00:00.000Z',
        provenance: 'youtube_api' as const,
      })),
      NOW,
    )

    const first = (await (
      await worker.fetch(new Request('https://catalog.test/catalog/since?limit=2'), bindings)
    ).json()) as { items: Array<{ externalId: string }>; cursor: { updatedAt: string; externalId: string }; hasMore: boolean }

    expect(first.items).toHaveLength(2)
    expect(first.hasMore).toBe(true)

    const second = (await (
      await worker.fetch(
        new Request(
          `https://catalog.test/catalog/since?limit=2&updatedAt=${encodeURIComponent(first.cursor.updatedAt)}&externalId=${first.cursor.externalId}`,
        ),
        bindings,
      )
    ).json()) as { items: Array<{ externalId: string }>; hasMore: boolean }

    expect(second.items).toHaveLength(1)
    expect(second.hasMore).toBe(false)
  })
})
