import { Database, FileDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Settings } from '@shared/schemas'
import { ErrorBox, PageHeader, Spinner } from '../components/ui'
import { useLoad } from '../hooks/useLoad'
import { api } from '../services/api'

function NumberField({ label, hint, value, min, max, onCommit }: { label: string; hint?: string; value: number; min: number; max: number; onCommit: (n: number) => Promise<void> }): JSX.Element {
  const [text, setText] = useState(String(value))
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => setText(String(value)), [value])
  const commit = async (): Promise<void> => {
    const n = Number(text)
    if (!Number.isInteger(n) || n < min || n > max) { setErr(`Enter a whole number from ${min} to ${max}`); return }
    setErr(null)
    if (n !== value) await onCommit(n)
  }
  return (
    <label className="field">
      <span>{label}{hint && <small className="muted"> {hint}</small>}</span>
      <input type="number" value={text} min={min} max={max} onChange={(e) => setText(e.target.value)} onBlur={() => void commit()} onKeyDown={(e) => e.key === 'Enter' && void commit()} aria-invalid={!!err} />
      {err && <small className="error">{err}</small>}
    </label>
  )
}

export function SettingsPage(): JSX.Element {
  const q = useLoad(() => Promise.all([api.getSettings(), api.appInfo()]), [], false)
  const [settings, setSettings] = useState<Settings>()
  const [msg, setMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => { if (q.data) setSettings(q.data[0]) }, [q.data])

  const set = async <K extends keyof Settings>(k: K, v: Settings[K]): Promise<void> => {
    try { setSettings(await api.setSetting(k, v)); setError(null) } catch (e) { setError((e as Error).message) }
  }

  if (q.error) return <><PageHeader title="Settings" /><ErrorBox message={q.error} onRetry={q.reload} /></>
  if (!q.data || !settings) return <><PageHeader title="Settings" /><Spinner /></>
  const info = q.data[1]

  const toggle = (k: keyof Settings & string, label: string, hint?: string): JSX.Element => (
    <label className="toggle">
      <input type="checkbox" checked={Boolean(settings[k as keyof Settings])} onChange={(e) => void set(k as never, e.target.checked as never)} />
      <span>{label}{hint && <small className="muted"> {hint}</small>}</span>
    </label>
  )

  return (
    <>
      <PageHeader title="Settings" />
      {error && <ErrorBox message={error} />}
      {msg && <div className="banner banner-info" role="status">{msg}</div>}
      <div className="stack">
        <section className="card">
          <h2>Appearance</h2>
          <label className="field"><span>Theme</span>
            <select value={settings.theme} onChange={(e) => void set('theme', e.target.value as Settings['theme'])}>
              <option value="system">Follow system</option><option value="dark">Dark</option><option value="light">Light</option>
            </select>
          </label>
        </section>

        <section className="card">
          <h2>Monitoring</h2>
          {toggle('liveMonitoring', 'Live hardware monitoring', '— react to plug/unplug events and rescan periodically')}
          <NumberField label="Safety rescan interval (seconds)" hint="catches missed events and refreshes live readings" value={settings.pollIntervalSec} min={10} max={3600} onCommit={(n) => set('pollIntervalSec', n)} />
        </section>

        <section className="card">
          <h2>Processes</h2>
          {toggle('processMonitoring', 'Process monitoring', '— show top processes by CPU and memory (names only; off by default because process lists are personal data)')}
        </section>

        <section className="card">
          <h2>Metrics</h2>
          {toggle('metricsEnabled', 'Sample live metrics', '— CPU, memory, network, disk I/O, battery, temperatures, fans')}
          <NumberField label="Sampling interval (seconds)" value={settings.metricsIntervalSec} min={1} max={60} onCommit={(n) => set('metricsIntervalSec', n)} />
          <NumberField label="Keep metric history for (hours)" value={settings.metricsRetentionHours} min={1} max={720} onCommit={(n) => set('metricsRetentionHours', n)} />
          <p className="muted small">Metrics are sampled from lightweight OS counters, independent of hardware rescans, and written in batches.</p>
        </section>

        <section className="card">
          <h2>Retention</h2>
          <NumberField label="Keep events for (days)" value={settings.eventRetentionDays} min={1} max={3650} onCommit={(n) => set('eventRetentionDays', n)} />
          <NumberField label="Maximum stored events" value={settings.maxEvents} min={100} max={1000000} onCommit={(n) => set('maxEvents', n)} />
          <p className="muted small">Older events are pruned when the application exits.</p>
        </section>

        <section className="card">
          <h2>Diagnostics thresholds</h2>
          <NumberField label="Disk usage warning (% used)" value={settings.diagDiskWarnPercent} min={50} max={99} onCommit={(n) => set('diagDiskWarnPercent', n)} />
          <NumberField label="Disk usage critical (% used)" value={settings.diagDiskCriticalPercent} min={51} max={100} onCommit={(n) => set('diagDiskCriticalPercent', n)} />
          <NumberField label="Temperature warning margin (°C below the sensor's own critical limit)" value={settings.diagTempMarginC} min={1} max={50} onCommit={(n) => set('diagTempMarginC', n)} />
          <NumberField label="Fallback temperature for sensors that report no limits (°C, 0 = off)" hint="there is no universal threshold" value={settings.diagTempFallbackC} min={0} max={150} onCommit={(n) => set('diagTempFallbackC', n)} />
          <NumberField label="Resource pressure warning (% of time tasks stalled, kernel PSI)" hint="CPU, memory and I/O rules" value={settings.diagPressureWarnPercent} min={1} max={95} onCommit={(n) => set('diagPressureWarnPercent', n)} />
          <NumberField label="…must persist for (minutes)" value={settings.diagPressureWindowMin} min={2} max={120} onCommit={(n) => set('diagPressureWindowMin', n)} />
          <NumberField label="Swap thrashing: sustained swap-in (pages/s)" value={settings.diagSwapInPagesPerSec} min={1} max={1000000} onCommit={(n) => set('diagSwapInPagesPerSec', n)} />
          <NumberField label="Thermal-throttle look-back (minutes)" value={settings.diagThrottleWindowMin} min={5} max={1440} onCommit={(n) => set('diagThrottleWindowMin', n)} />
          <NumberField label="Report missing devices seen within (hours)" value={settings.diagMissingWindowHours} min={1} max={8760} onCommit={(n) => set('diagMissingWindowHours', n)} />
          {toggle('diagNetworkDownEnabled', 'Report disconnected network interfaces', '— off by default; a disconnected interface is often normal')}
          <p className="muted small">Individual rules can be enabled or disabled on the Diagnostics page.</p>
        </section>

        <section className="card">
          <h2>Privacy & export</h2>
          <p className="muted small">Telemetry is not implemented and nothing leaves this computer. Exports omit these fields unless you enable them here.</p>
          {toggle('exportIncludeSerials', 'Include serial numbers and unique device identifiers')}
          {toggle('exportIncludeMacAddresses', 'Include MAC addresses')}
          {toggle('exportIncludeHostname', 'Include hostname')}
          {toggle('exportIncludeIpAddresses', 'Include IP addresses')}
          <div className="row">
            <button className="btn" onClick={async () => { const r = await api.exportInventory(); setMsg(r.saved ? `Exported ${r.devices} devices to ${r.path}` : null) }}><FileDown size={14} /> Export inventory (JSON)</button>
            <button className="btn" onClick={async () => { const r = await api.backupDatabase(); setMsg(r.saved ? `Database backed up to ${r.path}` : null) }}><Database size={14} /> Back up database</button>
          </div>
        </section>

        <section className="card">
          <h2>About</h2>
          <dl className="kv">
            <div><dt>Application</dt><dd>{info.version}</dd></div>
            <div><dt>Platform</dt><dd>{info.platform} / {info.arch}</dd></div>
            <div><dt>Electron / Node</dt><dd>{info.electron} / {info.node}</dd></div>
            <div><dt>Database schema</dt><dd>v{info.schemaVersion} ({info.migrations.length} migration{info.migrations.length === 1 ? '' : 's'} applied)</dd></div>
            <div><dt>Database file</dt><dd className="mono small">{info.databasePath}</dd></div>
          </dl>
          <details><summary>Applied migrations</summary>
            <ul className="plain">{info.migrations.map((m) => (<li key={m.version}><span>v{m.version} · {m.name}</span><span className="muted small">{new Date(m.appliedAt).toLocaleString()}</span></li>))}</ul>
          </details>
        </section>
      </div>
    </>
  )
}
