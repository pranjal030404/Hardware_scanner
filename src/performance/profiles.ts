import { unlockedCpu, type Assignment, type CapabilityService, type Snapshot } from './capabilities'
import type { BuiltinProfileId, PerfControl, PresetChange, ProfilePlan } from './types'

const first = (wanted: readonly string[], available: readonly string[]): string | undefined => wanted.find((w) => available.includes(w))

export const BUILTIN_TITLES: Record<BuiltinProfileId, string> = { stock: 'Stock (default)', quiet: 'Quiet (low power)', balanced: 'Balanced', performance: 'Performance', maximum: 'Maximum (hardware limits)' }

/** Settings are written in this order: tuned first (it rewrites CPU settings), governor before preference, PL2 before PL1. */
const ORDER = ['tuned.profile', 'cpu.governor', 'cpu.epp', 'cpu.turbo', 'cpu.max_khz', 'cpu.min_khz', 'cpu.max_perf_pct', 'cpu.min_perf_pct', 'cpu.dynamic_boost', 'rapl.pl2_uw', 'rapl.pl1_uw']
const rank = (id: string): number => {
  const i = ORDER.indexOf(id)
  if (i >= 0) return i
  if (id.startsWith('igpu.')) return 20 + ['max_mhz', 'boost_mhz', 'min_mhz'].indexOf(id.split('.')[2]!)
  if (id.startsWith('amdgpu.')) return 30 + ['od_reset', 'level', 'sclk_mhz', 'mclk_mhz', 'power_cap_uw'].indexOf(id.split('.')[2]!)
  return 40
}
export const ordered = (a: Assignment[]): Assignment[] => [...a].sort((x, y) => rank(x[0]) - rank(y[0]))

/** risks: per-setting risk overrides (e.g. clocks pinned at their maximum keep the chip hot even when idle). */
interface Built { assignments: Assignment[]; notes: Map<string, string>; skipped: string[]; risks?: Map<string, 'low' | 'medium' | 'high'> }

/**
 * The settings a built-in profile writes on this device. Every value comes from what the device
 * reports: its governors, energy preferences, turbo switch, clock range, the GPU's own efficient and
 * top clocks, the firmware power rating, tuned's profiles and recommendation.
 */
/**
 * Every writable control at the upper limit the hardware itself reports: full clock range with the
 * minimum pinned at the top, GPU pinned at RP0, AMD OverDrive clocks and board power at the driver's
 * maximum, NVIDIA power at the card's maximum. Where the hardware reports no upper limit (CPU power
 * above the firmware rating) nothing is invented: the value is left as it is and listed.
 */
function maximumAssignments(s: Snapshot): Built {
  const a: Assignment[] = []
  const notes = new Map<string, string>()
  const skipped: string[] = []
  const set = (id: string, v: string, note?: string): void => { a.push([id, v]); if (note) notes.set(id, note) }
  const c = s.cpu
  if (s.tuned) {
    const profile = first(['throughput-performance', 'latency-performance', 'accelerator-performance'], s.tuned.available)
    if (profile) set('tuned.profile', profile)
  }
  if (c) {
    if (c.governors.includes('performance')) set('cpu.governor', 'performance')
    if (c.epps.includes('performance')) set('cpu.epp', 'performance')
    if (c.turbo !== null) set('cpu.turbo', '1', 'boost to the maximum turbo clock')
    if (c.hwMaxKhz) set('cpu.max_khz', 'max', 'the CPU’s reported maximum')
    if (c.hwMaxKhz) set('cpu.min_khz', 'max', 'pinned at the maximum: the CPU no longer slows down when idle')
    if (c.maxPerf !== undefined) set('cpu.max_perf_pct', '100')
    if (c.minPerf !== undefined) set('cpu.min_perf_pct', '100', 'pinned at the maximum')
    if (c.dynamicBoost !== undefined) set('cpu.dynamic_boost', '1')
    skipped.push(`CPU clock above ${c.hwMaxKhz ? `${(c.hwMaxKhz / 1e6).toFixed(2)} GHz` : 'its maximum'}: ${unlockedCpu(c.model) ? 'set in BIOS/UEFI (no runtime interface)' : 'locked by the manufacturer'}`)
  }
  if (s.rapl) {
    if (s.rapl.pl1.max && s.rapl.pl1.limit < s.rapl.pl1.max) set('rapl.pl1_uw', String(s.rapl.pl1.max), 'firmware rating (the highest value the hardware reports)')
    skipped.push(`CPU power limits above ${s.rapl.pl1.max ? `the ${Math.round(s.rapl.pl1.max / 1e6)} W firmware rating` : 'their current values'}: the hardware reports no upper limit, so none is assumed. They can be raised manually under CPU (within the application’s safety ceiling).`)
  }
  for (const g of s.igpus) {
    set(`igpu.${g.card}.max_mhz`, String(g.rp0), 'RP0, the GPU’s reported maximum')
    if (g.boost !== undefined) set(`igpu.${g.card}.boost_mhz`, String(g.rp0))
    set(`igpu.${g.card}.min_mhz`, String(g.rp0), 'pinned at RP0: the GPU no longer slows down when idle')
  }
  for (const g of s.amds) {
    if (g.od?.sclk || g.od?.mclk) {
      set(`amdgpu.${g.card}.level`, 'manual', 'required for OverDrive clocks')
      if (g.od.sclk) set(`amdgpu.${g.card}.sclk_mhz`, String(g.od.sclk[1]), 'top of the driver’s OverDrive range')
      if (g.od.mclk) set(`amdgpu.${g.card}.mclk_mhz`, String(g.od.mclk[1]), 'top of the driver’s OverDrive range')
    } else if (g.level) {
      set(`amdgpu.${g.card}.level`, 'high')
      skipped.push(`${g.name} clocks: OverDrive is disabled in the driver`)
    }
    if (g.cap) set(`amdgpu.${g.card}.power_cap_uw`, String(g.cap.max), 'the board’s maximum (power1_cap_max)')
  }
  if (s.nvidia) set('nvidia.power_w', String(s.nvidia.max), 'the card’s maximum power limit')
  if (s.nvidia) skipped.push(`${s.nvidia.name} clock offsets: no supported interface`)
  if (s.memory) skipped.push('Memory clock and timings: set by the firmware (XMP/EXPO); no runtime interface')
  // Pinned minimum clocks and drivers' maximum clocks/power keep the hardware at full power continuously.
  const risks = new Map<string, 'low' | 'medium' | 'high'>()
  for (const [id] of a) if (/\.min_khz$|\.min_perf_pct$|\.min_mhz$|sclk_mhz$|mclk_mhz$|power_cap_uw$|nvidia\.power_w$/.test(id)) risks.set(id, 'high')
  return { assignments: ordered(a), notes, skipped, risks }
}

export function builtinAssignments(s: Snapshot, p: BuiltinProfileId): Built {
  if (p === 'maximum') return maximumAssignments(s)
  const a: Assignment[] = []
  const notes = new Map<string, string>()
  const skipped: string[] = []
  const c = s.cpu
  const set = (id: string, v: string, note?: string): void => { a.push([id, v]); if (note) notes.set(id, note) }

  if (s.tuned) {
    const profile = p === 'stock' ? s.tuned.recommended ?? undefined
      : first(p === 'performance' ? ['throughput-performance', 'latency-performance', 'accelerator-performance'] : p === 'balanced' ? ['balanced', 'desktop'] : ['balanced-battery', 'powersave', 'balanced'], s.tuned.available)
    if (profile && s.tuned.available.includes(profile)) set('tuned.profile', profile, p === 'stock' ? 'tuned’s own recommendation for this machine (tuned-adm recommend)' : undefined)
    else if (p === 'stock') skipped.push('tuned profile: tuned gives no recommendation, left unchanged')
  }
  if (c) {
    let gov: string | undefined
    if (p === 'stock') {
      // Documented defaults: intel_pstate/amd-pstate in active mode start in "powersave"; other drivers normally use schedutil.
      const active = (c.driver === 'intel_pstate' || c.driver?.startsWith('amd-pstate')) && c.mode !== 'passive'
      gov = active ? first(['powersave'], c.governors) : first(['schedutil'], c.governors)
      if (gov) notes.set('cpu.governor', active ? `the ${c.driver} driver’s default in active mode` : 'the usual kernel default')
      else skipped.push('CPU governor: no documented default among this driver’s choices, left unchanged')
    } else gov = p === 'performance' ? first(['performance'], c.governors) : first(['schedutil', 'powersave', 'ondemand'], c.governors)
    if (gov) a.push(['cpu.governor', gov])
    const epp = first(p === 'stock' ? ['default'] : p === 'performance' ? ['performance'] : p === 'balanced' ? ['balance_performance', 'default'] : ['power', 'balance_power'], c.epps)
    // intel_pstate only accepts "performance" as the energy preference under the performance governor.
    if (epp && !(gov === 'performance' && c.driver === 'intel_pstate' && epp !== 'performance')) set('cpu.epp', epp, p === 'stock' ? 'the firmware’s own default preference' : undefined)
    else if (p === 'stock' && c.epps.length) skipped.push('Energy preference: this CPU offers no "default" choice, left unchanged')
    if (c.turbo !== null) a.push(['cpu.turbo', p === 'quiet' ? '0' : '1'])
    if (c.hwMaxKhz) a.push(['cpu.max_khz', 'max'])
    if (c.hwMinKhz && p !== 'performance') a.push(['cpu.min_khz', 'min'])
    if (c.maxPerf !== undefined) a.push(['cpu.max_perf_pct', '100'])
    if (c.minPerf !== undefined && p !== 'performance') a.push(['cpu.min_perf_pct', '1'])
    if (c.dynamicBoost !== undefined) set('cpu.dynamic_boost', p === 'performance' ? '1' : '0', p === 'stock' ? 'kernel default (off)' : undefined)
  }
  if (s.rapl) {
    if (p === 'stock') {
      if (s.rapl.pl1.max) set('rapl.pl1_uw', String(s.rapl.pl1.max), 'firmware rating')
      else skipped.push('Sustained power (PL1): the firmware reports no factory value, left unchanged')
      if (s.rapl.pl2?.max) set('rapl.pl2_uw', String(s.rapl.pl2.max), 'firmware rating')
      else if (s.rapl.pl2) skipped.push('Short boost power (PL2): the firmware reports no factory value, left unchanged')
    } else if (p === 'performance' && s.rapl.pl1.max && s.rapl.pl1.limit < s.rapl.pl1.max) {
      // Profiles never lower a raised power limit; Performance only brings it up to the firmware rating.
      set('rapl.pl1_uw', String(s.rapl.pl1.max), 'firmware rating')
    }
  }
  for (const g of s.igpus) {
    const efficient = g.rp1 && g.rp1 >= g.rpn && g.rp1 <= g.rp0 ? g.rp1 : undefined
    const top = p === 'quiet' && efficient ? efficient : g.rp0
    set(`igpu.${g.card}.max_mhz`, String(top), p === 'stock' ? 'the driver’s full range' : p === 'quiet' && efficient ? 'the GPU’s efficient clock (RP1)' : undefined)
    if (g.boost !== undefined) a.push([`igpu.${g.card}.boost_mhz`, String(top)])
    set(`igpu.${g.card}.min_mhz`, String(p === 'performance' && efficient ? efficient : g.rpn), p === 'performance' && efficient ? 'the GPU’s efficient clock (RP1): quicker to respond' : undefined)
  }
  for (const g of s.amds) {
    if (p === 'stock' && g.od) a.push([`amdgpu.${g.card}.od_reset`, '1'])
    if (g.level) a.push([`amdgpu.${g.card}.level`, p === 'performance' ? 'high' : p === 'quiet' ? 'low' : 'auto'])
    if (p === 'stock' && g.cap?.def) set(`amdgpu.${g.card}.power_cap_uw`, String(g.cap.def), 'board default')
  }
  if (s.nvidia && (p === 'stock' || (p === 'performance' && s.nvidia.limit < s.nvidia.def))) set('nvidia.power_w', String(s.nvidia.def), 'card default')
  return { assignments: ordered(a), notes, skipped }
}

const rangeProblem = (c: PerfControl, raw: string): string | null => {
  if (c.options) return c.options.includes(raw) ? null : `${c.label}: “${raw}” is not offered by this device`
  if ((raw === 'max' || raw === 'min') && /_khz$/.test(c.id)) return null
  if (c.id.endsWith('.od_reset')) return raw === '1' ? null : `${c.label}: invalid`
  if (!/^\d+$/.test(raw)) return `${c.label}: “${raw}” is not a whole number`
  const v = Number(raw)
  if (c.min !== undefined && v < c.min) return `${c.label}: below this device’s minimum`
  if (c.max !== undefined && v > c.max) return `${c.label}: above the allowed maximum (${c.rangeSource ?? 'device range'})`
  return null
}

/** Checks a requested value against the control this device reports. Null when it may be applied. */
export function validate(controls: Map<string, PerfControl>, id: string, raw: string): string | null {
  const base = id.replace(/\.od_reset$/, '.sclk_mhz')
  const c = controls.get(id) ?? (id.endsWith('.od_reset') ? controls.get(base) : undefined)
  if (!c) return `${id}: this device has no such control`
  if (!c.write) return `${c.label}: ${c.reason ?? 'not writable'}`
  return id.endsWith('.od_reset') ? (raw === '1' ? null : `${c.label}: invalid`) : rangeProblem(c, raw)
}

/** Turns assignments into a reviewable plan: what changes, what is already set, what this device cannot do. */
export function makePlan(caps: CapabilityService, s: Snapshot, controls: PerfControl[], id: string, title: string, builtin: boolean, a: Assignment[], notes = new Map<string, string>(), skipped: string[] = [], incompatible: string | null = null, risks = new Map<string, 'low' | 'medium' | 'high'>()): ProfilePlan {
  const byId = new Map(controls.map((c) => [c.id, c]))
  const changes: PresetChange[] = []
  const unchanged: PresetChange[] = []
  const skip = [...skipped]
  for (const [cid, raw] of a) {
    const ctl = byId.get(cid) ?? (cid.endsWith('.od_reset') ? byId.get(cid.replace(/\.od_reset$/, '.sclk_mhz')) : undefined)
    const d = caps.describe(s, cid, raw)
    if (!ctl || (ctl.status === 'unsupported' || ctl.status === 'unavailable' || ctl.status === 'error')) { skip.push(`${d.label}: ${ctl?.reason ?? 'not on this device'}`); continue }
    const above = ctl.max !== undefined && /^\d+$/.test(raw) && ctl.currentRaw !== null && /^\d+$/.test(ctl.currentRaw) && Number(raw) > Number(ctl.currentRaw)
    // Raising a medium-risk limit is high risk; lowering it is not risky at all.
    const base = ctl.risk === 'medium' && ctl.max !== undefined && /^\d+$/.test(raw) ? (above ? 'high' : 'low') : ctl.risk
    const row: PresetChange = { id: cid, label: d.label, from: d.from, to: d.to, raw, risk: risks.get(cid) ?? base, ...(notes.get(cid) ? { note: notes.get(cid) } : {}) }
    if (d.from === d.to) unchanged.push(row)
    else changes.push(row)
  }
  const shown = changes.slice(0, 3).map((c) => `${c.label.replace(/ \(.*\)$/, '').toLowerCase()} → ${c.to}`)
  const more = changes.length - shown.length
  const total = changes.length + unchanged.length
  const summary = incompatible ? incompatible
    : !total ? 'This device reports nothing this profile can change.'
      : !changes.length ? `Already in effect: all ${total} settings it controls on this device are at its values.`
        : `Changes ${changes.length} of ${total} settings on this device: ${shown.join('; ')}${more ? `; and ${more} more` : ''}.`
  return { id, title, builtin, summary, compatible: incompatible === null, incompatibleReason: incompatible, changes, unchanged, skipped: skip }
}
