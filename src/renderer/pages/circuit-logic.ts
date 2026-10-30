import { defOf, partHeight, pinPosition, routeWire } from '../../circuit/parts'
import { netRails, net } from '../../circuit/netlist'
import { boardRect } from '../../circuit/board'
import type { PartState, Report } from '../../circuit/engine'
import type { Design, PartKind, Rail, Wire } from '../../circuit/types'

export const CANVAS = { w: 2400, h: 1800 }

export const STATE_COLOR: Record<PartState, string> = { ok: '#16a34a', warn: '#d97706', fault: '#dc2626', off: '#9ca3af', idle: '#64748b', 'n/a': 'transparent' }
export const RAIL_COLOR: Record<Rail | 'signal', string> = { GND: '#6b7280', '3V3': '#e8890c', '5V': '#dc2626', VBAT: '#c026d3', signal: '#0d9488' }

/** Colour a wire by the rail its net carries; nets that carry no rail are signals. */
export function wireColor(design: Design, report: Report, w: Wire): string {
  const rails = netRails(design, report.netlist, net(report.netlist, w.a.part, w.a.pin))
  return rails.length === 1 ? RAIL_COLOR[rails[0]!] : rails.length > 1 ? '#000' : RAIL_COLOR.signal
}

export function wirePoints(design: Design, w: Wire, lane = 0): string | null {
  const pa = design.parts.find((p) => p.id === w.a.part), pb = design.parts.find((p) => p.id === w.b.part)
  if (!pa || !pb) return null
  const a = pinPosition(pa, w.a.pin, defOf(design, pa)), b = pinPosition(pb, w.b.pin, defOf(design, pb))
  return a && b ? routeWire(a, b, lane).map((p) => `${p.x},${p.y}`).join(' ') : null
}

/** Horizontal offset that spreads parallel wires apart: stable per wire, within ±18 px. */
export function laneOf(id: string): number {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return ((h % 7) - 3) * 6
}

export interface Box { x: number; y: number; w: number; h: number }
const MIN_BOX = { w: 760, h: 440 }

/** The area to show: the board and every part with padding, never smaller than a comfortable working area. */
export function fitBox(design: Design): Box {
  const b = boardRect(design.board)
  let x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h
  for (const p of design.parts) {
    const def = defOf(design, p)
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + def.w); y1 = Math.max(y1, p.y + partHeight(def))
  }
  const pad = 50
  const w = Math.max(MIN_BOX.w, x1 - x0 + pad * 2), h = Math.max(MIN_BOX.h, y1 - y0 + pad * 2)
  return { x: Math.round(x0 - pad - (w - (x1 - x0 + pad * 2)) / 2), y: Math.round(y0 - pad - (h - (y1 - y0 + pad * 2)) / 2), w: Math.round(w), h: Math.round(h) }
}

/** Parts may be dragged anywhere in a generous world; the view re-fits when the drag ends. */
export const clampPos = (x: number, y: number, w: number, h: number): { x: number; y: number } => ({ x: Math.min(CANVAS.w - w, Math.max(-CANVAS.w, x)), y: Math.min(CANVAS.h - h, Math.max(-CANVAS.h, y)) })

/** Snap a coordinate to a step (board hole pitch, or the fine grid when there are no holes). */
export const snapTo = (n: number, step: number): number => (step > 1 ? Math.round(n / step) * step : n)

export const fmtRuntime = (h: number | null): string => (h === null ? '—' : h >= 100 ? '100+ h' : `${h.toFixed(1)} h`)

export const partLabel = (design: Design, id: string): string => {
  const p = design.parts.find((x) => x.id === id)
  return p ? `${defOf(design, p).name} (${id})` : id
}

export const LED_COLORS = ['#ef4444', '#22c55e', '#3b82f6', '#f8fafc', '#eab308'] as const
export const LED_NAMES = ['Red', 'Green', 'Blue', 'White', 'Yellow'] as const

/** An editable property of a part, shown in the Selected panel. */
export interface PropField { key: string; label: string; kind: 'number' | 'bool' | 'select'; min?: number; max?: number; step?: number; options?: readonly (readonly [number, string])[] }

export const PROP_FIELDS: Partial<Record<PartKind, PropField[]>> = {
  resistor: [{ key: 'ohms', label: 'Resistance (Ω)', kind: 'number', min: 1, max: 100_000_000 }],
  capacitor: [{ key: 'uF', label: 'Capacitance (µF)', kind: 'number', min: 0.001, max: 100_000, step: 0.1 }],
  inductor: [{ key: 'mH', label: 'Inductance (mH)', kind: 'number', min: 0.001, max: 100_000, step: 0.1 }],
  led: [{ key: 'color', label: 'Colour', kind: 'select', options: LED_NAMES.map((n, i) => [i, n] as const) }],
  pot: [{ key: 'ohms', label: 'Total resistance (Ω)', kind: 'number', min: 100, max: 10_000_000 }, { key: 'pos', label: 'Wiper position', kind: 'number', min: 0, max: 1, step: 0.01 }],
  npn: [{ key: 'beta', label: 'Gain (β)', kind: 'number', min: 10, max: 500 }],
  pnp: [{ key: 'beta', label: 'Gain (β)', kind: 'number', min: 10, max: 500 }],
  nmos: [{ key: 'vth', label: 'Gate threshold (V)', kind: 'number', min: 0.5, max: 6, step: 0.1 }],
  pmos: [{ key: 'vth', label: 'Gate threshold (V)', kind: 'number', min: 0.5, max: 6, step: 0.1 }],
  regulator: [{ key: 'vout', label: 'Output (V)', kind: 'number', min: 0.8, max: 24, step: 0.1 }, { key: 'buck', label: 'Buck converter (otherwise LDO)', kind: 'bool' }],
  buzzer: [{ key: 'ohms', label: 'Coil resistance (Ω)', kind: 'number', min: 10, max: 10_000 }],
  battery: [{ key: 'mAh', label: 'Capacity (mAh)', kind: 'number', min: 50, max: 20_000 }],
  sensor: [{ key: 'tempC', label: 'Temperature (°C)', kind: 'number', min: -40, max: 125, step: 0.5 }],
  fuse: [{ key: 'amps', label: 'Rating (A)', kind: 'number', min: 0.01, max: 100, step: 0.05 }, { key: 'blown', label: 'Blown (open circuit)', kind: 'bool' }],
  ldr: [{ key: 'lux', label: 'Illuminance (lx)', kind: 'number', min: 0, max: 200_000, step: 1 }],
  thermistor: [
    { key: 'r25', label: 'R at 25 °C (Ω)', kind: 'number', min: 100, max: 1_000_000 },
    { key: 'beta', label: 'β (K)', kind: 'number', min: 500, max: 9000 },
    { key: 'tempC', label: 'Temperature (°C)', kind: 'number', min: -40, max: 150, step: 0.5 }
  ],
  motor: [{ key: 'ohms', label: 'Winding resistance (Ω)', kind: 'number', min: 1, max: 1000 }],
  fan: [{ key: 'ohms', label: 'Resistance (Ω)', kind: 'number', min: 1, max: 10_000 }]
}

export const GROUP_LABEL = { module: 'Modules', power: 'Power', passive: 'Passives', active: 'Active', custom: 'Custom' } as const
