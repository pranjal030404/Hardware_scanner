import { describe, expect, it } from 'vitest'
import { cpuPressure, eccErrors, pciAerErrors, pciLinkWidth, usbReconnect, nvmeState, memoryPressure, sustainedStats, swapThrash, thermalThrottle } from '../src/diagnostics/rules-hardware'
import { DIAGNOSTIC_RULES } from '../src/diagnostics/rules'
import type { MetricWindow, RuleContext } from '../src/diagnostics/types'
import { SettingsSchema } from '../src/shared/schemas'
import type { StoredDevice } from '../src/shared/stored'

const NOW = Date.parse('2026-10-21T12:00:00Z')
const MIN = 60_000
const settings = SettingsSchema.parse({})

const series = (metric: string, vals: number[], opts: { everyMs?: number; stale?: boolean; deviceId?: string } = {}): MetricWindow => {
  const every = opts.everyMs ?? 30_000
  return { deviceId: opts.deviceId ?? 'dev1', deviceName: 'Test device', metric, unit: '%', source: 'fixture', stale: opts.stale ?? false, points: vals.map((v, i) => ({ t: NOW - (vals.length - 1 - i) * every, v })) }
}
const ctx = (windows: MetricWindow[], over: Partial<RuleContext> = {}): RuleContext => ({
  now: new Date(NOW), settings, devices: [], collectors: [], monitor: null, lastInventoryScanAt: null, recentEvents: [], freshMs: 120_000, staleMs: 300_000,
  metrics: { enabled: true, running: true, paused: false, intervalSec: 5, retentionHours: 24, platformSupported: true, providers: [], series: [], bufferedSamples: 0, pendingWrites: 0, storedSamples: 0 },
  metricWindow: (metric) => windows.filter((w) => w.metric === metric),
  ...over
})
const flat = (n: number, v: number) => Array.from({ length: n }, () => v)

describe('sustainedStats', () => {
  it('needs enough samples and reports coverage, fraction and median', () => {
    expect(sustainedStats([{ t: 0, v: 1 }], 10)).toBeUndefined()
    const st = sustainedStats(flat(10, 30).map((v, i) => ({ t: i * 1000, v })), 25)!
    expect(st).toMatchObject({ n: 10, coverageMs: 9000, fractionAbove: 1, median: 30, max: 30 })
  })
})

describe('cpu.pressure', () => {
  const m = 'pressure.cpu_some_avg10'
  it('fires only on sustained pressure across the window, with evidence, severity by magnitude and verification steps', () => {
    const r = cpuPressure.evaluate(ctx([series(m, flat(10, 30))])) // 10 samples × 30 s = 4.5 min ≥ 80 % of 5 min
    expect(r.status).toBe('evaluated')
    if (r.status !== 'evaluated') return
    expect(r.findings).toHaveLength(1)
    const f = r.findings[0]!
    expect(f.severity).toBe('low')
    expect(f.evidence.length).toBeGreaterThanOrEqual(3)
    expect(f.evidence[0]).toMatchObject({ type: 'metric_sample', key: m, source: 'fixture' })
    expect(f.recommendation).toMatch(/Verify:.*\/proc\/pressure\/cpu/)
    const hi = cpuPressure.evaluate(ctx([series(m, flat(10, 70))]))
    expect(hi.status === 'evaluated' && hi.findings[0]!.severity).toBe('medium')
  })
  it('does not fire on a single spike, a short window of data, or a stale series', () => {
    const spike = flat(10, 2); spike[9] = 99
    for (const c of [ctx([series(m, spike)]), ctx([series(m, flat(10, 90), { everyMs: 5000 })]), ctx([series(m, flat(10, 90), { stale: true })])]) {
      const r = cpuPressure.evaluate(c)
      expect(r.status === 'evaluated' && r.findings).toEqual([])
    }
  })
  it('stale or short data retains an existing finding instead of resolving it; hysteresis keeps near-threshold findings open', () => {
    const stale = cpuPressure.evaluate(ctx([series(m, flat(10, 90), { stale: true })]))
    expect(stale.status === 'evaluated' && stale.retain).toEqual(['device:dev1'])
    const near = cpuPressure.evaluate(ctx([series(m, flat(10, 21))])) // below 25 but ≥ 80 % of it
    expect(near.status === 'evaluated' && near.findings).toEqual([])
    expect(near.status === 'evaluated' && near.retain).toEqual(['device:dev1'])
    const low = cpuPressure.evaluate(ctx([series(m, flat(10, 3))]))
    expect(low.status === 'evaluated' && low.retain).toEqual([])
  })
  it('respects the configurable threshold', () => {
    const strict = ctx([series(m, flat(10, 12))], { settings: SettingsSchema.parse({ diagPressureWarnPercent: 10 }) })
    const r = cpuPressure.evaluate(strict)
    expect(r.status === 'evaluated' && r.findings).toHaveLength(1)
  })
  it('reports insufficient data (not "healthy") without PSI series, a sampler, or while sampling is off', () => {
    expect(cpuPressure.evaluate(ctx([])).status).toBe('insufficient_data')
    expect(cpuPressure.evaluate(ctx([], { metricWindow: undefined })).status).toBe('insufficient_data')
    expect(cpuPressure.evaluate(ctx([series(m, flat(10, 90))], { metrics: { ...ctx([]).metrics!, running: false } })).status).toBe('insufficient_data')
  })
})

describe('memory.pressure and memory.swap_thrash', () => {
  it('memory pressure uses its own series; swap thrash uses the swap-in rate with its own unit and threshold', () => {
    const a = memoryPressure.evaluate(ctx([series('pressure.memory_some_avg10', flat(10, 40))]))
    expect(a.status === 'evaluated' && a.findings[0]!.title).toMatch(/memory pressure/)
    const t = { ...series('memory.swap_in_rate', flat(10, 500)), unit: 'pages/s' }
    const b = swapThrash.evaluate(ctx([t]))
    expect(b.status === 'evaluated' && b.findings).toHaveLength(1)
    const idle = swapThrash.evaluate(ctx([{ ...t, points: t.points.map((p) => ({ ...p, v: 0 })) }]))
    expect(idle.status === 'evaluated' && idle.findings).toEqual([]) // occupied-but-idle swap is not thrashing
  })
})

describe('cpu.thermal_throttle', () => {
  const m = 'cpu.thermal_throttle_events'
  const counter = (vals: number[]) => ({ ...series(m, vals, { everyMs: 60_000 }), unit: 'count' })
  it('a constant non-zero counter is NOT a finding', () => {
    const r = thermalThrottle.evaluate(ctx([counter(flat(10, 4200))]))
    expect(r.status === 'evaluated' && r.findings).toEqual([])
  })
  it('an increase inside the window is, with before/after evidence; repeated increases escalate', () => {
    const one = thermalThrottle.evaluate(ctx([counter([10, 10, 10, 15, 15, 15])]))
    expect(one.status === 'evaluated' && one.findings[0]).toMatchObject({ severity: 'low', evidence: [{ value: 10 }, { value: 15 }] })
    const many = thermalThrottle.evaluate(ctx([counter([1, 2, 2, 5, 6, 6, 9])]))
    expect(many.status === 'evaluated' && many.findings[0]!.severity).toBe('medium')
  })
  it('a counter reset (reboot) is discarded, never counted as negative or positive throttling', () => {
    const r = thermalThrottle.evaluate(ctx([counter([500, 500, 2, 2, 2])]))
    expect(r.status === 'evaluated' && r.findings).toEqual([])
  })
  it('says insufficient data when the counters are not exposed', () => {
    expect(thermalThrottle.evaluate(ctx([])).status).toBe('insufficient_data')
  })
})

describe('memory.ecc_errors', () => {
  const dev = (props: Record<string, number>, observedAt = new Date(NOW - 10_000).toISOString()): StoredDevice =>
    ({ id: 'mem1', key: 'memory:system', category: 'memory', name: 'System memory', presence: 'present', properties: Object.entries(props).map(([key, value]) => ({ key, value, source: 'linux.memory', sourceProperty: 'edac', evidence: 'measured', observedAt })) }) as unknown as StoredDevice
  it('is silent with zero counts, high for uncorrectable, medium for correctable', () => {
    const none = eccErrors.evaluate(ctx([], { devices: [dev({ ecc_correctable_errors: 0, ecc_uncorrectable_errors: 0 })] }))
    expect(none.status === 'evaluated' && none.findings).toEqual([])
    const ce = eccErrors.evaluate(ctx([], { devices: [dev({ ecc_correctable_errors: 3, ecc_uncorrectable_errors: 0 })] }))
    expect(ce.status === 'evaluated' && ce.findings[0]!.severity).toBe('medium')
    const ue = eccErrors.evaluate(ctx([], { devices: [dev({ ecc_correctable_errors: 3, ecc_uncorrectable_errors: 1 })] }))
    expect(ue.status === 'evaluated' && ue.findings[0]).toMatchObject({ severity: 'high', evidence: expect.arrayContaining([expect.objectContaining({ key: 'ecc_uncorrectable_errors', value: 1 })]) })
  })
  it('without EDAC counters it has no data — never "no errors" — and stale counters are not trusted', () => {
    expect(eccErrors.evaluate(ctx([], { devices: [dev({ total_bytes: 1 })] })).status).toBe('insufficient_data')
    expect(eccErrors.evaluate(ctx([])).status).toBe('insufficient_data')
    expect(eccErrors.evaluate(ctx([], { devices: [dev({ ecc_correctable_errors: 9 }, new Date(NOW - 3_600_000).toISOString())] })).status).toBe('insufficient_data')
  })
})

describe('rule registry', () => {
  it('registers the new rules with unique ids, versions, descriptions and severity policies', () => {
    const ids = DIAGNOSTIC_RULES.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ['cpu.pressure', 'memory.pressure', 'io.pressure', 'memory.swap_thrash', 'cpu.thermal_throttle', 'memory.ecc_errors']) {
      const r = DIAGNOSTIC_RULES.find((x) => x.id === id)!
      expect(r.version).toBeGreaterThanOrEqual(1)
      expect(r.description.length).toBeGreaterThan(40)
      expect(r.severityPolicy.length).toBeGreaterThan(10)
      expect(r.dataUsed.length).toBeGreaterThan(10)
    }
  })
})

describe('pci rules', () => {
  const pci = (props: Record<string, number>, observedAt = new Date(NOW - 10_000).toISOString()): StoredDevice =>
    ({ id: 'p1', key: 'pci:0000:55:00.0', category: 'pci', name: 'NVMe SSD', presence: 'present', properties: Object.entries(props).map(([key, value]) => ({ key, value, source: 'linux.pci', sourceProperty: 'sysfs', evidence: 'os_reported', observedAt })) }) as unknown as StoredDevice
  const out = (r: ReturnType<typeof pciAerErrors.evaluate>) => (r.status === 'evaluated' ? r.findings : [])

  it('aer: silent for zero and small correctable counts, graded by class otherwise, never from missing counters', () => {
    expect(out(pciAerErrors.evaluate(ctx([], { devices: [pci({ aer_fatal_errors: 0, aer_nonfatal_errors: 0, aer_correctable_errors: 12 })] })))).toHaveLength(0)
    expect(out(pciAerErrors.evaluate(ctx([], { devices: [pci({ aer_correctable_errors: 500 })] })))[0]).toMatchObject({ severity: 'low' })
    expect(out(pciAerErrors.evaluate(ctx([], { devices: [pci({ aer_nonfatal_errors: 1 })] })))[0]).toMatchObject({ severity: 'medium' })
    const f = out(pciAerErrors.evaluate(ctx([], { devices: [pci({ aer_fatal_errors: 2, aer_correctable_errors: 1 })] })))[0]!
    expect(f.severity).toBe('high')
    expect(f.evidence.map((e) => e.key)).toContain('aer_fatal_errors')
    expect(pciAerErrors.evaluate(ctx([], { devices: [pci({ link_width: 4 })] })).status).toBe('insufficient_data')
    expect(pciAerErrors.evaluate(ctx([], { devices: [pci({ aer_fatal_errors: 2 }, new Date(NOW - 3600_000).toISOString())] })).status).toBe('insufficient_data')
  })
  it('link width: flags only a width below both the device and upstream capability', () => {
    const w = (cur: number, own: number, up: number) => out(pciLinkWidth.evaluate(ctx([], { devices: [pci({ link_width: cur, max_link_width: own, upstream_max_link_width: up })] })))
    expect(w(4, 4, 4)).toHaveLength(0)
    expect(w(2, 4, 2)).toHaveLength(0) // upstream port only offers x2: not a degradation
    expect(w(1, 4, 4)[0]).toMatchObject({ severity: 'low', title: expect.stringContaining('x1') })
    expect(w(0, 4, 4)).toHaveLength(0) // unknown/invalid width is not evidence
  })
  it('link width: no data without an upstream capability, and speed is never judged', () => {
    expect(pciLinkWidth.evaluate(ctx([], { devices: [pci({ link_width: 1, max_link_width: 4 })] })).status).toBe('insufficient_data')
    expect(pciLinkWidth.description).toMatch(/speed is not compared/i)
  })
})

describe('usb.reconnect and storage.nvme_state', () => {
  const ev = (minAgo: number, id = 'u1', type = 'device.disconnected', category = 'usb') => ({ type, at: new Date(NOW - minAgo * MIN).toISOString(), deviceId: id, deviceName: 'Hub', category, collectorId: null, summary: 's', data: {} }) as never
  const mon = { state: 'active' } as never
  it('usb: needs repeated disconnects of the same device inside the window', () => {
    const r = (events: unknown[]) => usbReconnect.evaluate(ctx([], { monitor: mon, recentEvents: events as never }))
    expect((r([ev(1), ev(2)]) as { findings: unknown[] }).findings).toHaveLength(0)
    const three = r([ev(1), ev(5), ev(9), ev(3, 'other')]) as { findings: { severity: string; evidence: unknown[] }[] }
    expect(three.findings).toHaveLength(1)
    expect(three.findings[0]).toMatchObject({ severity: 'low' })
    expect(three.findings[0]!.evidence).toHaveLength(3)
    expect((r([ev(1), ev(2), ev(3), ev(4), ev(5), ev(6)]) as { findings: { severity: string }[] }).findings[0]!.severity).toBe('medium')
    expect((r([ev(40), ev(41), ev(42)]) as { findings: unknown[] }).findings).toHaveLength(0) // outside window
    expect((r([ev(1, 'u1', 'device.connected'), ev(2, 'u1', 'device.connected'), ev(3, 'u1', 'device.connected')]) as { findings: unknown[] }).findings).toHaveLength(0)
    expect(usbReconnect.evaluate(ctx([], { monitor: null })).status).toBe('insufficient_data')
  })
  const nv = (state: string, observedAt = new Date(NOW - 5000).toISOString()): StoredDevice =>
    ({ id: 's1', key: 'storage:x', category: 'storage', name: 'NVMe', presence: 'present', properties: [{ key: 'nvme_state', value: state, source: 'linux.storage', sourceProperty: 'state', evidence: 'os_reported', observedAt }] }) as unknown as StoredDevice
  it('nvme: silent when live or stale, graded otherwise, no data when never collected', () => {
    const f = (d: StoredDevice) => (nvmeState.evaluate(ctx([], { devices: [d] })) as { findings: { severity: string }[] }).findings
    expect(f(nv('live'))).toHaveLength(0)
    expect(f(nv('resetting'))[0]).toMatchObject({ severity: 'low' })
    expect(f(nv('dead'))[0]).toMatchObject({ severity: 'high' })
    expect(f(nv('dead', new Date(NOW - 3600_000).toISOString()))).toHaveLength(0)
    expect(nvmeState.evaluate(ctx([])).status).toBe('insufficient_data')
  })
})
