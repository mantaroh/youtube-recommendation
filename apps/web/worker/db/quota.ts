import type { EpochMillis } from '@ypr/domain'

/**
 * The YouTube quota ledger (design section 42).
 *
 * `search.list` has an allowance of a hundred calls a day, separate from the main
 * quota, and there is no way to ask what is left. Spending it all means discovery
 * silently stops working and a manual search fails too, so calls are counted here
 * *before* they are made and refused once the budget for the day is gone.
 */

export type QuotaOperation = 'search' | 'list' | 'subscriptions'

/**
 * The JST calendar day.
 *
 * The real allowance resets at Pacific midnight, which this deliberately does not
 * track. The budget spent per day is a third of the allowance, so the offset between
 * the two calendars cannot cause an overspend, and a ledger keyed to the day the user
 * is living in is the one that matches what they see on the screen (rule: JST).
 */
export function jstDay(now: EpochMillis): string {
  const shifted = new Date(now + 9 * 3_600_000)
  return shifted.toISOString().slice(0, 10)
}

export async function usedToday(
  db: D1Database,
  operation: QuotaOperation,
  now: EpochMillis,
  source = 'youtube',
): Promise<number> {
  const row = await db
    .prepare('SELECT used FROM api_quota_usage WHERE day = ?1 AND source = ?2 AND operation = ?3')
    .bind(jstDay(now), source, operation)
    .first<{ used: number }>()
  return row?.used ?? 0
}

export async function recordUsage(
  db: D1Database,
  operation: QuotaOperation,
  count: number,
  now: EpochMillis,
  source = 'youtube',
): Promise<void> {
  if (count <= 0) return
  await db
    .prepare(
      `INSERT INTO api_quota_usage (day, source, operation, used)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(day, source, operation) DO UPDATE SET used = api_quota_usage.used + excluded.used`,
    )
    .bind(jstDay(now), source, operation, count)
    .run()
}

/**
 * A budget that can be drawn against and reports what it spent.
 *
 * The ledger is written once at the end rather than per call, because a discovery run
 * makes its calls in a tight loop and a round trip to D1 between each would cost more
 * than the accounting is worth. The trade-off is that a Worker that dies mid-run
 * under-reports; that direction is the safe one only because the budget is a third of
 * the real allowance.
 */
export class SearchBudget {
  private spent = 0

  private constructor(
    private readonly db: D1Database,
    private remaining: number,
    private readonly now: EpochMillis,
  ) {}

  static async open(db: D1Database, budget: number, now: EpochMillis): Promise<SearchBudget> {
    const used = await usedToday(db, 'search', now)
    return new SearchBudget(db, Math.max(0, budget - used), now)
  }

  get left(): number {
    return this.remaining
  }

  /** True when there was budget left and it has now been claimed. */
  take(count = 1): boolean {
    if (this.remaining < count) return false
    this.remaining -= count
    this.spent += count
    return true
  }

  async close(): Promise<number> {
    await recordUsage(this.db, 'search', this.spent, this.now)
    return this.spent
  }
}
