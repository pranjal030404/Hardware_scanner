import { BOARD_TYPES, type Board, type BoardType } from './types'

export { BOARD_TYPES }

/**
 * Board geometries. One grid unit is one 0.1" (2.54 mm) hole, drawn at the same 20 px pitch the
 * generic part symbols use, so a board can be sized in real hole counts.
 *
 * A board is a carrier: it gives the canvas a shape, a hole grid, rails and mounting holes. It adds
 * no pins and no connections — the wires are still the electrical model, so the same design can be
 * moved between a breadboard, a perfboard and a PCB without changing its behaviour.
 */
export const HOLE = 20

export interface BoardSpec {
  name: string
  short: string
  description: string
  cols: number
  rows: number
  margin: number
  holes: 'none' | 'grid' | 'strip' | 'breadboard' | 'footprint'
  accent: string
  /** Dark silkscreen board: labels and holes switch to light ink. */
  dark?: boolean
  /** Breadboard rails are split into two groups of 25 columns, like the real thing. */
  rails?: boolean
}

/** A dev-board outline. Like `uno`, it is a footprint with mounting holes, not a simulated MCU. */
const fp = (name: string, short: string, what: string, cols: number, rows: number, accent: string): BoardSpec => ({
  name, short, description: `Outline and mounting holes of ${what}. It is a footprint, not a simulated MCU.`,
  cols, rows, margin: 40, holes: 'footprint', accent, dark: true
})

export const BOARDS: Record<BoardType, BoardSpec> = {
  pcb: {
    name: 'PCB (blank)', short: 'PCB', description: 'A bare board outline with mounting holes. Place the circuit however you like.',
    cols: 60, rows: 40, margin: 40, holes: 'none', accent: '#14532d', dark: true
  },
  breadboard: {
    name: 'Breadboard (830 point)', short: 'Breadboard', description: 'Full-size breadboard: 63 columns, ten tie rows, centre channel and four power rails.',
    cols: 63, rows: 20, margin: 60, holes: 'breadboard', accent: '#e7e2d6', rails: true
  },
  'breadboard-half': {
    name: 'Breadboard (half size)', short: 'Half breadboard', description: 'Half-size breadboard: 30 columns, ten tie rows, centre channel and four power rails.',
    cols: 30, rows: 20, margin: 60, holes: 'breadboard', accent: '#e7e2d6', rails: true
  },
  perfboard: {
    name: 'Perfboard', short: 'Perfboard', description: 'Through-hole prototyping board: an unconnected 2.54 mm hole grid.',
    cols: 40, rows: 30, margin: 40, holes: 'grid', accent: '#d9cdb2'
  },
  stripboard: {
    name: 'Stripboard', short: 'Stripboard', description: 'Veroboard-style prototyping board: parallel copper strips, two rows tall.',
    cols: 40, rows: 25, margin: 40, holes: 'strip', accent: '#d3c49a'
  },
  'pcb-single': {
    name: 'PCB (single-sided)', short: 'Single-sided PCB', description: 'Single-layer phenolic board with copper on one side only: through-hole parts, all tracks on the solder side.',
    cols: 60, rows: 40, margin: 40, holes: 'none', accent: '#7a4a1e', dark: true
  },
  'pcb-double': {
    name: 'PCB (double-sided / 2-layer)', short: '2-layer PCB', description: 'Two copper layers with plated through-holes and vias. The usual layout for SMD and mixed designs.',
    cols: 70, rows: 45, margin: 40, holes: 'none', accent: '#1b5e20', dark: true
  },
  eurocard: {
    name: 'Eurocard PCB (100 × 160 mm)', short: 'Eurocard', description: 'Standard 100 × 160 mm rack-card format, for backplane and rack-mount modules.',
    cols: 63, rows: 39, margin: 40, holes: 'none', accent: '#1b4d3e', dark: true
  },
  'breadboard-mini': {
    name: 'Breadboard (mini, 170 point)', short: 'Mini breadboard', description: 'Small solderless breadboard: 17 columns, ten tie rows, centre channel and no power rails.',
    cols: 17, rows: 20, margin: 60, holes: 'breadboard', accent: '#e7e2d6'
  },
  'proto-shield': {
    name: 'Arduino proto shield', short: 'Proto shield', description: 'Uno-sized shield with a 2.54 mm hole grid for soldering your own circuit on top of an Arduino.',
    cols: 27, rows: 21, margin: 40, holes: 'grid', accent: '#0f4c5c', dark: true
  },
  mega: fp('Arduino Mega 2560 footprint', 'Mega outline', 'a 102 × 53 mm Mega-shaped board', 40, 21, '#0f4c5c'),
  promini: fp('Arduino Pro Mini footprint', 'Pro Mini outline', 'a 33 × 18 mm Pro Mini-shaped board', 13, 7, '#8a1c1c'),
  esp32s3: fp('ESP32-S3 DevKit footprint', 'ESP32-S3 outline', 'a 70 × 25 mm ESP32-S3 DevKit carrier', 28, 10, '#2f3b52'),
  esp32c3: fp('ESP32-C3 SuperMini footprint', 'ESP32-C3 outline', 'a 23 × 18 mm ESP32-C3 SuperMini carrier', 9, 7, '#2f3b52'),
  nodemcu: fp('NodeMCU ESP8266 footprint', 'NodeMCU outline', 'a 49 × 26 mm NodeMCU / ESP8266 carrier', 19, 10, '#2f3b52'),
  wemos: fp('Wemos D1 mini footprint', 'D1 mini outline', 'a 34 × 26 mm Wemos D1 mini carrier', 13, 10, '#2f3b52'),
  bluepill: fp('STM32 Blue Pill footprint', 'Blue Pill outline', 'a 53 × 23 mm STM32F103 Blue Pill board', 21, 9, '#1c3d8a'),
  teensy: fp('Teensy 4.x footprint', 'Teensy outline', 'a 36 × 18 mm Teensy-shaped board', 14, 7, '#222'),
  feather: fp('Adafruit Feather footprint', 'Feather outline', 'a 51 × 23 mm Feather-shaped board', 20, 9, '#5b1a4a'),
  microbit: fp('BBC micro:bit footprint', 'micro:bit outline', 'a 52 × 42 mm micro:bit-shaped board', 20, 17, '#1d5f8c'),
  pizero: fp('Raspberry Pi Zero footprint', 'Pi Zero outline', 'a 65 × 30 mm Pi Zero-shaped board', 26, 12, '#14532d'),
  pihat: fp('Raspberry Pi HAT footprint', 'Pi HAT outline', 'a 65 × 56 mm Raspberry Pi HAT', 26, 22, '#14532d'),
  uno: {
    name: 'Arduino Uno footprint', short: 'Uno outline', description: 'Outline and mounting holes of a 68 × 53 mm Uno-shaped board. It is a footprint, not a simulated MCU.',
    cols: 27, rows: 21, margin: 40, holes: 'footprint', accent: '#0f4c5c', dark: true
  },
  nano: {
    name: 'Arduino Nano footprint', short: 'Nano outline', description: 'Outline and mounting holes of a 45 × 18 mm Nano-shaped board. It is a footprint, not a simulated MCU.',
    cols: 18, rows: 7, margin: 40, holes: 'footprint', accent: '#0f4c5c', dark: true
  },
  esp32dev: {
    name: 'ESP32 DevKit footprint', short: 'ESP32 outline', description: 'Outline and mounting holes of a 55 × 28 mm ESP32 DevKit carrier. The simulated MCU is still the ESP32 part.',
    cols: 22, rows: 11, margin: 40, holes: 'footprint', accent: '#2f3b52', dark: true
  },
  pico: {
    name: 'Raspberry Pi Pico footprint', short: 'Pico outline', description: 'Outline and mounting holes of a 51 × 21 mm Pico-shaped board. It is a footprint, not a simulated MCU.',
    cols: 20, rows: 8, margin: 40, holes: 'footprint', accent: '#5b1a4a', dark: true
  },
  custom: {
    name: 'Custom board', short: 'Custom', description: 'A board of your own size, in 2.54 mm holes.',
    cols: 50, rows: 35, margin: 40, holes: 'grid', accent: '#14532d', dark: true
  }
}

export const DEFAULT_BOARD: Board = { type: 'pcb' }
export const MIN_BOARD_HOLES = 8
export const MAX_BOARD_HOLES = 120

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

export interface SizedBoard { type: BoardType; cols: number; rows: number; margin: number; spec: BoardSpec }
export interface BoardRect { x: number; y: number; w: number; h: number; margin: number; cols: number; rows: number }

/** Resolve a stored board (which may be absent, unknown or a custom size) into concrete dimensions. */
export function resolveBoard(board?: Board): SizedBoard {
  const type: BoardType = board && BOARD_TYPES_SET.has(board.type) ? board.type : DEFAULT_BOARD.type
  const base = BOARDS[type]
  const custom = type === 'custom'
  return {
    type,
    cols: custom ? clamp(Math.round(board?.cols ?? base.cols), MIN_BOARD_HOLES, MAX_BOARD_HOLES) : base.cols,
    rows: custom ? clamp(Math.round(board?.rows ?? base.rows), MIN_BOARD_HOLES, MAX_BOARD_HOLES) : base.rows,
    margin: base.margin,
    spec: base
  }
}

export function boardRect(board?: Board): BoardRect {
  const b = resolveBoard(board)
  return { x: 0, y: 0, w: b.margin * 2 + b.cols * HOLE, h: b.margin * 2 + b.rows * HOLE, margin: b.margin, cols: b.cols, rows: b.rows }
}

/** Boards with real holes snap placements to the 2.54 mm grid; outlines keep the finer 1 mm grid. */
export function boardPitch(board?: Board): number {
  const holes = resolveBoard(board).spec.holes
  return holes === 'grid' || holes === 'strip' || holes === 'breadboard' ? HOLE : 0
}

export const boardIsBreadboard = (board?: Board): boolean => resolveBoard(board).spec.holes === 'breadboard'

/** Overall size in millimetres, for the board panel. */
export const boardMm = (board?: Board): { w: number; h: number } => {
  const b = resolveBoard(board)
  return { w: Math.round(b.cols * 2.54), h: Math.round(b.rows * 2.54) }
}

/** Corner mounting holes (centres) in board coordinates. */
export function mountingHoles(board?: Board): { x: number; y: number }[] {
  const r = boardRect(board), inset = Math.max(18, Math.min(34, r.margin - 6))
  return [{ x: inset, y: inset }, { x: r.w - inset, y: inset }, { x: inset, y: r.h - inset }, { x: r.w - inset, y: r.h - inset }]
}

/** Breadboard bands, in hole rows from the top of the board. */
export const BREADBOARD_ROWS = {
  railTop: [0, 1],
  tieTop: [4, 8],
  channel: [9, 10],
  tieBottom: [11, 15],
  railBottom: [18, 19]
} as const

/** Y coordinate of a breadboard hole row. */
export const breadboardRowY = (rect: BoardRect, row: number): number => rect.y + rect.margin + HOLE / 2 + row * HOLE

/** Drawing rect for an inclusive band of breadboard rows. */
export const breadboardBand = (rect: BoardRect, band: readonly [number, number]): { y: number; h: number } => ({
  y: rect.y + rect.margin + band[0] * HOLE,
  h: (band[1] - band[0] + 1) * HOLE
})

const BOARD_TYPES_SET = new Set<string>(BOARD_TYPES)
