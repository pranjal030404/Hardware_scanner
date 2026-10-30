import { AlertTriangle, CheckCircle2, CircleSlash, Cpu, Gauge, History as HistoryIcon, Lock, MemoryStick, MonitorCog, Play, RotateCcw, Save, ShieldAlert, ShieldCheck, Square, Thermometer, Trash2, Undo2, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Settings } from '@shared/schemas'
import type { PerfApplyResult, PerfControl, PerfDevice, PerfLive, PerfState, PresetChange, ProfilePlan, Risk, TestMode, TestProgress, TestSession, TxRecord } from '../../performance/types'
import { Badge, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { useLoad } from '../hooks/useLoad'
import { SETTINGS_CHANGED } from '../nav'
import { api } from '../services/api'
import { CONTROL_STATUS, ITEM_STATUS, TX_STATUS, isNumeric, isToggle, needsReview, pendingChanges, toDisplay, toRaw } from './performance-logic'

type Tab = 'overview' | 'cpu' | 'gpu' | 'memory' | 'profiles' | 'testing' | 'history'
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' }, { id: 'cpu', label: 'Processor' }, { id: 'gpu', label: 'Graphics' }, { id: 'memory', label: 'Memory' },
  { id: 'profiles', label: 'Profiles' }, { id: 'testing', label: 'Benchmark & stability' }, { id: 'history', label: 'Change log' }
]
const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 }
const RISK_TONE: Record<Risk, 'muted' | 'warn' | 'bad'> = { low: 'muted', medium: 'warn', high: 'bad' }
const cleanError = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const time = (iso: string | null): string => (iso ? new Date(iso).toLocaleTimeString() : '—')
const stamp = (iso: string | null): string => (iso ? new Date(iso).toLocaleString() : '—')
const riskLabel = (r: Risk): string => `${r[0]!.toUpperCase()}${r.slice(1)} risk`
const maxRisk = (cs: PresetChange[]): Risk => cs.reduce<Risk>((r, c) => (RISK_RANK[c.risk] > RISK_RANK[r] ? c.risk : r), 'low')

// ---- header status --------------------------------------------------------------------------------

function StatusStrip({ s }: { s: PerfState }): JSX.Element {
  const active = s.profiles.find((p) => p.id === s.matches)
  const last = s.lastTransaction
  const items: { label: string; value: string; tone: 'ok' | 'warn' | 'bad' | 'muted' | 'info'; icon: JSX.Element; detail?: string }[] = [
    s.monitoringOnly || !s.tuningEnabled
      ? { label: 'Operating mode', value: 'Monitoring only', tone: 'muted', icon: <Gauge size={16} aria-hidden />, detail: s.tuningEnabled ? 'No writable controls available' : 'Tuning controls disabled' }
      : { label: 'Operating mode', value: 'Tuning enabled', tone: 'ok', icon: <MonitorCog size={16} aria-hidden />, detail: 'Changes require review' },
    s.helper.usable
      ? { label: 'Privileged helper', value: 'Installed and verified', tone: 'ok', icon: <ShieldCheck size={16} aria-hidden /> }
      : { label: 'Privileged helper', value: 'Not available', tone: 'warn', icon: <ShieldAlert size={16} aria-hidden />, detail: 'Controls are read-only' },
    { label: 'Active profile', value: active?.title ?? 'Custom configuration', tone: active ? 'info' : 'muted', icon: <Zap size={16} aria-hidden />, detail: active ? 'All settings match' : 'No built-in profile matches fully' },
    last
      ? { label: 'Last change', value: TX_STATUS[last.status].label, tone: TX_STATUS[last.status].tone === 'ok' ? 'ok' : TX_STATUS[last.status].tone === 'bad' ? 'bad' : 'warn', icon: <HistoryIcon size={16} aria-hidden />, detail: `${last.label} · ${stamp(last.startedAt)}` }
      : { label: 'Last change', value: 'None recorded', tone: 'muted', icon: <HistoryIcon size={16} aria-hidden />, detail: 'No changes made on this hardware' }
  ]
  return (
    <div className="pt-status" role="region" aria-label="Tuning status">
      {items.map((i) => (
        <div key={i.label} className={`pt-status-item tone-${i.tone}`}>
          <span className="pt-status-icon">{i.icon}</span>
          <div><div className="pt-label">{i.label}</div><div className="pt-status-value">{i.value}</div>{i.detail && <div className="pt-detail">{i.detail}</div>}</div>
        </div>
      ))}
    </div>
  )
}

// ---- live measurement tiles -------------------------------------------------------------------------

function Meter({ value, max, tone }: { value: number; max: number; tone: 'ok' | 'warn' | 'bad' | 'info' }): JSX.Element {
  const pct = Math.max(0, Math.min(100, (value / max) * 100))
  return <div className="pt-meter" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}><div className={`pt-meter-fill fill-${tone}`} style={{ width: `${pct}%` }} /></div>
}

function KpiTiles(): JSX.Element {
  const [live, setLive] = useState<PerfLive | null>(null)
  useEffect(() => {
    let alive = true
    const tick = (): void => void api.performanceLive().then((l) => alive && setLive(l), () => undefined)
    tick()
    const h = setInterval(tick, 1500)
    return () => { alive = false; clearInterval(h) }
  }, [])
  if (!live) return <Spinner />
  const t = live.temperatureC
  const lim = live.temperatureLimitC
  const tempState = t === null || lim === null ? null : t >= lim - 5 ? { tone: 'bad' as const, text: 'At device limit', icon: <AlertTriangle size={13} aria-hidden /> } : t >= lim - 15 ? { tone: 'warn' as const, text: 'Elevated', icon: <AlertTriangle size={13} aria-hidden /> } : { tone: 'ok' as const, text: 'Normal', icon: <CheckCircle2 size={13} aria-hidden /> }
  const tile = (label: string, icon: JSX.Element, value: string | null, unit: string, sub: string | null, source: string, meter?: JSX.Element, state?: JSX.Element): JSX.Element => (
    <div className="pt-kpi">
      <div className="pt-label">{icon} {label}</div>
      <div className="pt-kpi-value">{value ?? <span className="muted">—</span>}{value !== null && <span className="pt-unit">{unit}</span>}</div>
      {meter}
      <div className="pt-detail">{state}{sub}</div>
      <div className="pt-source mono" title={source}>{source}</div>
    </div>
  )
  return (
    <>
      <div className="pt-kpis">
        {tile('Processor clock', <Cpu size={13} aria-hidden />, live.cpuMHz === null ? null : String(live.cpuMHz), 'MHz', live.cpuMaxMHz ? `of ${live.cpuMaxMHz} MHz maximum (observed)` : 'observed', live.sources.cpuMHz ?? '', live.cpuMHz !== null && live.cpuMaxMHz ? <Meter value={live.cpuMHz} max={live.cpuMaxMHz} tone="info" /> : undefined)}
        {tile('Processor load', <Gauge size={13} aria-hidden />, live.cpuUtilization === null ? null : String(live.cpuUtilization), '%', live.cpuUtilization === null ? 'measuring…' : 'all cores', live.sources.cpuUtilization ?? '', live.cpuUtilization !== null ? <Meter value={live.cpuUtilization} max={100} tone="info" /> : undefined)}
        {tile('Processor temperature', <Thermometer size={13} aria-hidden />, t === null ? null : t.toFixed(0), '°C', lim ? ` · device limit ${lim.toFixed(0)} °C` : ' · no limit reported', live.sources.temperature ?? '', t !== null && lim ? <Meter value={t} max={lim} tone={tempState?.tone ?? 'info'} /> : undefined, tempState ? <span className={`pt-state tone-${tempState.tone}`}>{tempState.icon} {tempState.text}</span> : undefined)}
        {tile('Thermal throttling', <AlertTriangle size={13} aria-hidden />, live.throttleEvents === null ? null : String(live.throttleEvents), 'events', 'since boot', live.sources.throttleEvents ?? '')}
        {live.gpuMHz !== null && tile('Graphics clock', <MonitorCog size={13} aria-hidden />, live.gpuMHz === 0 ? 'Idle' : String(live.gpuMHz), live.gpuMHz === 0 ? '' : 'MHz', live.gpuMaxMHz ? `of ${live.gpuMaxMHz} MHz maximum (observed)` : 'observed', live.sources.gpuMHz ?? '', live.gpuMaxMHz ? <Meter value={live.gpuMHz} max={live.gpuMaxMHz} tone="info" /> : undefined)}
      </div>
      <p className="pt-footnote">Observed values, sampled {time(live.at)} and refreshed every 1.5 seconds.</p>
    </>
  )
}

// ---- transaction result ------------------------------------------------------------------------

function TxResult({ tx }: { tx: TxRecord }): JSX.Element {
  const st = TX_STATUS[tx.status]
  return (
    <div className={`tx-result tone-${st.tone}`}>
      <div className="tx-head"><strong>{tx.label}</strong><Badge tone={st.tone}>{st.label}</Badge><span className="pt-detail">{stamp(tx.startedAt)}</span></div>
      {tx.error && <p className="small">{tx.error}</p>}
      <table className="table compact tx-items">
        <thead><tr><th>Setting</th><th>Previous</th><th>Requested</th><th>Read back</th><th>Verification</th></tr></thead>
        <tbody>{tx.items.map((i) => (
          <tr key={i.controlId}><td>{i.label}</td><td className="muted num">{i.previous ?? 'unknown'}</td><td className="num">{i.requested}</td><td className="num">{i.effective ?? <span className="muted">—</span>}</td>
            <td><Badge tone={ITEM_STATUS[i.verification].tone}>{ITEM_STATUS[i.verification].label}</Badge>{i.message && <div className="pt-detail">{i.message}</div>}</td></tr>
        ))}</tbody>
      </table>
    </div>
  )
}

/** The exact list of changes, shown before anything is applied; high-risk changes need an explicit acknowledgement. */
function Review({ title, changes, skipped, busy, onApply, onCancel }: { title: string; changes: PresetChange[]; skipped?: string[]; busy: boolean; onApply: () => void; onCancel: () => void }): JSX.Element {
  const risk = maxRisk(changes)
  const [ack, setAck] = useState(false)
  return (
    <section className="review" role="dialog" aria-label={`Review changes: ${title}`}>
      <div className="review-head"><h3>Review changes</h3><span className="pt-detail">{title}</span><Badge tone={RISK_TONE[risk]}>{riskLabel(risk)}</Badge></div>
      <table className="table compact">
        <thead><tr><th>Setting</th><th>Current</th><th>New value</th><th>Risk</th></tr></thead>
        <tbody>{changes.map((c) => (
          <tr key={c.id}><td>{c.label}{c.note && <div className="pt-detail">{c.note}</div>}</td><td className="muted num">{c.from}</td><td className="num"><strong>{c.to}</strong></td>
            <td><Badge tone={RISK_TONE[c.risk]}>{riskLabel(c.risk)}</Badge></td></tr>
        ))}</tbody>
      </table>
      {skipped && skipped.length > 0 && <details><summary className="pt-detail">Not applicable on this hardware ({skipped.length})</summary><ul className="pt-list">{skipped.map((x) => <li key={x}>{x}</li>)}</ul></details>}
      <p className="pt-footnote">All values are run-time settings and revert to their defaults on restart, except a tuned profile, which persists until changed. Each setting is read back from the kernel after it is applied and recorded in the change log.</p>
      {risk === 'high' && (
        <label className="toggle risk-ack"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>I understand that these settings operate the hardware beyond its stock configuration, increasing heat and the possibility of instability.</span></label>
      )}
      <div className="row">
        <button className="btn btn-primary" disabled={busy || (risk === 'high' && !ack)} onClick={onApply}>Apply {changes.length} change{changes.length === 1 ? '' : 's'}</button>
        <button className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </section>
  )
}

// ---- component editors --------------------------------------------------------------------------

function ControlInput({ c, value, onChange }: { c: PerfControl; value: string; onChange: (raw: string) => void }): JSX.Element {
  if (isToggle(c)) return <label className="toggle inline"><input type="checkbox" checked={value === '1'} onChange={(e) => onChange(e.target.checked ? '1' : '0')} /><span>{value === '1' ? 'Enabled' : 'Disabled'}</span></label>
  if (c.options) return <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={c.label}>{c.options.map((o) => <option key={o} value={o}>{o}</option>)}</select>
  if (isNumeric(c)) {
    const shown = toDisplay(c, value)
    const step = (c.step ?? 1) / (c.scale ?? 1)
    return (
      <span className="knob-inputs">
        {/* A slider only because the backend reported both ends of the range and the step. */}
        <input type="range" min={toDisplay(c, String(c.min))} max={toDisplay(c, String(c.max))} step={step} value={shown} onChange={(e) => { const r = toRaw(c, e.target.value); if (r) onChange(r) }} aria-label={`${c.label} slider`} />
        <input type="number" min={toDisplay(c, String(c.min))} max={toDisplay(c, String(c.max))} step={step} value={shown} onChange={(e) => { const r = toRaw(c, e.target.value); if (r) onChange(r) }} aria-label={`${c.label} (${c.unit})`} />
        <span className="pt-unit">{c.unit}</span>
        <button type="button" className="btn btn-sm" onClick={() => onChange(String(c.max))} title={`Set to the upper limit: ${c.rangeSource ?? ''}`}>Upper limit</button>
      </span>
    )
  }
  return <span className="mono">{value}</span>
}

function DeviceEditor({ device, state, onReview }: { device: PerfDevice; state: PerfState; onReview: (title: string, changes: PresetChange[]) => void }): JSX.Element {
  const [edits, setEdits] = useState<Record<string, string>>({})
  useEffect(() => setEdits({}), [state])
  const editable = device.controls.filter((c) => c.status !== 'unsupported' && c.status !== 'unavailable' && c.read)
  const fixed = device.controls.filter((c) => !editable.includes(c))
  const changes = pendingChanges(device.controls, edits)
  const canEdit = state.tuningEnabled && state.helper.usable && state.busy === null
  return (
    <section className="card pt-section">
      <header className="pt-section-head">
        <div><h2>{device.label}</h2><p className="pt-detail">{device.summary}</p></div>
        {device.monitoringOnly ? <Badge tone="muted">Monitoring only</Badge> : <Badge tone="info">Tunable</Badge>}
      </header>
      {device.settings.length > 0 && (
        <table className="table compact pt-spec">
          <thead><tr><th>Specification</th><th>Current</th><th>Supported by this device</th><th>Highest-performance value</th></tr></thead>
          <tbody>{device.settings.map((x) => <tr key={x.label}><td>{x.label}</td><td className="num">{x.current}</td><td>{x.allowed}</td><td>{x.best}</td></tr>)}</tbody>
        </table>
      )}
      {editable.length > 0 && (
        <>
          <h3 className="pt-subhead">Controls</h3>
          {editable.some((c) => c.status === 'permission_required') && <p className="pt-detail">{state.tuningEnabled ? 'Read-only until the optional privileged helper is installed. ' : 'Read-only while tuning controls are disabled. '}{state.helper.reason}</p>}
          <table className="table compact pt-controls">
            <thead><tr><th>Control</th><th>Status</th><th>Current</th><th>{canEdit ? 'New value' : 'Range'}</th></tr></thead>
            <tbody>{editable.map((c) => (
              <tr key={c.id}>
                <td><strong>{c.label}</strong>{c.persistence === 'persistent' && <> <Badge tone="warn">persists across restart</Badge></>}<div className="pt-source mono" title={c.source}>{c.source}</div></td>
                <td><Badge tone={CONTROL_STATUS[c.status].tone}>{CONTROL_STATUS[c.status].label}</Badge></td>
                <td className="num">{c.current ?? '—'}</td>
                <td>{c.write && canEdit ? <ControlInput c={c} value={edits[c.id] ?? c.currentRaw ?? ''} onChange={(v) => setEdits((e) => ({ ...e, [c.id]: v }))} />
                  : <span className="pt-detail">{c.rangeSource ? `${toDisplay(c, String(c.min))}–${toDisplay(c, String(c.max))} ${c.unit}` : isToggle(c) ? 'Enabled / Disabled' : c.options?.join(', ') ?? '—'}</span>}
                  {c.rangeSource && <div className="pt-detail">Limit source: {c.rangeSource}</div>}</td>
              </tr>
            ))}</tbody>
          </table>
          {canEdit && (
            <div className="row">
              <button className="btn btn-primary" disabled={!changes.length} onClick={() => onReview(`${device.label}: manual settings`, changes)}>Review {changes.length ? `${changes.length} ` : ''}change{changes.length === 1 ? '' : 's'}</button>
              <button className="btn" disabled={!Object.keys(edits).length} onClick={() => setEdits({})}>Discard</button>
            </div>
          )}
        </>
      )}
      {fixed.length > 0 && (
        <>
          <h3 className="pt-subhead">Not adjustable</h3>
          <table className="table compact">
            <tbody>{fixed.map((c) => <tr key={c.id}><td className="pt-fixed-name"><Lock size={12} aria-hidden /> {c.label}</td><td><Badge tone="muted">{CONTROL_STATUS[c.status].label}</Badge></td><td className="pt-detail">{c.reason}</td></tr>)}</tbody>
          </table>
        </>
      )}
    </section>
  )
}

// ---- profiles -----------------------------------------------------------------------------------

function ProfileCard({ p, active, onReview, onDelete, disabled }: { p: ProfilePlan; active: boolean; onReview: () => void; onDelete?: () => void; disabled: boolean }): JSX.Element {
  const risk = maxRisk(p.changes)
  return (
    <article className={`pt-profile ${active ? 'active' : ''} ${p.compatible ? '' : 'incompatible'} ${p.id === 'maximum' ? 'is-maximum' : ''}`}>
      <header>
        <h3>{p.title}</h3>
        <div className="pt-profile-tags">
          {active && <Badge tone="ok">Active</Badge>}
          {!p.builtin && <Badge tone="neutral">Saved</Badge>}
          {!p.compatible && <Badge tone="muted">Different hardware</Badge>}
          {p.changes.length > 0 && <Badge tone={RISK_TONE[risk]}>{riskLabel(risk)}</Badge>}
        </div>
      </header>
      <p className="small">{p.summary}</p>
      <dl className="pt-profile-counts">
        <div><dt>Changes</dt><dd>{p.changes.length}</dd></div>
        <div><dt>Already set</dt><dd>{p.unchanged.length}</dd></div>
        <div><dt>Not applicable</dt><dd>{p.skipped.length}</dd></div>
      </dl>
      {p.changes.length > 0 && (
        <details><summary className="pt-detail">Changes on this hardware</summary>
          <ul className="preset-changes">{p.changes.map((c) => <li key={c.id}><span className="small">{c.label}{c.note && <span className="muted"> · {c.note}</span>}</span><span className="num"><span className="muted">{c.from}</span> → <strong>{c.to}</strong></span></li>)}</ul>
        </details>
      )}
      {p.skipped.length > 0 && <details><summary className="pt-detail">Not applicable ({p.skipped.length})</summary><ul className="pt-list">{p.skipped.map((x) => <li key={x}>{x}</li>)}</ul></details>}
      <footer className="row">
        <button className="btn" disabled={disabled || !p.compatible || !p.changes.length} onClick={onReview}>{p.changes.length ? 'Review changes' : 'No changes required'}</button>
        {onDelete && <button className="btn btn-ghost" onClick={onDelete} aria-label={`Delete profile ${p.title}`}><Trash2 size={14} /></button>}
      </footer>
    </article>
  )
}

// ---- benchmark & stability ------------------------------------------------------------------------

function TestSummaryView({ t }: { t: TestSession }): JSX.Element {
  const s = t.summary
  return (
    <div className="test-summary">
      <dl className="kv">
        {s.score !== null && <div><dt>Score</dt><dd className="num">{s.score} MB/s (SHA-256, {t.threads} threads)</dd></div>}
        <div><dt>Processor clock</dt><dd className="num">{s.avgMHz ?? '—'} MHz average · {s.maxMHz ?? '—'} MHz peak</dd></div>
        <div><dt>Temperature</dt><dd className="num">{s.maxTemperatureC?.toFixed(0) ?? '—'} °C peak{s.temperatureLimitC ? ` · device limit ${s.temperatureLimitC.toFixed(0)} °C` : ''}</dd></div>
        <div><dt>Thermal throttling</dt><dd className="num">{s.throttleEvents ?? 'not measured'}</dd></div>
        {s.sustainedChangePct !== null && <div><dt>Sustained throughput</dt><dd className="num">{s.sustainedChangePct} % (start to end)</dd></div>}
      </dl>
      {t.error && <p className="small error">{t.error}</p>}
      <ul className="pt-list">{s.notes.map((n) => <li key={n}>{n}</li>)}</ul>
    </div>
  )
}

function TestingTab({ settings, state }: { settings: Settings; state: PerfState }): JSX.Element {
  const [mode, setMode] = useState<TestMode>('benchmark')
  const [seconds, setSeconds] = useState(Math.min(60, settings.perfTestMaxSec))
  const [interval, setIntervalMs] = useState(Math.max(1000, settings.perfTestMinIntervalMs))
  const [progress, setProgress] = useState<TestProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const history = useLoad(() => api.performanceTests(20), [progress?.session.status], false)
  const running = progress?.session.status === 'running'
  useEffect(() => { void api.pollPerformanceTest().then(setProgress, () => undefined) }, [])
  useEffect(() => {
    if (!running) return
    const h = setInterval(() => void api.pollPerformanceTest().then(setProgress, (e) => setError(cleanError(e))), 1000)
    return () => clearInterval(h)
  }, [running])
  const start = async (): Promise<void> => {
    setError(null)
    try { setProgress(await api.startPerformanceTest(mode, seconds, interval)) } catch (e) { setError(cleanError(e)) }
  }
  const benches = (history.data ?? []).filter((t) => t.mode === 'benchmark' && t.status === 'completed' && t.fingerprint === state.fingerprint)
  const [latest, previous] = benches
  const last = progress?.samples.at(-1)
  const pct = progress ? Math.min(100, (progress.elapsedMs / 1000 / progress.session.durationS) * 100) : 0
  return (
    <div className="stack">
      <section className="card pt-section">
        <header className="pt-section-head"><div><h2>Run a session</h2><p className="pt-detail">Benchmark: a built-in, repeatable processor workload (SHA-256 on every logical processor) with clock, temperature, load and throttling sampled throughout. Monitoring: the same measurements without added load. Neither establishes stability; instability can take hours or different workloads to appear.</p></div></header>
        <div className="row test-form">
          <label className="field inline-field"><span>Type</span><select value={mode} disabled={running} onChange={(e) => setMode(e.target.value as TestMode)}><option value="benchmark">Benchmark (processor load)</option><option value="monitor">Monitoring only</option></select></label>
          <label className="field inline-field"><span>Duration (s)</span><input type="number" min={10} max={settings.perfTestMaxSec} value={seconds} disabled={running} onChange={(e) => setSeconds(Math.max(10, Math.min(settings.perfTestMaxSec, Number(e.target.value) || 10)))} /></label>
          <label className="field inline-field"><span>Sampling interval (ms)</span><input type="number" min={settings.perfTestMinIntervalMs} max={10000} step={250} value={interval} disabled={running} onChange={(e) => setIntervalMs(Math.max(settings.perfTestMinIntervalMs, Math.min(10000, Number(e.target.value) || 1000)))} /></label>
          {running ? <button className="btn" onClick={() => void api.cancelPerformanceTest().then(setProgress)}><Square size={14} /> Stop</button>
            : <button className="btn btn-primary" disabled={state.busy !== null} onClick={() => void start()}><Play size={14} /> Start</button>}
        </div>
        <p className="pt-footnote">Limits (Settings): up to {settings.perfTestMaxSec} s; sampling no more often than every {settings.perfTestMinIntervalMs} ms. Sessions and configuration changes never run at the same time.</p>
        {error && <div className="banner banner-bad" role="alert">{error}</div>}
        {progress && (
          <div className="test-progress" role="status" aria-live="polite">
            <div className="tx-head"><strong>{progress.session.mode === 'benchmark' ? 'Benchmark' : 'Monitoring'} session</strong><Badge tone={progress.session.status === 'completed' ? 'ok' : progress.session.status === 'failed' ? 'bad' : 'info'}>{progress.session.status}</Badge><span className="pt-detail num">{Math.round(progress.elapsedMs / 1000)} / {progress.session.durationS} s · {progress.samples.length} samples</span></div>
            {running && <Meter value={pct} max={100} tone="info" />}
            {last && <div className="pt-detail num">Processor {last.cpuMHz ?? '—'} MHz · {last.temperatureC?.toFixed(0) ?? '—'} °C · load {last.utilization ?? '—'} %{last.throughput !== null ? ` · ${last.throughput} MB/s` : ''}</div>}
            {progress.session.status !== 'running' && <TestSummaryView t={progress.session} />}
          </div>
        )}
      </section>
      {latest && previous && (
        <section className="card pt-section">
          <header className="pt-section-head"><div><h2>Comparison</h2><p className="pt-detail">The two most recent completed benchmarks on this hardware. The score applies to this workload only.</p></div></header>
          <table className="table compact">
            <thead><tr><th>Metric</th><th>{stamp(previous.startedAt)}</th><th>{stamp(latest.startedAt)}</th></tr></thead>
            <tbody>
              <tr><td>Profile in effect</td><td>{previous.profile ?? 'Custom'}</td><td>{latest.profile ?? 'Custom'}</td></tr>
              <tr><td>Score (MB/s)</td><td className="num">{previous.summary.score ?? '—'}</td><td className="num">{latest.summary.score ?? '—'}{latest.summary.score && previous.summary.score ? ` (${Math.round(((latest.summary.score - previous.summary.score) / previous.summary.score) * 100)} %)` : ''}</td></tr>
              <tr><td>Average processor clock</td><td className="num">{previous.summary.avgMHz ?? '—'} MHz</td><td className="num">{latest.summary.avgMHz ?? '—'} MHz</td></tr>
              <tr><td>Peak temperature</td><td className="num">{previous.summary.maxTemperatureC?.toFixed(0) ?? '—'} °C</td><td className="num">{latest.summary.maxTemperatureC?.toFixed(0) ?? '—'} °C</td></tr>
              <tr><td>Throttle events</td><td className="num">{previous.summary.throttleEvents ?? '—'}</td><td className="num">{latest.summary.throttleEvents ?? '—'}</td></tr>
              <tr><td>Sustained throughput</td><td className="num">{previous.summary.sustainedChangePct ?? '—'} %</td><td className="num">{latest.summary.sustainedChangePct ?? '—'} %</td></tr>
            </tbody>
          </table>
        </section>
      )}
      <section className="card pt-section">
        <header className="pt-section-head"><div><h2>Session history</h2></div></header>
        {!history.data ? <Spinner /> : !history.data.length ? <p className="pt-detail">No sessions recorded.</p> : (
          <table className="table compact">
            <thead><tr><th>Started</th><th>Type</th><th>Status</th><th>Score</th><th>Avg clock</th><th>Peak temp.</th><th>Throttles</th><th>Profile</th></tr></thead>
            <tbody>{history.data.map((t) => (
              <tr key={t.id}><td>{stamp(t.startedAt)}</td><td>{t.mode}</td><td><Badge tone={t.status === 'completed' ? 'ok' : t.status === 'failed' ? 'bad' : 'muted'}>{t.status}</Badge></td>
                <td className="num">{t.summary.score ?? '—'}</td><td className="num">{t.summary.avgMHz ?? '—'}</td><td className="num">{t.summary.maxTemperatureC?.toFixed(0) ?? '—'}</td><td className="num">{t.summary.throttleEvents ?? '—'}</td><td>{t.profile ?? '—'}</td></tr>
            ))}</tbody>
          </table>
        )}
      </section>
    </div>
  )
}

// ---- page ---------------------------------------------------------------------------------------

export function PerformancePage(): JSX.Element {
  const q = useLoad(() => Promise.all([api.performanceState(), api.getSettings()]), [], false)
  const [tab, setTab] = useState<Tab>('overview')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PerfApplyResult | null>(null)
  const [review, setReview] = useState<{ title: string; changes: PresetChange[]; skipped?: string[]; run: () => Promise<PerfApplyResult> } | null>(null)
  const [profileName, setProfileName] = useState('')
  const history = useLoad(() => api.performanceHistory(50), [result], false)

  const run = async (label: string, f: () => Promise<PerfApplyResult>): Promise<void> => {
    setBusy(label); setError(null); setResult(null); setReview(null)
    try { setResult(await f()); q.reload() } catch (e) { setError(cleanError(e)) } finally { setBusy(null) }
  }
  const settings = q.data?.[1]
  const ask = (title: string, changes: PresetChange[], f: () => Promise<PerfApplyResult>, skipped?: string[]): void => {
    if (settings && !needsReview(changes, settings.perfConfirmChanges)) void run(title, f)
    else setReview({ title, changes, skipped, run: f })
  }
  const enableTuning = async (): Promise<void> => {
    await api.setSetting('perfTuningEnabled', true)
    window.dispatchEvent(new Event(SETTINGS_CHANGED))
    q.reload()
  }

  const s = q.data?.[0]
  const pick = (kinds: PerfDevice['kind'][]): PerfDevice[] => s?.devices.filter((d) => kinds.includes(d.kind)) ?? []
  const cpuDevices = useMemo(() => pick(['cpu', 'power', 'system']), [s]) // eslint-disable-line react-hooks/exhaustive-deps
  const gpuDevices = useMemo(() => pick(['igpu', 'amdgpu', 'nvidia']), [s]) // eslint-disable-line react-hooks/exhaustive-deps
  const memDevices = useMemo(() => pick(['memory']), [s]) // eslint-disable-line react-hooks/exhaustive-deps

  const title = 'Performance tuning'
  if (q.error) return <><PageHeader title={title} /><ErrorBox message={q.error} onRetry={q.reload} /></>
  if (!s || !settings) return <><PageHeader title={title} /><Spinner /></>
  if (!s.supported) return <><PageHeader title={title} /><ErrorBox message={s.reason ?? 'Not supported'} /></>
  const blocked = !s.tuningEnabled || !s.helper.usable || s.busy !== null || busy !== null
  const applyValues = (t: string, changes: PresetChange[]): void => ask(t, changes, () => api.applyPerformanceValues(t, changes.map((c) => ({ id: c.id, value: c.raw }))))
  const editors = (list: PerfDevice[], empty: string): JSX.Element => (list.length ? <>{list.map((d) => <DeviceEditor key={d.id} device={d} state={s} onReview={applyValues} />)}</> : <section className="card pt-section"><p className="pt-detail">{empty}</p></section>)

  return (
    <>
      <PageHeader title={title} subtitle="Capability discovery, live measurement and verified configuration of processor, graphics and memory performance. Every change is reviewed before it is applied, read back from the hardware, and can be reverted." />
      <div className="stack wide pt-page">
        <StatusStrip s={s} />
        {s.monitoringOnly && s.reason && <div className="banner banner-info" role="note">{s.reason}</div>}
        {s.platform === 'linux' && !s.tuningEnabled && (
          <div className="banner banner-info pt-banner" role="note">
            <span><strong>Monitoring mode.</strong> Tuning controls are disabled; no hardware setting will be modified. They can be enabled here or under Settings → Features &amp; controls.</span>
            <button className="btn btn-sm" onClick={() => void enableTuning()}>Enable tuning controls</button>
          </div>
        )}
        {s.platform === 'linux' && s.tuningEnabled && !s.helper.usable && (
          <div className="banner banner-warn pt-banner" role="note"><span><strong>Privileged helper not available.</strong> {s.helper.reason}</span></div>
        )}
        {(busy || s.busy) && <div className="banner banner-info" role="status">{busy ? `${busy}: confirm the request in the system authentication dialog if prompted.` : s.busy === 'testing' ? 'A benchmark session is running; configuration changes are paused until it ends.' : 'A configuration change is in progress.'}</div>}
        {error && <div className="banner banner-bad" role="alert">{error}</div>}
        {result?.transaction && <TxResult tx={result.transaction} />}
        {result && !result.transaction && <div className="banner banner-info" role="status">No changes were required.</div>}
        {review && <Review title={review.title} changes={review.changes} skipped={review.skipped} busy={busy !== null} onApply={() => void run(review.title, review.run)} onCancel={() => setReview(null)} />}

        <nav className="pt-tabs" role="tablist" aria-label="Performance tuning sections">
          {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={`pt-tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>)}
        </nav>

        {tab === 'overview' && (
          <>
            <section className="card pt-section">
              <header className="pt-section-head"><div><h2>Current operating state</h2><p className="pt-detail">Measured directly from the hardware. Each value names its source.</p></div></header>
              <KpiTiles />
            </section>
            <section className="card pt-section">
              <header className="pt-section-head"><div><h2>Measurements</h2><p className="pt-detail">Readings this computer does not expose are listed as not measured; no value is estimated or substituted.</p></div></header>
              <table className="table compact">
                <thead><tr><th>Reading</th><th>Value</th><th>Status</th><th>Source</th><th>Recorded</th></tr></thead>
                <tbody>{s.telemetry.map((m) => (
                  <tr key={m.label + m.source}><td>{m.label}</td><td className="num">{m.value ?? <span className="muted">—</span>}</td>
                    <td>{m.state === 'live' ? <span className="pt-state tone-ok"><CheckCircle2 size={13} aria-hidden /> Measured</span> : m.state === 'stale' ? <span className="pt-state tone-warn"><AlertTriangle size={13} aria-hidden /> Stale</span> : <span className="pt-state tone-muted"><CircleSlash size={13} aria-hidden /> Not measured</span>}
                      {m.reason && <div className="pt-detail">{m.reason}</div>}</td>
                    <td className="mono pt-source-cell">{m.source}</td><td className="num">{time(m.at)}</td></tr>
                ))}</tbody>
              </table>
            </section>
            <section className="card pt-section">
              <header className="pt-section-head"><div><h2>Capability matrix</h2><p className="pt-detail">Write access requires both a kernel interface that accepts writes and the installed privileged helper. A control is shown as verified once a change to it has been read back successfully on this hardware.</p></div></header>
              <table className="table compact pt-matrix">
                <thead><tr><th>Component</th><th>Control</th><th>Read</th><th>Write</th><th>Status</th><th>Range or options</th><th>Persistence</th></tr></thead>
                <tbody>{s.devices.flatMap((d) => d.controls.map((c, i) => (
                  <tr key={c.id} className={i === 0 ? 'pt-group-start' : ''}>
                    <td>{i === 0 ? d.label : ''}</td><td title={c.reason ?? c.source}>{c.label}</td>
                    <td>{c.read ? <CheckCircle2 size={14} className="tone-ok" aria-label="yes" /> : <CircleSlash size={14} className="tone-muted" aria-label="no" />}</td>
                    <td>{c.write ? <CheckCircle2 size={14} className="tone-ok" aria-label="yes" /> : <CircleSlash size={14} className="tone-muted" aria-label="no" />}</td>
                    <td><Badge tone={CONTROL_STATUS[c.status].tone}>{CONTROL_STATUS[c.status].label}</Badge></td>
                    <td className="num">{c.rangeSource ? `${toDisplay(c, String(c.min))}–${toDisplay(c, String(c.max))} ${c.unit}` : c.options ? `${c.options.length} options` : '—'}</td>
                    <td>{c.read || c.write ? (c.persistence === 'persistent' ? 'Persists' : 'Until restart') : '—'}</td>
                  </tr>
                )))}</tbody>
              </table>
            </section>
            <section className="card pt-section">
              <header className="pt-section-head"><div><h2>Most recent change</h2></div></header>
              {s.lastTransaction ? <TxResult tx={s.lastTransaction} /> : <p className="pt-detail">No change has been made on this hardware by this application.</p>}
            </section>
          </>
        )}

        {tab === 'cpu' && (
          <>
            <div className="banner banner-info" role="note"><span>Processor clock controls set <strong>operating-system policy limits</strong> within the range the processor reports. They cannot raise its physical maximum clock; the observed clock is shown in the Overview.</span></div>
            {editors(cpuDevices, 'No processor performance interface was found.')}
          </>
        )}
        {tab === 'gpu' && editors(gpuDevices, 'No graphics processor with a supported monitoring or control interface was found.')}
        {tab === 'memory' && (
          <>
            <div className="banner banner-info" role="note"><span><MemoryStick size={14} aria-hidden /> Memory speed and timings are configured by the system firmware at start-up (XMP or EXPO profiles in the BIOS/UEFI setup). The operating system provides no interface to change them while running; this section reports them only.</span></div>
            {editors(memDevices, 'Memory information is not available.')}
          </>
        )}

        {tab === 'profiles' && (
          <>
            <section className="card pt-section">
              <header className="pt-section-head"><div><h2>Profiles</h2><p className="pt-detail">Built-in profiles are calculated from the values this hardware reports. <strong>Maximum (hardware limits)</strong> sets every writable control to the upper limit the hardware reports; it does not exceed or invent limits. Saved profiles apply only to the hardware configuration on which they were saved.</p></div></header>
              <div className="pt-profiles">
                {s.profiles.map((p) => (
                  <ProfileCard key={p.id} p={p} active={s.matches === p.id} disabled={blocked}
                    onReview={() => ask(p.title, p.changes, () => api.applyPerformanceProfile(p.id), p.skipped)}
                    onDelete={p.builtin ? undefined : () => void api.deletePerformanceProfile(Number(p.id.slice(7))).then(() => q.reload())} />
                ))}
              </div>
              <div className="row pt-save">
                <label className="field inline-field"><span>Save current configuration as</span><input value={profileName} maxLength={60} placeholder="Profile name" onChange={(e) => setProfileName(e.target.value)} /></label>
                <button className="btn" disabled={!profileName.trim()} onClick={() => void api.savePerformanceProfile(profileName.trim()).then(() => { setProfileName(''); q.reload() }, (e) => setError(cleanError(e)))}><Save size={14} /> Save profile</button>
              </div>
            </section>
            <section className="card pt-section">
              <header className="pt-section-head"><div><h2>Restore</h2><p className="pt-detail">Each restore is applied as a reviewed, verified change.</p></div></header>
              <div className="row">
                <button className="btn" disabled={blocked} onClick={() => { const p = s.profiles.find((x) => x.id === 'stock')!; ask('Restore stock settings', p.changes, () => api.restorePerformance('stock'), p.skipped) }}><RotateCcw size={14} /> Restore stock settings</button>
                <button className="btn" disabled={blocked || !s.canUndo} onClick={() => void run('Undo last change', () => api.restorePerformance('undo'))}><Undo2 size={14} /> Undo last change</button>
                <button className="btn" disabled={blocked || !s.canRestoreOriginal} onClick={() => void run('Restore original settings', () => api.restorePerformance('original'))}><HistoryIcon size={14} /> Restore original settings</button>
              </div>
              <details>
                <summary className="pt-detail">Recovery procedure</summary>
                <ul className="pt-list">
                  <li><strong>Stock settings</strong> uses only documented defaults: the firmware power rating, the driver’s default governor, the firmware’s energy preference, the graphics processor’s full range and tuned’s recommendation. Settings without a documented default are left unchanged and listed.</li>
                  <li><strong>Original settings</strong> restores each value as it was before this application first changed it on this hardware.</li>
                  <li>Processor policy, power limits and graphics clocks revert to their boot defaults on restart. <strong>A tuned profile persists across restarts</strong>; a restart alone is therefore not a complete reset. Use a restore action, or run <code>sudo tuned-adm profile {s.tuned?.recommended ?? 'balanced'}</code>.</li>
                  <li>Without this application: run <code>tuned-adm recommend</code>, apply the recommended profile and restart. The helpers are removed with <code>sudo sh resources/linux/install.sh --uninstall</code>.</li>
                </ul>
              </details>
            </section>
          </>
        )}

        {tab === 'testing' && <TestingTab settings={settings} state={s} />}

        {tab === 'history' && (
          <section className="card pt-section">
            <header className="pt-section-head"><div><h2>Change log</h2><p className="pt-detail">Every change with its previous, requested and read-back values. Retained for {settings.perfHistoryDays} days.</p></div></header>
            {!history.data ? <Spinner /> : !history.data.length ? <p className="pt-detail">No changes recorded.</p> : history.data.map((tx) => <TxResult key={tx.id} tx={tx} />)}
          </section>
        )}
      </div>
    </>
  )
}
