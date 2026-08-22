import { describe, expect, it } from 'vitest'
import {
  VectorIndex,
  addScaled,
  cosine,
  dot,
  l2Normalize,
  norm,
  weightedCentroid,
  zeros,
} from '../src/vector.js'

const vec = (...values: number[]) => Float32Array.from(values)

describe('vector primitives', () => {
  it('computes dot products and rejects mismatched dimensions', () => {
    expect(dot(vec(1, 2, 3), vec(4, 5, 6))).toBe(32)
    expect(() => dot(vec(1, 2), vec(1, 2, 3))).toThrow(/dimension mismatch/)
  })

  it('normalises to unit length and leaves the zero vector alone', () => {
    const normalized = l2Normalize(vec(3, 4))
    expect(norm(normalized)).toBeCloseTo(1, 6)
    expect(normalized[0]).toBeCloseTo(0.6, 6)

    const zero = l2Normalize(zeros(4))
    expect(norm(zero)).toBe(0)
  })

  it('measures cosine similarity independently of magnitude', () => {
    expect(cosine(vec(1, 0), vec(5, 0))).toBeCloseTo(1, 6)
    expect(cosine(vec(1, 0), vec(0, 1))).toBeCloseTo(0, 6)
    expect(cosine(vec(1, 0), vec(-1, 0))).toBeCloseTo(-1, 6)
    expect(cosine(zeros(2), vec(1, 0))).toBe(0)
  })

  it('accumulates scaled vectors in place', () => {
    const target = vec(1, 1)
    addScaled(target, vec(2, 4), 0.5)
    expect([...target]).toEqual([2, 3])
  })

  it('places a weighted centroid nearer the heavier member', () => {
    const centroid = weightedCentroid([vec(1, 0), vec(0, 1)], [3, 1])
    expect(cosine(centroid, vec(1, 0))).toBeGreaterThan(cosine(centroid, vec(0, 1)))
    expect(norm(centroid)).toBeCloseTo(1, 6)
    expect(() => weightedCentroid([], [])).toThrow(/empty set/)
  })
})

describe('VectorIndex', () => {
  const index = () => {
    const built = new VectorIndex(3, 2)
    built.upsert('a', vec(1, 0, 0))
    built.upsert('b', vec(0, 1, 0))
    built.upsert('c', vec(0.9, 0.1, 0))
    return built
  }

  it('ranks by cosine similarity', () => {
    const hits = index().search(vec(1, 0, 0), { topK: 2 })
    expect(hits.map((hit) => hit.key)).toEqual(['a', 'c'])
    expect(hits[0].similarity).toBeCloseTo(1, 5)
  })

  it('stores vectors normalised, so magnitude does not affect ranking', () => {
    const built = new VectorIndex(3)
    built.upsert('small', vec(1, 0, 0))
    built.upsert('large', vec(100, 0, 0))
    const hits = built.search(vec(1, 0, 0), { topK: 2 })
    expect(hits[0].similarity).toBeCloseTo(hits[1].similarity, 5)
  })

  it('replaces rather than duplicates on repeated upsert', () => {
    const built = index()
    built.upsert('a', vec(0, 0, 1))
    expect(built.size).toBe(3)
    expect(built.search(vec(0, 0, 1), { topK: 1 })[0].key).toBe('a')
  })

  it('keeps every remaining vector searchable after a removal', () => {
    const built = index()
    expect(built.remove('a')).toBe(true)
    expect(built.remove('a')).toBe(false)
    expect(built.size).toBe(2)
    expect(built.allKeys().sort()).toEqual(['b', 'c'])
    expect(built.search(vec(0, 1, 0), { topK: 1 })[0].key).toBe('b')
    expect(built.search(vec(1, 0, 0), { topK: 1 })[0].key).toBe('c')
  })

  it('applies filters and similarity floors', () => {
    const built = index()
    expect(built.search(vec(1, 0, 0), { topK: 5, filter: (key) => key !== 'a' })[0].key).toBe('c')
    // 'c' normalises to a cosine of ~0.994 against (1,0,0), so the floor has to sit above that.
    expect(built.search(vec(1, 0, 0), { topK: 5, minSimilarity: 0.999 }).map((h) => h.key)).toEqual(['a'])
    expect(built.search(vec(1, 0, 0), { topK: 5, minSimilarity: 0.99 }).map((h) => h.key)).toEqual(['a', 'c'])
  })

  it('grows beyond its initial capacity without losing vectors', () => {
    const built = new VectorIndex(3, 1)
    for (let i = 0; i < 50; i++) built.upsert(`k${i}`, vec(i + 1, 1, 0))
    expect(built.size).toBe(50)
    expect(built.search(vec(1, 1, 0), { topK: 50 })).toHaveLength(50)
  })

  it('rejects vectors of the wrong dimension', () => {
    const built = new VectorIndex(3)
    expect(() => built.upsert('x', vec(1, 0))).toThrow(/dimension mismatch/)
    expect(() => built.search(vec(1, 0), { topK: 1 })).toThrow(/dimension mismatch/)
  })
})
