import { describe, expect, it } from 'vitest'
import { matrix } from '../src/renderer/pages/collector-matrix'
import { rowsOf } from '../src/renderer/pages/sensor-rows'
import type { CollectorHealth, DeviceDetail } from '../src/shared/schemas'

const h = (over: Partial<CollectorHealth>): CollectorHealth => ({ id: 'c', version: '1', categories: ['pci'], platforms: ['linux'], status: 'available', partial: false, limitations: [], permissions: [], deviceCount: 2, ...over }) as unknown as CollectorHealth

describe('capability matrix', () => {
  it('derives coverage only from collector health', () => {
    const rows = matrix([
      h({ id: 'a', categories: ['pci'] }),
      h({ id: 'b', categories: ['storage'], status: 'permission_required', deviceCount: 0, limitations: [{ kind: 'permission', message: 'x' }] as never }),
      h({ id: 'c2', categories: ['usb'], partial: true }),
      h({ id: 'd', categories: ['display'], status: 'unsupported', deviceCount: null }),
      h({ id: 'e', categories: ['audio'], status: 'error' })
    ])
    const by = Object.fromEntries(rows.map((r) => [r.category, r]))
    expect(by.pci).toMatchObject({ coverage: 'full', tone: 'ok', devices: 2, privileged: false })
    expect(by.storage).toMatchObject({ coverage: 'permission needed', privileged: true })
    expect(by.usb?.coverage).toBe('limited')
    expect(by.display).toMatchObject({ coverage: 'not collected', collectors: [], devices: null })
    expect(by.audio?.coverage).toBe('failed')
  })
  it('does not call an info-only limitation "limited"', () => {
    expect(matrix([h({ limitations: [{ kind: 'info', message: 'fyi' }] as never })])[0]!.coverage).toBe('full')
  })
})

describe('sensor registry rows', () => {
  it('keeps only measurement channels and attaches driver-reported limits', () => {
    const p = (key: string, value: number) => ({ key, value, unit: '°C', source: 'linux.sensors', sourceProperty: '/sys/x', evidence: 'measured', observedAt: '2026-01-01T00:00:00Z' })
    const rows = rowsOf([{ device: { id: 'd1', name: 'coretemp' }, properties: [p('temperature:Package id 0', 50), p('temperature_crit:Package id 0', 100), p('channel_count', 1), p('fan:fan1', 3000)] } as unknown as DeviceDetail])
    expect(rows.map((r) => r.label)).toEqual(['Package id 0', 'fan1'])
    expect(rows[0]!.crit?.value).toBe(100)
    expect(rows[1]!.max).toBeUndefined()
  })
})
