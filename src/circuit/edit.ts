import { canAdd, defOf, defaultProps, findPin, nextPartId } from './parts'
import type { Design, PartKind, PinRef, PropValue } from './types'

export const GRID = 10
export const snap = (n: number): number => Math.round(n / GRID) * GRID

export function addPart(d: Design, kind: PartKind, x: number, y: number, def?: string): { design: Design; id: string } | null {
  if (!canAdd(d, kind) || d.parts.length >= 60) return null
  if (kind === 'custom' && !d.customs?.some((c) => c.id === def)) return null
  const id = nextPartId(d, kind)
  return { id, design: { ...d, parts: [...d.parts, { id, kind, x: snap(x), y: snap(y), props: defaultProps(kind), ...(kind === 'custom' ? { def } : {}) }] } }
}

export const movePart = (d: Design, id: string, x: number, y: number): Design => ({ ...d, parts: d.parts.map((p) => (p.id === id ? { ...p, x: snap(x), y: snap(y) } : p)) })

/** Removing a part also removes every wire attached to it. */
export const removePart = (d: Design, id: string): Design => ({ ...d, parts: d.parts.filter((p) => p.id !== id), wires: d.wires.filter((w) => w.a.part !== id && w.b.part !== id) })

export const removeWire = (d: Design, id: string): Design => ({ ...d, wires: d.wires.filter((w) => w.id !== id) })

const same = (a: PinRef, b: PinRef): boolean => a.part === b.part && a.pin === b.pin

export function addWire(d: Design, a: PinRef, b: PinRef): { design: Design; id: string } | { error: string } {
  if (same(a, b)) return { error: 'A wire needs two different pins.' }
  for (const r of [a, b]) {
    const part = d.parts.find((p) => p.id === r.part)
    if (!part || !findPin(defOf(d, part), r.pin)) return { error: 'That pin does not exist.' }
  }
  if (d.wires.some((w) => (same(w.a, a) && same(w.b, b)) || (same(w.a, b) && same(w.b, a)))) return { error: 'Those pins are already wired together.' }
  if (d.wires.length >= 300) return { error: 'Too many wires (limit 300).' }
  let n = d.wires.length + 1
  while (d.wires.some((w) => w.id === `w${n}`)) n++
  const id = `w${n}`
  return { id, design: { ...d, wires: [...d.wires, { id, a, b }] } }
}

export const setProp = (d: Design, id: string, key: string, value: PropValue): Design => ({ ...d, parts: d.parts.map((p) => (p.id === id ? { ...p, props: { ...p.props, [key]: value } } : p)) })

export const setFirmwarePin = (d: Design, key: string, gpio: number): Design => ({ ...d, firmware: { ...d.firmware, [key]: gpio } })
