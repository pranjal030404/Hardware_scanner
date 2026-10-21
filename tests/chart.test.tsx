import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildGeometry, formatMetric, formatTick, niceTicks } from '../src/renderer/components/chart-geometry'
import { TimeChart } from '../src/renderer/components/TimeChart'

const T = Date.parse('2026-03-01T12:00:00.000Z')
const pts = (vals: number[], step = 5000, start = T - vals.length * step) => vals.map((v, i) => ({ t: start + i * step, v }))

describe('chart geometry', () => {
  it('niceTicks returns round values covering the range', () => {
    expect(niceTicks(0, 100)).toEqual([0, 50, 100]); expect(niceTicks(0, 10, 5)).toEqual([0, 2, 4, 6, 8, 10])
    expect(niceTicks(3, 3)).toEqual([3, 3.5, 4]) // degenerate range still yields ticks
    expect(niceTicks(NaN, 1)).toEqual([0])
  })
  it('plots only points inside the window and keeps values inside the y domain', () => {
    const g = buildGeometry([{ id: 'a', label: 'a', intervalMs: 5000, points: [{ t: T - 999_999, v: 5 }, ...pts([10, 20, 30])] }], T - 60_000, T, 600, 170, { yMin: 0, yMax: 100 })
    expect(g.series[0]!.segments).toHaveLength(1)
    expect(g.series[0]!.segments[0]!.points).toHaveLength(3)
    for (const p of g.series[0]!.segments[0]!.points) { expect(p.y).toBeGreaterThanOrEqual(g.plot.top); expect(p.y).toBeLessThanOrEqual(g.plot.bottom); expect(p.x).toBeGreaterThanOrEqual(g.plot.left) }
    expect(g.yDomain).toEqual([0, 100])
  })
  it('breaks the line across missing data instead of interpolating', () => {
    const a = pts([1, 2, 3], 5000, T - 120_000)
    const b = pts([4, 5], 5000, T - 20_000) // 85 s gap
    const g = buildGeometry([{ id: 'a', label: 'a', intervalMs: 5000, points: [...a, ...b] }], T - 130_000, T, 600, 170)
    expect(g.series[0]!.segments).toHaveLength(2)
    expect(g.series[0]!.segments.map((s) => s.points.length)).toEqual([3, 2])
    // a gap threshold scales with the series interval: the same data with coarse spacing stays connected
    expect(buildGeometry([{ id: 'a', label: 'a', intervalMs: 60_000, points: [...a, ...b] }], T - 130_000, T, 600, 170).series[0]!.segments).toHaveLength(1)
  })
  it('anchors rate charts at zero and handles empty and constant series', () => {
    const rate = [{ id: 'a', label: 'a', intervalMs: 5000, points: pts([900, 1000, 950]) }]
    expect(buildGeometry(rate, T - 60_000, T, 600, 170, { yMin: 0 }).yDomain[0]).toBe(0) // rate cards pass yMin=0
    expect(buildGeometry([{ ...rate[0]!, points: pts([1, 1000, 950]) }], T - 60_000, T, 600, 170).yDomain[0]).toBe(0) // wide spread auto-anchors
    const empty = buildGeometry([{ id: 'a', label: 'a', intervalMs: 5000, points: [] }], T - 60_000, T, 600, 170)
    expect(empty.series[0]!.hasData).toBe(false)
    const flat = buildGeometry([{ id: 'a', label: 'a', intervalMs: 5000, points: pts([5, 5, 5]) }], T - 60_000, T, 600, 170)
    expect(flat.yDomain[1]).toBeGreaterThan(flat.yDomain[0])
    expect(flat.series[0]!.segments[0]!.points.every((p) => Number.isFinite(p.y))).toBe(true)
  })
  it('formats values with explicit units and real timestamps', () => {
    expect(formatMetric(1536, 'B/s')).toBe('1.5 KB/s'); expect(formatMetric(0, 'B/s')).toBe('0 B/s'); expect(formatMetric(12.34, '%')).toBe('12%'); expect(formatMetric(4.5, '%')).toBe('4.5%')
    expect(formatMetric(45.56, '°C')).toBe('45.6 °C'); expect(formatMetric(0, '%')).toBe('0%'); expect(formatMetric(3200, 'RPM')).toBe('3200 RPM'); expect(formatMetric(-8.5, 'W')).toBe('-8.5 W'); expect(formatMetric(NaN, '%')).toBe('—')
    const d = new Date(2026, 2, 1, 9, 5, 7).getTime()
    expect(formatTick(d, 60_000)).toBe('09:05:07'); expect(formatTick(d, 3_600_000)).toBe('09:05'); expect(formatTick(d, 48 * 3_600_000)).toBe('3/1 09:05')
  })
  it('handles tens of thousands of points quickly', () => {
    const big = pts(Array.from({ length: 50_000 }, (_, i) => Math.sin(i / 50) * 40 + 50), 100, T - 5_000_000)
    const t0 = performance.now()
    buildGeometry([{ id: 'a', label: 'a', intervalMs: 100, points: big }], T - 5_000_000, T, 800, 200, { yMin: 0, yMax: 100 })
    expect(performance.now() - t0).toBeLessThan(500)
  })
})

describe('TimeChart rendering', () => {
  const base = { toMs: T, windowMs: 300_000, ariaLabel: 'CPU utilisation over time' }
  it('renders an accessible SVG with unit-labelled y ticks and real-time x ticks', () => {
    const html = renderToStaticMarkup(<TimeChart {...base} unit="%" yMin={0} yMax={100} series={[{ id: 'cpu', label: 'CPU', intervalMs: 5000, points: pts([10, 40, 30], 5000, T - 15_000) }]} />)
    expect(html).toContain('role="img"'); expect(html).toContain('aria-label="CPU utilisation over time"')
    expect(html).toMatch(/>100%</); expect(html).toMatch(/>0%</)
    expect(html).toMatch(/>\d{2}:\d{2}:\d{2}</) // real clock times on the x axis (seconds for short windows)
    expect(html).toContain('<path')
    expect(html).not.toContain('No measurements')
    expect(html).not.toContain('chart-stale')
  })
  it('shows an explicit empty state (never a flat "healthy" line) when there are no measurements', () => {
    const html = renderToStaticMarkup(<TimeChart {...base} unit="%" series={[{ id: 'cpu', label: 'CPU', intervalMs: 5000, points: [] }]} />)
    expect(html).toContain('No measurements in this window'); expect(html).not.toContain('<path')
  })
  it('marks stale data visually', () => {
    const html = renderToStaticMarkup(<TimeChart {...base} unit="%" stale series={[{ id: 'cpu', label: 'CPU', intervalMs: 5000, points: pts([1, 2]) }]} />)
    expect(html).toContain('chart-stale')
  })
  it('draws multiple series with a legend and distinguishes them by dash, not just colour', () => {
    const html = renderToStaticMarkup(<TimeChart {...base} unit="B/s" yMin={0} series={[
      { id: 'rx', label: 'Receive', intervalMs: 5000, points: pts([1000, 2000, 1500], 5000, T - 15_000) },
      { id: 'tx', label: 'Transmit', intervalMs: 5000, dashed: true, points: pts([100, 200, 150], 5000, T - 15_000) }
    ]} />)
    expect(html).toContain('Receive'); expect(html).toContain('Transmit'); expect(html).toContain('stroke-dasharray="5 3"'); expect(html).toMatch(/KB\/s|B\/s/)
  })
  it('renders isolated points as dots and gaps as separate paths', () => {
    const html = renderToStaticMarkup(<TimeChart {...base} unit="%" series={[{ id: 'a', label: 'a', intervalMs: 5000, points: [...pts([1, 2], 5000, T - 200_000), { t: T - 5000, v: 3 }] }]} />)
    expect(html).toContain('<circle'); expect((html.match(/<path/g) ?? []).length).toBe(1)
  })
})
