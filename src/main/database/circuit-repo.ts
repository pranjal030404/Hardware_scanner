import type { CircuitSummary, Design, SavedCircuit } from '../../circuit/types'
import type { Db } from './db'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
export const MAX_CIRCUITS = 100

const summary = (r: Row): CircuitSummary => ({ id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at, parts: r.parts, wires: r.wires })

/** Saved virtual-circuit designs. The design JSON is validated at the IPC boundary before it gets here. */
export class CircuitRepo {
  constructor(private db: Db) {}

  list(): CircuitSummary[] {
    return (this.db.prepare('SELECT id, name, created_at, updated_at, parts, wires FROM circuit_designs ORDER BY updated_at DESC, id DESC').all() as Row[]).map(summary)
  }

  /** Insert (no id) or overwrite (id). Throws when the design limit is reached or the id is unknown. */
  save(id: number | undefined, name: string, design: Design, at: string): CircuitSummary {
    const json = JSON.stringify(design)
    if (id === undefined) {
      const count = (this.db.prepare('SELECT COUNT(*) AS n FROM circuit_designs').get() as Row).n as number
      if (count >= MAX_CIRCUITS) throw new Error(`At most ${MAX_CIRCUITS} circuits can be saved. Delete one first.`)
      const res = this.db.prepare('INSERT INTO circuit_designs (name, created_at, updated_at, parts, wires, design) VALUES (?,?,?,?,?,?)').run(name, at, at, design.parts.length, design.wires.length, json)
      return this.summaryOf(Number(res.lastInsertRowid))!
    }
    const res = this.db.prepare('UPDATE circuit_designs SET name = ?, updated_at = ?, parts = ?, wires = ?, design = ? WHERE id = ?').run(name, at, design.parts.length, design.wires.length, json, id)
    if (Number(res.changes) === 0) throw new Error('That circuit no longer exists.')
    return this.summaryOf(id)!
  }

  private summaryOf(id: number): CircuitSummary | null {
    const r = this.db.prepare('SELECT id, name, created_at, updated_at, parts, wires FROM circuit_designs WHERE id = ?').get(id) as Row | undefined
    return r ? summary(r) : null
  }

  load(id: number): SavedCircuit | null {
    const r = this.db.prepare('SELECT * FROM circuit_designs WHERE id = ?').get(id) as Row | undefined
    return r ? { ...summary(r), design: JSON.parse(r.design) as Design } : null
  }

  remove(id: number): void {
    this.db.prepare('DELETE FROM circuit_designs WHERE id = ?').run(id)
  }
}
