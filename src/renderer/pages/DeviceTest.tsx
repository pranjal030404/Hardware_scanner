import { CircleCheck, CircleMinus, CircleX, Copy, Info, Play, Plug, RefreshCw, Square, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { CheckStatus, DeepPhase, DeepProgress, DeepReport, HidrawInfo, LiveState, PathNode, TargetKind, TestReport, TestTarget } from '../../device-test/types'
import { Badge, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { useLoad } from '../hooks/useLoad'
import { api } from '../services/api'
import { liveFindings, tiles } from './device-test-logic'

const KIND_LABEL: Record<TargetKind, string> = { usb: 'USB devices', input: 'Built-in keyboard & pointers', network: 'Network', storage: 'Drives', battery: 'Battery', camera: 'Cameras', bluetooth: 'Bluetooth' }
const KIND_ORDER: TargetKind[] = ['usb', 'input', 'camera', 'network', 'bluetooth', 'storage', 'battery']
const TONE: Record<CheckStatus, 'ok' | 'warn' | 'bad' | 'info' | 'muted'> = { pass: 'ok', warn: 'warn', fail: 'bad', info: 'info', skip: 'muted' }
const VERDICT: Record<CheckStatus, string> = { pass: 'Working', warn: 'Working, with problems', fail: 'Not working properly', info: 'Information', skip: 'Not tested' }

const timeOf = (d: Date): string => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

const cleanError = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function StatusIcon({ status }: { status: CheckStatus }): JSX.Element {
  const p = { size: 16, 'aria-label': status, className: `status-icon status-${status}` }
  if (status === 'pass') return <CircleCheck {...p} />
  if (status === 'fail') return <CircleX {...p} />
  if (status === 'warn') return <TriangleAlert {...p} />
  if (status === 'info') return <Info {...p} />
  return <CircleMinus {...p} />
}

function HandsOn({ report }: { report: TestReport }): JSX.Element {
  const info = report.interactive
  const [live, setLive] = useState<LiveState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const session = useRef<string | null>(null)

  useEffect(() => {
    if (!live?.running) return
    const h = setInterval(() => {
      if (!session.current) return
      api.pollLiveTest(session.current).then(setLive, (e) => { setError(cleanError(e)); session.current = null })
    }, 200)
    return () => clearInterval(h)
  }, [live?.running])
  // Leaving the page or switching device always ends the session: the device is only read while you watch.
  useEffect(() => () => { if (session.current) void api.stopLiveTest() }, [report.target.id])

  const start = async (): Promise<void> => {
    setError(null)
    try { const s = await api.startLiveTest(report.target.id); session.current = s.sessionId; setLive(s) } catch (e) { setError(cleanError(e)) }
  }
  const stop = async (): Promise<void> => {
    await api.stopLiveTest()
    if (session.current) setLive((s) => (s ? { ...s, running: false, stoppedReason: 'Finished' } : s))
  }
  const still = async (): Promise<void> => {
    if (!session.current) return
    try { setLive(await api.startStillTest(session.current, 3000)) } catch (e) { setError(cleanError(e)) }
  }

  if (!info.available) return <p className="muted">{info.reason}</p>
  const ts = tiles(info, live)
  const findings = live ? liveFindings(info, live) : []
  const remaining = live ? Math.max(0, Math.ceil((live.limitMs - live.elapsedMs) / 1000)) : 0
  return (
    <div className="stack">
      <p className="muted small">
        Reads the device's own signals ({info.nodes.join(', ')}) while you use it. The device keeps working normally. Nothing is recorded or saved{info.isKeyboard ? '; key names are shown only on this screen' : ''}. Stops automatically after 2 minutes.
      </p>
      {error && <div className="banner banner-bad" role="alert">{error}</div>}
      <div className="row">
        {!live?.running
          ? <button className="btn" onClick={() => void start()}><Play size={14} /> {live ? 'Start again' : 'Start hands-on test'}</button>
          : <button className="btn" onClick={() => void stop()}><Square size={14} /> Finish</button>}
        {live?.running && info.hasMotion && (
          <button className="btn" disabled={live.still.phase === 'running'} onClick={() => void still()}>{live.still.phase === 'running' ? 'Hands off… (3 s)' : 'Hold-still test (3 s)'}</button>
        )}
        {live && <span className="muted small">{live.running ? `Listening · ${remaining}s left · ${live.events} signals received` : `Stopped: ${live.stoppedReason}`}</span>}
      </div>
      {live?.running && live.events === 0 && live.elapsedMs > 3000 && <div className="banner banner-warn" role="status">Nothing received yet. Use the device now: move it, click, press keys.</div>}
      {ts.length > 0 && (
        <div className="test-tiles" role="list" aria-label="What to try">
          {ts.map((t) => (
            <div key={t.key} role="listitem" className={`test-tile ${t.bad ? 'bad' : t.done ? 'done' : ''}`}>
              <span>{t.label}</span>
              <small>{t.bad ?? (t.done ? `works${t.value ? ` · ${t.value}` : ''}` : 'try it')}</small>
            </div>
          ))}
        </div>
      )}
      {info.isKeyboard && live && (
        <div className="card-inner">
          <strong>Keys</strong> <span className="muted small">{live.keyPresses} presses · {live.keys.length} different keys</span>
          <p className="mono small">{live.keys.slice(-60).join('  ') || 'Press keys on this keyboard…'}</p>
        </div>
      )}
      {findings.length > 0 && (
        <ul className="check-list" aria-label="Hands-on results">
          {findings.map((f) => (
            <li key={f.title}><StatusIcon status={f.status} /><div><strong>{f.title}</strong><p className="small">{f.detail}</p></div></li>
          ))}
        </ul>
      )}
    </div>
  )
}

const MAP_KIND: Record<PathNode['kind'], string> = {
  'pci-root': 'PCI root', pci: 'PCI', 'usb-root': 'USB root hub', usb: 'USB device', 'usb-interface': 'USB interface', hid: 'HID', input: 'input', serio: 'PS/2',
  i2c: 'I2C', storage: 'storage', bluetooth: 'Bluetooth', camera: 'camera', battery: 'battery', network: 'network', other: 'device'
}

/** The device's own branch of the system: its parents down from the root, and everything it contains. */
function MapNode({ n }: { n: PathNode }): JSX.Element {
  return (
    <li>
      <div className={`map-node ${n.target ? 'target' : ''}`}>
        <div><strong>{n.title}</strong> <Badge tone={n.target ? 'info' : 'muted'}>{n.target ? 'this device' : MAP_KIND[n.kind]}</Badge></div>
        {n.details.length > 0 && <dl className="map-details">{n.details.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
        <small className="mono muted">{n.sysfs}</small>
      </div>
      {n.children.length > 0 && <ul>{n.children.map((c) => <MapNode key={c.sysfs} n={c} />)}</ul>}
    </li>
  )
}

const DEEP_SECONDS = 12
const RUNNING: DeepPhase[] = ['auth', 'querying', 'capturing', 'analysing']
const STEPS: { phase: DeepPhase; label: string }[] = [
  { phase: 'auth', label: 'Password' }, { phase: 'querying', label: 'Asking the device' }, { phase: 'capturing', label: 'Capturing' }, { phase: 'analysing', label: 'Analysing' }
]
const ROLE_LABEL: Record<HidrawInfo['role'], string> = { paired: 'paired device', receiver: 'receiver', device: 'device' }

function Stepper({ phase }: { phase: DeepPhase }): JSX.Element {
  const at = phase === 'done' ? STEPS.length : STEPS.findIndex((s) => s.phase === phase)
  return (
    <ol className="stepper" aria-label="Progress">
      {STEPS.map((s, i) => (
        <li key={s.phase} className={i < at ? 'done' : i === at ? 'current' : ''} aria-current={i === at ? 'step' : undefined}>
          <span className="step-dot">{i < at ? <CircleCheck size={14} aria-hidden /> : i + 1}</span>{s.label}
        </li>
      ))}
    </ol>
  )
}

/** Movement reports per second, with clicks marked under each bar. One series, so no legend. */
function ActivityChart({ r }: { r: DeepReport }): JSX.Element {
  const max = Math.max(1, ...r.timeline.map((b) => b.motion))
  return (
    <figure className="activity">
      <figcaption><strong>Movement reports per second</strong> <span className="muted small">· dots under a bar = clicks in that second</span></figcaption>
      <div className="activity-plot" role="img" aria-label={`Movement reports per second over ${r.seconds} seconds: ${r.timeline.map((b) => b.motion).join(', ')}`}>
        <div className="activity-axis" aria-hidden><span>{max}</span><span>0</span></div>
        <div className="activity-bars">
          {r.motionReports === 0 && <div className="activity-empty">No movement in any second{r.pointerReports ? ', although the device was sending clicks' : ''}</div>}
          {r.timeline.map((b) => (
            <div className="activity-col" key={b.second} tabIndex={0} aria-label={`Second ${b.second}: ${b.motion} movement reports, ${b.presses} clicks, ${b.reports} reports in total`}>
              <div className="activity-track"><div className={`activity-bar ${b.motion ? '' : 'zero'}`} style={{ height: `${(b.motion / max) * 100}%` }} /></div>
              <div className="activity-clicks" aria-hidden>{b.presses > 0 && <span title={`${b.presses} click${b.presses > 1 ? 's' : ''}`}>{'•'.repeat(Math.min(3, b.presses))}</span>}</div>
              <span className="activity-x" aria-hidden>{b.second}s</span>
              <div className="activity-tip" role="tooltip"><strong>Second {b.second}</strong><br />{b.motion} with movement<br />{b.presses} click{b.presses === 1 ? '' : 's'}<br />{b.reports} reports total</div>
            </div>
          ))}
        </div>
      </div>
      <details><summary className="small muted">Show as a table</summary>
        <table className="table compact"><thead><tr><th>Second</th><th>Reports</th><th>With movement</th><th>Clicks</th></tr></thead>
          <tbody>{r.timeline.map((b) => <tr key={b.second}><td>{b.second}</td><td>{b.reports}</td><td>{b.motion}</td><td>{b.presses}</td></tr>)}</tbody></table>
      </details>
    </figure>
  )
}

export function DeepResult({ r, interactive }: { r: DeepReport; interactive: TestReport['interactive'] }): JSX.Element {
  const [headline, ...rest] = r.findings
  const h = r.hidpp
  const expected = ['Left', 'Right', 'Middle (wheel click)'].concat(interactive.buttons.includes('Side button') ? ['Back (side)', 'Forward (side)'] : [])
  const buttonRows = [...new Set([...expected, ...r.presses.map((p) => p.name)])].map((name) => ({ name, presses: r.presses.find((p) => p.name === name)?.presses ?? 0 }))
  const pct = r.pointerReports ? Math.round((r.motionReports / r.pointerReports) * 100) : 0
  const battery = h?.voltage_mV ? `${(h.voltage_mV / 1000).toFixed(2)} V` : h?.battery ? (h.battery.percent ? `${h.battery.percent}%` : 'reported, no percentage') : null
  return (
    <div className="stack deep-result">
      {headline && (
        <div className={`deep-verdict verdict-${headline.status}`} role="status">
          <StatusIcon status={headline.status} />
          <div><strong>{headline.title}</strong><p className="small">{headline.detail}</p></div>
        </div>
      )}
      <div className="deep-grid">
        <section className="card-inner">
          <h3>Signals received in {r.seconds} s</h3>
          <div className="deep-stats">
            <div><span className="deep-num">{r.reports}</span><span className="muted small">reports</span></div>
            <div><span className="deep-num">{r.pointerReports}</span><span className="muted small">pointer reports</span></div>
            <div className={r.pointerReports && !r.motionReports ? 'bad' : ''}><span className="deep-num">{r.motionReports}</span><span className="muted small">with movement ({pct}%)</span></div>
            <div><span className="deep-num">{r.movedX + r.movedY}</span><span className="muted small">total travel ({r.movedX} ↔, {r.movedY} ↕)</span></div>
            <div><span className="deep-num">{r.maxStep}</span><span className="muted small">largest single step</span></div>
            <div><span className="deep-num">{r.wheelReports}</span><span className="muted small">wheel reports</span></div>
          </div>
        </section>
        <section className="card-inner">
          <h3>What the device says about itself</h3>
          {h?.answered ? (
            <dl className="kv">
              {h.name && <div><dt>Name</dt><dd>{h.name}</dd></div>}
              {h.protocol && <div><dt>Protocol</dt><dd>HID++ {h.protocol}</dd></div>}
              {battery && <div><dt>Battery</dt><dd>{battery}</dd></div>}
              {h.dpi && <div><dt>Sensor setting</dt><dd>{h.dpi} DPI</dd></div>}
              {h.firmware?.map((f, i) => <div key={i}><dt>{i ? '' : 'Firmware'}</dt><dd className="mono small">{f}</dd></div>)}
            </dl>
          ) : <p className="small muted">{r.hidpp ? 'It did not answer (probably asleep when the test began). Click it once, then run the test again to read its battery and firmware.' : 'This device does not support direct queries.'}</p>}
        </section>
      </div>
      <section className="card-inner">
        <h3>Buttons</h3>
        <ul className="button-chips">
          {buttonRows.map((b) => (
            <li key={b.name} className={b.presses ? 'ok' : ''}>{b.presses ? <CircleCheck size={14} aria-hidden /> : <CircleMinus size={14} aria-hidden />} {b.name} <span className="muted small">{b.presses ? `${b.presses}×` : 'not pressed'}</span></li>
          ))}
        </ul>
        <p className="small muted">A button you pressed that shows “not pressed” is not sending anything.</p>
      </section>
      <ActivityChart r={r} />
      {rest.length > 0 && (
        <ul className="check-list" aria-label="More findings">
          {rest.map((f) => <li key={f.title}><StatusIcon status={f.status} /><div><strong>{f.title}</strong><p className="small">{f.detail}</p></div></li>)}
        </ul>
      )}
      {r.evidence.length > 0 && (
        <details>
          <summary className="small muted">Raw evidence: the first {r.evidence.length} decoded reports</summary>
          <table className="table compact mono"><thead><tr><th>Time</th><th>Buttons held</th><th>X</th><th>Y</th><th>Wheel</th></tr></thead>
            <tbody>{r.evidence.map((e, i) => <tr key={i}><td>+{e.ms} ms</td><td>{e.buttons}</td><td className={e.x ? '' : 'muted'}>{e.x}</td><td className={e.y ? '' : 'muted'}>{e.y}</td><td>{e.wheel}</td></tr>)}</tbody></table>
        </details>
      )}
    </div>
  )
}

/** Shown instead of a failing button when the optional root helper the deep test needs is missing. */
function HelperSetup({ helper, onRecheck, checking }: { helper: TestReport['deepHelper']; onRecheck: () => void; checking: boolean }): JSX.Element {
  const [copied, setCopied] = useState(false)
  const copy = (): void => { navigator.clipboard.writeText(helper.installCommand).then(() => setCopied(true), () => setCopied(false)) }
  return (
    <div className="banner banner-warn stack" role="status">
      <div>
        <strong>One-time setup needed.</strong> {(helper.reason ?? '').replace(/\s*Install the optional helpers.*$/s, '')} Raw device access needs a small, reviewed root helper that you install yourself; this application never installs anything as root.
      </div>
      <div className="row">
        <code className="mono small">{helper.installCommand}</code>
        <button className="btn btn-sm" onClick={copy}><Copy size={12} /> {copied ? 'Copied' : 'Copy'}</button>
      </div>
      <p className="small">Run it in a terminal, then check again. Remove it any time with the same command plus <code>--uninstall</code>. See docs/PERFORMANCE.md.</p>
      <div><button className="btn btn-sm" disabled={checking} onClick={onRecheck}><RefreshCw size={12} className={checking ? 'spin' : ''} /> {checking ? 'Checking…' : 'I installed it, check again'}</button></div>
    </div>
  )
}

/** Reads what the device itself transmits, below the driver; needs the administrator password. */
function DeepTest({ report, onRecheck, checking }: { report: TestReport; onRecheck: () => void; checking: boolean }): JSX.Element {
  const parts = report.hid
  const [node, setNode] = useState(parts[0]?.node ?? '')
  const [progress, setProgress] = useState<DeepProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const running = progress !== null && RUNNING.includes(progress.phase)

  useEffect(() => {
    if (!running || !progress) return
    const h = setInterval(() => { api.pollDeepTest(progress.sessionId).then(setProgress, (e) => setError(cleanError(e))) }, 250)
    return () => clearInterval(h)
  }, [running, progress?.sessionId])

  const start = async (): Promise<void> => {
    setError(null); setProgress(null)
    try { setProgress(await api.startDeepTest(report.target.id, node, DEEP_SECONDS)) } catch (e) { setError(cleanError(e)) }
  }
  const sel = parts.find((p) => p.node === node)

  return (
    <div className="stack">
      <p className="small muted">
        Reads the raw signals the device transmits, below the driver and the desktop. It proves whether the device itself is sending movement and clicks, which separates a faulty device from a problem on this computer. Nothing is changed on the device. Raw device access needs your administrator password.
      </p>
      <fieldset className="hid-parts" disabled={running}>
        <legend className="small">Choose the part to test</legend>
        {parts.map((p) => (
          <label key={p.node} className={`hid-part ${node === p.node ? 'selected' : ''}`}>
            <input type="radio" name="hid-part" value={p.node} checked={node === p.node} onChange={() => setNode(p.node)} />
            <span className="hid-part-body">
              <span><strong>{p.name}</strong> <span className="mono small muted">{p.node}</span></span>
              <span className="hid-part-badges">
                <Badge tone={p.role === 'paired' ? 'info' : 'muted'}>{ROLE_LABEL[p.role]}</Badge>
                {p.pointer && <Badge tone="neutral">movement + buttons</Badge>}
                {p.hidpp && <Badge tone="neutral">battery & firmware queries</Badge>}
              </span>
              <span className="small muted">{p.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="row">
        <button className="btn btn-primary" disabled={running || !node || !report.deepHelper.usable} onClick={() => void start()}><Play size={14} /> {progress?.result ? 'Run again' : `Run deep test (${DEEP_SECONDS} s)`}</button>
        {sel && !sel.pointer && <span className="small muted">This part carries no movement data; the test will only report what it sends.</span>}
      </div>
      {!report.deepHelper.usable && <HelperSetup helper={report.deepHelper} onRecheck={onRecheck} checking={checking} />}
      {error && <div className="banner banner-bad" role="alert">{error}</div>}
      {progress && (
        <div className="deep-progress">
          <Stepper phase={progress.phase === 'error' ? 'auth' : progress.phase} />
          {progress.phase === 'auth' && <div className="banner banner-warn" role="status">Enter your administrator password in the system dialog. The capture starts right after.</div>}
          {progress.phase === 'querying' && <div className="banner banner-info" role="status">Reading battery, firmware and sensor settings from the device. Click it once to wake it, and get ready to move it.</div>}
          {progress.phase === 'capturing' && (
            <div className="deep-capture" role="status" aria-live="polite">
              <div className="deep-countdown"><span className="deep-num">{progress.secondsLeft ?? DEEP_SECONDS}</span><span className="small">seconds left</span></div>
              <div>
                <strong>Move it in circles and click every button now.</strong>
                <div className="deep-live">
                  <span>{progress.live.reports} reports</span>
                  <span className={progress.live.pointerReports && !progress.live.motionReports ? 'bad' : 'ok'}>{progress.live.motionReports} with movement</span>
                  <span>buttons: {progress.live.buttons.join(', ') || 'none yet'}</span>
                  <span>{progress.live.wheelReports} wheel</span>
                </div>
              </div>
            </div>
          )}
          {progress.phase === 'analysing' && <div className="banner banner-info" role="status">Analysing what the device sent…</div>}
          {progress.phase === 'error' && <div className="banner banner-bad" role="alert">{progress.error}</div>}
        </div>
      )}
      {progress?.result && <DeepResult r={progress.result} interactive={report.interactive} />}
    </div>
  )
}

function Report({ targetId, onGone }: { targetId: string; onGone: () => void }): JSX.Element {
  const [nonce, setNonce] = useState(0)
  const q = useLoad(() => api.runDeviceTest(targetId), [targetId, nonce], false)
  if (q.error) return <ErrorBox message={cleanError({ message: q.error })} onRetry={onGone} />
  if (!q.data) return <div className="card"><Spinner /><p className="muted small">Checking the device…</p></div>
  const r = q.data
  return (
    <div className="stack">
      <section className={`card verdict verdict-${r.verdict.status}`} aria-live="polite">
        <div className="row spread">
          <div>
            <h2>{r.target.label}</h2>
            <p className="muted small">{r.target.detail}</p>
          </div>
          <button className="btn btn-sm" disabled={q.loading} onClick={() => setNonce((n) => n + 1)}><RefreshCw size={12} className={q.loading ? 'spin' : ''} /> {q.loading ? 'Checking…' : 'Check again'}</button>
        </div>
        <p className="small muted">Checked at {timeOf(new Date(r.ranAt))}</p>
        <p className="verdict-line"><StatusIcon status={r.verdict.status} /> <strong>{VERDICT[r.verdict.status]}</strong> — {r.verdict.headline}</p>
      </section>
      <section className="card">
        <h2>Automatic checks</h2>
        <ul className="check-list">
          {r.checks.map((c) => (
            <li key={c.id + c.title}>
              <StatusIcon status={c.status} />
              <div>
                <strong>{c.title}</strong> <Badge tone={TONE[c.status]}>{c.status}</Badge>
                <p className="small">{c.summary}</p>
                {c.fix && <p className="small fix"><strong>What to do:</strong> {c.fix}</p>}
                {c.details.length > 0 && <details><summary className="small muted">Evidence</summary><pre className="mono small evidence">{c.details.join('\n')}</pre></details>}
              </div>
            </li>
          ))}
        </ul>
      </section>
      {r.hid.length > 0 && (
        <section className="card" aria-label="Deep hardware test">
          <h2>Deep hardware test</h2>
          <DeepTest report={r} onRecheck={() => setNonce((n) => n + 1)} checking={q.loading} />
        </section>
      )}
      {r.map && (
        <section className="card" aria-label="Connection map">
          <h2>Connection map</h2>
          <p className="small muted">How this device is attached, from the processor's PCI root down to every part it contains, read live from the kernel.</p>
          <ul className="device-map"><MapNode n={r.map} /></ul>
        </section>
      )}
      {(r.interactive.available || r.target.inputNodes.length > 0) && (
        <section className="card">
          <h2>Hands-on test</h2>
          <HandsOn report={r} />
        </section>
      )}
    </div>
  )
}

export function DeviceTestPage(): JSX.Element {
  const q = useLoad(() => api.testTargets(), [], true)
  const [selected, setSelected] = useState<string | null>(null)
  const initial = useRef<Set<string> | null>(null)
  if (q.data && !initial.current) initial.current = new Set(q.data.targets.map((t) => t.id))
  // The list refreshes itself on device events too, so show when it was last read.
  const [updated, setUpdated] = useState<Date | null>(null)
  useEffect(() => { if (q.data) setUpdated(new Date()) }, [q.data])
  const fresh = q.data?.targets.filter((t) => initial.current && !initial.current.has(t.id)) ?? []

  // A device plugged in while this page is open is selected automatically.
  const lastFresh = fresh.at(-1)?.id
  useEffect(() => { if (lastFresh) setSelected(lastFresh) }, [lastFresh])

  if (q.error) return <><PageHeader title="Device test" /><ErrorBox message={q.error} onRetry={q.reload} /></>
  const groups = new Map<TargetKind, TestTarget[]>()
  for (const t of q.data?.targets ?? []) groups.set(t.kind, [...(groups.get(t.kind) ?? []), t])
  const sel = q.data?.targets.find((t) => t.id === selected)

  return (
    <>
      <PageHeader title="Device test" />
      <div className="devtest-layout">
        <aside className="stack">
          <section className="card">
            <h2><Plug size={15} aria-hidden /> Connect or choose a device</h2>
            <p className="small muted">Plug in the device you want to check. It is picked automatically when it appears, or choose any device below.</p>
            <div className="row">
              <button className="btn btn-sm" disabled={q.loading} onClick={q.reload}><RefreshCw size={12} className={q.loading ? 'spin' : ''} /> {q.loading ? 'Refreshing…' : 'Refresh list'}</button>
              {updated && <span className="small muted" aria-live="polite">Updated {timeOf(updated)}</span>}
            </div>
          </section>
          {q.data?.attempts.filter((a) => !a.nowPresent).map((a) => (
            <section className="card attempt" key={a.port + a.at} role="alert">
              <strong><CircleX size={14} aria-hidden /> Something on USB port {a.port} failed to connect</strong>
              <p className="small">{a.explanation}</p>
              <p className="mono small muted">{a.at} {a.message}</p>
            </section>
          ))}
          {q.data?.kernelLogLimitation && <p className="small muted">Kernel log: {q.data.kernelLogLimitation}</p>}
          {!q.data ? <Spinner /> : KIND_ORDER.filter((k) => groups.has(k)).map((k) => (
            <section className="card" key={k}>
              <h3>{KIND_LABEL[k]}</h3>
              <ul className="target-list">
                {groups.get(k)!.map((t) => (
                  <li key={t.id}>
                    <button className={`target ${selected === t.id ? 'active' : ''}`} aria-pressed={selected === t.id} onClick={() => setSelected(t.id)}>
                      <span>{t.label} {fresh.some((f) => f.id === t.id) && <Badge tone="info">new</Badge>}</span>
                      <small className="muted">{t.detail}</small>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </aside>
        <div>
          {sel ? <Report key={sel.id} targetId={sel.id} onGone={() => { setSelected(null); q.reload() }} />
            : selected ? <Empty title="That device was disconnected"><p className="muted small">Plug it in again; it will be selected automatically.</p></Empty>
              : <Empty title="Choose a device to test"><p className="muted small">Or plug one in now. A mouse, keyboard, USB stick, camera, network adapter, drive or battery can be checked.</p></Empty>}
        </div>
      </div>
    </>
  )
}
