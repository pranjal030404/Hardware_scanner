import { PART_DEFS } from './parts'
import type { Report } from './engine'
import type { Design } from './types'

/** State of the virtual player firmware: an encoder-driven volume control and a play/pause button. */
export interface FwState { volume: number; playing: boolean; presses: number; turns: number }
export const initialFw = (): FwState => ({ volume: 40, playing: false, presses: 0, turns: 0 })
export type FwEvent = 'cw' | 'ccw' | 'press'

const ok = (r: Report, design: Design, kind: 'oled' | 'encoder' | 'dac' | 'sd' | 'sensor'): boolean => {
  const p = design.parts.find((x) => x.kind === kind)
  return !!p && r.parts[p.id]?.state !== 'fault' && r.parts[p.id]?.state !== 'off' && r.parts[p.id]?.state !== 'idle' && r.espRunning
}

/** Inputs only reach the firmware when the ESP32 runs and the encoder is powered and wired to the pins it reads. */
export const encoderWorks = (r: Report, d: Design): boolean => ok(r, d, 'encoder')
export const displayWorks = (r: Report, d: Design): boolean => ok(r, d, 'oled')

/** The temperature the firmware reads over I²C, or null when the sensor is unpowered, unwired or the ESP32 is not running. */
export function sensorReading(r: Report, d: Design): { tempC: number } | null {
  const p = d.parts.find((x) => x.kind === 'sensor')
  return p && ok(r, d, 'sensor') ? { tempC: Number(p.props['tempC'] ?? 24.5) } : null
}

export function step(s: FwState, ev: FwEvent): FwState {
  if (ev === 'press') return { ...s, playing: !s.playing, presses: s.presses + 1 }
  const volume = Math.min(100, Math.max(0, s.volume + (ev === 'cw' ? 2 : -2)))
  return { ...s, volume, turns: s.turns + 1 }
}

/** Why playback is not producing sound, or null when it is. */
export function audioProblem(r: Report, d: Design, s: FwState): string | null {
  if (!s.playing) return null
  if (!r.espRunning) return 'ESP32 is not running'
  if (!ok(r, d, 'dac')) return 'DAC is not working'
  if (!ok(r, d, 'sd')) return 'SD card unavailable'
  const sd = d.parts.find((x) => x.kind === 'sd')
  if (sd && sd.props['card'] === false) return 'no SD card'
  return null
}

export interface OledView { lines: string[]; battery: string; status: string }

export function oledView(r: Report, d: Design, s: FwState, now: Date): OledView | null {
  if (!displayWorks(r, d)) return null
  const hh = String(now.getHours()).padStart(2, '0'), mm = String(now.getMinutes()).padStart(2, '0')
  const problem = audioProblem(r, d, s)
  return {
    lines: [`${hh}:${mm}`, `VOL ${s.volume}`],
    battery: r.battery.percent === null ? 'BAT --' : `BAT ${r.battery.percent}%`,
    status: problem ? `! ${problem}` : s.playing ? '> PLAYING' : '|| PAUSED'
  }
}

export const partName = (kind: keyof typeof PART_DEFS): string => PART_DEFS[kind].name
