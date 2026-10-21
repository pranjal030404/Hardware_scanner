import { Pause, Play } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { HipEvent } from '@shared/schemas'
import type { Navigate } from '../App'
import { Badge, CategoryIcon, Empty, ErrorBox, fullTime, PageHeader, timeAgo } from '../components/ui'
import { useEvents } from '../hooks/useEvents'
import { useLoad } from '../hooks/useLoad'
import { api } from '../services/api'

const TONE: Record<string, 'ok' | 'bad' | 'warn' | 'info' | 'neutral'> = {
  'device.connected': 'ok', 'device.disconnected': 'warn', 'device.updated': 'info', 'device.status_changed': 'warn', 'collector.failed': 'bad'
}

export function EventsPage({ navigate }: { navigate: Navigate }): JSX.Element {
  const hist = useLoad(() => api.recentEvents(300), [])
  const { monitor, setMonitor } = useEvents()
  const [filter, setFilter] = useState<'all' | 'devices' | 'collectors'>('all')

  const events = useMemo(() => (hist.data ?? []).filter((e: HipEvent) => filter === 'all' || (filter === 'devices' ? e.type.startsWith('device.') : e.type.startsWith('collector.'))), [hist.data, filter])
  const paused = monitor?.mode === 'paused'

  return (
    <>
      <PageHeader
        title="Events"
        subtitle="Hardware changes and collector failures, newest first"
        actions={
          <button className="btn" onClick={async () => setMonitor(await api.setMonitorPaused(!paused))} aria-pressed={paused}>
            {paused ? <><Play size={14} /> Resume monitoring</> : <><Pause size={14} /> Pause monitoring</>}
          </button>
        }
      />
      <section className="card monitor-card" aria-label="Monitoring status">
        <dl className="kv inline-kv">
          <div><dt>Mode</dt><dd><Badge tone={paused ? 'muted' : monitor?.degraded ? 'warn' : 'ok'}>{monitor?.mode ?? '…'}</Badge></dd></div>
          <div><dt>Safety rescan</dt><dd>every {monitor?.intervalSec ?? '…'}s</dd></div>
          <div><dt>Last scan</dt><dd title={fullTime(monitor?.lastScanAt)}>{timeAgo(monitor?.lastScanAt)}</dd></div>
        </dl>
        {monitor?.message && <p className={monitor.degraded ? 'banner banner-warn' : 'muted'}>{monitor.message}</p>}
      </section>
      <div className="chips" role="group" aria-label="Event filter">
        {(['all', 'devices', 'collectors'] as const).map((f) => (<button key={f} className={`chip ${filter === f ? 'active' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f}</button>))}
      </div>
      {hist.error && <ErrorBox message={hist.error} onRetry={hist.reload} />}
      {hist.data && events.length === 0 && <Empty title="No events yet">Plug in or remove a USB device, connect a monitor, or change a network link — changes appear here without restarting the app.</Empty>}
      {events.length > 0 && (
        <ol className="timeline">
          {events.map((e, i) => (
            <li key={`${e.at}${i}`}>
              <time dateTime={e.at} title={fullTime(e.at)}>{timeAgo(e.at)}</time>
              <Badge tone={TONE[e.type] ?? 'neutral'}>{e.type.replace('device.', '').replace('collector.', 'collector ').replace('_', ' ')}</Badge>
              {e.category && <CategoryIcon category={e.category} size={14} />}
              {e.deviceId ? <button className="link" onClick={() => navigate({ page: 'device', id: e.deviceId!, from: { page: 'events' } })}>{e.summary}</button> : <span>{e.summary}</span>}
              {Array.isArray(e.data['changes']) && <span className="muted small">{(e.data['changes'] as string[]).join('; ')}</span>}
            </li>
          ))}
        </ol>
      )}
    </>
  )
}
