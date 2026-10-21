import { useCallback, useEffect, useRef, useState } from 'react'
import { useEvents } from './useEvents'

export interface LoadState<T> {
  data: T | undefined
  error: string | null
  loading: boolean
  reload: () => void
}

/** Load data from the main process; refetches when `deps` change or live events arrive. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], live = true): LoadState<T> {
  const { tick } = useEvents()
  const [data, setData] = useState<T>()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const [manual, setManual] = useState(0)

  useEffect(() => {
    const mine = ++seq.current
    setLoading(true)
    fn().then(
      (d) => mine === seq.current && (setData(d), setError(null), setLoading(false)),
      (e: unknown) => mine === seq.current && (setError(e instanceof Error ? e.message : String(e)), setLoading(false))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, live ? tick : 0, manual])

  const reload = useCallback(() => setManual((m) => m + 1), [])
  return { data, error, loading, reload }
}
