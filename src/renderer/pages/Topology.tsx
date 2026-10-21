import { Background, Controls, MarkerType, MiniMap, ReactFlow, type Edge, type Node } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ChevronDown, ChevronRight, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Category, DeviceSummary } from '@shared/schemas'
import { layoutTopology } from '../../topology/layout'
import type { Navigate } from '../App'
import { Badge, CATEGORY_META, CategoryIcon, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { useLoad } from '../hooks/useLoad'
import { api } from '../services/api'

const CAT_COLOR: Partial<Record<Category, string>> = {
  pci: '#6366f1', usb: '#0ea5e9', hid: '#14b8a6', storage: '#f59e0b', network: '#22c55e', bluetooth: '#3b82f6', display: '#ec4899', audio: '#a855f7',
  camera: '#f43f5e', sensor: '#84cc16', power: '#eab308', serial: '#64748b'
}

export function TopologyPage({ navigate, focus }: { navigate: Navigate; focus?: string }): JSX.Element {
  const q = useLoad(() => api.topology(), [])
  const [confirmedOnly, setConfirmedOnly] = useState(false)
  const [hiddenCats, setHiddenCats] = useState<Set<Category>>(new Set())
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | undefined>(focus)

  useEffect(() => { if (focus) setSelected(focus) }, [focus])

  // First load: collapse deeper branches so the initial view is readable; the user can expand all.
  const initialised = useRef(false)
  useEffect(() => {
    if (!q.data || initialised.current) return
    initialised.current = true
    const l = layoutTopology(q.data.nodes, q.data.edges, {})
    setCollapsed(new Set(l.nodes.filter((n) => n.depth >= 2 && n.childCount > 0).map((n) => n.device.id)))
  }, [q.data])

  const cats = useMemo(() => [...new Set((q.data?.nodes ?? []).map((n) => n.category))].sort(), [q.data])
  const layout = useMemo(() => {
    if (!q.data) return undefined
    return layoutTopology(q.data.nodes, q.data.edges, { confirmedOnly, categories: new Set(cats.filter((c) => !hiddenCats.has(c))), collapsed, colWidth: 290, rowHeight: 46 })
  }, [q.data, confirmedOnly, hiddenCats, collapsed, cats])

  const needle = search.trim().toLowerCase()
  const matches = (d: DeviceSummary): boolean => !needle || [d.name, d.manufacturer, d.model, d.vendorId, d.productId, d.driver].some((x) => x?.toLowerCase().includes(needle))

  const { nodes, edges } = useMemo(() => {
    if (!layout) return { nodes: [] as Node[], edges: [] as Edge[] }
    const ns: Node[] = layout.nodes.map((p) => {
      const color = CAT_COLOR[p.device.category] ?? '#94a3b8'
      const dim = needle && !matches(p.device)
      return {
        id: p.device.id,
        position: { x: p.x, y: p.y },
        data: { label: (
          <div className="tnode">
            {p.childCount > 0 && <span className="tnode-toggle" aria-hidden>{p.hiddenDescendants ? <ChevronRight size={12} /> : <ChevronDown size={12} />}</span>}
            <span className="tnode-name">{p.device.name}</span>
            {p.hiddenDescendants > 0 && <span className="tnode-badge">+{p.hiddenDescendants}</span>}
          </div>
        ) },
        draggable: false,
        selected: p.device.id === selected,
        style: { borderLeft: `4px solid ${color}`, opacity: dim ? 0.25 : 1, outline: needle && !dim ? '2px solid var(--accent)' : undefined, width: 250 }
      }
    })
    const es: Edge[] = layout.edges.map((e) => ({
      id: `${e.fromId}>${e.toId}>${e.type}>${e.source}`,
      source: e.toId,
      target: e.fromId,
      // Labels only on the selected node's edges: labelling every edge buries the graph.
      label: selected && (e.fromId === selected || e.toId === selected) ? e.type.replace(/_/g, ' ') + (e.directness === 'inferred' ? ' (inferred)' : '') : undefined,
      style: { strokeDasharray: e.directness === 'inferred' ? '6 4' : undefined, strokeWidth: 1.5 },
      labelStyle: { fontSize: 10 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12 },
      markerStart: undefined
    }))
    return { nodes: ns, edges: es }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, selected, needle])

  const sel = q.data?.nodes.find((n) => n.id === selected)
  const selEdges = q.data?.edges.filter((e) => e.fromId === selected || e.toId === selected) ?? []
  const selPlaced = layout?.nodes.find((n) => n.device.id === selected)

  if (q.error) return <><PageHeader title="Topology" /><ErrorBox message={q.error} onRetry={q.reload} /></>
  if (!q.data || !layout) return <><PageHeader title="Topology" /><Spinner /></>

  return (
    <>
      <PageHeader title="Topology" subtitle="Device relationships as enumerated by the operating system. Dashed lines are inferred and not verified wiring." />
      <div className="toolbar">
        <label className="search"><Search size={14} aria-hidden /><input type="search" placeholder="Highlight devices…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Highlight devices" /></label>
        <label className="check"><input type="checkbox" checked={confirmedOnly} onChange={(e) => setConfirmedOnly(e.target.checked)} /> Confirmed relationships only</label>
        <button className="btn btn-sm" onClick={() => setCollapsed(new Set())}>Expand all</button>
        <button className="btn btn-sm" onClick={() => setCollapsed(new Set(layout.nodes.filter((n) => n.childCount > 0 && n.depth >= 2).map((n) => n.device.id)))}>Collapse deep branches</button>
      </div>
      <div className="chips" role="group" aria-label="Subsystems">
        {cats.map((c) => (
          <button key={c} className={`chip ${hiddenCats.has(c) ? '' : 'active'}`} aria-pressed={!hiddenCats.has(c)} onClick={() => setHiddenCats((s) => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n })}>
            <CategoryIcon category={c} size={13} /> {CATEGORY_META[c].label}
          </button>
        ))}
      </div>
      {layout.nodes.length === 0 ? <Empty title="No relationships to draw">Either nothing is inventoried yet or the current filters hide every connected device.</Empty> : (
        <div className="topology">
          <div className="flow" aria-label="Hardware topology graph">
            <ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{ minZoom: 0.55, maxZoom: 1, padding: 0.1 }} minZoom={0.1} nodesConnectable={false} colorMode="system"
              onNodeClick={(_, n) => setSelected(n.id)}
              onNodeDoubleClick={(_, n) => setCollapsed((s) => { const c = new Set(s); if (c.has(n.id)) c.delete(n.id); else c.add(n.id); return c })}
              proOptions={{ hideAttribution: true }}>
              <Background /><Controls showInteractive={false} /><MiniMap pannable zoomable />
            </ReactFlow>
          </div>
          <aside className="side card" aria-label="Selected device">
            {sel ? (
              <>
                <h2>{sel.name}</h2>
                <p><Badge tone="neutral">{CATEGORY_META[sel.category].label}</Badge> {sel.busType && <Badge tone="muted">{sel.busType}</Badge>}</p>
                {selPlaced && selPlaced.childCount > 0 && <button className="btn btn-sm" onClick={() => setCollapsed((s) => { const c = new Set(s); if (c.has(sel.id)) c.delete(sel.id); else c.add(sel.id); return c })}>{collapsed.has(sel.id) ? 'Expand' : 'Collapse'} {selPlaced.childCount} child{selPlaced.childCount === 1 ? '' : 'ren'}</button>}
                <h3>Relationships ({selEdges.length})</h3>
                <ul className="plain">
                  {selEdges.map((e, i) => {
                    const otherId = e.fromId === selected ? e.toId : e.fromId
                    const other = q.data!.nodes.find((n) => n.id === otherId)
                    return (<li key={i}><span>{e.fromId === selected ? 'attached to' : 'hosts'} <button className="link" onClick={() => setSelected(otherId)}>{other?.name ?? otherId}</button></span><Badge tone={e.directness === 'reported' ? 'ok' : 'warn'} title={`${e.type.replace(/_/g, ' ')} · source ${e.source}`}>{e.directness === 'reported' ? 'reported' : `inferred ${Math.round(e.confidence * 100)}%`}</Badge></li>)
                  })}
                </ul>
                <button className="btn" onClick={() => navigate({ page: 'device', id: sel.id, from: { page: 'topology', focus: sel.id } })}>Open full details</button>
              </>
            ) : <p className="muted">Click a device to see how it is connected. Double-click to collapse or expand its branch.</p>}
            <h3>Not connected ({layout.unconnected.length})</h3>
            <p className="muted small">No relationship was reported for these, so none is drawn.</p>
            <ul className="plain compact-list">{layout.unconnected.slice(0, 40).map((d) => (<li key={d.id}><button className="link" onClick={() => navigate({ page: 'device', id: d.id, from: { page: 'topology' } })}><CategoryIcon category={d.category} size={13} /> {d.name}</button></li>))}</ul>
          </aside>
        </div>
      )}
    </>
  )
}
