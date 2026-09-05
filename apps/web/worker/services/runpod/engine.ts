import type { Env } from '../../env.js'
import { RunpodClient } from './client.js'

/**
 * Which engine to talk to, decided in one place.
 *
 * Two deployments answer the same three routes with the same envelope: Runpod
 * Serverless, and the container run directly (`services/anagnorisis-worker/serve.py`).
 * Everything above this file submits jobs and polls a ledger without knowing which is
 * behind it, which is the property that makes the local one worth having — the job
 * pipeline being exercised is the real one, not a simulation of it.
 */

export const ENGINE_NOT_CONFIGURED =
  'no preference engine configured: set PREFERENCE_ENGINE_URL for a local engine, ' +
  'or RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID for Runpod'

export function engineConfigured(env: Env): boolean {
  if (env.PREFERENCE_ENGINE_URL) return true
  return Boolean(env.RUNPOD_API_KEY && env.RUNPOD_ENDPOINT_ID)
}

/** Where jobs are being sent, for the status screen to report. */
export function engineDescription(env: Env): string | null {
  if (env.PREFERENCE_ENGINE_URL) return `local (${env.PREFERENCE_ENGINE_URL})`
  if (env.RUNPOD_API_KEY && env.RUNPOD_ENDPOINT_ID) return `runpod (${env.RUNPOD_ENDPOINT_ID})`
  return null
}

export function engineClient(env: Env, fetchImpl?: typeof fetch): RunpodClient {
  return new RunpodClient({
    // A local engine authenticates nobody, so the header is filled with a placeholder
    // rather than made conditional: one code path, and a value that is meaningless
    // wherever it is not needed.
    apiKey: env.RUNPOD_API_KEY ?? 'local',
    endpointId: env.RUNPOD_ENDPOINT_ID ?? 'local',
    ...(env.PREFERENCE_ENGINE_URL ? { baseUrl: env.PREFERENCE_ENGINE_URL } : {}),
    ...(fetchImpl ? { fetchImpl } : {}),
  })
}
