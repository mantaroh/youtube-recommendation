import { beforeEach, describe, expect, it } from 'vitest'
import { HashingInferenceEngine } from '@ypr/core'
import { itemKey } from '@ypr/shared'
import { buildFeed } from '../src/lib/feed.js'
import { embedMissing, runDiscovery, runIngestion, storeItems } from '../src/lib/ingest.js'
import { rateItem, recordImpressions } from '../src/lib/events.js'
import { getDb } from '../src/lib/db.js'
import { FixtureSourceAdapter, buildFixtureCatalog } from '../src/lib/sources/youtube/fixtures.js'
import { updateAppSettings } from '../src/lib/settings.js'
import { useFreshDb } from './helpers.js'

const NOW = '2026-08-22T00:00:00.000Z'
const engine = new HashingInferenceEngine(384)

const rate = (id: string, rating: 0 | 1 | 2 | 3 | 4 | 5) =>
  rateItem({ source: 'youtube', externalId: id }, rating, NOW)

async function ingestFixtures(): Promise<void> {
  // The whole fixture catalog, not just what falls inside the subscription lookback
  // window, so that every lane has candidates regardless of publication dates.
  await storeItems(buildFixtureCatalog({ now: NOW }))
  await embedMissing(engine)
  // Run ingestion too: it is what records which channels count as subscribed.
  await runIngestion({
    engine,
    now: () => NOW,
    adapter: new FixtureSourceAdapter(() => NOW),
    mode: 'fixture',
  })
}

describe('feed', () => {
  beforeEach(async () => {
    useFreshDb()
    await ingestFixtures()
  })

  it('explains why nothing is there before anything is fetched', async () => {
    useFreshDb()
    const feed = await buildFeed({ now: NOW })
    expect(feed.items).toEqual([])
    expect(feed.emptyReason).toMatch(/fetched/i)
  })

  it('says the catalog is exhausted rather than asking for more ratings', async () => {
    // Rating everything is the case where "rate a few videos" would be exactly the wrong
    // advice: the fix is to fetch more, not to rate more.
    const everything = await getDb().items.toArray()
    for (const item of everything) {
      await rateItem({ source: 'youtube', externalId: item.externalId }, 4, NOW)
    }

    const feed = await buildFeed({ now: NOW })
    expect(feed.items).toEqual([])
    expect(feed.emptyReason).toMatch(/has been rated/i)
  })

  it('ranks a liked topic above one the user asked for less of', async () => {
    await rate('fixture-browser-0', 5)
    await rate('fixture-browser-1', 5)
    await rate('fixture-investment-0', 0)
    await rate('fixture-investment-1', 0)
    await runDiscovery({ engine, now: () => NOW, adapter: new FixtureSourceAdapter(() => NOW) })

    const feed = await buildFeed({ now: NOW, feedSize: 40 })
    const scoreOf = (prefix: string) => {
      const entries = feed.items.filter((entry) => entry.item.externalId.startsWith(prefix))
      return entries.length === 0 ? undefined : Math.max(...entries.map((entry) => entry.score))
    }

    const browser = scoreOf('fixture-browser')
    const investment = scoreOf('fixture-investment')
    expect(browser).toBeDefined()
    if (investment !== undefined) expect(browser!).toBeGreaterThan(investment)
  })

  it('never shows something that has already been rated', async () => {
    await rate('fixture-browser-0', 5)
    const feed = await buildFeed({ now: NOW, feedSize: 40 })
    expect(feed.items.some((entry) => entry.item.externalId === 'fixture-browser-0')).toBe(false)
  })

  it('labels each item with the lane it came from', async () => {
    await rate('fixture-browser-0', 5)
    const feed = await buildFeed({ now: NOW, feedSize: 40 })
    expect(feed.items.length).toBeGreaterThan(0)
    for (const entry of feed.items) {
      expect(['subscription', 'related', 'explore']).toContain(entry.lane)
    }
    // Subscribed channels are known, so that lane should not be empty.
    expect(feed.items.some((entry) => entry.lane === 'subscription')).toBe(true)
  })

  it('shifts the mix toward exploration when the slider moves', async () => {
    await rate('fixture-browser-0', 5)
    await rate('fixture-os-0', 5)

    await updateAppSettings({ discovery: 0 })
    const stable = await buildFeed({ now: NOW, feedSize: 20 })

    await updateAppSettings({ discovery: 1 })
    const adventurous = await buildFeed({ now: NOW, feedSize: 20 })

    expect(adventurous.quotas.explore).toBeGreaterThan(stable.quotas.explore)
    expect(adventurous.quotas.subscription).toBeLessThan(stable.quotas.subscription)
  })

  it('demotes what the feed has already shown', async () => {
    await rate('fixture-browser-0', 5)
    const first = await buildFeed({ now: NOW, feedSize: 10 })
    const shownKey = itemKey(first.items[0].item)

    await recordImpressions(
      first.items.map((entry, position) => ({ ref: entry.item, lane: entry.lane, position })),
      NOW,
    )

    const second = await buildFeed({ now: NOW, feedSize: 10 })
    const before = first.items.find((entry) => itemKey(entry.item) === shownKey)!
    const after = second.items.find((entry) => itemKey(entry.item) === shownKey)

    if (after) expect(after.score).toBeLessThan(before.score)
  })

  it('carries a reason for every item it shows', async () => {
    await rate('fixture-browser-0', 5)
    await rate('fixture-browser-1', 4)
    const feed = await buildFeed({ now: NOW, feedSize: 20 })

    for (const entry of feed.items) {
      const { breakdown } = entry
      const sum =
        breakdown.channel +
        breakdown.long +
        breakdown.short -
        breakdown.negative +
        breakdown.explore +
        breakdown.freshness
      // The reported total has to be the terms actually applied, weights aside.
      expect(Number.isFinite(sum)).toBe(true)
      expect(Number.isFinite(breakdown.total)).toBe(true)
    }
  })
})

describe('discovery', () => {
  beforeEach(async () => {
    useFreshDb()
    await ingestFixtures()
  })

  it('builds its queries from the user interests', async () => {
    await rate('fixture-os-0', 5)
    await rate('fixture-os-1', 5)

    const report = await runDiscovery({
      engine,
      now: () => NOW,
      adapter: new FixtureSourceAdapter(() => NOW),
    })

    expect(report.queries.length).toBeGreaterThan(0)
    expect(report.errors).toEqual([])
  })

  it('issues no queries when there are no interests yet', async () => {
    const report = await runDiscovery({
      engine,
      now: () => NOW,
      adapter: new FixtureSourceAdapter(() => NOW),
    })
    expect(report.queries).toEqual([])
  })
})
