import type { DeviceSummary } from '@shared/schemas'
import type { TopologyEdge } from '@shared/api'

export interface LayoutOptions {
  /** Hide inferred relationships (only kernel/OS-reported ones remain). */
  confirmedOnly?: boolean
  categories?: Set<string>
  collapsed?: Set<string>
  colWidth?: number
  rowHeight?: number
}

export interface PlacedNode {
  device: DeviceSummary
  x: number
  y: number
  depth: number
  childCount: number
  hiddenDescendants: number
}

export interface TopologyLayout {
  nodes: PlacedNode[]
  edges: TopologyEdge[]
  /** Devices with no relationships in the current view; shown separately instead of invented links. */
  unconnected: DeviceSummary[]
}

/**
 * Deterministic tree layout from real relationship records. Edges run child → parent; a node with
 * several parents is placed under the first (by stable ordering) and keeps its other edges drawn.
 * Nothing here creates relationships: it only arranges what the collectors reported/inferred.
 */
export function layoutTopology(nodes: DeviceSummary[], edgesIn: TopologyEdge[], o: LayoutOptions = {}): TopologyLayout {
  const colWidth = o.colWidth ?? 280
  const rowHeight = o.rowHeight ?? 64
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const visible = (id: string): boolean => {
    const n = byId.get(id)
    return !!n && (!o.categories || o.categories.has(n.category))
  }
  const edges = edgesIn.filter((e) => (!o.confirmedOnly || e.directness === 'reported') && visible(e.fromId) && visible(e.toId) && e.fromId !== e.toId)
  const connected = new Set<string>()
  edges.forEach((e) => (connected.add(e.fromId), connected.add(e.toId)))

  const parentOf = new Map<string, string>()
  const children = new Map<string, string[]>()
  for (const e of [...edges].sort((a, b) => a.toId.localeCompare(b.toId))) {
    // Prefer reported edges for tree placement.
    const prev = parentOf.get(e.fromId)
    if (prev === undefined || (e.directness === 'reported' && edges.find((x) => x.fromId === e.fromId && x.toId === prev)?.directness === 'inferred')) {
      parentOf.set(e.fromId, e.toId)
    }
  }
  // Break accidental cycles defensively.
  for (const id of [...parentOf.keys()]) {
    const seen = new Set([id])
    let cur = parentOf.get(id)
    while (cur !== undefined) {
      if (seen.has(cur)) {
        parentOf.delete(id)
        break
      }
      seen.add(cur)
      cur = parentOf.get(cur)
    }
  }
  for (const [c, p] of parentOf) children.set(p, [...(children.get(p) ?? []), c])
  const cmp = (a: string, b: string): number => {
    const na = byId.get(a)!
    const nb = byId.get(b)!
    return na.category.localeCompare(nb.category) || na.name.localeCompare(nb.name)
  }
  for (const list of children.values()) list.sort(cmp)
  const roots = [...connected].filter((id) => !parentOf.has(id)).sort(cmp)

  const placed: PlacedNode[] = []
  let row = 0
  const countDesc = (id: string): number => (children.get(id) ?? []).reduce((n, c) => n + 1 + countDesc(c), 0)
  // Tidy tree: leaves take consecutive rows, a parent is centred on its first and last child.
  const place = (id: string, depth: number): number => {
    const kids = children.get(id) ?? []
    const collapsed = !!o.collapsed?.has(id) && kids.length > 0
    const slot = placed.length
    placed.push({ device: byId.get(id)!, x: depth * colWidth, y: 0, depth, childCount: kids.length, hiddenDescendants: collapsed ? countDesc(id) : 0 })
    let y: number
    if (collapsed || kids.length === 0) {
      y = row++ * rowHeight
    } else {
      const ys = kids.map((k) => place(k, depth + 1))
      y = (ys[0]! + ys[ys.length - 1]!) / 2
    }
    placed[slot]!.y = y
    return y
  }
  roots.forEach((r) => place(r, 0))
  const shown = new Set(placed.map((p) => p.device.id))
  return {
    nodes: placed,
    edges: edges.filter((e) => shown.has(e.fromId) && shown.has(e.toId)),
    unconnected: nodes.filter((n) => !connected.has(n.id) && visible(n.id)).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
  }
}
