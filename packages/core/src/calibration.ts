import { cosine } from './vector.js'

/**
 * Similarity calibration.
 *
 * Sentence encoders do not spread cosine similarity over a usable range. Measured against
 * a real catalog, everything — a computer history lecture and an unrelated variety short
 * alike — sat between 0.77 and 0.86. Absolute thresholds therefore carry almost no
 * information; only the ordering does.
 *
 * So nothing here compares a raw cosine to a constant. Both users of this module ask a
 * relative question instead:
 *
 * - clustering: how similar are two rated items *compared to how similar rated items
 *   usually are*?
 * - ranking: how much closer is this candidate to an interest *than a typical candidate*?
 *
 * That keeps the model working when the embedding model is replaced, which a hand-tuned
 * threshold does not.
 */

/**
 * Z-score at which a candidate counts as a full match.
 *
 * Two standard deviations above the mean of the candidate pool. Anything at or below the
 * mean contributes nothing: being *typically* similar to an interest is not evidence of
 * interest, it is what every candidate looks like.
 */
export const CALIBRATION_Z_SPAN = 2

/** Ratings needed before the data can speak for itself. */
export const MIN_SAMPLES_FOR_ADAPTIVE_THRESHOLD = 12

/** Cap on the items sampled when estimating the threshold; the estimate is O(n²). */
export const MAX_THRESHOLD_SAMPLES = 200

export interface SimilarityStats {
  mean: number
  stddev: number
  count: number
}

export function similarityStats(values: readonly number[]): SimilarityStats {
  if (values.length === 0) return { mean: 0, stddev: 0, count: 0 }
  const mean = values.reduce((total, value) => total + value, 0) / values.length
  const variance =
    values.reduce((total, value) => total + (value - mean) * (value - mean), 0) / values.length
  return { mean, stddev: Math.sqrt(variance), count: values.length }
}

/**
 * Maps a raw similarity onto [0, 1] relative to the pool it was drawn from.
 *
 * A pool with no variation returns 0 for everything: if every candidate is equally close
 * to an interest, that closeness cannot distinguish between them and should not be
 * allowed to inflate every score equally.
 */
export function calibrate(
  similarity: number,
  stats: SimilarityStats,
  span = CALIBRATION_Z_SPAN,
): number {
  if (stats.count === 0 || stats.stddev === 0) return 0
  const z = (similarity - stats.mean) / stats.stddev
  return Math.min(1, Math.max(0, z / span))
}

/**
 * Two-sided version, giving the position of a similarity within [-span, +span] standard
 * deviations.
 *
 * Novelty needs this rather than `calibrate`: it has to tell "further from my interests
 * than usual" apart from "about as far as everything else", and a one-sided measure
 * collapses both to the same value.
 */
export function calibrateSigned(
  similarity: number,
  stats: SimilarityStats,
  span = CALIBRATION_Z_SPAN,
): number {
  if (stats.count === 0 || stats.stddev === 0) return 0.5
  const z = (similarity - stats.mean) / stats.stddev
  return Math.min(1, Math.max(0, (z + span) / (2 * span)))
}

export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
  return sorted[index]
}

export interface AdaptiveThresholdOptions {
  /** How many standard deviations above typical counts as "unusually similar". */
  zScore: number
  /** Used until there are enough ratings for the distribution to mean anything. */
  fallback: number
  minSamples?: number
  maxSamples?: number
}

/**
 * Derives the clustering threshold from the ratings themselves.
 *
 * The threshold is placed a fixed number of standard deviations above the *typical*
 * similarity between two rated items — the same relative measure the ranker uses, so the
 * whole system asks one question rather than two. Where that lands depends on the model
 * and the content, which is the point: a constant cosine cannot survive an encoder change.
 *
 * With a mix of topics the pairwise distribution is bimodal and this sits near the gap
 * between the two modes. With a single topic there is no gap, and the threshold splits off
 * the least similar items — which produces several neighbouring interests rather than one.
 * That is the safer failure: over-splitting leaves a usable model, while the collapse this
 * replaced destroyed all discrimination. The exact value wants validating against real
 * ratings (design addendum 1).
 */
export function adaptiveThreshold(
  vectors: readonly Float32Array[],
  options: AdaptiveThresholdOptions,
): number {
  const minSamples = options.minSamples ?? MIN_SAMPLES_FOR_ADAPTIVE_THRESHOLD
  if (vectors.length < minSamples) return options.fallback

  const sampled = sampleEvenly(vectors, options.maxSamples ?? MAX_THRESHOLD_SAMPLES)
  const pairs: number[] = []
  for (let i = 0; i < sampled.length; i++) {
    for (let j = i + 1; j < sampled.length; j++) {
      pairs.push(cosine(sampled[i], sampled[j]))
    }
  }
  if (pairs.length === 0) return options.fallback

  const stats = similarityStats(pairs)
  if (stats.stddev === 0) return options.fallback
  return stats.mean + options.zScore * stats.stddev
}

/**
 * Evenly spaced sample, so the estimate covers the whole history rather than only its
 * beginning, and stays deterministic across rebuilds.
 */
function sampleEvenly<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit) return [...values]
  const stride = values.length / limit
  const sampled: T[] = []
  for (let index = 0; sampled.length < limit; index += stride) {
    sampled.push(values[Math.floor(index)])
  }
  return sampled
}
