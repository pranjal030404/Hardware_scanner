import { Check, CircleCheck, EyeOff, RefreshCw, RotateCcw, Search, ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { FINDING_CATEGORIES, FINDING_STATUSES, SEVERITIES, type EvidenceRef, type Finding, type FindingCategory, type FindingStatus, type Severity } from '@shared/schemas'
import type { Navigate } from '../App'
import { Badge, CategoryIcon, Empty, ErrorBox, formatValue, fullTime, PageHeader, Spinner, timeAgo } from '../components/ui'
import { useLoad } from '../hooks/useLoad'
import { api } from '../services/api'

const SEV_TONE: Record<Severity, 'bad' | 'warn' | 'info' | 'muted'> = { critical: 'bad', high: 'bad', medium: 'warn', low: 'info', info: 'muted' }
const STATUS_TONE: Record<FindingStatus, 'ok' | 'warn' | 'muted' | 'info'> = { active: 'warn', acknowledged: 'info', resolved: 'ok', dismissed: 'muted' }
const RUN_TONE = { evaluated: 'ok', insufficient_data: 'warn', disabled: 'muted', error: 'bad' } as const

export const SeverityBadge = ({ s }: { s: Severity }): JSX.Element => <Badge tone={SEV_TONE[s]}>{s}</Badge>

function evidenceValue(e: EvidenceRef): string {
  return e.value === null ? '—' : formatValue(e.value, e.unit)
}

export function DiagnosticsPage({ navigate, focus }: { navigate: Navigate; focus?: string }): JSX.Element {
  const [status, setStatus] = useState<FindingStatus | 'all'>('active')
  const [severity, setSeverity] = useState<Severity | ''>('')
  const [category, setCategory] = useState<FindingCategory | ''>('')
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [selected, setSelected] = useState<string | undefined>(focus)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [showRules, setShowRules] = useState(false)

  useEffect(() => { const t = setTimeout(() => setDebounced(search), 150); return () => clearTimeout(t) }, [search])
  useEffect(() => { if (focus) { setSelected(focus); setStatus('all') } }, [focus])

  const st = useLoad(() => api.diagnosticsStatus(), [])
  const list = useLoad(() => api.listFindings({ status: status === 'all' ? undefined : status, severity: severity || undefined, category: category || undefined, search: debounced || undefined }), [status, severity, category, debounced])
  const detail = useLoad(() => (selected ? api.getFinding(selected) : Promise.resolve(null)), [selected])

  const findings = list.data ?? []
  // The selection intentionally survives list changes: acknowledging a finding moves it out of the
  // active tab, but its detail panel (and follow-up actions such as Reopen) must stay visible.

  const counts = st.data?.counts
  const total = useMemo(() => Object.values(counts?.byStatus ?? {}).reduce((a, b) => a + b, 0), [counts])

  const act = async (f: Finding, action: 'acknowledge' | 'dismiss' | 'resolve' | 'reopen'): Promise<void> => {
    setBusy(true); setActionError(null)
    try {
      let reason: string | undefined
      if (action === 'dismiss') reason = 'Dismissed by user'
      await api.setFindingStatus(f.id, action, reason)
      list.reload(); detail.reload(); st.reload()
    } catch (e) {
      setActionError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const evaluate = async (): Promise<void> => {
    setBusy(true)
    try { await api.evaluateDiagnostics(); st.reload(); list.reload(); detail.reload() } finally { setBusy(false) }
  }
  const toggleRule = async (id: string, enabled: boolean): Promise<void> => { await api.setDiagnosticRuleEnabled(id, enabled); st.reload(); list.reload() }

  const d = detail.data

  return (
    <>
      <PageHeader
        title="Diagnostics"
        subtitle={st.data?.lastEvaluatedAt ? `Last evaluated ${timeAgo(st.data.lastEvaluatedAt)} · deterministic rules, every finding cites its evidence` : 'Rules have not been evaluated yet'}
        actions={<button className="btn" onClick={() => void evaluate()} disabled={busy}><RefreshCw size={14} className={busy ? 'spin' : ''} aria-hidden /> Evaluate now</button>}
      />
      {st.error && <ErrorBox message={st.error} onRetry={st.reload} />}
      {st.data?.lastError && <div className="banner banner-bad" role="alert">Last evaluation failed: {st.data.lastError}</div>}
      {st.data?.dataStale && (
        <div className="banner banner-warn" role="status">Inventory data is stale{st.data.lastInventoryScanAt ? ` (last scan ${timeAgo(st.data.lastInventoryScanAt)})` : ' (no scan yet)'}. Findings below reflect the last known state and rules needing fresh data are paused, not resolved.</div>
      )}

      <div className="chips" role="group" aria-label="Severity summary">
        {[...SEVERITIES].reverse().map((s) => (
          <button key={s} className={`stat ${severity === s ? 'active-stat' : ''}`} aria-pressed={severity === s} onClick={() => setSeverity(severity === s ? '' : s)}>
            <b>{counts?.bySeverity[s] ?? 0}</b><SeverityBadge s={s} />
          </button>
        ))}
        <span className="muted small chip-note">Counts include active and acknowledged findings.</span>
      </div>

      <div className="tabs" role="tablist" aria-label="Status">
        {(['active', 'acknowledged', 'dismissed', 'resolved', 'all'] as const).map((s) => (
          <button key={s} role="tab" aria-selected={status === s} className={`tab ${status === s ? 'active' : ''}`} onClick={() => setStatus(s)}>
            {s}{s !== 'all' ? <b> {counts?.byStatus[s] ?? 0}</b> : <b> {total}</b>}
          </button>
        ))}
      </div>

      <div className="toolbar">
        <label className="search"><Search size={14} aria-hidden /><input type="search" placeholder="Search findings…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search findings" /></label>
        <select value={category} onChange={(e) => setCategory(e.target.value as FindingCategory | '')} aria-label="Filter by category">
          <option value="">Any category</option>{FINDING_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {(severity || category || debounced) && <button className="btn btn-sm" onClick={() => { setSeverity(''); setCategory(''); setSearch('') }}>Clear filters</button>}
      </div>

      {list.error && <ErrorBox message={list.error} onRetry={list.reload} />}
      {!list.data && !list.error && <Spinner />}

      {list.data && (
        <div className="diag-layout">
          <div className="table-wrap">
            {findings.length === 0 ? (
              <Empty icon={<CircleCheck size={22} />} title={status === 'active' && !severity && !category && !debounced ? 'No active findings' : 'No findings match these filters'}>
                {status === 'active' && !severity && !category && !debounced
                  ? (st.data?.lastEvaluatedAt ? 'Every rule that had enough fresh data found nothing to report. Rules that lacked data are listed under Rules & engine health — no data is not the same as healthy.' : 'The engine has not run yet.')
                  : 'Try another status tab or clear the filters.'}
              </Empty>
            ) : (
              <table className="table compact">
                <thead><tr><th scope="col">Severity</th><th scope="col">Finding</th><th scope="col">Category</th><th scope="col">Status</th><th scope="col">Last seen</th></tr></thead>
                <tbody>
                  {findings.map((f) => (
                    <tr key={f.id} tabIndex={0} className={selected === f.id ? 'row-selected' : ''} aria-selected={selected === f.id}
                      onClick={() => setSelected(f.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelected(f.id) } }}>
                      <td><SeverityBadge s={f.severity} /></td>
                      <td>{f.title}</td>
                      <td>{f.category}</td>
                      <td><Badge tone={STATUS_TONE[f.status]}>{f.status}</Badge></td>
                      <td className="muted" title={fullTime(f.lastSeenAt)}>{timeAgo(f.lastSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <aside className="card diag-detail" aria-label="Finding details">
            {!selected && <p className="muted">Select a finding to see its evidence, the rule that produced it and what you can do next.</p>}
            {selected && detail.loading && !d && <Spinner />}
            {selected && detail.error && <ErrorBox message={detail.error} onRetry={detail.reload} />}
            {selected && detail.data === null && !detail.loading && <p className="muted">This finding no longer exists.</p>}
            {d && (
              <>
                <div className="inline"><SeverityBadge s={d.finding.severity} /><Badge tone={STATUS_TONE[d.finding.status]}>{d.finding.status}</Badge>{d.finding.confidence !== null && <Badge tone="muted" title="How certain the rule is about this conclusion">confidence {Math.round(d.finding.confidence * 100)}%</Badge>}</div>
                <h2 className="detail-title">{d.finding.title}</h2>
                <p>{d.finding.description}</p>
                <h3>Recommended next step</h3>
                <p>{d.finding.recommendation || '—'}</p>

                <div className="row">
                  {d.finding.status === 'active' && <button className="btn btn-sm" disabled={busy} onClick={() => void act(d.finding, 'acknowledge')}><Check size={13} /> Acknowledge</button>}
                  {(d.finding.status === 'active' || d.finding.status === 'acknowledged') && <button className="btn btn-sm" disabled={busy} onClick={() => void act(d.finding, 'dismiss')}><EyeOff size={13} /> Dismiss</button>}
                  {d.finding.status !== 'resolved' && <button className="btn btn-sm" disabled={busy} onClick={() => void act(d.finding, 'resolve')}><CircleCheck size={13} /> Mark resolved</button>}
                  {d.finding.status !== 'active' && <button className="btn btn-sm" disabled={busy} onClick={() => void act(d.finding, 'reopen')}><RotateCcw size={13} /> Reopen</button>}
                </div>
                {actionError && <div className="banner banner-bad" role="alert">{actionError}</div>}
                {d.finding.status === 'dismissed' && <p className="muted small">Dismissed findings stay hidden while the condition persists, but come back if it gets worse.</p>}

                <h3>Evidence</h3>
                {d.finding.evidence.length === 0 ? <p className="muted small">Informational finding without recorded evidence references.</p> : (
                  <table className="table compact">
                    <thead><tr><th>What</th><th>Value</th><th>Source</th><th>Observed</th></tr></thead>
                    <tbody>
                      {d.finding.evidence.map((e, i) => (
                        <tr key={i}>
                          <td>{e.type.replace(/_/g, ' ')}{e.key && <div className="mono small">{e.key}</div>}</td>
                          <td>{evidenceValue(e)}{e.note && <div className="muted small">{e.note}</div>}</td>
                          <td className="mono small">{e.source ?? e.ref}</td>
                          <td className="muted small" title={fullTime(e.observedAt)}>{timeAgo(e.observedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {d.devices.length > 0 && (
                  <>
                    <h3>Affected devices</h3>
                    <ul className="plain">{d.devices.map((dv) => (
                      <li key={dv.id}><button className="link" onClick={() => navigate({ page: 'device', id: dv.id, from: { page: 'diagnostics', focus: d.finding.id } })}><CategoryIcon category={dv.category} size={14} /> {dv.name}{dv.presence === 'missing' && ' (missing)'}</button></li>
                    ))}</ul>
                  </>
                )}

                <h3>Timeline</h3>
                <dl className="kv">
                  <div><dt>First detected</dt><dd>{fullTime(d.finding.firstDetectedAt)}</dd></div>
                  <div><dt>Last seen</dt><dd>{fullTime(d.finding.lastSeenAt)}</dd></div>
                  {d.finding.acknowledgedAt && <div><dt>Acknowledged</dt><dd>{fullTime(d.finding.acknowledgedAt)}</dd></div>}
                  {d.finding.resolvedAt && <div><dt>Resolved</dt><dd>{fullTime(d.finding.resolvedAt)}</dd></div>}
                  {d.finding.resolutionReason && <div><dt>Reason</dt><dd>{d.finding.resolutionReason}</dd></div>}
                </dl>

                {d.rule && (
                  <>
                    <h3>About this rule</h3>
                    <p><b>{d.rule.title}</b> <span className="muted mono small">{d.rule.id} v{d.finding.ruleVersion}</span></p>
                    <p className="small">{d.rule.description}</p>
                    <p className="small muted"><b>Severity policy:</b> {d.rule.severityPolicy}</p>
                    <p className="small muted"><b>Data used:</b> {d.rule.dataUsed}</p>
                  </>
                )}
              </>
            )}
          </aside>
        </div>
      )}

      <section className="card rules-card">
        <button className="link" onClick={() => setShowRules(!showRules)} aria-expanded={showRules}><ShieldAlert size={14} /> Rules &amp; engine health {st.data && <span className="muted">· {st.data.rules.filter((r) => r.enabled).length}/{st.data.rules.length} enabled</span>}</button>
        {showRules && st.data && (
          <table className="table compact">
            <thead><tr><th>Rule</th><th>Last run</th><th>Outcome</th><th>Enabled</th></tr></thead>
            <tbody>
              {st.data.rules.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.title}</b><div className="mono small muted">{r.id} v{r.version} · {r.category}</div><div className="small muted">{r.description}</div></td>
                  <td className="muted small">{r.lastRun ? `${timeAgo(r.lastRun.startedAt)} · ${r.lastRun.durationMs}ms` : 'never'}</td>
                  <td>{r.lastRun ? <><Badge tone={RUN_TONE[r.lastRun.outcome]}>{r.lastRun.outcome.replace('_', ' ')}</Badge>{r.lastRun.message && <div className="small muted">{r.lastRun.message}</div>}</> : '—'}</td>
                  <td><label className="toggle"><input type="checkbox" checked={r.enabled} onChange={(e) => void toggleRule(r.id, e.target.checked)} aria-label={`Enable ${r.title}`} /></label></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <p className="muted small">Allowed statuses: {FINDING_STATUSES.join(', ')}. Nothing here changes your hardware or runs fixes.</p>
    </>
  )
}
