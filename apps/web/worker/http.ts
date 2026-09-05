/**
 * The global `fetch`, safe to hold onto.
 *
 * Storing bare `fetch` on an object and calling it as `this.fetchImpl(...)` makes the
 * receiver that object, and the Workers runtime rejects it with "Illegal invocation".
 * Binding once at the boundary means no caller has to remember how it is invoked.
 */
export function boundFetch(override?: typeof fetch): typeof fetch {
  return override ?? fetch.bind(globalThis)
}
