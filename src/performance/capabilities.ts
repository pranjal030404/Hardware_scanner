import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { SysReader } from '@collectors/core/sysreader'
import type { CommandRunner } from '@collectors/core/runner'
import { createHash } from 'node:crypto'
import type { ControlStatus, Measurement, PerfControl, PerfDevice, PerfKnob, PerfLive, PerfSetting, PerfState, Risk } from './types'

export type Assignment = [id: string, value: string]

export interface CapabilityDeps {
  reader: SysReader
  run: CommandRunner
  platform: string
  /** File mode of an absolute path (write evidence: sysfs attributes without a store handler are read-only). */
  stat?: (path: string) => Promise<{ mode: number }>
  now?: () => Date
  /** Pause between the two readings of a rate (utilisation); tests pass 0. */
  rateWindowMs?: number
}

/** What controls need to know besides the hardware itself. */
export interface ControlContext {
  helperUsable: boolean
  helperReason: string | null
  /** Controls whose writes were read back on this device before. */
  verified: Set<string>
}

export interface Described { label: string; from: string; to: string }

const CPU = '/sys/devices/system/cpu'
const RAPL = '/sys/class/powercap/intel-rapl:0'
const W = 1_000_000

const t = (s: string | undefined): string | undefined => s?.trim() || undefined
const num = (s: string | undefined): number | undefined => { const v = t(s); return v !== undefined && /^-?\d+$/.test(v) ? Number(v) : undefined }
const ghz = (khz: number | undefined): string => (khz ? `${(khz / 1e6).toFixed(2)} GHz` : 'unknown')
const watts = (uw: number | undefined): string => (uw ? `${Math.round(uw / W)} W` : 'unknown')
const onOff = (b: boolean | number | null | undefined): string => (b === null || b === undefined ? 'not reported' : b ? 'on' : 'off')
const duration = (us: number | undefined): string => (!us ? '' : us >= 1_000_000 ? `${(us / 1e6).toFixed(us >= 10e6 ? 0 : 1)} s` : `${(us / 1000).toFixed(us >= 10_000 ? 0 : 1)} ms`)
const first = (wanted: readonly string[], available: readonly string[]): string | undefined => wanted.find((w) => available.includes(w))

interface CpuInfo {
  model: string
  driver: string | undefined
  /** intel_pstate / amd-pstate operating mode (active, passive, guided…). */
  mode: string | undefined
  policies: string[]
  minKhz: number | undefined
  maxKhz: number | undefined
  hwMinKhz: number | undefined
  hwMaxKhz: number | undefined
  baseKhz: number | undefined
  /** Distinct per-policy maximum clocks: more than one means a hybrid CPU (performance + efficiency cores). */
  coreMaxes: number[]
  governor: string | undefined
  governors: string[]
  epp: string | undefined
  epps: string[]
  turbo: boolean | null
  minPerf: number | undefined
  maxPerf: number | undefined
  dynamicBoost: number | undefined
}

interface Igpu { card: string; driver: 'i915' | 'xe'; min: number; max: number; boost: number | undefined; rp0: number; rpn: number; rp1: number | undefined }
interface RaplConstraint { name: string; limit: number; max: number | undefined; windowUs: number | undefined }
interface Rapl { pl1: RaplConstraint; pl2: RaplConstraint | undefined; extra: RaplConstraint[] }
interface Amd { card: string; name: string; level: string | undefined; od: { sclk?: [number, number]; mclk?: [number, number]; curSclk?: number; curMclk?: number } | null; cap?: { cur: number; min: number; max: number; def: number | undefined } }
interface Nvidia { name: string; limit: number; def: number; min: number; max: number }

interface Memory {
  totalKb: number
  availableKb: number | undefined
  /** Per-module rated / configured speed from SMBIOS (MT/s); null when the tables are root-only. */
  modules: { rated: number | null; configured: number | null }[] | null
}

export interface Snapshot { cpu: CpuInfo | null; rapl: Rapl | null; igpus: Igpu[]; amds: Amd[]; nvidia: Nvidia | null; tuned: PerfState['tuned']; memory: Memory | null }

/** SMBIOS type 17 (memory device): speed at 0x15, configured speed at 0x20 (MT/s); 0 or 0xFFFF = unknown. */
export function parseSmbios17(raw: Buffer): { rated: number | null; configured: number | null } | null {
  if (raw.length < 0x17 || raw[0] !== 17) return null
  const size = raw.readUInt16LE(0x0c)
  if (size === 0) return null // empty slot
  const w = (o: number): number | null => { if (raw.length < o + 2 || raw[1]! < o + 2) return null; const v = raw.readUInt16LE(o); return v === 0 || v === 0xffff ? null : v }
  return { rated: w(0x15), configured: w(0x20) }
}

const RAPL_NAMES: Record<string, string> = { long_term: 'Sustained power (PL1)', short_term: 'Short boost power (PL2)', peak_power: 'Peak power (PL4)' }

/** True for desktop/enthusiast CPUs whose multiplier the vendor leaves unlocked. */
export function unlockedCpu(model: string): boolean {
  if (/\bi[3579]-\d{4,5}K[FS]?\b|\bUltra [579] \d{3}KF?\b/i.test(model)) return true
  // Every desktop Ryzen is unlocked; laptop parts end in U/H/HS/HX/E.
  return /\bRyzen\b/i.test(model) && !/\b\d{4}(U|H|HS|HX|E)\b/i.test(model)
}

/** Parses amdgpu pp_od_clk_voltage: OD_RANGE limits and the current top state. */
export function parseOd(text: string): NonNullable<Amd['od']> {
  const range = (k: string): [number, number] | undefined => {
    const m = new RegExp(`^${k}:\\s*(\\d+)\\s*Mhz\\s+(\\d+)\\s*Mhz`, 'mi').exec(text)
    return m ? [Number(m[1]), Number(m[2])] : undefined
  }
  const top = (section: string): number | undefined => {
    const m = new RegExp(`^${section}:\\n((?:\\s*\\d+:.*\\n?)+)`, 'm').exec(text)
    const vals = [...(m?.[1] ?? '').matchAll(/\d+:\s*(\d+)\s*Mhz/gi)].map((x) => Number(x[1]))
    return vals.length ? vals[vals.length - 1] : undefined
  }
  return { sclk: range('SCLK'), mclk: range('MCLK'), curSclk: top('OD_SCLK'), curMclk: top('OD_MCLK') }
}

const UNKNOWN = new Set(['?', 'unknown', 'not reported', 'none', 'as set'])
/** A read-back value that cannot confirm anything. */
export const isUnknown = (v: string | null | undefined): boolean => v === null || v === undefined || UNKNOWN.has(v) || v.startsWith('? ')

export class CapabilityService {
  private prevStat: { idle: number; total: number } | null = null
  constructor(private d: CapabilityDeps) {}

  private now(): Date { return this.d.now?.() ?? new Date() }

  // ---- reading (no privileges) -----------------------------------------------------------------

  async snapshot(): Promise<Snapshot> {
    const r = this.d.reader
    let cpu: CpuInfo | null = null
    const policies = (await r.dir(`${CPU}/cpufreq`)).filter((p) => /^policy\d+$/.test(p)).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
    if (policies.length) {
      const p0 = `${CPU}/cpufreq/${policies[0]}`
      const maxes = (await Promise.all(policies.map((p) => r.text(`${CPU}/cpufreq/${p}/cpuinfo_max_freq`)))).map(num).filter((x): x is number => !!x)
      const mins = (await Promise.all(policies.map((p) => r.text(`${CPU}/cpufreq/${p}/cpuinfo_min_freq`)))).map(num).filter((x): x is number => !!x)
      const noTurbo = num(await r.text(`${CPU}/intel_pstate/no_turbo`))
      const boost = num(await r.text(`${CPU}/cpufreq/boost`))
      const driver = t(await r.text(`${p0}/scaling_driver`))
      cpu = {
        model: /model name\s*:\s*(.+)/.exec((await r.text('/proc/cpuinfo')) ?? '')?.[1]?.trim() ?? 'CPU',
        driver,
        mode: t(await r.text(`${CPU}/intel_pstate/status`)) ?? t(await r.text(`${CPU}/amd_pstate/status`)),
        policies,
        minKhz: num(await r.text(`${p0}/scaling_min_freq`)),
        maxKhz: num(await r.text(`${p0}/scaling_max_freq`)),
        hwMinKhz: mins.length ? Math.min(...mins) : undefined,
        hwMaxKhz: maxes.length ? Math.max(...maxes) : undefined,
        baseKhz: num(await r.text(`${p0}/base_frequency`)),
        coreMaxes: [...new Set(maxes)].sort((a, b) => b - a),
        governor: t(await r.text(`${p0}/scaling_governor`)),
        governors: (t(await r.text(`${p0}/scaling_available_governors`)) ?? '').split(/\s+/).filter(Boolean),
        epp: t(await r.text(`${p0}/energy_performance_preference`)),
        epps: (t(await r.text(`${p0}/energy_performance_available_preferences`)) ?? '').split(/\s+/).filter(Boolean),
        turbo: noTurbo !== undefined ? noTurbo === 0 : boost !== undefined ? boost === 1 : null,
        minPerf: num(await r.text(`${CPU}/intel_pstate/min_perf_pct`)),
        maxPerf: num(await r.text(`${CPU}/intel_pstate/max_perf_pct`)),
        dynamicBoost: num(await r.text(`${CPU}/intel_pstate/hwp_dynamic_boost`))
      }
    }
    let rapl: Rapl | null = null
    const constraints: RaplConstraint[] = []
    for (let i = 0; i < 4; i++) {
      const limit = num(await r.text(`${RAPL}/constraint_${i}_power_limit_uw`))
      if (limit === undefined) continue
      const max = num(await r.text(`${RAPL}/constraint_${i}_max_power_uw`))
      constraints.push({ name: t(await r.text(`${RAPL}/constraint_${i}_name`)) ?? `constraint ${i}`, limit, max: max && max > 0 ? max : undefined, windowUs: num(await r.text(`${RAPL}/constraint_${i}_time_window_us`)) || undefined })
    }
    if (constraints[0] && constraints[0].limit > 0) rapl = { pl1: constraints[0], pl2: constraints[1]?.name === 'short_term' ? constraints[1] : undefined, extra: constraints.slice(constraints[1]?.name === 'short_term' ? 2 : 1) }
    const igpus: Igpu[] = []
    const amds: Amd[] = []
    for (const card of (await r.dir('/sys/class/drm')).filter((c) => /^card\d+$/.test(c))) {
      const base = `/sys/class/drm/${card}`
      const rp0 = num(await r.text(`${base}/gt_RP0_freq_mhz`))
      if (rp0) {
        igpus.push({ card, driver: 'i915', rp0, rpn: num(await r.text(`${base}/gt_RPn_freq_mhz`)) ?? 0, rp1: num(await r.text(`${base}/gt_RP1_freq_mhz`)), min: num(await r.text(`${base}/gt_min_freq_mhz`)) ?? 0, max: num(await r.text(`${base}/gt_max_freq_mhz`)) ?? 0, boost: num(await r.text(`${base}/gt_boost_freq_mhz`)) })
        continue
      }
      const xe = `${base}/device/tile0/gt0/freq0`
      const xrp0 = num(await r.text(`${xe}/rp0_freq`))
      if (xrp0) {
        igpus.push({ card, driver: 'xe', rp0: xrp0, rpn: num(await r.text(`${xe}/rpn_freq`)) ?? 0, rp1: num(await r.text(`${xe}/rpe_freq`)), min: num(await r.text(`${xe}/min_freq`)) ?? 0, max: num(await r.text(`${xe}/max_freq`)) ?? 0, boost: undefined })
        continue
      }
      const drv = await r.link(`${base}/device/driver`)
      if (!drv?.endsWith('/amdgpu')) continue
      const odText = await r.text(`${base}/device/pp_od_clk_voltage`)
      const amd: Amd = { card, name: t(await r.text(`${base}/device/product_name`)) ?? `AMD GPU (${card})`, level: t(await r.text(`${base}/device/power_dpm_force_performance_level`)), od: odText ? parseOd(odText) : null }
      for (const h of await r.dir(`${base}/device/hwmon`)) {
        const cur = num(await r.text(`${base}/device/hwmon/${h}/power1_cap`))
        if (cur === undefined) continue
        amd.cap = { cur, min: num(await r.text(`${base}/device/hwmon/${h}/power1_cap_min`)) ?? 0, max: num(await r.text(`${base}/device/hwmon/${h}/power1_cap_max`)) ?? cur, def: num(await r.text(`${base}/device/hwmon/${h}/power1_cap_default`)) }
      }
      amds.push(amd)
    }
    let nvidia: Nvidia | null = null
    if (this.d.platform === 'linux') {
      const n = await this.d.run('nvidia-smi', ['--query-gpu=name,power.limit,power.default_limit,power.min_limit,power.max_limit', '--format=csv,noheader,nounits'], { timeoutMs: 4000 })
      const f = n.ok ? n.stdout.split('\n')[0]?.split(',').map((x) => x.trim()) : undefined
      if (f && f.length === 5 && f.slice(1).every((x) => /^[\d.]+$/.test(x))) nvidia = { name: f[0]!, limit: Math.round(Number(f[1])), def: Math.round(Number(f[2])), min: Math.ceil(Number(f[3])), max: Math.floor(Number(f[4])) }
    }
    let tuned: PerfState['tuned'] = null
    const ta = await this.d.run('tuned-adm', ['active'], { timeoutMs: 5000 })
    if (ta.ok) {
      const list = await this.d.run('tuned-adm', ['list'], { timeoutMs: 5000 })
      const rec = await this.d.run('tuned-adm', ['recommend'], { timeoutMs: 5000 })
      tuned = { active: /profile:\s*(\S+)/.exec(ta.stdout)?.[1] ?? null, available: [...list.stdout.matchAll(/^- (\S+)/gm)].map((m) => m[1]!), recommended: rec.ok ? (t(rec.stdout)?.split(/\s+/)[0] ?? null) : null }
    }
    let memory: Memory | null = null
    const mi = (await r.text('/proc/meminfo')) ?? ''
    const kb = (k: string): number | undefined => { const m = new RegExp(`^${k}:\\s+(\\d+) kB`, 'm').exec(mi); return m ? Number(m[1]) : undefined }
    const total = kb('MemTotal')
    if (total) {
      let modules: Memory['modules'] = []
      for (const e of (await r.dir('/sys/firmware/dmi/entries')).filter((x) => /^17-\d+$/.test(x))) {
        const raw = await r.bytes(`/sys/firmware/dmi/entries/${e}/raw`)
        if (!raw) { modules = null; break }
        const m = parseSmbios17(raw)
        if (m) modules.push(m)
      }
      memory = { totalKb: total, availableKb: kb('MemAvailable'), modules }
    }
    return { cpu, rapl, igpus, amds, nvidia, tuned, memory }
  }

  // ---- what each setting means on this device --------------------------------------------------

  /** Current and new value of one helper setting, in words, read from this device. */
  describe(s: Snapshot, id: string, value: string): Described {
    const c = s.cpu
    // "max"/"min" are the hardware maximum/minimum whichever limit they are written to.
    const khz = (v: string): string => ghz(v === 'max' ? c?.hwMaxKhz : v === 'min' ? c?.hwMinKhz : Number(v))
    const gpu = (card: string): Igpu | undefined => s.igpus.find((g) => g.card === card)
    const amd = (card: string): Amd | undefined => s.amds.find((g) => g.card === card)
    const [kind, card, key] = id.split('.')
    switch (id) {
      case 'tuned.profile': return { label: 'System tuning profile (tuned)', from: s.tuned?.active ?? 'none', to: value }
      case 'cpu.governor': return { label: 'CPU governor', from: c?.governor ?? '?', to: value }
      case 'cpu.epp': return { label: 'Energy preference', from: c?.epp ?? '?', to: value }
      case 'cpu.turbo': return { label: 'Turbo boost', from: onOff(c?.turbo), to: onOff(value === '1') }
      case 'cpu.max_khz': return { label: 'Highest allowed CPU clock', from: ghz(c?.maxKhz), to: khz(value) }
      case 'cpu.min_khz': return { label: 'Lowest allowed CPU clock', from: ghz(c?.minKhz), to: khz(value) }
      case 'cpu.max_perf_pct': return { label: 'Performance cap', from: `${c?.maxPerf ?? '?'}%`, to: `${value}%` }
      // The kernel raises a too-low floor to the CPU's own minimum, so "1" means "as low as this CPU goes".
      case 'cpu.min_perf_pct': {
        const floor = c?.hwMinKhz && c.hwMaxKhz ? Math.floor((c.hwMinKhz * 100) / c.hwMaxKhz) : undefined
        return { label: 'Performance floor', from: `${c?.minPerf ?? '?'}%`, to: value === '1' && floor !== undefined ? `${Math.max(floor, 1)}%` : `${value}%` }
      }
      case 'cpu.dynamic_boost': return { label: 'Dynamic boost (I/O wait)', from: onOff(c?.dynamicBoost), to: onOff(value === '1') }
      case 'rapl.pl1_uw': return { label: 'Sustained power (PL1)', from: watts(s.rapl?.pl1.limit), to: watts(Number(value)) }
      case 'rapl.pl2_uw': return { label: 'Short boost power (PL2)', from: watts(s.rapl?.pl2?.limit), to: watts(Number(value)) }
      case 'nvidia.power_w': return { label: `${s.nvidia?.name ?? 'GPU'} power limit`, from: `${s.nvidia?.limit ?? '?'} W`, to: `${value} W` }
    }
    if (kind === 'igpu') {
      const g = gpu(card!)
      const cur = key === 'max_mhz' ? g?.max : key === 'min_mhz' ? g?.min : g?.boost
      return { label: `Graphics ${key === 'max_mhz' ? 'highest' : key === 'min_mhz' ? 'lowest' : 'boost'} clock (${card})`, from: `${cur ?? '?'} MHz`, to: `${value} MHz` }
    }
    if (kind === 'amdgpu') {
      const g = amd(card!)
      if (key === 'level') return { label: `${g?.name ?? card} performance level`, from: g?.level ?? '?', to: value }
      if (key === 'power_cap_uw') return { label: `${g?.name ?? card} power limit`, from: watts(g?.cap?.cur), to: watts(Number(value)) }
      if (key === 'od_reset') return { label: `${g?.name ?? card} overdrive clocks`, from: 'as set', to: 'driver defaults' }
      return { label: `${g?.name ?? card} ${key === 'sclk_mhz' ? 'core' : 'memory'} clock`, from: `${(key === 'sclk_mhz' ? g?.od?.curSclk : g?.od?.curMclk) ?? '?'} MHz`, to: `${value} MHz` }
    }
    return { label: id, from: '?', to: value }
  }

  async devices(s: Snapshot, ctx: ControlContext & { originals: Map<string, string> }): Promise<PerfDevice[]> {
    const out: Omit<PerfDevice, 'controls' | 'monitoringOnly'>[] = []
    const baseline = ctx.originals
    if (s.cpu) {
      const c = s.cpu
      const hybrid = c.coreMaxes.length > 1
      const settings: PerfSetting[] = [
        { label: 'Clock range allowed', current: `${ghz(c.minKhz)} – ${ghz(c.maxKhz)}`, allowed: `${ghz(c.hwMinKhz)} – ${ghz(c.hwMaxKhz)}`, best: `up to ${ghz(c.hwMaxKhz)}`, adjustable: !!c.hwMaxKhz },
        ...(c.baseKhz ? [{ label: 'Base clock (guaranteed)', current: ghz(c.baseKhz), allowed: 'fixed by the chip', best: '—', adjustable: false }] : []),
        { label: hybrid ? 'Maximum turbo per core type' : 'Maximum turbo', current: c.coreMaxes.map((m) => ghz(m)).join(' / ') || 'unknown', allowed: unlockedCpu(c.model) ? 'set in BIOS (unlocked multiplier)' : 'fixed by the chip (locked multiplier)', best: '—', adjustable: false },
        { label: 'Turbo boost', current: onOff(c.turbo), allowed: c.turbo === null ? 'no switch exposed by the driver' : 'on / off', best: c.turbo === null ? '—' : 'on', adjustable: c.turbo !== null }
      ]
      if (c.governor) settings.push({ label: 'Governor', current: c.governor, allowed: c.governors.join(', ') || c.governor, best: c.governors.includes('performance') ? 'performance' : '—', adjustable: c.governors.length > 1 })
      if (c.epp) settings.push({ label: 'Energy preference', current: c.epp, allowed: c.epps.join(', ') || c.epp, best: c.epps.includes('performance') ? 'performance' : '—', adjustable: c.epps.length > 1 })
      if (c.maxPerf !== undefined) settings.push({ label: 'Performance cap', current: `${c.maxPerf}%`, allowed: '1–100%', best: '100%', adjustable: true })
      if (c.minPerf !== undefined) settings.push({ label: 'Performance floor', current: `${c.minPerf}%`, allowed: `CPU minimum – ${c.maxPerf ?? 100}%`, best: 'any (100% pins the clock high)', adjustable: true })
      if (c.dynamicBoost !== undefined) settings.push({ label: 'Dynamic boost (I/O wait)', current: onOff(c.dynamicBoost), allowed: 'on / off', best: 'on', adjustable: true })
      const unlocked = unlockedCpu(c.model)
      out.push({
        id: 'cpu', kind: 'cpu', label: c.model,
        summary: [`driver ${c.driver ?? 'unknown'}${c.mode ? ` (${c.mode} mode)` : ''}`, `${c.policies.length} frequency domain${c.policies.length === 1 ? '' : 's'}`, hybrid ? 'hybrid: performance + efficiency cores' : null, c.baseKhz ? `base ${ghz(c.baseKhz)}` : null, `max turbo ${ghz(c.hwMaxKhz)}`].filter(Boolean).join(' · '),
        settings,
        overclock: {
          supported: false, knobs: [],
          reason: unlocked
            ? `This CPU has an unlocked multiplier. Raise it in the BIOS/UEFI setup: the operating system cannot change the multiplier or core voltage safely.${s.rapl ? ' Raising the power limits below helps it hold its turbo clock longer.' : ''}`
            : `The clock multiplier is locked by the manufacturer on this model: it cannot run above its ${ghz(c.hwMaxKhz)} turbo clock${c.baseKhz ? ` (base ${ghz(c.baseKhz)})` : ''}.${s.rapl ? ' Raising the power limits below is the only way to make it hold turbo longer.' : ' This CPU exposes no power limits, so there is nothing to tune beyond the presets.'}`
        }
      })
    }
    if (s.rapl) {
      const r = s.rapl
      const pl1Stock = r.pl1.max ?? Number(baseline.get('rapl.pl1_uw') ?? r.pl1.limit)
      const pl1Source = r.pl1.max ? 'firmware rating' : baseline.has('rapl.pl1_uw') ? 'value before the first change' : 'current value (this device reports no factory rating)'
      const ref = r.pl1.max ?? pl1Stock
      const knobs: PerfKnob[] = [{
        id: 'rapl.pl1_uw', label: 'Sustained power (PL1)', unit: 'W', scale: W, current: r.pl1.limit, stock: pl1Stock, stockSource: pl1Source,
        min: 5 * W, max: ref * 2, maxSource: `safety ceiling: 2× ${r.pl1.max ? 'the firmware rating' : 'the stock value'}`, step: W,
        help: `How much power the CPU may draw ${r.pl1.windowUs ? `averaged over ${duration(r.pl1.windowUs)}` : 'indefinitely'}. Higher = holds turbo longer under load, more heat and fan noise.`
      }]
      if (r.pl2) {
        const pl2Stock = r.pl2.max ?? Number(baseline.get('rapl.pl2_uw') ?? r.pl2.limit)
        knobs.push({
          id: 'rapl.pl2_uw', label: 'Short boost power (PL2)', unit: 'W', scale: W, current: r.pl2.limit, stock: pl2Stock,
          stockSource: r.pl2.max ? 'firmware rating' : baseline.has('rapl.pl2_uw') ? 'value before the first change' : 'current value (this device reports no factory rating)',
          min: 5 * W, max: ref * 3, maxSource: `safety ceiling: 3× ${r.pl1.max ? 'the sustained firmware rating' : 'the sustained stock value'}`, step: W,
          help: `Peak power for short bursts${r.pl2.windowUs ? ` (about ${duration(r.pl2.windowUs)})` : ''}.`
        })
      }
      const row = (k: RaplConstraint, adjustable: boolean): PerfSetting => ({
        label: RAPL_NAMES[k.name] ?? k.name, current: watts(k.limit),
        allowed: [k.max ? `firmware rating ${watts(k.max)}` : 'no rating reported', k.windowUs ? `over ${duration(k.windowUs)}` : null].filter(Boolean).join(', '),
        best: adjustable ? 'higher = longer turbo (more heat)' : '—', adjustable
      })
      out.push({
        id: 'power', kind: 'power', label: 'CPU power limits (RAPL)',
        summary: `package power limits reported by the CPU's firmware: ${[r.pl1, r.pl2, ...r.extra].filter(Boolean).map((k) => `${RAPL_NAMES[k!.name] ?? k!.name} ${watts(k!.limit)}`).join(', ')}`,
        settings: [row(r.pl1, true), ...(r.pl2 ? [row(r.pl2, true)] : []), ...r.extra.map((k) => row(k, false))],
        overclock: { supported: true, reason: 'Power-limit tuning: lets the CPU draw more power so it stays at turbo longer. It cannot raise the maximum clock. The CPU still protects itself by slowing down at its temperature limit. Some laptop firmware resets these limits on its own.', knobs }
      })
    }
    for (const g of s.igpus) {
      out.push({
        id: `igpu:${g.card}`, kind: 'igpu', label: `Intel integrated graphics (${g.card})`,
        summary: `driver ${g.driver} · reports ${g.rpn}–${g.rp0} MHz${g.rp1 ? `, efficient clock ${g.rp1} MHz` : ''}`,
        settings: [
          { label: 'Highest clock allowed', current: `${g.max} MHz`, allowed: `${g.rpn}–${g.rp0} MHz`, best: `${g.rp0} MHz`, adjustable: true },
          ...(g.boost !== undefined ? [{ label: 'Boost clock', current: `${g.boost} MHz`, allowed: `${g.rpn}–${g.rp0} MHz`, best: `${g.rp0} MHz`, adjustable: true }] : []),
          { label: 'Lowest clock allowed', current: `${g.min} MHz`, allowed: `${g.rpn}–${g.max} MHz`, best: g.rp1 ? `${g.rp1} MHz (efficient clock, quicker to respond)` : 'any', adjustable: true },
          ...(g.rp1 ? [{ label: 'Efficient clock (RP1)', current: `${g.rp1} MHz`, allowed: 'fixed by the chip', best: '—', adjustable: false }] : [])
        ],
        overclock: { supported: false, knobs: [], reason: `This GPU reports ${g.rp0} MHz ("RP0") as its top clock. It is fixed in the chip and the ${g.driver} driver rejects anything higher. The Maximum preset lets it reach ${g.rp0} MHz.` }
      })
    }
    for (const a of s.amds) {
      const knobs: PerfKnob[] = []
      if (a.od?.sclk) knobs.push({ id: `amdgpu.${a.card}.sclk_mhz`, label: 'Core clock', unit: 'MHz', scale: 1, current: a.od.curSclk ?? a.od.sclk[1], stock: Number(baseline.get(`amdgpu.${a.card}.sclk_mhz`) ?? a.od.curSclk ?? a.od.sclk[0]), stockSource: baseline.has(`amdgpu.${a.card}.sclk_mhz`) ? 'value before the first change' : 'current driver value', min: a.od.sclk[0], max: a.od.sclk[1], maxSource: 'the driver\'s overdrive range (OD_RANGE)', step: 5, help: 'Top core clock. Raise in small steps and test; artifacts or crashes mean too far.' })
      if (a.od?.mclk) knobs.push({ id: `amdgpu.${a.card}.mclk_mhz`, label: 'Memory clock', unit: 'MHz', scale: 1, current: a.od.curMclk ?? a.od.mclk[1], stock: Number(baseline.get(`amdgpu.${a.card}.mclk_mhz`) ?? a.od.curMclk ?? a.od.mclk[0]), stockSource: baseline.has(`amdgpu.${a.card}.mclk_mhz`) ? 'value before the first change' : 'current driver value', min: a.od.mclk[0], max: a.od.mclk[1], maxSource: 'the driver\'s overdrive range (OD_RANGE)', step: 5, help: 'VRAM clock. Errors show up as artifacts or driver resets.' })
      if (a.cap) knobs.push({ id: `amdgpu.${a.card}.power_cap_uw`, label: 'Power limit', unit: 'W', scale: W, current: a.cap.cur, stock: a.cap.def ?? a.cap.cur, stockSource: a.cap.def ? 'board default' : 'current value', min: a.cap.min, max: a.cap.max, maxSource: 'the board\'s maximum (power1_cap_max)', step: W, help: 'Board power the GPU may draw.' })
      out.push({
        id: `amdgpu:${a.card}`, kind: 'amdgpu', label: a.name,
        summary: `driver amdgpu · overdrive ${a.od ? 'enabled' : 'disabled'}${a.cap ? ` · power ${watts(a.cap.min)}–${watts(a.cap.max)}` : ''}`,
        settings: [
          { label: 'Performance level', current: a.level ?? 'unknown', allowed: 'auto, low, high, manual', best: 'high', adjustable: !!a.level },
          ...(a.od?.sclk ? [{ label: 'Core clock', current: `${a.od.curSclk ?? '?'} MHz`, allowed: `${a.od.sclk[0]}–${a.od.sclk[1]} MHz`, best: `up to ${a.od.sclk[1]} MHz (test stability)`, adjustable: true }] : []),
          ...(a.cap ? [{ label: 'Power limit', current: watts(a.cap.cur), allowed: `${watts(a.cap.min)}–${watts(a.cap.max)}`, best: watts(a.cap.max), adjustable: true }] : [])
        ],
        overclock: knobs.length
          ? { supported: true, knobs, reason: a.od ? 'AMD OverDrive: clocks within the range this driver reports. Applying switches the card to the manual performance level.' : 'Only the power limit is adjustable: clock overdrive is disabled (boot with amdgpu.ppfeaturemask=0xffffffff to enable it).' }
          : { supported: false, knobs, reason: 'The driver exposes no overdrive or power-limit controls (boot with amdgpu.ppfeaturemask=0xffffffff to enable overdrive).' }
      })
    }
    if (s.nvidia) {
      const n = s.nvidia
      out.push({
        id: 'nvidia', kind: 'nvidia', label: n.name, summary: `nvidia-smi · power ${n.min}–${n.max} W, default ${n.def} W`,
        settings: [{ label: 'Power limit', current: `${n.limit} W`, allowed: `${n.min}–${n.max} W`, best: `${n.max} W`, adjustable: n.max > n.min }],
        overclock: {
          supported: n.max > n.min, reason: 'Power-limit tuning through nvidia-smi, within the range the card reports. Clock offsets need nvidia-settings with Coolbits on X11 and are not available here.',
          knobs: n.max > n.min ? [{ id: 'nvidia.power_w', label: 'Power limit', unit: 'W', scale: 1, current: n.limit, stock: n.def, stockSource: 'card default', min: n.min, max: n.max, maxSource: 'the card\'s maximum', step: 1, help: 'Board power the GPU may draw.' }] : []
        }
      })
    }
    if (s.memory) {
      const m = s.memory
      const speeds = m.modules?.map((x) => x.configured ?? x.rated).filter((x): x is number => x !== null) ?? []
      const rated = m.modules?.map((x) => x.rated).filter((x): x is number => x !== null) ?? []
      const speedText = m.modules === null ? 'requires administrator access to read (SMBIOS)' : speeds.length ? [...new Set(speeds)].map((x) => `${x} MT/s`).join(' / ') : 'not reported by the firmware'
      out.push({
        id: 'memory', kind: 'memory', label: 'System memory (RAM)',
        summary: `${(m.totalKb / 2 ** 20).toFixed(1)} GiB installed${m.modules ? ` · ${m.modules.length} module${m.modules.length === 1 ? '' : 's'}` : ''} · speed ${speedText}`,
        settings: [
          { label: 'Installed', current: `${(m.totalKb / 2 ** 20).toFixed(1)} GiB`, allowed: '—', best: '—', adjustable: false },
          { label: 'Configured speed', current: speedText, allowed: rated.length ? `rated ${Math.max(...rated)} MT/s` : 'set by firmware', best: rated.length ? `${Math.max(...rated)} MT/s (enable XMP/EXPO in firmware setup)` : '—', adjustable: false }
        ],
        overclock: { supported: false, knobs: [], reason: 'Memory speed and timings are set by the firmware (XMP/EXPO profile in BIOS/UEFI setup).' }
      })
    }
    if (s.tuned) out.push({ id: 'system', kind: 'system', label: 'System tuning (tuned)', summary: `active profile ${s.tuned.active ?? 'none'}${s.tuned.recommended ? ` · recommends ${s.tuned.recommended}` : ''}`, settings: [{ label: 'Active profile', current: s.tuned.active ?? 'none', allowed: s.tuned.available.join(', '), best: first(['throughput-performance', 'latency-performance'], s.tuned.available) ?? '—', adjustable: true }], overclock: { supported: false, knobs: [], reason: 'tuned applies a set of system settings; it does not overclock.' } })
    const controls = await this.controls(s, ctx)
    return out.map((d) => {
      const cs = controls.filter((c) => c.deviceId === d.id)
      return { ...d, controls: cs, monitoringOnly: !cs.some((c) => c.write) }
    })
  }

  // ---- controls: what can be changed, with the evidence for it ----------------------------------

  private async writable(path: string): Promise<boolean> {
    try {
      const st = await (this.d.stat ?? ((p: string) => fs.stat(p)))(join(this.d.reader.root, path))
      // A sysfs attribute without a store handler is created read-only (0444): no write support, whatever the privileges.
      return (st.mode & 0o200) !== 0
    } catch {
      return false
    }
  }

  private status(present: boolean, readable: boolean, writable: boolean, id: string, ctx: ControlContext): { status: ControlStatus; reason: string | null } {
    if (!present) return { status: 'unsupported', reason: 'This device does not report this control.' }
    if (!readable) return { status: 'error', reason: 'The current value could not be read.' }
    if (!writable) return { status: 'unavailable', reason: 'The kernel exposes this read-only on this device.' }
    if (!ctx.helperUsable) return { status: 'permission_required', reason: ctx.helperReason }
    return ctx.verified.has(id) ? { status: 'supported', reason: null } : { status: 'not_verified', reason: 'Writable, but no change has been read back on this machine yet.' }
  }

  async controls(s: Snapshot, ctx: ControlContext): Promise<PerfControl[]> {
    const out: PerfControl[] = []
    const raw = new Map(this.baselineOf(s))
    const add = async (deviceId: string, id: string, label: string, source: string, present: boolean, extra: Partial<PerfControl> & { risk: Risk }, toolWritable?: boolean): Promise<void> => {
      const currentRaw = raw.get(id) ?? null
      const readable = currentRaw !== null
      const writable = present && (toolWritable ?? (await this.writable(source)))
      const st = this.status(present, readable, writable, id, ctx)
      const current = currentRaw === null ? null : this.describe(s, id, currentRaw).from
      out.push({ id, deviceId, label, status: st.status, read: readable, write: st.status === 'supported' || st.status === 'not_verified', current, currentRaw, source, persistence: 'runtime', rebootRequired: false, restorable: readable, reason: st.reason, ...extra })
    }
    /** A capability the hardware/OS does not offer through any documented interface: listed so its absence is explained. */
    const absent = (deviceId: string, id: string, label: string, status: ControlStatus, reason: string): void => {
      out.push({ id, deviceId, label, status, read: false, write: false, current: null, currentRaw: null, source: '—', persistence: 'runtime', rebootRequired: false, restorable: false, risk: 'high', reason })
    }
    const c = s.cpu
    if (c) {
      const p0 = `${CPU}/cpufreq/${c.policies[0]}`
      await add('cpu', 'cpu.governor', 'Governor', `${p0}/scaling_governor`, !!c.governor, { options: c.governors, risk: 'low' })
      await add('cpu', 'cpu.epp', 'Energy preference', `${p0}/energy_performance_preference`, !!c.epp, { options: c.epps, risk: 'low' })
      const turboPath = (await this.d.reader.exists(`${CPU}/intel_pstate/no_turbo`)) ? `${CPU}/intel_pstate/no_turbo` : `${CPU}/cpufreq/boost`
      await add('cpu', 'cpu.turbo', 'Turbo boost', turboPath, c.turbo !== null, { options: ['1', '0'], risk: 'low' })
      const range = { min: c.hwMinKhz, max: c.hwMaxKhz, unit: 'GHz', scale: 1e6, step: 100_000, rangeSource: "the CPU's reported range (cpuinfo_min_freq – cpuinfo_max_freq)" }
      await add('cpu', 'cpu.max_khz', 'Highest allowed clock (OS policy limit)', `${p0}/scaling_max_freq`, !!c.maxKhz, { ...range, risk: 'low' })
      await add('cpu', 'cpu.min_khz', 'Lowest allowed clock (OS policy limit)', `${p0}/scaling_min_freq`, !!c.minKhz, { ...range, risk: 'low' })
      await add('cpu', 'cpu.max_perf_pct', 'Performance cap', `${CPU}/intel_pstate/max_perf_pct`, c.maxPerf !== undefined, { min: 1, max: 100, unit: '%', scale: 1, step: 1, rangeSource: 'intel_pstate (1–100 %)', risk: 'low' })
      await add('cpu', 'cpu.min_perf_pct', 'Performance floor', `${CPU}/intel_pstate/min_perf_pct`, c.minPerf !== undefined, { min: 1, max: 100, unit: '%', scale: 1, step: 1, rangeSource: 'intel_pstate (raised to the CPU minimum by the kernel)', risk: 'low' })
      await add('cpu', 'cpu.dynamic_boost', 'Dynamic boost (I/O wait)', `${CPU}/intel_pstate/hwp_dynamic_boost`, c.dynamicBoost !== undefined, { options: ['1', '0'], risk: 'low' })
      absent('cpu', 'cpu.multiplier', 'Clock multiplier (overclocking)', unlockedCpu(c.model) ? 'unavailable' : 'unsupported', unlockedCpu(c.model)
        ? 'Unlocked CPU: the multiplier is set in the BIOS/UEFI setup. Linux has no documented interface to change it at run time, and this app does not write model-specific registers.'
        : `Locked by the manufacturer on this model: it cannot run above ${ghz(c.hwMaxKhz)}.`)
      absent('cpu', 'cpu.voltage_offset', 'Core voltage / undervolting', 'unavailable', 'No documented kernel interface. Voltage offsets need writes to undocumented model-specific registers, which this app does not do; on recent Intel laptops firmware usually locks them (Plundervolt mitigation).')
    }
    if (s.memory) absent('memory', 'memory.clock', 'Memory clock and timings', 'unsupported', 'RAM speed and timings are fixed by the firmware at boot (XMP/EXPO profiles in BIOS/UEFI setup). Linux provides no interface to change them while running.')
    if (s.tuned) await add('system', 'tuned.profile', 'tuned profile', 'tuned-adm', true, { options: s.tuned.available, risk: 'low', persistence: 'persistent' }, true)
    if (s.rapl) {
      const r = s.rapl
      const ref = r.pl1.max ?? Number(raw.get('rapl.pl1_uw') ?? r.pl1.limit)
      await add('power', 'rapl.pl1_uw', 'Sustained power (PL1)', `${RAPL}/constraint_0_power_limit_uw`, true, { min: 5 * W, max: ref * 2, unit: 'W', scale: W, step: W, rangeSource: `safety ceiling: 2× ${r.pl1.max ? 'the firmware rating' : 'the current value'}`, risk: 'medium' })
      if (r.pl2) await add('power', 'rapl.pl2_uw', 'Short boost power (PL2)', `${RAPL}/constraint_1_power_limit_uw`, true, { min: 5 * W, max: ref * 3, unit: 'W', scale: W, step: W, rangeSource: `safety ceiling: 3× ${r.pl1.max ? 'the sustained firmware rating' : 'the current sustained value'}`, risk: 'medium' })
    }
    for (const g of s.igpus) {
      const dir = g.driver === 'i915' ? `/sys/class/drm/${g.card}` : `/sys/class/drm/${g.card}/device/tile0/gt0/freq0`
      const f = (k: string): string => (g.driver === 'i915' ? `${dir}/gt_${k}_freq_mhz` : `${dir}/${k}_freq`)
      const range = { min: g.rpn, max: g.rp0, unit: 'MHz', scale: 1, step: 50, rangeSource: 'the GPU\'s reported range (RPn – RP0)' }
      await add(`igpu:${g.card}`, `igpu.${g.card}.max_mhz`, 'Highest allowed clock', f('max'), true, { ...range, risk: 'low' })
      if (g.boost !== undefined) await add(`igpu:${g.card}`, `igpu.${g.card}.boost_mhz`, 'Boost clock', f('boost'), true, { ...range, risk: 'low' })
      await add(`igpu:${g.card}`, `igpu.${g.card}.min_mhz`, 'Lowest allowed clock', f('min'), true, { ...range, risk: 'low' })
      absent(`igpu:${g.card}`, `igpu.${g.card}.overclock`, 'Clock above RP0 (overclocking)', 'unsupported', `The top clock (${g.rp0} MHz) is fixed in the chip; the ${g.driver} driver rejects higher values.`)
    }
    for (const a of s.amds) {
      const dev = `/sys/class/drm/${a.card}/device`
      await add(`amdgpu:${a.card}`, `amdgpu.${a.card}.level`, 'Performance level', `${dev}/power_dpm_force_performance_level`, !!a.level, { options: ['auto', 'low', 'high', 'manual'], risk: 'low' })
      if (a.od?.sclk) await add(`amdgpu:${a.card}`, `amdgpu.${a.card}.sclk_mhz`, 'Core clock (OverDrive)', `${dev}/pp_od_clk_voltage`, true, { min: a.od.sclk[0], max: a.od.sclk[1], unit: 'MHz', scale: 1, step: 5, rangeSource: 'the driver\'s OverDrive range (OD_RANGE)', risk: 'high' })
      if (a.od?.mclk) await add(`amdgpu:${a.card}`, `amdgpu.${a.card}.mclk_mhz`, 'Memory clock (OverDrive)', `${dev}/pp_od_clk_voltage`, true, { min: a.od.mclk[0], max: a.od.mclk[1], unit: 'MHz', scale: 1, step: 5, rangeSource: 'the driver\'s OverDrive range (OD_RANGE)', risk: 'high' })
      if (!a.od) absent(`amdgpu:${a.card}`, `amdgpu.${a.card}.overdrive`, 'Clock overdrive', 'unavailable', 'OverDrive is disabled in the driver. It is enabled with the kernel parameter amdgpu.ppfeaturemask=0xffffffff (a boot setting this app does not change).')
      if (a.cap) {
        const hw = (await this.d.reader.dir(`${dev}/hwmon`)).find(Boolean)
        await add(`amdgpu:${a.card}`, `amdgpu.${a.card}.power_cap_uw`, 'Power limit', `${dev}/hwmon/${hw}/power1_cap`, true, { min: a.cap.min, max: a.cap.max, unit: 'W', scale: W, step: W, rangeSource: 'the board\'s limits (power1_cap_min – power1_cap_max)', risk: 'medium' })
      }
    }
    if (s.nvidia) {
      const n = s.nvidia
      await add('nvidia', 'nvidia.power_w', 'Power limit', 'nvidia-smi', n.max > n.min, { min: n.min, max: n.max, unit: 'W', scale: 1, step: 1, rangeSource: 'the card\'s limits reported by nvidia-smi', risk: 'medium' }, true)
      absent('nvidia', 'nvidia.clock_offset', 'Clock offsets', 'unavailable', 'NVIDIA clock offsets need nvidia-settings with Coolbits under X11; there is no supported interface for them here.')
    }
    return out
  }

  /** A stable, non-identifying fingerprint of this hardware: profiles and history only apply to the same configuration. */
  fingerprint(s: Snapshot): string {
    const shape = { cpu: s.cpu ? [s.cpu.model, s.cpu.policies.length, s.cpu.hwMinKhz, s.cpu.hwMaxKhz, s.cpu.driver] : null, rapl: !!s.rapl, igpu: s.igpus.map((g) => [g.card, g.driver, g.rpn, g.rp0]), amd: s.amds.map((a) => [a.card, a.name]), nvidia: s.nvidia?.name ?? null }
    return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16)
  }

  // ---- telemetry: actual measurements, each with its source and time -----------------------------

  private async cpuStat(): Promise<{ idle: number; total: number } | null> {
    const line = (await this.d.reader.text('/proc/stat'))?.split('\n')[0]
    const v = line?.startsWith('cpu ') ? line.trim().split(/\s+/).slice(1).map(Number) : null
    if (!v || v.length < 5 || v.some((x) => !Number.isFinite(x))) return null
    return { idle: v[3]! + (v[4] ?? 0), total: v.reduce((a, b) => a + b, 0) }
  }

  private async throttleTotal(): Promise<number | null> {
    let total = 0
    let seen = false
    for (const cpu of (await this.d.reader.dir(CPU)).filter((x) => /^cpu\d+$/.test(x))) {
      const core = num(await this.d.reader.text(`${CPU}/${cpu}/thermal_throttle/core_throttle_count`))
      if (core !== undefined) { total += core; seen = true }
    }
    const pkg = num(await this.d.reader.text(`${CPU}/cpu0/thermal_throttle/package_throttle_count`))
    if (pkg !== undefined) { total += pkg; seen = true }
    return seen ? total : null
  }

  private async cpuTemp(): Promise<{ c: number; crit: number | null; source: string } | null> {
    for (const h of await this.d.reader.dir('/sys/class/hwmon')) {
      if (!['coretemp', 'k10temp', 'zenpower'].includes(t(await this.d.reader.text(`/sys/class/hwmon/${h}/name`)) ?? '')) continue
      const v = num(await this.d.reader.text(`/sys/class/hwmon/${h}/temp1_input`))
      if (v === undefined) continue
      const c = num(await this.d.reader.text(`/sys/class/hwmon/${h}/temp1_crit`))
      return { c: v / 1000, crit: c ? c / 1000 : null, source: `/sys/class/hwmon/${h}/temp1_input` }
    }
    return null
  }

  async telemetry(s: Snapshot): Promise<Measurement[]> {
    const r = this.d.reader
    const at = (): string => this.now().toISOString()
    const live = (label: string, value: string, source: string): Measurement => ({ label, value, source, at: at(), state: 'live' })
    const none = (label: string, source: string, reason: string): Measurement => ({ label, value: null, source, at: null, state: 'unavailable', reason })
    const out: Measurement[] = []
    if (s.cpu) {
      const cur: number[] = []
      for (const p of s.cpu.policies) { const v = num(await r.text(`${CPU}/cpufreq/${p}/scaling_cur_freq`)); if (v) cur.push(v) }
      out.push(cur.length ? live('CPU clock (observed, average)', `${Math.round(cur.reduce((a, b) => a + b, 0) / cur.length / 1000)} MHz`, `${CPU}/cpufreq/policy*/scaling_cur_freq`) : none('CPU clock (observed)', 'scaling_cur_freq', 'The driver does not report the current clock.'))
    }
    const a = await this.cpuStat()
    if (a) {
      await new Promise((res) => setTimeout(res, this.d.rateWindowMs ?? 300))
      const b = await this.cpuStat()
      const dt = b ? b.total - a.total : 0
      out.push(b && dt > 0 ? live('CPU utilisation', `${Math.round((1 - (b.idle - a.idle) / dt) * 100)} %`, '/proc/stat (two readings)') : none('CPU utilisation', '/proc/stat', 'No change between readings.'))
    }
    const temp = await this.cpuTemp()
    out.push(temp ? live('CPU temperature', `${temp.c.toFixed(0)} °C${temp.crit ? ` (device limit ${temp.crit.toFixed(0)} °C)` : ''}`, temp.source) : none('CPU temperature', 'hwmon coretemp/k10temp', 'No CPU temperature sensor driver is loaded.'))
    const thr = await this.throttleTotal()
    out.push(thr !== null ? live('Thermal-throttle events since boot', String(thr), `${CPU}/cpu*/thermal_throttle/*_throttle_count`) : none('Thermal throttling', 'thermal_throttle', 'This CPU/kernel exposes no throttle counters.'))
    if (s.rapl) out.push((await r.text(`${RAPL}/energy_uj`)) !== undefined ? live('CPU package energy counter', 'readable', `${RAPL}/energy_uj`) : none('CPU package power', `${RAPL}/energy_uj`, 'The energy counter is readable by root only on this kernel (restricted since Linux 5.10), so power is not measured.'))
    if (s.cpu) out.push(none('CPU core voltage', '—', 'Linux exposes no documented core-voltage reading for this CPU.'))
    for (const g of s.igpus) {
      const act = g.driver === 'i915' ? `/sys/class/drm/${g.card}/gt_act_freq_mhz` : `/sys/class/drm/${g.card}/device/tile0/gt0/freq0/act_freq`
      const v = num(await r.text(act))
      out.push(v === undefined ? none(`GPU ${g.card} clock`, act, 'Not reported.') : live(`GPU ${g.card} clock (observed)`, v === 0 ? 'idle (powered down)' : `${v} MHz`, act))
      out.push(none(`GPU ${g.card} utilisation`, '—', 'Intel GPU busy time needs the perf PMU (root); not measured.'))
    }
    for (const g of s.amds) {
      const dev = `/sys/class/drm/${g.card}/device`
      const busy = num(await r.text(`${dev}/gpu_busy_percent`))
      out.push(busy === undefined ? none(`${g.name} utilisation`, `${dev}/gpu_busy_percent`, 'Not reported.') : live(`${g.name} utilisation`, `${busy} %`, `${dev}/gpu_busy_percent`))
      const used = num(await r.text(`${dev}/mem_info_vram_used`))
      const total = num(await r.text(`${dev}/mem_info_vram_total`))
      if (used !== undefined && total) out.push(live(`${g.name} VRAM`, `${(used / 2 ** 30).toFixed(1)} / ${(total / 2 ** 30).toFixed(1)} GiB`, `${dev}/mem_info_vram_used`))
      for (const h of await r.dir(`${dev}/hwmon`)) {
        const temp2 = num(await r.text(`${dev}/hwmon/${h}/temp1_input`))
        if (temp2 !== undefined) out.push(live(`${g.name} temperature`, `${(temp2 / 1000).toFixed(0)} °C`, `${dev}/hwmon/${h}/temp1_input`))
        const pw = num(await r.text(`${dev}/hwmon/${h}/power1_average`)) ?? num(await r.text(`${dev}/hwmon/${h}/power1_input`))
        if (pw !== undefined) out.push(live(`${g.name} power`, `${(pw / W).toFixed(1)} W`, `${dev}/hwmon/${h}/power1_average`))
        const mv = num(await r.text(`${dev}/hwmon/${h}/in0_input`))
        if (mv !== undefined) out.push(live(`${g.name} core voltage`, `${(mv / 1000).toFixed(3)} V`, `${dev}/hwmon/${h}/in0_input`))
        const fan = num(await r.text(`${dev}/hwmon/${h}/fan1_input`))
        if (fan !== undefined) out.push(live(`${g.name} fan`, `${fan} RPM`, `${dev}/hwmon/${h}/fan1_input`))
      }
    }
    if (s.nvidia) {
      const q = await this.d.run('nvidia-smi', ['--query-gpu=temperature.gpu,power.draw,utilization.gpu,clocks.sm,clocks.mem,memory.used,memory.total,fan.speed', '--format=csv,noheader,nounits'], { timeoutMs: 4000 })
      const f = q.ok ? q.stdout.split('\n')[0]?.split(',').map((x) => x.trim()) : undefined
      const labels: [string, string][] = [['temperature', '°C'], ['power', 'W'], ['utilisation', '%'], ['core clock', 'MHz'], ['memory clock', 'MHz'], ['VRAM used', 'MiB'], ['VRAM total', 'MiB'], ['fan', '%']]
      if (f && f.length === labels.length) labels.forEach(([l, u], i) => out.push(/^[\d.]+$/.test(f[i]!) ? live(`${s.nvidia!.name} ${l}`, `${f[i]} ${u}`, 'nvidia-smi --query-gpu') : none(`${s.nvidia!.name} ${l}`, 'nvidia-smi', `Not reported (${f[i]}).`)))
      else out.push(none(`${s.nvidia.name} telemetry`, 'nvidia-smi', 'nvidia-smi did not answer.'))
    }
    if (s.memory) {
      const m = s.memory
      out.push(m.availableKb !== undefined ? live('Memory in use', `${((m.totalKb - m.availableKb) / 2 ** 20).toFixed(1)} of ${(m.totalKb / 2 ** 20).toFixed(1)} GiB`, '/proc/meminfo') : none('Memory in use', '/proc/meminfo', 'MemAvailable is not reported.'))
      if (m.modules === null) out.push(none('Memory speed', '/sys/firmware/dmi/entries/17-*/raw', 'The SMBIOS memory tables are readable by root only.'))
    }
    const fans: Measurement[] = []
    for (const h of await r.dir('/sys/class/hwmon')) {
      for (const f of (await r.dir(`/sys/class/hwmon/${h}`)).filter((x) => /^fan\d+_input$/.test(x))) {
        const v = num(await r.text(`/sys/class/hwmon/${h}/${f}`))
        if (v !== undefined) fans.push(live(`Fan (${t(await r.text(`/sys/class/hwmon/${h}/name`)) ?? h} ${f.replace('_input', '')})`, `${v} RPM`, `/sys/class/hwmon/${h}/${f}`))
      }
    }
    out.push(...(fans.length ? fans : [none('Fan speed', '/sys/class/hwmon/*/fan*_input', 'No fan speed sensor is exposed (common on laptops whose fans are run by the embedded controller).')]))
    return out
  }

  /** Quick readings for the live strip and test sessions. Utilisation is measured between successive calls. */
  async live(): Promise<PerfLive> {
    const r = this.d.reader
    const cur: number[] = []
    let cpuMax = 0
    for (const p of (await r.dir(`${CPU}/cpufreq`)).filter((x) => /^policy\d+$/.test(x))) {
      const v = num(await r.text(`${CPU}/cpufreq/${p}/scaling_cur_freq`))
      if (v) cur.push(v)
      cpuMax = Math.max(cpuMax, num(await r.text(`${CPU}/cpufreq/${p}/cpuinfo_max_freq`)) ?? 0)
    }
    let gpu: number | null = null
    let gpuMax: number | null = null
    let gpuSource = ''
    for (const c of (await r.dir('/sys/class/drm')).filter((x) => /^card\d+$/.test(x))) {
      const i915 = `/sys/class/drm/${c}/gt_act_freq_mhz`
      const xe = `/sys/class/drm/${c}/device/tile0/gt0/freq0/act_freq`
      const a = num(await r.text(i915)) ?? num(await r.text(xe))
      if (a !== undefined) { gpu = a; gpuSource = (await r.exists(i915)) ? i915 : xe; gpuMax = num(await r.text(`/sys/class/drm/${c}/gt_RP0_freq_mhz`)) ?? num(await r.text(`/sys/class/drm/${c}/device/tile0/gt0/freq0/rp0_freq`)) ?? null; break }
    }
    const temp = await this.cpuTemp()
    const st = await this.cpuStat()
    let util: number | null = null
    if (st && this.prevStat && st.total > this.prevStat.total) util = Math.round((1 - (st.idle - this.prevStat.idle) / (st.total - this.prevStat.total)) * 100)
    this.prevStat = st
    return {
      at: this.now().toISOString(),
      cpuMHz: cur.length ? Math.round(cur.reduce((a, b) => a + b, 0) / cur.length / 1000) : null, cpuMaxMHz: cpuMax ? cpuMax / 1000 : null,
      cpuUtilization: util, gpuMHz: gpu, gpuMaxMHz: gpuMax, temperatureC: temp?.c ?? null, temperatureLimitC: temp?.crit ?? null, throttleEvents: await this.throttleTotal(),
      sources: { cpuMHz: `${CPU}/cpufreq/policy*/scaling_cur_freq`, cpuUtilization: '/proc/stat', gpuMHz: gpuSource || '—', temperature: temp?.source ?? '—', throttleEvents: `${CPU}/cpu*/thermal_throttle/*_throttle_count` }
    }
  }

  /** What would be restored: every setting a change can touch, as it is now. */
  baselineOf(s: Snapshot): Assignment[] {
    const a: Assignment[] = []
    if (s.tuned?.active) a.push(['tuned.profile', s.tuned.active])
    const c = s.cpu
    if (c) {
      if (c.governor) a.push(['cpu.governor', c.governor])
      if (c.epp) a.push(['cpu.epp', c.epp])
      if (c.turbo !== null) a.push(['cpu.turbo', c.turbo ? '1' : '0'])
      if (c.maxKhz) a.push(['cpu.max_khz', c.maxKhz === c.hwMaxKhz ? 'max' : String(c.maxKhz)])
      if (c.minKhz) a.push(['cpu.min_khz', c.minKhz === c.hwMinKhz ? 'min' : String(c.minKhz)])
      if (c.maxPerf !== undefined) a.push(['cpu.max_perf_pct', String(c.maxPerf)])
      if (c.minPerf !== undefined) a.push(['cpu.min_perf_pct', String(c.minPerf)])
      if (c.dynamicBoost !== undefined) a.push(['cpu.dynamic_boost', String(c.dynamicBoost)])
    }
    if (s.rapl) {
      a.push(['rapl.pl1_uw', String(s.rapl.pl1.limit)])
      if (s.rapl.pl2) a.push(['rapl.pl2_uw', String(s.rapl.pl2.limit)])
    }
    for (const g of s.igpus) {
      a.push([`igpu.${g.card}.max_mhz`, String(g.max)])
      if (g.boost !== undefined) a.push([`igpu.${g.card}.boost_mhz`, String(g.boost)])
      a.push([`igpu.${g.card}.min_mhz`, String(g.min)])
    }
    for (const g of s.amds) {
      if (g.od) a.push([`amdgpu.${g.card}.od_reset`, '1'])
      if (g.cap) a.push([`amdgpu.${g.card}.power_cap_uw`, String(g.cap.cur)])
      if (g.level) a.push([`amdgpu.${g.card}.level`, g.level])
    }
    if (s.nvidia) a.push(['nvidia.power_w', String(s.nvidia.limit)])
    return a
  }


}
