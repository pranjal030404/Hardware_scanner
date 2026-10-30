import { ADC2, INPUT_ONLY, PART_DEFS, STRAPPING, defOf, findPin } from './parts'
import { buildNetlist, isConnected, net, netRails, type Netlist } from './netlist'
import { RGB_CHANNELS, ldrOhms, simulate, thermistorOhms, type Electrical, type ElementState } from './sim'
import { ADC_DEFAULT, ADC_KEY, SIGNALS } from './signals'
import type { Design, PartInst, PartKind } from './types'

export interface Issue { id: string; severity: 'error' | 'warn' | 'info'; part?: string; pin?: string; message: string }
export type PartState = 'ok' | 'warn' | 'fault' | 'off' | 'idle' | 'n/a'
export interface PartStatus { state: PartState; messages: string[] }
export interface SignalLink { key: string; kind: PartKind; label: string; expected: number; actual: number[]; ok: boolean; reason: string | null }
export interface BatteryReading { volts: number | null; percent: number | null; adcRaw: number | null; amps: number; runtimeH: number | null }

export interface Report {
  netlist: Netlist
  electrical: Electrical
  issues: Issue[]
  parts: Record<string, PartStatus>
  links: SignalLink[]
  espRunning: boolean
  battery: BatteryReading
  /** Voltage of any pin relative to the circuit's ground reference. */
  voltage(part: string, pin: string): number
}

const BAT_EMPTY = 3.0
const BAT_FULL = 4.2
const fmtV = (v: number): string => `${v.toFixed(2)} V`
const fmtOhms = (r: number): string => (r >= 1e6 ? `${(r / 1e6).toFixed(2)} MΩ` : r >= 1000 ? `${(r / 1000).toFixed(1)} kΩ` : `${r.toFixed(0)} Ω`)

/** Firmware's battery divider assumption: two equal resistors, so VBAT = 2 × the ADC voltage. */
const DIVIDER = 2

const kindOf = (design: Design, kind: PartKind): PartInst | undefined => design.parts.find((p) => p.kind === kind)

export function evaluate(design: Design): Report {
  const nl = buildNetlist(design)
  const el = simulate(design, nl)
  const issues: Issue[] = []
  const add = (severity: Issue['severity'], message: string, part?: string, pin?: string): void => {
    const o: Issue = { id: `i${issues.length}`, severity, message }
    if (part) o.part = part
    if (pin) o.pin = pin
    issues.push(o)
  }
  const esp = kindOf(design, 'esp32')
  const el_ = (id: string): ElementState | undefined => el.elements[id]
  const refNet = ((): number => {
    if (esp) return net(nl, esp.id, 'GND1')
    for (const p of design.parts) for (const pin of [...defOf(design, p).left, ...defOf(design, p).right]) if (pin.type === 'gnd' && isConnected(nl, p.id, pin.id)) return net(nl, p.id, pin.id)
    return 0
  })()
  const voltage = (part: string, pin: string): number => { const n = net(nl, part, pin); return n < 0 ? 0 : el.v[n]! - el.v[refNet]! }

  for (const w of nl.badWires) add('warn', `Wire ${w} points at a pin that does not exist and is ignored.`)

  // Shorts: a net that sources two different rails (or a rail and ground).
  nl.nets.forEach((pins, i) => {
    const rails = netRails(design, nl, i)
    if (rails.length > 1) {
      const first = pins.find((r) => findPin(defOf(design, design.parts.find((p) => p.id === r.part)!), r.pin)?.rail)
      add('error', `Short circuit: ${rails.join(' and ')} are connected together.`, first?.part, first?.pin)
    }
  })

  // Power pins that were never wired.
  for (const p of design.parts) {
    const sup = defOf(design, p).supply
    if (!sup) continue
    if (!isConnected(nl, p.id, sup.pin)) add('error', `${defOf(design, p).name}: ${sup.pin} is not connected to a supply.`, p.id, sup.pin)
    if (!isConnected(nl, p.id, sup.gnd)) add('error', `${defOf(design, p).name}: ${sup.gnd} is not connected to ground.`, p.id, sup.gnd)
  }
  if (esp && !isConnected(nl, esp.id, 'VIN') && !isConnected(nl, esp.id, '3V3')) add('error', 'ESP32 has no power input: wire 5 V to VIN (or 3.3 V to the 3V3 pin).', esp.id, 'VIN')

  // Supply level per part.
  for (const p of design.parts) {
    const pw = el.parts[p.id]
    const sup = defOf(design, p).supply
    if (!pw || !sup || !isConnected(nl, p.id, sup.pin) || !isConnected(nl, p.id, sup.gnd)) continue
    const name = defOf(design, p).name
    if (pw.level === 'damaged') add('error', `${name}: ${fmtV(pw.supplyV)} on ${sup.pin} exceeds the ${fmtV(sup.absMax)} absolute maximum. The part would be damaged.`, p.id, sup.pin)
    else if (pw.level === 'high') add('warn', `${name}: ${fmtV(pw.supplyV)} on ${sup.pin} is above the recommended ${fmtV(sup.vmax)}.`, p.id, sup.pin)
    else if (pw.level === 'low') add('warn', `${name}: ${fmtV(pw.supplyV)} on ${sup.pin} is below the ${fmtV(sup.vmin)} minimum, so it stays off.`, p.id, sup.pin)
  }
  for (const f of el.faults) add('error', f)

  for (const p of design.parts) {
    const el = el_(p.id)
    if ((p.kind === 'led' || p.kind === 'diode') && el && el.amps > 0.05) add('error', `${defOf(design, p).name} ${p.id}: ${(el.amps * 1000).toFixed(0)} mA with no current limit. Add a series resistor.`, p.id)
    if (p.kind === 'rgb' && el) {
      const peak = Math.max(...(el.channels ?? [0, 0, 0]))
      if (peak > 0.05) add('error', `${defOf(design, p).name} ${p.id}: a colour channel carries ${(peak * 1000).toFixed(0)} mA with no current limit. Add one series resistor per colour.`, p.id)
    }
    if (p.kind === 'fuse' && p.props['blown'] !== true && el) {
      const rating = Math.max(0.01, Number(p.props['amps'] ?? 0.5))
      if (el.amps > rating) add('error', `Fuse ${p.id} would blow: ${(el.amps * 1000).toFixed(0)} mA through a ${(rating * 1000).toFixed(0)} mA fuse.`, p.id)
    }
    if (p.kind === 'regulator' && el && el.amps > (p.props['buck'] === true ? 3 : 1.2)) add('error', `Regulator ${p.id} is overloaded (${(el.amps * 1000).toFixed(0)} mA).`, p.id)
    if ((p.kind === 'npn' || p.kind === 'pnp') && el?.on && (el.value ?? 0) > 1.05) add('warn', `${defOf(design, p).name} ${p.id} is not saturated: the base current is too low for this load. Use a smaller base resistor.`, p.id)
  }

  // ESP32 pins: voltage tolerance, boot straps.
  let bootMsg: string | null = null
  let download = false
  const espPow = esp ? el.parts[esp.id] : undefined
  if (esp) {
    for (const pin of PART_DEFS.esp32.left.concat(PART_DEFS.esp32.right)) {
      if (pin.type !== 'gpio' || !isConnected(nl, esp.id, pin.id)) continue
      const v = voltage(esp.id, pin.id)
      if (v > 3.6) add('error', `GPIO${pin.gpio} sees ${fmtV(v)}: ESP32 pins are not 5 V tolerant.`, esp.id, pin.id)
    }
    if (espPow?.powered) {
      if (isConnected(nl, esp.id, 'G12') && voltage(esp.id, 'G12') > 2) { bootMsg = 'GPIO12 is high at boot, which selects 1.8 V flash. The ESP32 will not boot.'; add('error', bootMsg, esp.id, 'G12') }
      if (isConnected(nl, esp.id, 'G0') && voltage(esp.id, 'G0') < 0.5) { download = true; add('warn', 'GPIO0 is held low at boot: the ESP32 starts in download mode and runs no firmware.', esp.id, 'G0') }
    }
  }
  const espRunning = !!esp && !!espPow?.powered && espPow.level === 'ok' && !bootMsg && !download

  // Firmware pin map versus wiring.
  const fw = design.firmware
  const links: SignalLink[] = []
  if (esp) {
    const gpiosOn = (n: number): number[] => (nl.nets[n] ?? []).filter((r) => r.part === esp.id).map((r) => findPin(PART_DEFS.esp32, r.pin)?.gpio).filter((x): x is number => typeof x === 'number')
    const used = new Map<number, { label: string; bus: string }[]>()
    for (const s of SIGNALS) {
      const part = kindOf(design, s.kind)
      if (!part) continue
      const expected = fw[s.key] ?? s.default
      used.set(expected, [...(used.get(expected) ?? []), { label: s.label, bus: s.bus ?? s.key }])
      const actual = gpiosOn(net(nl, part.id, s.pin))
      const ok = actual.includes(expected)
      const reason = ok ? null : actual.length ? `wired to GPIO${actual.join(', GPIO')} but the firmware uses GPIO${expected}` : `not wired to any ESP32 GPIO (firmware uses GPIO${expected})`
      links.push({ key: s.key, kind: s.kind, label: s.label, expected, actual, ok, reason })
      if (!ok) add('error', `${s.label}: ${reason}.`, part.id, s.pin)
      if ((INPUT_ONLY as readonly number[]).includes(expected) && s.dir !== 'in') add('error', `${s.label}: GPIO${expected} is input-only and cannot drive this signal.`, esp.id, `G${expected}`)
      if ((STRAPPING as readonly number[]).includes(expected)) add('warn', `${s.label} uses strapping pin GPIO${expected}; external loads can break booting.`, esp.id, `G${expected}`)
    }
    for (const [gpio, users] of used) if (new Set(users.map((u) => u.bus)).size > 1) add('error', `Firmware pin conflict: GPIO${gpio} is assigned to ${[...new Set(users.map((u) => u.label))].join(' and ')}.`, esp.id, `G${gpio}`)
  } else if (design.parts.some((p) => SIGNALS.some((s) => s.kind === p.kind))) add('info', 'Add an ESP32 to simulate firmware behaviour.')

  const dac = kindOf(design, 'dac')
  const dacClockOk = !dac || netRails(design, nl, net(nl, dac.id, 'SCK')).includes('GND')
  if (dac && !dacClockOk) add('error', 'PCM5102A: SCK must be tied to GND so the chip derives its clock from BCK.', dac.id, 'SCK')

  // Battery sense through the ADC pin.
  const adcPin = fw[ADC_KEY] ?? ADC_DEFAULT
  const battery: BatteryReading = { volts: null, percent: null, adcRaw: null, amps: el.battery?.amps ?? 0, runtimeH: null }
  if (esp && espRunning && isConnected(nl, esp.id, `G${adcPin}`)) {
    const vadc = voltage(esp.id, `G${adcPin}`)
    battery.adcRaw = Math.round(Math.min(1, Math.max(0, vadc / 3.1)) * 4095)
    battery.volts = vadc * DIVIDER
    battery.percent = Math.round(Math.min(1, Math.max(0, (battery.volts - BAT_EMPTY) / (BAT_FULL - BAT_EMPTY))) * 100)
  } else if (esp && design.parts.some((p) => p.kind === 'battery') && !isConnected(nl, esp.id, `G${adcPin}`)) add('info', `Battery sense: nothing is wired to GPIO${adcPin}, so the firmware cannot read the battery.`, esp.id, `G${adcPin}`)
  if (esp && (ADC2 as readonly number[]).includes(adcPin)) add('warn', `GPIO${adcPin} is an ADC2 pin and cannot be read while Wi-Fi is active.`, esp.id, `G${adcPin}`)
  const bat = kindOf(design, 'battery')
  if (bat && el.battery && el.battery.amps > 0.001) battery.runtimeH = Number(bat.props['mAh'] ?? 2000) / (el.battery.amps * 1000)

  if (esp && !espRunning && !issues.some((i) => i.severity === 'error') && espPow && !espPow.powered) add('info', 'The ESP32 is not powered. Check the path from the battery through the boost converter and switch to VIN.', esp.id, 'VIN')

  // Per-part status.
  const parts: Record<string, PartStatus> = {}
  for (const p of design.parts) {
    const def = defOf(design, p)
    const pw = el.parts[p.id]
    const st: PartStatus = { state: 'n/a', messages: [] }
    parts[p.id] = st
    if (pw) {
      if (!pw.powered) {
        st.state = pw.level === 'damaged' ? 'fault' : 'off'
        st.messages.push(pw.level === 'damaged' ? `Over-voltage: ${fmtV(pw.supplyV)}.` : pw.grounded ? `No power (${fmtV(pw.supplyV)} on ${def.supply!.pin}).` : 'No ground connection.')
        continue
      }
      st.state = pw.level === 'high' ? 'warn' : 'ok'
      st.messages.push(`${fmtV(pw.supplyV)} · ${pw.mA.toFixed(0)} mA`)
    }
    if (p.kind === 'esp32') {
      if (bootMsg) { st.state = 'fault'; st.messages.push(bootMsg) } else if (download) { st.state = 'warn'; st.messages.push('Download mode: no firmware running.') } else if (st.state === 'ok') st.messages.push(el.ldoOn ? 'Running (powered through the VIN regulator).' : 'Running.')
    } else if (p.kind === 'oled' || p.kind === 'encoder' || p.kind === 'dac' || p.kind === 'sd' || p.kind === 'sensor' || p.kind === 'servo') {
      const bad = links.filter((l) => l.kind === p.kind && !l.ok)
      if (bad.length) { st.state = 'fault'; for (const b of bad) st.messages.push(`${b.label}: ${b.reason}.`) }
      else if (!esp) { st.state = 'idle'; st.messages.push('No ESP32 to talk to.') }
      else if (!espRunning && st.state === 'ok') { st.state = 'idle'; st.messages.push('Waiting for the ESP32.') }
      if (p.kind === 'dac' && !dacClockOk) { st.state = 'fault'; st.messages.push('SCK not tied to GND: no master clock.') }
      if (p.kind === 'sd' && p.props['card'] === false && st.state === 'ok') { st.state = 'warn'; st.messages.push('No card inserted.') }
    } else if (p.kind === 'battery') {
      if (el.battery?.tripped) { st.state = 'fault'; st.messages.push('Protection tripped (over-current).') }
      else { st.state = 'ok'; st.messages.push(`${fmtV(el.battery?.volts ?? 0)} · ${((el.battery?.amps ?? 0) * 1000).toFixed(0)} mA out`) }
    } else if (p.kind === 'charger') {
      if (el.boost?.tripped) { st.state = 'fault'; st.messages.push('Shut down: output over-current.') }
      else if (el.boost?.on) { st.state = 'ok'; st.messages.push(`5 V out · ${(el.boost.outA * 1000).toFixed(0)} mA`) }
      else { st.state = 'off'; st.messages.push('Boost off: no battery, or battery under 3.0 V.') }
    } else if (p.kind === 'switch') { st.state = 'ok'; st.messages.push(p.props['closed'] === false ? 'Open' : 'Closed') }
    else if (p.kind === 'button') { st.state = 'ok'; st.messages.push(p.props['pressed'] === true ? 'Pressed' : 'Released') }
    else if (p.kind === 'capacitor') { st.state = 'ok'; st.messages.push(`${Number(p.props['uF'] ?? 0)} µF: blocks DC (open circuit at steady state)`) }
    else if (p.kind === 'inductor') { st.state = 'ok'; st.messages.push(`${Number(p.props['mH'] ?? 0)} mH: passes DC (≈0.1 Ω)`) }
    else if (p.kind === 'pot') { st.state = 'ok'; st.messages.push(`${Number(p.props['ohms'] ?? 0)} Ω, wiper at ${Math.round(Number(p.props['pos'] ?? 0.5) * 100)}%`) }
    else if (p.kind === 'diode' || p.kind === 'led') {
      const e = el_(p.id)
      if (e?.on && e.amps > 0.05) { st.state = 'fault'; st.messages.push(`${(e.amps * 1000).toFixed(0)} mA: over-current.`) }
      else if (e?.on && e.amps > 0.03) { st.state = 'warn'; st.messages.push(`${(e.amps * 1000).toFixed(0)} mA is above the usual 20 mA.`) }
      else if (e?.on) { st.state = 'ok'; st.messages.push(`Conducting ${(e.amps * 1000).toFixed(1)} mA`) }
      else { st.state = 'off'; st.messages.push('Off (not forward-biased)') }
    } else if (p.kind === 'npn' || p.kind === 'pnp' || p.kind === 'nmos' || p.kind === 'pmos') {
      const e = el_(p.id)
      if (e?.on) { st.state = (p.kind === 'npn' || p.kind === 'pnp') && (e.value ?? 0) > 1.05 ? 'warn' : 'ok'; st.messages.push(`ON · ${(e.amps * 1000).toFixed(1)} mA`) }
      else { st.state = 'off'; st.messages.push(p.kind === 'npn' || p.kind === 'pnp' ? 'Off (base below 0.7 V)' : 'Off (gate below threshold)') }
    } else if (p.kind === 'relay') {
      const e = el_(p.id)
      st.state = e?.on ? 'ok' : 'off'; st.messages.push(e?.on ? 'Energized: COM–NO closed' : 'Released: COM–NC closed')
    } else if (p.kind === 'opamp') {
      const m = el_(p.id)?.value ?? 0
      st.messages.push(m > 0 ? 'Output saturated high' : m < 0 ? 'Output saturated low' : 'Linear')
    } else if (p.kind === 'regulator') {
      const e = el_(p.id)
      if (!isConnected(nl, p.id, 'IN') || !isConnected(nl, p.id, 'GND')) { st.state = 'off'; st.messages.push('Input or ground not connected.') }
      else if (e?.on) {
        const target = Number(p.props['vout'] ?? 3.3)
        const dropout = (e.value ?? 0) < target - 0.05
        st.state = e.amps > (p.props['buck'] === true ? 3 : 1.2) ? 'fault' : dropout ? 'warn' : 'ok'
        st.messages.push(`${(e.value ?? 0).toFixed(2)} V out · ${(e.amps * 1000).toFixed(0)} mA${dropout ? ' · input too low (dropout)' : ''}`)
      } else { st.state = 'off'; st.messages.push('No output: input too low.') }
    } else if (p.kind === 'buzzer') {
      const vb = Math.abs(voltage(p.id, 'P') - voltage(p.id, 'N'))
      st.state = vb >= 2 ? 'ok' : 'off'; st.messages.push(vb >= 2 ? `Sounding (${fmtV(vb)})` : `Silent (${fmtV(vb)})`)
    } else if (p.kind === 'fuse') {
      const e = el_(p.id), rating = Math.max(0.01, Number(p.props['amps'] ?? 0.5))
      if (p.props['blown'] === true) { st.state = 'fault'; st.messages.push('Blown: open circuit.') }
      else if (e && e.amps > rating) { st.state = 'fault'; st.messages.push(`Would blow: ${(e.amps * 1000).toFixed(0)} mA through a ${(rating * 1000).toFixed(0)} mA fuse.`) }
      else { st.state = 'ok'; st.messages.push(`${((e?.amps ?? 0) * 1000).toFixed(1)} mA of ${(rating * 1000).toFixed(0)} mA`) }
    } else if (p.kind === 'ldr') {
      const lux = Number(p.props['lux'] ?? 100)
      st.state = 'ok'; st.messages.push(`${fmtOhms(ldrOhms(lux))} at ${lux} lx`)
    } else if (p.kind === 'thermistor') {
      const t = Number(p.props['tempC'] ?? 25)
      st.state = 'ok'; st.messages.push(`${fmtOhms(thermistorOhms(Number(p.props['r25'] ?? 10000), Number(p.props['beta'] ?? 3950), t))} at ${t} °C`)
    } else if (p.kind === 'motor' || p.kind === 'fan') {
      const e = el_(p.id)
      if (e?.on) { st.state = 'ok'; st.messages.push(`${p.kind === 'fan' ? 'Spinning' : 'Running'} · ${(e.amps * 1000).toFixed(0)} mA`) }
      else { st.state = 'off'; st.messages.push('Stopped: no voltage across it.') }
    } else if (p.kind === 'rgb') {
      const e = el_(p.id), ch = e?.channels ?? [0, 0, 0]
      if (e?.on && Math.max(...ch) > 0.05) { st.state = 'fault'; st.messages.push('A colour channel is over-current: add a series resistor per colour.') }
      else if (e?.on) { st.state = 'ok'; st.messages.push(`${RGB_CHANNELS.filter((_, i) => (ch[i] ?? 0) > 1e-5).join('+')} · ${(e.amps * 1000).toFixed(1)} mA`) }
      else { st.state = 'off'; st.messages.push('Off (no channel forward-biased)') }
    } else if (p.kind === 'header') {
      st.state = 'ok'; st.messages.push('8 independent pins, not connected to each other.')
    } else if (p.kind === 'usb') {
      st.state = p.props['plugged'] === false ? 'off' : 'ok'; st.messages.push(p.props['plugged'] === false ? 'Unplugged' : 'Plugged in: 5 V')
    } else if (p.kind === 'custom' && !def.supply) { st.state = 'ok'; st.messages.push(`${def.left.length + def.right.length} pins`) }
    else if (p.kind === 'resistor') { st.state = 'ok'; st.messages.push(`${Number(p.props['ohms'] ?? 0)} Ω`) }
  }

  return { netlist: nl, electrical: el, issues, parts, links, espRunning, battery, voltage }
}
