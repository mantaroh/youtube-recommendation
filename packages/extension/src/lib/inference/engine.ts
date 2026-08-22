import type { InferenceEngine } from '@ypr/shared'
import { HashingInferenceEngine } from '@ypr/core'
import { TransformersInferenceEngine } from './transformers.js'

/**
 * Chooses the embedding backend and remembers the choice for the life of the page.
 *
 * The sentence encoder is the real one. The hashing engine is a fallback for the case
 * where the model cannot be fetched at all (offline, blocked host, unsupported device):
 * it keeps the rest of the system usable, and because embeddings are derived rather than
 * canonical, switching back later just recomputes them (design section 2.1).
 */

export type EngineKind = 'transformers' | 'hashing'

export interface EngineStatus {
  kind: EngineKind
  modelId: string
  dimensions: number
  /** Set when the sentence encoder could not be loaded. */
  fallbackReason?: string
  progress: number
}

let engine: InferenceEngine | undefined
let status: EngineStatus = {
  kind: 'transformers',
  modelId: '',
  dimensions: 0,
  progress: 0,
}

const listeners = new Set<(status: EngineStatus) => void>()

export function subscribeToEngineStatus(listener: (status: EngineStatus) => void): () => void {
  listeners.add(listener)
  listener(status)
  return () => listeners.delete(listener)
}

function publish(next: Partial<EngineStatus>): void {
  status = { ...status, ...next }
  for (const listener of listeners) listener(status)
}

export function getEngineStatus(): EngineStatus {
  return status
}

export async function getEngine(): Promise<InferenceEngine> {
  if (engine) return engine

  const transformers = new TransformersInferenceEngine({
    onProgress: (event) => {
      const progress = (event as { progress?: number }).progress
      if (typeof progress === 'number') publish({ progress: Math.round(progress) })
    },
  })
  publish({ kind: 'transformers', modelId: transformers.modelId, dimensions: transformers.dimensions })

  try {
    await transformers.warmUp()
    publish({ progress: 100 })
    engine = transformers
  } catch (error) {
    const fallback = new HashingInferenceEngine(transformers.dimensions)
    publish({
      kind: 'hashing',
      modelId: fallback.modelId,
      dimensions: fallback.dimensions,
      fallbackReason: error instanceof Error ? error.message : String(error),
      progress: 100,
    })
    engine = fallback
  }
  return engine
}

/** Test seam. */
export function setEngine(next: InferenceEngine | undefined): void {
  engine = next
}
