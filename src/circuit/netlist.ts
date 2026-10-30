import { defOf, findPin, type PinDef } from './parts'
import type { Design, PinRef, Rail } from './types'
import { pinKey } from './types'

export interface Netlist {
  /** pin key -> net index */
  netOf: Map<string, number>
  nets: PinRef[][]
  /** Wires whose endpoints do not exist on a real part pin are ignored and counted here. */
  badWires: string[]
}

export function buildNetlist(design: Design): Netlist {
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    let r = k
    while (parent.get(r) !== r) r = parent.get(r)!
    let c = k
    while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n }
    return r
  }
  const union = (a: string, b: string): void => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb) }
  const refs = new Map<string, PinRef>()
  for (const p of design.parts) {
    const def = defOf(design, p)
    for (const pin of [...def.left, ...def.right]) { const r = { part: p.id, pin: pin.id }; refs.set(pinKey(r), r); parent.set(pinKey(r), pinKey(r)) }
    for (const tie of def.ties) for (let i = 1; i < tie.length; i++) union(`${p.id}.${tie[0]}`, `${p.id}.${tie[i]}`)
  }
  const badWires: string[] = []
  for (const w of design.wires) {
    const ka = pinKey(w.a), kb = pinKey(w.b)
    if (!parent.has(ka) || !parent.has(kb)) { badWires.push(w.id); continue }
    union(ka, kb)
  }
  const index = new Map<string, number>()
  const nets: PinRef[][] = []
  const netOf = new Map<string, number>()
  for (const [k, r] of refs) {
    const root = find(k)
    let i = index.get(root)
    if (i === undefined) { i = nets.length; index.set(root, i); nets.push([]) }
    nets[i]!.push(r)
    netOf.set(k, i)
  }
  return { netOf, nets, badWires }
}

export function pinDefOf(design: Design, r: PinRef): PinDef | undefined {
  const part = design.parts.find((p) => p.id === r.part)
  return part ? findPin(defOf(design, part), r.pin) : undefined
}

export const net = (nl: Netlist, part: string, pin: string): number => nl.netOf.get(`${part}.${pin}`) ?? -1
/** A pin counts as connected when its net reaches a pin of a different part. */
export const isConnected = (nl: Netlist, part: string, pin: string): boolean => (nl.nets[net(nl, part, pin)] ?? []).some((r) => r.part !== part)

/** Rails sourced onto a net (including GND). More than one means a short. */
export function netRails(design: Design, nl: Netlist, netIndex: number): Rail[] {
  const rails = new Set<Rail>()
  for (const r of nl.nets[netIndex] ?? []) { const d = pinDefOf(design, r); if (d?.rail) rails.add(d.rail) }
  return [...rails]
}
