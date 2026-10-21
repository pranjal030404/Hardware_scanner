import { useEffect, useState } from 'react'
import type { ProcessRow, ProcessSnapshot } from '../../processes'
import { formatBytes, Badge, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { api } from '../services/api'

const REFRESH_MS = 3000

function Table({ title, rows, cpu }: { title: string; rows: ProcessRow[]; cpu: boolean }): JSX.Element {
  return (
    <section className="card" aria-label={title}>
      <h2>{title}</h2>
      {rows.length === 0 ? <p className="muted small">{cpu ? 'Waiting for a second sample.' : 'No data.'}</p> : (
        <table className="table">
          <thead><tr><th>PID</th><th>Name</th><th>State</th><th>Threads</th><th>CPU (of one core)</th><th>Memory (RSS)</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.pid}><td className="mono">{r.pid}</td><td>{r.name}</td><td>{r.state}</td><td>{r.threads ?? '—'}</td><td className="mono">{r.cpuPercent === null ? '—' : `${r.cpuPercent.toFixed(1)}%`}</td><td className="mono">{r.rssBytes === null ? '—' : formatBytes(r.rssBytes)}</td></tr>
          ))}</tbody>
        </table>
      )}
    </section>
  )
}

export function ProcessesPage(): JSX.Element {
  const [snap, setSnap] = useState<ProcessSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    const tick = (): void => { api.topProcesses(15).then((s) => { if (alive) { setSnap(s); setError(null) } }).catch((e: unknown) => { if (alive) setError(String(e)) }) }
    tick()
    const t = setInterval(tick, REFRESH_MS)
    return () => { alive = false; clearInterval(t) } // no polling once the page is left
  }, [])

  const enable = async (): Promise<void> => { setBusy(true); try { await api.setSetting('processMonitoring', true); setSnap(await api.topProcesses(15)) } catch (e) { setError(String(e)) } finally { setBusy(false) } }

  if (error && !snap) return <><PageHeader title="Processes" /><ErrorBox message={error} /></>
  if (!snap) return <><PageHeader title="Processes" /><Spinner /></>
  return (
    <>
      <PageHeader title="Processes" subtitle="Opt-in. Shows kernel process names, memory and CPU share only — never command lines, environment or users. Read from /proc every few seconds while this page is open." />
      {!snap.enabled ? (
        <Empty title={snap.supported ? 'Process monitoring is off' : 'Not available on this operating system'}>
          <p>{snap.note}</p>
          {snap.supported && <button className="btn" disabled={busy} onClick={() => void enable()}>Enable process monitoring</button>}
        </Empty>
      ) : (
        <div className="stack">
          <p className="muted small"><Badge tone="ok">live</Badge> {snap.totalProcesses} processes · sampled {snap.intervalMs ? `over ${(snap.intervalMs / 1000).toFixed(1)} s` : 'once'} {snap.note && <>· {snap.note}</>}</p>
          <Table title="Top by CPU" rows={snap.topCpu} cpu />
          <Table title="Top by memory" rows={snap.topMemory} cpu={false} />
        </div>
      )}
    </>
  )
}
