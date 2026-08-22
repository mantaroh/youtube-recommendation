import { beforeEach, describe, expect, it } from 'vitest'
import { HashingInferenceEngine } from '@ypr/core'
import { embedMissing, storeItems } from '../src/lib/ingest.js'
import { rateItem } from '../src/lib/events.js'
import {
  forgetInterest,
  loadPreferenceContext,
  muteInterest,
  renameInterest,
  setAsOf,
} from '../src/lib/preference.js'
import { buildFixtureCatalog } from '../src/lib/sources/youtube/fixtures.js'
import { getDb } from '../src/lib/db.js'
import { useFreshDb } from './helpers.js'

const NOW = '2026-08-22T00:00:00.000Z'
const engine = new HashingInferenceEngine(384)

async function seed(): Promise<void> {
  await storeItems(buildFixtureCatalog({ now: NOW }))
  await embedMissing(engine)
}

const rate = (id: string, rating: 0 | 1 | 2 | 3 | 4 | 5, ts = NOW) =>
  rateItem({ source: 'youtube', externalId: id }, rating, ts)

describe('preference state built from the local store', () => {
  beforeEach(async () => {
    useFreshDb()
    await seed()
  })

  it('turns ratings into interests named after their topic', async () => {
    await rate('fixture-browser-0', 5)
    await rate('fixture-browser-1', 5)
    await rate('fixture-browser-2', 4)

    const { state } = await loadPreferenceContext({ now: NOW })

    expect(state.clusters).toHaveLength(1)
    const cluster = state.clusters[0]
    expect(cluster.memberIds).toHaveLength(3)
    expect(cluster.activity).toBeGreaterThan(0)
    expect(cluster.label.toLowerCase()).toMatch(/browser|compositor|render|layout|engine|paint|style/)
  })

  it('keeps unrelated topics apart', async () => {
    await rate('fixture-browser-0', 5)
    await rate('fixture-cooking-0', 5)
    await rate('fixture-chinese-0', 4)

    const { state } = await loadPreferenceContext({ now: NOW })
    expect(state.clusters.length).toBeGreaterThanOrEqual(3)
  })

  it('records a dislike as suppression rather than as an interest', async () => {
    await rate('fixture-investment-0', 0)
    await rate('fixture-investment-1', 0)

    const { state } = await loadPreferenceContext({ now: NOW })
    const cluster = state.clusters[0]
    expect(cluster.massLong).toBeLessThan(0)
    expect(cluster.normalisedNegative).toBeGreaterThan(0)
    expect(cluster.activity).toBe(0)
  })

  it('caches the rebuilt clusters so the screen can paint immediately', async () => {
    await rate('fixture-os-0', 5)
    await loadPreferenceContext({ now: NOW })
    expect(await getDb().clusters.count()).toBeGreaterThan(0)
  })

  it('applies mute, forget and rename through the event log', async () => {
    await rate('fixture-os-0', 5)
    await rate('fixture-os-1', 5)
    const first = await loadPreferenceContext({ now: NOW })
    const clusterId = first.state.clusters[0].id

    await renameInterest(clusterId, 'OS Internals')
    await muteInterest(clusterId, 30)

    const muted = await loadPreferenceContext({ now: NOW })
    expect(muted.state.clusters[0].label).toBe('OS Internals')
    expect(muted.state.clusters[0].activity).toBe(0)

    await muteInterest(clusterId, null)
    await forgetInterest(clusterId, true)
    const forgotten = await loadPreferenceContext({ now: NOW })
    expect(forgotten.state.clusters[0].forgotten).toBe(true)
  })

  it('replays the past without writing it back as the present', async () => {
    await rate('fixture-browser-0', 5, '2026-03-01T00:00:00.000Z')
    await rate('fixture-cooking-0', 5, '2026-07-01T00:00:00.000Z')

    const present = await loadPreferenceContext({ now: NOW })
    const clusterCountNow = present.state.clusters.length

    await setAsOf('2026-04-01T00:00:00.000Z')
    const past = await loadPreferenceContext({ now: NOW })
    expect(past.asOf).toBe('2026-04-01T00:00:00.000Z')
    expect(past.state.clusters).toHaveLength(1)

    await setAsOf(null)
    const back = await loadPreferenceContext({ now: NOW })
    expect(back.state.clusters).toHaveLength(clusterCountNow)
  })
})
