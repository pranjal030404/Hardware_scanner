import { createHash } from 'node:crypto'
import { DIAGNOSTIC_RULES } from '../../diagnostics/rules'
import type { DiagnosticRule, MetricWindow, RuleContext, RuleFinding, RuleResult } from '../../diagnostics/types'
import {
  FindingSchema, SEVERITIES, type DiagnosticsStatus, type Finding, type FindingDetail, type HipEvent, type MonitorStatus, type RuleInfo, type Settings
} from '@shared/schemas'
import { transaction, type Db } from '../database/db'
import { DiagnosticsRepo, type EventRepo, type InventoryRepo, type RuleRunRecord } from '../database/repositories'
import type { CollectorHealth, MetricsStatus } from '@shared/schemas'
import type { EventBus } from './event-bus'

export type FindingAction = 'acknowledge' | 'dismiss' | 'resolve' | 'reopen'

export interface DiagnosticsDeps {
  db: Db
  inventory: InventoryRepo
  events: EventRepo
  bus: EventBus
  getSettings: () => Settings
  getMonitor: () => MonitorStatus | null
  getCollectors: () => CollectorHealth[]
  getMetrics?: () => MetricsStatus | null
  getMetricWindow?: (metric: string, windowMs: number) => MetricWindow[]
  rules?: DiagnosticRule[]
  clock?: () => Date
}

export const findingId = (ruleId: string, subject: string): string => createHash('sha256').update(`${ruleId}\0${subject}`).digest('hex').slice(0, 20)
const sevRank = (s: string): number => SEVERITIES.indexOf(s as never)

export interface EvaluationSummary {
  created: number
  updated: number
  resolved: number
  reopened: number
  ruleErrors: number
  at: string
}

/**
 * Deterministic rule engine. Each evaluation builds one consistent context from stored data, runs every
 * enabled rule in isolation, and applies all results in a single transaction.
 *
 * Safety properties:
 *  - A rule with insufficient/stale data or that throws changes nothing: existing findings are kept.
 *  - A finding disappears only when its rule evaluated successfully and no longer reports the subject.
 *  - Findings are identified by (rule, subject), so re-evaluation updates instead of duplicating.
 */
export class DiagnosticsService {
  readonly repo: DiagnosticsRepo
  private rules: DiagnosticRule[]
  private evaluating = false
  private lastEvaluatedAt: string | null = null
  private lastError: string | null = null
  private timer: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  private unsub: (() => void) | null = null
  private clock: () => Date

  constructor(private d: DiagnosticsDeps) {
    this.repo = new DiagnosticsRepo(d.db)
    this.rules = d.rules ?? DIAGNOSTIC_RULES
    this.clock = d.clock ?? (() => new Date())
  }

  // ---- scheduling -----------------------------------------------------------------------------

  start(intervalMs = 60_000): void {
    this.unsub = this.d.bus.subscribe((e) => {
      // Reevaluate when inventory facts change. Diagnostic events are deliberately not triggers.
      if (e.type === 'collector.completed' || e.type === 'collector.failed' || e.type.startsWith('device.') || e.type === 'monitor.status_changed') this.schedule()
    })
    this.timer = setInterval(() => this.safeEvaluate(), intervalMs)
    this.timer.unref?.()
    this.schedule(500)
  }

  stop(): void {
    this.unsub?.()
    if (this.timer) clearInterval(this.timer)
    if (this.debounce) clearTimeout(this.debounce)
  }

  schedule(delayMs = 1500): void {
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => this.safeEvaluate(), delayMs)
    this.debounce.unref?.()
  }

  private safeEvaluate(): void {
    try {
      this.evaluate()
    } catch (e) {
      this.lastError = (e as Error).message
      console.error('diagnostics evaluation failed', e)
    }
  }

  // ---- evaluation -----------------------------------------------------------------------------

  buildContext(): RuleContext {
    const settings = this.d.getSettings()
    const poll = settings.pollIntervalSec * 1000
    return {
      now: this.clock(),
      settings,
      devices: this.d.inventory.loadAll({ includeMissing: true }),
      collectors: this.d.getCollectors(),
      monitor: this.d.getMonitor(),
      lastInventoryScanAt: this.d.inventory.lastScanAt(),
      metrics: this.d.getMetrics?.() ?? null,
      ...(this.d.getMetricWindow ? { metricWindow: this.d.getMetricWindow } : {}),
      recentEvents: this.d.events.recent(500),
      freshMs: Math.max(poll * 3, 120_000),
      staleMs: Math.max(poll * 5, 300_000)
    }
  }

  evaluate(): EvaluationSummary {
    if (this.evaluating) return { created: 0, updated: 0, resolved: 0, reopened: 0, ruleErrors: 0, at: this.clock().toISOString() }
    this.evaluating = true
    try {
      const ctx = this.buildContext()
      const nowIso = ctx.now.toISOString()
      const sum: EvaluationSummary = { created: 0, updated: 0, resolved: 0, reopened: 0, ruleErrors: 0, at: nowIso }
      const events: Parameters<EventBus['publish']>[0][] = []
      const disabled = new Set(ctx.settings.diagDisabledRules)

      // 1) Run rules (pure, no DB writes). A throwing rule affects only itself.
      const results: { rule: DiagnosticRule; run: RuleRunRecord; result: RuleResult | null }[] = []
      for (const rule of this.rules) {
        const t0 = performance.now()
        const base = { ruleId: rule.id, ruleVersion: rule.version, startedAt: nowIso }
        if (disabled.has(rule.id)) {
          results.push({ rule, result: null, run: { ...base, durationMs: 0, outcome: 'disabled', message: 'Disabled in settings', findings: 0 } })
          continue
        }
        try {
          const result = rule.evaluate(ctx)
          const dur = Math.round(performance.now() - t0)
          results.push({
            rule, result,
            run: result.status === 'evaluated'
              ? { ...base, durationMs: dur, outcome: 'evaluated', message: null, findings: result.findings.length }
              : { ...base, durationMs: dur, outcome: 'insufficient_data', message: result.reason, findings: 0 }
          })
        } catch (e) {
          sum.ruleErrors++
          results.push({ rule, result: null, run: { ...base, durationMs: Math.round(performance.now() - t0), outcome: 'error', message: (e as Error).message, findings: 0 } })
        }
      }

      // 2) Apply everything atomically.
      transaction(this.d.db, () => {
        for (const { rule, result, run } of results) {
          if (run.outcome === 'disabled') {
            for (const f of this.repo.byRule(rule.id)) if (f.status !== 'resolved') this.resolve(f, nowIso, 'Rule disabled', events, sum, false)
          } else if (result?.status === 'evaluated') {
            this.apply(rule, result.findings, result.retain ?? [], nowIso, events, sum, run)
          }
          this.repo.insertRun(run)
        }
        this.repo.pruneRuns()
      })
      this.lastEvaluatedAt = nowIso
      this.lastError = null
      for (const e of events) this.d.bus.publish(e)
      return sum
    } finally {
      this.evaluating = false
    }
  }

  private apply(rule: DiagnosticRule, raw: RuleFinding[], retain: string[], nowIso: string, events: Parameters<EventBus['publish']>[0][], sum: EvaluationSummary, run: RuleRunRecord): void {
    const existing = new Map(this.repo.byRule(rule.id).map((f) => [f.subjectKey, f]))
    const keep = new Set(retain)
    const seen = new Set<string>()
    for (const rf of raw) {
      // Evidence is mandatory for anything above `info`.
      if (rf.severity !== 'info' && rf.evidence.length === 0) {
        sum.ruleErrors++
        run.outcome = 'error'
        run.message = `Rule produced a ${rf.severity} finding for "${rf.subject}" without evidence; discarded`
        continue
      }
      if (seen.has(rf.subject)) continue
      seen.add(rf.subject)
      const id = findingId(rule.id, rf.subject)
      const prev = existing.get(rf.subject)
      const body = {
        id, ruleId: rule.id, ruleVersion: rule.version, subjectKey: rf.subject, severity: rf.severity, category: rule.category, title: rf.title,
        description: rf.description, deviceIds: rf.deviceIds, evidence: rf.evidence, confidence: rf.confidence ?? null, recommendation: rf.recommendation
      }
      const mk = (over: Partial<Finding>): Finding =>
        FindingSchema.parse({
          ...body, status: 'active', firstDetectedAt: nowIso, lastSeenAt: nowIso, updatedAt: nowIso, acknowledgedAt: null, resolvedAt: null, resolutionReason: null, ...over
        })
      if (!prev) {
        this.repo.upsert(mk({}))
        sum.created++
        events.push(this.event('diagnostic.created', mk({})))
      } else if (prev.status === 'resolved') {
        const f = mk({})
        this.repo.upsert(f)
        sum.reopened++
        events.push(this.event('diagnostic.created', f))
      } else {
        // Same finding still present: refresh the body, keep the user's status — unless it got worse.
        const escalated = sevRank(rf.severity) > sevRank(prev.severity) && (prev.status === 'acknowledged' || prev.status === 'dismissed')
        const f = mk({
          status: escalated ? 'active' : prev.status, firstDetectedAt: prev.firstDetectedAt,
          acknowledgedAt: escalated ? null : prev.acknowledgedAt, resolutionReason: escalated ? null : prev.resolutionReason
        })
        this.repo.upsert(f)
        sum.updated++
        if (escalated) events.push(this.event('diagnostic.created', f))
      }
    }
    // Safe resolution: only for subjects the rule actually evaluated and no longer reports.
    for (const [subject, f] of existing) {
      if (seen.has(subject) || keep.has(subject) || f.status === 'resolved') continue
      this.resolve(f, nowIso, 'Condition no longer present', events, sum, true)
    }
  }

  private resolve(f: Finding, nowIso: string, reason: string, events: Parameters<EventBus['publish']>[0][], sum: EvaluationSummary | null, notify: boolean): void {
    const next: Finding = { ...f, status: 'resolved', resolvedAt: nowIso, updatedAt: nowIso, resolutionReason: reason }
    this.repo.upsert(next)
    if (sum) sum.resolved++
    if (notify && f.status !== 'dismissed') events.push(this.event('diagnostic.resolved', next))
  }

  private event(type: 'diagnostic.created' | 'diagnostic.resolved', f: Finding): Parameters<EventBus['publish']>[0] {
    return {
      type, summary: type === 'diagnostic.created' ? `[${f.severity}] ${f.title}` : `Resolved: ${f.title}`, deviceId: f.deviceIds[0] ?? null,
      data: { findingId: f.id, severity: f.severity, ruleId: f.ruleId }
    } as Parameters<EventBus['publish']>[0]
  }

  // ---- user actions ---------------------------------------------------------------------------

  setStatus(id: string, action: FindingAction, reason?: string): Finding {
    const f = this.repo.get(id)
    if (!f) throw new Error('Finding not found')
    const now = this.clock().toISOString()
    const bad = (): never => { throw new Error(`Cannot ${action} a finding that is ${f.status}`) }
    let next: Finding
    switch (action) {
      case 'acknowledge':
        if (f.status !== 'active') bad()
        next = { ...f, status: 'acknowledged', acknowledgedAt: now, updatedAt: now }
        break
      case 'dismiss':
        if (f.status !== 'active' && f.status !== 'acknowledged') bad()
        next = { ...f, status: 'dismissed', updatedAt: now, resolutionReason: reason?.trim() || 'Dismissed by user' }
        break
      case 'resolve':
        if (f.status === 'resolved') bad()
        next = { ...f, status: 'resolved', resolvedAt: now, updatedAt: now, resolutionReason: reason?.trim() || 'Marked resolved by user' }
        break
      case 'reopen':
        if (f.status === 'active') bad()
        next = { ...f, status: 'active', acknowledgedAt: null, resolvedAt: null, resolutionReason: null, updatedAt: now }
        break
    }
    this.repo.upsert(FindingSchema.parse(next!))
    if (action === 'resolve') this.d.bus.publish(this.event('diagnostic.resolved', next!))
    return next!
  }

  // ---- queries --------------------------------------------------------------------------------

  list(f: Parameters<DiagnosticsRepo['list']>[0]): Finding[] {
    return this.repo.list(f)
  }

  detail(id: string): FindingDetail | null {
    const finding = this.repo.get(id)
    if (!finding) return null
    const rule = this.ruleInfos().find((r) => r.id === finding.ruleId) ?? null
    const devices = finding.deviceIds.flatMap((did) => {
      const d = this.d.inventory.get(did, [])
      return d ? [{ id: d.device.id, name: d.device.name, category: d.device.category, presence: d.device.presence }] : []
    })
    return { finding, rule, devices }
  }

  private ruleInfos(): RuleInfo[] {
    const disabled = new Set(this.d.getSettings().diagDisabledRules)
    const runs = this.repo.lastRuns()
    return this.rules.map((r) => {
      const run = runs.get(r.id)
      return {
        id: r.id, version: r.version, title: r.title, category: r.category, description: r.description, severityPolicy: r.severityPolicy, dataUsed: r.dataUsed,
        enabled: !disabled.has(r.id),
        lastRun: run ? { startedAt: run.startedAt, durationMs: run.durationMs, outcome: run.outcome, message: run.message, findings: run.findings } : null
      }
    })
  }

  hasRule(id: string): boolean {
    return this.rules.some((r) => r.id === id)
  }

  status(): DiagnosticsStatus {
    const settings = this.d.getSettings()
    const lastScan = this.d.inventory.lastScanAt()
    const staleMs = Math.max(settings.pollIntervalSec * 5000, 300_000)
    return {
      lastEvaluatedAt: this.lastEvaluatedAt,
      evaluating: this.evaluating,
      lastError: this.lastError,
      dataStale: !lastScan || this.clock().getTime() - Date.parse(lastScan) > staleMs,
      lastInventoryScanAt: lastScan,
      counts: this.repo.counts(),
      rules: this.ruleInfos()
    }
  }
}

export type { HipEvent }
