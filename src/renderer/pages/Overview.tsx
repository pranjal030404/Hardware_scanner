import { AlertTriangle, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import type { Category } from '@shared/schemas'
import type { Navigate } from '../App'
import { Badge, CATEGORY_META, CategoryIcon, CollectorStatusBadge, Empty, ErrorBox, formatBytes, PageHeader, Spinner, timeAgo } from '../components/ui'
import { useEvents } from '../hooks/useEvents'
import { useLoad } from '../hooks/useLoad'
import { api } from '../services/api'

export function OverviewPage({ navigate }: { navigate: Navigate }): JSX.Element {
  const ov = useLoad(() => api.overview(), [])
  const health = useLoad(() => api.collectorHealth(), [])
  const events = useLoad(() => api.recentEvents(6), [])
  const { monitor } = useEvents()
  const [scanning, setScanning] = useState(false)

  const rescan = async (): Promise<void> => {
    setScanning(true)
    try { await api.scan() } finally { setScanning(false) }
  }

  if (ov.error) return <><PageHeader title="Overview" /><ErrorBox message={ov.error} onRetry={ov.reload} /></>
  if (!ov.data) return <><PageHeader title="Overview" /><Spinner /></>
  const o = ov.data
  const total = Object.values(o.counts).reduce((a, b) => a + b, 0)
  const problems = (health.data ?? []).filter((h) => ['error', 'permission_required', 'unavailable', 'stale'].includes(h.status) || h.partial)
  const noData = total === 0

  return (
    <>
      <PageHeader
        title="Overview"
        subtitle={monitor?.lastScanAt ? `Last scan ${timeAgo(monitor.lastScanAt)}` : 'Waiting for the first scan'}
        actions={<button className="btn" onClick={() => void rescan()} disabled={scanning}><RefreshCw size={14} className={scanning ? 'spin' : ''} aria-hidden /> Rescan</button>}
      />
      {monitor?.degraded && (
        <div className="banner banner-warn" role="status"><AlertTriangle size={14} aria-hidden /> Live monitoring is degraded: {monitor.message}</div>
      )}
      {noData ? (
        <Empty title="No hardware inventoried yet">The first scan is still running or every collector failed. See the Collectors page for details.</Empty>
      ) : (
        <div className="grid">
          <section className="card span-2" aria-labelledby="sys">
            <h2 id="sys">System</h2>
            <dl className="kv">
              {Object.entries(o.system).map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
            </dl>
          </section>

          <section className="card" aria-labelledby="mon">
            <h2 id="mon">Monitoring</h2>
            <p><Badge tone={monitor?.mode === 'paused' ? 'muted' : monitor?.degraded ? 'warn' : 'ok'}>{monitor?.mode ?? '…'}</Badge></p>
            <p className="muted">{monitor?.message ?? (monitor?.mode === 'udev' ? 'Hardware changes are detected immediately via udev; a safety rescan runs every ' + monitor.intervalSec + 's.' : '')}</p>
            <button className="btn btn-sm" onClick={() => navigate({ page: 'events' })}>Open events</button>
          </section>

          <section className="card span-3" aria-labelledby="counts">
            <h2 id="counts">Detected hardware <span className="muted">· {total} devices</span></h2>
            <div className="chips">
              {(Object.keys(CATEGORY_META) as Category[]).filter((c) => o.counts[c]).map((c) => (
                <button key={c} className="stat" onClick={() => navigate({ page: 'inventory', category: c })}>
                  <CategoryIcon category={c} /><b>{o.counts[c]}</b><span>{CATEGORY_META[c].label}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="card span-2" aria-labelledby="stor">
            <h2 id="stor">Storage</h2>
            {o.storage.length === 0 ? <p className="muted">No mounted volumes with usage information.</p> : o.storage.map((s) => {
              const pct = Math.round((s.usedBytes / s.totalBytes) * 100)
              return (
                <div key={s.mount} className="usage">
                  <div className="usage-head"><span>{s.mount}</span><span className="muted">{s.fs} · {formatBytes(s.usedBytes)} of {formatBytes(s.totalBytes)}</span></div>
                  <div className="bar" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${s.mount} usage`}><span style={{ width: `${pct}%` }} className={pct > 90 ? 'bad' : pct > 75 ? 'warn' : ''} /></div>
                </div>
              )
            })}
          </section>

          <section className="card" aria-labelledby="net">
            <h2 id="net">Network</h2>
            {o.network.length === 0 ? <p className="muted">No physical interfaces.</p> : (
              <ul className="plain">
                {o.network.map((n) => (<li key={n.name}><span>{n.name} <span className="muted">({n.kind})</span></span><Badge tone={n.state === 'up' ? 'ok' : 'muted'}>{n.state}</Badge></li>))}
              </ul>
            )}
          </section>

          <section className="card span-2" aria-labelledby="ev">
            <h2 id="ev">Recent device events</h2>
            {(events.data ?? []).filter((e) => e.type.startsWith('device.') || e.type === 'collector.failed').length === 0
              ? <p className="muted">No changes since monitoring began. Plug in or remove a device to see it here.</p>
              : (
                <ul className="plain">
                  {(events.data ?? []).filter((e) => e.type.startsWith('device.') || e.type === 'collector.failed').map((e, i) => (
                    <li key={i}><span>{e.summary}</span><span className="muted">{timeAgo(e.at)}</span></li>
                  ))}
                </ul>
              )}
          </section>

          <section className="card" aria-labelledby="fd">
            <h2 id="fd">Diagnostics</h2>
            {o.openFindings === 0 ? <p className="muted">No active findings.</p> : <p><Badge tone="warn">{o.openFindings} active</Badge></p>}
            <button className="btn btn-sm" onClick={() => navigate({ page: 'diagnostics' })}>Open diagnostics</button>
          </section>

          <section className="card" aria-labelledby="ch">
            <h2 id="ch">Collector health</h2>
            {problems.length === 0 ? <p><Badge tone="ok">all collectors healthy</Badge></p> : (
              <ul className="plain">
                {problems.map((p) => (<li key={p.id}><span>{p.id}</span><CollectorStatusBadge status={p.status} partial={p.partial} /></li>))}
              </ul>
            )}
            <button className="btn btn-sm" onClick={() => navigate({ page: 'collectors' })}>Details & permissions</button>
          </section>
        </div>
      )}
    </>
  )
}
