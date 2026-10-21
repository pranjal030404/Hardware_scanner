import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../src/main/database/db'
import { InventoryRepo } from '../src/main/database/repositories'
import { dispatch, type Handlers } from '../src/main/ipc/dispatch'
import { MetricsService, downsample } from '../src/main/services/metrics'
import type { MetricProvider, MetricReading, ProviderOutput } from '../src/metrics/types'
import { SysReader } from '@collectors/core/sysreader'
import { IPC_CHANNELS } from '@shared/ipc'
import { SettingsSchema } from '@shared/schemas'
import { deviceIdFromKey } from '@collectors/core/normalize'
import { obs } from './helpers/factory'
import { tmpRoot } from './helpers/fixtures'

const T0 = Date.parse('2026-03-01T12:00:00.000Z')

/** A provider whose output the test scripts. */
function scripted(id: string, script: { next: () => Partial<ProviderOutput> | Error }): MetricProvider {
  return {
    id, title: id, platforms: ['linux'], metrics: [{ metric: 'm', unit: '%', description: 'd', source: 's' }],
    isSupported: async () => true,
    async sample(_c, prev) {
      const o = script.next()
      if (o instanceof Error) throw o
      return { readings: [], status: 'ok', next: prev, ...o }
    }
  }
}
const reading = (metric: string, value: number, unit = '%', key = 'dev:1'): MetricReading => ({ ref: { key }, metric, value, unit, source: 'src' })

function rig(providers: MetricProvider[], settings: Partial<ReturnType<typeof SettingsSchema.parse>> = {}, opts: { persistEveryMs?: number; devices?: string[]; maxSeries?: number } = {}) {
  const db = openDatabase(':memory:')
  const inv = new InventoryRepo(db)
  inv.ensureSystem('linux', '2026-01-01T00:00:00Z')
  for (const k of opts.devices ?? ['dev:1']) inv.upsert(deviceIdFromKey(k), obs(k, { category: 'cpu', name: k }), 'h', '2026-01-01T00:00:00Z')
  let now = T0
  let mono = 1000
  let s = SettingsSchema.parse(settings)
  const root = tmpRoot()
  const svc = new MetricsService({
    db, providers, platform: 'linux', getSettings: () => s, clock: () => new Date(now), mono: () => mono,
    makeContext: (m) => ({ reader: new SysReader(root), os: { cpus: () => [], totalmem: () => 0, freemem: () => 0 }, monoMs: m }),
    persistEveryMs: opts.persistEveryMs, maxSeries: opts.maxSeries
  })
  return {
    svc, db, id: deviceIdFromKey('dev:1'),
    advance: (ms: number) => { now += ms; mono += ms },
    setSettings: (x: Partial<typeof s>) => (s = { ...s, ...x })
  }
}

describe('MetricsService sampling', () => {
  it('records real readings, attaches them to inventory devices and exposes source/unit/freshness', async () => {
    let v = 10
    const r = rig([scripted('p', { next: () => ({ readings: [reading('cpu.utilization', (v += 5))] }) })])
    await r.svc.start()
    for (let i = 0; i < 3; i++) { r.advance(5000); await r.svc.tick() }
    const q = r.svc.query([{ metric: 'cpu.utilization', deviceId: r.id }], 60_000)[0]!
    expect(q.points.map((p) => p.v)).toEqual([15, 20, 25, 30])
    expect(q).toMatchObject({ unit: '%', source: 'src', stale: false, intervalMs: 5000 })
    const st = r.svc.status()
    expect(st.series[0]).toMatchObject({ metric: 'cpu.utilization', deviceName: 'dev:1', lastValue: 30, stale: false })
    expect(st.providers[0]).toMatchObject({ status: 'ok', consecutiveFailures: 0 })
    r.svc.stop()
  })

  it('drops invalid readings (NaN, out-of-range, negative rates) and counts them; never stores them', async () => {
    const r = rig([scripted('p', { next: () => ({ readings: [reading('a', NaN), reading('b', 250), reading('c', -4, 'B/s'), reading('d', 42)] }) })])
    await r.svc.start()
    expect(r.svc.status().series.map((s) => s.metric)).toEqual(['d'])
    expect(r.svc.status().providers[0]!.invalidReadings).toBe(3)
    r.svc.stop()
  })

  it('skips readings for devices that are not in the inventory (nothing to attach to)', async () => {
    const r = rig([scripted('p', { next: () => ({ readings: [reading('x', 1, '%', 'unknown:dev'), reading('y', 2)] }) })])
    await r.svc.start()
    expect(r.svc.status().series.map((s) => s.metric)).toEqual(['y'])
    r.svc.stop()
  })

  it('isolates a failing provider, reports it, re-baselines state, and recovers', async () => {
    let fail = false
    const states: unknown[] = []
    const bad: MetricProvider = { ...scripted('bad', { next: () => ({}) }), async sample(_c, prev) { states.push(prev); if (fail) throw new Error('read failed'); return { readings: [reading('bad.m', 1)], status: 'ok', next: 'baseline' } } }
    const good = scripted('good', { next: () => ({ readings: [reading('good.m', 2)] }) })
    const r = rig([bad, good])
    await r.svc.start()
    fail = true; r.advance(5000); await r.svc.tick(); r.advance(5000); await r.svc.tick()
    const st = r.svc.status()
    expect(st.providers.find((p) => p.id === 'bad')).toMatchObject({ status: 'error', message: 'read failed', consecutiveFailures: 2 })
    expect(st.providers.find((p) => p.id === 'good')).toMatchObject({ status: 'ok' })
    expect(r.svc.query([{ metric: 'good.m', deviceId: r.id }], 60_000)[0]!.points).toHaveLength(3) // unaffected
    fail = false; r.advance(5000); await r.svc.tick()
    expect(states[states.length - 1]).toBeUndefined() // recovery starts from a fresh baseline
    expect(r.svc.status().providers.find((p) => p.id === 'bad')).toMatchObject({ status: 'ok', consecutiveFailures: 0 })
    r.svc.stop()
  })

  it('marks unsupported providers instead of faking data', async () => {
    const p = { ...scripted('p', { next: () => ({}) }), isSupported: async () => false }
    const r = rig([p]); await r.svc.start()
    expect(r.svc.status().providers[0]).toMatchObject({ status: 'unsupported' }); expect(r.svc.status().series).toEqual([])
    r.svc.stop()
  })

  it('providers for other platforms are excluded; no providers means platformSupported=false', () => {
    const w = { ...scripted('w', { next: () => ({}) }), platforms: ['win32'] as NodeJS.Platform[] }
    expect(rig([w]).svc.status().platformSupported).toBe(false)
  })

  it('a hung provider times out without blocking the tick loop', async () => {
    vi.useFakeTimers()
    try {
      const hung: MetricProvider = { ...scripted('hung', { next: () => ({}) }), sample: () => new Promise(() => {}) }
      const r = rig([hung]); r.svc.start()
      const t = r.svc.tick(); await vi.advanceTimersByTimeAsync(3100); await t
      expect(r.svc.status().providers[0]).toMatchObject({ status: 'error', message: expect.stringMatching(/timed out/) })
      r.svc.stop()
    } finally { vi.useRealTimers() }
  })
})

describe('pause / resume / scheduling', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('samples on the configured interval, stops when paused (data shown stale) and re-baselines on resume', async () => {
    const prevs: unknown[] = []
    const p: MetricProvider = { ...scripted('p', { next: () => ({}) }), async sample(_c, prev) { prevs.push(prev); return { readings: [reading('m', 1)], status: 'ok', next: prevs.length } } }
    const r = rig([p], { metricsIntervalSec: 2 })
    r.svc.start(); await vi.advanceTimersByTimeAsync(0)
    expect(prevs).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2000); expect(prevs).toHaveLength(2)
    r.setSettings({ metricsIntervalSec: 10 }); r.svc.applySettings()
    await vi.advanceTimersByTimeAsync(9000); expect(prevs).toHaveLength(2) // new interval honoured
    await vi.advanceTimersByTimeAsync(1500); expect(prevs).toHaveLength(3)
    r.svc.setPaused(true)
    await vi.advanceTimersByTimeAsync(60_000); expect(prevs).toHaveLength(3)
    const st = r.svc.status()
    expect(st).toMatchObject({ paused: true }); expect(st.providers[0]!.status).toBe('paused'); expect(st.series[0]!.stale).toBe(true)
    r.advance(60_000)
    r.svc.setPaused(false); await vi.advanceTimersByTimeAsync(0)
    expect(prevs[prevs.length - 1]).toBeUndefined() // no delta across the pause
    r.svc.stop()
  })

  it('disabling in settings stops sampling', async () => {
    let n = 0
    const r = rig([scripted('p', { next: () => (n++, {}) })], { metricsIntervalSec: 1 })
    r.svc.start(); await vi.advanceTimersByTimeAsync(2100)
    const before = n
    r.setSettings({ metricsEnabled: false }); r.svc.applySettings()
    await vi.advanceTimersByTimeAsync(5000); expect(n).toBe(before)
    expect(r.svc.status().running).toBe(false)
  })
})

describe('staleness', () => {
  it('a series with no recent measurement is stale, never "healthy"', async () => {
    const r = rig([scripted('p', { next: () => ({ readings: [reading('m', 1)] }) })], { metricsIntervalSec: 5 })
    await r.svc.start()
    expect(r.svc.status().series[0]!.stale).toBe(false)
    r.advance(14_000); expect(r.svc.status().series[0]!.stale).toBe(false) // within 3 intervals
    r.advance(2000); expect(r.svc.status().series[0]!.stale).toBe(true)
    expect(r.svc.query([{ metric: 'm', deviceId: r.id }], 60_000)[0]!.stale).toBe(true)
    expect(r.svc.query([{ metric: 'nothing', deviceId: r.id }], 60_000)[0]).toMatchObject({ points: [], lastAt: null, stale: true })
    r.svc.stop()
  })
})

describe('persistence, batching and retention', () => {
  it('batches writes: nothing is written per tick; one averaged sample per series per flush window', async () => {
    let v = 0
    const r = rig([scripted('p', { next: () => ({ readings: [reading('m', (v += 10))] }) })], {}, { persistEveryMs: 30_000 })
    await r.svc.start()
    for (let i = 0; i < 4; i++) { r.advance(5000); await r.svc.tick() }
    expect(r.svc.status()).toMatchObject({ storedSamples: 0, pendingWrites: 5 }) // 5 readings buffered, none written yet
    r.advance(10_000); await r.svc.tick() // crosses the persist window → one flush
    expect(r.svc.status().storedSamples).toBe(1)
    const row = r.db.prepare('SELECT value, unit, source FROM metric_samples').get() as { value: number; unit: string; source: string }
    expect(row).toMatchObject({ value: 35, unit: '%', source: 'src' }) // mean of 10..60
    r.svc.stop()
  })

  it('stop() flushes buffered samples', async () => {
    const r = rig([scripted('p', { next: () => ({ readings: [reading('m', 7)] }) })])
    await r.svc.start(); r.svc.stop()
    expect(r.svc.repo.count()).toBe(1)
  })

  it('retention prunes samples older than the configured window', async () => {
    const r = rig([scripted('p', { next: () => ({ readings: [reading('m', 1)] }) })], { metricsRetentionHours: 1 }, { persistEveryMs: 1 })
    r.svc.repo.insertBatch([
      { deviceId: r.id, metric: 'm', value: 1, unit: '%', source: 's', at: new Date(T0 - 3 * 3_600_000).toISOString() },
      { deviceId: r.id, metric: 'm', value: 2, unit: '%', source: 's', at: new Date(T0 - 30 * 60_000).toISOString() }
    ])
    await r.svc.start(); r.advance(5000); await r.svc.tick()
    const times = (r.db.prepare('SELECT at FROM metric_samples ORDER BY at').all() as { at: string }[]).map((x) => Date.parse(x.at))
    expect(times.every((t) => t >= T0 - 3_600_000)).toBe(true)
    expect(times.length).toBeGreaterThanOrEqual(2)
    r.svc.stop()
  })

  it('memory is bounded: the live buffer never exceeds its cap and series count is capped', async () => {
    const r = rig([scripted('p', { next: () => ({ readings: [reading('m', 1)] }) })], { metricsIntervalSec: 60 }, { persistEveryMs: 1e12 })
    r.svc.start()
    for (let i = 0; i < 400; i++) { await r.svc.tick(); r.advance(60_000) }
    expect(r.svc.status().bufferedSamples).toBeLessThanOrEqual(Math.ceil(120 * 1.25) + 1) // cap=120 at 60s interval
    const many = rig([scripted('p', { next: () => ({ readings: Array.from({ length: 50 }, (_, i) => reading(`m${i}`, 1)) }) })], {}, { maxSeries: 10 })
    await many.svc.start()
    expect(many.svc.status().series).toHaveLength(10)
    expect(many.svc.status().providers[0]!.message).toMatch(/series limit/)
    r.svc.stop(); many.svc.stop()
  })

  it('history survives a restart: persisted series are listed (stale) and queryable', async () => {
    const r = rig([scripted('p', { next: () => ({ readings: [reading('m', 5)] }) })])
    await r.svc.start(); r.svc.stop()
    r.advance(120_000)
    const svc2 = new MetricsService({ db: r.db, providers: [], platform: 'linux', getSettings: () => SettingsSchema.parse({}), clock: () => new Date(T0 + 120_000), makeContext: () => { throw new Error('unused') } })
    svc2.start()
    expect(svc2.status().series[0]).toMatchObject({ metric: 'm', lastValue: null, stale: true })
    expect(svc2.query([{ metric: 'm', deviceId: r.id }], 600_000)[0]!.points.map((p) => p.v)).toEqual([5])
    svc2.stop()
  })
})

describe('query / downsample / scale', () => {
  it('downsample averages per bucket and keeps gaps as gaps', () => {
    const pts = [{ t: 0, v: 1 }, { t: 1000, v: 3 }, { t: 2000, v: 5 }, { t: 90_000, v: 10 }]
    const d = downsample(pts, 0, 10_000)
    expect(d).toEqual([{ t: 1000, v: 3 }, { t: 90_000, v: 10 }])
  })
  it('merges persisted history with the live buffer without duplicating', async () => {
    const r = rig([scripted('p', { next: () => ({ readings: [reading('m', 9)] }) })])
    r.svc.repo.insertBatch([{ deviceId: r.id, metric: 'm', value: 1, unit: '%', source: 's', at: new Date(T0 - 600_000).toISOString() }, { deviceId: r.id, metric: 'm', value: 2, unit: '%', source: 's', at: new Date(T0 - 300_000).toISOString() }])
    await r.svc.start()
    const q = r.svc.query([{ metric: 'm', deviceId: r.id }], 900_000)[0]!
    expect(q.points.map((p) => p.v)).toEqual([1, 2, 9])
    expect(q.intervalMs).toBe(30_000) // persisted history is coarser than live samples: gaps are judged against it
    r.svc.stop()
  })
  it('stays fast and bounded with a very large number of samples', () => {
    const r = rig([])
    const rows = Array.from({ length: 150_000 }, (_, i) => ({ deviceId: r.id, metric: `m${i % 50}`, value: i % 100, unit: '%', source: 's', at: new Date(T0 - (i % 3000) * 1000).toISOString() }))
    const t0 = performance.now(); r.svc.repo.insertBatch(rows); const insert = performance.now() - t0
    r.svc.start()
    const t1 = performance.now()
    const out = r.svc.query([{ metric: 'm0', deviceId: r.id }], 3_600_000, 200)
    const status = r.svc.status()
    const q = performance.now() - t1
    console.log(`150k samples: insert ${insert.toFixed(0)}ms, query+status ${q.toFixed(0)}ms`)
    expect(out[0]!.points.length).toBeLessThanOrEqual(200)
    expect(status.storedSamples).toBe(150_000)
    expect(q).toBeLessThan(1500); expect(insert).toBeLessThan(8000)
    r.svc.stop()
  }, 60_000)
})

describe('metrics IPC validation', () => {
  const origins = { appUrlPrefix: 'file:///app/out/renderer' }
  const url = 'file:///app/out/renderer/index.html'
  const handlers = Object.fromEntries(IPC_CHANNELS.map((c) => [c, async (i: unknown) => i])) as unknown as Handlers
  it('rejects malformed queries', async () => {
    const ok = { series: [{ metric: 'cpu.utilization', deviceId: 'abc' }], windowSec: 300 }
    await expect(dispatch('metrics:query', ok, url, handlers, origins)).resolves.toMatchObject({ windowSec: 300 })
    const bad: unknown[] = [
      {}, { ...ok, windowSec: 1 }, { ...ok, windowSec: 99_999_999 }, { ...ok, windowSec: 1.5 }, { ...ok, series: [] }, { ...ok, series: Array.from({ length: 41 }, () => ok.series[0]) },
      { ...ok, series: [{ metric: '', deviceId: 'a' }] }, { ...ok, series: [{ metric: 'm', deviceId: 'a', sql: 'x' }] }, { ...ok, maxPoints: 5 }, { ...ok, maxPoints: 99999 }, { ...ok, extra: 1 }
    ]
    for (const p of bad) await expect(dispatch('metrics:query', p, url, handlers, origins), JSON.stringify(p)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' })
    await expect(dispatch('metrics:setPaused', { paused: 'x' }, url, handlers, origins)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' })
    await expect(dispatch('metrics:status', 1, url, handlers, origins)).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' })
  })
})
