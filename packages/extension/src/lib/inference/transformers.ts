import type { InferenceEngine } from '@ypr/shared'
import type { FeatureExtractionPipeline, ProgressCallback } from '@huggingface/transformers'

/**
 * Embedding backend running entirely inside the browser (design section 7.2).
 *
 * The e5 family needs `query: ` / `passage: ` prefixes to separate an information need
 * from a document. That convention lives here and nowhere else, which is why the
 * interface exposes two methods instead of one with a mode flag.
 */

export const DEFAULT_MODEL_ID = 'Xenova/multilingual-e5-small'
export const DEFAULT_DIMENSIONS = 384

export interface TransformersEngineOptions {
  modelId?: string
  dimensions?: number
  /** Reports model download progress so the UI can show it on first run. */
  onProgress?: ProgressCallback
}

export class TransformersInferenceEngine implements InferenceEngine {
  readonly modelId: string
  readonly dimensions: number
  private readonly onProgress: ProgressCallback | undefined
  private extractor: Promise<FeatureExtractionPipeline> | undefined

  constructor(options: TransformersEngineOptions = {}) {
    this.modelId = options.modelId ?? DEFAULT_MODEL_ID
    this.dimensions = options.dimensions ?? DEFAULT_DIMENSIONS
    this.onProgress = options.onProgress
  }

  async embedQuery(texts: string[]): Promise<Float32Array[]> {
    return this.embed(texts.map((text) => `query: ${text}`))
  }

  async embedPassage(texts: string[]): Promise<Float32Array[]> {
    return this.embed(texts.map((text) => `passage: ${text}`))
  }

  /** Loads the model. Call it before a batch so the UI can show download progress. */
  async warmUp(): Promise<void> {
    await this.getExtractor()
  }

  private async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const extractor = await this.getExtractor()
    const output = await extractor(texts, { pooling: 'mean', normalize: true })
    const [rows, dimensions] = output.dims as [number, number]
    if (dimensions !== this.dimensions) {
      throw new Error(
        `model ${this.modelId} produced ${dimensions} dimensions, expected ${this.dimensions}`,
      )
    }
    const flat = output.data as Float32Array
    const vectors: Float32Array[] = []
    for (let row = 0; row < rows; row++) {
      vectors.push(flat.slice(row * dimensions, (row + 1) * dimensions))
    }
    return vectors
  }

  private getExtractor(): Promise<FeatureExtractionPipeline> {
    if (!this.extractor) {
      // Imported lazily: the runtime is a large chunk, and a page that never embeds
      // anything (the interest editor, say) should not pay for it.
      this.extractor = import('@huggingface/transformers').then(({ env, pipeline }) => {
        // Models are fetched from the hub and cached by the browser; nothing is bundled.
        env.allowLocalModels = false
        return pipeline('feature-extraction', this.modelId, {
          dtype: 'q8',
          device: 'auto',
          ...(this.onProgress ? { progress_callback: this.onProgress } : {}),
        })
      })
    }
    return this.extractor
  }
}
