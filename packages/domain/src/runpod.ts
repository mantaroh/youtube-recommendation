/**
 * The wire protocol between the Cloudflare Worker and the GPU service
 * (design sections 22 through 24).
 *
 * One endpoint, one envelope, `operation` inside. Runpod bills per endpoint and every
 * endpoint means another container image to keep current, so four operations share one
 * rather than each getting its own.
 *
 * Note what the payloads do not carry: no OAuth token, no Access identity, no email, no
 * address (design section 44). The GPU side is given text and ratings, and is told
 * nothing about who produced them.
 */

export type RunpodOperation = 'train' | 'score_batch' | 'embed_batch' | 'describe_batch'

/** Runpod unwraps `input` and hands it to the handler verbatim. */
export interface RunpodEnvelope<TPayload> {
  input: {
    operation: RunpodOperation
    payload: TPayload
  }
}

/**
 * Design section 23 writes the score request with its fields directly under `input`,
 * and section 22 writes the general form with a nested `payload`. The nested form is
 * the one implemented, because it is the only one that stays the same shape as
 * operations are added.
 */
export interface ScoreBatchPayload {
  profile: string
  /** `model-<version>`. The GPU side refuses the job if that version is not on disk. */
  modelVersion: string
  items: ScoreBatchItem[]
}

export interface ScoreBatchItem {
  id: string
  /** Title, description and channel name, already assembled by the Worker. */
  text: string
}

export interface ScoreBatchResult {
  items: Array<{
    id: string
    /** Anagnorisis scale, 0..10. */
    score: number
  }>
  modelVersion: string
}

export interface TrainPayload {
  profile: string
  /** The version to produce. Training writes `<version>.tmp` and renames on success. */
  modelVersion: string
  events: TrainEvent[]
  /** Wall-clock ceiling, so a runaway run cannot bill for an idle GPU. */
  timeBudgetSeconds?: number
  maxSteps?: number
}

export interface TrainEvent {
  itemId: string
  /** Anagnorisis scale, 0..10: already doubled from the 0..5 the user chose. */
  rating: number
  description: string
  /** When the rating was given, so the memory file records the real date. */
  ratedAt?: string
}

export interface TrainResult {
  modelVersion: string
  modelPath: string
  trainedEventCount: number
  trainedSeconds: number
  accuracy?: Record<string, number>
}

export interface EmbedBatchPayload {
  profile: string
  items: ScoreBatchItem[]
}

export interface EmbedBatchResult {
  items: Array<{
    id: string
    vector: number[]
  }>
  dimensions: number
}

export interface DescribeBatchPayload {
  profile: string
  items: ScoreBatchItem[]
}

export interface DescribeBatchResult {
  items: Array<{
    id: string
    description: string
  }>
}

export type RunpodPayload =
  | ScoreBatchPayload
  | TrainPayload
  | EmbedBatchPayload
  | DescribeBatchPayload

/** Runpod's own job envelope, returned by `/run`, `/runsync` and `/status`. */
export interface RunpodJobStatus<TOutput = unknown> {
  id: string
  /** Runpod's vocabulary, which is not ours: see `mapRunpodStatus`. */
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT'
  output?: TOutput
  error?: string
  delayTime?: number
  executionTime?: number
}
