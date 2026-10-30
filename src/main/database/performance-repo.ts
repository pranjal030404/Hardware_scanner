import type { ItemVerification, TestMode, TestSample, TestSession, TestStatus, TestSummary, TxItem, TxRecord, TxStatus } from '../../performance/types'
import { transaction, type Db } from './db'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export interface SavedProfile {
  id: number
  name: string
  fingerprint: string
  createdAt: string
  settings: [string, string][]
}

const itemFromRow = (r: Row): TxItem => ({
  controlId: r.control_id, label: r.label, previousRaw: r.previous_raw, previous: r.previous, requestedRaw: r.requested_raw,
  requested: r.requested, effective: r.effective, verification: r.verification as ItemVerification, message: r.message
})

const sessionFromRow = (r: Row): TestSession => ({
  id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, mode: r.mode as TestMode, durationS: r.duration_s, intervalMs: r.interval_ms,
  threads: r.threads, status: r.status as TestStatus, fingerprint: r.fingerprint, txId: r.tx_id, profile: r.profile,
  summary: JSON.parse(r.summary) as TestSummary, error: r.error
})

/** Tuning transactions, saved profiles and test sessions. */
export class PerformanceRepo {
  constructor(private db: Db) {}

  // ---- transactions --------------------------------------------------------------------------

  startTx(kind: TxRecord['kind'], label: string, fingerprint: string, items: TxItem[], at: string): number {
    return transaction(this.db, () => {
      const id = Number(this.db.prepare('INSERT INTO perf_transactions (started_at, kind, label, fingerprint, status) VALUES (?,?,?,?,?)').run(at, kind, label, fingerprint, 'running').lastInsertRowid)
      const ins = this.db.prepare('INSERT INTO perf_transaction_items (tx_id, control_id, label, previous_raw, previous, requested_raw, requested, effective, verification, message) VALUES (?,?,?,?,?,?,?,?,?,?)')
      for (const i of items) ins.run(id, i.controlId, i.label, i.previousRaw, i.previous, i.requestedRaw, i.requested, i.effective, i.verification, i.message)
      return id
    })
  }

  finishTx(id: number, status: TxStatus, items: TxItem[], error: string | null, at: string): void {
    transaction(this.db, () => {
      this.db.prepare('UPDATE perf_transactions SET status = ?, error = ?, finished_at = ? WHERE id = ?').run(status, error, at, id)
      const upd = this.db.prepare('UPDATE perf_transaction_items SET effective = ?, verification = ?, message = ? WHERE tx_id = ? AND control_id = ?')
      for (const i of items) upd.run(i.effective, i.verification, i.message, id, i.controlId)
    })
  }

  private txFromRow(r: Row): TxRecord {
    const items = (this.db.prepare('SELECT * FROM perf_transaction_items WHERE tx_id = ? ORDER BY id').all(r.id) as Row[]).map(itemFromRow)
    return { id: r.id, startedAt: r.started_at, finishedAt: r.finished_at, kind: r.kind, label: r.label, fingerprint: r.fingerprint, status: r.status as TxStatus, error: r.error, items }
  }

  getTx(id: number): TxRecord | null {
    const r = this.db.prepare('SELECT * FROM perf_transactions WHERE id = ?').get(id) as Row | undefined
    return r ? this.txFromRow(r) : null
  }

  recentTx(limit = 50): TxRecord[] {
    return (this.db.prepare('SELECT * FROM perf_transactions ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map((r) => this.txFromRow(r))
  }

  lastTx(fingerprint: string): TxRecord | null {
    const r = this.db.prepare('SELECT * FROM perf_transactions WHERE fingerprint = ? ORDER BY id DESC LIMIT 1').get(fingerprint) as Row | undefined
    return r ? this.txFromRow(r) : null
  }

  /** The most recent change on this device that actually changed something and has not been undone. */
  lastUndoable(fingerprint: string): TxRecord | null {
    const r = this.db.prepare(`SELECT * FROM perf_transactions WHERE fingerprint = ? AND status NOT IN ('running','failed','rolled_back') AND kind != 'rollback'
      AND EXISTS (SELECT 1 FROM perf_transaction_items i WHERE i.tx_id = perf_transactions.id AND i.verification IN ('verified','mismatch','unverifiable') AND i.previous_raw IS NOT NULL)
      ORDER BY id DESC LIMIT 1`).get(fingerprint) as Row | undefined
    return r ? this.txFromRow(r) : null
  }

  /** For each control, the value it had before the app first changed it on this device. */
  originalValues(fingerprint: string): Map<string, { raw: string; label: string; display: string | null }> {
    const rows = this.db.prepare(`SELECT i.control_id, i.previous_raw, i.label, i.previous FROM perf_transaction_items i JOIN perf_transactions t ON t.id = i.tx_id
      WHERE t.fingerprint = ? AND i.previous_raw IS NOT NULL AND i.verification IN ('verified','mismatch','unverifiable','rolled_back','rollback_failed') ORDER BY i.id ASC`).all(fingerprint) as Row[]
    const out = new Map<string, { raw: string; label: string; display: string | null }>()
    for (const r of rows) if (!out.has(r.control_id)) out.set(r.control_id, { raw: r.previous_raw, label: r.label, display: r.previous })
    return out
  }

  /** Controls whose writes were read back successfully on this device at least once. */
  verifiedControls(fingerprint: string): Set<string> {
    const rows = this.db.prepare(`SELECT DISTINCT i.control_id FROM perf_transaction_items i JOIN perf_transactions t ON t.id = i.tx_id WHERE t.fingerprint = ? AND i.verification = 'verified'`).all(fingerprint) as Row[]
    return new Set(rows.map((r) => r.control_id as string))
  }

  /** A change that was undone: it no longer counts as the last undoable change. */
  markRolledBack(id: number): void {
    this.db.prepare(`UPDATE perf_transactions SET status = 'rolled_back' WHERE id = ?`).run(id)
  }

  failedRollbacks(limit = 10): TxRecord[] {
    return (this.db.prepare(`SELECT * FROM perf_transactions WHERE status = 'rollback_failed' ORDER BY id DESC LIMIT ?`).all(limit) as Row[]).map((r) => this.txFromRow(r))
  }

  /** A transaction left "running" by a crash is closed honestly at startup. */
  closeInterrupted(at: string): number {
    return Number(this.db.prepare(`UPDATE perf_transactions SET status = 'unverifiable', error = 'The application stopped before this change could be verified', finished_at = ? WHERE status = 'running'`).run(at).changes)
  }

  // ---- profiles ------------------------------------------------------------------------------

  saveProfile(name: string, fingerprint: string, settings: [string, string][], at: string): number {
    return Number(this.db.prepare('INSERT INTO perf_profiles (name, fingerprint, created_at, settings) VALUES (?,?,?,?)').run(name, fingerprint, at, JSON.stringify(settings)).lastInsertRowid)
  }

  profiles(): SavedProfile[] {
    return (this.db.prepare('SELECT * FROM perf_profiles ORDER BY id').all() as Row[]).map((r) => ({ id: r.id, name: r.name, fingerprint: r.fingerprint, createdAt: r.created_at, settings: JSON.parse(r.settings) as [string, string][] }))
  }

  deleteProfile(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM perf_profiles WHERE id = ?').run(id).changes) > 0
  }

  // ---- test sessions -------------------------------------------------------------------------

  startTest(s: Omit<TestSession, 'id' | 'finishedAt' | 'summary' | 'error' | 'status'>): number {
    return Number(this.db.prepare('INSERT INTO perf_test_sessions (started_at, mode, duration_s, interval_ms, threads, status, fingerprint, tx_id, profile) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(s.startedAt, s.mode, s.durationS, s.intervalMs, s.threads, 'running', s.fingerprint, s.txId, s.profile).lastInsertRowid)
  }

  finishTest(id: number, status: TestStatus, summary: TestSummary, samples: TestSample[], error: string | null, at: string): void {
    transaction(this.db, () => {
      this.db.prepare('UPDATE perf_test_sessions SET status = ?, summary = ?, error = ?, finished_at = ? WHERE id = ?').run(status, JSON.stringify(summary), error, at, id)
      const ins = this.db.prepare('INSERT INTO perf_test_samples (session_id, t_ms, data) VALUES (?,?,?)')
      for (const s of samples) ins.run(id, s.tMs, JSON.stringify(s))
    })
  }

  tests(limit = 50): TestSession[] {
    return (this.db.prepare('SELECT * FROM perf_test_sessions ORDER BY id DESC LIMIT ?').all(limit) as Row[]).map(sessionFromRow)
  }

  test(id: number): { session: TestSession; samples: TestSample[] } | null {
    const r = this.db.prepare('SELECT * FROM perf_test_sessions WHERE id = ?').get(id) as Row | undefined
    if (!r) return null
    const samples = (this.db.prepare('SELECT data FROM perf_test_samples WHERE session_id = ? ORDER BY t_ms').all(id) as Row[]).map((x) => JSON.parse(x.data) as TestSample)
    return { session: sessionFromRow(r), samples }
  }

  closeInterruptedTests(at: string): number {
    return Number(this.db.prepare(`UPDATE perf_test_sessions SET status = 'failed', error = 'The application stopped during the test', finished_at = ? WHERE status = 'running'`).run(at).changes)
  }

  /** History retention by age; profiles are kept. */
  prune(days: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString()
    return transaction(this.db, () =>
      Number(this.db.prepare(`DELETE FROM perf_transactions WHERE started_at < ? AND status != 'running'`).run(cutoff).changes) +
      Number(this.db.prepare(`DELETE FROM perf_test_sessions WHERE started_at < ? AND status != 'running'`).run(cutoff).changes))
  }
}
