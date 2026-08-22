import { describe, expect, it } from 'vitest'
import worker, { runCrawl, type Env } from '../src/index.js'
import {
  crawlChannelUploads,
  crawlMostPopular,
  parseIso8601Duration,
  uploadsPlaylistId,
} from '../src/youtube.js'
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

function catalogItem(externalId: string, overrides: Record<string, unknown> = {}) {
  return {
    source: 'youtube' as const,
    externalId,
    title: 't',
    description: '',
    tags: [] as string[],
    channelId: 'UC_x',
    channelTitle: 'C',
    officialCategoryId: '28',
    durationSeconds: 1,
    publishedAt: NOW,
    viewCount: 0,
    metadataFetchedAt: NOW,
    expiresAt: '2026-12-01T00:00:00.000Z',
    provenance: 'youtube_api' as const,
    ...overrides,
  }
}

describe('popular chart crawl', () => {
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
          error: {
            code: 403,
            message: 'The request cannot be completed because you have exceeded your quota.',
          },
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

    expect(result.errors).toEqual([
      'JP/28: 403 The request cannot be completed because you have exceeded your quota.',
    ])
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

describe('channel uploads crawl', () => {
  const playlistThenHydrate = (ids: string[]) =>
    (async (input: RequestInfo | URL) => {
      if (String(input).includes('/playlistItems')) {
        return new Response(
          JSON.stringify({ items: ids.map((id) => ({ contentDetails: { videoId: id } })) }),
          { status: 200 },
        )
      }
      return new Response(JSON.stringify(videoPayload(ids)), { status: 200 })
    }) as unknown as typeof fetch

  it('derives the uploads playlist from the channel id', () => {
    expect(uploadsPlaylistId('UCabc123')).toBe('UUabc123')
    expect(uploadsPlaylistId('PLnot-a-channel')).toBeUndefined()
    expect(uploadsPlaylistId('UC')).toBeUndefined()
  })

  it('walks each channel and fills in the metadata a playlist entry lacks', async () => {
    const urls: string[] = []
    const capture = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return playlistThenHydrate(['a', 'b'])(input)
    }) as unknown as typeof fetch

    const result = await crawlChannelUploads({
      apiKey: 'key',
      channelIds: ['UCone'],
      now: NOW,
      fetchImpl: capture,
    })

    expect(new URL(urls[0]).searchParams.get('playlistId')).toBe('UUone')
    expect(result.items.map((item) => item.externalId).sort()).toEqual(['a', 'b'])
    // A playlist entry carries only an id; duration and views come from the second call.
    expect(result.items[0].durationSeconds).toBe(600)
    expect(result.requests).toBe(2)
  })

  it('never spends the search budget, which is a hundred times scarcer', async () => {
    const urls: string[] = []
    const capture = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return playlistThenHydrate(['a'])(input)
    }) as unknown as typeof fetch

    await crawlChannelUploads({ apiKey: 'key', channelIds: ['UCone'], now: NOW, fetchImpl: capture })
    expect(urls.some((url) => url.includes('/search'))).toBe(false)
  })

  it('skips a channel that cannot be walked instead of failing the run', async () => {
    const missing = (async (input: RequestInfo | URL) => {
      if (String(input).includes('UUgone')) {
        return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404 })
      }
      return playlistThenHydrate(['a'])(input)
    }) as unknown as typeof fetch

    const result = await crawlChannelUploads({
      apiKey: 'key',
      channelIds: ['UCgone', 'UCok'],
      now: NOW,
      fetchImpl: missing,
    })

    expect(result.skipped).toEqual(['UCgone'])
    expect(result.errors).toEqual([])
    expect(result.items).toHaveLength(1)
  })

  it('skips an id that is not a channel without calling anything', async () => {
    let calls = 0
    const counting = (async (input: RequestInfo | URL) => {
      calls += 1
      return playlistThenHydrate(['a'])(input)
    }) as unknown as typeof fetch

    const result = await crawlChannelUploads({
      apiKey: 'key',
      channelIds: ['PLplaylist'],
      now: NOW,
      fetchImpl: counting,
    })

    expect(result.skipped).toEqual(['PLplaylist'])
    expect(calls).toBe(0)
  })

  it('reaches videos with almost no views, which the popular chart cannot', async () => {
    // The whole point of this pass: a brand new upload has few views however large the
    // channel is, so the emerging and evergreen strata finally have something to draw on.
    const newUpload = (async (input: RequestInfo | URL) => {
      if (String(input).includes('/playlistItems')) {
        return new Response(JSON.stringify({ items: [{ contentDetails: { videoId: 'fresh' } }] }), {
          status: 200,
        })
      }
      return new Response(
        JSON.stringify({
          items: [
            {
              id: 'fresh',
              snippet: { title: 'Posted an hour ago', channelId: 'UCone', publishedAt: NOW },
              contentDetails: { duration: 'PT8M' },
              statistics: { viewCount: '7' },
            },
          ],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const result = await crawlChannelUploads({
      apiKey: 'key',
      channelIds: ['UCone'],
      now: NOW,
      fetchImpl: newUpload,
    })

    expect(result.items[0].viewCount).toBe(7)
  })

  it('makes no hydration call when no channel yielded anything', async () => {
    const empty = (async () =>
      new Response(JSON.stringify({ items: [] }), { status: 200 })) as unknown as typeof fetch

    const result = await crawlChannelUploads({
      apiKey: 'key',
      channelIds: ['UCone'],
      now: NOW,
      fetchImpl: empty,
    })

    expect(result.items).toEqual([])
    expect(result.requests).toBe(1)
  })
})

describe('scheduled work', () => {
  it('sweeps expired rows even when no API key is configured', async () => {
    const db = createTestDatabase()
    await upsertItems(
      db,
      [
        catalogItem('expired', {
          metadataFetchedAt: '2026-07-01T00:00:00.000Z',
          expiresAt: '2026-07-31T00:00:00.000Z',
        }),
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
      Array.from({ length: 3 }, (_, index) => catalogItem(`id-${index}`)),
      NOW,
    )

    const first = (await (
      await worker.fetch(new Request('https://catalog.test/catalog/since?limit=2'), bindings)
    ).json()) as {
      items: Array<{ externalId: string }>
      cursor: { updatedAt: string; externalId: string }
      hasMore: boolean
    }

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
