/**
 * Vector primitives and the brute-force index the local ranker runs on.
 *
 * At the scale this system targets (thousands to tens of thousands of videos) an exact
 * scan over a contiguous Float32Array is fast enough, which is what lets V1 avoid an ANN
 * service entirely (design sections 1.1 and 4.4).
 */

export function zeros(dimensions: number): Float32Array {
  return new Float32Array(dimensions)
}

export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`dimension mismatch: ${a.length} vs ${b.length}`)
  }
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

export function norm(v: Float32Array): number {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  return Math.sqrt(sum)
}

/** Returns a new L2-normalised copy. A zero vector is returned unchanged. */
export function l2Normalize(v: Float32Array): Float32Array {
  const length = norm(v)
  if (length === 0) return new Float32Array(v)
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / length
  return out
}

export function l2NormalizeInPlace(v: Float32Array): Float32Array {
  const length = norm(v)
  if (length === 0) return v
  for (let i = 0; i < v.length; i++) v[i] = v[i] / length
  return v
}

/** Cosine similarity for vectors that may or may not be normalised. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const denominator = norm(a) * norm(b)
  if (denominator === 0) return 0
  return dot(a, b) / denominator
}

/** `target += source * scale`, in place. */
export function addScaled(target: Float32Array, source: Float32Array, scale: number): void {
  if (target.length !== source.length) {
    throw new Error(`dimension mismatch: ${target.length} vs ${source.length}`)
  }
  for (let i = 0; i < target.length; i++) target[i] += source[i] * scale
}

/**
 * Weighted centroid, L2-normalised. Weights are expected to be non-negative: the
 * centroid describes *which topic* a cluster is about, so a disliked video still pulls
 * the centroid toward its own topic (see `clustering.ts`).
 */
export function weightedCentroid(
  vectors: readonly Float32Array[],
  weights: readonly number[],
): Float32Array {
  if (vectors.length === 0) throw new Error('cannot take the centroid of an empty set')
  const dimensions = vectors[0].length
  const accumulator = zeros(dimensions)
  for (let i = 0; i < vectors.length; i++) {
    addScaled(accumulator, vectors[i], weights[i] ?? 1)
  }
  return l2NormalizeInPlace(accumulator)
}

export interface VectorSearchHit {
  key: string
  similarity: number
}

export interface VectorSearchOptions {
  topK: number
  minSimilarity?: number
  /** Return false to exclude a key from the result. */
  filter?: (key: string) => boolean
}

/**
 * Exact nearest-neighbour index over L2-normalised vectors.
 *
 * Vectors are stored row-major in one contiguous buffer so that a query is a single
 * linear pass with good cache behaviour. Deletion swaps the last row into the freed
 * slot, so row order is not stable and must never be relied upon.
 */
export class VectorIndex {
  readonly dimensions: number
  private data: Float32Array
  private keys: string[] = []
  private rowByKey = new Map<string, number>()

  constructor(dimensions: number, initialCapacity = 1024) {
    if (dimensions <= 0) throw new Error('dimensions must be positive')
    this.dimensions = dimensions
    this.data = new Float32Array(Math.max(1, initialCapacity) * dimensions)
  }

  get size(): number {
    return this.keys.length
  }

  has(key: string): boolean {
    return this.rowByKey.has(key)
  }

  /** Inserts or replaces a vector. The stored copy is always normalised. */
  upsert(key: string, vector: Float32Array): void {
    if (vector.length !== this.dimensions) {
      throw new Error(`dimension mismatch: expected ${this.dimensions}, got ${vector.length}`)
    }
    const normalized = l2Normalize(vector)
    const existing = this.rowByKey.get(key)
    const row = existing ?? this.keys.length
    if (existing === undefined) {
      this.ensureCapacity(row + 1)
      this.keys.push(key)
      this.rowByKey.set(key, row)
    }
    this.data.set(normalized, row * this.dimensions)
  }

  remove(key: string): boolean {
    const row = this.rowByKey.get(key)
    if (row === undefined) return false
    const lastRow = this.keys.length - 1
    if (row !== lastRow) {
      const lastKey = this.keys[lastRow]
      this.data.copyWithin(row * this.dimensions, lastRow * this.dimensions, (lastRow + 1) * this.dimensions)
      this.keys[row] = lastKey
      this.rowByKey.set(lastKey, row)
    }
    this.keys.pop()
    this.rowByKey.delete(key)
    return true
  }

  get(key: string): Float32Array | undefined {
    const row = this.rowByKey.get(key)
    if (row === undefined) return undefined
    return this.data.slice(row * this.dimensions, (row + 1) * this.dimensions)
  }

  allKeys(): string[] {
    return [...this.keys]
  }

  /** Cosine similarity against every stored vector, keeping the best `topK`. */
  search(query: Float32Array, options: VectorSearchOptions): VectorSearchHit[] {
    if (query.length !== this.dimensions) {
      throw new Error(`dimension mismatch: expected ${this.dimensions}, got ${query.length}`)
    }
    const normalizedQuery = l2Normalize(query)
    const minSimilarity = options.minSimilarity ?? -Infinity
    const hits: VectorSearchHit[] = []

    for (let row = 0; row < this.keys.length; row++) {
      const key = this.keys[row]
      if (options.filter && !options.filter(key)) continue
      const offset = row * this.dimensions
      let similarity = 0
      for (let i = 0; i < this.dimensions; i++) {
        similarity += this.data[offset + i] * normalizedQuery[i]
      }
      if (similarity >= minSimilarity) hits.push({ key, similarity })
    }

    hits.sort((a, b) => b.similarity - a.similarity || (a.key < b.key ? -1 : 1))
    return hits.slice(0, options.topK)
  }

  private ensureCapacity(rows: number): void {
    const capacity = this.data.length / this.dimensions
    if (rows <= capacity) return
    let nextCapacity = Math.max(1, capacity)
    while (nextCapacity < rows) nextCapacity *= 2
    const grown = new Float32Array(nextCapacity * this.dimensions)
    grown.set(this.data)
    this.data = grown
  }
}
