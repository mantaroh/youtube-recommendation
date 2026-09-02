import type { AppContext, Env } from '../env.js'

/** What every route can reach: the bindings, and the request-scoped context. */
export interface AppBindings {
  Bindings: Env
  Variables: {
    app: AppContext
  }
}
