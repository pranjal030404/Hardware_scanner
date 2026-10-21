/** Pure chart maths (no React) so it can be unit-tested. */

export interface ChartPoint { t: number; v: number }
export interface ChartSeriesInput { id: string; label: string; points: ChartPoint[]; /** Expected spacing; larger gaps break the line. */ intervalMs: number; dashed?: boolean }

export interface Segment { d: string; points: { x: number; y: number; t: number; v: number }[] }
export interface Geometry {
  width: number
  height: number
  plot: { left: number; right: number; top: number; bottom: number }
  yDomain: [number, number]
  yTicks: number[]
  xTicks: { x: number; t: number }[]
  series: { id: string; segments: Segment[]; hasData: boolean }[]
}

export const GAP_FACTOR = 2.5

/** "Nice" tick values covering [min, max]. */
export function niceTicks(min: number, max: number, target = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0]
  if (max === min) { max = min + 1 }
  const raw = (max - min) / Math.max(1, target)
  const pow = Math.pow(10, Math.floor(Math.log10(raw)))
  const f = raw / pow
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow
  const out: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(Math.round(v / step) * step)
  return out
}

export function buildGeometry(
  series: ChartSeriesInput[], fromMs: number, toMs: number, width: number, height: number, opts: { yMin?: number; yMax?: number } = {}
): Geometry {
  const plot = { left: 54, right: width - 10, top: 8, bottom: height - 22 }
  const all = series.flatMap((s) => s.points.filter((p) => p.t >= fromMs && p.t <= toMs))
  let lo = opts.yMin ?? (all.length ? Math.min(...all.map((p) => p.v)) : 0)
  let hi = opts.yMax ?? (all.length ? Math.max(...all.map((p) => p.v)) : 1)
  if (opts.yMin === undefined && lo > 0 && lo / Math.max(hi, 1e-9) < 0.5) lo = 0 // keep bars of rates anchored at zero
  if (hi - lo < 1e-9) { hi = lo + 1 }
  if (opts.yMax === undefined) hi += (hi - lo) * 0.08
  const yTicks = niceTicks(lo, hi)
  if (opts.yMax === undefined && yTicks.length) hi = Math.max(hi, yTicks[yTicks.length - 1]!)
  const x = (t: number): number => plot.left + ((t - fromMs) / Math.max(1, toMs - fromMs)) * (plot.right - plot.left)
  const y = (v: number): number => plot.bottom - ((v - lo) / (hi - lo)) * (plot.bottom - plot.top)
  const xTicks = Array.from({ length: 5 }, (_, i) => fromMs + ((toMs - fromMs) * i) / 4).map((t) => ({ t, x: x(t) }))
  return {
    width, height, plot, yDomain: [lo, hi], yTicks, xTicks,
    series: series.map((s) => {
      const pts = s.points.filter((p) => p.t >= fromMs && p.t <= toMs).sort((a, b) => a.t - b.t)
      const segments: Segment[] = []
      let cur: Segment['points'] = []
      const close = (): void => {
        if (cur.length) segments.push({ points: cur, d: cur.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('') })
        cur = []
      }
      let prev: ChartPoint | undefined
      for (const p of pts) {
        // A missing measurement is a gap in the line, never an interpolated value.
        if (prev && p.t - prev.t > s.intervalMs * GAP_FACTOR) close()
        cur.push({ x: x(p.t), y: y(Math.min(hi, Math.max(lo, p.v))), t: p.t, v: p.v })
        prev = p
      }
      close()
      return { id: s.id, segments, hasData: pts.length > 0 }
    })
  }
}

/** Time-axis label: seconds only for short windows, otherwise HH:MM (plus date beyond a day). */
export function formatTick(t: number, windowMs: number): string {
  const d = new Date(t)
  const p = (n: number): string => String(n).padStart(2, '0')
  if (windowMs <= 20 * 60_000) return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  if (windowMs > 36 * 3_600_000) return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

export function formatMetric(v: number, unit: string): string {
  if (!Number.isFinite(v)) return '—'
  if (unit === 'B/s' || unit === 'B') {
    const u = ['B', 'KB', 'MB', 'GB', 'TB']
    let n = Math.abs(v), i = 0
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
    return `${v < 0 ? '-' : ''}${n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)} ${u[i]}${unit === 'B/s' ? '/s' : ''}`
  }
  if (unit === '%') return `${Number.isInteger(v) || v >= 10 ? v.toFixed(0) : v.toFixed(1)}%`
  if (unit === '°C') return `${Number.isInteger(v) ? v : v.toFixed(1)} °C`
  if (unit === 'RPM') return `${Math.round(v)} RPM`
  if (unit === 'W') return `${v.toFixed(1)} W`
  return `${Math.round(v * 100) / 100}${unit ? ` ${unit}` : ''}`
}
