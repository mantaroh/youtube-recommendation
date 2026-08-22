import { addScaled, cosine, l2Normalize, zeros } from './vector.js'

/**
 * Leader clustering (design section 3.2).
 *
 * Chosen over k-means for three reasons: it updates incrementally as ratings arrive, it
 * does not need the number of clusters up front, and — replayed in sequence order — it is
 * deterministic, which is what makes rebuilding at a past instant reproducible.
 *
 * Both liked and disliked items shape a cluster's centroid, weighted by the magnitude of
 * the rating. A cluster describes *a topic*, not an opinion: disliking a video still tells
 * us where in the space that topic sits. Whether the topic is wanted is decided later, by
 * the signed masses.
 */

export interface ClusterMember {
  key: string
  /** Signed rating weight. */
  weight: number
  ts: string
}

export interface ClusterAccumulator {
  /** Stable across rebuilds: derived from the first member that created the cluster. */
  id: string
  /** Unnormalised sum of member vectors, weighted by |weight|. */
  sum: Float32Array
  /** L2-normalised centroid, kept in step with `sum`. */
  centroid: Float32Array
  members: ClusterMember[]
}

export interface ClustererOptions {
  dimensions: number
  /** Cosine threshold for joining an existing cluster. */
  tau: number
  /** Maximum number of clusters; the least massive is merged away beyond this. */
  kMax: number
}

export class LeaderClusterer {
  private readonly options: ClustererOptions
  private readonly accumulators: ClusterAccumulator[] = []
  /**
   * Maps a merged-away cluster id to the cluster that absorbed it, so user edits made
   * against the old id keep applying after a merge.
   */
  private readonly aliases = new Map<string, string>()

  constructor(options: ClustererOptions) {
    this.options = options
  }

  get clusters(): readonly ClusterAccumulator[] {
    return this.accumulators
  }

  /** Resolves an id through any merges that happened after it was recorded. */
  resolveId(id: string): string {
    let current = id
    const visited = new Set<string>()
    while (this.aliases.has(current) && !visited.has(current)) {
      visited.add(current)
      current = this.aliases.get(current)!
    }
    return current
  }

  add(member: ClusterMember, vector: Float32Array): ClusterAccumulator {
    const magnitude = Math.abs(member.weight)
    // A neutral rating carries no information about where the topic sits.
    if (magnitude === 0) return this.nearestOrNew(member, vector, 0)
    return this.nearestOrNew(member, vector, magnitude)
  }

  private nearestOrNew(
    member: ClusterMember,
    vector: Float32Array,
    magnitude: number,
  ): ClusterAccumulator {
    let best: ClusterAccumulator | undefined
    let bestSimilarity = -Infinity
    for (const cluster of this.accumulators) {
      const similarity = cosine(cluster.centroid, vector)
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity
        best = cluster
      }
    }

    if (best && bestSimilarity >= this.options.tau) {
      best.members.push(member)
      if (magnitude > 0) {
        addScaled(best.sum, vector, magnitude)
        best.centroid = l2Normalize(best.sum)
      }
      return best
    }

    const sum = zeros(this.options.dimensions)
    addScaled(sum, vector, magnitude > 0 ? magnitude : 1)
    const created: ClusterAccumulator = {
      id: `c:${member.key}`,
      sum,
      centroid: l2Normalize(sum),
      members: [member],
    }
    this.accumulators.push(created)
    this.enforceLimit()
    return created
  }

  /**
   * Merges the least massive cluster into its nearest neighbour once the cap is exceeded.
   * Mass, not size, decides: a small cluster of strong ratings is worth more than a large
   * one of lukewarm ones.
   */
  private enforceLimit(): void {
    while (this.accumulators.length > this.options.kMax) {
      let weakestIndex = 0
      let weakestMass = Infinity
      for (let i = 0; i < this.accumulators.length; i++) {
        const mass = this.accumulators[i].members.reduce(
          (total, member) => total + Math.abs(member.weight),
          0,
        )
        if (mass < weakestMass) {
          weakestMass = mass
          weakestIndex = i
        }
      }

      const weakest = this.accumulators[weakestIndex]
      let targetIndex = -1
      let bestSimilarity = -Infinity
      for (let i = 0; i < this.accumulators.length; i++) {
        if (i === weakestIndex) continue
        const similarity = cosine(this.accumulators[i].centroid, weakest.centroid)
        if (similarity > bestSimilarity) {
          bestSimilarity = similarity
          targetIndex = i
        }
      }
      if (targetIndex === -1) return

      const target = this.accumulators[targetIndex]
      addScaled(target.sum, weakest.sum, 1)
      target.centroid = l2Normalize(target.sum)
      target.members.push(...weakest.members)
      this.aliases.set(weakest.id, target.id)
      this.accumulators.splice(weakestIndex, 1)
    }
  }
}
