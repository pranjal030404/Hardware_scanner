import { useCallback, useEffect, useRef, useState } from 'react'
import type { MetricSeriesData, MetricsStatus } from '@shared/schemas'
import { api } from '../services/api'

export interface SeriesSel { metric: string; deviceId: string }
export const selKey = (s: SeriesSel): string => `${s.metric}\0${s.deviceId}`

/**
 * Polls metric status and the requested series while mounted. Polling cadence follows the sampling
 * interval (min 2 s); nothing is polled while sampling is paused beyond a slow status check.
 */
export function useMetrics(selectors: SeriesSel[], windowSec: number, maxPoints = 300): {
  status: MetricsStatus | undefined
  data: Map<string, MetricSeriesData>
  error: string | null
  now: number
  reload: () => void
} {
  const [status, setStatus] = useState<MetricsStatus>()
  const [data, setData] = useState<Map<string, MetricSeriesData>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const selRef = useRef(selectors)
  selRef.current = selectors
  const selSig = selectors.map(selKey).join('|')
  const seq = useRef(0)

  const load = useCallback(async () => {
    const mine = ++seq.current
    try {
      const st = await api.metricsStatus()
      const sel = selRef.current.slice(0, 40)
      const res = sel.length ? await api.queryMetrics(sel, windowSec, maxPoints) : []
      if (mine !== seq.current) return
      setStatus(st); setData(new Map(res.map((r) => [selKey(r), r]))); setNow(Date.now()); setError(null)
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message)
    }
  }, [windowSec, maxPoints])

  useEffect(() => { void load() }, [load, selSig])
  const interval = status?.paused ? 10_000 : Math.max(2000, (status?.intervalSec ?? 5) * 1000)
  useEffect(() => {
    const t = setInterval(() => void load(), interval)
    return () => clearInterval(t)
  }, [load, interval])

  return { status, data, error, now, reload: () => void load() }
}
