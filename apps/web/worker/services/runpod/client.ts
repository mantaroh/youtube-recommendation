import type {
  GpuJobStatus,
  RunpodEnvelope,
  RunpodJobStatus,
  RunpodOperation,
  RunpodPayload,
} from '@ypr/domain'
import { boundFetch } from '../../http.js'

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
  /**
   * Where the engine lives, when it is not Runpod.
   *
   * The GPU service speaks one envelope and three routes — `/run`, `/status/{id}`,
   * `/cancel/{id}` — none of which is Runpod-specific. Pointing this at a process on
   * the developer's own machine therefore changes nothing above this file: the job
   * ledger, the polling pass and the atomic model switch all behave identically,
   * which is the point of testing against it at all.
   *
   * `PREFERENCE_ENGINE_URL` in the environment; unset means Runpod.
   */
  baseUrl?: string
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
    this.fetchImpl = boundFetch(config.fetchImpl)
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
    const response = await this.fetchImpl(`${this.root()}/status/${runpodJobId}`, {
      headers: this.headers(),
    })
    if (!response.ok) {
      throw new RunpodError(`status ${response.status}: ${await response.text()}`, response.status)
    }
    return (await response.json()) as RunpodJobStatus<TOutput>
  }

  async cancel(runpodJobId: string): Promise<void> {
    await this.fetchImpl(`${this.root()}/cancel/${runpodJobId}`, {
      method: 'POST',
      headers: this.headers(),
    })
  }

  /**
   * Where requests go.
   *
   * A local engine is addressed directly; Runpod nests every endpoint under its id.
   * Trailing slashes are trimmed so that both `http://host:9000` and
   * `http://host:9000/` behave the same, which is the sort of difference that
   * otherwise shows up as a 404 an hour later.
   */
  private root(): string {
    if (this.config.baseUrl) return this.config.baseUrl.replace(/\/+$/, '')
    return `${API_ROOT}/${this.config.endpointId}`
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await this.fetchImpl(`${this.root()}/${path}`, {
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
