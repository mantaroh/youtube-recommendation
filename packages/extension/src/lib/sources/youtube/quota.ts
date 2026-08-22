import { getSetting, setSetting } from '../../settings.js'

/**
 * Daily quota ledger (design section 6.1).
 *
 * Two independent budgets are tracked because they are enforced independently by the
 * API: general unit cost, and a self-imposed cap on `search.list` calls. The cap keeps
 * the crawl inside the plan of 10 clusters x 3 queries x 2 runs per day even if the
 * ranker asks for more.
 *
 * The day boundary follows US Pacific time, because that is when the API quota actually
 * resets — not the JST day used everywhere else in this project.
 */

const LEDGER_KEY = 'youtube.quota'

/** Self-imposed cap, not an API limit. */
export const SEARCH_CALL_BUDGET = 60
/** Default project allowance for everything other than search. */
export const UNIT_BUDGET = 10_000

export type QuotaBucket = 'units' | 'search'

export interface QuotaLedger {
  day: string
  units: number
  search: number
}

export function pacificDayKey(now: Date = new Date()): string {
  // en-CA renders as YYYY-MM-DD, which sorts and compares cleanly.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(now)
}

export async function readLedger(now: Date = new Date()): Promise<QuotaLedger> {
  const day = pacificDayKey(now)
  const stored = await getSetting<QuotaLedger | null>(LEDGER_KEY, null)
  if (!stored || stored.day !== day) return { day, units: 0, search: 0 }
  return stored
}

export function budgetFor(bucket: QuotaBucket): number {
  return bucket === 'search' ? SEARCH_CALL_BUDGET : UNIT_BUDGET
}

export async function remaining(bucket: QuotaBucket, now: Date = new Date()): Promise<number> {
  const ledger = await readLedger(now)
  return Math.max(0, budgetFor(bucket) - ledger[bucket])
}

/**
 * Reserves budget before a call. Returns false when the budget is exhausted, so callers
 * degrade (fewer queries) instead of failing the whole ingestion run.
 */
export async function reserve(bucket: QuotaBucket, amount: number, now: Date = new Date()): Promise<boolean> {
  const ledger = await readLedger(now)
  if (ledger[bucket] + amount > budgetFor(bucket)) return false
  const next: QuotaLedger = { ...ledger, [bucket]: ledger[bucket] + amount }
  await setSetting(LEDGER_KEY, next)
  return true
}

export async function resetLedger(now: Date = new Date()): Promise<void> {
  await setSetting<QuotaLedger>(LEDGER_KEY, { day: pacificDayKey(now), units: 0, search: 0 })
}
