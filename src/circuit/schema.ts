import { z } from 'zod'
import { MAX_CUSTOMS, MAX_CUSTOM_PINS } from './custom'
import { MAX_BOARD_HOLES, MIN_BOARD_HOLES } from './board'
import { ESP_GPIOS } from './parts'
import { BOARD_TYPES, PART_KINDS } from './types'

const id = z.string().regex(/^[a-z0-9_-]{1,24}$/)
const pin = z.object({ part: id, pin: z.string().regex(/^[A-Za-z0-9_]{1,12}$/) }).strict()
const coord = z.number().finite().min(-5000).max(5000)

const customPin = z.object({ id: z.string().regex(/^[A-Za-z0-9_]{1,12}$/), label: z.string().min(1).max(12), type: z.enum(['power', 'gnd', 'signal', 'passive']), side: z.enum(['L', 'R']) }).strict()
const custom = z.object({
  id: z.string().regex(/^c\d{1,2}$/), name: z.string().trim().min(1).max(30), accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  pins: z.array(customPin).min(1).max(MAX_CUSTOM_PINS),
  supply: z.object({ vmin: z.number().min(0).max(60), vmax: z.number().min(0).max(60), mA: z.number().min(0).max(5000) }).strict().optional()
}).strict()

/** Persisted/imported design. Bounded so a pasted or stored design cannot be used to exhaust memory. */
export const DesignSchema = z.object({
  parts: z.array(z.object({
    id, kind: z.enum(PART_KINDS), x: coord, y: coord, def: z.string().regex(/^c\d{1,2}$/).optional(),
    props: z.record(z.string().max(16), z.union([z.number().finite(), z.boolean()])).refine((o) => Object.keys(o).length <= 8)
  }).strict()).max(60),
  wires: z.array(z.object({ id, a: pin, b: pin }).strict()).max(300),
  firmware: z.record(z.string().max(32), z.number().int().refine((n) => (ESP_GPIOS as readonly number[]).includes(n))).refine((o) => Object.keys(o).length <= 40),
  customs: z.array(custom).max(MAX_CUSTOMS).optional(),
  board: z.object({
    type: z.enum(BOARD_TYPES),
    cols: z.number().int().min(MIN_BOARD_HOLES).max(MAX_BOARD_HOLES).optional(),
    rows: z.number().int().min(MIN_BOARD_HOLES).max(MAX_BOARD_HOLES).optional()
  }).strict().optional()
}).strict().superRefine((d, ctx) => {
  const ids = new Set((d.customs ?? []).map((c) => c.id))
  if (ids.size !== (d.customs ?? []).length) ctx.addIssue({ code: 'custom', message: 'duplicate custom part id' })
  for (const p of d.parts) if (p.kind === 'custom' && (!p.def || !ids.has(p.def))) ctx.addIssue({ code: 'custom', message: `part ${p.id} uses an undefined custom part` })
  if (new Set(d.parts.map((p) => p.id)).size !== d.parts.length) ctx.addIssue({ code: 'custom', message: 'duplicate part id' })
  if (new Set(d.wires.map((w) => w.id)).size !== d.wires.length) ctx.addIssue({ code: 'custom', message: 'duplicate wire id' })
  if (d.board?.type === 'custom' && (d.board.cols === undefined || d.board.rows === undefined)) ctx.addIssue({ code: 'custom', message: 'a custom board needs a width and a height' })
})
