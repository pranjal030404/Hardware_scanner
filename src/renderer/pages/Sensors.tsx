import { RefreshCw } from 'lucide-react'
import type { DeviceDetail } from '@shared/schemas'
import { rowsOf, STALE_MS, UNLABELLED } from './sensor-rows'
import type { Navigate } from '../App'
import { Badge, Empty, ErrorBox, fullTime, PageHeader, Spinner, timeAgo, formatValue } from '../components/ui'
import { useLoad } from '../hooks/useLoad'
import { api } from '../services/api'

export function SensorsPage({ navigate }: { navigate: Navigate }): JSX.Element {
  const q = useLoad(async () => {
    const list = await api.listDevices({ category: 'sensor' })
    return (await Promise.all(list.map((d) => api.getDevice(d.id)))).filter((d): d is DeviceDetail => !!d)
  }, [])
  if (q.error) return <><PageHeader title="Sensors" /><ErrorBox message={q.error} onRetry={q.reload} /></>
  if (!q.data) return <><PageHeader title="Sensors" /><Spinner /></>
  const rows = rowsOf(q.data)
  const now = Date.now()
  return (
    <>
      <PageHeader
        title="Sensors"
        subtitle="Every channel the kernel's hwmon interface exposes, with its source. Values are as of the last inventory scan; the Monitor page charts live temperature and fan series. Unlabelled channels have an unknown physical meaning and are not interpreted."
        actions={<button className="btn" onClick={q.reload}><RefreshCw size={14} /> Refresh</button>}
      />
      {rows.length === 0 ? (
        <Empty title="No sensors exposed">This machine's kernel exposes no hwmon channels (or the collector has not run). Nothing is estimated.</Empty>
      ) : (
        <section className="card" aria-label="Sensor registry">
          <table className="table">
            <thead><tr><th>Sensor chip</th><th>Channel</th><th>Kind</th><th>Value</th><th>Limits (driver-reported)</th><th>Label</th><th>Observed</th><th>Source</th></tr></thead>
            <tbody>
              {rows.map((r) => {
                const stale = now - Date.parse(r.p.observedAt) > STALE_MS
                const unlabelled = UNLABELLED.test(r.label)
                return (
                  <tr key={`${r.deviceId}:${r.p.key}`}>
                    <td><button className="link" onClick={() => navigate({ page: 'device', id: r.deviceId, from: { page: 'sensors' } })}>{r.chip}</button></td>
                    <td>{r.label}</td>
                    <td>{r.kind}</td>
                    <td className="mono">{formatValue(r.p.value, r.p.unit)}</td>
                    <td className="mono small">{[r.max && `max ${formatValue(r.max.value, r.max.unit)}`, r.crit && `crit ${formatValue(r.crit.value, r.crit.unit)}`].filter(Boolean).join(' · ') || <span className="muted">none reported</span>}</td>
                    <td>{unlabelled ? <Badge tone="warn" title="The driver provides no label for this channel">unlabelled</Badge> : <Badge tone="ok">labelled</Badge>}</td>
                    <td title={fullTime(r.p.observedAt)}>{timeAgo(r.p.observedAt)} {stale && <Badge tone="warn">stale</Badge>}</td>
                    <td className="mono small" title={`${r.p.source} · ${r.p.evidence.replace('_', ' ')}`}>{r.p.sourceProperty}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </section>
      )}
    </>
  )
}
