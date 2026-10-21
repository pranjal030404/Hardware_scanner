import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../src/main/database/db'
import { EventRepo } from '../src/main/database/repositories'
import { EventBus } from '../src/main/services/event-bus'
import { MonitorService, parseUdevLine, type UdevEvent, type WatcherFactory } from '../src/main/services/monitor'
import type { InventoryService } from '../src/main/services/inventory'

describe('EventBus', () => {
  it('validates events', () => {
    const bus = new EventBus(null)
    expect(() => bus.publish({ type: 'nope' as never, summary: 'x' })).toThrow(/Invalid event/)
    expect(() => bus.publish({ type: 'device.updated', summary: 'x', category: 'toaster' as never })).toThrow()
  })
  it('suppresses identical events inside the window only, persisting history types only', () => {
    let t = 0
    const db = openDatabase(':memory:'); const repo = new EventRepo(db)
    const bus = new EventBus(repo, 2000, () => t)
    const got: string[] = []
    bus.subscribe((e) => got.push(e.type))
    bus.publish({ type: 'device.connected', summary: 'USB mouse connected', deviceId: 'a' })
    t = 500; bus.publish({ type: 'device.connected', summary: 'USB mouse connected', deviceId: 'a' })
    t = 600; bus.publish({ type: 'device.connected', summary: 'USB mouse connected', deviceId: 'b' }) // different device
    t = 3000; bus.publish({ type: 'device.connected', summary: 'USB mouse connected', deviceId: 'a' })
    bus.publish({ type: 'monitor.status_changed', summary: 'polling' })
    expect(got).toEqual(['device.connected', 'device.connected', 'device.connected', 'monitor.status_changed'])
    expect(repo.recent(10).map((e) => e.type)).toEqual(['device.connected', 'device.connected', 'device.connected']) // transient not stored
  })
  it('a throwing listener does not break others', () => {
    const bus = new EventBus(null, 0)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let ok = false
    bus.subscribe(() => { throw new Error('x') })
    bus.subscribe(() => (ok = true))
    bus.publish({ type: 'device.updated', summary: 'y' })
    expect(ok).toBe(true); spy.mockRestore()
  })
})

describe('udev parsing', () => {
  it('parses monitor lines and ignores noise', () => {
    expect(parseUdevLine('UDEV  [1234.567890] add      /devices/pci0000:00/0000:00:14.0/usb3/3-1 (usb)')).toEqual({ action: 'add', devpath: '/devices/pci0000:00/0000:00:14.0/usb3/3-1', subsystem: 'usb' })
    expect(parseUdevLine('UDEV  [5.1] remove   /devices/x/block/sdb (block)')?.action).toBe('remove')
    expect(parseUdevLine('monitor will print the received events for:')).toBeUndefined()
    expect(parseUdevLine('')).toBeUndefined()
  })
})

describe('MonitorService', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const mkInv = () => {
    const scan = vi.fn(async () => ({}) as never)
    return { inv: { scan, scanning: false } as unknown as InventoryService, scan }
  }
  function harness(factory: WatcherFactory | null) {
    const { inv, scan } = mkInv()
    const statuses: string[] = []
    const bus = new EventBus(null, 0)
    bus.subscribe((e) => e.type === 'monitor.status_changed' && statuses.push(String(e.data['mode']) + (e.data['degraded'] ? '!' : '')))
    const m = new MonitorService(inv, bus, { intervalSec: 60, debounceMs: 100, minGapMs: 0 }, factory)
    return { m, scan, statuses }
  }

  it('debounces a burst of udev events into a single rescan', async () => {
    let emit!: (e: UdevEvent) => void
    const { m, scan } = harness((on) => ((emit = on), { stop() {} }))
    m.start()
    await vi.advanceTimersByTimeAsync(0)
    scan.mockClear()
    for (let i = 0; i < 20; i++) emit({ action: 'add', devpath: `/d/${i}`, subsystem: 'usb' })
    await vi.advanceTimersByTimeAsync(99); expect(scan).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10); expect(scan).toHaveBeenCalledTimes(1)
    m.stop()
  })
  it('polls on the configured interval as a safety net and honours pause/resume', async () => {
    const { m, scan } = harness(() => ({ stop() {} }))
    m.start(); await vi.advanceTimersByTimeAsync(0); scan.mockClear()
    await vi.advanceTimersByTimeAsync(60_000); expect(scan).toHaveBeenCalledTimes(1)
    expect(m.setPaused(true).mode).toBe('paused')
    await vi.advanceTimersByTimeAsync(180_000); expect(scan).toHaveBeenCalledTimes(1)
    expect(m.setPaused(false).mode).toBe('udev')
    await vi.advanceTimersByTimeAsync(0); expect(scan).toHaveBeenCalledTimes(2) // rescan on resume to recover missed events
    m.stop()
  })
  it('degrades visibly to polling when native notifications are unavailable', () => {
    const none = harness(null); none.m.start()
    expect(none.m.status()).toMatchObject({ mode: 'polling', degraded: true })
    expect(none.m.status().message).toMatch(/not available/)
    const failing = harness(() => null); failing.m.start()
    expect(failing.m.status()).toMatchObject({ mode: 'polling', degraded: true })
    none.m.stop(); failing.m.stop()
  })
  it('restarts a crashed watcher with backoff and rescans through polling meanwhile', async () => {
    let onExit!: (r: string) => void; let starts = 0
    const { m, statuses } = harness((_e, x) => ((onExit = x), starts++, { stop() {} }))
    m.start(); expect(starts).toBe(1)
    onExit('udevadm exited (1)')
    expect(m.status()).toMatchObject({ mode: 'polling', degraded: true })
    await vi.advanceTimersByTimeAsync(2100)
    expect(starts).toBe(2); expect(m.status()).toMatchObject({ mode: 'udev', degraded: false })
    expect(statuses).toContain('polling!')
    m.stop()
  })
})
