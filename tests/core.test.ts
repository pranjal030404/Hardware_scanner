import { describe, expect, it } from 'vitest'
import { contentHash, deviceIdFromKey, diffObservations, mergeObservations } from '@collectors/core/normalize'
import { parseIds } from '@collectors/core/ids'
import { parseSmbiosType17 } from '@collectors/linux/memory'
import { meaningful } from '@collectors/core/context'
import { obs, AT } from './helpers/factory'
import { PCI_IDS } from './helpers/fixtures'

const prop = (key: string, value: string | number, source = 'a', volatile = false) => ({ key, value, source, sourceProperty: 'x', evidence: 'os_reported' as const, observedAt: AT, ...(volatile ? { volatile: true } : {}) })

describe('identity & dedup', () => {
  it('derives a stable opaque id from the key', () => {
    expect(deviceIdFromKey('usb:1:2:sn:A')).toBe(deviceIdFromKey('usb:1:2:sn:A'))
    expect(deviceIdFromKey('usb:1:2:sn:A')).not.toBe(deviceIdFromKey('usb:1:2:sn:B'))
    expect(deviceIdFromKey('x')).toMatch(/^[0-9a-f]{20}$/)
  })
  it('merges observations of the same device, keeping per-field provenance', () => {
    const a = obs('d', { source: 'c1', manufacturer: 'Acme', fieldSources: { manufacturer: { source: 'c1', sourceProperty: 'p1', evidence: 'os_reported' } }, properties: [prop('temp', 40, 'c1')], identifiers: [{ kind: 'serial', value: '1' }] })
    const b = obs('d', { source: 'c2', manufacturer: 'Other', model: 'M1', fieldSources: { model: { source: 'c2', sourceProperty: 'p2', evidence: 'measured' } }, properties: [prop('temp', 41, 'c2'), prop('fan', 1, 'c2')], identifiers: [{ kind: 'serial', value: '1' }, { kind: 'mac', value: 'x' }] })
    const [m, ...rest] = mergeObservations([a, b])
    expect(rest).toHaveLength(0)
    expect(m!.manufacturer).toBe('Acme') // first wins
    expect(m!.model).toBe('M1') // gap filled…
    expect(m!.fieldSources.model!.source).toBe('c2') // …with the provenance of who reported it
    expect(m!.properties.filter((p) => p.key === 'temp').map((p) => p.source).sort()).toEqual(['c1', 'c2']) // disagreement stays visible
    expect(m!.identifiers).toHaveLength(2)
    expect(m!.source).toBe('c1')
  })
  it('an error from any source is not hidden by another source saying ok', () => {
    const [m] = mergeObservations([obs('d', { status: 'ok' }), obs('d', { status: 'error' })])
    expect(m!.status).toBe('error')
  })
  it('does not mutate inputs', () => {
    const a = obs('d', { properties: [prop('x', 1)] })
    mergeObservations([a, obs('d', { properties: [prop('y', 2)] })])
    expect(a.properties).toHaveLength(1)
  })
})

describe('change detection', () => {
  it('ignores volatile properties and timestamps but sees real changes', () => {
    const base = obs('d', { properties: [prop('cap', 50, 'a', true), prop('size', 100)] })
    const volatileOnly = obs('d', { observedAt: '2027-01-01T00:00:00Z', properties: [prop('cap', 49, 'a', true), prop('size', 100)] })
    const real = obs('d', { properties: [prop('cap', 50, 'a', true), prop('size', 200)] })
    expect(contentHash(volatileOnly)).toBe(contentHash(base))
    expect(contentHash(real)).not.toBe(contentHash(base))
    expect(diffObservations(base, real)).toEqual(['size: 100 → 200'])
    expect(diffObservations(base, obs('d', { name: 'new', properties: base.properties }))).toEqual(['name: d → new'])
  })
  it('is insensitive to ordering', () => {
    const a = obs('d', { identifiers: [{ kind: 'a', value: '1' }, { kind: 'b', value: '2' }] })
    const b = obs('d', { identifiers: [{ kind: 'b', value: '2' }, { kind: 'a', value: '1' }] })
    expect(contentHash(a)).toBe(contentHash(b))
  })
})

describe('helpers', () => {
  it('treats OEM placeholders as unavailable', () => {
    for (const v of ['To Be Filled By O.E.M.', 'Default string', 'Not Specified', 'System Product Name', 'None', '  ', '0000', undefined]) expect(meaningful(v as string)).toBeUndefined()
    expect(meaningful(' HP ')).toBe('HP')
  })
  it('parses pci.ids vendors, devices and classes', () => {
    const db = parseIds(PCI_IDS)
    expect(db.vendor('8086')).toBe('Intel Corporation')
    expect(db.device('8086', '9A2F')).toBe('Wi-Fi 6 AX201')
    expect(db.device('8086', 'ffff')).toBeUndefined()
    expect(db.className('0604')).toBe('PCI bridge')
    expect(db.className('06')).toBe('Bridge')
  })
  it('parses SMBIOS type 17 and treats an empty slot as no module', () => {
    const header = Buffer.alloc(0x22)
    header[0] = 17; header[1] = 0x22
    header.writeUInt16LE(8192, 0x0c) // 8 GiB
    header[0x0e] = 0x0d // SODIMM
    header[0x10] = 1; header[0x11] = 2 // locator, bank string idx
    header[0x12] = 0x22 // DDR5
    header.writeUInt16LE(4800, 0x15)
    header[0x17] = 3 // manufacturer
    header[0x1a] = 4 // part number
    const strings = Buffer.from('ChannelA-DIMM0\0BANK 0\0Micron\0MTC8C1084S1SC48BA1\0\0', 'latin1')
    const raw = Buffer.concat([header, strings])
    expect(parseSmbiosType17(raw)).toMatchObject({ sizeMiB: 8192, type: 'DDR5', formFactor: 'SODIMM', locator: 'ChannelA-DIMM0', manufacturer: 'Micron', partNumber: 'MTC8C1084S1SC48BA1', speedMTs: 4800 })
    const empty = Buffer.from(raw); empty.writeUInt16LE(0, 0x0c)
    expect(parseSmbiosType17(empty)).toBeUndefined()
    expect(parseSmbiosType17(Buffer.alloc(4))).toBeUndefined()
  })
})
