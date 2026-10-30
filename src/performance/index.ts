import type { SysReader } from '@collectors/core/sysreader'
import type { CommandRunner } from '@collectors/core/runner'
import { helperStatus, type HelperStatus } from '../privileged/helpers'
import { CapabilityService, type Assignment, type Snapshot } from './capabilities'
import { BUILTIN_TITLES, builtinAssignments, makePlan, validate } from './profiles'
import { StabilityService, type WorkloadFactory } from './stability'
import { PerfLock, TuningService, type TxStore } from './transactions'
import type { BuiltinProfileId, PerfApplyResult, PerfControl, PerfLive, PerfState, ProfilePlan, TestMode, TestProgress, TestSample, TestSession, TestStatus, TestSummary, TxRecord } from './types'
import { windowsState } from './windows'

export { CapabilityService, unlockedCpu, parseOd, isUnknown, type Assignment, type Snapshot } from './capabilities'
export { builtinAssignments, makePlan, validate, ordered } from './profiles'
export { PerfLock, TuningService } from './transactions'
export { StabilityService, summarise, hashWorkload } from './stability'

export interface PerfStore extends TxStore {
  lastTx(fingerprint: string): TxRecord | null
  lastUndoable(fingerprint: string): TxRecord | null
  originalValues(fingerprint: string): Map<string, { raw: string; label: string; display: string | null }>
  verifiedControls(fingerprint: string): Set<string>
  markRolledBack(id: number): void
  recentTx(limit: number): TxRecord[]
  saveProfile(name: string, fingerprint: string, settings: [string, string][], at: string): number
  profiles(): { id: number; name: string; fingerprint: string; createdAt: string; settings: [string, string][] }[]
  deleteProfile(id: number): boolean
  startTest(s: Omit<TestSession, 'id' | 'finishedAt' | 'summary' | 'error' | 'status'>): number
  finishTest(id: number, status: TestStatus, summary: TestSummary, samples: TestSample[], error: string | null, at: string): void
  tests(limit: number): TestSession[]
  test(id: number): { session: TestSession; samples: TestSample[] } | null
}

export interface PerformanceDeps {
  reader: SysReader
  run: CommandRunner
  platform: string
  store: PerfStore
  /** Settings → "Tuning controls" switch. */
  tuningEnabled: () => boolean
  limits: () => { maxTestSeconds: number; minIntervalMs: number }
  threads: number
  cpus?: () => { model: string; speed: number }[]
  helper?: () => Promise<HelperStatus>
  exists?: (p: string) => Promise<boolean>
  stat?: (p: string) => Promise<{ mode: number }>
  workload?: WorkloadFactory
  now?: () => Date
  rateWindowMs?: number
}

const BUILTINS: BuiltinProfileId[] = ['stock', 'quiet', 'balanced', 'performance', 'maximum']

/** Performance tuning: capability discovery, profiles, verified transactions, history and test sessions. */
export class PerformanceService {
  readonly caps: CapabilityService
  readonly lock = new PerfLock()
  private tuning: TuningService
  readonly tests: StabilityService

  constructor(private d: PerformanceDeps) {
    this.caps = new CapabilityService({ reader: d.reader, run: d.run, platform: d.platform, stat: d.stat, now: d.now, rateWindowMs: d.rateWindowMs })
    this.tuning = new TuningService({ caps: this.caps, run: d.run, store: d.store, lock: this.lock, helper: () => this.helper(), now: d.now })
    this.tests = new StabilityService({
      live: () => this.caps.live(), store: d.store, lock: this.lock, threads: d.threads,
      fingerprint: async () => this.caps.fingerprint(await this.caps.snapshot()),
      context: async () => {
        const s = await this.caps.snapshot()
        const fp = this.caps.fingerprint(s)
        const st = await this.state(s)
        return { txId: d.store.lastTx(fp)?.id ?? null, profile: st.matches }
      },
      workload: d.workload, now: d.now ? () => d.now!().getTime() : undefined
    })
  }

  private helper(): Promise<HelperStatus> {
    return this.d.helper ? this.d.helper() : helperStatus('hip-perf-helper', this.d.platform)
  }

  private async context(s: Snapshot): Promise<{ fp: string; controls: PerfControl[]; helper: HelperStatus; originals: Map<string, string> }> {
    const fp = this.caps.fingerprint(s)
    const helper = await this.helper()
    const originals = new Map([...this.d.store.originalValues(fp)].map(([k, v]) => [k, v.raw]))
    const controls = await this.caps.controls(s, { helperUsable: helper.usable, helperReason: helper.reason, verified: this.d.store.verifiedControls(fp) })
    return { fp, controls, helper, originals }
  }

  private plans(s: Snapshot, fp: string, controls: PerfControl[]): ProfilePlan[] {
    const builtins = BUILTINS.map((id) => {
      const b = builtinAssignments(s, id)
      return makePlan(this.caps, s, controls, id, BUILTIN_TITLES[id], true, b.assignments, b.notes, b.skipped, null, b.risks)
    })
    const byId = new Map(controls.map((c) => [c.id, c]))
    const custom = this.d.store.profiles().map((p) => {
      let reason: string | null = null
      if (p.fingerprint !== fp) reason = 'Saved on different hardware (or before a hardware/driver change): it is not applied to this configuration.'
      else {
        const problems = p.settings.map(([id, raw]) => { const c = byId.get(id); return !c || c.status === 'unsupported' || c.status === 'unavailable' ? `${id} is not available` : validate(new Map([[id, { ...c, write: true }]]), id, raw) }).filter(Boolean)
        if (problems.length) reason = `Not applicable now: ${problems.join('; ')}.`
      }
      return makePlan(this.caps, s, controls, `custom:${p.id}`, p.name, false, p.settings, new Map(), [], reason)
    })
    return [...builtins, ...custom]
  }

  async state(snap?: Snapshot): Promise<PerfState> {
    if (this.d.platform === 'win32') return windowsState({ run: this.d.run, cpus: this.d.cpus ?? (() => []), now: () => this.d.now?.() ?? new Date(), exists: this.d.exists ?? (async () => false) })
    if (this.d.platform !== 'linux') {
      return { supported: false, monitoringOnly: true, reason: `Performance tuning is not implemented on ${this.d.platform}.`, platform: this.d.platform, fingerprint: '', tuningEnabled: false, helper: { usable: false, path: '', reason: null }, devices: [], telemetry: [], profiles: [], tuned: null, matches: null, lastTransaction: null, canUndo: false, canRestoreOriginal: false, busy: null }
    }
    const s = snap ?? (await this.caps.snapshot())
    const { fp, controls, helper, originals } = await this.context(s)
    const verified = this.d.store.verifiedControls(fp)
    const devices = await this.caps.devices(s, { helperUsable: helper.usable, helperReason: helper.reason, verified, originals })
    const profiles = this.plans(s, fp, controls)
    const matches = profiles.find((p) => p.builtin && p.changes.length === 0 && p.unchanged.length > 0)?.id ?? null
    return {
      supported: true, monitoringOnly: !controls.some((c) => c.write) || !this.d.tuningEnabled(), reason: null, platform: 'linux', fingerprint: fp,
      tuningEnabled: this.d.tuningEnabled(), helper: { usable: helper.usable, path: helper.path, reason: helper.reason },
      devices, telemetry: snap ? [] : await this.caps.telemetry(s), profiles, tuned: s.tuned, matches,
      lastTransaction: this.d.store.lastTx(fp), canUndo: this.d.store.lastUndoable(fp) !== null, canRestoreOriginal: originals.size > 0, busy: this.lock.holder
    }
  }

  live(): Promise<PerfLive> { return this.caps.live() }

  private guard(): void {
    if (this.d.platform !== 'linux') throw new Error('Tuning is only implemented on Linux.')
    if (!this.d.tuningEnabled()) throw new Error('Tuning controls are switched off in Settings → Features & controls. Monitoring still works.')
  }

  private async result(tx: TxRecord | null): Promise<PerfApplyResult> {
    return { state: await this.state(), transaction: tx }
  }

  /** Applies a built-in or saved profile. Only what differs is written; everything is read back. */
  async applyProfile(id: string): Promise<PerfApplyResult> {
    this.guard()
    const s = await this.caps.snapshot()
    const { fp, controls } = await this.context(s)
    const plan = this.plans(s, fp, controls).find((p) => p.id === id)
    if (!plan) throw new Error('Unknown profile.')
    if (!plan.compatible) throw new Error(plan.incompatibleReason ?? 'This profile does not fit this hardware.')
    return this.result(await this.tuning.apply('profile', plan.title, plan.changes.map((c) => [c.id, c.raw]), controls))
  }

  /** Applies individual values (CPU/GPU tuning, overclocking). Each must be a writable control of this device, within its range. */
  async applyCustom(values: { id: string; value: string }[], label: string): Promise<PerfApplyResult> {
    this.guard()
    const s = await this.caps.snapshot()
    const { controls } = await this.context(s)
    const a: Assignment[] = values.map((v) => [v.id, v.value])
    // OverDrive clock writes only take effect in the manual performance level.
    for (const [id] of [...a]) if (/^amdgpu\.[^.]+\.(sclk|mclk)_mhz$/.test(id) && !a.some(([x]) => x === `amdgpu.${id.split('.')[1]}.level`)) a.unshift([`amdgpu.${id.split('.')[1]}.level`, 'manual'])
    const byId = new Map(controls.map((c) => [c.id, c]))
    const problems = a.map(([id, raw]) => validate(byId, id, raw)).filter((x): x is string => x !== null)
    if (problems.length) throw new Error(`Nothing was changed. ${problems.join('; ')}.`)
    const pl1 = a.find(([id]) => id === 'rapl.pl1_uw')
    const pl2 = Number(a.find(([id]) => id === 'rapl.pl2_uw')?.[1] ?? s.rapl?.pl2?.limit ?? Infinity)
    if (pl1 && Number(pl1[1]) > pl2) throw new Error('Nothing was changed: sustained power (PL1) cannot be higher than short boost power (PL2).')
    return this.result(await this.tuning.apply('custom', label, a, controls))
  }

  async restore(target: 'stock' | 'undo' | 'original'): Promise<PerfApplyResult> {
    this.guard()
    const s = await this.caps.snapshot()
    const { fp, controls, originals } = await this.context(s)
    if (target === 'stock') {
      const b = builtinAssignments(s, 'stock')
      return this.result(await this.tuning.apply('restore', 'Restore stock settings', b.assignments, controls))
    }
    if (target === 'original') {
      if (!originals.size) throw new Error('No change has been recorded on this hardware, so there is nothing to restore.')
      return this.result(await this.tuning.apply('restore', 'Restore original settings', [...originals], controls))
    }
    const last = this.d.store.lastUndoable(fp)
    if (!last) throw new Error('There is no recorded change to undo on this hardware.')
    const back = last.items.filter((i) => i.previousRaw !== null && ['verified', 'mismatch', 'unverifiable'].includes(i.verification)).map((i) => [i.controlId, i.previousRaw!] as Assignment)
    const tx = await this.tuning.apply('rollback', `Undo: ${last.label}`, back, controls)
    if (!tx || tx.status === 'verified' || tx.status === 'partially_verified' || tx.status === 'unverifiable') this.d.store.markRolledBack(last.id)
    return this.result(tx)
  }

  history(limit = 50): TxRecord[] { return this.d.store.recentTx(limit) }

  /** Saves the current values of every writable control as a profile for this exact hardware. */
  async saveProfile(name: string): Promise<PerfState> {
    const s = await this.caps.snapshot()
    const { fp, controls } = await this.context(s)
    const writable = new Set(controls.filter((c) => c.status !== 'unsupported' && c.status !== 'unavailable' && c.status !== 'error').map((c) => c.id))
    const settings = this.caps.baselineOf(s).filter(([id]) => writable.has(id))
    if (!settings.length) throw new Error('This device has no writable settings to save.')
    this.d.store.saveProfile(name, fp, settings, (this.d.now?.() ?? new Date()).toISOString())
    return this.state()
  }

  async deleteProfile(id: number): Promise<PerfState> {
    this.d.store.deleteProfile(id)
    return this.state()
  }

  async startTest(mode: TestMode, seconds: number, intervalMs: number): Promise<TestProgress> {
    if (this.d.platform !== 'linux') throw new Error('Test sessions are only implemented on Linux.')
    const lim = this.d.limits()
    if (seconds > lim.maxTestSeconds) throw new Error(`The longest allowed test is ${lim.maxTestSeconds} s (Settings).`)
    if (intervalMs < lim.minIntervalMs) throw new Error(`The shortest allowed sampling interval is ${lim.minIntervalMs} ms (Settings).`)
    return this.tests.start(mode, seconds, intervalMs)
  }

  listTests(limit = 30): TestSession[] { return this.d.store.tests(limit) }
  getTest(id: number): { session: TestSession; samples: TestSample[] } | null { return this.d.store.test(id) }
}
