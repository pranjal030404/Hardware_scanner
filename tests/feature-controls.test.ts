import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/main/database/db'
import { InventoryRepo, SettingsRepo } from '../src/main/database/repositories'
import { EventBus } from '../src/main/services/event-bus'
import { InventoryService } from '../src/main/services/inventory'
import { MetricsService } from '../src/main/services/metrics'
import { SysReader } from '@collectors/core/sysreader'
import { deviceIdFromKey } from '@collectors/core/normalize'
import { SettingsSchema } from '@shared/schemas'
import type { MetricProvider } from '../src/metrics/types'
import { countEnabled, setAllEnabled, setEnabled } from '../src/renderer/pages/feature-controls'
import { visibleNav } from '../src/renderer/nav'
import { complete, fakeCollector, obs, type FakeState } from './helpers/factory'
import { ctxFor, tmpRoot } from './helpers/fixtures'

describe('feature-control list helpers', () => {
  it('switches single ids and whole groups without touching other entries', () => {
    expect(setEnabled([], 'a', false)).toEqual(['a'])
    expect(setEnabled(['a', 'b'], 'a', true)).toEqual(['b'])
    expect(setEnabled(['a'], 'a', false)).toEqual(['a']) // no duplicates
    expect(setAllEnabled(['x', 'a'], ['a', 'b'], false)).toEqual(['x', 'a', 'b'])
    expect(setAllEnabled(['x', 'a', 'b'], ['a', 'b'], true)).toEqual(['x'])
    expect(countEnabled(['a', 'x'], ['a', 'b', 'c'])).toBe(2)
  })

  it('never hides Overview or Settings from the sidebar', () => {
    const pages = visibleNav(['overview', 'settings', 'topology']).map((n) => n.page)
    expect(pages).toContain('overview')
    expect(pages).toContain('settings')
    expect(pages).not.toContain('topology')
  })

  it('new settings default to everything on and validate their values', () => {
    const s = SettingsSchema.parse({})
    expect(s).toMatchObject({ disabledCollectors: [], metricsDisabledProviders: [], hiddenPages: [] })
    const repo = new SettingsRepo(openDatabase(':memory:'))
    expect(repo.set('disabledCollectors', ['linux.usb']).disabledCollectors).toEqual(['linux.usb'])
    expect(() => repo.set('hiddenPages', 'topology')).toThrow()
  })
})

describe('disabled collectors', () => {
  it('are skipped by scans, keep their devices and are reported as disabled', async () => {
    const db = openDatabase(':memory:')
    let off: string[] = []
    const a: FakeState = { result: complete([obs('d1', { source: 'a', name: 'd1' })]) }
    const svc = new InventoryService({ db, collectors: [fakeCollector('a', a)], makeContext: () => ctxFor(tmpRoot()), bus: new EventBus(null), platform: 'linux', disabled: () => off })
    await svc.scan()
    off = ['a']
    a.result = complete([]) // would mark d1 missing if the collector ran
    const s = await svc.scan()
    expect(s.collectors).toEqual({ ok: 0, failed: 0, unavailable: 0 })
    expect(svc.repo.list({}).map((d) => d.key)).toEqual(['d1'])
    expect(svc.getHealth(1, Date.now() + 10_000).find((h) => h.id === 'a')).toMatchObject({ disabled: true, status: 'available' })
    off = []
    await svc.scan()
    expect(svc.repo.list({})).toHaveLength(0)
  })
})

describe('disabled metric providers', () => {
  it('are not sampled and resume from a fresh baseline when switched back on', async () => {
    const db = openDatabase(':memory:')
    new InventoryRepo(db).ensureSystem('linux', '2026-01-01T00:00:00Z')
    new InventoryRepo(db).upsert(deviceIdFromKey('dev:1'), obs('dev:1', { category: 'cpu', name: 'dev:1' }), 'h', '2026-01-01T00:00:00Z')
    let calls = 0
    const prevs: unknown[] = []
    const p: MetricProvider = {
      id: 'p', title: 'p', platforms: ['linux'], metrics: [], isSupported: async () => true,
      async sample(_c, prev) { calls++; prevs.push(prev); return { readings: [], status: 'ok', next: calls } }
    }
    let s = SettingsSchema.parse({})
    const root = tmpRoot()
    const svc = new MetricsService({
      db, providers: [p], platform: 'linux', getSettings: () => s,
      makeContext: (m) => ({ reader: new SysReader(root), os: { cpus: () => [], totalmem: () => 0, freemem: () => 0 }, monoMs: m })
    })
    await svc.start()
    expect(calls).toBe(1)
    s = { ...s, metricsDisabledProviders: ['p'] }
    await svc.tick()
    expect(calls).toBe(1)
    expect(svc.status().providers[0]).toMatchObject({ status: 'disabled' })
    s = { ...s, metricsDisabledProviders: [] }
    await svc.tick()
    expect(calls).toBe(2)
    expect(prevs.at(-1)).toBeUndefined()
    svc.stop()
  })
})
