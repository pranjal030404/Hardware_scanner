import { GitCompare, History, Save, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ComparisonChange, CoverageState, PropertyChange, SnapshotComparison, SnapshotMeta } from '@shared/schemas'
import type { Navigate } from '../App'
import { Badge, CATEGORY_META, CategoryIcon, Empty, ErrorBox, formatValue, fullTime, PageHeader, Spinner, timeAgo } from '../components/ui'
import { useLoad } from '../hooks/useLoad'
import { api } from '../services/api'

const COV_TONE: Record<CoverageState, 'ok' | 'warn' | 'bad' | 'muted'> = {
  complete: 'ok', partial: 'warn', stale: 'warn', permission_required: 'warn', unavailable: 'warn', unsupported: 'muted', error: 'bad', not_scanned: 'muted'
}
const CERT_TONE = { confirmed: 'ok', probable: 'info', uncertain: 'warn' } as const

const label = (m: SnapshotMeta): string => m.label ?? new Date(m.createdAt).toLocaleString()

function Value({ v, unit }: { v: string | number | boolean | null; unit?: string }): JSX.Element {
  return v === null ? <span className="muted">—</span> : <span className="mono">{typeof v === 'string' && v === '[sensitive]' ? '[sensitive]' : formatValue(v, unit)}</span>
}

function ChangeRows({ changes, navigate }: { changes: PropertyChange[]; navigate?: undefined }): JSX.Element {
  void navigate
  return (
    <table className="table compact nested">
      <thead><tr><th>Property</th><th>Before</th><th>After</th><th>Source</th><th>Certainty</th></tr></thead>
      <tbody>
        {changes.map((c, i) => (
          <tr key={i}>
            <td>{c.field.replace(/_/g, ' ')}{c.kind !== 'property' && <span className="muted small"> ({c.kind})</span>}</td>
            <td><Value v={c.before} unit={c.unit} /></td>
            <td><Value v={c.after} unit={c.unit} /></td>
            <td className="mono small">{c.source ?? ''}</td>
            <td><Badge tone={CERT_TONE[c.certainty]} title={c.note}>{c.change === 'removed' ? 'removed · ' : c.change === 'added' ? 'added · ' : ''}{c.certainty}</Badge>{c.note && <div className="muted small">{c.note}</div>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Section({ title, count, children, tone }: { title: string; count: number; children: React.ReactNode; tone?: 'warn' }): JSX.Element | null {
  if (!count) return null
  return (
    <section className="card cmp-section">
      <h2>{title} <span className={tone === 'warn' ? 'warn-text' : 'muted'}>· {count}</span></h2>
      {children}
    </section>
  )
}

function Comparison({ r, navigate }: { r: SnapshotComparison; navigate: Navigate }): JSX.Element {
  const by = <K extends ComparisonChange['kind']>(k: K) => r.changes.filter((c): c is Extract<ComparisonChange, { kind: K }> => c.kind === k)
  const open = (id: string): void => navigate({ page: 'device', id, from: { page: 'snapshots' } })
  const s = r.summary
  const nothing = r.changes.length === 0
  return (
    <div className="stack wide" aria-live="polite">
      <section className="card">
        <h2>Comparison <span className="muted">· {label(r.base)} → {label(r.target)}</span></h2>
        <div className="chips">
          {([['Added', s.added], ['Removed', s.removed], ['Changed', s.changed], ['Relationships', s.relationshipChanged], ['Coverage', s.coverageChanged], ['Indeterminate', s.indeterminate], ['Unchanged', s.unchanged]] as const).map(([k, v]) => (
            <span className="stat static" key={k}><b>{v}</b><span>{k}</span></span>
          ))}
        </div>
        {r.uncertain ? (
          <div className="banner banner-warn" role="status">
            <div>
              <b>This comparison is not fully conclusive.</b> Differences marked indeterminate or uncertain may be caused by incomplete collection rather than real hardware changes:
              <ul className="reasons">{r.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          </div>
        ) : (
          <div className="banner banner-info" role="status">Conclusive: no difference here can be explained by a change in collector coverage.{r.includeVolatile ? '' : ' Live readings (counters, battery level, …) are excluded.'}</div>
        )}
        {nothing && !r.uncertain && <p className="muted">No differences between these snapshots.</p>}
      </section>

      <Section title="Coverage changes" count={by('coverage_changed').length} tone="warn">
        <ul className="plain">{by('coverage_changed').map((c) => (
          <li key={c.collectorId}><span><span className="mono">{c.collectorId}</span> <Badge tone="muted">{c.before.replace('_', ' ')}</Badge> → <Badge tone={c.after === 'complete' ? 'ok' : 'warn'}>{c.after.replace('_', ' ')}</Badge><div className="muted small">{c.explanation}</div></span></li>
        ))}</ul>
      </Section>

      <Section title="Removed devices" count={by('device_removed').length}>
        <ul className="plain">{by('device_removed').map((c) => (
          <li key={c.device.key}><button className="link" onClick={() => open(c.device.deviceId)}><CategoryIcon category={c.device.category} size={14} /> {c.device.name}</button><Badge tone="ok">confirmed removed</Badge></li>
        ))}</ul>
      </Section>
      <Section title="Added devices" count={by('device_added').length}>
        <ul className="plain">{by('device_added').map((c) => (
          <li key={c.device.key}><button className="link" onClick={() => open(c.device.deviceId)}><CategoryIcon category={c.device.category} size={14} /> {c.device.name}</button><Badge tone="ok">confirmed added</Badge></li>
        ))}</ul>
      </Section>

      <Section title="Changed devices" count={by('property_changed').length}>
        {by('property_changed').map((c) => (
          <div key={c.device.key} className="cmp-device">
            <button className="link" onClick={() => open(c.device.deviceId)}><CategoryIcon category={c.device.category} size={14} /> {c.device.name}</button>
            {c.rekeyed && <Badge tone="info" title={`Matched by ${c.rekeyed.method}`}>re-identified</Badge>}
            <ChangeRows changes={c.changes} />
          </div>
        ))}
      </Section>

      <Section title="Relationship changes" count={by('relationship_changed').length}>
        {by('relationship_changed').map((c) => (
          <div key={c.device.key} className="cmp-device">
            <button className="link" onClick={() => open(c.device.deviceId)}><CategoryIcon category={c.device.category} size={14} /> {c.device.name}</button>
            <ul className="plain">{c.changes.map((x, i) => (
              <li key={i}>
                <span>{x.change} <Badge tone="neutral">{x.type.replace(/_/g, ' ')}</Badge> {x.otherName}
                  {x.note && <div className="muted small">{x.note}</div>}</span>
                <span className="rel-meta">
                  {x.before && <Badge tone={x.before.directness === 'reported' ? 'ok' : 'warn'}>{x.before.directness === 'reported' ? 'reported' : `inferred ${Math.round(x.before.confidence * 100)}%`}</Badge>}
                  {x.before && x.after && '→'}
                  {x.after && <Badge tone={x.after.directness === 'reported' ? 'ok' : 'warn'}>{x.after.directness === 'reported' ? 'reported' : `inferred ${Math.round(x.after.confidence * 100)}%`}</Badge>}
                  <Badge tone={CERT_TONE[x.certainty]}>{x.certainty}</Badge>
                </span>
              </li>
            ))}</ul>
          </div>
        ))}
      </Section>

      <Section title="Indeterminate differences" count={by('indeterminate').length} tone="warn">
        <p className="muted small">These devices differ between the snapshots, but incomplete collection means the app cannot say whether they were really added or removed.</p>
        <ul className="plain">{by('indeterminate').map((c) => (
          <li key={c.device.key + c.direction}><span><button className="link" onClick={() => open(c.device.deviceId)}><CategoryIcon category={c.device.category} size={14} /> {c.device.name}</button>
            <div className="muted small">{c.direction === 'missing_in_target' ? 'Missing in the newer snapshot' : 'Present only in the newer snapshot'} — {c.reason}</div></span><Badge tone="warn">uncertain</Badge></li>
        ))}</ul>
      </Section>
    </div>
  )
}

export function SnapshotsPage({ navigate }: { navigate: Navigate }): JSX.Element {
  const list = useLoad(() => api.listSnapshots(), [], false)
  const [labelText, setLabelText] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | undefined>()
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')
  const [includeVolatile, setIncludeVolatile] = useState(false)
  const [result, setResult] = useState<SnapshotComparison | null>(null)

  const snaps = list.data ?? []
  const meta = useMemo(() => snaps.find((s) => s.id === selected), [snaps, selected])

  const run = async (what: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(what); setError(null); setNotice(null)
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(null) }
  }

  const create = (): Promise<void> => run('create', async () => {
    const m = await api.createSnapshot(labelText.trim() || undefined)
    setLabelText(''); setSelected(m.id); list.reload()
    setNotice(`Snapshot saved: ${m.deviceCount} devices${m.complete ? '' : ' — coverage was incomplete, see details'}.`)
  })
  const compare = (): Promise<void> => run('compare', async () => { setResult(await api.compareSnapshots(fromId, toId, includeVolatile)) })
  const remove = (): Promise<void> => run('delete', async () => {
    const ids = [...checked]
    const r = await api.deleteSnapshots(ids)
    setChecked(new Set()); setConfirmDelete(false)
    if (selected && ids.includes(selected)) setSelected(undefined)
    if (result && (ids.includes(result.base.id) || ids.includes(result.target.id))) setResult(null)
    if (ids.includes(fromId)) setFromId('')
    if (ids.includes(toId)) setToId('')
    setNotice(`Deleted ${r.deleted} snapshot${r.deleted === 1 ? '' : 's'}.`)
    list.reload()
  })

  return (
    <>
      <PageHeader
        title="Snapshots"
        subtitle="Point-in-time copies of the inventory with the collector coverage at the time. Comparisons only call a device removed when the collector that reported it completed in the newer snapshot."
      />
      <section className="card" aria-label="Create snapshot">
        <div className="toolbar">
          <label className="field inline-field"><span>Label (optional)</span>
            <input type="text" maxLength={80} value={labelText} placeholder="e.g. before BIOS update" onChange={(e) => setLabelText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
          </label>
          <button className="btn" disabled={busy !== null} onClick={() => void create()}><Save size={14} className={busy === 'create' ? 'spin' : ''} /> Create snapshot</button>
          <span className="muted small">Runs a fresh scan first, then saves a copy.</span>
        </div>
      </section>
      {error && <ErrorBox message={error} />}
      {notice && <div className="banner banner-info" role="status">{notice}</div>}
      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {!list.data && !list.error && <Spinner />}

      {list.data && snaps.length === 0 && <Empty icon={<History size={22} />} title="No snapshots yet">Create one now, then create another later (after plugging devices or changing settings) to compare them.</Empty>}

      {snaps.length > 0 && (
        <div className="snap-layout">
          <div className="table-wrap">
            <table className="table compact">
              <thead><tr><th scope="col" aria-label="Select"></th><th scope="col">Snapshot</th><th scope="col">Devices</th><th scope="col">Coverage</th><th scope="col">Created</th></tr></thead>
              <tbody>
                {snaps.map((s) => (
                  <tr key={s.id} tabIndex={0} className={selected === s.id ? 'row-selected' : ''} onClick={() => setSelected(s.id)} onKeyDown={(e) => { if (e.key === 'Enter') setSelected(s.id) }}>
                    <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${label(s)} for deletion`} checked={checked.has(s.id)} onChange={(e) => setChecked((c) => { const n = new Set(c); if (e.target.checked) n.add(s.id); else n.delete(s.id); return n })} /></td>
                    <td>{label(s)}</td>
                    <td>{s.deviceCount}</td>
                    <td><Badge tone={s.complete ? 'ok' : 'warn'}>{s.complete ? 'complete' : s.collectors.length ? 'incomplete' : 'unknown'}</Badge></td>
                    <td className="muted" title={fullTime(s.createdAt)}>{timeAgo(s.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="table-foot">
              {!confirmDelete ? (
                <button className="btn btn-sm" disabled={checked.size === 0 || busy !== null} onClick={() => setConfirmDelete(true)}><Trash2 size={13} /> Delete selected ({checked.size})</button>
              ) : (
                <span className="confirm" role="alertdialog" aria-label="Confirm deletion">
                  Permanently delete {checked.size} snapshot{checked.size === 1 ? '' : 's'}? This cannot be undone.
                  <button className="btn btn-sm btn-danger" disabled={busy !== null} onClick={() => void remove()}>Delete</button>
                  <button className="btn btn-sm" onClick={() => setConfirmDelete(false)}>Cancel</button>
                </span>
              )}
              <span className="muted small">Snapshots are never deleted automatically.</span>
            </div>
          </div>

          <aside className="card" aria-label="Snapshot details">
            {!meta ? <p className="muted">Select a snapshot to see its metadata and the coverage of each collector when it was taken.</p> : (
              <>
                <h2>{label(meta)}</h2>
                <dl className="kv">
                  <div><dt>Created</dt><dd>{fullTime(meta.createdAt)}</dd></div>
                  <div><dt>Scan finished</dt><dd>{fullTime(meta.scanAt)}</dd></div>
                  <div><dt>Devices</dt><dd>{meta.deviceCount} · {meta.propertyCount} properties · {meta.relationshipCount} relationships</dd></div>
                  <div><dt>App / schema</dt><dd>{meta.appVersion ?? '—'} / v{meta.schemaVersion ?? '—'}</dd></div>
                  <div><dt>Machine id</dt><dd className="mono small" title="Random id generated on this computer; never transmitted">{meta.machineId ? meta.machineId.slice(0, 8) : '—'}</dd></div>
                </dl>
                <div className="chips">{Object.entries(meta.categoryCounts).map(([c, n]) => <span key={c} className="chip static"><CategoryIcon category={c as keyof typeof CATEGORY_META} size={13} /> {CATEGORY_META[c as keyof typeof CATEGORY_META]?.label ?? c} <b>{n}</b></span>)}</div>
                {meta.limitations.length > 0 && <div className="banner banner-warn" role="status"><div><b>Collection limitations</b><ul className="reasons">{meta.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul></div></div>}
                {meta.collectors.length === 0 && <p className="muted small">This snapshot predates coverage tracking, so it can never confirm a removal.</p>}
                <h3>Collector coverage</h3>
                <table className="table compact">
                  <tbody>{meta.collectors.filter((c) => c.state !== 'unsupported').map((c) => (
                    <tr key={c.id}><td className="mono small">{c.id}</td><td><Badge tone={COV_TONE[c.state]}>{c.state.replace('_', ' ')}</Badge></td><td className="muted small">{c.deviceCount} devices</td></tr>
                  ))}</tbody>
                </table>
              </>
            )}
          </aside>
        </div>
      )}

      {snaps.length >= 2 && (
        <section className="card" aria-label="Compare snapshots">
          <h2>Compare</h2>
          <div className="toolbar">
            <label className="field inline-field"><span>From (older)</span>
              <select value={fromId} onChange={(e) => setFromId(e.target.value)} aria-label="From snapshot"><option value="">Choose…</option>{snaps.map((s) => <option key={s.id} value={s.id}>{label(s)}</option>)}</select></label>
            <label className="field inline-field"><span>To (newer)</span>
              <select value={toId} onChange={(e) => setToId(e.target.value)} aria-label="To snapshot"><option value="">Choose…</option>{snaps.map((s) => <option key={s.id} value={s.id}>{label(s)}</option>)}</select></label>
            <label className="check"><input type="checkbox" checked={includeVolatile} onChange={(e) => setIncludeVolatile(e.target.checked)} /> Include live readings</label>
            <button className="btn" disabled={!fromId || !toId || fromId === toId || busy !== null} onClick={() => void compare()}><GitCompare size={14} className={busy === 'compare' ? 'spin' : ''} /> Compare</button>
          </div>
          {fromId && toId && fromId === toId && <p className="muted small">Choose two different snapshots.</p>}
        </section>
      )}
      {snaps.length === 1 && <p className="muted small">Create a second snapshot to enable comparison.</p>}
      {result && <Comparison r={result} navigate={navigate} />}
    </>
  )
}
