import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { compareSnapshots, type SnapshotData } from '../src/snapshots/compare'
import { migrate, openDatabase } from '../src/main/database/db'
import { MIGRATIONS } from '../src/main/database/migrations'
import { EventRepo, SnapshotRepo } from '../src/main/database/repositories'
import { dispatch, type Handlers } from '../src/main/ipc/dispatch'
import { EventBus } from '../src/main/services/event-bus'
import { InventoryService } from '../src/main/services/inventory'
import { SnapshotService, coverageState } from '../src/main/services/snapshots'
import { IPC_CHANNELS } from '@shared/ipc'
import type { CollectorCoverage, CollectorHealth, CoverageState, Property, Relationship, SnapshotMeta } from '@shared/schemas'
import type { StoredDevice } from '@shared/stored'
import { complete, fakeCollector, obs, type FakeState } from './helpers/factory'
import { ctxFor, tmpRoot } from './helpers/fixtures'

const T0 = '2026-02-01T10:00:00.000Z'
const T1 = '2026-02-02T10:00:00.000Z'

const cov = (id: string, state: CoverageState = 'complete', over: Partial<CollectorCoverage> = {}): CollectorCoverage => ({
  id, state, categories: ['usb'], lastRunAt: T0, lastSuccessAt: T0, durationMs: 1, message: null, limitations: [], deviceCount: 0, ...over
})
const meta = (id: string, collectors: CollectorCoverage[], at = T0): SnapshotMeta => ({
  id, label: null, createdAt: at, scanAt: at, appVersion: '1', schemaVersion: 3, machineId: 'm', deviceCount: 0, relationshipCount: 0, propertyCount: 0, categoryCounts: {},
  collectors, complete: collectors.every((c) => c.state === 'complete'), limitations: []
})
const prop = (key: string, value: string | number | boolean, over: Partial<Property> = {}): Property => ({ key, value, source: 'A', sourceProperty: 'p', evidence: 'os_reported', observedAt: T0, ...over })
const rel = (targetKey: string, over: Partial<Relationship> = {}): Relationship => ({ targetKey, type: 'bus_attachment', directness: 'reported', source: 'A', confidence: 1, observedAt: T0, ...over })
let n = 0
const dev = (key: string, over: Partial<StoredDevice> = {}): StoredDevice => ({
  id: `id-${key}`, key, category: 'usb', subtype: null, name: key, manufacturer: null, model: null, description: null, vendorId: null, productId: null, busType: null, deviceClass: null,
  driver: null, status: 'ok', presence: 'present', firstSeen: T0, lastSeen: T0, lastScanned: T0, source: 'A', identifiers: [], properties: [], relationships: [], fieldSources: {}, ...(void n++, over)
})
const snap = (id: string, devices: StoredDevice[], collectors: CollectorCoverage[] = [cov('A')], at = T0): SnapshotData => ({ meta: meta(id, collectors, at), devices })
const kinds = (c: ReturnType<typeof compareSnapshots>) => c.changes.map((x) => x.kind)

describe('compareSnapshots — basics', () => {
  it('identical inventories produce no changes and are not uncertain', () => {
    const d = [dev('a', { properties: [prop('speed', 480)] }), dev('b')]
    const r = compareSnapshots(snap('s1', d), snap('s2', structuredClone(d), [cov('A')], T1))
    expect(r.changes).toEqual([])
    expect(r.summary).toMatchObject({ unchanged: 2, added: 0, removed: 0 })
    expect(r.uncertain).toBe(false)
  })

  it('reports confirmed additions and removals when the owning collector was complete in both', () => {
    const r = compareSnapshots(snap('s1', [dev('a'), dev('gone')]), snap('s2', [dev('a'), dev('new')], [cov('A')], T1))
    expect(r.changes.map((c) => [c.kind, 'device' in c ? c.device.key : '', 'certainty' in c ? c.certainty : ''])).toEqual([
      ['device_removed', 'gone', 'confirmed'], ['device_added', 'new', 'confirmed']
    ])
    expect(r.uncertain).toBe(false)
  })

  it('reports property and field changes with before/after, unit and provenance', () => {
    const a = dev('a', { driver: 'old', fieldSources: { driver: { source: 'A', sourceProperty: '/driver', evidence: 'os_reported' } }, properties: [prop('size_bytes', 100, { unit: 'B' }), prop('kept', 1)] })
    const b = dev('a', { driver: 'new', fieldSources: { driver: { source: 'A', sourceProperty: '/driver', evidence: 'os_reported' } }, properties: [prop('size_bytes', 200, { unit: 'B', sourceProperty: 'sz' }), prop('kept', 1)] })
    const r = compareSnapshots(snap('s1', [a]), snap('s2', [b]))
    const c = r.changes[0]!
    expect(c.kind).toBe('property_changed')
    if (c.kind !== 'property_changed') throw new Error()
    expect(c.changes).toEqual([
      expect.objectContaining({ field: 'driver', kind: 'field', before: 'old', after: 'new', source: 'A · /driver', certainty: 'confirmed' }),
      expect.objectContaining({ field: 'size_bytes', kind: 'property', before: 100, after: 200, unit: 'B', source: 'A · sz', certainty: 'confirmed' })
    ])
    expect(r.summary.changed).toBe(1)
  })

  it('ignores volatile properties by default and includes them on request; sensitive values are masked', () => {
    const a = dev('a', { properties: [prop('rx', 1, { volatile: true }), prop('ip', '10.0.0.1', { sensitive: true })] })
    const b = dev('a', { properties: [prop('rx', 99, { volatile: true }), prop('ip', '10.0.0.2', { sensitive: true })] })
    const dflt = compareSnapshots(snap('s1', [a]), snap('s2', [b]))
    const c = dflt.changes[0]!
    if (c.kind !== 'property_changed') throw new Error()
    expect(c.changes.map((x) => x.field)).toEqual(['ip'])
    expect(JSON.stringify(dflt)).not.toContain('10.0.0.')
    expect(c.changes[0]).toMatchObject({ before: '[sensitive]', after: '[sensitive]', sensitive: true })
    const withVol = compareSnapshots(snap('s1', [a]), snap('s2', [b]), { includeVolatile: true })
    const c2 = withVol.changes[0]!
    if (c2.kind !== 'property_changed') throw new Error()
    expect(c2.changes.map((x) => x.field).sort()).toEqual(['ip', 'rx'])
    expect(withVol.includeVolatile).toBe(true)
  })
})

describe('compareSnapshots — changed identities', () => {
  it('matches a moved device by its serial instead of reporting remove+add', () => {
    const a = dev('usb:1:2:port:3-1', { name: 'Stick', identifiers: [{ kind: 'serial', value: 'SN1', sensitive: true }, { kind: 'usb_port_path', value: '3-1' }] })
    const b = dev('usb:1:2:port:3-4', { name: 'Stick', identifiers: [{ kind: 'serial', value: 'SN1', sensitive: true }, { kind: 'usb_port_path', value: '3-4' }] })
    const r = compareSnapshots(snap('s1', [a]), snap('s2', [b]))
    expect(r.summary).toMatchObject({ added: 0, removed: 0, changed: 1 })
    const c = r.changes[0]!
    if (c.kind !== 'property_changed') throw new Error()
    expect(c.rekeyed).toMatchObject({ from: a.key, to: b.key, confidence: 0.95 })
    expect(c.changes[0]).toMatchObject({ kind: 'identity', certainty: 'probable' })
    expect(JSON.stringify(r)).not.toContain('SN1') // the serial is used for matching, never echoed
  })

  it('heuristic id+name matching is flagged uncertain; ambiguous matches are not guessed', () => {
    const mk = (key: string) => dev(key, { name: 'Webcam', vendorId: '04f2', productId: 'b6c0' })
    const r = compareSnapshots(snap('s1', [mk('x:port:1')]), snap('s2', [mk('x:port:2')]))
    expect(r.summary).toMatchObject({ added: 0, removed: 0, changed: 1 })
    expect(r.uncertain).toBe(true)
    expect(r.reasons.join()).toMatch(/heuristic/)
    const amb = compareSnapshots(snap('s1', [mk('x:port:1'), mk('x:port:2')]), snap('s2', [mk('x:port:5'), mk('x:port:6')]))
    expect(amb.summary).toMatchObject({ added: 2, removed: 2, changed: 0 })
  })

  it('does not pair devices of different categories or different serials', () => {
    const a = dev('k1', { identifiers: [{ kind: 'serial', value: 'A' }] })
    const b = dev('k2', { identifiers: [{ kind: 'serial', value: 'B' }] })
    expect(compareSnapshots(snap('s1', [a]), snap('s2', [b])).summary).toMatchObject({ added: 1, removed: 1 })
  })
})

describe('compareSnapshots — incomplete collection never produces confirmed removals', () => {
  const before = [dev('keep'), dev('lost', { name: 'Lost Device' })]
  const after = [dev('keep')]
  for (const state of ['error', 'partial', 'permission_required', 'stale', 'unavailable', 'unsupported', 'not_scanned'] as CoverageState[]) {
    it(`REGRESSION: owning collector ${state} in the newer snapshot → indeterminate, not removed`, () => {
      const r = compareSnapshots(snap('s1', before), snap('s2', after, [cov('A', state)], T1))
      expect(r.summary.removed).toBe(0)
      expect(r.summary.indeterminate).toBe(1)
      expect(r.uncertain).toBe(true)
      const c = r.changes.find((x) => x.kind === 'indeterminate')!
      expect(c).toMatchObject({ direction: 'missing_in_target' })
      if (c.kind === 'indeterminate') expect(c.reason).toContain(state.replace('_', ' '))
      expect(r.changes.some((x) => x.kind === 'coverage_changed')).toBe(true)
      expect(r.reasons.join()).toMatch(/cannot be confirmed/)
    })
  }
  it('a collector missing entirely from the newer snapshot cannot confirm removals', () => {
    const r = compareSnapshots(snap('s1', before), snap('s2', after, [cov('Z')], T1))
    expect(r.summary.removed).toBe(0)
    expect(r.reasons.join()).toMatch(/was not part of that snapshot/)
  })
  it('a device that was only last-known in the older snapshot cannot be confirmed removed either', () => {
    const r = compareSnapshots(snap('s1', before, [cov('A', 'error')]), snap('s2', after, [cov('A')], T1))
    expect(r.summary.removed).toBe(0)
    expect(r.summary.indeterminate).toBe(1)
  })
  it('new devices are indeterminate when the older snapshot did not cover their collector completely', () => {
    const r = compareSnapshots(snap('s1', [], [cov('A', 'permission_required')]), snap('s2', [dev('x')], [cov('A')], T1))
    expect(r.summary).toMatchObject({ added: 0, indeterminate: 1 })
    const c = r.changes.find((x) => x.kind === 'indeterminate')!
    expect(c).toMatchObject({ direction: 'new_in_target' })
    // coverage change recovered: explained, not silently reported as new hardware
    expect(r.changes.some((x) => x.kind === 'coverage_changed' && x.after === 'complete')).toBe(true)
  })
  it('only devices of the degraded collector become uncertain; others stay confirmed', () => {
    const b = [dev('a1', { source: 'A' }), dev('b1', { source: 'B' })]
    const r = compareSnapshots(snap('s1', b, [cov('A'), cov('B')]), snap('s2', [], [cov('A', 'error'), cov('B')], T1))
    expect(r.changes.filter((c) => c.kind === 'device_removed').map((c) => 'device' in c && c.device.key)).toEqual(['b1'])
    expect(r.changes.filter((c) => c.kind === 'indeterminate').map((c) => 'device' in c && c.device.key)).toEqual(['a1'])
  })
  it('permission changes: a property that vanished while the collector became partial is uncertain', () => {
    const a = dev('mem', { properties: [prop('locator', 'DIMM0', { source: 'M' }), prop('size_bytes', 8, { source: 'M' })], source: 'M' })
    const b = dev('mem', { properties: [], source: 'M' })
    const r = compareSnapshots(snap('s1', [a], [cov('M')]), snap('s2', [b], [cov('M', 'permission_required')], T1))
    const c = r.changes.find((x) => x.kind === 'property_changed')!
    if (c.kind !== 'property_changed') throw new Error()
    expect(c.changes.every((x) => x.certainty === 'uncertain' && x.change === 'removed')).toBe(true)
    expect(r.uncertain).toBe(true)
  })
  it('stale data and unreadable stored records are surfaced', () => {
    const s2 = { ...snap('s2', [], [cov('A', 'stale')], T1), skipped: 2 }
    const r = compareSnapshots(snap('s1', before), s2)
    expect(r.skippedRecords).toBe(2)
    expect(r.reasons.join()).toMatch(/2 stored device record/)
    expect(r.summary.removed).toBe(0)
  })
})

describe('compareSnapshots — relationships', () => {
  it('keeps reported and inferred relationships distinguishable and detects changes', () => {
    const parent = dev('hub', { name: 'Hub' })
    const a = dev('kbd', { relationships: [rel('hub'), rel('sys', { type: 'logical_parent', directness: 'inferred', confidence: 0.6 })] })
    const b = dev('kbd', { relationships: [rel('sys', { type: 'logical_parent', directness: 'reported', confidence: 1 }), rel('other', { type: 'storage_attachment' })] })
    const other = dev('other', { name: 'Other' })
    const r = compareSnapshots(snap('s1', [a, parent]), snap('s2', [b, other, parent]))
    const c = r.changes.find((x) => x.kind === 'relationship_changed')!
    if (c.kind !== 'relationship_changed') throw new Error()
    const by = (ch: string, t: string) => c.changes.find((x) => x.change === ch && x.type === t)!
    expect(by('removed', 'bus_attachment')).toMatchObject({ otherName: 'Hub', certainty: 'confirmed', before: { directness: 'reported' } })
    expect(by('modified', 'logical_parent')).toMatchObject({ before: { directness: 'inferred', confidence: 0.6 }, after: { directness: 'reported', confidence: 1 } })
    expect(by('added', 'storage_attachment')).toMatchObject({ otherName: 'Other' })
  })
  it('a relationship missing because its collector was incomplete is uncertain', () => {
    const a = dev('kbd', { relationships: [rel('hub')] })
    const b = dev('kbd', { relationships: [] })
    const r = compareSnapshots(snap('s1', [a]), snap('s2', [b], [cov('A', 'partial')], T1))
    const c = r.changes.find((x) => x.kind === 'relationship_changed')!
    if (c.kind !== 'relationship_changed') throw new Error()
    expect(c.changes[0]).toMatchObject({ change: 'removed', certainty: 'uncertain' })
  })
})

describe('compareSnapshots — coverage', () => {
  it('reports coverage changes with affected device counts', () => {
    const r = compareSnapshots(snap('s1', [dev('a'), dev('b')]), snap('s2', [dev('a'), dev('b')], [cov('A', 'permission_required')], T1))
    expect(r.changes[0]).toMatchObject({ kind: 'coverage_changed', collectorId: 'A', before: 'complete', after: 'permission_required', devicesAffected: 2 })
    expect(r.uncertain).toBe(true)
  })
})

// ------------------------------------------------------------------------------------------------

describe('coverageState mapping', () => {
  const h = (over: Partial<CollectorHealth>): CollectorHealth => ({ id: 'x', version: '1', platforms: ['linux'], categories: ['usb'], permissions: [], method: 'm', status: 'available', partial: false, message: null, lastRunAt: T0, lastSuccessAt: T0, durationMs: 1, deviceCount: 1, limitations: [], ...over })
  const now = new Date(T0)
  it('only a fresh, non-partial success is complete', () => {
    expect(coverageState(h({}), now, 1000)).toBe('complete')
    expect(coverageState(h({ partial: true }), now, 1000)).toBe('partial')
    expect(coverageState(h({}), new Date(Date.parse(T0) + 5000), 1000)).toBe('stale')
    expect(coverageState(h({ lastSuccessAt: null }), now, 1000)).toBe('stale')
    for (const s of ['error', 'permission_required', 'unavailable', 'unsupported', 'not_scanned'] as const) expect(coverageState(h({ status: s }), now, 1000)).toBe(s)
  })
})

describe('SnapshotService + persistence', () => {
  function setup(states: Record<string, FakeState>) {
    const db = openDatabase(':memory:')
    const bus = new EventBus(new EventRepo(db), 0)
    const inv = new InventoryService({ db, collectors: Object.entries(states).map(([id, s]) => fakeCollector(id, s)), makeContext: () => ctxFor(tmpRoot()), bus, platform: 'linux' })
    // Same clock as the fixture host (collector timestamps), so freshness is judged consistently.
    let t = Date.parse('2026-01-01T00:00:00.000Z')
    const svc = new SnapshotService({ db, inventory: inv, appVersion: '9.9.9', freshMs: () => 3_600_000, clock: () => new Date((t += 60_000)) })
    return { db, inv, svc }
  }
  const usb = (k: string, over = {}) => obs(k, { source: 'a', name: k, ...over })

  it('stores a self-contained copy with versions, machine id and per-collector coverage', async () => {
    const a: FakeState = { result: complete([usb('d1', { properties: [{ key: 'speed', value: 480, source: 'a', sourceProperty: 'x', evidence: 'os_reported', observedAt: T0 }], relationships: [{ targetKey: 'd0', type: 'bus_attachment', directness: 'reported', source: 'a', confidence: 1, observedAt: T0 }] }), usb('d2')]) }
    const { inv, svc, db } = setup({ a })
    const m = await svc.create({ label: ' before ' })
    expect(m).toMatchObject({ label: 'before', appVersion: '9.9.9', schemaVersion: MIGRATIONS.at(-1)!.version, deviceCount: 2, relationshipCount: 1, propertyCount: 1, complete: true, categoryCounts: { usb: 2 } })
    expect(m.machineId).toMatch(/^[0-9a-f-]{36}$/)
    expect(m.collectors[0]).toMatchObject({ id: 'a', state: 'complete', deviceCount: 2 })
    // mutate current inventory afterwards: the snapshot must not change
    a.result = complete([usb('d1', { name: 'renamed' })])
    await inv.scan()
    const stored = svc.repo.getDevices(m.id).devices
    expect(stored.map((d) => d.name).sort()).toEqual(['d1', 'd2'])
    expect(stored.find((d) => d.key === 'd1')!.properties[0]).toMatchObject({ key: 'speed', value: 480, source: 'a', sourceProperty: 'x' })
    expect(stored.find((d) => d.key === 'd1')!.relationships[0]).toMatchObject({ targetKey: 'd0', directness: 'reported' })
    expect((await svc.create()).machineId).toBe(m.machineId) // stable local identity
    void db
  })

  it('records failed/partial collectors so the snapshot is not called complete', async () => {
    const a: FakeState = { result: complete([usb('d1')]) }
    const b: FakeState = { result: complete([obs('p1', { source: 'b', category: 'pci' })]) }
    const { inv, svc } = setup({ a, b })
    await inv.scan()
    a.result = new Error('sysfs exploded')
    b.result = { outcome: 'partial', observations: [obs('p1', { source: 'b', category: 'pci' })], limitations: [{ kind: 'permission', message: 'denied' }] }
    const m = await svc.create()
    expect(m.complete).toBe(false)
    expect(m.collectors.map((c) => [c.id, c.state])).toEqual([['a', 'error'], ['b', 'partial']])
    expect(m.limitations.join()).toMatch(/a: error/)
    expect(m.deviceCount).toBe(2) // last-known device of the failed collector is kept but its coverage says it is not authoritative
  })

  it('REGRESSION (end to end): a failed collector between two snapshots cannot produce a confirmed removal', async () => {
    const a: FakeState = { result: complete([usb('d1'), usb('d2')]) }
    const { svc } = setup({ a })
    const s1 = await svc.create({ label: 'ok' })
    a.result = new Error('collector down')
    const s2 = await svc.create({ label: 'failed' })
    const r = svc.compare(s1.id, s2.id)
    expect(r.summary.removed).toBe(0)
    expect(r.changes.some((c) => c.kind === 'coverage_changed' && c.after === 'error')).toBe(true)
    expect(r.uncertain).toBe(true)
    // and a genuine removal, with healthy collectors, is confirmed
    a.result = complete([usb('d1')])
    const s3 = await svc.create({ label: 'recovered' })
    const r2 = svc.compare(s1.id, s3.id)
    expect(r2.summary).toMatchObject({ removed: 1, added: 0 })
    expect(r2.uncertain).toBe(false)
  })

  it('compare validates input; delete removes exactly the selected snapshots and their records', async () => {
    const a: FakeState = { result: complete([usb('d1')]) }
    const { svc, db } = setup({ a })
    const [s1, s2, s3] = [await svc.create(), await svc.create(), await svc.create()]
    expect(() => svc.compare(s1!.id, s1!.id)).toThrow(/two different/)
    expect(() => svc.compare(s1!.id, 'nope')).toThrow(/not found/)
    expect(svc.delete([s1!.id, s1!.id, 'unknown'])).toBe(1)
    expect(svc.list().map((m) => m.id).sort()).toEqual([s2!.id, s3!.id].sort())
    expect((db.prepare('SELECT COUNT(*) c FROM snapshot_device_records WHERE snapshot_id = ?').get(s1!.id) as { c: number }).c).toBe(0)
    expect((db.prepare('SELECT COUNT(*) c FROM snapshot_device_records WHERE snapshot_id = ?').get(s2!.id) as { c: number }).c).toBe(1)
    expect(svc.list()).toHaveLength(2) // no automatic retention removed anything else
  })

  it('counts unreadable records instead of hiding them', async () => {
    const a: FakeState = { result: complete([usb('d1'), usb('d2')]) }
    const { svc, db } = setup({ a })
    const s1 = await svc.create(); const s2 = await svc.create()
    db.prepare("UPDATE snapshot_device_records SET record = 'garbage' WHERE snapshot_id = ? AND device_key = 'd1'").run(s2.id)
    db.prepare("UPDATE snapshot_device_records SET record = '{\"key\":\"d2\"}' WHERE snapshot_id = ? AND device_key = 'd2'").run(s2.id)
    const r = svc.compare(s1.id, s2.id)
    expect(r.skippedRecords).toBe(2)
    expect(r.summary.removed).toBe(0) // unreadable ≠ removed
    expect(r.summary.indeterminate).toBe(2)
    expect(r.reasons.join()).toMatch(/could not be read/)
    expect(r.uncertain).toBe(true)
  })

  it('survives a v2→v3 migration with a pre-existing snapshot (no coverage info ⇒ never "complete")', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, MIGRATIONS.slice(0, 2))
    db.prepare("INSERT INTO systems (id, platform, created_at) VALUES ('local','linux','x')").run()
    db.prepare("INSERT INTO inventory_snapshots (id, system_id, created_at, label, device_count) VALUES ('old','local','2025-01-01','legacy',3)").run()
    db.prepare("INSERT INTO snapshot_device_records (snapshot_id, device_key, record) VALUES ('old','k','{}')").run()
    migrate(db, MIGRATIONS)
    const repo = new SnapshotRepo(db)
    const m = repo.getMeta('old')!
    expect(m).toMatchObject({ label: 'legacy', deviceCount: 3, complete: false, collectors: [], appVersion: null, machineId: null })
    expect(repo.getDevices('old')).toEqual({ devices: [], skipped: 1, skippedKeys: ['k'] })
    expect(db.prepare('SELECT COUNT(*) c FROM snapshot_device_records').get()).toMatchObject({ c: 1 })
  })

  it('snapshot creation is atomic: a failing insert leaves no partial snapshot', () => {
    const db = openDatabase(':memory:')
    const repo = new SnapshotRepo(db)
    db.prepare("INSERT INTO systems (id, platform, created_at) VALUES ('local','linux','x')").run()
    const m = meta('s', [cov('A')])
    expect(() => repo.insert(m, [dev('k'), { ...dev('k2'), key: undefined as unknown as string }])).toThrow()
    expect(repo.list()).toHaveLength(0)
    expect((db.prepare('SELECT COUNT(*) c FROM snapshot_device_records').get() as { c: number }).c).toBe(0)
  })

  it('compares large snapshots quickly', () => {
    const many = (suffix: string) => Array.from({ length: 5000 }, (_, i) => dev(`k${i}`, { properties: [prop('p', i + (suffix === 'b' && i % 50 === 0 ? 1 : 0))] }))
    const t0 = performance.now()
    const r = compareSnapshots(snap('s1', many('a')), snap('s2', many('b'), [cov('A')], T1))
    expect(r.summary.changed).toBe(100)
    expect(performance.now() - t0).toBeLessThan(2000)
  })
})

describe('snapshot IPC validation', () => {
  const origins = { appUrlPrefix: 'file:///app/out/renderer' }
  const url = 'file:///app/out/renderer/index.html'
  const handlers = Object.fromEntries(IPC_CHANNELS.map((c) => [c, async (i: unknown) => i])) as unknown as Handlers
  it('rejects malformed requests', async () => {
    const bad: [string, unknown][] = [
      ['snapshots:get', {}], ['snapshots:create', { label: 'x'.repeat(81) }], ['snapshots:create', { rescan: 'yes' }], ['snapshots:create', { path: '/etc' }],
      ['snapshots:compare', { baseId: 'a' }], ['snapshots:compare', { baseId: '', targetId: 'b' }], ['snapshots:compare', { baseId: 'a', targetId: 'b', includeVolatile: 1 }],
      ['snapshots:delete', {}], ['snapshots:delete', { ids: [] }], ['snapshots:delete', { ids: Array.from({ length: 51 }, (_, i) => `i${i}`) }], ['snapshots:delete', { ids: [5] }], ['snapshots:list', 1]
    ]
    for (const [c, p] of bad) await expect(dispatch(c, p, url, handlers, origins), `${c} ${JSON.stringify(p)}`).rejects.toMatchObject({ code: 'INVALID_PAYLOAD' })
    await expect(dispatch('snapshots:delete', { ids: ['a'] }, url, handlers, origins)).resolves.toEqual({ ids: ['a'] })
  })
})
