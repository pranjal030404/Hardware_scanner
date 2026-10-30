/** Virtual circuit lab: the design model. Pure data, so it can be saved, validated and simulated anywhere. */
export const BUILTIN_KINDS = [
  'esp32', 'oled', 'encoder', 'dac', 'sd', 'battery', 'charger', 'switch', 'resistor',
  'capacitor', 'inductor', 'diode', 'led', 'rgb', 'pot', 'button', 'npn', 'pnp', 'nmos', 'pmos', 'opamp', 'regulator',
  'sensor', 'buzzer', 'relay', 'servo', 'usb', 'fuse', 'ldr', 'thermistor', 'motor', 'fan', 'header'
] as const
export type BuiltinKind = (typeof BUILTIN_KINDS)[number]
/** `custom` parts are described by a CustomDef stored in the design. */
export const PART_KINDS = [...BUILTIN_KINDS, 'custom'] as const
export type PartKind = (typeof PART_KINDS)[number]

/** Named power rails. Pins that source a rail (or ground) are tagged so shorts between rails can be found. */
export type Rail = 'GND' | '3V3' | '5V' | 'VBAT'

export interface PinRef { part: string; pin: string }
export type PropValue = number | boolean
export interface PartInst { id: string; kind: PartKind; x: number; y: number; props: Record<string, PropValue>; /** CustomDef id, for kind `custom`. */ def?: string }
export interface Wire { id: string; a: PinRef; b: PinRef }
/** Which ESP32 GPIO the (virtual) firmware uses for each peripheral signal, keyed `${kind}.${pin}`. */
export type Firmware = Record<string, number>
export type CustomPinType = 'power' | 'gnd' | 'signal' | 'passive'
export interface CustomPin { id: string; label: string; type: CustomPinType; side: 'L' | 'R' }
/** Which physical carrier the circuit is laid out on. It shapes the canvas, not the circuit. */
export const BOARD_TYPES = [
  'pcb', 'pcb-single', 'pcb-double', 'eurocard',
  'breadboard', 'breadboard-half', 'breadboard-mini', 'perfboard', 'stripboard', 'proto-shield',
  'uno', 'mega', 'nano', 'promini', 'esp32dev', 'esp32s3', 'esp32c3', 'nodemcu', 'wemos',
  'pico', 'bluepill', 'teensy', 'feather', 'microbit', 'pizero', 'pihat', 'custom'
] as const
export type BoardType = (typeof BOARD_TYPES)[number]
/** `custom` uses cols/rows (holes); every other type has a fixed size. */
export interface Board { type: BoardType; cols?: number; rows?: number }

/** A user-defined part: pins plus, when it has a power and a ground pin, a supply range and load. */
export interface CustomDef { id: string; name: string; accent: string; pins: CustomPin[]; supply?: { vmin: number; vmax: number; mA: number } }
export interface Design { parts: PartInst[]; wires: Wire[]; firmware: Firmware; customs?: CustomDef[]; board?: Board }

export interface CircuitSummary { id: number; name: string; createdAt: string; updatedAt: string; parts: number; wires: number }
export interface SavedCircuit extends CircuitSummary { design: Design }

export const pinKey = (r: PinRef): string => `${r.part}.${r.pin}`
