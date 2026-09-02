import type {
  GpuJobStatus,
  RunpodEnvelope,
  RunpodJobStatus,
  RunpodOperation,
  RunpodPayload,
} from '@ypr/domain'

/**
 * The Runpod Serverless endpoint (design sections 22, 28 and 29).
 *
 * Everything of consequence goes through `/run`, which returns a job id immediately.
 * The Worker is on a request timeout and a training run takes minutes, so waiting is
 * not an option available to it — and even where it would fit, holding a request open
 * for the duration would bill Cloudflare for time spent doing nothing.
 *
 * `/runsync` exists here for the one case the design allows: a small probe where the
 * round trip is shorter than the bookkeeping.
 */

const API_ROOT = 'https://api.runpod.ai/v2'

export interface RunpodConfig {
  apiKey: string
  endpointId: string
  fetchImpl?: typeof fetch
}

export class RunpodError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'RunpodError'
  }
}

export class RunpodClient {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly config: RunpodConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch
  }

  /** Queue a job. Returns the Runpod job id; the result is collected later. */
  async run(operation: RunpodOperation, payload: RunpodPayload): Promise<string> {
    const body: RunpodEnvelope<RunpodPayload> = { input: { operation, payload } }
    const result = await this.post<RunpodJobStatus>('run', body)
    if (!result.id) throw new RunpodError('runpod accepted the job but returned no id', 502)
    return result.id
  }

  /** Run and wait. Only for probes small enough that waiting is cheaper than polling. */
  async runSync<TOutput>(
    operation: RunpodOperation,
    payload: RunpodPayload,
  ): Promise<RunpodJobStatus<TOutput>> {
    const body: RunpodEnvelope<RunpodPayload> = { input: { operation, payload } }
    return this.post<RunpodJobStatus<TOutput>>('runsync', body)
  }

  async status<TOutput>(runpodJobId: string): Promise<RunpodJobStatus<TOutput>> {
    const response = await this.fetchImpl(
      `${API_ROOT}/${this.config.endpointId}/status/${runpodJobId}`,
      { headers: this.headers() },
    )
    if (!response.ok) {
      throw new RunpodError(`status ${response.status}: ${await response.text()}`, response.status)
    }
    return (await response.json()) as RunpodJobStatus<TOutput>
  }

  async cancel(runpodJobId: string): Promise<void> {
    await this.fetchImpl(`${API_ROOT}/${this.config.endpointId}/cancel/${runpodJobId}`, {
      method: 'POST',
      headers: this.headers(),
    })
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${API_ROOT}/${this.config.endpointId}/${path}`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new RunpodError(`${path} ${response.status}: ${await response.text()}`, response.status)
    }
    return (await response.json()) as T
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.config.apiKey}`, accept: 'application/json' }
  }
}

/**
 * Runpod's job vocabulary translated into ours.
 *
 * `CANCELLED` and `TIMED_OUT` become `failed` rather than a state of their own. From
 * the point of view of the ledger they are the same event — work that was submitted
 * and did not produce a result — and the reason is preserved in the `error` column.
 */
export function mapRunpodStatus(status: RunpodJobStatus['status']): GpuJobStatus {
  switch (status) {
    case 'IN_QUEUE':
      return 'queued'
    case 'IN_PROGRESS':
      return 'processing'
    case 'COMPLETED':
      return 'completed'
    default:
      return 'failed'
  }
}
