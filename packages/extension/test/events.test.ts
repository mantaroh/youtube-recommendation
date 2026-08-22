import { beforeEach, describe, expect, it } from 'vitest'
import { appendEvent, currentRating, listEvents, rateItem, ratingsByKey, recordImpressions, recordWatch } from '../src/lib/events.js'
import { type PreferenceDatabase } from '../src/lib/db.js'
import { useFreshDb } from './helpers.js'

const REF = { source: 'youtube', externalId: 'abc123' } as const

describe('event log', () => {
  let db: PreferenceDatabase

  beforeEach(() => {
    db = useFreshDb()
  })

  it('assigns increasing sequence numbers', async () => {
    const first = await rateItem(REF, 5, '2026-01-01T00:00:00.000Z')
    const second = await rateItem(REF, 3, '2026-02-01T00:00:00.000Z')
    expect(second.seq).toBeGreaterThan(first.seq)
  })

  it('keeps every rating rather than overwriting, while the projection holds the latest', async () => {
    await rateItem(REF, 5, '2026-01-01T00:00:00.000Z')
    await rateItem(REF, 0, '2026-06-01T00:00:00.000Z')

    const events = await listEvents()
    expect(events.filter((event) => event.type === 'rating')).toHaveLength(2)
    expect(await currentRating(REF)).toBe(0)
  })

  it('treats unrated and 0 as different states', async () => {
    expect(await currentRating(REF)).toBeUndefined()
    await rateItem(REF, 0, '2026-01-01T00:00:00.000Z')
    expect(await currentRating(REF)).toBe(0)

    const map = await ratingsByKey()
    expect(map.get('youtube:abc123')).toBe(0)
    expect(map.has('youtube:never-rated')).toBe(false)
  })

  it('rejects an event that does not satisfy the schema', async () => {
    await expect(
      appendEvent({
        type: 'rating',
        ts: '2026-01-01T00:00:00.000Z',
        source: 'youtube',
        externalId: 'x',
        // 7 is not on the rating scale.
        rating: 7 as never,
      }),
    ).rejects.toThrow()
    expect(await db.events.count()).toBe(0)
  })

  it('rejects a malformed timestamp', async () => {
    await expect(rateItem(REF, 5, 'yesterday')).rejects.toThrow()
    expect(await db.events.count()).toBe(0)
  })

  it('records watch and impression events without touching the rating projection', async () => {
    await recordWatch(REF, 120, 600, '2026-03-01T00:00:00.000Z')
    await recordImpressions([{ ref: REF, lane: 'explore', position: 0 }], '2026-03-01T00:00:00.000Z')

    const events = await listEvents()
    expect(events.map((event) => event.type)).toEqual(['watch', 'impression'])
    expect(await db.ratings.count()).toBe(0)
  })

  it('can replay only the events up to a past instant', async () => {
    await rateItem(REF, 5, '2026-01-15T00:00:00.000Z')
    await rateItem({ source: 'youtube', externalId: 'later' }, 4, '2026-07-15T00:00:00.000Z')

    const asOfApril = await listEvents({ upToTs: '2026-04-01T00:00:00.000Z' })
    expect(asOfApril).toHaveLength(1)
    expect(asOfApril[0]).toMatchObject({ externalId: 'abc123' })

    const all = await listEvents()
    expect(all).toHaveLength(2)
  })

  it('can replay up to a sequence number', async () => {
    const first = await rateItem(REF, 5, '2026-01-15T00:00:00.000Z')
    await rateItem({ source: 'youtube', externalId: 'second' }, 2, '2026-01-16T00:00:00.000Z')
    expect(await listEvents({ upToSeq: first.seq })).toHaveLength(1)
  })
})
