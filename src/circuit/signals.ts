import type { Firmware, PartKind } from './types'

/** A peripheral signal the virtual firmware drives or samples on an ESP32 GPIO. */
export interface SignalDef { key: string; kind: PartKind; pin: string; label: string; dir: 'in' | 'out' | 'io'; default: number; /** Signals sharing a bus may share a GPIO (I²C devices on one pair of wires). */ bus?: string }

const s = (kind: PartKind, pin: string, label: string, dir: SignalDef['dir'], def: number, bus?: string): SignalDef => ({ key: `${kind}.${pin}`, kind, pin, label, dir, default: def, ...(bus ? { bus } : {}) })

export const SIGNALS: SignalDef[] = [
  s('oled', 'SDA', 'OLED SDA (I²C data)', 'io', 21, 'i2c-sda'),
  s('oled', 'SCK', 'OLED SCL (I²C clock)', 'out', 22, 'i2c-scl'),
  s('sensor', 'SDA', 'Sensor SDA (I²C data)', 'io', 21, 'i2c-sda'),
  s('sensor', 'SCL', 'Sensor SCL (I²C clock)', 'out', 22, 'i2c-scl'),
  s('servo', 'SIG', 'Servo signal (PWM)', 'out', 13),
  s('dac', 'BCK', 'DAC BCK (I²S bit clock)', 'out', 26),
  s('dac', 'LCK', 'DAC LRCK (I²S word select)', 'out', 25),
  s('dac', 'DIN', 'DAC DIN (I²S data)', 'out', 27),
  s('sd', 'CLK', 'SD SCK (SPI clock)', 'out', 18),
  s('sd', 'MISO', 'SD MISO', 'in', 19),
  s('sd', 'MOSI', 'SD MOSI', 'out', 23),
  s('sd', 'CS', 'SD CS', 'out', 5),
  s('encoder', 'CLK', 'Encoder CLK', 'in', 32),
  s('encoder', 'DT', 'Encoder DT', 'in', 33),
  s('encoder', 'SW', 'Encoder button', 'in', 14)
]

/** Battery sense: the firmware samples this ADC pin, which should sit on a VBAT/2 divider. */
export const ADC_KEY = 'adc.vbat'
export const ADC_DEFAULT = 34

export const defaultFirmware = (): Firmware => ({ ...Object.fromEntries(SIGNALS.map((x) => [x.key, x.default])), [ADC_KEY]: ADC_DEFAULT })
