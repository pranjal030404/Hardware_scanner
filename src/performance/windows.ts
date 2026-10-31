import { createHash } from 'node:crypto'
import { cpus as osCpus, totalmem, freemem } from 'node:os'
import type { CommandRunner } from '@collectors/core/runner'
import type { Assignment } from './capabilities'
import { BUILTIN_TITLES, validate } from './profiles'
import { StabilityService, type WorkloadFactory } from './stability'
import { PerfLock } from './transactions'
import type { PerfStore } from './index'
import type {
  BuiltinProfileId, Measurement, PerfApplyResult, PerfControl, PerfDevice, PerfLive, PerfState, PerfSetting,
  PresetChange, ProfilePlan, TestMode, TestProgress, TxItem, TxRecord, TxStatus
} from './types'
import { psQuote, runElevatedPowerShell, runPowerShell } from '../platform/windows'

/** Fixed locations of NVIDIA's documented management tool on Windows (never a PATH lookup). */
export const NVIDIA_SMI_WINDOWS = ['C:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe']

const BUILTINS: BuiltinProfileId[] = ['stock', 'quiet', 'balanced', 'performance', 'maximum']

interface PlanRow { name: string; guid: string }
interface GpuRow { name: string; temp: number | null; power: number | null; util: number | null; sm: number | null; mem: number | null; used: number | null; total: number | null; limit: number | null; def: number | null; min: number | null; max: number | null }

interface Snapshot {
  cpus: { model: string; speed: number }[]
  plans: PlanRow[]
  active: PlanRow | null
  minPct: number | null
  maxPct: number | null
  gpu: GpuRow | null
  smi: string | null
  memory: { totalKb: number; availableKb: number }
}

export interface WindowsPerfDeps {
  run: CommandRunner
  store: PerfStore
  tuningEnabled: () => boolean
  limits: () => { maxTestSeconds: number; minIntervalMs: number }
  threads: number
  cpus: () => { model: string; speed: number }[]
  exists: (p: string) => Promise<boolean>
  now: () => Date
  lock: PerfLock
  workload?: WorkloadFactory
}

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

const sameRaw = (a: string | null, b: string): boolean => {
  if (a === null) return false
  if (a === b) return true
  const x = Number(a); const y = Number(b)
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 0.01
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(n)))

const setting = (label: string, current: string, best = '—'): PerfSetting => ({ label, current, allowed: '—', best, adjustable: false })

const display = (c: PerfControl, raw: string | null): string | null => {
  if (raw === null) return null
  if (c.options) return raw
  const n = Number(raw)
  if (!Number.isFinite(n)) return raw
  const shown = c.scale && c.scale !== 1 ? n / c.scale : n
  return c.unit ? `${Math.round(shown * 10) / 10} ${c.unit}` : String(Math.round(shown * 10) / 10)
}

/**
 * Windows tuning. Only documented, machine-readable interfaces are used: `powercfg` for the active
 * power plan and the processor minimum/maximum state (the same limits Windows exposes in its own
 * power options), and `nvidia-smi` for the NVIDIA board power limit. Changing any of them needs
 * administrator rights, so the user is asked through the normal UAC prompt. CPU multiplier and
 * voltage are firmware settings: no runtime interface is invented for them.
 */
export class WindowsPerformance {
  private smi: string | null | undefined
  private previousTimes: { idle: number; total: number } | null = null
  readonly tests: StabilityService

  constructor(private d: WindowsPerfDeps) {
    this.tests = new StabilityService({
      live: () => this.live(), store: d.store, lock: d.lock, threads: d.threads,
      fingerprint: async () => (await this.read()).fingerprint,
      context: async () => {
        const snap = await this.read()
        const st = await this.state(snap)
        return { txId: d.store.lastTx(snap.fingerprint)?.id ?? null, profile: st.matches }
      },
      workload: d.workload, now: () => d.now().getTime()
    })
  }

  private now(): string { return this.d.now().toISOString() }

  private async resolveSmi(): Promise<string | null> {
    if (this.smi !== undefined) return this.smi
    this.smi = null
    for (const p of NVIDIA_SMI_WINDOWS) if (await this.d.exists(p)) { this.smi = p; break }
    return this.smi
  }

  private async readGpu(smi: string | null): Promise<GpuRow | null> {
    if (!smi) return null
    const q = await this.d.run(smi, ['--query-gpu=name,temperature.gpu,power.draw,utilization.gpu,clocks.sm,clocks.mem,memory.used,memory.total,power.limit,power.default_limit,power.min_limit,power.max_limit', '--format=csv,noheader,nounits'], { timeoutMs: 5000 })
    if (!q.ok) return null
    const f = q.stdout.split(/\r?\n/)[0]?.split(',').map((x) => x.trim())
    if (!f || f.length < 8) return null
    return {
      name: f[0] || 'NVIDIA GPU', temp: num(f[1]), power: num(f[2]), util: num(f[3]), sm: num(f[4]), mem: num(f[5]),
      used: num(f[6]), total: num(f[7]), limit: num(f[8]), def: num(f[9]), min: num(f[10]), max: num(f[11])
    }
  }

  private parsePlans(text: string): PlanRow[] {
    const out: PlanRow[] = []
    for (const m of text.matchAll(/GUID:\s*([0-9a-fA-F-]{36})\s*\(([^)]*)\)/g)) out.push({ guid: m[1]!.toLowerCase(), name: m[2]!.trim() })
    return out
  }

  private async read(): Promise<Snapshot & { fingerprint: string }> {
    const cpus = this.d.cpus()
    const plansRes = await runPowerShell(this.d.run, '& powercfg.exe /list')
    const plans = plansRes.ok ? this.parsePlans(plansRes.stdout) : []
    const activeRes = await runPowerShell(this.d.run, '& powercfg.exe /getactivescheme')
    const active = activeRes.ok ? (this.parsePlans(activeRes.stdout)[0] ?? null) : null
    if (active && !plans.some((p) => p.guid === active.guid)) plans.push(active)

    const pct = async (setting: string): Promise<number | null> => {
      const r = await runPowerShell(this.d.run, `& powercfg.exe /query SCHEME_CURRENT SUB_PROCESSOR ${setting}`)
      const m = r.ok ? /Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)/.exec(r.stdout) : null
      return m ? parseInt(m[1]!, 16) : null
    }
    const [minPct, maxPct] = await Promise.all([pct('PROCTHROTTLEMIN'), pct('PROCTHROTTLEMAX')])
    const smi = await this.resolveSmi()
    const gpu = await this.readGpu(smi)
    const memory = { totalKb: Math.round(totalmem() / 1024), availableKb: Math.round(freemem() / 1024) }
    const fingerprint = `win32:${createHash('sha256').update(`${cpus[0]?.model ?? 'cpu'}|${cpus.length}|${gpu?.name ?? ''}`).digest('hex').slice(0, 16)}`
    return { cpus, plans, active, minPct, maxPct, gpu, smi, memory, fingerprint }
  }

  private cpuUtilization(): number | null {
    const times = osCpus().map((c) => c.times)
    const idle = times.reduce((a, t) => a + t.idle, 0)
    const total = times.reduce((a, t) => a + t.user + t.nice + t.sys + t.idle + t.irq, 0)
    const prev = this.previousTimes
    this.previousTimes = { idle, total }
    if (!prev) return null
    const di = idle - prev.idle; const dt = total - prev.total
    return dt > 0 ? Math.round((1 - di / dt) * 1000) / 10 : null
  }

  async live(): Promise<PerfLive> {
    const cpus = this.d.cpus()
    const avg = cpus.length ? Math.round(cpus.reduce((a, c) => a + c.speed, 0) / cpus.length) : null
    const smi = await this.resolveSmi()
    const q = smi ? await this.d.run(smi, ['--query-gpu=temperature.gpu,clocks.sm', '--format=csv,noheader,nounits'], { timeoutMs: 5000 }) : null
    const f = q?.ok ? q.stdout.split(/\r?\n/)[0]?.split(',').map((x) => x.trim()) : undefined
    const sources: Record<string, string> = { cpu: 'os.cpus()' }
    if (smi) sources.gpu = 'nvidia-smi'
    return {
      at: this.now(), cpuMHz: avg, cpuMaxMHz: cpus.length ? Math.max(...cpus.map((c) => c.speed)) : null,
      cpuUtilization: this.cpuUtilization(), gpuMHz: f ? num(f[1]) : null, gpuMaxMHz: null,
      temperatureC: f ? num(f[0]) : null, temperatureLimitC: null, throttleEvents: null, sources
    }
  }

  private controls(snap: Snapshot, verified: Set<string>): PerfControl[] {
    const at = this.now()
    const cs: PerfControl[] = []
    const status = (id: string): PerfControl['status'] => (verified.has(id) ? 'supported' : 'not_verified')
    if (snap.active && snap.plans.length) {
      cs.push({
        id: 'win.power_plan', deviceId: 'cpu', label: 'Power plan (active scheme)', status: status('win.power_plan'), read: true, write: true,
        current: snap.active.name, currentRaw: snap.active.name, options: snap.plans.map((p) => p.name), source: 'powercfg.exe /list', persistence: 'persistent',
        rebootRequired: false, restorable: true, risk: 'low', reason: null
      })
    }
    if (snap.maxPct !== null) {
      cs.push({
        id: 'win.cpu.max_pct', deviceId: 'cpu', label: 'Processor maximum state', status: status('win.cpu.max_pct'), read: true, write: true,
        current: `${snap.maxPct} %`, currentRaw: String(snap.maxPct), min: 1, max: 100, unit: '%', scale: 1, step: 1, rangeSource: 'Windows processor power policy (1–100 %)',
        source: 'powercfg.exe /query … PROCTHROTTLEMAX', persistence: 'persistent', rebootRequired: false, restorable: true, risk: 'medium', reason: null
      })
    }
    if (snap.minPct !== null) {
      cs.push({
        id: 'win.cpu.min_pct', deviceId: 'cpu', label: 'Processor minimum state', status: status('win.cpu.min_pct'), read: true, write: true,
        current: `${snap.minPct} %`, currentRaw: String(snap.minPct), min: 0, max: 100, unit: '%', scale: 1, step: 1, rangeSource: 'Windows processor power policy (0–100 %)',
        source: 'powercfg.exe /query … PROCTHROTTLEMIN', persistence: 'persistent', rebootRequired: false, restorable: true, risk: 'medium', reason: null
      })
    }
    const g = snap.gpu
    if (g && g.limit !== null && g.min !== null && g.max !== null) {
      cs.push({
        id: 'win.nvidia.power_w', deviceId: 'nvidia', label: 'Power limit', status: status('win.nvidia.power_w'), read: true, write: true,
        current: `${g.limit} W`, currentRaw: String(g.limit), min: g.min, max: g.max, unit: 'W', scale: 1, step: 1, rangeSource: `the card's own rating (${g.min}–${g.max} W)`,
        source: 'nvidia-smi --query-gpu=power.limit', persistence: 'runtime', rebootRequired: false, restorable: true, risk: 'medium', reason: null
      })
    }
    return cs
  }

  private devices(snap: Snapshot, cs: PerfControl[], originals: Map<string, { raw: string }>): PerfDevice[] {
    const out: PerfDevice[] = []
    if (snap.cpus.length) {
      const settings: PerfSetting[] = [
        setting('Model', snap.cpus[0]!.model), setting('Logical processors', String(snap.cpus.length)),
        setting('Nominal clock', `${snap.cpus[0]!.speed} MHz`),
        setting('Power plan', snap.active?.name ?? 'not reported'),
        setting('Processor state', snap.minPct !== null || snap.maxPct !== null ? `${snap.minPct ?? '?'}–${snap.maxPct ?? '?'} %` : 'not reported')
      ]
      const cpu = cs.filter((c) => c.deviceId === 'cpu')
      out.push({
        id: 'cpu', kind: 'cpu', label: snap.cpus[0]!.model, summary: `${snap.cpus.length} logical processors`, monitoringOnly: !cpu.some((c) => c.write),
        settings, controls: cpu,
        overclock: { supported: false, knobs: [], reason: 'Clock multiplier and voltage are firmware settings: Windows exposes processor power-policy limits only. Use the BIOS/UEFI or the CPU vendor’s tool.' }
      })
    }
    if (snap.gpu) {
      const g = snap.gpu
      const settings: PerfSetting[] = [
        setting('Temperature', g.temp !== null ? `${g.temp} °C` : 'not reported'),
        setting('Board power draw', g.power !== null ? `${g.power} W` : 'not reported'),
        setting('Graphics clock', g.sm !== null ? `${g.sm} MHz` : 'not reported'),
        setting('Memory clock', g.mem !== null ? `${g.mem} MHz` : 'not reported'),
        setting('Utilisation', g.util !== null ? `${g.util} %` : 'not reported'),
        setting('VRAM', g.used !== null && g.total !== null ? `${g.used} / ${g.total} MiB` : 'not reported')
      ]
      const nv = cs.filter((c) => c.deviceId === 'nvidia')
      out.push({
        id: 'nvidia', kind: 'nvidia', label: g.name, summary: 'nvidia-smi', monitoringOnly: !nv.some((c) => c.write), settings, controls: nv,
        overclock: { supported: false, knobs: [], reason: 'Clock and voltage offsets need the card vendor’s own utility. The documented board power limit is available above.' }
      })
    }
    const memCs = cs.filter((c) => c.deviceId === 'memory')
    const memSettings: PerfSetting[] = [
      setting('Installed memory', `${Math.round(snap.memory.totalKb / 1024)} MiB`),
      setting('Available memory', `${Math.round(snap.memory.availableKb / 1024)} MiB`),
      setting('Memory tuning', 'firmware (XMP/EXPO)')
    ]
    out.push({
      id: 'memory', kind: 'memory', label: 'Memory', summary: 'read-only on Windows', monitoringOnly: !memCs.some((c) => c.write),
      settings: memSettings, controls: memCs,
      overclock: { supported: false, knobs: [], reason: 'Memory clock and timings are set by the firmware (XMP/EXPO); Windows exposes no runtime interface.' }
    })
    void originals
    return out
  }

  private telemetry(snap: Snapshot, at: string): Measurement[] {
    const out: Measurement[] = []
    if (snap.cpus.length) out.push({ label: 'CPU clock (reported by Windows)', value: `${snap.cpus[0]!.speed} MHz`, source: 'os.cpus()', at, state: 'live', reason: 'Windows reports the processor’s current clock here, not a measured average.' })
    const g = snap.gpu
    if (g) {
      const rows: [string, string, number | null][] = [['temperature', '°C', g.temp], ['power', 'W', g.power], ['utilisation', '%', g.util], ['core clock', 'MHz', g.sm], ['memory clock', 'MHz', g.mem]]
      for (const [label, unit, v] of rows) out.push(v === null ? { label: `${g.name} ${label}`, value: null, source: 'nvidia-smi --query-gpu', at: null, state: 'unavailable', reason: 'Not reported by the driver.' } : { label: `${g.name} ${label}`, value: `${v} ${unit}`, source: 'nvidia-smi --query-gpu', at, state: 'live' })
      if (g.used !== null && g.total !== null) out.push({ label: `${g.name} VRAM used`, value: `${g.used} MiB of ${g.total}`, source: 'nvidia-smi --query-gpu', at, state: 'live' })
    }
    return out
  }

  private assignments(snap: Snapshot, id: BuiltinProfileId): { a: Assignment[]; notes: Map<string, string>; skipped: string[]; risks: Map<string, 'low' | 'medium' | 'high'> } {
    const a: Assignment[] = []
    const notes = new Map<string, string>()
    const skipped: string[] = []
    const risks = new Map<string, 'low' | 'medium' | 'high'>()
    const set = (cid: string, v: string, note?: string): void => { a.push([cid, v]); if (note) notes.set(cid, note) }
    const max = snap.maxPct !== null ? { stock: 100, quiet: 50, balanced: 100, performance: 100, maximum: 100 }[id] : null
    const min = snap.minPct !== null ? { stock: 5, quiet: 5, balanced: 5, performance: 50, maximum: 100 }[id] : null
    if (max !== null) set('win.cpu.max_pct', String(max), id === 'quiet' ? 'caps the processor at half its policy range to keep fan noise and heat down' : id === 'maximum' ? 'the full policy range' : undefined)
    if (min !== null) set('win.cpu.min_pct', String(min), id === 'maximum' ? 'pinned at the maximum: the CPU no longer slows down when idle' : id === 'performance' ? 'keeps clocks high so load ramps up immediately' : undefined)
    if (min !== null && min === 100) risks.set('win.cpu.min_pct', 'high')
    if (snap.gpu && snap.gpu.min !== null && snap.gpu.max !== null && snap.gpu.limit !== null) {
      if (id === 'maximum') set('win.nvidia.power_w', String(snap.gpu.max), 'the card’s maximum power limit')
      else if (id === 'stock' || id === 'balanced' || id === 'quiet' || id === 'performance') set('win.nvidia.power_w', String(snap.gpu.def ?? snap.gpu.limit), 'card default')
      if (snap.gpu.max !== null) risks.set('win.nvidia.power_w', id === 'maximum' ? 'high' : 'medium')
    }
    skipped.push('CPU clock multiplier and voltage: firmware settings (BIOS/UEFI), no runtime interface')
    if (snap.gpu) skipped.push(`${snap.gpu.name} clock/voltage offsets: use the card vendor’s utility`)
    skipped.push('Memory clock and timings: firmware (XMP/EXPO)')
    return { a, notes, skipped, risks }
  }

  private plan(snap: Snapshot, cs: PerfControl[], id: string, title: string, builtin: boolean, a: Assignment[], notes: Map<string, string>, skipped: string[], incompatible: string | null, risks: Map<string, 'low' | 'medium' | 'high'>): ProfilePlan {
    const byId = new Map(cs.map((c) => [c.id, c]))
    const changes: PresetChange[] = []
    const unchanged: PresetChange[] = []
    const skip = [...skipped]
    for (const [cid, raw] of a) {
      const c = byId.get(cid)
      const label = c?.label ?? cid
      if (!c || c.status === 'unsupported' || c.status === 'unavailable' || c.status === 'error') { skip.push(`${label}: ${c?.reason ?? 'not available on this machine'}`); continue }
      const to = display(c, raw) ?? raw
      const row: PresetChange = { id: cid, label, from: c.current ?? 'unknown', to, raw, risk: risks.get(cid) ?? c.risk, ...(notes.get(cid) ? { note: notes.get(cid) } : {}) }
      if (sameRaw(c.currentRaw, raw)) unchanged.push(row); else changes.push(row)
    }
    const shown = changes.slice(0, 3).map((c) => `${c.label.replace(/ \(.*\)$/, '').toLowerCase()} → ${c.to}`)
    const more = changes.length - shown.length
    const total = changes.length + unchanged.length
    const summary = incompatible ? incompatible
      : !total ? 'This machine reports nothing this profile can change.'
        : !changes.length ? `Already in effect: all ${total} settings it controls on this machine are at its values.`
          : `Changes ${changes.length} of ${total} settings on this machine: ${shown.join('; ')}${more ? `; and ${more} more` : ''}.`
    return { id, title, builtin, summary, compatible: incompatible === null, incompatibleReason: incompatible, changes, unchanged, skipped: skip }
  }

  private profiles(snap: Snapshot, cs: PerfControl[], fp: string): ProfilePlan[] {
    const builtins = BUILTINS.map((id) => {
      const b = this.assignments(snap, id)
      return this.plan(snap, cs, id, BUILTIN_TITLES[id], true, b.a, b.notes, b.skipped, null, b.risks)
    })
    const byId = new Map(cs.map((c) => [c.id, c]))
    const custom = this.d.store.profiles().map((p) => {
      let reason: string | null = null
      if (p.fingerprint !== fp) reason = 'Saved on different hardware (or before a hardware/driver change): it is not applied to this configuration.'
      else {
        const problems = p.settings.map(([id, raw]) => { const c = byId.get(id); return !c || c.status === 'unsupported' || c.status === 'unavailable' ? `${id} is not available` : validate(new Map([[id, { ...c, write: true }]]), id, raw) }).filter(Boolean)
        if (problems.length) reason = `Not applicable now: ${problems.join('; ')}.`
      }
      return this.plan(snap, cs, `custom:${p.id}`, p.name, false, p.settings, new Map(), [], reason, new Map())
    })
    return [...builtins, ...custom]
  }

  async state(fresh?: Snapshot & { fingerprint: string }): Promise<PerfState> {
    const snap = fresh ?? (await this.read())
    const fp = snap.fingerprint
    const verified = this.d.store.verifiedControls(fp)
    const cs = this.controls(snap, verified)
    const originals = new Map([...this.d.store.originalValues(fp)].map(([k, v]) => [k, { raw: v.raw }]))
    const enabled = this.d.tuningEnabled()
    const writable = cs.some((c) => c.write)
    const profiles = this.profiles(snap, cs, fp)
    const matches = profiles.find((p) => p.builtin && p.changes.length === 0 && p.unchanged.length > 0)?.id ?? null
    const at = this.now()
    return {
      supported: true, monitoringOnly: !writable || !enabled, platform: 'win32', fingerprint: fp,
      reason: !writable ? 'No writable control was found: this machine did not expose the Windows processor power policy or an NVIDIA power limit.' : !enabled ? 'Tuning controls are switched off in Settings → Features & controls.' : null,
      tuningEnabled: enabled, helper: { usable: true, path: 'Windows UAC', reason: null },
      devices: this.devices(snap, cs, originals), telemetry: this.telemetry(snap, at), profiles,
      tuned: null, matches, lastTransaction: this.d.store.lastTx(fp),
      canUndo: this.d.store.lastUndoable(fp) !== null, canRestoreOriginal: originals.size > 0, busy: this.d.lock.holder
    }
  }

  private scriptFor(plan: Assignment[], snap: Snapshot): string {
    const parts: string[] = []
    for (const [id, raw] of plan) {
      if (id === 'win.power_plan') {
        const p = snap.plans.find((x) => x.name === raw || x.guid.toLowerCase() === raw.toLowerCase())
        if (!p) throw new Error(`Nothing was changed: this machine has no power plan called “${raw}”.`)
        parts.push(`& powercfg.exe /setactive ${psQuote(p.guid)}; if ($LASTEXITCODE -ne 0) { throw 'powercfg /setactive failed' }`)
      } else if (id === 'win.cpu.max_pct' || id === 'win.cpu.min_pct') {
        const key = id.endsWith('max_pct') ? 'PROCTHROTTLEMAX' : 'PROCTHROTTLEMIN'
        const value = String(clamp(Number(raw), 0, 100))
        parts.push(`& powercfg.exe /setacvalueindex SCHEME_CURRENT SUB_PROCESSOR ${key} ${value}; if ($LASTEXITCODE -ne 0) { throw 'powercfg AC failed' }`)
        parts.push(`& powercfg.exe /setdcvalueindex SCHEME_CURRENT SUB_PROCESSOR ${key} ${value}; if ($LASTEXITCODE -ne 0) { throw 'powercfg DC failed' }`)
        parts.push(`& powercfg.exe /setactive SCHEME_CURRENT; if ($LASTEXITCODE -ne 0) { throw 'powercfg activation failed' }`)
      } else if (id === 'win.nvidia.power_w') {
        if (!snap.smi) throw new Error('Nothing was changed: nvidia-smi was not found on this machine.')
        parts.push(`& ${psQuote(snap.smi)} -pl ${clamp(Number(raw), 0, 100000)}; if ($LASTEXITCODE -ne 0) { throw 'nvidia-smi -pl failed' }`)
      }
    }
    return parts.join('; ')
  }

  private readBack(cs: PerfControl[], item: TxItem): { effective: string | null; ok: boolean | null } {
    const c = cs.find((x) => x.id === item.controlId)
    if (!c || c.currentRaw === null) return { effective: null, ok: null }
    return { effective: c.current, ok: sameRaw(c.currentRaw, item.requestedRaw) }
  }

  private async apply(kind: TxRecord['kind'], label: string, requested: Assignment[]): Promise<TxRecord | null> {
    this.d.lock.take('tuning')
    try {
      if (!this.d.tuningEnabled()) throw new Error('Tuning controls are switched off in Settings → Features & controls.')
      const s0 = await this.read()
      const fp = s0.fingerprint
      const cs0 = this.controls(s0, this.d.store.verifiedControls(fp))
      const byId = new Map(cs0.map((c) => [c.id, c]))
      const problems = requested.map(([id, raw]) => validate(byId, id, raw)).filter((x): x is string => x !== null)
      if (problems.length) throw new Error(`Nothing was changed. ${problems.join('; ')}.`)
      const plan = requested.filter(([id, raw]) => !sameRaw(byId.get(id)!.currentRaw, raw))
      if (!plan.length) return null
      const items: TxItem[] = plan.map(([id, raw]) => {
        const c = byId.get(id)!
        return { controlId: id, label: c.label, previousRaw: c.currentRaw, previous: c.current, requestedRaw: raw, requested: display(c, raw) ?? raw, effective: null, verification: 'pending', message: null }
      })
      const txId = this.d.store.startTx(kind, label, fp, items, this.now())
      const outcome = await runElevatedPowerShell(this.d.run, this.scriptFor(plan, s0), 180_000)
      const s1 = await this.read()
      const cs1 = this.controls(s1, this.d.store.verifiedControls(fp))
      for (const it of items) {
        const rb = this.readBack(cs1, it)
        it.effective = rb.effective
        const unchanged = rb.effective !== null && sameRaw(it.previousRaw, it.effective)
        if (!outcome.ok && (unchanged || rb.ok === null)) it.verification = 'not_applied'
        else if (rb.ok === null) { it.verification = 'unverifiable'; it.message = 'The value cannot be read back, so the change cannot be confirmed.' }
        else if (rb.ok) it.verification = 'verified'
        else { it.verification = 'mismatch'; it.message = `Requested ${it.requested}, Windows reports ${rb.effective}.` }
      }
      let status: TxStatus
      let error = outcome.error
      if (!outcome.ok) {
        const changed = items.filter((i) => (i.verification === 'verified' || i.verification === 'mismatch') && i.previousRaw !== null)
        if (!changed.length) status = 'failed'
        else {
          const back = await runElevatedPowerShell(this.d.run, this.scriptFor(changed.map((i) => [i.controlId, i.previousRaw!] as Assignment), s0), 180_000)
          const s2 = await this.read()
          const cs2 = this.controls(s2, this.d.store.verifiedControls(fp))
          for (const i of changed) {
            const rb = this.readBack(cs2, i)
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

  private async result(tx: TxRecord | null): Promise<PerfApplyResult> {
    return { state: await this.state(), transaction: tx }
  }

  async applyProfile(id: string): Promise<PerfApplyResult> {
    if (!this.d.tuningEnabled()) throw new Error('Tuning controls are switched off in Settings → Features & controls.')
    const snap = await this.read()
    const cs = this.controls(snap, this.d.store.verifiedControls(snap.fingerprint))
    const plan = this.profiles(snap, cs, snap.fingerprint).find((p) => p.id === id)
    if (!plan) throw new Error('Unknown profile.')
    if (!plan.compatible) throw new Error(plan.incompatibleReason ?? 'This profile does not fit this machine.')
    return this.result(await this.apply('profile', plan.title, plan.changes.map((c) => [c.id, c.raw])))
  }

  async applyCustom(values: { id: string; value: string }[], label: string): Promise<PerfApplyResult> {
    if (!this.d.tuningEnabled()) throw new Error('Tuning controls are switched off in Settings → Features & controls.')
    return this.result(await this.apply('custom', label, values.map((v) => [v.id, v.value])))
  }

  async restore(target: 'stock' | 'undo' | 'original'): Promise<PerfApplyResult> {
    if (!this.d.tuningEnabled()) throw new Error('Tuning controls are switched off in Settings → Features & controls.')
    const snap = await this.read()
    const fp = snap.fingerprint
    if (target === 'stock') {
      const b = this.assignments(snap, 'stock')
      return this.result(await this.apply('restore', 'Restore stock settings', b.a))
    }
    if (target === 'original') {
      const originals = this.d.store.originalValues(fp)
      if (!originals.size) throw new Error('No change has been recorded on this hardware, so there is nothing to restore.')
      return this.result(await this.apply('restore', 'Restore original settings', [...originals].map(([id, v]) => [id, v.raw] as Assignment)))
    }
    const last = this.d.store.lastUndoable(fp)
    if (!last) throw new Error('There is no recorded change to undo on this hardware.')
    const back = last.items.filter((i) => i.previousRaw !== null && ['verified', 'mismatch', 'unverifiable'].includes(i.verification)).map((i) => [i.controlId, i.previousRaw!] as Assignment)
    const tx = await this.apply('rollback', `Undo: ${last.label}`, back)
    if (!tx || tx.status === 'verified' || tx.status === 'partially_verified' || tx.status === 'unverifiable') this.d.store.markRolledBack(last.id)
    return this.result(tx)
  }

  async saveProfile(name: string): Promise<PerfState> {
    const snap = await this.read()
    const cs = this.controls(snap, this.d.store.verifiedControls(snap.fingerprint))
    const settings = cs.filter((c) => c.write && c.currentRaw !== null).map((c) => [c.id, c.currentRaw!] as [string, string])
    if (!settings.length) throw new Error('This machine has no writable settings to save.')
    this.d.store.saveProfile(name, snap.fingerprint, settings, this.now())
    return this.state()
  }

  async startTest(mode: TestMode, seconds: number, intervalMs: number): Promise<TestProgress> {
    const lim = this.d.limits()
    if (seconds > lim.maxTestSeconds) throw new Error(`The longest allowed test is ${lim.maxTestSeconds} s (Settings).`)
    if (intervalMs < lim.minIntervalMs) throw new Error(`The shortest allowed sampling interval is ${lim.minIntervalMs} ms (Settings).`)
    return this.tests.start(mode, seconds, intervalMs)
  }
}
