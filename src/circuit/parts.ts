import type { BuiltinKind, CustomDef, Design, PartInst, PartKind, PropValue, Rail } from './types'

export type PinType = 'gnd' | 'vin' | 'vout' | 'gpio' | 'signal' | 'passive'
export interface PinDef { id: string; label: string; type: PinType; rail?: Rail; gpio?: number }
/** A part that is powered from one pin (against ground) and draws a resistive load while powered. */
export interface SupplyDef { pin: string; gnd: string; vmin: number; vmax: number; absMax: number; mA: number; nominal: number }
export type PartGroup = 'module' | 'power' | 'passive' | 'active' | 'custom'
export interface PartDef {
  kind: PartKind
  group: PartGroup
  name: string
  w: number
  left: PinDef[]
  right: PinDef[]
  /** Pins that are connected inside the part (e.g. the two GND pins of a dev board). */
  ties: string[][]
  supply?: SupplyDef
  /** Module-level pull-ups from the supply pin to these signal pins. */
  pullups?: { pins: string[]; ohms: number }
  unique: boolean
  props: Record<string, PropValue>
  accent: string
}

export const INPUT_ONLY = [34, 35, 36, 39] as const
/** Strapping pins that can stop a boot when loaded externally (GPIO5 only affects SDIO slave timing, so it is left out). */
export const STRAPPING = [0, 2, 12, 15] as const
export const ADC2 = [0, 2, 4, 12, 13, 14, 15, 25, 26, 27] as const
export const ESP_GPIOS = [0, 2, 4, 5, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39] as const

const g = (n: number): PinDef => ({ id: `G${n}`, label: `GPIO${n}`, type: 'gpio', gpio: n })
const sig = (id: string, label = id): PinDef => ({ id, label, type: 'signal' })
const pas = (id: string, label = id): PinDef => ({ id, label, type: 'passive' })
const gnd = (id: string, label = 'GND'): PinDef => ({ id, label, type: 'gnd', rail: 'GND' })
const vin = (id: string, label = id): PinDef => ({ id, label, type: 'vin' })
const vout = (id: string, rail: Rail, label = id): PinDef => ({ id, label, type: 'vout', rail })

export const PART_DEFS: Record<BuiltinKind, PartDef> = {
  esp32: {
    kind: 'esp32', group: 'module', name: 'ESP32 DevKit', w: 150, accent: '#2f3b52', unique: true, props: {},
    left: [vout('3V3', '3V3', '3V3'), sig('EN'), g(36), g(39), g(34), g(35), g(32), g(33), g(25), g(26), g(27), g(14), g(12), gnd('GND1'), g(13), vin('VIN', 'VIN · 5V')],
    right: [gnd('GND2'), g(23), g(22), g(21), g(19), g(18), g(5), g(17), g(16), g(4), g(0), g(2), g(15)],
    ties: [['GND1', 'GND2']],
    supply: { pin: '3V3', gnd: 'GND1', vmin: 3.0, vmax: 3.6, absMax: 3.9, mA: 80, nominal: 3.3 }
  },
  oled: {
    kind: 'oled', group: 'module', name: 'OLED 128×64 (I²C)', w: 160, accent: '#7a5b00', unique: true, props: {},
    left: [], right: [vin('VDD'), gnd('GND'), sig('SCK', 'SCK/SCL'), sig('SDA')],
    ties: [], supply: { pin: 'VDD', gnd: 'GND', vmin: 3.0, vmax: 5.5, absMax: 6.0, mA: 20, nominal: 3.3 }, pullups: { pins: ['SDA', 'SCK'], ohms: 10000 }
  },
  encoder: {
    kind: 'encoder', group: 'module', name: 'Rotary encoder', w: 140, accent: '#3a3a3a', unique: true, props: {},
    left: [], right: [sig('CLK'), sig('DT'), sig('SW'), vin('PLUS', '+'), gnd('GND')],
    ties: [], supply: { pin: 'PLUS', gnd: 'GND', vmin: 2.3, vmax: 5.5, absMax: 6.0, mA: 1, nominal: 3.3 }, pullups: { pins: ['CLK', 'DT', 'SW'], ohms: 10000 }
  },
  dac: {
    kind: 'dac', group: 'module', name: 'PCM5102A DAC', w: 120, accent: '#5b2a86', unique: true, props: {},
    left: [], right: [vin('VIN'), gnd('GND'), sig('LCK'), sig('DIN'), sig('BCK'), sig('SCK')],
    ties: [], supply: { pin: 'VIN', gnd: 'GND', vmin: 3.0, vmax: 5.5, absMax: 6.0, mA: 12, nominal: 5 }
  },
  sd: {
    kind: 'sd', group: 'module', name: 'microSD (SPI)', w: 130, accent: '#1d5f8c', unique: true, props: { card: true },
    left: [gnd('GND'), sig('MISO'), sig('CLK'), sig('MOSI'), sig('CS'), vin('V3', '3V3')], right: [],
    ties: [], supply: { pin: 'V3', gnd: 'GND', vmin: 2.7, vmax: 3.6, absMax: 3.9, mA: 30, nominal: 3.3 }
  },
  battery: {
    kind: 'battery', group: 'power', name: 'Li-ion battery', w: 110, accent: '#4b6b4b', unique: true, props: { voltage: 3.7, mAh: 2000 },
    left: [], right: [vout('P', 'VBAT', '+'), gnd('N', '−')], ties: []
  },
  charger: {
    kind: 'charger', group: 'power', name: 'Charger / 5V boost', w: 140, accent: '#222', unique: true, props: {},
    left: [pas('BP', 'B+'), pas('BN', 'B−')], right: [vout('OP', '5V', '5V+'), gnd('ON', '5V−')], ties: []
  },
  switch: { kind: 'switch', group: 'passive', name: 'Switch', w: 90, accent: '#555', unique: false, props: { closed: true }, left: [pas('A')], right: [pas('B')], ties: [] },
  resistor: { kind: 'resistor', group: 'passive', name: 'Resistor', w: 90, accent: '#a0763c', unique: false, props: { ohms: 47000 }, left: [pas('A')], right: [pas('B')], ties: [] },
  capacitor: { kind: 'capacitor', group: 'passive', name: 'Capacitor', w: 90, accent: '#2d5f7a', unique: false, props: { uF: 10 }, left: [pas('A')], right: [pas('B')], ties: [] },
  inductor: { kind: 'inductor', group: 'passive', name: 'Inductor', w: 90, accent: '#6b4a2d', unique: false, props: { mH: 10 }, left: [pas('A')], right: [pas('B')], ties: [] },
  diode: { kind: 'diode', group: 'passive', name: 'Diode', w: 90, accent: '#3d3d46', unique: false, props: {}, left: [pas('A', 'A ▸')], right: [pas('K', '▸| K')], ties: [] },
  led: { kind: 'led', group: 'passive', name: 'LED', w: 90, accent: '#3d3d46', unique: false, props: { color: 0 }, left: [pas('A', 'A ▸')], right: [pas('K', '▸| K')], ties: [] },
  pot: { kind: 'pot', group: 'passive', name: 'Potentiometer', w: 130, accent: '#44546a', unique: false, props: { ohms: 10000, pos: 0.5 }, left: [pas('A')], right: [pas('W'), pas('B')], ties: [] },
  button: { kind: 'button', group: 'passive', name: 'Push button', w: 100, accent: '#555', unique: false, props: { pressed: false }, left: [pas('A')], right: [pas('B')], ties: [] },
  npn: { kind: 'npn', group: 'active', name: 'NPN transistor', w: 130, accent: '#46463a', unique: false, props: { beta: 100 }, left: [pas('B')], right: [pas('C'), pas('E')], ties: [] },
  pnp: { kind: 'pnp', group: 'active', name: 'PNP transistor', w: 130, accent: '#46463a', unique: false, props: { beta: 100 }, left: [pas('B')], right: [pas('C'), pas('E')], ties: [] },
  nmos: { kind: 'nmos', group: 'active', name: 'N-MOSFET', w: 100, accent: '#3a4646', unique: false, props: { vth: 2 }, left: [pas('G')], right: [pas('D'), pas('S')], ties: [] },
  pmos: { kind: 'pmos', group: 'active', name: 'P-MOSFET', w: 100, accent: '#3a4646', unique: false, props: { vth: 2 }, left: [pas('G')], right: [pas('D'), pas('S')], ties: [] },
  opamp: {
    kind: 'opamp', group: 'active', name: 'Op-amp', w: 100, accent: '#2f4a3a', unique: false, props: {},
    left: [sig('INP', 'IN+'), sig('INN', 'IN−')], right: [vin('VCC'), sig('OUT'), gnd('GND')], ties: [],
    supply: { pin: 'VCC', gnd: 'GND', vmin: 3.0, vmax: 32, absMax: 36, mA: 1, nominal: 5 }
  },
  regulator: { kind: 'regulator', group: 'power', name: 'Regulator (LDO/buck)', w: 165, accent: '#4a3a2f', unique: false, props: { vout: 3.3, buck: false }, left: [vin('IN'), gnd('GND')], right: [pas('OUT')], ties: [] },
  sensor: {
    kind: 'sensor', group: 'module', name: 'I²C sensor', w: 120, accent: '#2f5a4a', unique: false, props: { tempC: 24.5 },
    left: [], right: [vin('VCC'), gnd('GND'), sig('SDA'), sig('SCL')], ties: [],
    supply: { pin: 'VCC', gnd: 'GND', vmin: 1.8, vmax: 3.6, absMax: 4.0, mA: 1, nominal: 3.3 }, pullups: { pins: ['SDA', 'SCL'], ohms: 10000 }
  },
  buzzer: { kind: 'buzzer', group: 'module', name: 'Buzzer', w: 90, accent: '#4a2f3a', unique: false, props: { ohms: 150 }, left: [pas('P', '+')], right: [pas('N', '−')], ties: [] },
  relay: { kind: 'relay', group: 'module', name: 'Relay (5 V coil)', w: 140, accent: '#2f3a5a', unique: false, props: {}, left: [pas('CP', 'COIL+'), pas('CN', 'COIL−')], right: [pas('COM'), pas('NO'), pas('NC')], ties: [] },
  servo: {
    kind: 'servo', group: 'module', name: 'Servo', w: 110, accent: '#5a4a2f', unique: true, props: {},
    left: [], right: [vin('VCC', 'V+'), gnd('GND'), sig('SIG')], ties: [],
    supply: { pin: 'VCC', gnd: 'GND', vmin: 4.0, vmax: 6.0, absMax: 7.0, mA: 150, nominal: 5 }
  },
  usb: { kind: 'usb', group: 'power', name: 'USB 5 V', w: 110, accent: '#3a3a3a', unique: true, props: { plugged: true }, left: [], right: [vout('VBUS', '5V', 'VBUS'), pas('DP', 'D+'), pas('DN', 'D−'), gnd('GND')], ties: [] },
  rgb: {
    kind: 'rgb', group: 'passive', name: 'RGB LED (common cathode)', w: 130, accent: '#3d3d46', unique: false, props: {},
    left: [pas('R', 'R ▸'), pas('G', 'G ▸'), pas('B', 'B ▸')], right: [pas('K', '▾ K')], ties: []
  },
  fuse: {
    kind: 'fuse', group: 'passive', name: 'Fuse', w: 90, accent: '#8a6d3b', unique: false, props: { amps: 0.5, blown: false },
    left: [pas('A')], right: [pas('B')], ties: []
  },
  ldr: {
    kind: 'ldr', group: 'passive', name: 'LDR (light sensor)', w: 120, accent: '#7a6a2f', unique: false, props: { lux: 100 },
    left: [pas('A')], right: [pas('B')], ties: []
  },
  thermistor: {
    kind: 'thermistor', group: 'passive', name: 'Thermistor (NTC)', w: 120, accent: '#3f6b5a', unique: false, props: { r25: 10000, beta: 3950, tempC: 25 },
    left: [pas('A')], right: [pas('B')], ties: []
  },
  motor: {
    kind: 'motor', group: 'active', name: 'DC motor', w: 100, accent: '#4a4a55', unique: false, props: { ohms: 12 },
    left: [pas('A', '+')], right: [pas('B', '−')], ties: []
  },
  fan: {
    kind: 'fan', group: 'active', name: 'Fan', w: 100, accent: '#3a4a52', unique: false, props: { ohms: 50 },
    left: [pas('A', '+')], right: [pas('B', '−')], ties: []
  },
  header: {
    kind: 'header', group: 'passive', name: 'Header 2×4', w: 110, accent: '#2f3a3a', unique: false, props: {},
    left: [pas('A1', '1'), pas('A2', '2'), pas('A3', '3'), pas('A4', '4')],
    right: [pas('B1', '1'), pas('B2', '2'), pas('B3', '3'), pas('B4', '4')], ties: []
  }
}

const FALLBACK: PartDef = { kind: 'custom', group: 'custom', name: 'Missing custom part', w: 120, accent: '#7f1d1d', left: [], right: [], ties: [], unique: false, props: {} }
const customCache = new WeakMap<CustomDef, PartDef>()

/** Turn a user-defined part into the same PartDef shape the built-ins use. */
export function customToPartDef(c: CustomDef): PartDef {
  const hit = customCache.get(c)
  if (hit) return hit
  const pin = (p: CustomDef['pins'][number]): PinDef => (p.type === 'gnd' ? gnd(p.id, p.label) : p.type === 'power' ? vin(p.id, p.label) : p.type === 'signal' ? sig(p.id, p.label) : pas(p.id, p.label))
  const power = c.pins.find((p) => p.type === 'power'), ground = c.pins.find((p) => p.type === 'gnd')
  const def: PartDef = {
    kind: 'custom', group: 'custom', name: c.name, w: Math.min(260, Math.max(130, c.name.length * 8 + 40)), accent: c.accent, unique: false, props: {}, ties: [],
    left: c.pins.filter((p) => p.side === 'L').map(pin), right: c.pins.filter((p) => p.side === 'R').map(pin)
  }
  if (c.supply && power && ground) def.supply = { pin: power.id, gnd: ground.id, vmin: c.supply.vmin, vmax: c.supply.vmax, absMax: c.supply.vmax + 0.3, mA: c.supply.mA, nominal: Math.min(Math.max(3.3, c.supply.vmin), c.supply.vmax) }
  customCache.set(c, def)
  return def
}

/** The definition of one placed part, built-in or custom. */
export function defOf(design: Pick<Design, 'customs'>, p: Pick<PartInst, 'kind' | 'def'>): PartDef {
  if (p.kind !== 'custom') return PART_DEFS[p.kind]
  const c = design.customs?.find((x) => x.id === p.def)
  return c ? customToPartDef(c) : FALLBACK
}

export const PIN_PITCH = 20
export const HEADER = 26
const PAD = 8

export const allPins = (def: PartDef): PinDef[] => [...def.left, ...def.right]
export const partHeight = (def: PartDef): number => HEADER + Math.max(def.left.length, def.right.length, 2) * PIN_PITCH + PAD
export const findPin = (def: PartDef, id: string): PinDef | undefined => allPins(def).find((p) => p.id === id)

/** Pin position relative to the part origin, plus the side its wire leaves from. */
export function pinOffset(def: PartDef, id: string): { x: number; y: number; dir: -1 | 1 } | null {
  const li = def.left.findIndex((p) => p.id === id)
  if (li >= 0) return { x: 0, y: HEADER + li * PIN_PITCH + PIN_PITCH / 2, dir: -1 }
  const ri = def.right.findIndex((p) => p.id === id)
  if (ri >= 0) return { x: def.w, y: HEADER + ri * PIN_PITCH + PIN_PITCH / 2, dir: 1 }
  return null
}

export function pinPosition(part: PartInst, id: string, def: PartDef): { x: number; y: number; dir: -1 | 1 } | null {
  const o = pinOffset(def, id)
  return o ? { x: part.x + o.x, y: part.y + o.y, dir: o.dir } : null
}

export const defaultProps = (kind: PartKind): Record<string, PropValue> => (kind === 'custom' ? {} : { ...PART_DEFS[kind].props })

/** Orthogonal wire path between two pin positions. */
export function routeWire(a: { x: number; y: number; dir: -1 | 1 }, b: { x: number; y: number; dir: -1 | 1 }, lane = 0): { x: number; y: number }[] {
  const a1 = { x: a.x + a.dir * 14, y: a.y }
  const b1 = { x: b.x + b.dir * 14, y: b.y }
  const xm = a.dir !== b.dir ? (a1.x + b1.x) / 2 : (a.dir > 0 ? Math.max(a1.x, b1.x) : Math.min(a1.x, b1.x)) + a.dir * 14
  const xl = xm + lane
  return [{ x: a.x, y: a.y }, a1, { x: xl, y: a1.y }, { x: xl, y: b1.y }, b1, { x: b.x, y: b.y }]
}

export function nextPartId(design: Design, kind: PartKind): string {
  const used = new Set(design.parts.map((p) => p.id))
  for (let i = 1; ; i++) if (!used.has(`${kind}${i}`)) return `${kind}${i}`
}

export const canAdd = (design: Design, kind: PartKind): boolean => kind === 'custom' || !PART_DEFS[kind].unique || !design.parts.some((p) => p.kind === kind)
