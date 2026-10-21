import { useEffect, useMemo, useRef, useState } from 'react'
import { buildGeometry, formatMetric, formatTick, type ChartSeriesInput } from './chart-geometry'

export interface TimeChartProps {
  series: (ChartSeriesInput & { color?: string })[]
  /** Right edge of the time axis (normally "now"). */
  toMs: number
  windowMs: number
  unit: string
  yMin?: number
  yMax?: number
  height?: number
  ariaLabel: string
  stale?: boolean
}

interface Hit { id: string; label: string; ci: number; x: number; y: number; t: number; v: number }

const PALETTE = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)']

/** Dependency-free SVG line chart: real timestamps, explicit units, gaps stay gaps, stale data is dimmed. */
export function TimeChart({ series, toMs, windowMs, unit, yMin, yMax, height = 170, ariaLabel, stale }: TimeChartProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(560)
  const [hover, setHover] = useState<{ x: number } | null>(null)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((e) => setWidth(Math.max(240, Math.floor(e[0]!.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const fromMs = toMs - windowMs
  const g = useMemo(() => buildGeometry(series, fromMs, toMs, width, height, { yMin, yMax }), [series, fromMs, toMs, width, height, yMin, yMax])
  const hasData = g.series.some((s) => s.hasData)

  // Nearest point to the cursor, across all series.
  const hit = useMemo((): Hit | null => {
    if (!hover) return null
    let best: Hit | null = null
    for (let ci = 0; ci < g.series.length; ci++) {
      const s = g.series[ci]!
      for (const seg of s.segments) {
        for (const p of seg.points) {
          if (best === null || Math.abs(p.x - hover.x) < Math.abs(best.x - hover.x)) best = { id: s.id, label: series[ci]!.label, ci, x: p.x, y: p.y, t: p.t, v: p.v }
        }
      }
    }
    return best
  }, [hover, g, series])

  return (
    <div ref={ref} className={`chart ${stale ? 'chart-stale' : ''}`}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel}
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover({ x: e.clientX - r.left }) }} onMouseLeave={() => setHover(null)}>
        {g.yTicks.map((v) => {
          const y = g.plot.bottom - ((v - g.yDomain[0]) / (g.yDomain[1] - g.yDomain[0])) * (g.plot.bottom - g.plot.top)
          return (
            <g key={v}>
              <line x1={g.plot.left} x2={g.plot.right} y1={y} y2={y} className="chart-grid" />
              <text x={g.plot.left - 6} y={y + 3} textAnchor="end" className="chart-tick">{formatMetric(v, unit).replace(/ (B|KB|MB|GB|TB)\/s$/, ' $1/s')}</text>
            </g>
          )
        })}
        {g.xTicks.map((t, i) => (
          <text key={i} x={t.x} y={height - 6} textAnchor={i === 0 ? 'start' : i === g.xTicks.length - 1 ? 'end' : 'middle'} className="chart-tick">{formatTick(t.t, windowMs)}</text>
        ))}
        {g.series.map((s, ci) => {
          const src = series[ci]!
          const color = src.color ?? PALETTE[ci % PALETTE.length]
          return s.segments.map((seg, i) =>
            seg.points.length === 1
              ? <circle key={`${s.id}${i}`} cx={seg.points[0]!.x} cy={seg.points[0]!.y} r={2.5} fill={color} />
              : <path key={`${s.id}${i}`} d={seg.d} fill="none" stroke={color} strokeWidth={1.8} strokeDasharray={src.dashed ? '5 3' : undefined} strokeLinejoin="round" />
          )
        })}
        {hit && (
          <g pointerEvents="none">
            <line x1={hit.x} x2={hit.x} y1={g.plot.top} y2={g.plot.bottom} className="chart-cross" />
            <circle cx={hit.x} cy={hit.y} r={3.5} fill={series[hit.ci]!.color ?? PALETTE[hit.ci % PALETTE.length]} />
          </g>
        )}
        {!hasData && <text x={(g.plot.left + g.plot.right) / 2} y={(g.plot.top + g.plot.bottom) / 2} textAnchor="middle" className="chart-empty">No measurements in this window</text>}
      </svg>
      {hit && (
        <div className="chart-tip" style={{ left: Math.min(hit.x + 10, width - 170), top: 4 }} role="status">
          <b>{new Date(hit.t).toLocaleTimeString()}</b>
          <span>{hit.label}: {formatMetric(hit.v, unit)}</span>
        </div>
      )}
      {series.length > 1 && (
        <ul className="chart-legend">
          {series.map((s, i) => (
            <li key={s.id}><svg width="22" height="8" aria-hidden><line x1="0" x2="22" y1="4" y2="4" stroke={s.color ?? PALETTE[i % PALETTE.length]} strokeWidth="2" strokeDasharray={s.dashed ? '5 3' : undefined} /></svg>{s.label}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
