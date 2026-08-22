import { beforeEach, describe, expect, it } from 'vitest'
import {
  SEARCH_CALL_BUDGET,
  UNIT_BUDGET,
  pacificDayKey,
  readLedger,
  remaining,
  reserve,
} from '../src/lib/sources/youtube/quota.js'
import { useFreshDb } from './helpers.js'

describe('quota ledger', () => {
  beforeEach(() => {
    useFreshDb()
  })

  it('tracks the two budgets independently', async () => {
    expect(await reserve('search', 10)).toBe(true)
    expect(await reserve('units', 100)).toBe(true)
    const ledger = await readLedger()
    expect(ledger.search).toBe(10)
    expect(ledger.units).toBe(100)
    expect(await remaining('search')).toBe(SEARCH_CALL_BUDGET - 10)
    expect(await remaining('units')).toBe(UNIT_BUDGET - 100)
  })

  it('refuses a reservation that would cross the budget, and leaves the ledger untouched', async () => {
    expect(await reserve('search', SEARCH_CALL_BUDGET)).toBe(true)
    expect(await reserve('search', 1)).toBe(false)
    expect((await readLedger()).search).toBe(SEARCH_CALL_BUDGET)
    // The other bucket is unaffected by search running dry.
    expect(await reserve('units', 5)).toBe(true)
  })

  it('starts over when the Pacific day rolls', async () => {
    const beforeMidnight = new Date('2026-08-22T06:00:00.000Z') // 23:00 on the 21st, Pacific
    const afterMidnight = new Date('2026-08-22T08:00:00.000Z') // 01:00 on the 22nd, Pacific

    expect(pacificDayKey(beforeMidnight)).toBe('2026-08-21')
    expect(pacificDayKey(afterMidnight)).toBe('2026-08-22')

    await reserve('search', 50, beforeMidnight)
    expect((await readLedger(beforeMidnight)).search).toBe(50)
    expect((await readLedger(afterMidnight)).search).toBe(0)
  })
})
