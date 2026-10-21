import { describe, expect, it } from 'vitest'
import { compareDevices, differenceCount } from '../src/renderer/pages/compare-logic'
import type { DeviceDetail } from '../src/shared/schemas'

const dev = (id: string, category: string, over: Record<string, unknown>, props: Record<string, string | number>, extra: Record<string, { volatile?: boolean; sensitive?: boolean }> = {}): DeviceDetail =>
  ({ device: { id, category, name: id, manufacturer: null, model: null, vendorId: null, productId: null, busType: null, driver: null, subtype: null, status: 'ok', ...over }, identifiers: [], relationships: [], events: [],
    properties: Object.entries(props).map(([key, value]) => ({ key, value, source: 's', sourceProperty: `p/${key}`, evidence: 'os_reported', observedAt: 't', ...(extra[key] ?? {}) })) }) as unknown as DeviceDetail

describe('compareDevices', () => {
  it('classifies same / different / one-sided, with sources', () => {
    const r = compareDevices(dev('a', 'storage', { model: 'X', driver: 'nvme' }, { size: 10, fw: 'A' }), dev('b', 'storage', { model: 'Y', driver: 'nvme' }, { size: 10, only: 1 }))
    if ('error' in r) throw new Error(r.error)
    const by = Object.fromEntries(r.map((x) => [x.key, x]))
    expect(by.model).toMatchObject({ status: 'different', a: 'X', b: 'Y' })
    expect(by.driver!.status).toBe('same')
    expect(by.size!.status).toBe('same')
    expect(by.fw).toMatchObject({ status: 'only_a', aSource: 's · p/fw' })
    expect(by.only!.status).toBe('only_b')
    expect(differenceCount(r)).toBe(3)
  })
  it('refuses cross-category and self comparison', () => {
    expect(compareDevices(dev('a', 'usb', {}, {}), dev('b', 'pci', {}, {}))).toHaveProperty('error')
    expect(compareDevices(dev('a', 'usb', {}, {}), dev('a', 'usb', {}, {}))).toHaveProperty('error')
  })
  it('does not count live readings as differences and masks sensitive values', () => {
    const r = compareDevices(dev('a', 'sensor', {}, { temp: 40, serial: 'SN1' }, { temp: { volatile: true }, serial: { sensitive: true } }), dev('b', 'sensor', {}, { temp: 55, serial: 'SN2' }, { temp: { volatile: true }, serial: { sensitive: true } }))
    if ('error' in r) throw new Error(r.error)
    expect(differenceCount(r)).toBe(1) // only the (masked) serial
    const serial = r.find((x) => x.key === 'serial')!
    expect(serial.a).toBe('••••')
    expect(JSON.stringify(r)).not.toMatch(/SN1|SN2/)
  })
})
