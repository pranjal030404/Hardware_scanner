import type { DeviceDetail, Property } from '@shared/schemas'

export type CompareStatus = 'same' | 'different' | 'only_a' | 'only_b'

export interface CompareRow {
  key: string
  /** Identity fields come from the device record; the rest are collected properties. */
  group: 'identity' | 'property'
  a?: string
  b?: string
  aSource?: string
  bSource?: string
  status: CompareStatus
  /** Live readings differ between any two moments; they are shown but never counted as a real difference. */
  volatile: boolean
  sensitive: boolean
}

const IDENTITY: [string, (d: DeviceDetail) => string | null][] = [
  ['manufacturer', (d) => d.device.manufacturer], ['model', (d) => d.device.model], ['vendor id', (d) => d.device.vendorId], ['product id', (d) => d.device.productId],
  ['bus', (d) => d.device.busType], ['driver', (d) => d.device.driver], ['subtype', (d) => d.device.subtype], ['status', (d) => d.device.status]
]

const show = (p: Property): string => `${String(p.value)}${p.unit ? ` ${p.unit}` : ''}`

/** Sensitive values (serials, MACs) are masked so a comparison can be screenshotted or shared safely. */
const mask = (v: string, sensitive: boolean): string => (sensitive ? '••••' : v)

/**
 * Compare two devices of the SAME category. Different categories share too few fields for the result to mean
 * anything, so that is refused instead of producing a misleading wall of "only in A" rows.
 */
export function compareDevices(a: DeviceDetail, b: DeviceDetail): CompareRow[] | { error: string } {
  if (a.device.id === b.device.id) return { error: 'Choose two different devices.' }
  if (a.device.category !== b.device.category) return { error: 'Only devices of the same category can be compared.' }
  const rows: CompareRow[] = []
  for (const [label, get] of IDENTITY) {
    const av = get(a) ?? undefined, bv = get(b) ?? undefined
    if (av === undefined && bv === undefined) continue
    rows.push({ key: label, group: 'identity', a: av, b: bv, status: av === undefined ? 'only_b' : bv === undefined ? 'only_a' : av === bv ? 'same' : 'different', volatile: false, sensitive: false })
  }
  const pa = new Map(a.properties.map((p) => [p.key, p])), pb = new Map(b.properties.map((p) => [p.key, p]))
  for (const key of [...new Set([...pa.keys(), ...pb.keys()])].sort()) {
    const x = pa.get(key), y = pb.get(key)
    const sensitive = !!(x?.sensitive || y?.sensitive)
    const av = x ? show(x) : undefined, bv = y ? show(y) : undefined
    rows.push({
      key, group: 'property',
      a: av === undefined ? undefined : mask(av, sensitive), b: bv === undefined ? undefined : mask(bv, sensitive),
      aSource: x && `${x.source} · ${x.sourceProperty}`, bSource: y && `${y.source} · ${y.sourceProperty}`,
      status: !x ? 'only_b' : !y ? 'only_a' : av === bv ? 'same' : 'different', volatile: !!(x?.volatile || y?.volatile), sensitive
    })
  }
  return rows
}

export const differenceCount = (rows: CompareRow[]): number => rows.filter((r) => r.status !== 'same' && !r.volatile).length
