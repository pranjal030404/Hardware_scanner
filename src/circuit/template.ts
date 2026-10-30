import { defaultProps } from './parts'
import { defaultFirmware } from './signals'
import type { Board, Design, PartKind, PropValue, Wire } from './types'

/** The handheld player from the reference diagram: ESP32 + OLED + encoder + PCM5102A + microSD on a Li-ion pack. */
export function playerTemplate(): Design {
  const at: [string, PartKind, number, number][] = [
    ['oled1', 'oled', 40, 30], ['encoder1', 'encoder', 40, 190], ['dac1', 'dac', 40, 370],
    ['esp1', 'esp32', 420, 60], ['sd1', 'sd', 760, 40],
    ['battery1', 'battery', 40, 600], ['r1', 'resistor', 240, 640], ['r2', 'resistor', 380, 640],
    ['sw1', 'switch', 560, 640], ['charger1', 'charger', 720, 560]
  ]
  const parts = at.map(([id, kind, x, y]) => ({ id, kind, x, y, props: defaultProps(kind) }))
  let n = 0
  const w = (a: string, b: string): Wire => {
    const [pa, na] = a.split('.') as [string, string]
    const [pb, nb] = b.split('.') as [string, string]
    return { id: `w${++n}`, a: { part: pa, pin: na }, b: { part: pb, pin: nb } }
  }
  const wires = [
    w('oled1.VDD', 'esp1.3V3'), w('oled1.GND', 'esp1.GND1'), w('oled1.SCK', 'esp1.G22'), w('oled1.SDA', 'esp1.G21'),
    w('encoder1.CLK', 'esp1.G32'), w('encoder1.DT', 'esp1.G33'), w('encoder1.SW', 'esp1.G14'), w('encoder1.PLUS', 'esp1.3V3'), w('encoder1.GND', 'esp1.GND1'),
    w('dac1.VIN', 'sw1.B'), w('dac1.GND', 'esp1.GND1'), w('dac1.LCK', 'esp1.G25'), w('dac1.DIN', 'esp1.G27'), w('dac1.BCK', 'esp1.G26'), w('dac1.SCK', 'dac1.GND'),
    w('sd1.GND', 'esp1.GND2'), w('sd1.MISO', 'esp1.G19'), w('sd1.CLK', 'esp1.G18'), w('sd1.MOSI', 'esp1.G23'), w('sd1.CS', 'esp1.G5'), w('sd1.V3', 'esp1.3V3'),
    w('battery1.P', 'charger1.BP'), w('battery1.N', 'charger1.BN'), w('charger1.BN', 'esp1.GND1'), w('charger1.ON', 'esp1.GND1'),
    w('charger1.OP', 'sw1.A'), w('sw1.B', 'esp1.VIN'),
    w('battery1.P', 'r1.A'), w('r1.B', 'r2.A'), w('r2.A', 'esp1.G34'), w('r2.B', 'esp1.GND1')
  ]
  return { parts, wires, firmware: defaultFirmware(), board: { type: 'pcb' } }
}

export const emptyDesign = (): Design => ({ parts: [], wires: [], firmware: defaultFirmware(), board: { type: 'pcb' } })

type PartSpec = [id: string, kind: PartKind, x: number, y: number, props?: Record<string, PropValue>]

/** Build a design from part specs and `a.pin b.pin` wire strings. */
export function build(parts: PartSpec[], wires: string[], firmware = defaultFirmware(), board?: Board): Design {
  return {
    parts: parts.map(([id, kind, x, y, props]) => ({ id, kind, x, y, props: { ...defaultProps(kind), ...props } })),
    wires: wires.map((s, i) => {
      const [a, b] = s.split(' ') as [string, string]
      const [pa, na] = a.split('.') as [string, string], [pb, nb] = b.split('.') as [string, string]
      return { id: `w${i + 1}`, a: { part: pa, pin: na }, b: { part: pb, pin: nb } }
    }),
    firmware,
    ...(board ? { board } : {})
  }
}

export interface Example { id: string; name: string; description: string; make: () => Design }

export const EXAMPLES: Example[] = [
  { id: 'player', name: 'Handheld player', description: 'ESP32, OLED, encoder, DAC, microSD on a Li-ion pack.', make: playerTemplate },
  {
    id: 'led', name: 'LED + resistor', description: 'USB 5 V through a 330 Ω resistor into an LED, on a half breadboard.',
    make: () => build([['usb1', 'usb', 40, 60], ['r1', 'resistor', 260, 60, { ohms: 330 }], ['led1', 'led', 420, 60, { color: 1 }]], ['usb1.VBUS r1.A', 'r1.B led1.A', 'led1.K usb1.GND'], undefined, { type: 'breadboard-half' })
  },
  {
    id: 'transistor', name: 'Transistor LED driver', description: 'A push button switches an NPN that drives an LED, on a breadboard.',
    make: () => build(
      [['usb1', 'usb', 40, 80], ['btn1', 'button', 240, 40], ['r1', 'resistor', 380, 40, { ohms: 10000 }], ['r3', 'resistor', 380, 160, { ohms: 100000 }], ['npn1', 'npn', 540, 90], ['r2', 'resistor', 540, 260, { ohms: 330 }], ['led1', 'led', 700, 260, { color: 0 }]],
      ['usb1.VBUS btn1.A', 'btn1.B r1.A', 'r1.B npn1.B', 'r1.B r3.A', 'r3.B usb1.GND', 'usb1.VBUS r2.A', 'r2.B led1.A', 'led1.K npn1.C', 'npn1.E usb1.GND'],
      undefined, { type: 'breadboard' }
    )
  },
  {
    id: 'sensor', name: 'Regulated sensor board', description: 'USB → 3.3 V regulator → ESP32 with an I²C sensor and OLED on one bus, on a perfboard.',
    make: () => build(
      [['usb1', 'usb', 40, 60], ['reg1', 'regulator', 240, 60], ['c1', 'capacitor', 240, 200], ['esp1', 'esp32', 480, 40], ['sensor1', 'sensor', 760, 40], ['oled1', 'oled', 760, 220]],
      ['usb1.VBUS reg1.IN', 'usb1.GND reg1.GND', 'usb1.GND esp1.GND1', 'reg1.OUT esp1.3V3', 'c1.A esp1.3V3', 'c1.B esp1.GND1', 'sensor1.VCC esp1.3V3', 'sensor1.GND esp1.GND1', 'sensor1.SDA esp1.G21', 'sensor1.SCL esp1.G22', 'oled1.VDD esp1.3V3', 'oled1.GND esp1.GND1', 'oled1.SCK esp1.G22', 'oled1.SDA esp1.G21'],
      undefined, { type: 'perfboard' }
    )
  },
  {
    id: 'nightlight', name: 'Breadboard light detector', description: 'An LDR and a 100 kΩ divider switch an NPN that lights an LED when light falls on the sensor.',
    make: () => build(
      [['usb1', 'usb', 40, 60], ['ldr1', 'ldr', 240, 60], ['r1', 'resistor', 240, 220, { ohms: 100000 }], ['npn1', 'npn', 420, 160], ['r2', 'resistor', 560, 320, { ohms: 330 }], ['led1', 'led', 720, 320, { color: 4 }]],
      ['usb1.VBUS ldr1.A', 'ldr1.B npn1.B', 'npn1.B r1.A', 'r1.B usb1.GND', 'usb1.VBUS r2.A', 'r2.B led1.A', 'led1.K npn1.C', 'npn1.E usb1.GND'],
      undefined, { type: 'breadboard' }
    )
  }
]
