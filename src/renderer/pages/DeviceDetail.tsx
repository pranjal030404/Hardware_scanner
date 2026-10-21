import { ArrowLeft, Eye, EyeOff, Share2 } from 'lucide-react'
import { useState } from 'react'
import type { Evidence, Identifier, RelatedDevice } from '@shared/schemas'
import type { Navigate, Route } from '../App'
import { Badge, CATEGORY_META, CategoryIcon, DeviceStatusBadge, Empty, ErrorBox, formatValue, fullTime, PageHeader, Spinner, timeAgo } from '../components/ui'
import { DeviceMetrics } from '../components/DeviceMetrics'
import { useLoad } from '../hooks/useLoad'
import { api } from '../services/api'

const EVIDENCE: Record<Evidence, { label: string; tone: 'ok' | 'info' | 'neutral' | 'warn'; hint: string }> = {
  os_reported: { label: 'OS reported', tone: 'ok', hint: 'Value read directly from an operating-system interface' },
  measured: { label: 'measured', tone: 'info', hint: 'Live reading from a sensor or counter' },
  derived: { label: 'derived', tone: 'neutral', hint: 'Computed or classified by this application from other values' },
  database_lookup: { label: 'ID lookup', tone: 'warn', hint: 'Name looked up from a vendor/product ID database, not read from the device' }
}

function EvidenceBadge({ e }: { e: Evidence }): JSX.Element {
  const m = EVIDENCE[e]
  return <Badge tone={m.tone} title={m.hint}>{m.label}</Badge>
}

function SensitiveValue({ text }: { text: string }): JSX.Element {
  const [show, setShow] = useState(false)
  return (
    <span className="inline">
      <span className="mono">{show ? text : '••••••••'}</span>
      <button className="btn btn-sm btn-ghost" onClick={() => setShow(!show)} aria-label={show ? 'Hide value' : 'Reveal value'}>{show ? <EyeOff size={13} /> : <Eye size={13} />}</button>
      <Badge tone="muted" title="Excluded from exports unless enabled in Settings">sensitive</Badge>
    </span>
  )
}

function IdentifierRow({ i }: { i: Identifier }): JSX.Element {
  const [show, setShow] = useState(false)
  return (
    <tr>
      <td>{i.kind.replace(/_/g, ' ')}</td>
      <td className="mono">{i.sensitive && !show ? '••••••••' : i.value}</td>
      <td>{i.sensitive ? <button className="btn btn-sm btn-ghost" onClick={() => setShow(!show)} aria-label={show ? 'Hide value' : 'Reveal value'}>{show ? <EyeOff size={13} /> : <Eye size={13} />}</button> : null}{i.sensitive && <Badge tone="muted" title="Excluded from exports unless enabled in Settings">sensitive</Badge>}</td>
    </tr>
  )
}

function Relations({ title, items, onOpen, note }: { title: string; items: RelatedDevice[]; onOpen: (id: string) => void; note?: string }): JSX.Element | null {
  if (!items.length) return null
  return (
    <section className="card">
      <h2>{title}</h2>
      {note && <p className="muted small">{note}</p>}
      <ul className="plain">
        {items.map((r) => (
          <li key={`${r.other.id}${r.relationshipType}${r.source}`}>
            <button className="link" onClick={() => onOpen(r.other.id)}><CategoryIcon category={r.other.category} size={14} /> {r.other.name}{r.other.presence === 'missing' && ' (missing)'}</button>
            <span className="rel-meta">
              <Badge tone="neutral">{r.relationshipType.replace(/_/g, ' ')}</Badge>
              <Badge tone={r.directness === 'reported' ? 'ok' : 'warn'} title={r.directness === 'reported' ? 'Reported directly by the OS/kernel' : 'Inferred by this application; not verified wiring'}>{r.directness === 'reported' ? 'reported' : `inferred · ${Math.round(r.confidence * 100)}%`}</Badge>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function DeviceDetailPage({ id, back, navigate }: { id: string; back: Route; navigate: Navigate }): JSX.Element {
  const q = useLoad(() => api.getDevice(id), [id])
  const open = (otherId: string): void => navigate({ page: 'device', id: otherId, from: back })

  if (q.error) return <><PageHeader title="Device" /><ErrorBox message={q.error} onRetry={q.reload} /></>
  if (q.loading && !q.data) return <><PageHeader title="Device" /><Spinner /></>
  if (!q.data) return <><PageHeader title="Device not found" actions={<button className="btn" onClick={() => navigate(back)}><ArrowLeft size={14} /> Back</button>} /><Empty title="This device is no longer in the inventory" /></>
  const { device: d, identifiers, properties, relationships, events } = q.data
  const parents = relationships.filter((r) => r.direction === 'parent')
  const children = relationships.filter((r) => r.direction === 'child')

  const core: [string, string | null, string][] = [
    ['Name', d.name, 'name'], ['Manufacturer', d.manufacturer, 'manufacturer'], ['Model', d.model, 'model'], ['Subtype', d.subtype, 'subtype'],
    ['Description', d.description, 'description'], ['Vendor ID', d.vendorId, 'vendorId'], ['Product ID', d.productId, 'productId'], ['Bus', d.busType, 'busType'],
    ['Class', d.deviceClass, 'deviceClass'], ['Driver', d.driver, 'driver']
  ]
  const live = properties.filter((p) => p.volatile)
  const stable = properties.filter((p) => !p.volatile)

  return (
    <>
      <PageHeader
        title={d.name}
        subtitle={<span className="inline"><CategoryIcon category={d.category} /> {CATEGORY_META[d.category].label} {d.presence === 'missing' ? <Badge tone="warn">missing since {timeAgo(d.lastSeen)}</Badge> : <DeviceStatusBadge status={d.status} />}</span>}
        actions={<>
          <button className="btn" onClick={() => navigate({ page: 'topology', focus: d.id })}><Share2 size={14} /> Show in topology</button>
          <button className="btn" onClick={() => navigate(back)}><ArrowLeft size={14} /> Back</button>
        </>}
      />
      <div className="grid">
        <section className="card span-2">
          <h2>Identity</h2>
          <table className="table compact">
            <thead><tr><th>Field</th><th>Value</th><th>Source</th><th>Evidence</th></tr></thead>
            <tbody>
              {core.map(([label, value, key]) => {
                const src = d.fieldSources[key]
                return (
                  <tr key={key}>
                    <td>{label}</td>
                    <td>{value ?? <span className="muted" title="Not exposed by the operating system">unavailable</span>}</td>
                    <td className="mono small">{value && src ? `${src.source} · ${src.sourceProperty}` : ''}</td>
                    <td>{value && src ? <EvidenceBadge e={src.evidence} /> : null}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h2>Record</h2>
          <dl className="kv">
            <div><dt>First seen</dt><dd>{fullTime(d.firstSeen)}</dd></div>
            <div><dt>Last seen</dt><dd>{fullTime(d.lastSeen)}</dd></div>
            <div><dt>Last scanned</dt><dd>{fullTime(d.lastScanned)}</dd></div>
            <div><dt>Collector</dt><dd className="mono">{d.source}</dd></div>
            <div><dt>Record ID</dt><dd className="mono small">{d.id}</dd></div>
          </dl>
        </section>

        <section className="card span-2">
          <h2>Identifiers</h2>
          {identifiers.length === 0 ? <p className="muted">No identifiers reported.</p> : (
            <table className="table compact"><tbody>{identifiers.map((i) => <IdentifierRow key={`${i.kind}${i.value}`} i={i} />)}</tbody></table>
          )}
        </section>

        <Relations title="Attached to" items={parents} onOpen={open} note="Parent relationships as reported by the OS device tree, or marked as inferred." />
        <Relations title="Attached devices" items={children} onOpen={open} />

        <section className="card span-3">
          <h2>Properties <span className="muted">· {stable.length}</span></h2>
          {stable.length === 0 ? <p className="muted">No additional properties.</p> : <PropertyTable rows={stable} />}
        </section>
        <DeviceMetrics deviceId={d.id} />
        {live.length > 0 && (
          <section className="card span-3">
            <h2>Live readings <span className="muted">· as of last scan</span></h2>
            <PropertyTable rows={live} />
          </section>
        )}
        <section className="card span-3">
          <h2>History</h2>
          {events.length === 0 ? <p className="muted">No connection or change events recorded for this device since it was first seen.</p> : (
            <ul className="plain">{events.map((e, i) => (<li key={i}><span>{e.summary}{Array.isArray(e.data['changes']) && <span className="muted small"> — {(e.data['changes'] as string[]).join('; ')}</span>}</span><span className="muted" title={fullTime(e.at)}>{timeAgo(e.at)}</span></li>))}</ul>
          )}
        </section>
      </div>
    </>
  )
}

function PropertyTable({ rows }: { rows: import('@shared/schemas').Property[] }): JSX.Element {
  return (
    <table className="table compact">
      <thead><tr><th>Property</th><th>Value</th><th>Source</th><th>Evidence</th><th>Observed</th></tr></thead>
      <tbody>
        {rows.map((p) => (
          <tr key={`${p.key}${p.source}`}>
            <td>{p.key.replace(/_/g, ' ')}</td>
            <td>{p.sensitive ? <SensitiveValue text={formatValue(p.value, p.unit)} /> : formatValue(p.value, p.unit)}</td>
            <td className="mono small">{p.source} · {p.sourceProperty}</td>
            <td><EvidenceBadge e={p.evidence} /></td>
            <td className="muted small" title={fullTime(p.observedAt)}>{timeAgo(p.observedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
