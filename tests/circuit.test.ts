import { describe, expect, it } from 'vitest'
import { evaluate } from '../src/circuit/engine'
import { initialFw, oledView, step, encoderWorks, audioProblem } from '../src/circuit/firmware'
import { DesignSchema } from '../src/circuit/schema'
import { emptyDesign, playerTemplate } from '../src/circuit/template'
import type { Design } from '../src/circuit/types'

const clone = (d: Design): Design => structuredClone(d)
const errors = (d: Design) => evaluate(d).issues.filter((i) => i.severity === 'error')

describe('circuit lab: reference player', () => {
  const d = playerTemplate()
  const r = evaluate(d)
  it('has no errors or warnings and every part works', () => {
    expect(r.issues).toEqual([])
    for (const id of ['esp1', 'oled1', 'encoder1', 'dac1', 'sd1', 'battery1', 'charger1']) expect(r.parts[id]!.state, id).toBe('ok')
    expect(r.espRunning).toBe(true)
  })
  it('regulates rails: 5 V boost, 3.3 V LDO, battery sag small', () => {
    expect(r.voltage('esp1', 'VIN')).toBeGreaterThan(4.8)
    expect(r.voltage('esp1', '3V3')).toBeGreaterThan(3.2)
    expect(r.voltage('esp1', '3V3')).toBeLessThan(3.35)
    expect(r.electrical.battery!.amps).toBeGreaterThan(0.1)
    expect(r.electrical.battery!.amps).toBeLessThan(0.5)
    expect(r.battery.runtimeH!).toBeGreaterThan(3)
  })
  it('reads the battery through the VBAT/2 divider', () => {
    expect(r.voltage('esp1', 'G34')).toBeCloseTo(r.voltage('battery1', 'P') / 2, 2)
    expect(r.battery.volts!).toBeGreaterThan(3.55)
    expect(r.battery.volts!).toBeLessThan(3.75)
    expect(r.battery.percent!).toBeGreaterThan(40)
  })
  it('follows the battery slider', () => {
    const full = clone(d); full.parts.find((p) => p.id === 'battery1')!.props['voltage'] = 4.2
    expect(evaluate(full).battery.percent!).toBeGreaterThan(90)
    const flat = clone(d); flat.parts.find((p) => p.id === 'battery1')!.props['voltage'] = 2.9
    expect(evaluate(flat).espRunning).toBe(false) // the boost converter drops out under 3.0 V
    expect(evaluate(flat).parts['charger1']!.state).toBe('off')
  })
})

describe('circuit lab: faults', () => {
  const base = playerTemplate()
  it('open switch turns everything off', () => {
    const d = clone(base); d.parts.find((p) => p.id === 'sw1')!.props['closed'] = false
    const r = evaluate(d)
    expect(r.espRunning).toBe(false)
    expect(r.parts['oled1']!.state).toBe('off')
    expect(r.parts['battery1']!.state).toBe('ok')
  })
  it('swapped I2C wires are reported with the expected GPIO', () => {
    const d = clone(base)
    d.wires.find((w) => w.a.part === 'oled1' && w.a.pin === 'SDA')!.b.pin = 'G19'
    const r = evaluate(d)
    expect(r.parts['oled1']!.state).toBe('fault')
    expect(r.issues.some((i) => /OLED SDA.*GPIO19.*GPIO21/.test(i.message))).toBe(true)
    expect(oledView(r, d, initialFw(), new Date())).toBeNull()
  })
  it('changing the firmware pin map fixes the mismatch', () => {
    const d = clone(base)
    d.wires.find((w) => w.a.part === 'oled1' && w.a.pin === 'SDA')!.b.pin = 'G19'
    d.wires.find((w) => w.a.part === 'sd1' && w.a.pin === 'MISO')!.b.pin = 'G13'
    d.firmware['oled.SDA'] = 19; d.firmware['sd.MISO'] = 13
    expect(errors(d)).toEqual([])
  })
  it('shorting 3V3 to GND is an error and trips the battery protection', () => {
    const d = clone(base)
    d.wires.push({ id: 'ws', a: { part: 'esp1', pin: '3V3' }, b: { part: 'esp1', pin: 'GND1' } })
    const r = evaluate(d)
    expect(r.issues.some((i) => /Short circuit/.test(i.message))).toBe(true)
    expect(r.electrical.battery!.tripped || r.electrical.boost!.tripped).toBe(true)
    expect(r.espRunning).toBe(false)
  })
  it('5 V on the 3V3-only SD module damages it and flags the encoder pins', () => {
    const d = clone(base)
    d.wires = d.wires.filter((w) => !(w.a.part === 'sd1' && w.a.pin === 'V3'))
    d.wires.push({ id: 'wx', a: { part: 'sd1', pin: 'V3' }, b: { part: 'esp1', pin: 'VIN' } })
    const r = evaluate(d)
    expect(r.parts['sd1']!.state).toBe('fault')
    expect(r.issues.some((i) => /sd|microSD/i.test(i.message) && /absolute maximum/.test(i.message))).toBe(true)
  })
  it('encoder powered from 5 V puts 5 V on GPIOs', () => {
    const d = clone(base)
    d.wires = d.wires.filter((w) => !(w.a.part === 'encoder1' && w.a.pin === 'PLUS'))
    d.wires.push({ id: 'wy', a: { part: 'encoder1', pin: 'PLUS' }, b: { part: 'esp1', pin: 'VIN' } })
    expect(evaluate(d).issues.some((i) => /not 5 V tolerant/.test(i.message))).toBe(true)
  })
  it('DAC without SCK on GND has no clock', () => {
    const d = clone(base); d.wires = d.wires.filter((w) => !(w.a.part === 'dac1' && w.a.pin === 'SCK'))
    const r = evaluate(d)
    expect(r.parts['dac1']!.state).toBe('fault')
  })
  it('GPIO12 pulled high prevents boot; input-only pin cannot be an output', () => {
    const d = clone(base)
    d.wires.push({ id: 'w12', a: { part: 'esp1', pin: 'G12' }, b: { part: 'esp1', pin: '3V3' } })
    expect(evaluate(d).parts['esp1']!.state).toBe('fault')
    const e = clone(base); e.firmware['dac.DIN'] = 34
    expect(evaluate(e).issues.some((i) => /input-only/.test(i.message))).toBe(true)
  })
  it('missing ground is called out', () => {
    const d = clone(base); d.wires = d.wires.filter((w) => !(w.a.part === 'oled1' && w.a.pin === 'GND'))
    expect(evaluate(d).issues.some((i) => /GND is not connected/.test(i.message))).toBe(true)
  })
  it('empty design is harmless', () => {
    const r = evaluate(emptyDesign())
    expect(r.issues).toEqual([])
  })
})

describe('circuit lab: firmware', () => {
  const d = playerTemplate()
  const r = evaluate(d)
  it('encoder turns volume, press plays; OLED shows it', () => {
    expect(encoderWorks(r, d)).toBe(true)
    let s = initialFw()
    s = step(step(s, 'cw'), 'cw'); s = step(s, 'press')
    expect(s.volume).toBe(44)
    const v = oledView(r, d, s, new Date(2014, 9, 1, 8, 8))!
    expect(v.lines[0]).toBe('08:08')
    expect(v.status).toBe('> PLAYING')
    expect(v.battery).toMatch(/BAT \d+%/)
    expect(audioProblem(r, d, s)).toBeNull()
  })
  it('volume is clamped', () => { let s = initialFw(); for (let i = 0; i < 100; i++) s = step(s, 'ccw'); expect(s.volume).toBe(0) })
  it('playback reports a missing SD card', () => {
    const e = clone(d); e.parts.find((p) => p.id === 'sd1')!.props['card'] = false
    expect(audioProblem(evaluate(e), e, { ...initialFw(), playing: true })).toBe('no SD card')
  })
})

describe('circuit lab: schema and scale', () => {
  it('accepts the template and rejects hostile designs', () => {
    expect(DesignSchema.safeParse(playerTemplate()).success).toBe(true)
    const d = clone(playerTemplate())
    expect(DesignSchema.safeParse({ ...d, extra: 1 }).success).toBe(false)
    expect(DesignSchema.safeParse({ ...d, parts: [...d.parts, d.parts[0]] }).success).toBe(false)
    expect(DesignSchema.safeParse({ ...d, firmware: { 'oled.SDA': 99 } }).success).toBe(false)
    expect(DesignSchema.safeParse({ ...d, parts: [{ ...d.parts[0], kind: 'rm -rf' }] }).success).toBe(false)
  })
  it('evaluates a 60-part design quickly', () => {
    const d = clone(playerTemplate())
    for (let i = 0; i < 50; i++) d.parts.push({ id: `rx${i}`, kind: 'resistor', x: 0, y: 0, props: { ohms: 1000 } })
    const t = performance.now(); evaluate(d); expect(performance.now() - t).toBeLessThan(1500)
  })
})

import { addPart, addWire, movePart, removePart, setProp, snap } from '../src/circuit/edit'

describe('circuit lab: editing', () => {
  it('adds parts once, snaps to the grid and numbers resistors', () => {
    let d = emptyDesign()
    const a = addPart(d, 'esp32', 103, 97)!; d = a.design
    expect(d.parts[0]).toMatchObject({ id: 'esp321', x: 100, y: 100 })
    expect(addPart(d, 'esp32', 0, 0)).toBeNull()
    d = addPart(d, 'resistor', 0, 0)!.design; d = addPart(d, 'resistor', 0, 0)!.design
    expect(d.parts.map((p) => p.id)).toEqual(['esp321', 'resistor1', 'resistor2'])
    expect(snap(14)).toBe(10); expect(snap(15)).toBe(20)
    expect(movePart(d, 'resistor1', 33, 48).parts[1]).toMatchObject({ x: 30, y: 50 })
  })
  it('wires: rejects self, duplicate and unknown pins; removing a part drops its wires', () => {
    let d = addPart(addPart(emptyDesign(), 'resistor', 0, 0)!.design, 'resistor', 200, 0)!.design
    const A = { part: 'resistor1', pin: 'B' }, B = { part: 'resistor2', pin: 'A' }
    expect('error' in addWire(d, A, A)).toBe(true)
    expect('error' in addWire(d, A, { part: 'resistor2', pin: 'Z' })).toBe(true)
    const w = addWire(d, A, B); expect('design' in w).toBe(true)
    if ('design' in w) d = w.design
    expect('error' in addWire(d, B, A)).toBe(true)
    expect(removePart(d, 'resistor1').wires).toEqual([])
    expect(setProp(d, 'resistor1', 'ohms', 10).parts[0]!.props['ohms']).toBe(10)
  })
  it('a hand-built divider produces the right voltage', () => {
    let d = emptyDesign()
    for (const k of ['battery', 'resistor', 'resistor'] as const) d = addPart(d, k, 0, 0)!.design
    const link = (a: string, b: string): void => { const [pa, na] = a.split('.') as [string, string]; const [pb, nb] = b.split('.') as [string, string]; const r = addWire(d, { part: pa, pin: na }, { part: pb, pin: nb }); if ('design' in r) d = r.design }
    d = setProp(d, 'resistor1', 'ohms', 10000); d = setProp(d, 'resistor2', 'ohms', 30000)
    link('battery1.P', 'resistor1.A'); link('resistor1.B', 'resistor2.A'); link('resistor2.B', 'battery1.N')
    const r = evaluate(d)
    expect(r.voltage('resistor2', 'A')).toBeCloseTo(3.7 * 0.75, 1)
    expect(errors(d)).toEqual([])
  })
})

import { DatabaseSync } from 'node:sqlite'
import { migrate } from '../src/main/database/db'
import { MIGRATIONS } from '../src/main/database/migrations'
import { CircuitRepo, MAX_CIRCUITS } from '../src/main/database/circuit-repo'
import { IPC_REQUEST_SCHEMAS } from '../src/shared/ipc'

describe('circuit lab: storage', () => {
  const repo = (): CircuitRepo => { const db = new DatabaseSync(':memory:'); migrate(db, MIGRATIONS); return new CircuitRepo(db) }
  it('saves, updates, loads and deletes', () => {
    const r = repo(), d = playerTemplate()
    const a = r.save(undefined, 'one', d, '2026-01-01T00:00:00Z')
    expect(a).toMatchObject({ name: 'one', parts: 10, wires: 31 })
    const b = r.save(a.id, 'renamed', emptyDesign(), '2026-01-02T00:00:00Z')
    expect(b).toMatchObject({ id: a.id, name: 'renamed', parts: 0, createdAt: '2026-01-01T00:00:00Z' })
    expect(r.load(a.id)!.design).toEqual(emptyDesign())
    expect(() => r.save(999, 'ghost', d, 'x')).toThrow(/no longer exists/)
    r.remove(a.id)
    expect(r.load(a.id)).toBeNull(); expect(r.list()).toEqual([])
  })
  it('caps the number of saved circuits', () => {
    const r = repo()
    for (let i = 0; i < MAX_CIRCUITS; i++) r.save(undefined, `c${i}`, emptyDesign(), 'x')
    expect(() => r.save(undefined, 'one too many', emptyDesign(), 'x')).toThrow(/At most/)
  })
  it('IPC schemas validate the design and reject extras', () => {
    const ok = { name: 'n', design: playerTemplate() }
    expect(IPC_REQUEST_SCHEMAS['circuit:save'].safeParse(ok).success).toBe(true)
    expect(IPC_REQUEST_SCHEMAS['circuit:save'].safeParse({ ...ok, path: '/etc/passwd' }).success).toBe(false)
    expect(IPC_REQUEST_SCHEMAS['circuit:save'].safeParse({ ...ok, name: '' }).success).toBe(false)
    expect(IPC_REQUEST_SCHEMAS['circuit:load'].safeParse({ id: 0 }).success).toBe(false)
  })
})

describe('circuit lab: solver robustness', () => {
  it('settles with the switch open (no oscillating power state, no phantom voltage)', () => {
    const d = clone(playerTemplate()); d.parts.find((p) => p.id === 'sw1')!.props['closed'] = false
    const r = evaluate(d)
    expect(r.voltage('esp1', 'VIN')).toBeCloseTo(0, 3)
    expect(r.voltage('dac1', 'VIN')).toBeCloseTo(0, 3)
    expect(r.issues.filter((i) => i.severity !== 'info')).toEqual([])
    expect(r.issues.some((i) => i.severity === 'info' && /not powered/.test(i.message))).toBe(true)
    for (const id of ['esp1', 'oled1', 'encoder1', 'dac1', 'sd1']) expect(r.parts[id]!.state, id).toBe('off')
  })
  it('a part with no ground reads off instead of floating', () => {
    const d = clone(playerTemplate()); d.wires = d.wires.filter((w) => !(w.a.part === 'encoder1' && w.a.pin === 'GND'))
    expect(evaluate(d).parts['encoder1']!.state).toBe('off')
  })
  it('every single-wire removal from the example still converges', () => {
    const base = playerTemplate()
    for (let i = 0; i < base.wires.length; i++) {
      const d = clone(base); d.wires.splice(i, 1)
      expect(evaluate(d).electrical.converged, `wire ${base.wires[i]!.id}`).toBe(true)
    }
  })
  it('removing any one part still converges', () => {
    const base = playerTemplate()
    for (const p of base.parts) {
      const d = clone(base); d.parts = d.parts.filter((x) => x.id !== p.id)
      expect(evaluate(d).electrical.converged, p.id).toBe(true)
    }
  })
})

describe('circuit lab: operating-range sweep', () => {
  it('converges and stays physical across battery voltage and switch position', () => {
    for (const closed of [true, false]) for (let v = 2.5; v <= 4.3001; v += 0.1) {
      const d = clone(playerTemplate())
      d.parts.find((p) => p.id === 'battery1')!.props['voltage'] = v
      d.parts.find((p) => p.id === 'sw1')!.props['closed'] = closed
      const r = evaluate(d)
      expect(r.electrical.converged, `v=${v.toFixed(1)} closed=${closed}`).toBe(true)
      expect(r.electrical.battery!.amps).toBeGreaterThanOrEqual(0)
      expect(r.voltage('esp1', '3V3')).toBeLessThan(3.4)
      if (!closed) expect(r.espRunning).toBe(false)
    }
  })
  it('runs from a battery between 3.4 V and 4.3 V and reports a falling percentage', () => {
    const pct = (v: number): number => { const d = clone(playerTemplate()); d.parts.find((p) => p.id === 'battery1')!.props['voltage'] = v; const r = evaluate(d); expect(r.espRunning, `${v} V`).toBe(true); return r.battery.percent! }
    expect(pct(4.2)).toBeGreaterThan(pct(3.9)); expect(pct(3.9)).toBeGreaterThan(pct(3.5))
  })
})

import { build, EXAMPLES } from '../src/circuit/template'
import { parseCustom } from '../src/circuit/custom'
import { sensorReading } from '../src/circuit/firmware'

const mA = (r: ReturnType<typeof evaluate>, id: string): number => (r.electrical.elements[id]?.amps ?? 0) * 1000

describe('circuit lab: new parts', () => {
  it('every example loads with no errors, converges and validates', () => {
    for (const ex of EXAMPLES) {
      const d = ex.make(), r = evaluate(d)
      expect(r.issues, ex.id).toEqual([])
      expect(r.electrical.converged, ex.id).toBe(true)
      expect(DesignSchema.safeParse(d).success, ex.id).toBe(true)
    }
  })
  it('LED with a 330 Ω resistor from 5 V draws about (5 − Vf) / R', () => {
    const r = evaluate(build([['usb1', 'usb', 0, 0], ['r1', 'resistor', 0, 0, { ohms: 330 }], ['led1', 'led', 0, 0, { color: 0 }]], ['usb1.VBUS r1.A', 'r1.B led1.A', 'led1.K usb1.GND']))
    expect(mA(r, 'led1')).toBeGreaterThan(8.5); expect(mA(r, 'led1')).toBeLessThan(9.5)
    expect(r.parts['led1']!.state).toBe('ok')
    expect(r.voltage('led1', 'A')).toBeCloseTo(1.9 + 0.009 * 2, 1)
  })
  it('LED colour changes the forward drop and an LED with no resistor is an error', () => {
    const mk = (color: number) => evaluate(build([['usb1', 'usb', 0, 0], ['r1', 'resistor', 0, 0, { ohms: 330 }], ['led1', 'led', 0, 0, { color }]], ['usb1.VBUS r1.A', 'r1.B led1.A', 'led1.K usb1.GND']))
    expect(mA(mk(2), 'led1')).toBeLessThan(mA(mk(0), 'led1'))
    const bad = evaluate(build([['usb1', 'usb', 0, 0], ['led1', 'led', 0, 0]], ['usb1.VBUS led1.A', 'led1.K usb1.GND']))
    expect(bad.issues.some((i) => /no current limit/.test(i.message))).toBe(true)
    expect(bad.parts['led1']!.state).toBe('fault')
  })
  it('a reversed LED and a reversed diode block current', () => {
    const r = evaluate(build([['usb1', 'usb', 0, 0], ['r1', 'resistor', 0, 0, { ohms: 330 }], ['led1', 'led', 0, 0], ['d1', 'diode', 0, 0]], ['usb1.VBUS r1.A', 'r1.B led1.K', 'led1.A d1.K', 'd1.A usb1.GND']))
    expect(mA(r, 'led1')).toBe(0); expect(r.parts['led1']!.state).toBe('off')
  })
  it('a diode drops about 0.7 V', () => {
    const r = evaluate(build([['usb1', 'usb', 0, 0], ['d1', 'diode', 0, 0], ['r1', 'resistor', 0, 0, { ohms: 1000 }]], ['usb1.VBUS d1.A', 'd1.K r1.A', 'r1.B usb1.GND']))
    expect(r.voltage('r1', 'A')).toBeGreaterThan(4.1); expect(r.voltage('r1', 'A')).toBeLessThan(4.4)
  })
  it('a potentiometer divides the supply by its wiper position', () => {
    for (const pos of [0.25, 0.5, 0.9]) {
      const r = evaluate(build([['usb1', 'usb', 0, 0], ['p1', 'pot', 0, 0, { pos }]], ['usb1.VBUS p1.A', 'p1.B usb1.GND']))
      expect(r.voltage('p1', 'W')).toBeCloseTo(5 * (1 - pos), 1)
    }
  })
  it('an NPN switches an LED when its base is driven, and warns when the base resistor is too large', () => {
    const base = (pressed: boolean, rb = 10000) => evaluate(build(
      [['usb1', 'usb', 0, 0], ['btn1', 'button', 0, 0, { pressed }], ['r1', 'resistor', 0, 0, { ohms: rb }], ['r3', 'resistor', 0, 0, { ohms: 100000 }], ['npn1', 'npn', 0, 0], ['r2', 'resistor', 0, 0, { ohms: 330 }], ['led1', 'led', 0, 0]],
      ['usb1.VBUS btn1.A', 'btn1.B r1.A', 'r1.B npn1.B', 'r1.B r3.A', 'r3.B usb1.GND', 'usb1.VBUS r2.A', 'r2.B led1.A', 'led1.K npn1.C', 'npn1.E usb1.GND']))
    const on = base(true), off = base(false)
    expect(on.parts['led1']!.state).toBe('ok'); expect(mA(on, 'led1')).toBeGreaterThan(8)
    expect(off.parts['led1']!.state).toBe('off'); expect(off.parts['npn1']!.state).toBe('off')
    expect(on.parts['npn1']!.state).toBe('ok')
    const weak = base(true, 4_700_000)
    expect(weak.parts['npn1']!.state).not.toBe('ok')
  })
  it('MOSFETs follow the gate: N-channel low side and P-channel high side', () => {
    const n = (gate: boolean) => evaluate(build([['usb1', 'usb', 0, 0], ['sw1', 'switch', 0, 0, { closed: gate }], ['rg', 'resistor', 0, 0, { ohms: 100000 }], ['m1', 'nmos', 0, 0], ['r1', 'resistor', 0, 0, { ohms: 100 }]],
      ['usb1.VBUS sw1.A', 'sw1.B m1.G', 'm1.G rg.A', 'rg.B usb1.GND', 'usb1.VBUS r1.A', 'r1.B m1.D', 'm1.S usb1.GND']))
    expect(mA(n(true), 'm1')).toBeGreaterThan(45); expect(mA(n(false), 'm1')).toBe(0)
    const p = (gateLow: boolean) => evaluate(build([['usb1', 'usb', 0, 0], ['sw1', 'switch', 0, 0, { closed: gateLow }], ['rg', 'resistor', 0, 0, { ohms: 100000 }], ['m1', 'pmos', 0, 0], ['r1', 'resistor', 0, 0, { ohms: 100 }]],
      ['usb1.VBUS m1.S', 'm1.G rg.A', 'rg.B usb1.VBUS', 'sw1.A m1.G', 'sw1.B usb1.GND', 'm1.D r1.A', 'r1.B usb1.GND']))
    expect(mA(p(true), 'm1')).toBeGreaterThan(45); expect(mA(p(false), 'm1')).toBe(0)
  })
  it('an op-amp follows its input as a buffer and saturates as a comparator', () => {
    const buf = evaluate(build([['usb1', 'usb', 0, 0], ['ra', 'resistor', 0, 0, { ohms: 10000 }], ['rb', 'resistor', 0, 0, { ohms: 10000 }], ['u1', 'opamp', 0, 0], ['rl', 'resistor', 0, 0, { ohms: 10000 }]],
      ['usb1.VBUS ra.A', 'ra.B rb.A', 'rb.B usb1.GND', 'ra.B u1.INP', 'u1.OUT u1.INN', 'usb1.VBUS u1.VCC', 'usb1.GND u1.GND', 'u1.OUT rl.A', 'rl.B usb1.GND']))
    expect(buf.electrical.converged).toBe(true)
    expect(buf.voltage('u1', 'OUT')).toBeGreaterThan(2.45); expect(buf.voltage('u1', 'OUT')).toBeLessThan(2.55)
    const cmp = (hi: boolean) => evaluate(build([['usb1', 'usb', 0, 0], ['ra', 'resistor', 0, 0, { ohms: hi ? 1000 : 30000 }], ['rb', 'resistor', 0, 0, { ohms: 10000 }], ['rc', 'resistor', 0, 0, { ohms: 10000 }], ['rd', 'resistor', 0, 0, { ohms: 10000 }], ['u1', 'opamp', 0, 0]],
      ['usb1.VBUS ra.A', 'ra.B rb.A', 'rb.B usb1.GND', 'ra.B u1.INP', 'usb1.VBUS rc.A', 'rc.B rd.A', 'rd.B usb1.GND', 'rc.B u1.INN', 'usb1.VBUS u1.VCC', 'usb1.GND u1.GND']))
    expect(cmp(true).voltage('u1', 'OUT')).toBeGreaterThan(4.5)
    expect(cmp(false).voltage('u1', 'OUT')).toBeLessThan(0.5)
  })
  it('an LDO regulates, drops out when the input is too low, and a buck draws less input current', () => {
    const reg = (vin: number, buck = false) => evaluate(build([['b1', 'battery', 0, 0, { voltage: 4.3 }], ['u1', 'usb', 0, 0], ['reg1', 'regulator', 0, 0, { vout: 3.3, buck }], ['rl', 'resistor', 0, 0, { ohms: 33 }]],
      ['u1.VBUS reg1.IN', 'u1.GND reg1.GND', 'reg1.OUT rl.A', 'rl.B u1.GND', 'b1.P b1.P', 'b1.N u1.GND']))
    const ok = reg(5)
    expect(ok.voltage('reg1', 'OUT')).toBeGreaterThan(3.2); expect(ok.voltage('reg1', 'OUT')).toBeLessThan(3.31)
    expect(ok.electrical.converged).toBe(true)
    expect(ok.parts['reg1']!.state).toBe('ok')
    const lowIn = evaluate(build([['b1', 'battery', 0, 0, { voltage: 3.4 }], ['reg1', 'regulator', 0, 0], ['rl', 'resistor', 0, 0, { ohms: 33 }]],
      ['b1.P reg1.IN', 'b1.N reg1.GND', 'reg1.OUT rl.A', 'rl.B b1.N']))
    expect(lowIn.voltage('reg1', 'OUT')).toBeLessThan(3.2); expect(lowIn.parts['reg1']!.state).toBe('warn')
    const inA = (buck: boolean) => evaluate(build([['b1', 'battery', 0, 0, { voltage: 4.2 }], ['reg1', 'regulator', 0, 0, { vout: 1.8, buck }], ['rl', 'resistor', 0, 0, { ohms: 9 }]],
      ['b1.P reg1.IN', 'b1.N reg1.GND', 'reg1.OUT rl.A', 'rl.B b1.N'])).electrical.battery!.amps
    expect(inA(true)).toBeLessThan(inA(false) * 0.7)
  })
  it('a relay closes its contact when the coil is energized', () => {
    const rl = (coil: boolean) => evaluate(build([['usb1', 'usb', 0, 0], ['sw1', 'switch', 0, 0, { closed: coil }], ['k1', 'relay', 0, 0], ['r1', 'resistor', 0, 0, { ohms: 500 }], ['r2', 'resistor', 0, 0, { ohms: 500 }]],
      ['usb1.VBUS sw1.A', 'sw1.B k1.CP', 'k1.CN usb1.GND', 'usb1.VBUS k1.COM', 'k1.NO r1.A', 'r1.B usb1.GND', 'k1.NC r2.A', 'r2.B usb1.GND']))
    const on = rl(true), off = rl(false)
    expect(on.parts['k1']!.state).toBe('ok'); expect(on.voltage('r1', 'A')).toBeGreaterThan(4.5); expect(on.voltage('r2', 'A')).toBeLessThan(0.5)
    expect(off.parts['k1']!.state).toBe('off'); expect(off.voltage('r2', 'A')).toBeGreaterThan(4.5)
  })
  it('capacitors block DC and inductors pass it', () => {
    const r = evaluate(build([['usb1', 'usb', 0, 0], ['c1', 'capacitor', 0, 0], ['rc', 'resistor', 0, 0, { ohms: 1000 }], ['l1', 'inductor', 0, 0], ['rl', 'resistor', 0, 0, { ohms: 1000 }]],
      ['usb1.VBUS c1.A', 'c1.B rc.A', 'rc.B usb1.GND', 'usb1.VBUS l1.A', 'l1.B rl.A', 'rl.B usb1.GND']))
    expect(r.voltage('rc', 'A')).toBeLessThan(0.1); expect(r.voltage('rl', 'A')).toBeGreaterThan(4.5)
  })
  it('a buzzer sounds with enough voltage and a servo needs 4–6 V', () => {
    const r = evaluate(build([['usb1', 'usb', 0, 0], ['bz1', 'buzzer', 0, 0], ['sv1', 'servo', 0, 0]], ['usb1.VBUS bz1.P', 'bz1.N usb1.GND', 'usb1.VBUS sv1.VCC', 'sv1.GND usb1.GND']))
    expect(r.parts['bz1']!.messages.join()).toMatch(/Sounding/)
    expect(r.parts['sv1']!.state).not.toBe('fault')
  })
  it('unplugging USB removes the 5 V rail', () => {
    const r = evaluate(build([['usb1', 'usb', 0, 0, { plugged: false }], ['r1', 'resistor', 0, 0]], ['usb1.VBUS r1.A', 'r1.B usb1.GND']))
    expect(r.voltage('r1', 'A')).toBeLessThan(0.1); expect(r.parts['usb1']!.state).toBe('off')
  })
  it('I²C devices may share GPIO21/22; the sensor is read only when it works; 5 V damages it', () => {
    const d = EXAMPLES.find((e) => e.id === 'sensor')!.make()
    const r = evaluate(d)
    expect(r.issues.some((i) => /conflict/.test(i.message))).toBe(false)
    expect(sensorReading(r, d)).toEqual({ tempC: 24.5 })
    expect(r.parts['esp1']!.state).toBe('ok')
    const bad = clone(d); bad.wires = bad.wires.filter((w) => !(w.a.part === 'sensor1' && w.a.pin === 'VCC'))
    bad.wires.push({ id: 'wv', a: { part: 'sensor1', pin: 'VCC' }, b: { part: 'usb1', pin: 'VBUS' } })
    const rb = evaluate(bad)
    expect(rb.parts['sensor1']!.state).toBe('fault'); expect(sensorReading(rb, bad)).toBeNull()
  })
  it('two different signals on one GPIO are still a conflict', () => {
    const d = EXAMPLES.find((e) => e.id === 'sensor')!.make(); d.firmware['sensor.SDA'] = 22
    expect(evaluate(d).issues.some((i) => /conflict/.test(i.message))).toBe(true)
  })
})

describe('circuit lab: custom parts', () => {
  it('parses a pin list, rejects bad input and gives each part a unique id', () => {
    const ok = parseCustom({ name: 'Hall sensor', pins: 'VCC:power, GND:gnd, OUT', vmin: 3, vmax: 5.5, mA: 5 }, [])
    expect('def' in ok && ok.def.pins.map((p) => `${p.id}:${p.type}:${p.side}`)).toEqual(['VCC:power:L', 'GND:gnd:R', 'OUT:signal:L'])
    expect('def' in ok && ok.def.supply).toEqual({ vmin: 3, vmax: 5.5, mA: 5 })
    expect('def' in parseCustom({ name: 'x', pins: 'A', vmin: 0, vmax: 0, mA: 0 }, ['c1']) && (parseCustom({ name: 'x', pins: 'A', vmin: 0, vmax: 0, mA: 0 }, ['c1']) as { def: { id: string } }).def.id).toBe('c2')
    for (const bad of [{ name: '', pins: 'A' }, { name: 'x', pins: '' }, { name: 'x', pins: 'A,A' }, { name: 'x', pins: 'A:wat' }, { name: 'x', pins: 'A:signal:Q' }, { name: 'x', pins: 'V:power,G:gnd', vmin: 5, vmax: 3 }, { name: 'x', pins: Array.from({ length: 30 }, (_, i) => `P${i}`).join() }])
      expect('error' in parseCustom({ vmin: 3, vmax: 5, mA: 1, ...bad }, [])).toBe(true)
  })
  it('a placed custom part is powered, loads the rail, and is flagged when over-volted', () => {
    const c = parseCustom({ name: 'Hall sensor', pins: 'VCC:power, GND:gnd, OUT', vmin: 3, vmax: 3.6, mA: 5 }, [])
    if (!('def' in c)) throw new Error('parse')
    let d = build([['usb1', 'usb', 0, 0], ['reg1', 'regulator', 0, 0]], ['usb1.VBUS reg1.IN', 'usb1.GND reg1.GND'])
    d = { ...d, customs: [c.def] }
    const add = addPart(d, 'custom', 0, 0, c.def.id)!; d = add.design
    d = { ...d, wires: [...d.wires, { id: 'a1', a: { part: 'reg1', pin: 'OUT' }, b: { part: add.id, pin: 'VCC' } }, { id: 'a2', a: { part: 'usb1', pin: 'GND' }, b: { part: add.id, pin: 'GND' } }] }
    const r = evaluate(d)
    expect(r.parts[add.id]!.state).toBe('ok')
    expect(r.parts[add.id]!.messages.join()).toMatch(/3\.3\d V/)
    d = { ...d, wires: d.wires.map((w) => (w.id === 'a1' ? { ...w, a: { part: 'usb1', pin: 'VBUS' } } : w)) }
    expect(evaluate(d).parts[add.id]!.state).toBe('fault')
    expect(addPart({ ...d, customs: [] }, 'custom', 0, 0, c.def.id)).toBeNull()
  })
})

import { PROP_FIELDS, fitBox, wirePoints } from '../src/renderer/pages/circuit-logic'
import { BUILTIN_KINDS } from '../src/circuit/types'
import { PART_DEFS, defaultProps } from '../src/circuit/parts'

describe('circuit lab: UI logic', () => {
  it('every editable property exists on its part with a matching type', () => {
    for (const [kind, fields] of Object.entries(PROP_FIELDS)) for (const f of fields!) {
      const d = defaultProps(kind as keyof typeof PART_DEFS)[f.key]
      expect(d, `${kind}.${f.key}`).toBeDefined()
      expect(typeof d, `${kind}.${f.key}`).toBe(f.kind === 'bool' ? 'boolean' : 'number')
      if (f.kind === 'number') expect(d as number, `${kind}.${f.key}`).toBeGreaterThanOrEqual(f.min ?? -Infinity)
    }
  })
  it('every built-in part has unique pin ids, a name and routes wires', () => {
    for (const k of BUILTIN_KINDS) {
      const def = PART_DEFS[k]
      const ids = [...def.left, ...def.right].map((p) => p.id)
      expect(new Set(ids).size, k).toBe(ids.length)
      expect(def.name.length, k).toBeGreaterThan(0)
      expect(def.kind, k).toBe(k)
      if (def.supply) { expect(ids, k).toContain(def.supply.pin); expect(ids, k).toContain(def.supply.gnd) }
    }
  })
  it('every part kind can be placed alone on a PCB and evaluated without throwing or diverging', () => {
    for (const k of BUILTIN_KINDS) {
      const d = build([['p1', k, 0, 0]], [])
      expect(evaluate(d).electrical.converged, k).toBe(true)
    }
  })
  it('fitBox covers custom parts and wirePoints resolves their pins', () => {
    const c = parseCustom({ name: 'X', pins: 'VCC:power, GND:gnd', vmin: 3, vmax: 5, mA: 1 }, [])
    if (!('def' in c)) throw new Error('parse')
    let d: Design = { ...emptyDesign(), customs: [c.def] }
    const a = addPart(d, 'custom', 400, 300, c.def.id)!; d = a.design
    const b = addPart(d, 'resistor', 100, 100)!; d = b.design
    const w = addWire(d, { part: b.id, pin: 'B' }, { part: a.id, pin: 'VCC' }); if ('error' in w) throw new Error(w.error); d = w.design
    expect(wirePoints(d, d.wires[0]!)).toMatch(/^\d+,\d+/)
    const box = fitBox(d)
    expect(box.x).toBeLessThanOrEqual(100); expect(box.x + box.w).toBeGreaterThanOrEqual(530)
  })
})

import { BOARDS, BOARD_TYPES, HOLE, boardMm, boardPitch, boardRect, resolveBoard } from '../src/circuit/board'
import { buildNetlist, net } from '../src/circuit/netlist'
import { ldrOhms, thermistorOhms } from '../src/circuit/sim'
import type { Board } from '../src/circuit/types'

describe('circuit lab: boards', () => {
  it('resolves every board type to a sane rectangle', () => {
    for (const t of BOARD_TYPES) {
      const b = { type: t } as Board
      const r = boardRect(b)
      const sized = resolveBoard(b)
      expect(r.w, t).toBeGreaterThan(HOLE * 4)
      expect(r.h, t).toBeGreaterThan(HOLE * 4)
      expect(r.w, t).toBe(sized.margin * 2 + sized.cols * HOLE)
      expect(BOARDS[t].name.length, t).toBeGreaterThan(0)
      expect(boardMm(b).w, t).toBeGreaterThan(0)
      expect(BOARDS[t].description.length, t).toBeGreaterThan(20)
    }
  })
  it('falls back to a PCB when the stored board is unknown, and clamps a custom size', () => {
    expect(resolveBoard({ type: 'nope' as never }).type).toBe('pcb')
    expect(resolveBoard(undefined).type).toBe('pcb')
    expect(resolveBoard({ type: 'custom', cols: 200, rows: 1 })).toMatchObject({ cols: 120, rows: 8 })
    expect(resolveBoard({ type: 'custom', cols: 44, rows: 22 })).toMatchObject({ cols: 44, rows: 22 })
  })
  it('snaps to holes only on boards that have them', () => {
    expect(boardPitch({ type: 'breadboard' })).toBe(HOLE)
    expect(boardPitch({ type: 'perfboard' })).toBe(HOLE)
    expect(boardPitch({ type: 'stripboard' })).toBe(HOLE)
    expect(boardPitch({ type: 'custom' })).toBe(HOLE)
    expect(boardPitch({ type: 'pcb' })).toBe(0)
    expect(boardPitch({ type: 'uno' })).toBe(0)
  })
  it('the same design behaves identically on every board', () => {
    const base = playerTemplate()
    const ref = evaluate(base)
    for (const type of BOARD_TYPES) {
      const d: Design = { ...structuredClone(base), board: type === 'custom' ? { type, cols: 30, rows: 20 } : { type } }
      const r = evaluate(d)
      expect(r.issues.map((i) => i.message), type).toEqual(ref.issues.map((i) => i.message))
      expect(r.voltage('esp1', '3V3'), type).toBeCloseTo(ref.voltage('esp1', '3V3'), 6)
      expect(r.parts['oled1']!.state, type).toBe('ok')
    }
  })
  it('fitBox always shows the whole board, even with no parts', () => {
    const d: Design = { ...emptyDesign(), board: { type: 'breadboard' } }
    const r = boardRect(d.board)
    const box = fitBox(d)
    expect(box.x).toBeLessThanOrEqual(r.x)
    expect(box.y).toBeLessThanOrEqual(r.y)
    expect(box.x + box.w).toBeGreaterThanOrEqual(r.x + r.w)
    expect(box.y + box.h).toBeGreaterThanOrEqual(r.y + r.h)
  })
  it('stores a board in the design schema and rejects malformed ones', () => {
    const d: Design = { ...emptyDesign(), board: { type: 'breadboard' } }
    expect(DesignSchema.safeParse(d).success).toBe(true)
    expect(DesignSchema.safeParse({ ...d, board: { type: 'breadboard', cols: 5 } }).success).toBe(false)
    expect(DesignSchema.safeParse({ ...d, board: { type: 'nope' } }).success).toBe(false)
    expect(DesignSchema.safeParse({ ...d, board: { type: 'custom' } }).success).toBe(false)
    expect(DesignSchema.safeParse({ ...d, board: { type: 'custom', cols: 24, rows: 16 } }).success).toBe(true)
    expect(DesignSchema.safeParse({ ...d, board: { type: 'custom', cols: 1000, rows: 16 } }).success).toBe(false)
    const parsed = DesignSchema.parse(d) as Design
    expect(parsed.board).toEqual({ type: 'breadboard' })
  })
})

describe('circuit lab: new parts', () => {
  it('every new part kind converges on its own', () => {
    for (const k of ['fuse', 'ldr', 'thermistor', 'motor', 'fan', 'rgb', 'header'] as const) {
      const d = build([['p1', k, 0, 0]], [])
      expect(evaluate(d).electrical.converged, k).toBe(true)
    }
  })
  it('a fuse over its rating is reported and a blown fuse is open', () => {
    const d = build([['usb1', 'usb', 0, 0], ['f1', 'fuse', 200, 0, { amps: 0.5 }], ['r1', 'resistor', 400, 0, { ohms: 1 }]],
      ['usb1.VBUS f1.A', 'f1.B r1.A', 'r1.B usb1.GND'])
    const r = evaluate(d)
    expect(r.parts['f1']!.state).toBe('fault')
    expect(r.issues.some((i) => /would blow/i.test(i.message))).toBe(true)
    const blown = structuredClone(d)
    blown.parts.find((p) => p.id === 'f1')!.props['blown'] = true
    const rb = evaluate(blown)
    expect(rb.issues.some((i) => /would blow/i.test(i.message))).toBe(false)
    expect(rb.parts['f1']!.messages.join()).toMatch(/blown/i)
    // An open fuse leaves no current path, so the resistor drops no voltage.
    expect(Math.abs(rb.voltage('r1', 'A') - rb.voltage('r1', 'B'))).toBeLessThan(1e-3)
  })
  it('the LDR resistance falls with light and the thermistor with heat', () => {
    expect(ldrOhms(0)).toBe(1_000_000)
    expect(ldrOhms(100)).toBeLessThan(ldrOhms(10))
    expect(ldrOhms(1000)).toBeLessThan(ldrOhms(100))
    expect(thermistorOhms(10000, 3950, 60)).toBeLessThan(thermistorOhms(10000, 3950, 25))
    expect(thermistorOhms(10000, 3950, 0)).toBeGreaterThan(thermistorOhms(10000, 3950, 25))
    expect(thermistorOhms(10000, 3950, 25)).toBeCloseTo(10000, 6)
  })
  it('motor and fan draw current from a supply', () => {
    const d = build([['usb1', 'usb', 0, 0], ['m1', 'motor', 200, 0, { ohms: 12 }], ['f1', 'fan', 400, 0, { ohms: 50 }]],
      ['usb1.VBUS m1.A', 'm1.B usb1.GND', 'usb1.VBUS f1.A', 'f1.B usb1.GND'])
    const r = evaluate(d)
    expect(r.parts['m1']!.state).toBe('ok')
    expect(r.parts['f1']!.state).toBe('ok')
    expect(r.electrical.elements['m1']!.amps).toBeGreaterThan(0.3)
    expect(r.electrical.elements['f1']!.amps).toBeGreaterThan(0.05)
  })
  it('RGB channels light independently and over-current is caught', () => {
    const d = build([['usb1', 'usb', 0, 0], ['r1', 'resistor', 200, 0, { ohms: 330 }], ['rgb1', 'rgb', 400, 0]],
      ['usb1.VBUS r1.A', 'r1.B rgb1.R', 'rgb1.G usb1.GND', 'rgb1.B usb1.GND', 'rgb1.K usb1.GND'])
    const r = evaluate(d)
    const ch = r.electrical.elements['rgb1']!.channels!
    expect(ch[0]).toBeGreaterThan(0.005) // red through 330 Ω
    expect(ch[1]).toBe(0) // green is grounded on both ends
    expect(ch[2]).toBe(0) // blue has 3.0 V forward drop, so 5 V through none
    expect(r.issues.some((i) => /RGB LED/.test(i.message))).toBe(false)
    const hot = build([['usb1', 'usb', 0, 0], ['rgb1', 'rgb', 200, 0]], ['usb1.VBUS rgb1.R', 'rgb1.K usb1.GND'])
    expect(evaluate(hot).issues.some((i) => /series resistor per colour/i.test(i.message))).toBe(true)
  })
  it('header pins are independent pads, not tied together', () => {
    const d = build([['h1', 'header', 0, 0]], [])
    const nl = buildNetlist(d)
    expect(net(nl, 'h1', 'A1')).not.toBe(net(nl, 'h1', 'B1'))
    expect(evaluate(d).parts['h1']!.state).toBe('ok')
  })
  it('every example is clean, and the light detector turns its LED on', () => {
    for (const ex of EXAMPLES) {
      const r = evaluate(ex.make())
      expect(r.issues, ex.id).toEqual([])
    }
    const d = EXAMPLES.find((e) => e.id === 'nightlight')!.make()
    expect(evaluate(d).parts['led1']!.state).toBe('ok')
    const dark = structuredClone(d)
    dark.parts.find((p) => p.id === 'ldr1')!.props['lux'] = 0
    expect(evaluate(dark).parts['led1']!.state).toBe('off')
  })
})
