import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { DIAGNOSTIC_RULES } from '../src/diagnostics/rules'
import type { DiagnosticRule, RuleContext } from '../src/diagnostics/types'
import { listMigrations, migrate, openDatabase } from '../src/main/database/db'
import { MIGRATIONS } from '../src/main/database/migrations'
import { DiagnosticsRepo, EventRepo, InventoryRepo } from '../src/main/database/repositories'
import { dispatch, type Handlers } from '../src/main/ipc/dispatch'
import { DiagnosticsService, findingId } from '../src/main/services/diagnostics'
import { EventBus } from '../src/main/services/event-bus'
import { InventoryService } from '../src/main/services/inventory'
import { IPC_CHANNELS } from '@shared/ipc'
import { SettingsSchema, type CollectorHealth, type DeviceObservation, type HipEvent, type MonitorStatus, type Property, type Severity } from '@shared/schemas'
import type { StoredDevice } from '@shared/stored'
import { complete, fakeCollector, obs, type FakeState } from './helpers/factory'
import { ctxFor, tmpRoot } from './helpers/fixtures'

const NOW = new Date('2026-03-01T12:00:00.000Z')
const iso = (msAgo: number): string => new Date(NOW.getTime() - msAgo).toISOString()
const rule = (id: string): DiagnosticRule => DIAGNOSTIC_RULES.find((r) => r.id === id)!

const P = (key: string, value: string | number | boolean, over: Partial<Property> = {}): Property => ({ key, value, source: 'linux.x', sourceProperty: 'p', evidence: 'measured', observedAt: iso(10_000), ...over })
let n = 0
const dev = (over: Partial<StoredDevice> = {}, props: Property[] = []): StoredDevice => ({
  id: `dev${++n}`, key: `k${n}`, category: 'storage', subtype: null, name: `Device ${n}`, manufacturer: null, model: null, description: null, vendorId: null, productId: null,
  busType: null, deviceClass: null, driver: null, status: 'ok', presence: 'present', firstSeen: iso(1e9), lastSeen: iso(10_000), lastScanned: iso(10_000), source: 'linux.x',
  identifiers: [], properties: props, relationships: [], fieldSources: {}, ...over
})
const health = (id: string, over: Partial<CollectorHealth> = {}): CollectorHealth => ({
  id, version: '1', platforms: ['linux'], categories: ['storage'], permissions: [], method: 'm', status: 'available', partial: false, message: null,
  lastRunAt: iso(10_000), lastSuccessAt: iso(10_000), durationMs: 5, deviceCount: 1, limitations: [], ...over
})
const monitor = (over: Partial<MonitorStatus> = {}): MonitorStatus => ({ mode: 'udev', degraded: false, message: null, intervalSec: 60, lastScanAt: iso(10_000), scanning: false, ...over })
const ctx = (over: Partial<RuleContext> = {}): RuleContext => ({
  now: NOW, settings: SettingsSchema.parse({}), devices: [], collectors: [], monitor: monitor(), lastInventoryScanAt: iso(10_000), recentEvents: [], freshMs: 180_000, staleMs: 300_000, ...over
})
const evalOk = (id: string, c: RuleContext) => {
  const r = rule(id).evaluate(c)
  if (r.status !== 'evaluated') throw new Error(`expected evaluated, got ${r.reason}`)
  return r
}

describe('rule: collector.health', () => {
  it('maps collector states to calibrated severities with evidence', () => {
    const r = evalOk('collector.health', ctx({
      collectors: [
        health('a', { status: 'error', message: 'boom' }), health('b', { status: 'permission_required', limitations: [{ kind: 'permission', message: 'denied', remedy: 'do X' }] }),
        health('c', { status: 'unavailable', message: 'no tool' }), health('d', { partial: true, limitations: [{ kind: 'permission', message: 'some denied' }] }),
        health('e'), health('f', { status: 'unsupported' }), health('g', { status: 'not_scanned', lastRunAt: null })
      ]
    }))
    const by = Object.fromEntries(r.findings.map((f) => [f.subject, f]))
    expect(Object.keys(by).sort()).toEqual(['collector:a', 'collector:b', 'collector:c', 'collector:d'])
    expect([by['collector:a']!.severity, by['collector:b']!.severity, by['collector:c']!.severity, by['collector:d']!.severity]).toEqual(['medium', 'low', 'info', 'info'])
    expect(by['collector:a']!.description).toMatch(/NOT treated as removed/)
    expect(by['collector:b']!.recommendation).toBe('do X')
    for (const f of r.findings) expect(f.evidence[0]).toMatchObject({ type: 'collector_run' })
  })
  it('has insufficient data before any collector ran', () => {
    expect(rule('collector.health').evaluate(ctx({ collectors: [health('g', { status: 'not_scanned', lastRunAt: null })] })).status).toBe('insufficient_data')
  })
})

describe('rule: inventory.stale + monitoring.state', () => {
  it('flags a stale inventory, with lower severity if the user paused monitoring', () => {
    expect(evalOk('inventory.stale', ctx({ lastInventoryScanAt: iso(10_000) })).findings).toHaveLength(0)
    expect(evalOk('inventory.stale', ctx({ lastInventoryScanAt: iso(900_000) })).findings[0]).toMatchObject({ severity: 'medium', subject: 'inventory' })
    expect(evalOk('inventory.stale', ctx({ lastInventoryScanAt: iso(900_000), monitor: monitor({ mode: 'paused' }) })).findings[0]!.severity).toBe('info')
    expect(rule('inventory.stale').evaluate(ctx({ lastInventoryScanAt: null })).status).toBe('insufficient_data')
    expect(evalOk('inventory.stale', ctx({ collectors: [health('x', { status: 'stale' })] })).findings[0]!.subject).toBe('collector-stale:x')
  })
  it('reports paused and degraded monitoring separately', () => {
    expect(evalOk('monitoring.state', ctx({ monitor: monitor({ mode: 'paused' }) })).findings[0]).toMatchObject({ subject: 'monitor:paused', severity: 'info' })
    expect(evalOk('monitoring.state', ctx({ monitor: monitor({ mode: 'polling', degraded: true, message: 'no udev' }) })).findings[0]).toMatchObject({ subject: 'monitor:degraded', severity: 'low' })
    expect(evalOk('monitoring.state', ctx()).findings).toHaveLength(0)
    expect(rule('monitoring.state').evaluate(ctx({ monitor: null })).status).toBe('insufficient_data')
  })
})

describe('rule: device.os_error', () => {
  it('reports authoritative OS error state only from a fresh, healthy collector', () => {
    const bad = dev({ category: 'usb', status: 'error', source: 'windows.pnp', fieldSources: { status: { source: 'windows.pnp', sourceProperty: 'Problem', evidence: 'os_reported' } } }, [P('problem_code', 'CM_PROB_FAILED_START', { source: 'windows.pnp' })])
    const r = evalOk('device.os_error', ctx({ devices: [bad, dev({ status: 'ok' })], collectors: [health('windows.pnp'), health('linux.x')] }))
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatchObject({ severity: 'medium', confidence: 0.9, deviceIds: [bad.id] })
    expect(r.findings[0]!.evidence.map((e) => e.key)).toEqual(['status', 'problem_code'])
    expect(r.findings[0]!.description).toMatch(/comes from the OS/)
  })
  it('retains (does not resolve) when the owning collector is failing or stale', () => {
    const bad = dev({ status: 'error', source: 'windows.pnp' })
    const r = evalOk('device.os_error', ctx({ devices: [bad], collectors: [health('windows.pnp', { status: 'error' })] }))
    expect(r.findings).toHaveLength(0)
    expect(r.status === 'evaluated' && r.retain).toEqual([`device:${bad.id}`])
  })
  it('never treats a missing device as an error', () => {
    expect(evalOk('device.os_error', ctx({ devices: [dev({ presence: 'missing', status: 'ok' })], collectors: [health('linux.x')] })).findings).toHaveLength(0)
  })
})

describe('rule: storage.space', () => {
  const part = (usedPct: number, over: Partial<StoredDevice> = {}, fs = 'ext4', total = 100 * 2 ** 30) =>
    dev({ subtype: 'partition', source: 'linux.storage', ...over }, [P('mount_point', '/data'), P('filesystem', fs), P('filesystem_total_bytes', total), P('free_bytes', total * (1 - usedPct / 100), { unit: 'B' })])
  const c = (d: StoredDevice[], extra: Partial<RuleContext> = {}) => ctx({ devices: d, collectors: [health('linux.storage')], ...extra })
  it('uses configurable thresholds: medium at warning, high at critical, nothing below', () => {
    expect(evalOk('storage.space', c([part(70)])).findings).toHaveLength(0)
    expect(evalOk('storage.space', c([part(88)])).findings[0]).toMatchObject({ severity: 'medium' })
    expect(evalOk('storage.space', c([part(97)])).findings[0]).toMatchObject({ severity: 'high' })
    const custom = SettingsSchema.parse({ diagDiskWarnPercent: 60, diagDiskCriticalPercent: 80 })
    expect(evalOk('storage.space', c([part(70)], { settings: custom })).findings[0]!.severity).toBe('medium')
    expect(evalOk('storage.space', c([part(85)], { settings: custom })).findings[0]!.severity).toBe('high')
  })
  it('records evidence of the real values and the threshold used', () => {
    const f = evalOk('storage.space', c([part(90)])).findings[0]!
    expect(f.evidence.map((e) => e.key ?? e.ref)).toEqual(['free_bytes', 'filesystem_total_bytes', 'diagDiskWarnPercent'])
    expect(f.title).toBe('/data is 90% full')
  })
  it('ignores read-only image filesystems and tiny volumes', () => {
    expect(evalOk('storage.space', c([part(100, {}, 'squashfs'), part(99, {}, 'vfat', 10 * 2 ** 20)])).findings).toHaveLength(0)
  })
  it('needs fresh data: stale storage collector → insufficient; stale value → retained, not resolved', () => {
    expect(rule('storage.space').evaluate(ctx({ devices: [part(99)], collectors: [health('linux.storage', { lastSuccessAt: iso(3_600_000) })] })).status).toBe('insufficient_data')
    const old = part(99)
    old.properties = old.properties.map((p) => ({ ...p, observedAt: iso(3_600_000) }))
    const r = evalOk('storage.space', c([old]))
    expect(r.findings).toHaveLength(0)
    expect(r.status === 'evaluated' && r.retain).toEqual([`device:${old.id}`])
  })
})

describe('rule: storage.smart', () => {
  const disk = (props: Property[]) => dev({ source: 'linux.storage' }, props)
  const c = (d: StoredDevice[], h = health('linux.smart')) => ctx({ devices: d, collectors: [h] })
  it('escalates by the most serious indicator and cites each property', () => {
    expect(evalOk('storage.smart', c([disk([P('smart_passed', true), P('nvme_percentage_used', 3)])])).findings).toHaveLength(0)
    expect(evalOk('storage.smart', c([disk([P('smart_passed', false)])])).findings[0]).toMatchObject({ severity: 'critical', confidence: 1 })
    const f = evalOk('storage.smart', c([disk([P('nvme_percentage_used', 92), P('nvme_media_errors', 4)])])).findings[0]!
    expect(f.severity).toBe('medium')
    expect(f.evidence.map((e) => e.key).sort()).toEqual(['nvme_media_errors', 'nvme_percentage_used'])
    expect(evalOk('storage.smart', c([disk([P('nvme_critical_warning', 4)])])).findings[0]!.severity).toBe('high')
    expect(evalOk('storage.smart', c([disk([P('reallocated_sectors', 2)])])).findings[0]!.severity).toBe('low')
  })
  it('says nothing about health when SMART is not readable (permission/error/stale)', () => {
    for (const h of [health('linux.smart', { status: 'permission_required' }), health('linux.smart', { status: 'error' }), health('linux.smart', { lastSuccessAt: iso(1e7) })]) {
      expect(rule('storage.smart').evaluate(c([disk([P('smart_passed', false)])], h)).status).toBe('insufficient_data')
    }
    expect(rule('storage.smart').evaluate(ctx({ devices: [], collectors: [] })).status).toBe('insufficient_data')
  })
})

describe('rule: sensor.temperature', () => {
  const sensor = (t: number, extra: Property[] = []) => dev({ category: 'sensor', name: 'coretemp', source: 'linux.sensors' }, [P('temperature:Package', t, { unit: '°C' }), ...extra])
  const c = (d: StoredDevice[], settings = SettingsSchema.parse({})) => ctx({ devices: d, collectors: [health('linux.sensors')], settings })
  const lim = [P('temperature_crit:Package', 100), P('temperature_max:Package', 90)]
  it('uses the sensor’s own limits: none, margin, max, critical', () => {
    expect(evalOk('sensor.temperature', c([sensor(60, lim)])).findings).toHaveLength(0)
    expect(evalOk('sensor.temperature', c([sensor(60, [P('temperature_crit:Package', 65)])])).findings[0]!.severity).toBe('medium') // within 10 °C of crit
    expect(evalOk('sensor.temperature', c([sensor(91, lim)])).findings[0]!.severity).toBe('high')
    expect(evalOk('sensor.temperature', c([sensor(101, lim)])).findings[0]!.severity).toBe('critical')
  })
  it('has no universal threshold: a sensor without limits is ignored unless a fallback is configured', () => {
    expect(evalOk('sensor.temperature', c([sensor(95)])).findings).toHaveLength(0)
    const f = evalOk('sensor.temperature', c([sensor(95)], SettingsSchema.parse({ diagTempFallbackC: 90 }))).findings
    expect(f[0]).toMatchObject({ severity: 'medium' })
    expect(f[0]!.description).toMatch(/reports no limits/)
  })
  it('requires a fresh reading and cites the actual value', () => {
    const s = sensor(101, lim)
    s.properties[0] = { ...s.properties[0]!, observedAt: iso(3_600_000) }
    expect(evalOk('sensor.temperature', c([s])).findings).toHaveLength(0)
    const f = evalOk('sensor.temperature', c([sensor(101, lim)])).findings[0]!
    expect(f.evidence[0]).toMatchObject({ key: 'temperature:Package', value: 101, unit: '°C' })
    expect(rule('sensor.temperature').evaluate(ctx({ devices: [sensor(101, lim)], collectors: [] })).status).toBe('insufficient_data')
  })
})

describe('rule: network.link_down', () => {
  const nic = (state: string, subtype = 'wifi') => dev({ category: 'network', subtype, source: 'linux.network' }, [P('operstate', state)])
  const on = SettingsSchema.parse({ diagNetworkDownEnabled: true })
  it('is opt-in', () => {
    expect(evalOk('network.link_down', ctx({ devices: [nic('down')], collectors: [health('linux.network')] })).findings).toHaveLength(0)
    expect(evalOk('network.link_down', ctx({ settings: on, devices: [nic('down')], collectors: [health('linux.network')] })).findings[0]).toMatchObject({ severity: 'low' })
  })
  it('ignores up links, virtual/loopback interfaces and unreliable state', () => {
    const c = (d: StoredDevice[], h = health('linux.network')) => ctx({ settings: on, devices: d, collectors: [h] })
    expect(evalOk('network.link_down', c([nic('up'), nic('down', 'loopback'), nic('down', 'virtual')])).findings).toHaveLength(0)
    expect(rule('network.link_down').evaluate(c([nic('down')], health('linux.network', { status: 'error' }))).status).toBe('insufficient_data')
  })
})

describe('rule: device.missing', () => {
  const missing = (over: Partial<StoredDevice>) => dev({ presence: 'missing', lastSeen: iso(3_600_000), ...over })
  it('peripherals are informational, internal components medium, never critical', () => {
    const usb = missing({ category: 'usb', source: 'linux.usb' })
    const pci = missing({ category: 'pci', source: 'linux.pci' })
    const r = evalOk('device.missing', ctx({ devices: [usb, pci], collectors: [health('linux.usb'), health('linux.pci')] }))
    const by = Object.fromEntries(r.findings.map((f) => [f.deviceIds[0], f]))
    expect(by[usb.id]).toMatchObject({ severity: 'info', confidence: 1 })
    expect(by[pci.id]).toMatchObject({ severity: 'medium', confidence: 0.6 })
    expect(by[pci.id]!.description).toMatch(/not by itself proof of failure/)
    expect(r.findings.every((f) => f.severity !== 'critical' && f.severity !== 'high')).toBe(true)
    expect(by[usb.id]!.evidence.map((e) => e.type)).toEqual(['device_field', 'collector_run'])
  })
  it('does not report absence unless the owning collector currently completes', () => {
    const d = missing({ category: 'pci', source: 'linux.pci' })
    for (const h of [health('linux.pci', { status: 'error' }), health('linux.pci', { partial: true }), health('linux.pci', { status: 'permission_required' })]) {
      const r = evalOk('device.missing', ctx({ devices: [d], collectors: [h] }))
      expect(r.findings).toHaveLength(0)
      expect(r.status === 'evaluated' && r.retain).toEqual([`device:${d.id}`])
    }
  })
  it('only covers recently seen devices (reporting window)', () => {
    const old = missing({ category: 'usb', source: 'linux.usb', lastSeen: iso(30 * 86_400_000) })
    expect(evalOk('device.missing', ctx({ devices: [old], collectors: [health('linux.usb')] })).findings).toHaveLength(0)
  })
})

describe('rule: device.property_changed', () => {
  const ev = (changes: string[], deviceId: string, at = iso(60_000)): HipEvent => ({ type: 'device.updated', at, deviceId, deviceName: 'x', category: 'storage', collectorId: 'c', summary: 'x changed', data: { changes } })
  it('reports only identity-level changes from the last 24h, once per device+field', () => {
    const d = dev()
    const r = evalOk('device.property_changed', ctx({ devices: [d], recentEvents: [ev(['model: A → B', 'name: x → y', 'driver: a → b'], d.id), ev(['model: A → B'], d.id), ev(['size_bytes: 1 → 2'], d.id, iso(2 * 86_400_000))] }))
    expect(r.findings.map((f) => f.subject)).toEqual([`device:${d.id}:model`, `device:${d.id}:model`])
    expect(r.findings[0]).toMatchObject({ severity: 'low', confidence: 0.7 })
    expect(r.findings[0]!.evidence[0]).toMatchObject({ type: 'device_event', value: 'model: A → B' })
  })
})

// ------------------------------------------------------------------------------------------------
// Engine
// ------------------------------------------------------------------------------------------------

function engine(rules: DiagnosticRule[], opts: { settings?: Partial<ReturnType<typeof SettingsSchema.parse>> } = {}) {
  const db = openDatabase(':memory:')
  const inv = new InventoryRepo(db)
  inv.ensureSystem('linux', NOW.toISOString())
  const bus = new EventBus(new EventRepo(db), 0)
  const events: HipEvent[] = []
  bus.subscribe((e) => events.push(e))
  let settings = SettingsSchema.parse(opts.settings ?? {})
  let now = NOW
  const svc = new DiagnosticsService({ db, inventory: inv, events: new EventRepo(db), bus, getSettings: () => settings, getMonitor: () => monitor(), getCollectors: () => [], rules, clock: () => now })
  return { svc, db, inv, events, setSettings: (s: Partial<typeof settings>) => (settings = { ...settings, ...s }), tick: (ms: number) => (now = new Date(now.getTime() + ms)) }
}

const simple = (state: { out: () => ReturnType<DiagnosticRule['evaluate']> }, id = 'test.rule'): DiagnosticRule => ({
  id, version: 1, title: 't', category: 'device', description: 'd', severityPolicy: 's', dataUsed: 'u', evaluate: () => state.out()
})
const finding = (subject: string, over: Partial<ReturnType<typeof f0>> = {}) => ({ ...f0(subject), ...over })
const f0 = (subject: string) => ({
  subject, severity: 'medium' as Severity, title: `T ${subject}`, description: 'D', deviceIds: [] as string[], recommendation: 'R',
  evidence: [{ type: 'setting' as const, ref: 'x', value: 1, observedAt: NOW.toISOString() }]
})

describe('DiagnosticsService', () => {
  it('creates a finding once and updates it on re-evaluation (no duplicates), persisting evidence', () => {
    const st = { out: () => ({ status: 'evaluated' as const, findings: [finding('a')] }) }
    const { svc, events, tick } = engine([simple(st)])
    expect(svc.evaluate()).toMatchObject({ created: 1, updated: 0 })
    tick(60_000)
    st.out = () => ({ status: 'evaluated', findings: [finding('a', { description: 'changed' })] })
    expect(svc.evaluate()).toMatchObject({ created: 0, updated: 1 })
    const list = svc.list({})
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: findingId('test.rule', 'a'), description: 'changed', status: 'active', ruleVersion: 1 })
    expect(list[0]!.firstDetectedAt).toBe(NOW.toISOString())
    expect(list[0]!.lastSeenAt).toBe(new Date(NOW.getTime() + 60_000).toISOString())
    expect(list[0]!.evidence[0]).toMatchObject({ type: 'setting', ref: 'x', value: 1 })
    expect(events.filter((e) => e.type === 'diagnostic.created')).toHaveLength(1) // not re-announced
  })

  it('resolves a finding only when the rule evaluated and no longer reports it; reopens when it returns', () => {
    const st: { out: () => ReturnType<DiagnosticRule['evaluate']> } = { out: () => ({ status: 'evaluated', findings: [finding('a'), finding('b')] }) }
    const { svc, events, tick } = engine([simple(st)])
    svc.evaluate()
    st.out = () => ({ status: 'insufficient_data', reason: 'no data' })
    svc.evaluate()
    expect(svc.list({ status: 'active' })).toHaveLength(2) // insufficient data never resolves
    st.out = () => ({ status: 'evaluated', findings: [finding('a')], retain: ['b'] })
    svc.evaluate()
    expect(svc.list({ status: 'active' })).toHaveLength(2) // 'b' retained: could not be evaluated
    st.out = () => ({ status: 'evaluated', findings: [finding('a')] })
    tick(1000)
    expect(svc.evaluate().resolved).toBe(1)
    const b = svc.repo.get(findingId('test.rule', 'b'))!
    expect(b).toMatchObject({ status: 'resolved', resolutionReason: 'Condition no longer present', resolvedAt: new Date(NOW.getTime() + 1000).toISOString() })
    expect(events.filter((e) => e.type === 'diagnostic.resolved')).toHaveLength(1)
    st.out = () => ({ status: 'evaluated', findings: [finding('a'), finding('b')] })
    expect(svc.evaluate().reopened).toBe(1)
    expect(svc.repo.get(findingId('test.rule', 'b'))).toMatchObject({ status: 'active', resolvedAt: null, resolutionReason: null })
  })

  it('isolates a throwing rule: others still apply, its own findings are untouched, and the run is recorded', () => {
    const good = { out: () => ({ status: 'evaluated' as const, findings: [finding('g')] }) }
    const bad: { out: () => ReturnType<DiagnosticRule['evaluate']> } = { out: () => ({ status: 'evaluated', findings: [finding('x')] }) }
    const { svc } = engine([simple(good, 'good.rule'), simple(bad, 'bad.rule')])
    svc.evaluate()
    bad.out = () => { throw new Error('rule bug') }
    const sum = svc.evaluate()
    expect(sum.ruleErrors).toBe(1)
    expect(svc.list({ status: 'active' }).map((f) => f.ruleId).sort()).toEqual(['bad.rule', 'good.rule'])
    const st = svc.status()
    expect(st.rules.find((r) => r.id === 'bad.rule')!.lastRun).toMatchObject({ outcome: 'error', message: 'rule bug' })
    expect(st.rules.find((r) => r.id === 'good.rule')!.lastRun).toMatchObject({ outcome: 'evaluated', findings: 1 })
  })

  it('rejects non-info findings without evidence (and keeps the rest)', () => {
    const st = { out: () => ({ status: 'evaluated' as const, findings: [finding('noev', { evidence: [] }), finding('info-ok', { severity: 'info', evidence: [] })] }) }
    const { svc } = engine([simple(st)])
    const sum = svc.evaluate()
    expect(sum.ruleErrors).toBe(1)
    expect(svc.list({}).map((f) => f.subjectKey)).toEqual(['info-ok'])
    expect(svc.status().rules[0]!.lastRun).toMatchObject({ outcome: 'error' })
  })

  it('manual status transitions: acknowledge, dismiss (persists while condition holds), resolve, reopen; invalid ones throw', () => {
    const st = { out: () => ({ status: 'evaluated' as const, findings: [finding('a')] }) }
    const { svc, tick } = engine([simple(st)])
    svc.evaluate()
    const id = findingId('test.rule', 'a')
    expect(svc.setStatus(id, 'acknowledge')).toMatchObject({ status: 'acknowledged' })
    expect(() => svc.setStatus(id, 'acknowledge')).toThrow(/Cannot acknowledge a finding that is acknowledged/)
    expect(svc.setStatus(id, 'dismiss', 'expected')).toMatchObject({ status: 'dismissed', resolutionReason: 'expected' })
    tick(1000); svc.evaluate()
    expect(svc.repo.get(id)!.status).toBe('dismissed') // still present: stays dismissed, but last_seen advances
    expect(svc.repo.get(id)!.lastSeenAt).toBe(new Date(NOW.getTime() + 1000).toISOString())
    expect(svc.setStatus(id, 'reopen')).toMatchObject({ status: 'active', resolutionReason: null })
    expect(() => svc.setStatus(id, 'reopen')).toThrow()
    expect(svc.setStatus(id, 'resolve')).toMatchObject({ status: 'resolved', resolutionReason: 'Marked resolved by user' })
    expect(() => svc.setStatus(id, 'resolve')).toThrow()
    expect(() => svc.setStatus('nope', 'resolve')).toThrow(/not found/)
    tick(1000); expect(svc.evaluate().reopened).toBe(1) // manual resolve while the condition persists
  })

  it('a dismissed or acknowledged finding that gets worse becomes active again', () => {
    const st: { out: () => ReturnType<DiagnosticRule['evaluate']> } = { out: () => ({ status: 'evaluated', findings: [finding('a', { severity: 'low' })] }) }
    const { svc } = engine([simple(st)])
    svc.evaluate()
    const id = findingId('test.rule', 'a')
    svc.setStatus(id, 'dismiss')
    st.out = () => ({ status: 'evaluated', findings: [finding('a', { severity: 'high' })] })
    svc.evaluate()
    expect(svc.repo.get(id)).toMatchObject({ status: 'active', severity: 'high' })
  })

  it('disabling a rule resolves its findings with a reason; re-enabling brings them back', () => {
    const st = { out: () => ({ status: 'evaluated' as const, findings: [finding('a')] }) }
    const e = engine([simple(st)])
    e.svc.evaluate()
    e.setSettings({ diagDisabledRules: ['test.rule'] })
    e.svc.evaluate()
    expect(e.svc.repo.get(findingId('test.rule', 'a'))).toMatchObject({ status: 'resolved', resolutionReason: 'Rule disabled' })
    expect(e.svc.status().rules[0]).toMatchObject({ enabled: false, lastRun: { outcome: 'disabled' } })
    e.setSettings({ diagDisabledRules: [] })
    e.svc.evaluate()
    expect(e.svc.repo.get(findingId('test.rule', 'a'))!.status).toBe('active')
  })

  it('filters by status, severity, category and search; counts reflect findings needing attention', () => {
    const st = { out: () => ({ status: 'evaluated' as const, findings: [finding('a', { severity: 'high', title: 'Disk full' }), finding('b', { severity: 'low', title: 'Fan slow' }), finding('c', { severity: 'info', evidence: [] })] }) }
    const { svc } = engine([simple(st)])
    svc.evaluate()
    svc.setStatus(findingId('test.rule', 'b'), 'dismiss')
    expect(svc.list({ severity: 'high' })).toHaveLength(1)
    expect(svc.list({ status: 'dismissed' }).map((f) => f.title)).toEqual(['Fan slow'])
    expect(svc.list({ search: 'disk' })).toHaveLength(1)
    expect(svc.list({ category: 'storage' })).toHaveLength(0)
    expect(svc.list({ search: "'; DROP TABLE diagnostic_findings;--" })).toHaveLength(0)
    expect(svc.list({}).map((f) => f.severity)).toEqual(['high', 'low', 'info']) // most severe first
    expect(svc.status().counts).toEqual({ bySeverity: { high: 1, info: 1 }, byStatus: { active: 2, dismissed: 1 } })
  })

  it('detail() returns the rule explanation and affected devices that exist', () => {
    const o: DeviceObservation = obs('k1', { name: 'My Disk', category: 'storage' })
    const st = { out: () => ({ status: 'evaluated' as const, findings: [finding('a', { deviceIds: ['devid', 'ghost'] })] }) }
    const e = engine([simple(st)])
    e.inv.upsert('devid', o, 'h', NOW.toISOString())
    e.svc.evaluate()
    const d = e.svc.detail(findingId('test.rule', 'a'))!
    expect(d.devices).toEqual([{ id: 'devid', name: 'My Disk', category: 'storage', presence: 'present' }])
    expect(d.rule).toMatchObject({ id: 'test.rule', severityPolicy: 's' })
    expect(e.svc.detail('zzz')).toBeNull()
  })

  it('tolerates corrupted evidence rows without hiding the finding', () => {
    const st = { out: () => ({ status: 'evaluated' as const, findings: [finding('a')] }) }
    const { svc, db } = engine([simple(st)])
    svc.evaluate()
    db.prepare("UPDATE diagnostic_findings SET evidence = ?").run(JSON.stringify([{ nonsense: true }, { type: 'setting', ref: 'k', value: 2, observedAt: 'x' }]))
    expect(svc.list({})[0]!.evidence).toHaveLength(1)
    db.prepare("UPDATE diagnostic_findings SET evidence = 'not json'").run()
    expect(svc.list({})[0]!.evidence).toEqual([])
  })
})

describe('diagnostics with the real inventory pipeline', () => {
  function full(states: Record<string, FakeState>) {
    const db = openDatabase(':memory:')
    const bus = new EventBus(new EventRepo(db), 0)
    const inv = new InventoryService({ db, collectors: Object.entries(states).map(([id, s]) => fakeCollector(id, s)), makeContext: () => ctxFor(tmpRoot()), bus, platform: 'linux' })
    const svc = new DiagnosticsService({ db, inventory: inv.repo, events: new EventRepo(db), bus, getSettings: () => SettingsSchema.parse({}), getMonitor: () => monitor({ lastScanAt: new Date().toISOString() }), getCollectors: () => inv.getHealth() })
    return { inv, svc }
  }
  const usb = (k: string) => obs(k, { source: 'a', name: k })

  it('REGRESSION: a failed collector produces a collector finding but never a device-missing finding', async () => {
    const a: FakeState = { result: complete([usb('d1'), obs('d2', { source: 'a', category: 'pci', name: 'Internal' })]) }
    const { inv, svc } = full({ a })
    await inv.scan(); svc.evaluate()
    a.result = new Error('sysfs exploded')
    await inv.scan(); svc.evaluate()
    const ids = svc.list({}).map((f) => f.ruleId)
    expect(ids).toContain('collector.health')
    expect(ids).not.toContain('device.missing')
    expect(inv.repo.list({})).toHaveLength(2)
  })

  it('a permission-limited collector yields a low/info finding explaining the gap, and still no missing devices', async () => {
    const a: FakeState = { result: complete([usb('d1')]) }
    const { inv, svc } = full({ a })
    await inv.scan()
    a.result = { outcome: 'permission_required', observations: [], limitations: [{ kind: 'permission', message: 'SMART needs root', remedy: 'grant read access' }] }
    await inv.scan(); svc.evaluate()
    const f = svc.list({ search: 'permission' })[0]!
    expect(f).toMatchObject({ ruleId: 'collector.health', severity: 'low', recommendation: 'grant read access' })
    expect(svc.list({}).some((x) => x.ruleId === 'device.missing')).toBe(false)
  })

  it('an unplugged peripheral after a complete scan → info finding that resolves when it returns', async () => {
    const a: FakeState = { result: complete([usb('d1'), usb('d2')]) }
    const { inv, svc } = full({ a })
    await inv.scan(); svc.evaluate()
    a.result = complete([usb('d1')])
    await inv.scan(); svc.evaluate()
    const f = svc.list({ status: 'active' }).find((x) => x.ruleId === 'device.missing')!
    expect(f).toMatchObject({ severity: 'info', title: 'd2 was disconnected' })
    a.result = complete([usb('d1'), usb('d2')])
    await inv.scan(); svc.evaluate()
    expect(svc.repo.get(f.id)).toMatchObject({ status: 'resolved' })
  })
})

describe('diagnostics IPC validation', () => {
  const origins = { appUrlPrefix: 'file:///app/out/renderer' }
  const url = 'file:///app/out/renderer/index.html'
  const handlers = Object.fromEntries(IPC_CHANNELS.map((c) => [c, async (i: unknown) => i])) as unknown as Handlers
  it('rejects malformed finding/rule requests and accepts valid ones', async () => {
    const bad: [string, unknown][] = [
      ['diagnostics:list', { status: 'open' }], ['diagnostics:list', { severity: 'informational' }], ['diagnostics:list', { search: 'x'.repeat(201) }], ['diagnostics:list', { sql: '1' }],
      ['diagnostics:get', {}], ['diagnostics:get', { id: 'x'.repeat(65) }], ['diagnostics:setStatus', { id: 'a', action: 'delete' }], ['diagnostics:setStatus', { id: 'a', action: 'resolve', reason: 'r'.repeat(301) }],
      ['diagnostics:setStatus', { action: 'resolve' }], ['diagnostics:setRuleEnabled', { ruleId: 'x' }], ['diagnostics:setRuleEnabled', { ruleId: 'x', enabled: 'yes' }], ['diagnostics:status', { x: 1 }], ['diagnostics:evaluate', 1]
    ]
    for (const [c, p] of bad) await expect(dispatch(c, p, url, handlers, origins), `${c} ${JSON.stringify(p)}`).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' })
    await expect(dispatch('diagnostics:setStatus', { id: 'a', action: 'dismiss', reason: 'ok' }, url, handlers, origins)).resolves.toEqual({ id: 'a', action: 'dismiss', reason: 'ok' })
    await expect(dispatch('diagnostics:list', { status: 'active', severity: 'high' }, url, handlers, origins)).resolves.toBeTruthy()
  })
})

describe('database migration compatibility (v1 → v2)', () => {
  it('upgrades a populated v1 database, keeps data, maps legacy findings, and backs up first', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, [MIGRATIONS[0]!])
    db.prepare("INSERT INTO systems (id, platform, created_at) VALUES ('local','linux','x')").run()
    db.prepare("INSERT INTO settings VALUES ('theme','\"dark\"','x')").run()
    db.prepare("INSERT INTO devices (id,system_id,key,category,name,first_seen,last_seen,last_scanned,source,content_hash) VALUES ('d1','local','k1','usb','Dev','a','b','c','s','h')").run()
    db.prepare(`INSERT INTO diagnostic_findings (id,system_id,device_id,rule_id,severity,category,title,description,evidence,state,created_at) VALUES
      ('f1','local','d1','legacy.rule','informational','device','Legacy','Body','[{"x":1}]','open','2025-01-01'),
      ('f2','local',NULL,'legacy.rule','high','device','Old','Body','bad json','resolved','2025-01-02')`).run()
    migrate(db, MIGRATIONS.slice(0, 2))
    expect(listMigrations(db).map((m) => m.version)).toEqual([1, 2])
    expect(db.prepare("SELECT value FROM settings WHERE key='theme'").get()).toMatchObject({ value: '"dark"' })
    expect(db.prepare('SELECT COUNT(*) c FROM devices').get()).toMatchObject({ c: 1 })
    const f1 = new DiagnosticsRepo(db).get('f1')!
    expect(f1).toMatchObject({ severity: 'info', status: 'active', ruleVersion: 1, deviceIds: ['d1'], recommendation: '' })
    expect(f1.evidence).toEqual([]) // legacy shape that is not a valid reference is dropped, finding kept
    expect(new DiagnosticsRepo(db).get('f2')).toMatchObject({ status: 'resolved', deviceIds: [] })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('diagnostic_findings_v1','diagnostic_rule_runs')").all()).toHaveLength(1)
    expect(() => db.prepare("INSERT INTO diagnostic_findings (id,system_id,rule_id,rule_version,subject_key,severity,category,title,description,first_detected_at,last_seen_at,updated_at) VALUES ('z','local','r',1,'s','informational','c','t','d','a','a','a')").run()).toThrow()
  })
})

describe('rule: metrics.availability', () => {
  const m = (over: Record<string, unknown> = {}, providers: Record<string, unknown>[] = []) => ({
    enabled: true, running: true, paused: false, intervalSec: 5, retentionHours: 24, platformSupported: true, bufferedSamples: 0, pendingWrites: 0, storedSamples: 0, series: [],
    providers: providers.map((p) => ({ id: 'p', title: 'P', status: 'ok', message: null, lastSampleAt: iso(2000), consecutiveFailures: 0, counterResets: 0, invalidReadings: 0, metrics: [], ...p })), ...over
  }) as unknown as RuleContext['metrics']
  it('is silent when healthy, disabled or when a source legitimately does not exist', () => {
    expect(evalOk('metrics.availability', ctx({ metrics: m({}, [{}, { id: 'battery', status: 'unavailable' }]) })).findings).toHaveLength(0)
    expect(evalOk('metrics.availability', ctx({ metrics: m({ enabled: false }, [{ status: 'error' }]) })).findings).toHaveLength(0)
  })
  it('reports errors, stalls and pause with evidence; unknown state is insufficient data', () => {
    const f = (c: RuleContext['metrics']) => evalOk('metrics.availability', ctx({ metrics: c })).findings
    expect(f(m({}, [{ status: 'error', message: 'denied', consecutiveFailures: 3 }]))[0]).toMatchObject({ severity: 'low', subject: 'metrics:p' })
    expect(f(m({}, [{ lastSampleAt: iso(600_000) }]))[0]!.title).toMatch(/no recent samples/)
    expect(f(m({ paused: true }, [{ status: 'paused' }]))[0]).toMatchObject({ severity: 'info', subject: 'metrics:paused' })
    expect(f(m({}, [{ status: 'error' }]))[0]!.evidence[0]).toMatchObject({ type: 'monitor_state', ref: 'p', value: 'error' })
    expect(rule('metrics.availability').evaluate(ctx({ metrics: null })).status).toBe('insufficient_data')
  })
})
