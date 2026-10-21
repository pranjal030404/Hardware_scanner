/** Pure helpers for turning raw counters into rates/utilisation without ever fabricating values. */

export interface RateResult {
  /** Units per second, or undefined when no trustworthy rate exists. */
  value?: number
  /** The counter went backwards (reset, wrap, device re-created). The caller must re-baseline. */
  reset: boolean
}

/**
 * Delta rate of a monotonically increasing counter.
 * - no previous value, non-positive or non-finite elapsed time → no rate (not a zero!)
 * - counter decreased → reset: no rate, and the new value becomes the baseline
 */
export function counterRate(prev: number | undefined, cur: number, dtMs: number | undefined): RateResult {
  if (!Number.isFinite(cur) || cur < 0) return { reset: false }
  if (prev === undefined || dtMs === undefined || !Number.isFinite(dtMs) || dtMs <= 0) return { reset: false }
  if (cur < prev) return { reset: true }
  return { value: (cur - prev) / (dtMs / 1000), reset: false }
}

/** Percentage of `busy` within `total` ticks over an interval; undefined when there is no elapsed work to measure. */
export function ratioPercent(busyDelta: number, totalDelta: number): number | undefined {
  if (!Number.isFinite(busyDelta) || !Number.isFinite(totalDelta) || totalDelta <= 0 || busyDelta < 0) return undefined
  return Math.min(100, Math.max(0, (busyDelta / totalDelta) * 100))
}

/** Reading sanity gate applied to every value before it is stored. */
export function isValidReading(v: number, unit: string): boolean {
  if (!Number.isFinite(v) || Math.abs(v) > 1e15) return false
  if (unit === '%' && (v < 0 || v > 100.0001)) return false
  if (['B/s', 'B', 'RPM', '/s', 'pages/s', 'count', 'tasks', 'load', 'MHz'].includes(unit) && v < 0) return false
  if (unit === '°C' && (v < -100 || v > 400)) return false
  return true
}
