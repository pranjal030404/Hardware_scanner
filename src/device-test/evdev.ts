import { constants, promises as fs } from 'node:fs'
import type { SysReader } from '@collectors/core/sysreader'
import type { ButtonStats, LiveState } from './types'

// linux/input-event-codes.h
export const EV_SYN = 0
export const EV_KEY = 1
export const EV_REL = 2
export const EV_ABS = 3
export const SYN_DROPPED = 3
export const REL_X = 0
export const REL_Y = 1
export const REL_HWHEEL = 6
export const REL_WHEEL = 8
export const BTN_TOUCH = 0x14a
export const ABS_X = 0
export const ABS_Y = 1

export const BUTTON_NAMES: Record<number, string> = {
  0x110: 'Left button', 0x111: 'Right button', 0x112: 'Middle button (wheel click)', 0x113: 'Side button', 0x114: 'Extra button',
  0x115: 'Forward button', 0x116: 'Back button', 0x117: 'Task button'
}
const FINGERS: Record<number, number> = { 0x145: 1, 0x14d: 2, 0x14e: 3, 0x14f: 4, 0x148: 5 }

const KEY_NAMES: Record<number, string> = (() => {
  const m: Record<number, string> = { 1: 'Esc', 12: '-', 13: '=', 14: 'Backspace', 15: 'Tab', 26: '[', 27: ']', 28: 'Enter', 29: 'Left Ctrl', 39: ';', 40: "'", 41: '`', 42: 'Left Shift', 43: '\\', 51: ',', 52: '.', 53: '/', 54: 'Right Shift', 55: 'Keypad *', 56: 'Left Alt', 57: 'Space', 58: 'Caps Lock', 69: 'Num Lock', 70: 'Scroll Lock', 86: '102nd key', 87: 'F11', 88: 'F12', 96: 'Keypad Enter', 97: 'Right Ctrl', 98: 'Keypad /', 99: 'PrtSc', 100: 'Right Alt', 102: 'Home', 103: 'Up', 104: 'Page Up', 105: 'Left', 106: 'Right', 107: 'End', 108: 'Down', 109: 'Page Down', 110: 'Insert', 111: 'Delete', 113: 'Mute', 114: 'Volume Down', 115: 'Volume Up', 119: 'Pause', 125: 'Left Super', 126: 'Right Super', 127: 'Menu' }
  '1234567890'.split('').forEach((c, i) => (m[2 + i] = c))
  'QWERTYUIOP'.split('').forEach((c, i) => (m[16 + i] = c))
  'ASDFGHJKL'.split('').forEach((c, i) => (m[30 + i] = c))
  'ZXCVBNM'.split('').forEach((c, i) => (m[44 + i] = c))
  for (let i = 0; i < 10; i++) m[59 + i] = `F${i + 1}`
  ;['Keypad 7', 'Keypad 8', 'Keypad 9', 'Keypad -', 'Keypad 4', 'Keypad 5', 'Keypad 6', 'Keypad +', 'Keypad 1', 'Keypad 2', 'Keypad 3', 'Keypad 0', 'Keypad .'].forEach((k, i) => (m[71 + i] = k))
  return m
})()

export const keyName = (code: number): string => KEY_NAMES[code] ?? `key ${code}`

/** The main typing block of a laptop/desktop keyboard, used to list keys not yet tried. */
export const MAIN_KEYS: number[] = [1, ...Array.from({ length: 13 }, (_, i) => 2 + i), 14, 15, ...Array.from({ length: 13 }, (_, i) => 16 + i), 29, ...Array.from({ length: 12 }, (_, i) => 30 + i), 42, 43, ...Array.from({ length: 11 }, (_, i) => 44 + i), 56, 57, 58, ...Array.from({ length: 10 }, (_, i) => 59 + i), 87, 88, 97, 100, 103, 105, 106, 108, 111, 125]

/** Parses a sysfs capability bitmap ("120013 0 3" = most-significant word first, one long per word). */
export function parseBitmap(text: string | undefined): bigint {
  if (!text) return 0n
  const words = text.trim().split(/\s+/).reverse()
  return words.reduce((acc, w, i) => acc | (BigInt(`0x${w || '0'}`) << BigInt(64 * i)), 0n)
}
export const hasBit = (map: bigint, bit: number): boolean => ((map >> BigInt(bit)) & 1n) === 1n

export interface Capabilities {
  key: bigint
  rel: bigint
  abs: bigint
}

export async function capabilities(reader: SysReader, node: string): Promise<Capabilities> {
  const base = `/sys/class/input/${node}/device/capabilities`
  return { key: parseBitmap(await reader.text(`${base}/key`)), rel: parseBitmap(await reader.text(`${base}/rel`)), abs: parseBitmap(await reader.text(`${base}/abs`)) }
}

export interface InputEvent {
  /** Microseconds, from the kernel's timestamp. */
  t: number
  type: number
  code: number
  value: number
}

/** struct input_event on 64-bit Linux: timeval (2 × 8 bytes), u16 type, u16 code, s32 value = 24 bytes. */
export const EVENT_SIZE = 24
export function parseEvents(buf: Buffer, length = buf.length): InputEvent[] {
  const out: InputEvent[] = []
  for (let o = 0; o + EVENT_SIZE <= length; o += EVENT_SIZE) {
    out.push({ t: Number(buf.readBigInt64LE(o)) * 1e6 + Number(buf.readBigInt64LE(o + 8)), type: buf.readUInt16LE(o + 16), code: buf.readUInt16LE(o + 18), value: buf.readInt32LE(o + 20) })
  }
  return out
}

/** A press that follows the same button's release this quickly is the switch bouncing, not a human. */
export const CHATTER_US = 35_000
/** Gaps longer than this end a "continuous movement" run. */
const RUN_BREAK_US = 250_000
const STUCK_MS = 10_000

interface Btn { name: string; presses: number; chatter: number; downAt: number | null; lastRelease: number | null }

/**
 * Aggregates raw input events into what the test page shows. Keeps only counts and key names;
 * nothing is stored or sent anywhere else.
 */
export class InputAggregator {
  private btns = new Map<number, Btn>()
  private keys = new Map<number, number>()
  private keyDown = new Map<number, number>()
  private st = {
    events: 0, dropped: 0, keyPresses: 0,
    motion: { left: 0, right: 0, up: 0, down: 0, events: 0 },
    wheel: { up: 0, down: 0, left: 0, right: 0 },
    touch: { touches: 0, maxFingers: 0, travel: 0 }
  }
  private lastMotion: number | null = null
  private intervals: number[] = []
  private maxGap = 0
  private lastAbs: { x?: number; y?: number } = {}
  private still: { phase: 'idle' | 'running' | 'done'; until: number; motion: number; events: number } = { phase: 'idle', until: 0, motion: 0, events: 0 }
  private lastT = 0

  constructor(private buttonCodes: number[], private isKeyboard: boolean) {
    for (const c of buttonCodes) this.btns.set(c, { name: BUTTON_NAMES[c] ?? `Button ${c}`, presses: 0, chatter: 0, downAt: null, lastRelease: null })
  }

  /** Starts a "hold still" window, measured in the device's own clock. */
  startStill(durationMs: number, nowUs: number): void {
    this.still = { phase: 'running', until: nowUs + durationMs * 1000, motion: 0, events: 0 }
  }

  /** The device clock's latest timestamp (falls back to the given wall clock). */
  deviceNow(fallbackUs: number): number {
    return this.lastT || fallbackUs
  }

  push(e: InputEvent): void {
    this.st.events++
    this.lastT = Math.max(this.lastT, e.t)
    if (this.still.phase === 'running' && e.t > this.still.until) this.still.phase = 'done'
    if (e.type === EV_SYN && e.code === SYN_DROPPED) { this.st.dropped++; return }
    if (e.type === EV_REL) {
      if (e.code === REL_X || e.code === REL_Y) {
        const m = this.st.motion
        if (e.code === REL_X) e.value < 0 ? (m.left += -e.value) : (m.right += e.value)
        else e.value < 0 ? (m.up += -e.value) : (m.down += e.value)
        m.events++
        this.motionTick(e.t)
        if (this.still.phase === 'running') { this.still.motion += Math.abs(e.value); this.still.events++ }
      } else if (e.code === REL_WHEEL) e.value > 0 ? this.st.wheel.up++ : this.st.wheel.down++
      else if (e.code === REL_HWHEEL) e.value > 0 ? this.st.wheel.right++ : this.st.wheel.left++
      return
    }
    if (e.type === EV_ABS && (e.code === ABS_X || e.code === ABS_Y)) {
      const k = e.code === ABS_X ? 'x' : 'y'
      const prev = this.lastAbs[k]
      if (prev !== undefined) {
        this.st.touch.travel += Math.abs(e.value - prev)
        if (this.still.phase === 'running') { this.still.motion += Math.abs(e.value - prev); this.still.events++ }
      }
      this.lastAbs[k] = e.value
      this.motionTick(e.t)
      return
    }
    if (e.type !== EV_KEY) return
    if (e.code === BTN_TOUCH) {
      if (e.value === 1) this.st.touch.touches++
      else this.lastAbs = {}
      return
    }
    const fingers = FINGERS[e.code]
    if (fingers !== undefined) { if (e.value === 1) this.st.touch.maxFingers = Math.max(this.st.touch.maxFingers, fingers); return }
    const b = this.btns.get(e.code)
    if (b) {
      if (e.value === 1) {
        b.presses++
        if (b.lastRelease !== null && e.t - b.lastRelease < CHATTER_US) b.chatter++
        b.downAt = e.t
      } else if (e.value === 0) {
        b.lastRelease = e.t
        b.downAt = null
      }
      return
    }
    if (this.isKeyboard && e.value === 1) {
      this.st.keyPresses++
      this.keys.delete(e.code)
      this.keys.set(e.code, e.t)
      this.keyDown.set(e.code, e.t)
    } else if (this.isKeyboard && e.value === 0) this.keyDown.delete(e.code)
  }

  private motionTick(t: number): void {
    if (this.lastMotion !== null) {
      const d = t - this.lastMotion
      if (d > 0 && d < RUN_BREAK_US) {
        if (this.intervals.length < 4000) this.intervals.push(d)
        this.maxGap = Math.max(this.maxGap, d)
      }
    }
    this.lastMotion = t
  }

  state(nowUs: number): Omit<LiveState, 'sessionId' | 'running' | 'stoppedReason' | 'elapsedMs' | 'limitMs' | 'errors' | 'untried'> {
    if (this.still.phase === 'running' && nowUs > this.still.until) this.still.phase = 'done'
    const buttons: ButtonStats[] = [...this.btns.values()].map((b) => ({ name: b.name, presses: b.presses, chatter: b.chatter, down: b.downAt !== null, heldMs: b.downAt !== null ? Math.max(0, Math.round((nowUs - b.downAt) / 1000)) : 0 }))
    const sorted = [...this.intervals].sort((a, b) => a - b)
    const median = sorted.length >= 20 ? sorted[Math.floor(sorted.length / 2)]! : null
    const stuck = [
      ...buttons.filter((b) => b.down && b.heldMs > STUCK_MS).map((b) => b.name),
      ...[...this.keyDown].filter(([, t]) => (nowUs - t) / 1000 > STUCK_MS).map(([c]) => keyName(c))
    ]
    return {
      events: this.st.events, dropped: this.st.dropped,
      motion: { ...this.st.motion }, wheel: { ...this.st.wheel }, touch: { ...this.st.touch },
      buttons, keys: [...this.keys.keys()].map(keyName), keyPresses: this.st.keyPresses, stuck,
      reportRateHz: median ? Math.round(1e6 / median) : null,
      maxMotionGapMs: this.intervals.length >= 20 ? Math.round(this.maxGap / 1000) : null,
      still: { phase: this.still.phase, motion: this.still.motion, events: this.still.events }
    }
  }

  pressedKeyCodes(): number[] {
    return [...this.keys.keys()]
  }
}

/**
 * Reads input event nodes without blocking the libuv thread pool: the nodes are opened
 * non-blocking and drained on a short timer, so a quiet device never ties up a worker thread.
 * Reading does not grab the device: it keeps working normally during the test.
 */
export class EvdevReader {
  private fds: { node: string; fh: fs.FileHandle }[] = []
  private timer: NodeJS.Timeout | null = null
  private buf = Buffer.alloc(EVENT_SIZE * 256)
  private draining = false

  constructor(private onEvents: (events: InputEvent[]) => void, private onError: (node: string, message: string) => void) {}

  async open(nodes: readonly string[], devRoot = '/dev/input'): Promise<void> {
    for (const node of nodes) {
      if (!/^event\d+$/.test(node)) throw new Error(`Not an input event node: ${node}`)
      this.fds.push({ node, fh: await fs.open(`${devRoot}/${node}`, constants.O_RDONLY | constants.O_NONBLOCK) })
    }
    this.timer = setInterval(() => void this.drain(), 15)
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (const f of [...this.fds]) {
        for (let i = 0; i < 16; i++) {
          let n: number
          try {
            n = (await f.fh.read(this.buf, 0, this.buf.length, null)).bytesRead
          } catch (e) {
            const code = (e as NodeJS.ErrnoException).code
            if (code === 'EAGAIN' || code === 'EWOULDBLOCK') break
            this.onError(f.node, code === 'ENODEV' ? 'The device was unplugged' : (e as Error).message)
            this.fds = this.fds.filter((x) => x !== f)
            void f.fh.close().catch(() => undefined)
            break
          }
          if (n <= 0) break
          this.onEvents(parseEvents(this.buf, n))
          if (n < this.buf.length) break
        }
      }
    } finally {
      this.draining = false
    }
  }

  get openCount(): number {
    return this.fds.length
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const fds = this.fds
    this.fds = []
    await Promise.all(fds.map((f) => f.fh.close().catch(() => undefined)))
  }
}
