import { useCallback, useEffect, useState } from 'react'

export interface AsyncState<T> {
  value: T | undefined
  error: string | undefined
  loading: boolean
  reload: () => void
}

/** Runs an async loader and re-runs it on demand. Ignores results from stale runs. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [value, setValue] = useState<T | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    loader()
      .then((result) => {
        if (cancelled) return
        setValue(result)
        setError(undefined)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(cause instanceof Error ? cause.message : String(cause))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce])

  const reload = useCallback(() => setNonce((current) => current + 1), [])
  return { value, error, loading, reload }
}
