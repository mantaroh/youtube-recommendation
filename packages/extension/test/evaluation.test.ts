import { beforeEach, describe, expect, it } from 'vitest'
import { HashingInferenceEngine } from '@ypr/core'
import {
  buildEvaluationReport,
  jstDay,
  keysForVideoIds,
  listTrials,
  recordTrial,
  shuffleStable,
} from '../src/lib/evaluation.js'
import { embedMissing, storeItems } from '../src/lib/ingest.js'
import { rateItem } from '../src/lib/events.js'
import { buildFixtureCatalog } from '../src/lib/sources/youtube/fixtures.js'
import { updateAppSettings } from '../src/lib/settings.js'
import { useFreshDb } from './helpers.js'

const NOW = '2026-08-22T00:00:00.000Z'
const engine = new HashingInferenceEngine(384)

const rate = (id: string, rating: 0 | 1 | 2 | 3 | 4 | 5) =>
  rateItem({ source: 'youtube', externalId: id }, rating, NOW)

describe('trial recording', () => {
  beforeEach(async () => {
    useFreshDb()
    await storeItems(buildFixtureCatalog({ now: NOW }))
    await embedMissing(engine)
  })

  it('uses the JST day, matching the rest of the project', () => {
    // 23:00 UTC on the 21st is already the 22nd in Tokyo.
    expect(jstDay(new Date('2026-08-21T23:00:00.000Z'))).toBe('2026-08-22')
    expect(jstDay(new Date('2026-08-21T14:00:00.000Z'))).toBe('2026-08-21')
  })

  it('records one list per arm per day and refuses a retry', async () => {
    const day = new Date('2026-08-22T01:00:00.000Z')
    const first = await recordTrial('own', keysForVideoIds(['a', 'b']), day)
    const second = await recordTrial('own', keysForVideoIds(['c', 'd']), day)

    expect(first?.id).toBe('2026-08-22:own')
    // The second attempt returns the original rather than replacing it: a day that went
    // badly must not be quietly re-run.
    expect(second?.itemKeys).toEqual(first?.itemKeys)
    expect(await listTrials()).toHaveLength(1)
  })

  it('keeps the two arms separate on the same day', async () => {
    const day = new Date('2026-08-22T01:00:00.000Z')
    await recordTrial('own', keysForVideoIds(['a']), day)
    await recordTrial('youtube', keysForVideoIds(['b']), day)
    expect(await listTrials()).toHaveLength(2)
  })

  it('records nothing for an empty list', async () => {
    expect(await recordTrial('own', [])).toBeUndefined()
    expect(await listTrials()).toHaveLength(0)
  })
})

describe('evaluation report', () => {
  beforeEach(async () => {
    useFreshDb()
    await storeItems(buildFixtureCatalog({ now: NOW }))
    await embedMissing(engine)
    await updateAppSettings({ subscribedChannelIds: ['UC_fixture_browser'] })
  })

  it('reports both arms side by side', async () => {
    const day = new Date('2026-08-22T01:00:00.000Z')
    // Two different official categories against one, so entropy can separate them.
    await recordTrial('own', keysForVideoIds(['fixture-browser-0', 'fixture-chinese-0']), day)
    await recordTrial('youtube', keysForVideoIds(['fixture-cooking-0', 'fixture-cooking-1']), day)

    await rate('fixture-browser-0', 5)
    await rate('fixture-chinese-0', 4)
    await rate('fixture-cooking-0', 1)
    await rate('fixture-cooking-1', 0)

    const report = await buildEvaluationReport()
    const own = report.metrics.find((metrics) => metrics.arm === 'own')!
    const youtube = report.metrics.find((metrics) => metrics.arm === 'youtube')!

    expect(own.meanRating).toBeCloseTo(4.5, 6)
    expect(youtube.meanRating).toBeCloseTo(0.5, 6)
    expect(youtube.rejectionRate).toBeCloseTo(0.5, 6)
    // Two categories against one.
    expect(own.categoryEntropy).toBeGreaterThan(youtube.categoryEntropy)
    expect(report.comparison.find((row) => row.metric === 'Mean rating')?.delta).toBeCloseTo(4, 6)
  })

  it('measures novelty against the channels the user follows', async () => {
    await recordTrial('own', keysForVideoIds(['fixture-browser-0', 'fixture-cooking-0']))
    const report = await buildEvaluationReport()
    const own = report.metrics.find((metrics) => metrics.arm === 'own')!
    expect(own.newChannelShare).toBeCloseTo(0.5, 6)
  })

  it('lists items whose metadata is not held locally instead of dropping them', async () => {
    await recordTrial('youtube', keysForVideoIds(['unknown-video-id']))
    const report = await buildEvaluationReport()
    expect(report.missingKeys).toEqual(['youtube:unknown-video-id'])
    expect(report.metrics.find((metrics) => metrics.arm === 'youtube')!.shown).toBe(1)
  })

  it('queues unrated trial items in an order that hides which arm they came from', async () => {
    await recordTrial('own', keysForVideoIds(['fixture-browser-0', 'fixture-browser-1']))
    await recordTrial('youtube', keysForVideoIds(['fixture-cooking-0', 'fixture-cooking-1']))

    const report = await buildEvaluationReport()
    const ids = report.pending.map((item) => item.externalId)

    expect(ids).toHaveLength(4)
    // Insertion order would put both "own" items first and give the source away.
    expect(ids.slice(0, 2).every((id) => id.startsWith('fixture-browser'))).toBe(false)
  })

  it('drops an item from the queue once it has been rated', async () => {
    await recordTrial('own', keysForVideoIds(['fixture-browser-0']))
    expect((await buildEvaluationReport()).pending).toHaveLength(1)
    await rate('fixture-browser-0', 4)
    expect((await buildEvaluationReport()).pending).toHaveLength(0)
  })

  it('exports a CSV row per arm', async () => {
    await recordTrial('own', keysForVideoIds(['fixture-browser-0']))
    const report = await buildEvaluationReport()
    expect(report.csv.split('\n')).toHaveLength(3)
  })
})

describe('blind ordering', () => {
  it('is stable across calls, so the list does not jump while being worked through', () => {
    const keys = ['youtube:a', 'youtube:b', 'youtube:c', 'youtube:d']
    expect(shuffleStable(keys)).toEqual(shuffleStable(keys))
  })

  it('does not simply preserve the order it was given', () => {
    const keys = Array.from({ length: 20 }, (_, index) => `youtube:id-${index}`)
    expect(shuffleStable(keys)).not.toEqual(keys)
  })
})
