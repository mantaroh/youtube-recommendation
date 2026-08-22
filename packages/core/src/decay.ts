import { MILLISECONDS_PER_DAY } from './constants.js'

/**
 * Time helpers.
 *
 * Nothing in this package reads the clock: every function that depends on "now" takes it
 * as an argument. That is what makes rebuilding state at an arbitrary past instant
 * (design section 3.6) and testing decay with synthetic timestamps possible.
 */

export function toMillis(timestamp: string): number {
  const millis = Date.parse(timestamp)
  if (Number.isNaN(millis)) throw new Error(`not an ISO 8601 timestamp: ${timestamp}`)
  return millis
}

/** Days from `from` to `to`. Negative when `to` precedes `from`. */
export function daysBetween(from: string, to: string): number {
  return (toMillis(to) - toMillis(from)) / MILLISECONDS_PER_DAY
}

/**
 * Exponential decay with a half-life: `2^(-elapsed / halfLife)`.
 *
 * Elapsed time is clamped at zero so that an event timestamped slightly in the future
 * (clock skew between devices) cannot amplify itself.
 */
export function decayFactor(elapsedDays: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) throw new Error('half-life must be positive')
  const elapsed = Math.max(0, elapsedDays)
  return Math.exp((-Math.LN2 * elapsed) / halfLifeDays)
}

/** Decay of an event that happened at `eventTs`, evaluated at `now`. */
export function decayAt(eventTs: string, now: string, halfLifeDays: number): number {
  return decayFactor(daysBetween(eventTs, now), halfLifeDays)
}

export function addDays(timestamp: string, days: number): string {
  return new Date(toMillis(timestamp) + days * MILLISECONDS_PER_DAY).toISOString()
}
