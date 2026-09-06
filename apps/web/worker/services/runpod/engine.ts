import type { Env } from '../../env.js'
import { RunpodClient } from './client.js'

/**
 * Which engine to talk to, decided in one place.
 *
 * Three deployments answer the same work in three different shapes:
 *
 * - **runpod** — Runpod Serverless, reached over its own API.
 * - **local** — the same container run directly (`services/anagnorisis-worker/serve.py`),
 *   reached at a plain address. Everything above this file submits jobs and polls a
 *   ledger without knowing which of the two is behind it, which is what makes the local
 *   one worth having: the pipeline being exercised is the real one.
 * - **pull** — nothing is reached at all. Jobs are left in the ledger and a runner comes
 *   and takes them (`docs/design/pull-engine.ja.md`). This is the mode for a machine
 *   that is not always on and should not be reachable from outside.
 */

export type EngineMode = 'pull' | 'local' | 'runpod' | 'none'

export const ENGINE_NOT_CONFIGURED =
  'no preference engine configured: set ENGINE_PULL_TOKEN to let a runner collect jobs, ' +
  'PREFERENCE_ENGINE_URL for a local engine, or RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID for Runpod'

/**
 * Pull wins when more than one is configured.
 *
 * The combination is a misconfiguration rather than a choice, and of the two readings
 * the safe one is to wait for a runner: submitting to an endpoint that was left set by
 * accident would spend money. The status screen reports the mode so the mistake is
 * visible rather than silent.
 */
export function engineMode(env: Env): EngineMode {
  if (env.ENGINE_PULL_TOKEN) return 'pull'
  if (env.PREFERENCE_ENGINE_URL) return 'local'
  if (env.RUNPOD_API_KEY && env.RUNPOD_ENDPOINT_ID) return 'runpod'
  return 'none'
}

export function engineConfigured(env: Env): boolean {
  return engineMode(env) !== 'none'
}

/** True when jobs are collected rather than delivered, so nothing is submitted anywhere. */
export function enginePulls(env: Env): boolean {
  return engineMode(env) === 'pull'
}

/** Where jobs are going, for the status screen to report. */
export function engineDescription(env: Env): string | null {
  switch (engineMode(env)) {
    case 'pull':
      return 'pull (a runner collects jobs)'
    case 'local':
      return `local (${env.PREFERENCE_ENGINE_URL})`
    case 'runpod':
      return `runpod (${env.RUNPOD_ENDPOINT_ID})`
    default:
      return null
  }
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
