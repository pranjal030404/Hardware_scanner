import { CircleAlert, CircleCheck, Info, Minus, Plus, RotateCcw, RotateCw, Save, Trash2, TriangleAlert, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { BREADBOARD_ROWS, BOARDS, boardIsBreadboard, boardMm, boardPitch, boardRect, breadboardBand, breadboardRowY, mountingHoles, resolveBoard } from '../../circuit/board'
import { parseCustom } from '../../circuit/custom'
import { evaluate, type Report } from '../../circuit/engine'
import { addPart, addWire, movePart, removePart, removeWire, setFirmwarePin, setProp } from '../../circuit/edit'
import { encoderWorks, initialFw, oledView, sensorReading, step, type FwEvent } from '../../circuit/firmware'
import { ESP_GPIOS, HEADER, PART_DEFS, canAdd, defOf, partHeight, pinPosition, type PartDef } from '../../circuit/parts'
import { DesignSchema } from '../../circuit/schema'
import { ADC_KEY, SIGNALS, defaultFirmware } from '../../circuit/signals'
import type { ElementState } from '../../circuit/sim'
import { EXAMPLES, emptyDesign, playerTemplate } from '../../circuit/template'
import { BOARD_TYPES, BUILTIN_KINDS, type Board as BoardModel, type BoardType, type BuiltinKind, type Design, type PartInst, type PinRef } from '../../circuit/types'
import { Badge, PageHeader } from '../components/ui'
import { useLoad } from '../hooks/useLoad'
import { api } from '../services/api'
import { GROUP_LABEL, LED_COLORS, PROP_FIELDS, RAIL_COLOR, STATE_COLOR, clampPos, fitBox, fmtRuntime, laneOf, partLabel, snapTo, wireColor, wirePoints, type Box } from './circuit-logic'

type Sel = { kind: 'part' | 'wire'; id: string } | null
const cleanError = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const ISSUE_ICON = { error: CircleAlert, warn: TriangleAlert, info: Info } as const
const MAX_BOARDS = 12

/** One PCB project open in a tab. */
interface BoardTab { key: string; name: string; design: Design; currentId: number | undefined; baseline: string }
const snapshot = (name: string, d: Design): string => JSON.stringify([name, d])
let boardCounter = 0
const makeBoard = (name: string, design: Design, currentId?: number): BoardTab => ({ key: `b${++boardCounter}`, name, design, currentId, baseline: snapshot(name, design) })
/** Open tabs survive leaving the page (not the app). */
const session: { boards: BoardTab[]; active: string } = (() => { const b = makeBoard('Handheld player', playerTemplate()); return { boards: [b], active: b.key } })()

export function CircuitPage(): JSX.Element {
  const [boards, setBoards] = useState(session.boards)
  const [active, setActive] = useState(session.active)
  const [confirmClose, setConfirmClose] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const saved = useLoad(() => api.listCircuits(), [])
  useEffect(() => { session.boards = boards; session.active = active }, [boards, active])
  const board = boards.find((b) => b.key === active) ?? boards[0]!

  const patch = (key: string, p: Partial<BoardTab>): void => setBoards((bs) => bs.map((b) => (b.key === key ? { ...b, ...p } : b)))
  const add = (b: BoardTab): void => {
    if (boards.length >= MAX_BOARDS) { setMsg(`At most ${MAX_BOARDS} PCBs can be open. Close one first.`); return }
    setMsg(null); setBoards((bs) => [...bs, b]); setActive(b.key)
  }
  function close(key: string): void {
    const b = boards.find((x) => x.key === key)
    if (b && snapshot(b.name, b.design) !== b.baseline && confirmClose !== key) { setConfirmClose(key); return }
    setConfirmClose(null)
    const rest = boards.filter((x) => x.key !== key)
    if (rest.length === 0) { const n = makeBoard('Untitled PCB', emptyDesign()); setBoards([n]); setActive(n.key); return }
    setBoards(rest)
    if (active === key) setActive(rest[Math.max(0, boards.findIndex((x) => x.key === key) - 1)]!.key)
  }
  async function openSaved(id: number): Promise<void> {
    const open = boards.find((b) => b.currentId === id)
    if (open) { setActive(open.key); return }
    try {
      const c = await api.loadCircuit(id)
      if (!c) { setMsg('That circuit no longer exists.'); saved.reload(); return }
      add(makeBoard(c.name, c.design, c.id))
    } catch (e) { setMsg(cleanError(e)) }
  }
  const newFrom = (id: string): void => {
    if (id === 'blank') add(makeBoard(`PCB ${boardCounter + 1}`, emptyDesign()))
    else { const ex = EXAMPLES.find((e) => e.id === id); if (ex) add(makeBoard(ex.name, ex.make())) }
  }

  return (
    <>
      <PageHeader title="Circuit lab" subtitle="Design several PCBs, each with its own parts and wiring, and test them before touching hardware." />
      <div className="cl-tabs" role="tablist" aria-label="PCBs">
        {boards.map((b) => {
          const dirty = snapshot(b.name, b.design) !== b.baseline
          return (
            <div key={b.key} className={`cl-tab ${b.key === board.key ? 'active' : ''}`}>
              <button role="tab" aria-selected={b.key === board.key} onClick={() => setActive(b.key)} title={dirty ? 'Unsaved changes' : undefined}>
                {b.name || 'Untitled'}{dirty && <i className="cl-dirty" aria-label="unsaved" />}
              </button>
              <button className={`cl-tab-x ${confirmClose === b.key ? 'cl-tab-confirm' : ''}`} aria-label={confirmClose === b.key ? `Discard changes to ${b.name}` : `Close ${b.name}`} onClick={() => close(b.key)}>
                {confirmClose === b.key ? 'Discard?' : <X size={12} aria-hidden />}
              </button>
            </div>
          )
        })}
        <select className="cl-newpcb" aria-label="New PCB" value="" onChange={(e) => { if (e.target.value) newFrom(e.target.value) }}>
          <option value="">＋ New PCB…</option>
          <option value="blank">Blank PCB</option>
          {EXAMPLES.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
        </select>
        {msg && <span className="cl-note cl-note-bad" role="status">{msg}</span>}
      </div>
      <Editor key={board.key} board={board} onPatch={(p) => patch(board.key, p)} saved={saved.data ?? []} reloadSaved={saved.reload} onOpenSaved={(id) => void openSaved(id)} />
    </>
  )
}

interface EditorProps { board: BoardTab; onPatch: (p: Partial<BoardTab>) => void; saved: { id: number; name: string; parts: number }[]; reloadSaved: () => void; onOpenSaved: (id: number) => void }

function Editor({ board, onPatch, saved, reloadSaved, onOpenSaved }: EditorProps): JSX.Element {
  const design = board.design
  const designRef = useRef(design)
  designRef.current = design
  const [sel, setSel] = useState<Sel>(null)
  const [wiring, setWiring] = useState<PinRef | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const [fw, setFw] = useState(initialFw)
  const [now, setNow] = useState(() => new Date())
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)
  const [json, setJson] = useState<string | null>(null)
  const [box, setBox] = useState<Box>(() => fitBox(design))
  const [dragging, setDragging] = useState(false)
  const [builder, setBuilder] = useState(false)
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null)
  const held = useRef<Set<string>>(new Set())

  const report = useMemo(() => evaluate(design), [design])
  const esp = design.parts.find((p) => p.kind === 'esp32')
  const view = useMemo(() => oledView(report, design, fw, now), [report, design, fw, now])
  const errors = report.issues.filter((i) => i.severity === 'error').length
  const warns = report.issues.filter((i) => i.severity === 'warn').length

  useEffect(() => { const h = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(h) }, [])

  const edit = (next: Design): void => onPatch({ design: next })
  const say = (tone: 'ok' | 'bad', text: string): void => setNote({ tone, text })
  const load = (next: Design): void => { onPatch({ design: next }); setBox(fitBox(next)); setSel(null); setWiring(null) }

  // Momentary buttons release on any pointer-up, even outside the part.
  useEffect(() => {
    const up = (): void => {
      if (!held.current.size) return
      let d = designRef.current
      for (const id of held.current) d = setProp(d, id, 'pressed', false)
      held.current.clear()
      onPatch({ design: d })
    }
    window.addEventListener('pointerup', up)
    return () => window.removeEventListener('pointerup', up)
  })

  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return
      if (e.key === 'Escape') { setWiring(null); setSel(null) }
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); deleteSel() }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  function deleteSel(): void {
    if (!sel) return
    const next = sel.kind === 'part' ? removePart(design, sel.id) : removeWire(design, sel.id)
    edit(next); setSel(null)
    if (sel.kind === 'part') setBox(fitBox(next))
  }

  const toSvg = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const svg = svgRef.current!
    const pt = svg.createSVGPoint()
    pt.x = e.clientX; pt.y = e.clientY
    const m = svg.getScreenCTM()
    if (!m) return { x: 0, y: 0 }
    const p = pt.matrixTransform(m.inverse())
    return { x: p.x, y: p.y }
  }

  function pinClick(ref: PinRef): void {
    if (!wiring) { setWiring(ref); setSel(null); return }
    if (wiring.part === ref.part && wiring.pin === ref.pin) { setWiring(null); return }
    const r = addWire(design, wiring, ref)
    if ('error' in r) { say('bad', r.error); return }
    edit(r.design); setWiring(null); setNote(null)
  }

  function endDrag(): void {
    if (!drag.current) return
    drag.current = null
    setDragging(false)
    setBox(fitBox(designRef.current))
  }

  function onMove(e: React.PointerEvent): void {
    const p = toSvg(e)
    if (wiring) setCursor(p)
    const d = drag.current
    if (!d) return
    const cur = designRef.current
    const part = cur.parts.find((x) => x.id === d.id)
    if (!part) return
    const def = defOf(cur, part)
    const pitch = boardPitch(cur.board)
    const c = clampPos(snapTo(p.x - d.dx, pitch), snapTo(p.y - d.dy, pitch), def.w, partHeight(def))
    onPatch({ design: movePart(cur, d.id, c.x, c.y) })
  }

  function place(kind: Parameters<typeof addPart>[1], defId?: string): void {
    const n = design.parts.length
    const pitch = boardPitch(design.board)
    const r = addPart(design, kind, snapTo(box.x + 40 + (n % 6) * 30, pitch), snapTo(box.y + 40 + (n % 6) * 30, pitch), defId)
    if (!r) { say('bad', design.parts.length >= 60 ? 'Design is full (60 parts).' : 'Only one of those is allowed per PCB.'); return }
    edit(r.design); setSel({ kind: 'part', id: r.id }); setBox(fitBox(r.design))
  }

  const dirty = snapshot(board.name, design) !== board.baseline
  async function save(): Promise<void> {
    try {
      const s = await api.saveCircuit(board.name.trim() || 'Untitled PCB', design, board.currentId)
      onPatch({ currentId: s.id, name: s.name, baseline: snapshot(s.name, design) }); reloadSaved(); say('ok', `Saved “${s.name}”.`)
    } catch (e) { say('bad', cleanError(e)) }
  }
  async function removeSaved(id: number): Promise<void> {
    try { await api.deleteCircuit(id); onPatch({ currentId: undefined, baseline: '' }); reloadSaved(); say('ok', 'Deleted the saved copy. This tab is still open.') } catch (e) { say('bad', cleanError(e)) }
  }
  function importJson(): void {
    try {
      const r = DesignSchema.safeParse(JSON.parse(json ?? ''))
      if (!r.success) { say('bad', `Not a valid circuit: ${r.error.issues[0]?.message ?? 'unknown error'}`); return }
      load(r.data as Design); onPatch({ currentId: undefined }); setJson(null); say('ok', 'Imported.')
    } catch { say('bad', 'That is not valid JSON.') }
  }

  const selPart = sel?.kind === 'part' ? design.parts.find((p) => p.id === sel.id) : undefined
  const batt = design.parts.find((p) => p.kind === 'battery')
  const sd = design.parts.find((p) => p.kind === 'sd')
  const enc = design.parts.some((p) => p.kind === 'encoder')
  const encOk = encoderWorks(report, design)
  const reading = sensorReading(report, design)
  const ofKind = (k: BuiltinKind): PartInst[] => design.parts.filter((p) => p.kind === k)
  const hasControls = design.parts.some((p) => ['switch', 'button', 'pot', 'usb', 'fuse', 'ldr', 'thermistor'].includes(p.kind)) || !!batt || !!sd
  const bx = resolveBoard(design.board)
  const boardSpec = BOARDS[bx.type]
  const boardSize = boardMm(design.board)
  const setBoard = (next: BoardModel): void => { const d = { ...design, board: next }; edit(d); setBox(fitBox(d)) }

  return (
    <>
      <div className="cl-toolbar">
        <input className="cl-name" value={board.name} maxLength={60} aria-label="PCB name" onChange={(e) => onPatch({ name: e.target.value })} />
        <button className="btn btn-primary" onClick={() => void save()} title={dirty ? 'Save changes' : 'Saved'}><Save size={14} aria-hidden />Save</button>
        <select aria-label="Saved circuits" value="" onChange={(e) => { if (e.target.value) onOpenSaved(Number(e.target.value)) }}>
          <option value="">Open saved…</option>
          {saved.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.parts} parts</option>)}
        </select>
        {board.currentId !== undefined && <button className="btn btn-danger" onClick={() => void removeSaved(board.currentId!)} title="Delete the saved copy of this PCB"><Trash2 size={14} aria-hidden />Delete saved</button>}
        {note && <span className={`cl-note cl-note-${note.tone}`} role="status">{note.text}</span>}
        <span className="cl-sep" />
        <Badge tone={errors ? 'bad' : warns ? 'warn' : 'ok'}>{errors ? `${errors} error${errors > 1 ? 's' : ''}` : warns ? `${warns} warning${warns > 1 ? 's' : ''}` : 'No problems found'}</Badge>
        <button className="btn" onClick={() => setBox(fitBox(design))} title="Zoom to fit every part">Fit view</button>
        <button className="btn" onClick={() => setJson(JSON.stringify(design, null, 2))}>JSON</button>
      </div>

      {json !== null && (
        <div className="card cl-json">
          <textarea value={json} spellCheck={false} aria-label="Circuit JSON" onChange={(e) => setJson(e.target.value)} />
          <div className="cl-row"><button className="btn btn-primary" onClick={importJson}>Import this JSON</button>
            <button className="btn" onClick={() => void navigator.clipboard.writeText(json).then(() => say('ok', 'Copied.'), () => say('bad', 'Copy failed.'))}>Copy</button>
            <button className="btn" onClick={() => setJson(null)}>Close</button></div>
        </div>
      )}

      <div className="cl-layout">
        <div className="cl-canvas-wrap">
          <div className="cl-palette" role="toolbar" aria-label="Parts">
            {(['module', 'power', 'passive', 'active'] as const).map((g) => (
              <div key={g} className="cl-pgroup"><span>{GROUP_LABEL[g]}</span>
                {BUILTIN_KINDS.filter((k) => PART_DEFS[k].group === g).map((k) => (
                  <button key={k} className="btn btn-sm" disabled={!canAdd(design, k)} onClick={() => place(k)} title={canAdd(design, k) ? `Add ${PART_DEFS[k].name}` : 'Already on this PCB'}>
                    <Plus size={12} aria-hidden />{PART_DEFS[k].name}
                  </button>
                ))}
              </div>
            ))}
            <div className="cl-pgroup"><span>{GROUP_LABEL.custom}</span>
              {(design.customs ?? []).map((c) => (
                <span key={c.id} className="cl-custom">
                  <button className="btn btn-sm" onClick={() => place('custom', c.id)} title={`Add ${c.name}`}><Plus size={12} aria-hidden />{c.name}</button>
                  {!design.parts.some((p) => p.def === c.id) && <button className="btn btn-sm btn-ghost" aria-label={`Remove custom part ${c.name}`} onClick={() => edit({ ...design, customs: (design.customs ?? []).filter((x) => x.id !== c.id) })}><X size={11} aria-hidden /></button>}
                </span>
              ))}
              <button className="btn btn-sm" aria-expanded={builder} onClick={() => setBuilder(!builder)}><Plus size={12} aria-hidden />New custom part…</button>
            </div>
          </div>
          {builder && <CustomBuilder design={design} onCreate={(next) => { edit(next); setBuilder(false); say('ok', 'Custom part created. Add it from the Custom row.') }} onError={(t) => say('bad', t)} />}
          <svg ref={svgRef} className={`cl-canvas ${dragging ? 'cl-dragging' : ''}`} viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} style={{ aspectRatio: `${box.w} / ${box.h}` }} role="application" aria-label="Circuit canvas"
            onPointerMove={onMove} onPointerUp={endDrag} onPointerLeave={endDrag}
            onPointerDown={(e) => { if (e.target === e.currentTarget) { setSel(null); setWiring(null) } }}>
            <defs><pattern id="cl-grid" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="currentColor" opacity=".15" /></pattern></defs>
            <rect x={-4000} y={-4000} width={8000} height={8000} fill="url(#cl-grid)" pointerEvents="none" />
            <BoardView board={design.board} />
            {design.wires.map((w) => {
              const pts = wirePoints(design, w, laneOf(w.id))
              if (!pts) return null
              const active = sel?.kind === 'wire' && sel.id === w.id
              return (
                <g key={w.id} className="cl-wire" onPointerDown={(e) => { e.stopPropagation(); setSel({ kind: 'wire', id: w.id }); setWiring(null) }}>
                  <polyline points={pts} fill="none" stroke="transparent" strokeWidth={12} />
                  <polyline points={pts} fill="none" stroke={wireColor(design, report, w)} strokeWidth={active ? 4 : 2} strokeLinejoin="round" opacity={active ? 1 : 0.85} />
                  <title>{`${w.a.part}.${w.a.pin} ↔ ${w.b.part}.${w.b.pin}: ${report.voltage(w.a.part, w.a.pin).toFixed(2)} V`}</title>
                </g>
              )
            })}
            {wiring && cursor && (() => {
              const p = design.parts.find((x) => x.id === wiring.part)
              const a = p && pinPosition(p, wiring.pin, defOf(design, p))
              return a ? <line x1={a.x} y1={a.y} x2={cursor.x} y2={cursor.y} stroke="var(--accent)" strokeWidth={2} strokeDasharray="5 4" pointerEvents="none" /> : null
            })()}
            {design.parts.map((p) => (
              <PartView key={p.id} part={p} def={defOf(design, p)} report={report} selected={sel?.kind === 'part' && sel.id === p.id} wiring={wiring}
                elem={report.electrical.elements[p.id]} oled={p.kind === 'oled' ? view : undefined} turns={fw.turns} reading={p.kind === 'sensor' ? reading : null}
                onSelect={() => { setSel({ kind: 'part', id: p.id }); setWiring(null) }}
                onGrab={(e) => { const c = toSvg(e); drag.current = { id: p.id, dx: c.x - p.x, dy: c.y - p.y }; setDragging(true) }}
                onPin={pinClick}
                onToggle={() => edit(setProp(design, p.id, 'closed', p.props['closed'] === false))}
                onHold={(down) => { if (down) held.current.add(p.id); else held.current.delete(p.id); edit(setProp(designRef.current, p.id, 'pressed', down)) }} />
            ))}
          </svg>
          <ul className="cl-legend" aria-label="Wire colours">
            {([['3V3', '3.3 V'], ['5V', '5 V'], ['VBAT', 'Battery'], ['GND', 'Ground'], ['signal', 'Signal']] as const).map(([k, l]) => <li key={k}><i style={{ background: RAIL_COLOR[k] }} />{l}</li>)}
            <li className="cl-legend-state"><i className="cl-dot cl-dot-ok" />ok<i className="cl-dot cl-dot-warn" />warning<i className="cl-dot cl-dot-fault" />fault<i className="cl-dot cl-dot-off" />off</li>
          </ul>
        </div>

        <div className="cl-side">
          <section className="card" aria-label="Board">
            <h3>Board</h3>
            <label className="cl-row cl-board-pick">Type
              <select aria-label="Board type" value={bx.type} onChange={(e) => {
                const type = e.target.value as BoardType
                setBoard(type === 'custom' ? { type, cols: bx.cols, rows: bx.rows } : { type })
              }}>
                {BOARD_TYPES.map((t) => <option key={t} value={t}>{BOARDS[t].name}</option>)}
              </select>
            </label>
            {bx.type === 'custom' && (
              <div className="cl-row">
                <label>Width (holes)<input type="number" min={8} max={120} value={bx.cols} aria-label="Board width in holes" onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setBoard({ type: 'custom', cols: Math.min(120, Math.max(8, Math.round(n))), rows: bx.rows }) }} /></label>
                <label>Height (holes)<input type="number" min={8} max={120} value={bx.rows} aria-label="Board height in holes" onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) setBoard({ type: 'custom', cols: bx.cols, rows: Math.min(120, Math.max(8, Math.round(n))) }) }} /></label>
              </div>
            )}
            <p className="cl-hint">{boardSpec.description}</p>
            <p className="cl-hint">≈ {boardSize.w} × {boardSize.h} mm · {bx.cols} × {bx.rows} holes</p>
            <p className="cl-hint">The board is the carrier under the circuit. It changes the canvas, hole grid and mounting holes, never the wiring — the same design works on every board.</p>
          </section>

          <section className="card" aria-label="Live test">
            <h3>Live test</h3>
            {design.parts.some((p) => p.kind === 'oled') && (
              <div className={`cl-oled ${view ? '' : 'cl-oled-off'}`} aria-label="OLED preview">
                {view ? (<><div className="cl-oled-time">{view.lines[0]}</div><div>{view.lines[1]} · {view.battery}</div><div>{view.status}</div></>) : <div>No signal</div>}
              </div>
            )}
            {enc && (
              <div className="cl-row" title={encOk ? '' : 'The encoder is unpowered, unwired, or the ESP32 is not running'}>
                <button className="btn btn-sm" disabled={!encOk} onClick={() => setFw((s) => step(s, 'ccw' satisfies FwEvent))} aria-label="Turn encoder left"><RotateCcw size={13} aria-hidden />Left</button>
                <button className="btn btn-sm" disabled={!encOk} onClick={() => setFw((s) => step(s, 'cw' satisfies FwEvent))} aria-label="Turn encoder right"><RotateCw size={13} aria-hidden />Right</button>
                <button className="btn btn-sm" disabled={!encOk} onClick={() => setFw((s) => step(s, 'press' satisfies FwEvent))}>Press</button>
                <span className="muted">volume {fw.volume}</span>
              </div>
            )}
            {reading && <p className="cl-reading">Sensor reads <b>{reading.tempC.toFixed(1)} °C</b> over I²C</p>}
            {hasControls && <h4 className="cl-sub">Controls</h4>}
            {ofKind('switch').map((s) => <label key={s.id} className="cl-row"><input type="checkbox" checked={s.props['closed'] !== false} onChange={(e) => edit(setProp(design, s.id, 'closed', e.target.checked))} />Switch {s.id} closed</label>)}
            {ofKind('button').map((b) => (
              <div key={b.id} className="cl-row">
                <button className="btn btn-sm" onPointerDown={() => { held.current.add(b.id); edit(setProp(designRef.current, b.id, 'pressed', true)) }}>Hold to press {b.id}</button>
                <span className="muted">{b.props['pressed'] === true ? 'pressed' : 'released'}</span>
              </div>
            ))}
            {ofKind('pot').map((p) => (
              <label key={p.id} className="cl-row cl-slider">Pot {p.id}: wiper {Math.round(Number(p.props['pos'] ?? 0.5) * 100)}%
                <input type="range" min={0} max={1} step={0.01} value={Number(p.props['pos'] ?? 0.5)} aria-label={`Wiper ${p.id}`} onChange={(e) => edit(setProp(design, p.id, 'pos', Number(e.target.value)))} /></label>
            ))}
            {ofKind('usb').map((u) => <label key={u.id} className="cl-row"><input type="checkbox" checked={u.props['plugged'] !== false} onChange={(e) => edit(setProp(design, u.id, 'plugged', e.target.checked))} />USB plugged in</label>)}
            {batt && (
              <label className="cl-row cl-slider">Battery {Number(batt.props['voltage'] ?? 3.7).toFixed(2)} V
                <input type="range" min={2.5} max={4.3} step={0.05} value={Number(batt.props['voltage'] ?? 3.7)} onChange={(e) => edit(setProp(design, batt.id, 'voltage', Number(e.target.value)))} aria-label="Battery voltage" /></label>
            )}
            {sd && <label className="cl-row"><input type="checkbox" checked={sd.props['card'] !== false} onChange={(e) => edit(setProp(design, sd.id, 'card', e.target.checked))} />SD card inserted</label>}
            {ofKind('ldr').map((l) => (
              <label key={l.id} className="cl-row cl-slider">Light {Number(l.props['lux'] ?? 100)} lx
                <input type="range" min={0} max={5000} step={10} value={Number(l.props['lux'] ?? 100)} aria-label={`Light on ${l.id}`} onChange={(e) => edit(setProp(design, l.id, 'lux', Number(e.target.value)))} /></label>
            ))}
            {ofKind('thermistor').map((t) => (
              <label key={t.id} className="cl-row cl-slider">Thermistor {t.id}: {Number(t.props['tempC'] ?? 25).toFixed(1)} °C
                <input type="range" min={-20} max={120} step={0.5} value={Number(t.props['tempC'] ?? 25)} aria-label={`Temperature on ${t.id}`} onChange={(e) => edit(setProp(design, t.id, 'tempC', Number(e.target.value)))} /></label>
            ))}
            {ofKind('fuse').map((f) => <label key={f.id} className="cl-row"><input type="checkbox" checked={f.props['blown'] === true} onChange={(e) => edit(setProp(design, f.id, 'blown', e.target.checked))} />Fuse {f.id} blown</label>)}
            <Meters report={report} design={design} />
          </section>

          <section className="card" aria-label="Checks">
            <h3>Checks</h3>
            {report.issues.length === 0 ? <p className="cl-good"><CircleCheck size={14} aria-hidden /> No problems found.</p> : (
              <ul className="cl-issues">
                {report.issues.map((i) => {
                  const Icon = ISSUE_ICON[i.severity]
                  return <li key={i.id} className={`cl-issue cl-${i.severity}`}><button onClick={() => i.part && setSel({ kind: 'part', id: i.part })}><Icon size={14} aria-hidden /><span>{i.message}</span></button></li>
                })}
              </ul>
            )}
          </section>

          {selPart && (
            <section className="card" aria-label="Selected part">
              <h3>{partLabel(design, selPart.id)}</h3>
              <p className="muted">{report.parts[selPart.id]?.messages.join(' ')}</p>
              {(PROP_FIELDS[selPart.kind] ?? []).map((f) => {
                const v = selPart.props[f.key]
                if (f.kind === 'bool') return <label key={f.key} className="cl-row"><input type="checkbox" checked={v === true} onChange={(e) => edit(setProp(design, selPart.id, f.key, e.target.checked))} />{f.label}</label>
                if (f.kind === 'select') return <label key={f.key} className="cl-row">{f.label}<select value={Number(v ?? 0)} onChange={(e) => edit(setProp(design, selPart.id, f.key, Number(e.target.value)))}>{f.options!.map(([n, l]) => <option key={n} value={n}>{l}</option>)}</select></label>
                return <label key={f.key} className="cl-row">{f.label}<input type="number" min={f.min} max={f.max} step={f.step ?? 1} value={Number(v ?? 0)} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) edit(setProp(design, selPart.id, f.key, Math.min(f.max ?? n, Math.max(f.min ?? n, n)))) }} /></label>
              })}
              <button className="btn btn-danger" onClick={deleteSel}><Trash2 size={14} aria-hidden />Remove part</button>
            </section>
          )}
          {sel?.kind === 'wire' && <section className="card"><h3>Wire {sel.id}</h3><button className="btn btn-danger" onClick={deleteSel}><Trash2 size={14} aria-hidden />Remove wire</button></section>}

          {esp && (
            <details className="card" aria-label="Firmware pins">
              <summary><strong>Firmware pin map</strong> <span className="muted">which GPIO the code uses</span></summary>
              <table className="cl-fw"><tbody>
                {[...SIGNALS.filter((s) => design.parts.some((p) => p.kind === s.kind)).map((s) => ({ key: s.key, label: s.label })), { key: ADC_KEY, label: 'Battery sense (ADC)' }].map((s) => {
                  const link = report.links.find((l) => l.key === s.key)
                  return (
                    <tr key={s.key}><td>{link ? (link.ok ? <CircleCheck size={13} className="status-pass" aria-label="matches wiring" /> : <CircleAlert size={13} className="status-fail" aria-label="mismatch" />) : <Minus size={13} aria-hidden />}</td><td>{s.label}</td>
                      <td><select aria-label={`${s.label} GPIO`} value={design.firmware[s.key] ?? 0} onChange={(e) => edit(setFirmwarePin(design, s.key, Number(e.target.value)))}>
                        {ESP_GPIOS.map((g) => <option key={g} value={g}>GPIO{g}</option>)}</select></td></tr>
                  )
                })}
              </tbody></table>
              <button className="btn btn-sm" onClick={() => edit({ ...design, firmware: defaultFirmware() })}>Reset to defaults</button>
            </details>
          )}
        </div>
      </div>
    </>
  )
}

const BOARD_INK = { plus: '#d64545', minus: '#2f6fb5' } as const
const RAIL_GROUPS = (cols: number): [number, number][] => (cols >= 50
  ? [[0, 24], [38, cols - 1]]
  : [[0, Math.floor(cols / 2) - 1], [Math.floor(cols / 2) + 1, cols - 1]])

/** The carrier under the circuit: PCB, breadboard, perfboard, stripboard or a dev-board footprint. */
function BoardView({ board }: { board?: BoardModel }): JSX.Element {
  const b = resolveBoard(board)
  const spec = b.spec
  const r = boardRect(board)
  const dark = spec.dark === true
  const ink = dark ? '#e8f4ec' : '#3a3226'
  const holeInk = dark ? '#0b2416' : '#4b4234'
  const m = r.margin
  const holeX = (c: number): number => m + 10 + c * 20
  const field = (y: number, h: number): { x: number; y: number; width: number; height: number } => ({ x: m, y, width: r.cols * 20, height: h })
  const tieTop = breadboardBand(r, BREADBOARD_ROWS.tieTop)
  const tieBottom = breadboardBand(r, BREADBOARD_ROWS.tieBottom)
  const rowsOf = (band: readonly [number, number]): number => band[1] - band[0] + 1
  return (
    <g className="cl-board" pointerEvents="none" aria-hidden="true">
      <defs>
        <pattern id="cl-holes" x={m} y={m} width={20} height={20} patternUnits="userSpaceOnUse">
          <circle cx={10} cy={10} r={3.2} fill={holeInk} opacity={0.62} />
        </pattern>
      </defs>
      <rect x={r.x} y={r.y} width={r.w} height={r.h} rx={10} fill={spec.accent} stroke={dark ? '#04200f' : '#b7ab92'} strokeWidth={2} />
      {dark && <rect x={6} y={6} width={r.w - 12} height={r.h - 12} rx={8} fill="none" stroke="#ffffff" strokeOpacity={0.09} />}

      {spec.holes === 'none' && <rect x={m - 8} y={m - 8} width={r.w - 2 * m + 16} height={r.h - 2 * m + 16} rx={8} fill="none" stroke={ink} strokeOpacity={0.14} />}

      {spec.holes === 'breadboard' && (
        <g>
          <rect x={m} y={m + BREADBOARD_ROWS.channel[0] * 20} width={r.cols * 20} height={rowsOf(BREADBOARD_ROWS.channel) * 20} fill={holeInk} opacity={0.1} />
          {spec.rails && RAIL_GROUPS(r.cols).map((g) => {
            const x0 = holeX(g[0]) - 10, w = (g[1] - g[0] + 1) * 20
            return (['top', 'bottom'] as const).map((side) => {
              const plusRow = side === 'top' ? 0 : 18, minusRow = plusRow + 1
              return (
                <g key={`${side}-${g[0]}`}>
                  <rect x={x0} y={breadboardRowY(r, plusRow) - 9} width={w} height={18} rx={9} fill={BOARD_INK.plus} opacity={0.26} />
                  <rect x={x0} y={breadboardRowY(r, minusRow) - 9} width={w} height={18} rx={9} fill={BOARD_INK.minus} opacity={0.22} />
                  <rect {...field(breadboardRowY(r, plusRow) - 10, 20)} x={x0} width={w} fill="url(#cl-holes)" />
                  <rect {...field(breadboardRowY(r, minusRow) - 10, 20)} x={x0} width={w} fill="url(#cl-holes)" />
                  <text x={x0 - 6} y={breadboardRowY(r, plusRow) + 3.5} fontSize={10} fontWeight={700} fill={BOARD_INK.plus} textAnchor="end">+</text>
                  <text x={x0 - 6} y={breadboardRowY(r, minusRow) + 3.5} fontSize={10} fontWeight={700} fill={BOARD_INK.minus} textAnchor="end">−</text>
                </g>
              )
            })
          })}
          <rect {...field(tieTop.y, tieTop.h)} fill="url(#cl-holes)" />
          <rect {...field(tieBottom.y, tieBottom.h)} fill="url(#cl-holes)" />
          {['a', 'b', 'c', 'd', 'e'].map((l, i) => <text key={l} x={m - 8} y={breadboardRowY(r, BREADBOARD_ROWS.tieTop[0] + i) + 4} fontSize={10} fill={ink} textAnchor="end">{l}</text>)}
          {['f', 'g', 'h', 'i', 'j'].map((l, i) => <text key={l} x={m - 8} y={breadboardRowY(r, BREADBOARD_ROWS.tieBottom[0] + i) + 4} fontSize={10} fill={ink} textAnchor="end">{l}</text>)}
          {Array.from({ length: Math.floor(r.cols / 5) }, (_, k) => (k + 1) * 5).map((n) => (
            <text key={n} x={holeX(n - 1)} y={breadboardRowY(r, BREADBOARD_ROWS.channel[0]) + 6} fontSize={9} fill={ink} textAnchor="middle" opacity={0.75}>{n}</text>
          ))}
        </g>
      )}

      {(spec.holes === 'grid' || spec.holes === 'strip') && (
        <g>
          {spec.holes === 'strip' && Array.from({ length: r.rows }, (_, row) => (
            <rect key={row} x={m + 2} y={breadboardRowY(r, row) - 3} width={r.cols * 20 - 4} height={6} fill="#b08d4a" opacity={0.55} />
          ))}
          <rect {...field(m, r.rows * 20)} fill="url(#cl-holes)" />
        </g>
      )}

      {spec.holes === 'footprint' && (
        <g>
          <rect x={m + 10} y={m + 4} width={r.cols * 20 - 20} height={14} rx={4} fill="#0a0f0c" opacity={0.55} />
          <rect x={m + 10} y={r.h - m - 18} width={r.cols * 20 - 20} height={14} rx={4} fill="#0a0f0c" opacity={0.55} />
          <text x={r.w / 2} y={r.h / 2 + 5} fontSize={15} fontWeight={700} fill={ink} textAnchor="middle" opacity={0.55}>{spec.short}</text>
        </g>
      )}

      {spec.holes !== 'breadboard' && mountingHoles(board).map((p, i) => (
        <g key={i}><circle cx={p.x} cy={p.y} r={7} fill={holeInk} opacity={0.45} /><circle cx={p.x} cy={p.y} r={3.4} fill={dark ? '#07240f' : '#a89b80'} /></g>
      ))}

      <text x={m} y={r.h - 16} fontSize={11} fill={ink} opacity={0.8}>{spec.name}</text>
      <text x={r.w - m} y={r.h - 16} fontSize={10} fill={ink} opacity={0.55} textAnchor="end">
        {spec.holes === 'breadboard' ? `${r.cols} columns · 2.54 mm` : `${r.cols} × ${r.rows} holes · 2.54 mm`}
      </text>
    </g>
  )
}


function Meters({ report, design }: { report: Report; design: Design }): JSX.Element | null {
  const esp = design.parts.find((p) => p.kind === 'esp32')
  const batt = design.parts.find((p) => p.kind === 'battery')
  const regs = design.parts.filter((p) => p.kind === 'regulator')
  if (!esp && !batt && !regs.length) return null
  return (
    <dl className="cl-meters">
      {esp && <><dt>3V3 rail</dt><dd>{report.voltage(esp.id, '3V3').toFixed(2)} V</dd><dt>VIN</dt><dd>{report.voltage(esp.id, 'VIN').toFixed(2)} V</dd></>}
      {regs.map((r) => <><dt key={`${r.id}k`}>Regulator {r.id}</dt><dd key={`${r.id}v`}>{(report.electrical.elements[r.id]?.value ?? 0).toFixed(2)} V</dd></>)}
      {batt && <><dt>Battery draw</dt><dd>{((report.electrical.battery?.amps ?? 0) * 1000).toFixed(0)} mA</dd><dt>Runtime</dt><dd>{fmtRuntime(report.battery.runtimeH)}</dd></>}
      {esp && <><dt>ADC (battery)</dt><dd>{report.battery.adcRaw === null ? '—' : `${report.battery.adcRaw} → ${report.battery.volts?.toFixed(2)} V (${report.battery.percent}%)`}</dd></>}
    </dl>
  )
}

function CustomBuilder({ design, onCreate, onError }: { design: Design; onCreate: (d: Design) => void; onError: (t: string) => void }): JSX.Element {
  const [name, setName] = useState('')
  const [pins, setPins] = useState('VCC:power, GND:gnd, SDA, SCL')
  const [vmin, setVmin] = useState(3)
  const [vmax, setVmax] = useState(3.6)
  const [mA, setMa] = useState(5)
  const [color, setColor] = useState('#4b4b6b')
  function create(): void {
    if ((design.customs ?? []).length >= 10) { onError('At most 10 custom parts per PCB.'); return }
    const r = parseCustom({ name, pins, vmin, vmax, mA, accent: color }, (design.customs ?? []).map((c) => c.id))
    if ('error' in r) { onError(r.error); return }
    onCreate({ ...design, customs: [...(design.customs ?? []), r.def] })
  }
  return (
    <div className="cl-builder" role="group" aria-label="Custom part builder">
      <label>Name<input value={name} maxLength={30} placeholder="Hall sensor" onChange={(e) => setName(e.target.value)} /></label>
      <label className="cl-builder-pins">Pins <span className="muted">NAME:type (power, gnd, signal, passive), optional :L or :R</span>
        <textarea value={pins} rows={2} spellCheck={false} onChange={(e) => setPins(e.target.value)} /></label>
      <label>Supply min (V)<input type="number" step={0.1} value={vmin} onChange={(e) => setVmin(Number(e.target.value))} /></label>
      <label>Supply max (V)<input type="number" step={0.1} value={vmax} onChange={(e) => setVmax(Number(e.target.value))} /></label>
      <label>Load (mA)<input type="number" value={mA} onChange={(e) => setMa(Number(e.target.value))} /></label>
      <label>Colour<input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>
      <button className="btn btn-primary" onClick={create}>Create part</button>
    </div>
  )
}

interface PartViewProps {
  part: PartInst; def: PartDef; report: Report; selected: boolean; wiring: PinRef | null; elem: ElementState | undefined
  oled?: ReturnType<typeof oledView> | undefined; turns: number; reading: { tempC: number } | null
  onSelect: () => void; onGrab: (e: React.PointerEvent) => void; onPin: (r: PinRef) => void; onToggle: () => void; onHold: (down: boolean) => void
}

function PartView({ part, def, report, selected, wiring, elem, oled, turns, reading, onSelect, onGrab, onPin, onToggle, onHold }: PartViewProps): JSX.Element {
  const h = partHeight(def)
  const st = report.parts[part.id]
  const cx = def.w / 2, cy = HEADER + 26
  const stroke = selected ? 'var(--accent)' : st && (st.state === 'fault' || st.state === 'warn') ? STATE_COLOR[st.state] : '#0006'
  const pinsOf = (side: 'left' | 'right'): JSX.Element[] => def[side].map((pin, i) => {
    const y = HEADER + i * 20 + 10
    const x = side === 'left' ? 0 : def.w
    const ref = { part: part.id, pin: pin.id }
    const on = wiring?.part === part.id && wiring.pin === pin.id
    const v = report.voltage(part.id, pin.id)
    return (
      <g key={pin.id} className="cl-pin" onPointerDown={(e) => { e.stopPropagation(); onPin(ref) }}>
        <circle cx={x} cy={y} r={9} fill="transparent" />
        <circle cx={x} cy={y} r={on ? 6 : 4.5} fill={on ? 'var(--accent)' : pin.rail ? RAIL_COLOR[pin.rail] : '#e5e7eb'} stroke="#111" strokeWidth={1} />
        <text x={side === 'left' ? 9 : def.w - 9} y={y + 3.5} textAnchor={side === 'left' ? 'start' : 'end'} fontSize={10.5} fill="#fff" pointerEvents="none">{pin.label}</text>
        <title>{`${def.name} · ${pin.label}: ${v.toFixed(2)} V`}</title>
      </g>
    )
  })
  const glow = elem?.on ? Math.min(1, (elem.amps / 0.015) + 0.25) : 0
  const pos = Number(part.props['pos'] ?? 0.5)
  const sym = (t: string): JSX.Element => <text x={cx} y={cy + 6} fontSize={17} fontWeight={700} fill="#fff" opacity={0.85} textAnchor="middle" pointerEvents="none">{t}</text>
  return (
    <g transform={`translate(${part.x},${part.y})`} className={`cl-part cl-st-${st?.state ?? 'na'}`}>
      <rect width={def.w} height={h} rx={6} fill={def.accent} stroke={stroke} strokeWidth={selected ? 3 : 2} opacity={st?.state === 'off' && part.kind !== 'led' ? 0.7 : 1}
        onPointerDown={(e) => { e.stopPropagation(); onSelect(); onGrab(e) }} />
      <text x={8} y={17} fontSize={12} fontWeight={700} fill="#fff" pointerEvents="none">{def.name}</text>
      {st && st.state !== 'n/a' && <circle cx={def.w - 10} cy={13} r={4.5} fill={STATE_COLOR[st.state]}><title>{st.messages.join(' ')}</title></circle>}
      {part.kind === 'oled' && (
        <g pointerEvents="none"><rect x={8} y={34} width={82} height={46} rx={3} fill="#050505" stroke="#444" />
          {oled && <><text x={14} y={58} fontSize={20} fill="#ffb000" fontFamily="monospace">{oled.lines[0]}</text><text x={14} y={72} fontSize={8} fill="#ffb000" fontFamily="monospace">{oled.lines[1]}</text></>}</g>
      )}
      {part.kind === 'encoder' && <g pointerEvents="none" transform={`rotate(${turns * 18} 40 74)`}><circle cx={40} cy={74} r={22} fill="#bbb" stroke="#555" /><line x1={40} y1={74} x2={40} y2={56} stroke="#444" strokeWidth={3} /></g>}
      {part.kind === 'battery' && <text x={10} y={50} fontSize={14} fill="#fff" pointerEvents="none">{Number(part.props['voltage'] ?? 3.7).toFixed(2)}V</text>}
      {part.kind === 'resistor' && <text x={cx} y={h - 10} fontSize={10} fill="#fff" textAnchor="middle" pointerEvents="none">{Number(part.props['ohms'] ?? 0) >= 1000 ? `${Number(part.props['ohms']) / 1000}k` : Number(part.props['ohms'] ?? 0)}Ω</text>}
      {part.kind === 'switch' && (
        <g onPointerDown={(e) => { e.stopPropagation(); onToggle() }} style={{ cursor: 'pointer' }}>
          <line x1={20} y1={52} x2={part.props['closed'] === false ? 62 : 70} y2={part.props['closed'] === false ? 36 : 52} stroke="#fff" strokeWidth={3} strokeLinecap="round" />
          <title>Click to {part.props['closed'] === false ? 'close' : 'open'}</title>
        </g>
      )}
      {part.kind === 'sd' && <rect x={def.w - 50} y={40} width={36} height={44} rx={3} fill={part.props['card'] === false ? 'none' : '#0b3a5b'} stroke="#9cc" strokeDasharray={part.props['card'] === false ? '3 3' : undefined} pointerEvents="none" />}
      {part.kind === 'led' && (
        <g pointerEvents="none"><circle cx={cx} cy={cy} r={17} fill={LED_COLORS[Math.round(Number(part.props['color'] ?? 0)) % LED_COLORS.length]} opacity={glow * 0.35} />
          <circle cx={cx} cy={cy} r={10} fill={LED_COLORS[Math.round(Number(part.props['color'] ?? 0)) % LED_COLORS.length]} opacity={elem?.on ? 0.3 + glow * 0.7 : 0.18} stroke="#fff" strokeOpacity={0.6} /></g>
      )}
      {part.kind === 'diode' && <g pointerEvents="none" stroke="#fff" fill="none" strokeWidth={2}><polygon points={`${cx - 9},${cy - 9} ${cx - 9},${cy + 9} ${cx + 8},${cy}`} /><line x1={cx + 10} y1={cy - 9} x2={cx + 10} y2={cy + 9} /></g>}
      {part.kind === 'capacitor' && <g pointerEvents="none" stroke="#fff" strokeWidth={3}><line x1={cx - 5} y1={cy - 11} x2={cx - 5} y2={cy + 11} /><line x1={cx + 5} y1={cy - 11} x2={cx + 5} y2={cy + 11} /></g>}
      {part.kind === 'inductor' && <path d={`M${cx - 18},${cy} a6,6 0 0 1 12,0 a6,6 0 0 1 12,0 a6,6 0 0 1 12,0`} fill="none" stroke="#fff" strokeWidth={2} pointerEvents="none" />}
      {part.kind === 'pot' && <g pointerEvents="none" transform={`rotate(${-135 + pos * 270} ${cx - 10} ${cy})`}><circle cx={cx - 10} cy={cy} r={13} fill="#ccd" stroke="#556" /><line x1={cx - 10} y1={cy} x2={cx - 10} y2={cy - 11} stroke="#334" strokeWidth={3} /></g>}
      {part.kind === 'button' && (
        <g style={{ cursor: 'pointer' }} onPointerDown={(e) => { e.stopPropagation(); onHold(true) }} onPointerUp={() => onHold(false)}>
          <circle cx={cx} cy={cy} r={13} fill={part.props['pressed'] === true ? '#999' : '#ddd'} stroke="#222" strokeWidth={2} /><title>Hold to press</title></g>
      )}
      {(part.kind === 'npn' || part.kind === 'pnp') && sym(part.kind === 'npn' ? 'NPN' : 'PNP')}
      {part.kind === 'nmos' && sym('N-FET')}
      {part.kind === 'pmos' && sym('P-FET')}
      {part.kind === 'opamp' && <polygon points={`${cx - 14},${cy - 14} ${cx - 14},${cy + 14} ${cx + 12},${cy}`} fill="none" stroke="#fff" strokeWidth={2} pointerEvents="none" />}
      {part.kind === 'regulator' && <text x={cx} y={cy + 6} fontSize={15} fontWeight={700} fill="#fff" textAnchor="middle" pointerEvents="none">{(elem?.value ?? 0).toFixed(2)} V</text>}
      {part.kind === 'sensor' && <text x={14} y={cy + 6} fontSize={14} fill="#fff" pointerEvents="none">{reading ? `${reading.tempC.toFixed(1)}°C` : '— °C'}</text>}
      {part.kind === 'relay' && sym(elem?.on ? 'ON' : 'OFF')}
      {part.kind === 'buzzer' && <g pointerEvents="none" fill="none" stroke="#fff" strokeWidth={2}><circle cx={cx} cy={cy} r={9} opacity={st?.state === 'ok' ? 1 : 0.4} />{st?.state === 'ok' && <path d={`M${cx + 13},${cy - 6} q5,6 0,12 M${cx + 18},${cy - 10} q8,10 0,20`} />}</g>}
      {part.kind === 'usb' && <text x={14} y={cy + 28} fontSize={11} fill="#fff" pointerEvents="none">{part.props['plugged'] === false ? 'unplugged' : '5 V'}</text>}
      {part.kind === 'rgb' && (
        <g pointerEvents="none">
          {(['#ef4444', '#22c55e', '#3b82f6'] as const).map((c, i) => (
            <circle key={c} cx={cx - 18 + i * 18} cy={cy} r={8} fill={c} opacity={0.16 + Math.min(1, (elem?.channels?.[i] ?? 0) / 0.01) * 0.84} stroke="#0004" />
          ))}
        </g>
      )}
      {part.kind === 'fuse' && (
        <g pointerEvents="none" stroke="#fff" fill="none" strokeWidth={2}>
          <rect x={cx - 18} y={cy - 7} width={36} height={14} rx={4} />
          <line x1={cx - 18} y1={cy} x2={cx + 18} y2={cy} strokeDasharray={part.props['blown'] === true ? '4 4' : undefined} />
        </g>
      )}
      {part.kind === 'ldr' && (
        <g pointerEvents="none" stroke="#fff" fill="none" strokeWidth={2}>
          <circle cx={cx} cy={cy} r={12} />
          <path d={`M${cx - 7},${cy + 6} l3.5,-12 l3.5,12 l3.5,-12`} />
        </g>
      )}
      {part.kind === 'thermistor' && (
        <g pointerEvents="none"><circle cx={cx} cy={cy} r={12} fill="none" stroke="#fff" strokeWidth={2} /><text x={cx} y={cy + 5} fontSize={13} fontWeight={700} fill="#fff" textAnchor="middle">θ</text></g>
      )}
      {part.kind === 'motor' && (
        <g pointerEvents="none"><circle cx={cx} cy={cy} r={14} fill="none" stroke="#fff" strokeWidth={2} /><text x={cx} y={cy + 6} fontSize={16} fontWeight={700} fill="#fff" textAnchor="middle">M</text></g>
      )}
      {part.kind === 'fan' && (
        <g pointerEvents="none" stroke="#fff" fill="none" strokeWidth={2}>
          <circle cx={cx} cy={cy} r={14} opacity={elem?.on ? 1 : 0.6} />
          <g opacity={elem?.on ? 1 : 0.45}>
            <path d={`M${cx},${cy} l0,-11 M${cx},${cy} l9.5,5.5 M${cx},${cy} l-9.5,5.5`} strokeWidth={3} strokeLinecap="round" />
          </g>
        </g>
      )}
      {part.kind === 'header' && (
        <g pointerEvents="none" fill="#cbd5e1">
          {Array.from({ length: 8 }, (_, i) => (
            <rect key={i} x={cx - 15 + (i % 2) * 30} y={HEADER + 8 + Math.floor(i / 2) * 20} width={12} height={12} rx={2} opacity={0.7} />
          ))}
        </g>
      )}
      {pinsOf('left')}{pinsOf('right')}
    </g>
  )
}
