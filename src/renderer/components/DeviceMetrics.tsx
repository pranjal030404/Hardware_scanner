import { useMemo } from 'react'
import { formatMetric } from './chart-geometry'
import { TimeChart } from './TimeChart'
import { Badge, timeAgo } from './ui'
import { selKey, useMetrics } from '../hooks/useMetrics'

const WINDOW_SEC = 900

/** Live measurements for one device (only series whose device relationship is known). */
export function DeviceMetrics({ deviceId }: { deviceId: string }): JSX.Element | null {
  const base = useMetrics([], WINDOW_SEC)
  const mine = useMemo(() => (base.status?.series ?? []).filter((s) => s.deviceId === deviceId).slice(0, 8), [base.status, deviceId])
  const sel = useMemo(() => mine.map((s) => ({ metric: s.metric, deviceId })), [mine, deviceId])
  const live = useMetrics(sel, WINDOW_SEC, 150)
  if (!mine.length) return null
  const paused = !!live.status?.paused
  return (
    <section className="card span-3" aria-label="Live metrics">
      <h2>Live metrics <span className="muted">· last 15 minutes, measured from the OS</span></h2>
      <div className="grid">
        {mine.map((s) => {
          const d = live.data.get(selKey({ metric: s.metric, deviceId }))
          const last = d?.points[d.points.length - 1]?.v
          const stale = paused || !d || d.stale
          return (
            <div key={s.metric} className="mini-metric">
              <div className="metric-head"><span>{s.metric.replace(/^(temperature|fan):/, '$1 · ').replace(/[._]/g, ' ')}</span><span className="inline">{last !== undefined && <b>{formatMetric(last, s.unit)}</b>}<Badge tone={stale ? 'warn' : 'ok'}>{stale ? 'stale' : 'live'}</Badge></span></div>
              {d && <TimeChart ariaLabel={`${s.metric} for ${s.deviceName}`} height={100} series={[{ id: s.metric, label: s.metric, points: d.points, intervalMs: d.intervalMs }]} toMs={live.now} windowMs={WINDOW_SEC * 1000} unit={s.unit} yMin={s.unit === '%' ? 0 : undefined} yMax={s.unit === '%' ? 100 : undefined} stale={stale} />}
              <p className="muted small">Source: <span className="mono">{s.source}</span>{stale && d?.lastAt ? ` · last measurement ${timeAgo(d.lastAt)}` : ''}</p>
            </div>
          )
        })}
      </div>
    </section>
  )
}
