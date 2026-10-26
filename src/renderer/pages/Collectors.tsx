import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { matrix } from './collector-matrix'
import { Badge, CATEGORY_META, CollectorStatusBadge, ErrorBox, fullTime, PageHeader, Spinner, timeAgo } from '../components/ui'
import { useLoad } from '../hooks/useLoad'
import { api } from '../services/api'

export function CollectorsPage(): JSX.Element {
  const q = useLoad(() => api.collectorHealth(), [])
  const [busy, setBusy] = useState<string | null>(null)

  const rescan = async (ids?: string[]): Promise<void> => {
    setBusy(ids?.[0] ?? 'all')
    try { await api.scan(ids) } finally { setBusy(null); q.reload() }
  }

  if (q.error) return <><PageHeader title="Collectors" /><ErrorBox message={q.error} onRetry={q.reload} /></>
  if (!q.data) return <><PageHeader title="Collectors" /><Spinner /></>
  const supported = q.data.filter((c) => c.status !== 'unsupported')
  const unsupported = q.data.filter((c) => c.status === 'unsupported')

  return (
    <>
      <PageHeader
        title="Collectors"
        subtitle="Each collector inspects one area of the machine. A collector that cannot inspect something says so — it never reports an empty inventory as success."
        actions={<button className="btn" disabled={busy !== null} onClick={() => void rescan()}><RefreshCw size={14} className={busy === 'all' ? 'spin' : ''} /> Rescan all</button>}
      />
      <div className="stack">
        <section className="card" aria-label="Capability matrix">
          <h2>Capability matrix</h2>
          <p className="muted small">What this machine can actually report, by hardware category, and how complete the last run was. “Limited” means a collector ran but could not read everything (see its limitations below); “not collected” means no collector covers it on this operating system.</p>
          <table className="table">
            <thead><tr><th>Category</th><th>Collectors</th><th>Coverage</th><th>Devices</th><th>Needs elevated access</th></tr></thead>
            <tbody>
              {matrix(q.data).map((r) => (
                <tr key={r.category}>
                  <td>{CATEGORY_META[r.category].label}</td>
                  <td className="mono small">{r.collectors.join(', ') || '—'}</td>
                  <td><Badge tone={r.tone}>{r.coverage}</Badge></td>
                  <td>{r.devices ?? '—'}</td>
                  <td>{r.privileged ? <Badge tone="warn">yes</Badge> : <span className="muted">no</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        {supported.map((c) => (
          <section key={c.id} className="card collector">
            <div className="collector-head">
              <div>
                <h2 className="mono">{c.id} <span className="muted small">v{c.version}</span></h2>
                <p className="muted small">{c.method}</p>
              </div>
              <div className="collector-actions">
                {c.disabled ? <Badge tone="muted" title="Switched off in Settings → Features & controls">disabled</Badge> : <CollectorStatusBadge status={c.status} partial={c.partial} />}
                <button className="btn btn-sm" disabled={busy !== null || c.disabled} onClick={() => void rescan([c.id])} aria-label={`Rescan ${c.id}`}><RefreshCw size={12} className={busy === c.id ? 'spin' : ''} /> Rescan</button>
              </div>
            </div>
            <dl className="kv inline-kv">
              <div><dt>Categories</dt><dd>{c.categories.map((x) => CATEGORY_META[x].label).join(', ')}</dd></div>
              <div><dt>Devices</dt><dd>{c.deviceCount ?? '—'}</dd></div>
              <div><dt>Last run</dt><dd title={fullTime(c.lastRunAt)}>{timeAgo(c.lastRunAt)}{c.durationMs !== null && ` · ${c.durationMs}ms`}</dd></div>
              <div><dt>Last success</dt><dd title={fullTime(c.lastSuccessAt)}>{timeAgo(c.lastSuccessAt)}</dd></div>
            </dl>
            {c.message && <p className={c.status === 'error' ? 'banner banner-bad' : 'muted'}>{c.message}</p>}
            {c.limitations.map((l, i) => (
              <div key={i} className={`banner banner-${l.kind === 'info' ? 'info' : 'warn'}`}>
                <Badge tone={l.kind === 'info' ? 'info' : 'warn'}>{l.kind.replace('_', ' ')}</Badge> <span>{l.message}{l.remedy && <><br /><span className="muted small">What you can do: {l.remedy}</span></>}</span>
              </div>
            ))}
            {c.permissions.length > 0 && <p className="muted small">Permissions for full results: {c.permissions.join('; ')}</p>}
          </section>
        ))}
        {unsupported.length > 0 && (
          <section className="card">
            <h2>Not supported on this operating system</h2>
            <ul className="plain">{unsupported.map((c) => (<li key={c.id}><span className="mono">{c.id}</span><CollectorStatusBadge status="unsupported" /></li>))}</ul>
          </section>
        )}
      </div>
    </>
  )
}
