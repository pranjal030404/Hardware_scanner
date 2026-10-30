import { defOf } from './parts'
import { isConnected, net, netRails, type Netlist } from './netlist'
import { solveLinear } from './solver'
import type { Design, PartInst } from './types'

export type SupplyLevel = 'ok' | 'high' | 'damaged' | 'low' | 'none'
export interface PartPower { supplyV: number; grounded: boolean; powered: boolean; level: SupplyLevel; mA: number }
/** Operating state of a part with a non-linear or switching model. */
export interface ElementState {
  on: boolean
  /** Current through the part in amps (forward current, collector/drain current, coil current, regulator output). */
  amps: number
  /** Part specific: transistor saturation ratio, op-amp mode (1 high, -1 low, 0 linear), regulator output volts. */
  value?: number
  /** RGB LED only: current per channel (R, G, B) in amps. */
  channels?: [number, number, number]
}
export interface Electrical {
  /** Voltage per net, relative to the solver's reference (compare nets by difference only). */
  v: number[]
  parts: Record<string, PartPower>
  elements: Record<string, ElementState>
  battery: { id: string; volts: number; amps: number; tripped: boolean } | null
  boost: { on: boolean; outA: number; tripped: boolean } | null
  ldoOn: boolean
  /** False when the on/off states of the non-linear parts were still changing at the iteration limit. */
  converged: boolean
  faults: string[]
}

const GMIN = 1e-9
/** Ground nets sit on the ideal reference through 1 kΩ. A supply whose return is not wired can then only push current through ~2 kΩ, so its loads starve instead of being powered by an undefined ground. */
const GROUND_LEAK = 1e-3
const BATTERY_R = 0.15
const BOOST_R = 0.3
const LDO_R = 0.5
const BOOST_EFF = 0.85
const BATTERY_TRIP_A = 3
const BOOST_TRIP_A = 2
const MAX_ITER = 40
export const LED_VF = [1.9, 2.1, 3.0, 3.1, 2.0] as const
export const RGB_CHANNELS = ['R', 'G', 'B'] as const
/** Forward drop per RGB channel: a red die needs less than a blue one. */
export const RGB_VF = { R: 1.9, G: 2.1, B: 3.0 } as const
const DIODE_VF = 0.7
const DIODE_R = 1
const LED_R = 2
const REG_R = 0.2
const FUSE_R = 0.02

const num = (p: PartInst, k: string, d: number): number => { const v = p.props[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d }
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))
export const forwardDrop = (p: PartInst): number => (p.kind === 'led' ? LED_VF[clamp(Math.round(num(p, 'color', 0)), 0, LED_VF.length - 1)]! : DIODE_VF)

/** Light-dependent resistor: bright light lowers the resistance (about 9.9 kΩ at 100 lx, 1 MΩ in the dark). */
export const ldrOhms = (lux: number): number => Math.min(1e6, Math.max(50, 1e6 / (1 + clamp(lux, 0, 200_000))))

/** NTC thermistor: resistance falls as temperature rises (β equation around 25 °C). */
export const thermistorOhms = (r25: number, beta: number, tempC: number): number =>
  Math.min(1e7, Math.max(10, clamp(r25, 10, 1e7) * Math.exp(clamp(beta, 500, 9000) * (1 / (clamp(tempC, -55, 150) + 273.15) - 1 / 298.15))))

/** Steady-state resistance of the two-terminal parts that behave as plain resistors at DC. */
export function twoTerminalOhms(p: PartInst): number {
  if (p.kind === 'ldr') return ldrOhms(num(p, 'lux', 100))
  if (p.kind === 'thermistor') return thermistorOhms(num(p, 'r25', 10000), num(p, 'beta', 3950), num(p, 'tempC', 25))
  if (p.kind === 'motor' || p.kind === 'fan') return Math.max(1, num(p, 'ohms', 12))
  return 0
}


function levelOf(v: number, s: { vmin: number; vmax: number; absMax: number }): SupplyLevel {
  if (v > s.absMax) return 'damaged'
  if (v > s.vmax) return 'high'
  if (v >= s.vmin) return 'ok'
  return v < 0.5 ? 'none' : 'low'
}

/**
 * DC operating point by nodal analysis. Sources are Norton equivalents (ideal source + series
 * resistance), loads are resistors, and the non-linear parts (diodes, LEDs, transistors, relays,
 * op-amp saturation, regulators, the boost converter, brown-out and protection trips) are resolved
 * by iterating on their on/off state until it stops changing.
 */
export function simulate(design: Design, nl: Netlist): Electrical {
  const N = nl.nets.length
  const powered: Record<string, boolean> = {}
  for (const p of design.parts) powered[p.id] = true
  const on: Record<string, boolean> = {}
  const opMode: Record<string, number> = {}
  const regIn: Record<string, number> = {}
  const regOutA: Record<string, number> = {}
  const regOutV: Record<string, number> = {}
  const amps: Record<string, number> = {}
  const ratio: Record<string, number> = {}
  const rgbChannels: Record<string, [number, number, number]> = {}
  let ldoOn = true, boostOn = true, boostTrip = false, batTrip = false
  let ldoOutA = 0, boostOutA = 0, batAmps = 0
  let v: number[] = new Array<number>(N).fill(0)
  let converged = false

  const esp = design.parts.find((p) => p.kind === 'esp32')
  const charger = design.parts.find((p) => p.kind === 'charger')
  const battery = design.parts.find((p) => p.kind === 'battery')

  // Nets that source GND are tied weakly to the reference.
  const refNets = new Set<number>()
  for (let i = 0; i < N; i++) if (netRails(design, nl, i).includes('GND')) refNets.add(i)

  const level: Record<string, SupplyLevel> = {}
  const supplyV: Record<string, number> = {}
  const grounded: Record<string, boolean> = {}

  for (let iter = 0; iter < MAX_ITER; iter++) {
    const G = Array.from({ length: N }, () => new Array<number>(N).fill(0))
    const I = new Array<number>(N).fill(0)
    for (let i = 0; i < N; i++) G[i]![i]! += refNets.has(i) ? GROUND_LEAK : GMIN
    const stamp = (a: number, b: number, g: number): void => { G[a]![a]! += g; G[b]![b]! += g; G[a]![b]! -= g; G[b]![a]! -= g }
    const source = (a: number, b: number, volts: number, r: number): void => { stamp(a, b, 1 / r); I[a]! += volts / r; I[b]! -= volts / r }
    const sink = (a: number, b: number, a_: number): void => { I[a]! -= a_; I[b]! += a_ }
    const n = (p: PartInst, pin: string): number => net(nl, p.id, pin)

    for (const p of design.parts) {
      const def = defOf(design, p)
      switch (p.kind) {
        case 'resistor': stamp(n(p, 'A'), n(p, 'B'), 1 / Math.max(1, num(p, 'ohms', 1000))); break
        case 'inductor': stamp(n(p, 'A'), n(p, 'B'), 1 / 0.1); break
        case 'fuse': if (p.props['blown'] !== true) stamp(n(p, 'A'), n(p, 'B'), 1 / FUSE_R); break
        case 'ldr': case 'thermistor': case 'motor': case 'fan': stamp(n(p, 'A'), n(p, 'B'), 1 / twoTerminalOhms(p)); break
        case 'rgb': {
          const k = n(p, 'K')
          for (const ch of RGB_CHANNELS) if (on[`${p.id}.${ch}`]) source(n(p, ch), k, RGB_VF[ch], LED_R)
          break
        }
        case 'pot': {
          const r = Math.max(100, num(p, 'ohms', 10000)), pos = clamp(num(p, 'pos', 0.5), 0, 1)
          stamp(n(p, 'A'), n(p, 'W'), 1 / (r * pos + 0.01)); stamp(n(p, 'W'), n(p, 'B'), 1 / (r * (1 - pos) + 0.01)); break
        }
        case 'switch': if (p.props['closed'] !== false) stamp(n(p, 'A'), n(p, 'B'), 50); break
        case 'button': if (p.props['pressed'] === true) stamp(n(p, 'A'), n(p, 'B'), 20); break
        case 'buzzer': stamp(n(p, 'P'), n(p, 'N'), 1 / Math.max(10, num(p, 'ohms', 150))); break
        case 'diode': case 'led': if (on[p.id]) source(n(p, 'A'), n(p, 'K'), forwardDrop(p), p.kind === 'led' ? LED_R : DIODE_R); break
        case 'npn': if (on[p.id]) { source(n(p, 'B'), n(p, 'E'), 0.7, 10); source(n(p, 'C'), n(p, 'E'), 0.2, 1) } break
        case 'pnp': if (on[p.id]) { source(n(p, 'E'), n(p, 'B'), 0.7, 10); source(n(p, 'E'), n(p, 'C'), 0.2, 1) } break
        case 'nmos': if (on[p.id]) stamp(n(p, 'D'), n(p, 'S'), 1 / 0.05); break
        case 'pmos': if (on[p.id]) stamp(n(p, 'S'), n(p, 'D'), 1 / 0.05); break
        case 'relay': stamp(n(p, 'CP'), n(p, 'CN'), 1 / 70); stamp(n(p, 'COM'), on[p.id] ? n(p, 'NO') : n(p, 'NC'), 20); break
        case 'usb': if (p.props['plugged'] !== false) source(n(p, 'VBUS'), n(p, 'GND'), 5, 0.1); break
        case 'opamp': {
          if (!powered[p.id]) break
          const out = n(p, 'OUT'), g = n(p, 'GND'), vcc = v[n(p, 'VCC')]! - v[g]!
          const mode = opMode[p.id] ?? 0
          if (mode === 0) { G[out]![n(p, 'INP')]! -= 1; G[out]![n(p, 'INN')]! += 1; stamp(out, g, 1e-5) }
          else source(out, g, mode > 0 ? Math.max(0.1, vcc - 0.15) : 0.1, 50)
          break
        }
        case 'regulator': {
          const i = n(p, 'IN'), o = n(p, 'OUT'), g = n(p, 'GND')
          if (!isConnected(nl, p.id, 'IN') || !isConnected(nl, p.id, 'GND')) break
          const buck = p.props['buck'] === true, target = clamp(num(p, 'vout', 3.3), 0.8, 24), drop = buck ? 0.5 : 0.3
          const vin = regIn[p.id] ?? 0
          const out = vin >= target + drop ? target : Math.max(0, vin - drop)
          regOutV[p.id] = out
          if (out > 0.05) {
            source(o, g, out, REG_R)
            const oa = Math.max(0, regOutA[p.id] ?? 0)
            sink(i, g, buck ? (out * oa) / (0.9 * Math.max(vin, 1)) + 0.003 : oa + 0.005)
          }
          break
        }
        case 'charger':
          if (boostOn && !boostTrip) {
            source(n(p, 'OP'), n(p, 'ON'), 5, BOOST_R)
            const vin = Math.max(2.5, v[n(p, 'BP')]! - v[n(p, 'BN')]!)
            sink(n(p, 'BP'), n(p, 'BN'), (5 * Math.max(0, boostOutA)) / (BOOST_EFF * vin) + 0.002)
          }
          break
        case 'battery': if (!batTrip) source(n(p, 'P'), n(p, 'N'), clamp(num(p, 'voltage', 3.7), 2.5, 4.3), BATTERY_R); break
        default: break
      }
      if (def.supply && def.pullups) for (const pin of def.pullups.pins) stamp(n(p, def.supply.pin), n(p, pin), 1 / def.pullups.ohms)
      if (def.supply) stamp(n(p, def.supply.pin), n(p, def.supply.gnd), (def.supply.mA / 1000) / def.supply.nominal)
    }
    if (esp && ldoOn) {
      source(net(nl, esp.id, '3V3'), net(nl, esp.id, 'GND1'), 3.3, LDO_R)
      sink(net(nl, esp.id, 'VIN'), net(nl, esp.id, 'GND1'), Math.max(0, ldoOutA) + 0.005)
    }

    v = solveLinear(G, I)

    // Re-derive every state that depends on the solution.
    let changed = false
    const flip = (id: string, next: boolean): void => { if ((on[id] ?? false) !== next) { on[id] = next; changed = true } }
    const vd = (a: number, b: number): number => v[a]! - v[b]!
    for (const p of design.parts) {
      const def = defOf(design, p)
      const sup = def.supply
      if (sup) {
        const gOk = isConnected(nl, p.id, sup.gnd) && isConnected(nl, p.id, sup.pin)
        const sv = gOk ? vd(net(nl, p.id, sup.pin), net(nl, p.id, sup.gnd)) : 0
        const lv = gOk ? levelOf(sv, sup) : 'none'
        grounded[p.id] = isConnected(nl, p.id, sup.gnd)
        supplyV[p.id] = sv
        level[p.id] = lv
        powered[p.id] = lv === 'ok' || lv === 'high'
      }
      const q = (pin: string): number => net(nl, p.id, pin)
      switch (p.kind) {
        case 'diode': case 'led': {
          const vf = forwardDrop(p), r = p.kind === 'led' ? LED_R : DIODE_R, va = vd(q('A'), q('K'))
          const i = (va - vf) / r
          amps[p.id] = on[p.id] ? Math.max(0, i) : 0
          flip(p.id, on[p.id] ? i >= 0 : va > vf)
          break
        }
        case 'fuse': {
          amps[p.id] = p.props['blown'] === true ? 0 : Math.abs(vd(q('A'), q('B'))) / FUSE_R
          break
        }
        case 'ldr': case 'thermistor': case 'motor': case 'fan': {
          amps[p.id] = Math.abs(vd(q('A'), q('B'))) / twoTerminalOhms(p)
          break
        }
        case 'rgb': {
          const k = q('K'), cur: [number, number, number] = [0, 0, 0]
          RGB_CHANNELS.forEach((ch, idx) => {
            const key = `${p.id}.${ch}`, va = vd(q(ch), k), i = (va - RGB_VF[ch]) / LED_R
            const was = on[key] === true
            flip(key, was ? i >= 0 : va > RGB_VF[ch])
            cur[idx] = on[key] ? Math.max(0, i) : 0
          })
          rgbChannels[p.id] = cur
          amps[p.id] = cur[0] + cur[1] + cur[2]
          break
        }
        case 'npn': case 'pnp': {
          const pn = p.kind === 'npn'
          const vbe = pn ? vd(q('B'), q('E')) : vd(q('E'), q('B'))
          const ib = Math.max(0, (vbe - 0.7) / 10)
          const ic = on[p.id] ? Math.max(0, pn ? vd(q('C'), q('E')) - 0.2 : vd(q('E'), q('C')) - 0.2) : 0
          amps[p.id] = ic
          ratio[p.id] = ib > 1e-9 ? ic / (Math.max(1, num(p, 'beta', 100)) * ib) : 0
          flip(p.id, on[p.id] ? vbe >= 0.7 : vbe > 0.7)
          break
        }
        case 'nmos': case 'pmos': {
          const vgs = p.kind === 'nmos' ? vd(q('G'), q('S')) : vd(q('S'), q('G'))
          const vth = clamp(num(p, 'vth', 2), 0.3, 10)
          const id = on[p.id] ? Math.abs(p.kind === 'nmos' ? vd(q('D'), q('S')) : vd(q('S'), q('D'))) / 0.05 : 0
          amps[p.id] = id
          flip(p.id, on[p.id] ? vgs >= vth - 0.2 : vgs >= vth)
          break
        }
        case 'relay': {
          const vc = vd(q('CP'), q('CN'))
          amps[p.id] = Math.abs(vc) / 70
          flip(p.id, on[p.id] ? vc > 1.5 : vc >= 3.5)
          break
        }
        case 'opamp': {
          if (!powered[p.id]) { if ((opMode[p.id] ?? 0) !== 0) { opMode[p.id] = 0; changed = true } break }
          const g = q('GND'), vcc = vd(q('VCC'), g), vo = vd(q('OUT'), g), dv = vd(q('INP'), q('INN'))
          const mode = opMode[p.id] ?? 0
          const next = mode === 0 ? (vo > vcc - 0.15 ? 1 : vo < 0.1 ? -1 : 0) : mode > 0 ? (dv <= 0 ? 0 : 1) : (dv >= 0 ? 0 : -1)
          if (next !== mode) { opMode[p.id] = next; changed = true }
          break
        }
        case 'regulator': {
          if (!isConnected(nl, p.id, 'IN') || !isConnected(nl, p.id, 'GND')) break
          const g = q('GND'), vin = vd(q('IN'), g)
          const out = regOutV[p.id] ?? 0
          const oa = out > 0.05 ? Math.max(0, (out - vd(q('OUT'), g)) / REG_R) : 0
          if (Math.abs(vin - (regIn[p.id] ?? 0)) > 1e-5 || Math.abs(oa - (regOutA[p.id] ?? 0)) > 1e-5) changed = true
          regIn[p.id] = vin; regOutA[p.id] = oa; amps[p.id] = oa
          break
        }
        default: break
      }
    }
    if (esp) {
      const gnd = v[net(nl, esp.id, 'GND1')]!
      const vinV = v[net(nl, esp.id, 'VIN')]! - gnd
      const o: boolean = isConnected(nl, esp.id, 'VIN') && isConnected(nl, esp.id, 'GND1') && vinV >= (ldoOn ? 3.45 : 3.55)
      if (o !== ldoOn) { ldoOn = o; changed = true }
      const out = o ? (3.3 - (v[net(nl, esp.id, '3V3')]! - gnd)) / LDO_R : 0
      if (Math.abs(out - ldoOutA) > 1e-5) changed = true
      ldoOutA = out
    }
    if (charger) {
      const vin = v[net(nl, charger.id, 'BP')]! - v[net(nl, charger.id, 'BN')]!
      const o: boolean = isConnected(nl, charger.id, 'BP') && isConnected(nl, charger.id, 'BN') && vin >= (boostOn ? 2.9 : 3.0)
      if (o !== boostOn) { boostOn = o; changed = true }
      const out = o && !boostTrip ? (5 - (v[net(nl, charger.id, 'OP')]! - v[net(nl, charger.id, 'ON')]!)) / BOOST_R : 0
      if (Math.abs(out - boostOutA) > 1e-5) changed = true
      boostOutA = out
      if (out > BOOST_TRIP_A && !boostTrip) { boostTrip = true; changed = true }
    }
    if (battery && !batTrip) {
      const a = (clamp(num(battery, 'voltage', 3.7), 2.5, 4.3) - (v[net(nl, battery.id, 'P')]! - v[net(nl, battery.id, 'N')]!)) / BATTERY_R
      batAmps = a
      if (a > BATTERY_TRIP_A) { batTrip = true; changed = true }
    } else if (batTrip) batAmps = 0
    if (!changed && iter > 1) { converged = true; break }
  }

  const parts: Record<string, PartPower> = {}
  for (const p of design.parts) {
    const sup = defOf(design, p).supply
    if (!sup) continue
    const isOn = powered[p.id] === true
    parts[p.id] = { supplyV: supplyV[p.id] ?? 0, grounded: grounded[p.id] ?? false, powered: isOn, level: level[p.id] ?? 'none', mA: isOn ? ((supplyV[p.id] ?? 0) / sup.nominal) * sup.mA : 0 }
  }
  const elements: Record<string, ElementState> = {}
  for (const p of design.parts) {
    if (p.kind === 'diode' || p.kind === 'led') elements[p.id] = { on: on[p.id] === true && (amps[p.id] ?? 0) > 1e-5, amps: amps[p.id] ?? 0 }
    else if (p.kind === 'rgb') elements[p.id] = { on: (amps[p.id] ?? 0) > 1e-5, amps: amps[p.id] ?? 0, channels: rgbChannels[p.id] ?? [0, 0, 0] }
    else if (p.kind === 'fuse') elements[p.id] = { on: p.props['blown'] !== true, amps: amps[p.id] ?? 0 }
    else if (p.kind === 'motor' || p.kind === 'fan') elements[p.id] = { on: (amps[p.id] ?? 0) > 1e-4, amps: amps[p.id] ?? 0 }
    else if (p.kind === 'nmos' || p.kind === 'pmos' || p.kind === 'relay') elements[p.id] = { on: on[p.id] === true, amps: amps[p.id] ?? 0 }
    else if (p.kind === 'npn' || p.kind === 'pnp') elements[p.id] = { on: on[p.id] === true, amps: amps[p.id] ?? 0, value: ratio[p.id] ?? 0 }
    else if (p.kind === 'opamp') elements[p.id] = { on: powered[p.id] === true, amps: 0, value: opMode[p.id] ?? 0 }
    else if (p.kind === 'regulator') elements[p.id] = { on: (regOutV[p.id] ?? 0) > 0.05, amps: amps[p.id] ?? 0, value: regOutV[p.id] ?? 0 }
  }
  const faults: string[] = []
  if (batTrip) faults.push('Battery protection tripped: output current exceeded 3 A (short circuit or overload).')
  if (boostTrip) faults.push('Boost converter shut down: output current exceeded 2 A.')
  return {
    v, parts, elements,
    battery: battery ? { id: battery.id, volts: batTrip ? num(battery, 'voltage', 3.7) : v[net(nl, battery.id, 'P')]! - v[net(nl, battery.id, 'N')]!, amps: batAmps, tripped: batTrip } : null,
    boost: charger ? { on: boostOn && !boostTrip, outA: boostOutA, tripped: boostTrip } : null,
    ldoOn, converged, faults
  }
}
