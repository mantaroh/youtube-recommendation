import { beforeEach, describe, expect, it } from 'vitest'
import type { CatalogItem } from '@ypr/shared'
import { countItems, listSince, purgeExpired, upsertItems } from '../src/catalog.js'
import { createTestDatabase } from './d1.js'

const NOW = '2026-08-22T00:00:00.000Z'

function item(overrides: Partial<CatalogItem> & { externalId: string }): CatalogItem {
  return {
    source: 'youtube',
    title: `Title ${overrides.externalId}`,
    description: 'description',
    tags: ['a', 'b'],
    channelId: 'UC_x',
    channelTitle: 'Channel',
    officialCategoryId: '28',
    durationSeconds: 600,
    publishedAt: NOW,
    viewCount: 1000,
    metadataFetchedAt: NOW,
    expiresAt: '2026-09-21T00:00:00.000Z',
    provenance: 'youtube_api',
    ...overrides,
  }
}

describe('catalog storage', () => {
  let db: D1Database

  beforeEach(() => {
    db = createTestDatabase()
  })

  it('stores items and reads them back intact', async () => {
    await upsertItems(db, [item({ externalId: 'a', tags: ['browser', 'rendering'] })], NOW)
    const page = await listSince(db, null, 10)

    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      source: 'youtube',
      externalId: 'a',
      tags: ['browser', 'rendering'],
      viewCount: 1000,
    })
  })

  it('updates rather than duplicating on a second write of the same video', async () => {
    await upsertItems(db, [item({ externalId: 'a', viewCount: 10 })], NOW)
    await upsertItems(db, [item({ externalId: 'a', viewCount: 999 })], '2026-08-23T00:00:00.000Z')

    expect(await countItems(db)).toBe(1)
    const page = await listSince(db, null, 10)
    expect(page.items[0].viewCount).toBe(999)
  })

  it('pages without skipping items written in the same batch', async () => {
    // Every row shares an `updated_at`, which is exactly the case a timestamp-only cursor
    // gets wrong.
    const batch = Array.from({ length: 5 }, (_, index) => item({ externalId: `id-${index}` }))
    await upsertItems(db, batch, NOW)

    const seen: string[] = []
    let cursor = null as Awaited<ReturnType<typeof listSince>>['cursor']
    let guard = 0

    do {
      const page: Awaited<ReturnType<typeof listSince>> = await listSince(db, cursor, 2)
      seen.push(...page.items.map((entry) => entry.externalId))
      cursor = page.cursor
      if (!page.hasMore) break
    } while (guard++ < 10)

    expect(seen.sort()).toEqual(['id-0', 'id-1', 'id-2', 'id-3', 'id-4'])
  })

  it('returns only what changed after the cursor', async () => {
    await upsertItems(db, [item({ externalId: 'old' })], '2026-08-01T00:00:00.000Z')
    await upsertItems(db, [item({ externalId: 'new' })], '2026-08-20T00:00:00.000Z')

    const page = await listSince(db, { updatedAt: '2026-08-01T00:00:00.000Z', externalId: 'old' }, 10)
    expect(page.items.map((entry) => entry.externalId)).toEqual(['new'])
  })

  it('deletes what is past its TTL and leaves the rest', async () => {
    await upsertItems(
      db,
      [
        item({ externalId: 'expired', expiresAt: '2026-08-01T00:00:00.000Z' }),
        item({ externalId: 'live', expiresAt: '2026-12-01T00:00:00.000Z' }),
      ],
      NOW,
    )

    expect(await purgeExpired(db, NOW)).toBe(1)
    const page = await listSince(db, null, 10)
    expect(page.items.map((entry) => entry.externalId)).toEqual(['live'])
  })

  it('caps the page size a caller can ask for', async () => {
    await upsertItems(
      db,
      Array.from({ length: 20 }, (_, index) => item({ externalId: `id-${index}` })),
      NOW,
    )
    const page = await listSince(db, null, 100_000)
    expect(page.items.length).toBeLessThanOrEqual(500)
    expect(page.items).toHaveLength(20)
  })

  it('survives a row whose tags are not valid JSON', async () => {
    await db
      .prepare(
        `INSERT INTO catalog_item VALUES ('youtube','broken','t','d','not json','UC','C','28',1,?1,0,?1,?2,'youtube_api',?1)`,
      )
      .bind(NOW, '2026-12-01T00:00:00.000Z')
      .run()

    const page = await listSince(db, null, 10)
    expect(page.items[0].tags).toEqual([])
  })
})
