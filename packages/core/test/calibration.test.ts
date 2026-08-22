import { describe, expect, it } from 'vitest'
import {
  CALIBRATION_Z_SPAN,
  MIN_SAMPLES_FOR_ADAPTIVE_THRESHOLD,
  adaptiveThreshold,
  calibrate,
  calibrateSigned,
  quantile,
  similarityStats,
} from '../src/calibration.js'
import { TAU, TAU_Z_SCORE } from '../src/constants.js'
import { cosine, l2Normalize } from '../src/vector.js'

/**
 * Builds vectors whose cosine similarities reproduce what a sentence encoder actually
 * produced against the real catalog: a large component every item shares, a smaller
 * per-topic component, and a small per-item one. Same-topic pairs land near 0.86 and
 * different-topic pairs near 0.77 — both high, and only 0.09 apart.
 */
const DIMENSIONS = 24
function encoderLike(topic: number, index: number): Float32Array {
  const vector = new Float32Array(DIMENSIONS)
  vector[0] = 0.8775 // shared by everything
  vector[1 + topic] = 0.3 // shared within a topic
  vector[8 + index] = 0.3742 // unique to this item
  return l2Normalize(vector)
}

describe('similarity statistics', () => {
  it('summarises a set of similarities', () => {
    const stats = similarityStats([0.5, 0.5, 0.5])
    expect(stats).toMatchObject({ mean: 0.5, stddev: 0, count: 3 })
  })

  it('answers zero for an empty set rather than failing', () => {
    expect(similarityStats([])).toMatchObject({ mean: 0, stddev: 0, count: 0 })
  })
})

describe('one-sided calibration', () => {
  const stats = similarityStats([0.7, 0.8, 0.9]) // mean 0.8, stddev ~0.0816

  it('gives nothing to a typical candidate', () => {
    // Being as close as everything else is not evidence of interest.
    expect(calibrate(0.8, stats)).toBeCloseTo(0, 12)
    expect(calibrate(0.7, stats)).toBe(0)
  })

  it('reaches 1 at the top of the span and clamps beyond it', () => {
    const twoSigma = stats.mean + CALIBRATION_Z_SPAN * stats.stddev
    expect(calibrate(twoSigma, stats)).toBeCloseTo(1, 6)
    expect(calibrate(twoSigma + 1, stats)).toBe(1)
  })

  it('returns nothing when every candidate is equally close', () => {
    // A closeness shared by all of them cannot separate any of them.
    expect(calibrate(0.9, similarityStats([0.9, 0.9, 0.9]))).toBe(0)
    expect(calibrate(0.9, similarityStats([]))).toBe(0)
  })
})

describe('two-sided calibration', () => {
  const stats = similarityStats([0.7, 0.8, 0.9])

  it('places a typical candidate in the middle', () => {
    expect(calibrateSigned(0.8, stats)).toBeCloseTo(0.5, 6)
  })

  it('separates unusually far from merely average, which the one-sided form cannot', () => {
    const far = stats.mean - CALIBRATION_Z_SPAN * stats.stddev
    expect(calibrateSigned(far, stats)).toBeCloseTo(0, 6)
    expect(calibrateSigned(stats.mean, stats)).toBeCloseTo(0.5, 6)
    // Both are zero under the one-sided measure, which is why novelty needs this one.
    expect(calibrate(far, stats)).toBe(calibrate(stats.mean, stats))
  })
})

describe('quantile', () => {
  it('reads the requested position of a sorted set', () => {
    expect(quantile([3, 1, 2], 0)).toBe(1)
    expect(quantile([3, 1, 2], 1)).toBe(3)
    expect(quantile([], 0.5)).toBe(0)
  })
})

describe('adaptive clustering threshold', () => {
  const twoTopics = [
    ...Array.from({ length: 6 }, (_, index) => encoderLike(0, index)),
    ...Array.from({ length: 6 }, (_, index) => encoderLike(1, index + 6)),
  ]

  it('reproduces the narrow band the real encoder produced', () => {
    const same = cosine(twoTopics[0], twoTopics[1])
    const different = cosine(twoTopics[0], twoTopics[6])
    expect(same).toBeGreaterThan(0.84)
    expect(same).toBeLessThan(0.88)
    expect(different).toBeGreaterThan(0.75)
    expect(different).toBeLessThan(0.79)
  })

  it('lands between the two topics, where a fixed 0.55 cannot', () => {
    const threshold = adaptiveThreshold(twoTopics, { zScore: TAU_Z_SCORE, fallback: TAU })
    const same = cosine(twoTopics[0], twoTopics[1])
    const different = cosine(twoTopics[0], twoTopics[6])

    expect(threshold).toBeGreaterThan(different)
    expect(threshold).toBeLessThanOrEqual(same)
    // The configured constant would have merged everything: both pairs clear it.
    expect(different).toBeGreaterThan(TAU)
  })

  it('keeps the configured value until there are enough ratings to say anything', () => {
    const tooFew = twoTopics.slice(0, MIN_SAMPLES_FOR_ADAPTIVE_THRESHOLD - 1)
    expect(adaptiveThreshold(tooFew, { zScore: TAU_Z_SCORE, fallback: TAU })).toBe(TAU)
    expect(adaptiveThreshold([], { zScore: TAU_Z_SCORE, fallback: TAU })).toBe(TAU)
  })

  it('falls back when every pair is identical, since there is no spread to measure', () => {
    const identical = Array.from({ length: 20 }, () => encoderLike(0, 0))
    expect(adaptiveThreshold(identical, { zScore: TAU_Z_SCORE, fallback: TAU })).toBe(TAU)
  })

  it('is deterministic and bounded in cost for a large history', () => {
    const many = Array.from({ length: 900 }, (_, index) => encoderLike(index % 3, index % 16))
    const first = adaptiveThreshold(many, { zScore: TAU_Z_SCORE, fallback: TAU })
    const second = adaptiveThreshold(many, { zScore: TAU_Z_SCORE, fallback: TAU })
    expect(first).toBe(second)
    expect(Number.isFinite(first)).toBe(true)
  })
})
