import { describe, expect, it } from 'vitest'
import { H_NEG_DAYS, H_SHORT_DAYS } from '../src/constants.js'
import { addDays, daysBetween, decayAt, decayFactor, toMillis } from '../src/decay.js'

const T0 = '2026-01-01T00:00:00.000Z'

describe('time helpers', () => {
  it('rejects timestamps it cannot parse', () => {
    expect(() => toMillis('not a date')).toThrow(/ISO 8601/)
  })

  it('measures signed distances in days', () => {
    expect(daysBetween(T0, addDays(T0, 14))).toBeCloseTo(14, 9)
    expect(daysBetween(addDays(T0, 14), T0)).toBeCloseTo(-14, 9)
  })
})

describe('exponential decay', () => {
  it('halves at exactly one half-life', () => {
    expect(decayFactor(0, 14)).toBeCloseTo(1, 9)
    expect(decayFactor(14, 14)).toBeCloseTo(0.5, 9)
    expect(decayFactor(28, 14)).toBeCloseTo(0.25, 9)
  })

  it('clamps future timestamps so clock skew cannot amplify a signal', () => {
    expect(decayAt(addDays(T0, 5), T0, H_SHORT_DAYS)).toBe(1)
  })

  it('keeps negative interest alive far longer than short-term interest', () => {
    const after60Days = addDays(T0, 60)
    const shortTerm = decayAt(T0, after60Days, H_SHORT_DAYS)
    const negative = decayAt(T0, after60Days, H_NEG_DAYS)
    expect(negative).toBeCloseTo(0.5, 6)
    expect(shortTerm).toBeLessThan(0.06)
    expect(negative).toBeGreaterThan(shortTerm * 8)
  })

  it('answers the problem the design calls out: a three-month-old burst nearly vanishes', () => {
    expect(decayAt(T0, addDays(T0, 90), H_SHORT_DAYS)).toBeLessThan(0.02)
  })

  it('requires a positive half-life', () => {
    expect(() => decayFactor(1, 0)).toThrow(/half-life/)
  })
})
