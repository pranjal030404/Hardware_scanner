import type { CollectorHealth, EvidenceRef, FindingCategory, HipEvent, MetricsStatus, MonitorStatus, Settings, Severity } from '@shared/schemas'
import type { StoredDevice } from '@shared/stored'
import type { TestSession, TxRecord } from '../performance/types'

/** Performance-tuning state the performance rules read; absent when the feature is not available. */
export interface PerfDiagnosticsContext {
  tuningEnabled: boolean
  helperUsable: boolean
  helperReason: string | null
  lastTx: TxRecord | null
  failedRollbacks: TxRecord[]
  lastTest: TestSession | null
}

/** Recent samples of one metric on one device, oldest first. */
export interface MetricWindow {
  deviceId: string
  deviceName: string
  metric: string
  unit: string
  source: string
  points: { t: number; v: number }[]
  stale: boolean
}

export interface RuleContext {
  now: Date
  settings: Settings
  /** Present AND missing devices; rules decide which they need. */
  devices: StoredDevice[]
  collectors: CollectorHealth[]
  monitor: MonitorStatus | null
  lastInventoryScanAt: string | null
  /** Metric sampler state; null when unknown. */
  metrics?: MetricsStatus | null
  /** Samples of `metric` (exact name) over the last `windowMs`, one entry per device. Absent when the sampler is unavailable. */
  metricWindow?: (metric: string, windowMs: number) => MetricWindow[]
  /** Recent persisted device events (newest first), bounded window. */
  recentEvents: HipEvent[]
  /** Observations older than this are not evidence of the present state. */
  freshMs: number
  /** After this long without any scan the whole inventory counts as stale. */
  staleMs: number
  performance?: PerfDiagnosticsContext | null
}

export interface RuleFinding {
  /** Stable identity of the thing the finding is about; with the rule id it dedupes repeated evaluations. */
  subject: string
  severity: Severity
  title: string
  description: string
  deviceIds: string[]
  /** Required for every severity above `info`. */
  evidence: EvidenceRef[]
  confidence?: number
  recommendation: string
}

export type RuleResult =
  | {
      status: 'evaluated'
      findings: RuleFinding[]
      /** Subjects that could not be evaluated this time: their existing findings are left untouched, not resolved. */
      retain?: string[]
    }
  | { status: 'insufficient_data'; reason: string }

export interface DiagnosticRule {
  id: string
  version: number
  title: string
  category: FindingCategory
  /** What the rule checks, shown to the user. */
  description: string
  /** How severity is chosen. */
  severityPolicy: string
  /** Which stored data the rule consumes. */
  dataUsed: string
  evaluate(ctx: RuleContext): RuleResult
}

export const isFresh = (iso: string | null | undefined, ctx: Pick<RuleContext, 'now' | 'freshMs'>): boolean =>
  !!iso && ctx.now.getTime() - Date.parse(iso) <= ctx.freshMs
