import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/database/db'
import { EventRepo } from '../src/main/database/repositories'
import { EventBus } from '../src/main/services/event-bus'
import { InventoryService } from '../src/main/services/inventory'
import type { HipEvent } from '@shared/schemas'
import { complete, fakeCollector, obs, type FakeState } from './helpers/factory'
import { ctxFor, tmpRoot } from './helpers/fixtures'

function setup(states: Record<string, FakeState>) {
  const db = openDatabase(':memory:')
  const events: HipEvent[] = []
  let t = 1_700_000_000_000
  const bus = new EventBus(new EventRepo(db), 0, () => (t += 1000))
  bus.subscribe((e) => events.push(e))
  const collectors = Object.entries(states).map(([id, s]) => fakeCollector(id, s))
  const root = tmpRoot()
  const svc = new InventoryService({ db, collectors, makeContext: () => ctxFor(root), bus, platform: 'linux' })
  return { svc, events, db, types: () => events.map((e) => e.type) }
}
const usb = (k: string, over = {}) => obs(k, { source: 'a', name: k, ...over })

describe('InventoryService scan semantics', () => {
  it('baseline scan stores devices without a flood of connect events', async () => {
    const { svc, types } = setup({ a: { result: complete([usb('d1'), usb('d2')]) } })
    const s = await svc.scan()
    expect(s).toMatchObject({ devices: 2, added: 2, removed: 0 })
    expect(svc.repo.list({})).toHaveLength(2)
    expect(types().filter((t) => t.startsWith('device.'))).toEqual([])
  })

  it('plug-in and unplug produce connected/disconnected events and flip presence', async () => {
    const st: FakeState = { result: complete([usb('d1')]) }
    const { svc, events } = setup({ a: st })
    await svc.scan()
    st.result = complete([usb('d1'), usb('d2', { name: 'New Mouse' })])
    await svc.scan()
    expect(events.find((e) => e.type === 'device.connected')).toMatchObject({ deviceName: 'New Mouse', summary: 'New Mouse connected', data: { firstSeen: true } })
    st.result = complete([usb('d1')])
    await svc.scan()
    expect(events.find((e) => e.type === 'device.disconnected')).toMatchObject({ deviceName: 'New Mouse' })
    expect(svc.repo.list({}).map((d) => d.key)).toEqual(['d1'])
    expect(svc.repo.list({ includeMissing: true })).toHaveLength(2)
    st.result = complete([usb('d1'), usb('d2', { name: 'New Mouse' })])
    await svc.scan()
    expect(events.filter((e) => e.type === 'device.connected').at(-1)).toMatchObject({ summary: 'New Mouse reconnected', data: { returning: true } })
    expect(svc.repo.list({})).toHaveLength(2)
  })

  it('a failing collector never removes devices and surfaces collector.failed once', async () => {
    const st: FakeState = { result: complete([usb('d1')]) }
    const { svc, events } = setup({ a: st })
    await svc.scan()
    st.result = new Error('sysfs exploded')
    await svc.scan(); await svc.scan()
    expect(svc.repo.list({})).toHaveLength(1)
    expect(events.filter((e) => e.type === 'collector.failed')).toHaveLength(1)
    const h = svc.getHealth().find((c) => c.id === 'a')!
    expect(h).toMatchObject({ status: 'error', message: 'sysfs exploded', deviceCount: null })
    expect(h.lastSuccessAt).not.toBeNull() // last good scan is remembered
    st.result = complete([usb('d1')])
    await svc.scan()
    expect(svc.getHealth().find((c) => c.id === 'a')!.status).toBe('available')
  })

  it('permission-limited (partial) or unavailable collectors cannot mark devices missing', async () => {
    const st: FakeState = { result: complete([usb('d1')]) }
    const { svc, events } = setup({ a: st })
    await svc.scan()
    st.result = { outcome: 'partial', observations: [], limitations: [{ kind: 'permission', message: 'denied' }] }
    await svc.scan()
    st.result = { outcome: 'permission_required', observations: [], limitations: [{ kind: 'permission', message: 'denied' }] }
    await svc.scan()
    st.result = { outcome: 'unavailable', observations: [], limitations: [] }
    await svc.scan()
    expect(svc.repo.list({})).toHaveLength(1)
    expect(events.some((e) => e.type === 'device.disconnected')).toBe(false)
    expect(svc.getHealth()[0]!.status).toBe('unavailable')
  })

  it('only the collector that owns a device can make it disappear', async () => {
    const a: FakeState = { result: complete([usb('da')]) }
    const b: FakeState = { result: complete([obs('db', { source: 'b' })]) }
    const { svc } = setup({ a, b })
    await svc.scan()
    b.result = new Error('b down')
    a.result = complete([]) // a legitimately reports nothing
    await svc.scan()
    expect(svc.repo.list({}).map((d) => d.key)).toEqual(['db']) // da gone, db retained
  })

  it('emits device.updated with a field-level diff, and status_changed for status transitions', async () => {
    const st: FakeState = { result: complete([usb('d1', { driver: 'old' })]) }
    const { svc, events } = setup({ a: st })
    await svc.scan()
    st.result = complete([usb('d1', { driver: 'new' })])
    await svc.scan()
    expect(events.find((e) => e.type === 'device.updated')).toMatchObject({ data: { changes: ['driver: old → new'] } })
    st.result = complete([usb('d1', { driver: 'new', status: 'error' })])
    await svc.scan()
    expect(events.find((e) => e.type === 'device.status_changed')).toMatchObject({ summary: 'd1: status ok → error' })
  })

  it('volatile changes refresh stored values silently', async () => {
    const p = (v: number) => [{ key: 'rx', value: v, source: 'a', sourceProperty: 'x', evidence: 'measured' as const, observedAt: '2026-01-01T00:00:00Z', volatile: true }]
    const st: FakeState = { result: complete([usb('d1', { properties: p(1) })]) }
    const { svc, events } = setup({ a: st })
    await svc.scan()
    st.result = complete([usb('d1', { properties: p(999) })])
    await svc.scan()
    expect(events.filter((e) => e.type.startsWith('device.'))).toHaveLength(0)
    const id = svc.repo.list({})[0]!.id
    expect(svc.repo.get(id, [])!.properties[0]!.value).toBe(999)
  })

  it('coalesces overlapping scan requests into one run plus one follow-up', async () => {
    let runs = 0
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const st: FakeState = { result: async () => { runs++; await gate; return complete([usb('d1')]) } }
    const { svc } = setup({ a: st })
    const p1 = svc.scan(); const p2 = svc.scan(); const p3 = svc.scan()
    expect(p1).toBe(p2); expect(p2).toBe(p3)
    release()
    await p1
    await new Promise((r) => setTimeout(r, 50))
    expect(runs).toBe(2)
  })

  it('merges duplicate observations across collectors into one device', async () => {
    const a: FakeState = { result: complete([usb('d1', { manufacturer: 'Acme' })]) }
    const b: FakeState = { result: complete([obs('d1', { source: 'b', model: 'M' })]) }
    const { svc } = setup({ a, b })
    const s = await svc.scan()
    expect(s.devices).toBe(1)
    const d = svc.repo.list({})[0]!
    expect(d).toMatchObject({ manufacturer: 'Acme', model: 'M', source: 'a' })
  })

  it('supplementary collectors enrich but can never create or overwrite a device on their own', async () => {
    const prop = (k: string) => ({ key: k, value: 1, source: 'smart', sourceProperty: 'x', evidence: 'measured' as const, observedAt: '2026-01-01T00:00:00Z' })
    const main: FakeState = { result: complete([usb('disk', { name: 'Samsung SSD', properties: [{ ...prop('size'), source: 'a' }] })]) }
    const smart: FakeState = { result: complete([obs('disk', { source: 'smart', name: 'smart-model', properties: [prop('smart_passed')] }), obs('ghost', { source: 'smart' })]) }
    const db = openDatabase(':memory:')
    const bus = new EventBus(new EventRepo(db), 0)
    const svc = new InventoryService({ db, collectors: [fakeCollector('a', main), fakeCollector('smart', smart, { supplementary: true })], makeContext: () => ctxFor(tmpRoot()), bus, platform: 'linux' })
    await svc.scan()
    expect(svc.repo.list({}).map((d) => d.key)).toEqual(['disk']) // 'ghost' was not created
    const id = svc.repo.list({})[0]!.id
    expect(svc.repo.get(id, [])!.properties.map((p) => p.key).sort()).toEqual(['size', 'smart_passed'])
    // The primary collector fails: SMART alone must not replace the stored record.
    main.result = new Error('storage collector down')
    await svc.scan()
    const d = svc.repo.get(id, [])!
    expect(d.device.name).toBe('Samsung SSD')
    expect(d.properties.map((p) => p.key).sort()).toEqual(['size', 'smart_passed'])
  })

  it('reports stale collectors instead of silently "available"', async () => {
    const { svc } = setup({ a: { result: complete([]) } })
    await svc.scan()
    const h = svc.getHealth(1000, Date.parse(svc.getHealth()[0]!.lastSuccessAt!) + 60_000)
    expect(h[0]!.status).toBe('stale')
  })

  it('marks collectors unsupported on other platforms and does not run them', async () => {
    const db = openDatabase(':memory:')
    const win = fakeCollector('w', { result: complete([usb('x')]) }, { platforms: ['win32'] })
    const svc = new InventoryService({ db, collectors: [win], makeContext: () => ctxFor(tmpRoot()), bus: new EventBus(null), platform: 'linux' })
    await svc.scan()
    expect(svc.getHealth()[0]!.status).toBe('unsupported')
    expect(svc.repo.list({})).toHaveLength(0)
  })

  it('stores a large inventory quickly (performance smoke)', async () => {
    const many = Array.from({ length: 3000 }, (_, i) => usb(`d${i}`, { properties: [{ key: 'n', value: i, source: 'a', sourceProperty: 'x', evidence: 'os_reported', observedAt: '2026-01-01T00:00:00Z' }] }))
    const st: FakeState = { result: complete(many) }
    const { svc } = setup({ a: st })
    const t0 = performance.now()
    await svc.scan()
    const first = performance.now() - t0
    const t1 = performance.now()
    await svc.scan()
    const second = performance.now() - t1
    expect(svc.repo.list({})).toHaveLength(3000)
    expect(svc.repo.list({ search: 'd299' }).length).toBeGreaterThan(0)
    console.log(`3000 devices: first scan ${first.toFixed(0)}ms, rescan ${second.toFixed(0)}ms`)
    expect(first).toBeLessThan(5000)
    expect(second).toBeLessThan(5000)
  }, 60_000)
})
