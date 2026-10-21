import { deviceIdFromKey } from '../../collectors/core/normalize'
import { isValidReading } from '../../metrics/derive'
import type { DeviceRef, MetricProvider, MetricReading, ProviderOutput, SampleContext } from '../../metrics/types'
import type { MetricProviderInfo, MetricProviderStatus, MetricSeriesData, MetricSeriesSummary, MetricsStatus, Settings } from '@shared/schemas'
import type { Db } from '../database/db'
import { MetricRepo, type KnownSeries } from '../database/repositories'
import type { EventBus } from './event-bus'

export interface MetricsDeps {
  db: Db
  providers: MetricProvider[]
  platform: NodeJS.Platform
  getSettings: () => Settings
  makeContext: (monoMs: number) => SampleContext
  bus?: EventBus
  clock?: () => Date
  mono?: () => number
  /** Persist averaged samples at most this often per series. */
  persistEveryMs?: number
  /** In-memory points kept per series are derived from the interval; this caps total series. */
  maxSeries?: number
}

interface Series {
  metric: string
  deviceId: string
  unit: string
  source: string
  points: { t: number; v: number }[]
  lastAt: number
  lastValue: number
  acc: { sum: number; count: number; lastT: number }
}

interface ProviderState {
  provider: MetricProvider
  supported: boolean | null
  status: MetricProviderStatus
  message: string | null
  lastSampleAt: number | null
  failures: number
  resets: number
  invalid: number
  prev: unknown
}

const SAMPLE_TIMEOUT_MS = 3000
const key = (metric: string, deviceId: string): string => `${metric}\0${deviceId}`

/**
 * Samples lightweight OS counters on its own timer (never by rescanning the inventory), keeps a
 * bounded in-memory buffer for live charts and persists averaged samples in batches with bounded
 * retention. A failing provider only affects itself; pausing or failing re-baselines counters so a
 * rate is never computed across a gap.
 */
export class MetricsService {
  readonly repo: MetricRepo
  private states: ProviderState[]
  private series = new Map<string, Series>()
  private known = new Map<string, KnownSeries>()
  private resolveCache = new Map<string, { id: string | null; at: number }>()
  private timer: NodeJS.Timeout | null = null
  private running = false
  private paused = false
  private busy = false
  private lastFlushMono = 0
  private lastPruneMono = 0
  private pendingWrites = 0
  private clock: () => Date
  private mono: () => number
  private persistEveryMs: number
  private maxSeries: number

  constructor(private d: MetricsDeps) {
    this.repo = new MetricRepo(d.db)
    this.clock = d.clock ?? (() => new Date())
    this.mono = d.mono ?? (() => performance.now())
    this.persistEveryMs = d.persistEveryMs ?? 30_000
    this.maxSeries = d.maxSeries ?? 600
    this.states = d.providers
      .filter((p) => p.platforms.includes(d.platform))
      .map((provider) => ({ provider, supported: null, status: 'starting' as MetricProviderStatus, message: null, lastSampleAt: null, failures: 0, resets: 0, invalid: 0, prev: undefined }))
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  /** Starts sampling; resolves when the first tick (baseline) has completed. */
  start(): Promise<void> {
    const s = this.d.getSettings()
    if (!s.metricsEnabled || this.running) return Promise.resolve()
    this.running = true
    const since = new Date(this.clock().getTime() - s.metricsRetentionHours * 3_600_000).toISOString()
    for (const k of this.repo.known(since)) this.known.set(key(k.metric, k.deviceId), k)
    this.lastFlushMono = this.mono()
    this.schedule()
    return this.tick()
  }

  stop(): void {
    this.flush()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.running = false
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => void this.tick(), this.d.getSettings().metricsIntervalSec * 1000)
    this.timer.unref?.()
  }

  /** Apply changed settings (enabled flag, interval). */
  applySettings(): void {
    const s = this.d.getSettings()
    if (!s.metricsEnabled) {
      if (this.running) this.stop()
      return
    }
    if (!this.running) this.start()
    else if (!this.paused) this.schedule()
  }

  setPaused(p: boolean): void {
    if (p === this.paused) return
    this.paused = p
    if (p) {
      this.flush()
      if (this.timer) clearInterval(this.timer)
      this.timer = null
      for (const st of this.states) st.status = 'paused'
    } else {
      // Re-baseline: a rate across the pause would be meaningless.
      for (const st of this.states) { st.prev = undefined; st.status = 'starting' }
      if (this.running) { this.schedule(); void this.tick() }
    }
  }

  // ---- sampling -------------------------------------------------------------------------------

  async tick(): Promise<void> {
    if (this.busy || this.paused || !this.running) return
    this.busy = true
    try {
      const nowMs = this.clock().getTime()
      const mono = this.mono()
      for (const st of this.states) await this.runProvider(st, nowMs, mono)
      this.maybeFlush(mono)
    } finally {
      this.busy = false
    }
  }

  private async runProvider(st: ProviderState, nowMs: number, mono: number): Promise<void> {
    const ctx = this.d.makeContext(mono)
    try {
      if (st.supported === null) st.supported = await st.provider.isSupported(ctx)
      if (!st.supported) {
        st.status = 'unsupported'
        st.message = 'The required system interface is not present on this machine'
        return
      }
      let to: NodeJS.Timeout | undefined
      const timeout = new Promise<never>((_, rej) => { to = setTimeout(() => rej(new Error(`timed out after ${SAMPLE_TIMEOUT_MS}ms`)), SAMPLE_TIMEOUT_MS) })
      const out: ProviderOutput = await Promise.race([st.provider.sample(ctx, st.prev), timeout]).finally(() => clearTimeout(to))
      st.prev = out.next
      st.failures = 0
      st.resets += out.counterResets ?? 0
      st.status = out.status === 'ok' ? 'ok' : out.status
      st.message = out.message ?? null
      if (out.status !== 'unavailable') st.lastSampleAt = nowMs
      this.record(st, out.readings, nowMs)
    } catch (e) {
      // Isolate the failure and re-baseline so recovery never computes a rate across the gap.
      st.failures++
      st.status = 'error'
      st.message = (e as Error).message
      st.prev = undefined
    }
  }

  private resolve(ref: DeviceRef, nowMs: number): string | null {
    const k = 'key' in ref ? `k:${ref.key}` : `i:${ref.identifier.kind}:${ref.identifier.value}`
    const c = this.resolveCache.get(k)
    if (c && nowMs - c.at < (c.id ? 300_000 : 20_000)) return c.id
    let id: string | null
    if ('key' in ref) {
      id = this.repo.resolveKey(ref.key)
      if (!id) { const guess = deviceIdFromKey(ref.key); id = this.repo.devices([guess]).has(guess) ? guess : null }
    } else id = this.repo.resolveIdentifier(ref.identifier.kind, ref.identifier.value)
    this.resolveCache.set(k, { id, at: nowMs })
    return id
  }

  private record(st: ProviderState, readings: MetricReading[], nowMs: number): void {
    const cap = this.bufferCap()
    for (const r of readings) {
      if (!isValidReading(r.value, r.unit)) { st.invalid++; continue }
      const deviceId = this.resolve(r.ref, nowMs)
      if (!deviceId) continue // measurement of something not in the inventory: nothing to attach it to
      const k = key(r.metric, deviceId)
      let s = this.series.get(k)
      if (!s) {
        if (this.series.size >= this.maxSeries) { st.message = `series limit (${this.maxSeries}) reached; some readings are not recorded`; continue }
        s = { metric: r.metric, deviceId, unit: r.unit, source: r.source, points: [], lastAt: nowMs, lastValue: r.value, acc: { sum: 0, count: 0, lastT: nowMs } }
        this.series.set(k, s)
      }
      s.points.push({ t: nowMs, v: r.value })
      if (s.points.length > cap * 1.25) s.points.splice(0, s.points.length - cap)
      s.lastAt = nowMs
      s.lastValue = r.value
      s.unit = r.unit
      s.source = r.source
      s.acc.sum += r.value
      s.acc.count++
      s.acc.lastT = nowMs
      this.pendingWrites++
      this.known.set(k, { metric: r.metric, deviceId, unit: r.unit, source: r.source, lastAt: new Date(nowMs).toISOString() })
    }
  }

  private bufferCap(): number {
    return Math.min(3600, Math.max(120, Math.ceil(3600 / this.d.getSettings().metricsIntervalSec)))
  }

  // ---- persistence ----------------------------------------------------------------------------

  private maybeFlush(mono: number): void {
    if (mono - this.lastFlushMono >= this.persistEveryMs || this.pendingWrites >= 2000) this.flush(mono)
  }

  /** Persist one averaged sample per series for the elapsed window, then prune per retention. */
  flush(mono = this.mono()): void {
    const rows = []
    for (const s of this.series.values()) {
      if (!s.acc.count) continue
      rows.push({ deviceId: s.deviceId, metric: s.metric, value: s.acc.sum / s.acc.count, unit: s.unit, source: s.source, at: new Date(s.acc.lastT).toISOString() })
      s.acc = { sum: 0, count: 0, lastT: s.acc.lastT }
    }
    try {
      this.repo.insertBatch(rows)
    } catch (e) {
      console.error('metric flush failed', e)
    }
    this.pendingWrites = 0
    this.lastFlushMono = mono
    if (mono - this.lastPruneMono > 600_000 || this.lastPruneMono === 0) {
      this.lastPruneMono = mono
      const keepMs = this.d.getSettings().metricsRetentionHours * 3_600_000
      this.repo.prune(new Date(this.clock().getTime() - keepMs).toISOString())
    }
  }

  // ---- queries --------------------------------------------------------------------------------

  private staleAfterMs(): number {
    return Math.max(this.d.getSettings().metricsIntervalSec * 3000, 10_000)
  }

  status(): MetricsStatus {
    const s = this.d.getSettings()
    const now = this.clock().getTime()
    const stale = this.staleAfterMs()
    const ids = [...new Set([...this.known.values()].map((k) => k.deviceId))]
    const devs = this.repo.devices(ids)
    const series: MetricSeriesSummary[] = []
    for (const [k, kn] of this.known) {
      const live = this.series.get(k)
      const d = devs.get(kn.deviceId)
      if (!d) continue
      const lastAt = live?.lastAt ?? Date.parse(kn.lastAt)
      series.push({
        metric: kn.metric, deviceId: kn.deviceId, deviceName: d.name, deviceCategory: d.category as MetricSeriesSummary['deviceCategory'], unit: live?.unit ?? kn.unit, source: live?.source ?? kn.source,
        lastValue: live?.lastValue ?? null, lastAt: new Date(lastAt).toISOString(), stale: this.paused || !this.running || now - lastAt > stale
      })
    }
    const providers: MetricProviderInfo[] = this.states.map((st) => ({
      id: st.provider.id, title: st.provider.title, status: this.paused ? 'paused' : st.status, message: st.message,
      lastSampleAt: st.lastSampleAt ? new Date(st.lastSampleAt).toISOString() : null, consecutiveFailures: st.failures, counterResets: st.resets, invalidReadings: st.invalid,
      metrics: st.provider.metrics.map((m) => ({ ...m }))
    }))
    return {
      enabled: s.metricsEnabled, running: this.running, paused: this.paused, intervalSec: s.metricsIntervalSec, retentionHours: s.metricsRetentionHours,
      platformSupported: this.states.length > 0, providers, series: series.sort((a, b) => a.metric.localeCompare(b.metric) || a.deviceName.localeCompare(b.deviceName)),
      bufferedSamples: [...this.series.values()].reduce((n, x) => n + x.points.length, 0), pendingWrites: this.pendingWrites, storedSamples: this.repo.count()
    }
  }

  /** Windowed, downsampled series for charts. Merges persisted history with the live buffer. */
  query(selectors: { metric: string; deviceId: string }[], windowMs: number, maxPoints = 300): MetricSeriesData[] {
    const s = this.d.getSettings()
    const now = this.clock().getTime()
    const from = now - windowMs
    const rawInterval = s.metricsIntervalSec * 1000
    return selectors.map(({ metric, deviceId }) => {
      const k = key(metric, deviceId)
      const live = this.series.get(k)
      const kn = this.known.get(k)
      const mem = live ? live.points.filter((p) => p.t >= from) : []
      let pts = mem
      let usedDb = false
      const memStart = mem.length ? mem[0]!.t : now + 1
      if (!live || memStart > from + rawInterval * 2) {
        const older = this.repo.window(metric, deviceId, new Date(from).toISOString(), new Date(memStart).toISOString())
        if (older.length) { pts = [...older, ...mem]; usedDb = true }
      }
      const bucketMs = pts.length > maxPoints ? Math.ceil(windowMs / maxPoints) : 0
      if (bucketMs) pts = downsample(pts, from, bucketMs)
      const lastAt = live?.lastAt ?? (kn ? Date.parse(kn.lastAt) : null)
      return {
        metric, deviceId, unit: live?.unit ?? kn?.unit ?? '', source: live?.source ?? kn?.source ?? '', points: pts,
        lastAt: lastAt === null ? null : new Date(lastAt).toISOString(),
        stale: lastAt === null || this.paused || !this.running || now - lastAt > this.staleAfterMs(),
        intervalMs: Math.max(rawInterval, bucketMs, usedDb ? this.persistEveryMs : 0)
      }
    })
  }
}

/** Mean per time bucket; empty buckets are omitted so gaps stay gaps. */
export function downsample(points: { t: number; v: number }[], from: number, bucketMs: number): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = []
  let cur = -1
  let sum = 0
  let n = 0
  let tSum = 0
  const flush = (): void => { if (n) out.push({ t: Math.round(tSum / n), v: sum / n }) }
  for (const p of points) {
    const b = Math.floor((p.t - from) / bucketMs)
    if (b !== cur) { flush(); cur = b; sum = 0; n = 0; tSum = 0 }
    sum += p.v; tSum += p.t; n++
  }
  flush()
  return out
}
