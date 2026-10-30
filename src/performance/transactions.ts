import type { CommandRunner } from '@collectors/core/runner'
import type { HelperStatus } from '../privileged/helpers'
import { isUnknown, type Assignment, type CapabilityService, type Snapshot } from './capabilities'
import { ordered, validate } from './profiles'
import type { PerfControl, TxItem, TxRecord, TxStatus } from './types'

export interface TxStore {
  startTx(kind: TxRecord['kind'], label: string, fingerprint: string, items: TxItem[], at: string): number
  finishTx(id: number, status: TxStatus, items: TxItem[], error: string | null, at: string): void
  getTx(id: number): TxRecord | null
}

/** One operation at a time across tuning and testing: a test must not run while settings change, and vice versa. */
export class PerfLock {
  holder: 'tuning' | 'testing' | null = null
  take(who: 'tuning' | 'testing'): void {
    if (this.holder) throw new Error(this.holder === 'tuning' ? 'Another tuning change is still being applied. Wait for it to finish.' : 'A performance test is running. Stop it before changing settings.')
    this.holder = who
  }
  release(): void { this.holder = null }
}

export interface TuningDeps {
  caps: CapabilityService
  run: CommandRunner
  store: TxStore
  lock: PerfLock
  helper: () => Promise<HelperStatus>
  now?: () => Date
}

interface HelperOutcome { ok: boolean; error: string | null; cancelled: boolean }

/**
 * Applies settings as transactions: validate against this device → record previous values → apply
 * through the installed helper → read every setting back from the kernel → verify. If the helper
 * fails part-way, everything that did change is rolled back to its previous value and that rollback
 * is verified too. Nothing is reported as applied just because a command exited successfully.
 */
export class TuningService {
  constructor(private d: TuningDeps) {}

  private now(): string { return (this.d.now?.() ?? new Date()).toISOString() }

  private async runHelper(path: string, a: Assignment[]): Promise<HelperOutcome> {
    const r = await this.d.run('pkexec', [path, ...a.map(([k, v]) => `${k}=${v}`)], { timeoutMs: 180_000 })
    if (r.ok) return { ok: true, error: null, cancelled: false }
    if (r.notFound) return { ok: false, error: 'pkexec is not installed, so administrator rights cannot be requested.', cancelled: true }
    if (r.code === 126) return { ok: false, error: 'Cancelled: the password dialog was closed.', cancelled: true }
    if (r.code === 127) return { ok: false, error: 'Not authorised: administrator rights were refused.', cancelled: true }
    if (r.timedOut) return { ok: false, error: 'The helper did not finish in time.', cancelled: false }
    return { ok: false, error: r.stderr.split('\n').find((l) => l.startsWith('ERROR '))?.slice(6) ?? (r.stderr.trim() || `the helper failed (exit ${r.code})`), cancelled: false }
  }

  /** Effective value read back for one requested setting, and whether it confirms the request. */
  private readBack(s: Snapshot, id: string, raw: string): { effective: string | null; ok: boolean | null } {
    if (id.endsWith('.od_reset')) return { effective: null, ok: null }
    const d = this.d.caps.describe(s, id, raw)
    if (isUnknown(d.from)) return { effective: null, ok: null }
    return { effective: d.from, ok: d.from === d.to }
  }

  async apply(kind: TxRecord['kind'], label: string, requested: Assignment[], controls: PerfControl[]): Promise<TxRecord | null> {
    this.d.lock.take('tuning')
    try {
      const helper = await this.d.helper()
      if (!helper.usable) throw new Error(helper.reason ?? 'The privileged helper is not available.')
      const byId = new Map(controls.map((c) => [c.id, c]))
      const problems = requested.map(([id, raw]) => validate(byId, id, raw)).filter((x): x is string => x !== null)
      if (problems.length) throw new Error(`Nothing was changed. ${problems.join('; ')}.`)

      const s0 = await this.d.caps.snapshot()
      const fp = this.d.caps.fingerprint(s0)
      const previous = new Map(this.d.caps.baselineOf(s0))
      // Only what differs is written, so a setting that already matches is never touched.
      const plan = ordered(requested).filter(([id, raw]) => id.endsWith('.od_reset') || this.d.caps.describe(s0, id, raw).from !== this.d.caps.describe(s0, id, raw).to)
      if (!plan.length) return null
      const items: TxItem[] = plan.map(([id, raw]) => {
        const d = this.d.caps.describe(s0, id, raw)
        return { controlId: id, label: d.label, previousRaw: previous.get(id) ?? null, previous: isUnknown(d.from) ? null : d.from, requestedRaw: raw, requested: d.to, effective: null, verification: 'pending', message: null }
      })
      const txId = this.d.store.startTx(kind, label, fp, items, this.now())

      const outcome = await this.runHelper(helper.path, plan)
      const s1 = await this.d.caps.snapshot()
      for (const it of items) {
        const rb = this.readBack(s1, it.controlId, it.requestedRaw)
        it.effective = rb.effective
        const unchanged = rb.effective !== null && rb.effective === it.previous
        if (!outcome.ok && (unchanged || rb.ok === null)) it.verification = 'not_applied'
        else if (rb.ok === null) { it.verification = 'unverifiable'; it.message = 'The value cannot be read back, so the change cannot be confirmed.' }
        else if (rb.ok) it.verification = 'verified'
        else { it.verification = 'mismatch'; it.message = `Requested ${it.requested}, the kernel reports ${rb.effective}.` }
      }

      let status: TxStatus
      let error = outcome.error
      if (!outcome.ok) {
        // Part of the change may have happened: put back everything that moved.
        const changed = items.filter((i) => (i.verification === 'verified' || i.verification === 'mismatch') && i.previousRaw !== null)
        if (!changed.length) status = 'failed'
        else {
          const back = await this.runHelper(helper.path, ordered(changed.map((i) => [i.controlId, i.previousRaw!] as Assignment)))
          const s2 = await this.d.caps.snapshot()
          for (const i of changed) {
            const rb = this.readBack(s2, i.controlId, i.previousRaw!)
            i.effective = rb.effective ?? i.effective
            i.verification = rb.ok ? 'rolled_back' : 'rollback_failed'
            if (!rb.ok) i.message = `Could not be put back${back.error ? ` (${back.error})` : ''}: it is now ${rb.effective ?? 'unknown'}, was ${i.previous ?? 'unknown'}.`
          }
          status = changed.some((i) => i.verification === 'rollback_failed') ? 'rollback_failed' : 'rolled_back'
          error = `${outcome.error ?? 'The change failed'}${status === 'rolled_back' ? ' The settings that had changed were restored.' : ''}`
        }
      } else {
        const v = items.filter((i) => i.verification === 'verified').length
        const m = items.filter((i) => i.verification === 'mismatch').length
        status = v === items.length ? 'verified' : m === 0 && v === 0 ? 'unverifiable' : v > 0 ? 'partially_verified' : 'mismatch'
      }
      this.d.store.finishTx(txId, status, items, error, this.now())
      return this.d.store.getTx(txId)
    } finally {
      this.d.lock.release()
    }
  }
}
