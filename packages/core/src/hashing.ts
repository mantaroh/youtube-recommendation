import type { InferenceEngine } from '@ypr/shared'
import { l2NormalizeInPlace, zeros } from './vector.js'

/**
 * Deterministic bag-of-words embedding used by tests and as a no-download fallback.
 *
 * Tokens are hashed into dimensions and accumulated, so texts that share vocabulary end
 * up close together. That is far weaker than a real sentence encoder, but it is real
 * lexical similarity rather than noise, which is what makes it usable for exercising the
 * clustering and ranking logic without pulling a model.
 *
 * It is not a substitute for `TransformersInferenceEngine`: it has no notion of meaning,
 * so "OS internals" and "kernel programming" are unrelated to it.
 */
export class HashingInferenceEngine implements InferenceEngine {
  readonly modelId: string
  readonly dimensions: number

  constructor(dimensions = 384, modelId = 'local/hashing-bow-v1') {
    this.dimensions = dimensions
    this.modelId = modelId
  }

  async embedQuery(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedOne(text))
  }

  async embedPassage(texts: string[]): Promise<Float32Array[]> {
    return texts.map((text) => this.embedOne(text))
  }

  embedOne(text: string): Float32Array {
    const vector = zeros(this.dimensions)
    const tokens = tokenize(text)
    if (tokens.length === 0) return vector
    const seen = new Map<string, number>()
    for (const token of tokens) {
      seen.set(token, (seen.get(token) ?? 0) + 1)
    }
    for (const [token, count] of seen) {
      // Sub-linear term frequency, so one repeated word cannot dominate a document.
      const weight = 1 + Math.log(count)
      const primary = hash(token) % this.dimensions
      // A second, independently seeded slot reduces the effect of collisions.
      const secondary = hash(`${token}#2`) % this.dimensions
      vector[primary] += weight
      vector[secondary] += weight * 0.5
    }
    return l2NormalizeInPlace(vector)
  }
}

function tokenize(text: string): string[] {
  const lowered = text.toLowerCase()
  const words = lowered.match(/[a-z0-9]+|[぀-ヿ一-鿿]+/g)
  if (!words) return []
  const tokens: string[] = []
  for (const word of words) {
    if (/^[a-z0-9]+$/.test(word)) {
      tokens.push(word)
    } else {
      // CJK has no spaces: character bigrams approximate word boundaries.
      if (word.length === 1) tokens.push(word)
      for (let i = 0; i + 1 < word.length; i++) tokens.push(word.slice(i, i + 2))
    }
  }
  return tokens
}

/** FNV-1a, 32-bit. Stable across runs and platforms, which keeps rebuilds reproducible. */
function hash(text: string): number {
  let value = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    value ^= text.charCodeAt(i)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value >>> 0
}
