import type { CustomDef, CustomPin, CustomPinType } from './types'

export const MAX_CUSTOMS = 10
export const MAX_CUSTOM_PINS = 24
const TYPES: CustomPinType[] = ['power', 'gnd', 'signal', 'passive']

export interface CustomSpec { name: string; pins: string; vmin: number; vmax: number; mA: number; accent?: string }

/**
 * Parse the builder's pin list. One pin per comma or line, as `NAME` or `NAME:type` or `NAME:type:L|R`.
 * Pins with no side alternate left/right. Types: power, gnd, signal (default), passive.
 */
export function parseCustom(spec: CustomSpec, existingIds: string[]): { def: CustomDef } | { error: string } {
  const name = spec.name.trim()
  if (!name || name.length > 30) return { error: 'Give the part a name (up to 30 characters).' }
  const raw = spec.pins.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
  if (raw.length < 1) return { error: 'Add at least one pin, for example: VCC:power, GND:gnd, SDA, SCL.' }
  if (raw.length > MAX_CUSTOM_PINS) return { error: `At most ${MAX_CUSTOM_PINS} pins.` }
  const pins: CustomPin[] = []
  for (let i = 0; i < raw.length; i++) {
    const [label = '', t = 'signal', side] = raw[i]!.split(':').map((s) => s.trim())
    const id = label.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 12)
    if (!id || !/^[A-Za-z0-9_]+$/.test(id)) return { error: `Pin “${raw[i]}” needs a name.` }
    if (pins.some((p) => p.id === id)) return { error: `Pin name “${id}” is used twice.` }
    if (!(TYPES as string[]).includes(t)) return { error: `Pin “${label}”: type must be power, gnd, signal or passive.` }
    if (side !== undefined && side !== 'L' && side !== 'R') return { error: `Pin “${label}”: side must be L or R.` }
    pins.push({ id, label: label.slice(0, 12), type: t as CustomPinType, side: (side as 'L' | 'R' | undefined) ?? (i % 2 === 0 ? 'L' : 'R') })
  }
  const power = pins.filter((p) => p.type === 'power').length, ground = pins.filter((p) => p.type === 'gnd').length
  const supply = power >= 1 && ground >= 1
  if (supply) {
    if (!(spec.vmin >= 0 && spec.vmax > spec.vmin && spec.vmax <= 60)) return { error: 'Supply range: max must be above min (and at most 60 V).' }
    if (!(spec.mA >= 0 && spec.mA <= 5000)) return { error: 'Load must be between 0 and 5000 mA.' }
  }
  let n = 1
  while (existingIds.includes(`c${n}`)) n++
  const def: CustomDef = { id: `c${n}`, name, accent: /^#[0-9a-f]{6}$/i.test(spec.accent ?? '') ? spec.accent! : '#4b4b6b', pins, ...(supply ? { supply: { vmin: spec.vmin, vmax: spec.vmax, mA: spec.mA } } : {}) }
  return { def }
}
