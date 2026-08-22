import { beforeEach, describe, expect, it } from 'vitest'
import { HashingInferenceEngine } from '@ypr/core'
import { embedMissing, purgeExpired, runIngestion, storeItems } from '../src/lib/ingest.js'
import { FixtureSourceAdapter, buildFixtureCatalog } from '../src/lib/sources/youtube/fixtures.js'
import { type PreferenceDatabase } from '../src/lib/db.js'
import { useFreshDb } from './helpers.js'

const NOW = '2026-08-22T00:00:00.000Z'

describe('ingestion', () => {
  let db: PreferenceDatabase
  const engine = new HashingInferenceEngine(384)

  beforeEach(() => {
    db = useFreshDb()
  })

  it('fetches, stores and embeds in one run', async () => {
    const report = await runIngestion({
      engine,
      now: () => NOW,
      adapter: new FixtureSourceAdapter(() => NOW),
      mode: 'fixture',
    })

    expect(report.channelCount).toBeGreaterThan(0)
    expect(report.fetchedItems).toBeGreaterThan(0)
    expect(report.newItems).toBe(report.fetchedItems)
    expect(report.embedded).toBe(report.fetchedItems)
    expect(report.errors).toEqual([])

    expect(await db.items.count()).toBe(report.fetchedItems)
    expect(await db.embeddings.count()).toBe(report.fetchedItems)

    const embedding = await db.embeddings.toCollection().first()
    expect(embedding?.modelId).toBe(engine.modelId)
    expect(embedding?.vector).toHaveLength(384)
  })

  it('does not re-embed on a second run', async () => {
    const adapter = new FixtureSourceAdapter(() => NOW)
    await runIngestion({ engine, now: () => NOW, adapter, mode: 'fixture' })
    const second = await runIngestion({ engine, now: () => NOW, adapter, mode: 'fixture' })
    expect(second.embedded).toBe(0)
    expect(second.newItems).toBe(0)
  })

  it('re-embeds everything when the model changes, without touching the catalog', async () => {
    const adapter = new FixtureSourceAdapter(() => NOW)
    const first = await runIngestion({ engine, now: () => NOW, adapter, mode: 'fixture' })

    const replacement = new HashingInferenceEngine(384, 'local/hashing-bow-v2')
    const embedded = await embedMissing(replacement)

    expect(embedded).toBe(first.fetchedItems)
    expect(await db.items.count()).toBe(first.fetchedItems)
    // Both generations coexist: the old vectors are only dropped when their item is.
    expect(await db.embeddings.where('modelId').equals('local/hashing-bow-v2').count()).toBe(embedded)
  })

  it('drops metadata past its TTL along with the vectors derived from it', async () => {
    const catalog = buildFixtureCatalog({ now: NOW })
    await storeItems(catalog)
    await embedMissing(engine)
    expect(await db.items.count()).toBe(catalog.length)

    const wellPastTtl = '2026-10-22T00:00:00.000Z'
    const purged = await purgeExpired(wellPastTtl)

    expect(purged).toBe(catalog.length)
    expect(await db.items.count()).toBe(0)
    expect(await db.embeddings.count()).toBe(0)
  })

  it('keeps ratings when the metadata they refer to expires', async () => {
    const catalog = buildFixtureCatalog({ now: NOW })
    await storeItems(catalog)
    await db.ratings.put({
      source: 'youtube',
      externalId: catalog[0].externalId,
      rating: 5,
      ratedAt: NOW,
    })

    await purgeExpired('2026-10-22T00:00:00.000Z')

    // Our own feedback is not external API data and outlives the 30 day TTL.
    expect(await db.ratings.count()).toBe(1)
  })

  it('reports the fixture fallback rather than failing when no source is configured', async () => {
    const report = await runIngestion({ engine, now: () => NOW })
    expect(report.mode).toBe('fixture')
    expect(report.reason).toMatch(/client id|API key/i)
    expect(report.fetchedItems).toBeGreaterThan(0)
  })
})

describe('fixture catalog', () => {
  it('is deterministic', () => {
    const first = buildFixtureCatalog({ now: NOW })
    const second = buildFixtureCatalog({ now: NOW })
    expect(first).toEqual(second)
  })

  it('spans the popularity strata instead of being uniformly popular', () => {
    const catalog = buildFixtureCatalog({ now: NOW })
    expect(catalog.some((item) => item.viewCount < 1000)).toBe(true)
    expect(catalog.some((item) => item.viewCount > 100_000)).toBe(true)
  })

  it('marks every item as fixture data so it cannot pass for API data', () => {
    expect(buildFixtureCatalog({ now: NOW }).every((item) => item.provenance === 'fixture')).toBe(true)
  })
})
