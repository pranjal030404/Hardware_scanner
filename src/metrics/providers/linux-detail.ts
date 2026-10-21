/**
 * Deeper Linux providers: per-logical-CPU load and frequency, CPU time breakdown, context-switch and
 * interrupt rates, load average, thermal-throttle counters, PSI pressure, and memory/swap/paging/NUMA.
 * Everything is read from procfs/sysfs; nothing is derived from an unrelated value, and a missing
 * interface produces no reading (never zero).
 */
import type { SysReader } from '../../collectors/core/sysreader'
import { counterRate, ratioPercent } from '../derive'
import type { MetricProvider, MetricReading, ProviderOutput, SampleContext } from '../types'

const spec = (metric: string, unit: string, description: string, source: string) => ({ metric, unit, description, source })
const CPU_SYS = '/sys/devices/system/cpu'

// ---------------------------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------------------------

export interface Ticks { busy: number; total: number; user: number; system: number; iowait: number; steal: number; irq: number }
export interface ProcStat {
  aggregate?: Ticks
  cpus: Map<number, Ticks>
  ctxt?: number
  intr?: number
  running?: number
  blocked?: number
}

function ticksOf(fields: number[]): Ticks | undefined {
  if (fields.length < 4 || fields.some((n) => !Number.isFinite(n))) return undefined
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields as [number, number, number, number, number?, number?, number?, number?]
  const idleAll = idle + iowait
  const total = user + nice + system + idleAll + irq + softirq + steal
  return { busy: total - idleAll, total, user: user + nice, system, iowait, steal, irq: irq + softirq }
}

/** Parse /proc/stat: aggregate and per-CPU tick counters plus `ctxt`, `intr`, `procs_running/blocked`. */
export function parseProcStatDetail(text: string): ProcStat {
  const out: ProcStat = { cpus: new Map() }
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/)
    const head = f[0] ?? ''
    if (head === 'cpu') out.aggregate = ticksOf(f.slice(1, 9).map(Number))
    else if (/^cpu\d+$/.test(head)) {
      const t = ticksOf(f.slice(1, 9).map(Number))
      if (t) out.cpus.set(Number(head.slice(3)), t)
    } else if (head === 'ctxt') out.ctxt = Number(f[1])
    else if (head === 'intr') out.intr = Number(f[1])
    else if (head === 'procs_running') out.running = Number(f[1])
    else if (head === 'procs_blocked') out.blocked = Number(f[1])
  }
  for (const k of ['ctxt', 'intr', 'running', 'blocked'] as const) if (out[k] !== undefined && !Number.isFinite(out[k])) delete out[k]
  return out
}

export interface Psi { some?: { avg10: number; avg60: number; avg300: number; total: number }; full?: { avg10: number; avg60: number; avg300: number; total: number } }

/** Parse a /proc/pressure/* file. Values are the kernel's own exponentially-smoothed percentages. */
export function parsePsi(text: string): Psi | undefined {
  const out: Psi = {}
  for (const line of text.split('\n')) {
    const m = /^(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)\s+total=(\d+)/.exec(line.trim())
    if (!m) continue
    const v = { avg10: Number(m[2]), avg60: Number(m[3]), avg300: Number(m[4]), total: Number(m[5]) }
    if (Object.values(v).some((n) => !Number.isFinite(n))) return undefined
    out[m[1] as 'some' | 'full'] = v
  }
  return out.some || out.full ? out : undefined
}

export interface LoadAvg { l1: number; l5: number; l15: number; running?: number; total?: number }
export function parseLoadavg(text: string): LoadAvg | undefined {
  const f = text.trim().split(/\s+/)
  const [l1, l5, l15] = f.slice(0, 3).map(Number)
  if (l1 === undefined || l5 === undefined || l15 === undefined || [l1, l5, l15].some((n) => !Number.isFinite(n))) return undefined
  const m = /^(\d+)\/(\d+)$/.exec(f[3] ?? '')
  return { l1, l5, l15, ...(m ? { running: Number(m[1]), total: Number(m[2]) } : {}) }
}

export function parseVmstat(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of text.split('\n')) {
    const m = /^(\w+)\s+(\d+)$/.exec(line.trim())
    if (m) out[m[1]!] = Number(m[2])
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// CPU detail
// ---------------------------------------------------------------------------------------------

interface CpuMap { pkg: number; core: number }
interface CpuDetailState {
  stat: ProcStat
  at: number
  /** logical cpu → (package, core), rebuilt when the set of cpuN directories changes. */
  map: Map<number, CpuMap>
  names: string
}

async function readCpuMap(reader: SysReader): Promise<{ map: Map<number, CpuMap>; names: string }> {
  const names = (await reader.dir(CPU_SYS)).filter((d) => /^cpu\d+$/.test(d)).sort()
  const map = new Map<number, CpuMap>()
  for (const n of names) {
    const pkg = await reader.num(`${CPU_SYS}/${n}/topology/physical_package_id`)
    const core = await reader.num(`${CPU_SYS}/${n}/topology/core_id`)
    if (pkg !== undefined && core !== undefined) map.set(Number(n.slice(3)), { pkg, core })
  }
  return { map, names: names.join(',') }
}

export const linuxCpuDetailProvider: MetricProvider = {
  id: 'metrics.linux.cpu_detail',
  title: 'CPU detail (per logical CPU, time split, rates, throttling)',
  platforms: ['linux'],
  metrics: [
    spec('cpu.logical_utilization:<cpuN>', '%', 'Non-idle share of one logical processor (attached to its physical core)', '/proc/stat cpuN'),
    spec('cpu.frequency:<cpuN>', 'MHz', 'Current frequency of one logical processor as reported by cpufreq', `${CPU_SYS}/cpuN/cpufreq/scaling_cur_freq`),
    spec('cpu.user_pct', '%', 'Time in user mode (user+nice), all CPUs', '/proc/stat'),
    spec('cpu.system_pct', '%', 'Time in kernel mode', '/proc/stat'),
    spec('cpu.iowait_pct', '%', 'Time idle while waiting for I/O (kernel estimate; not a disk-latency measurement)', '/proc/stat'),
    spec('cpu.steal_pct', '%', 'Time taken by the hypervisor (virtual machines only)', '/proc/stat'),
    spec('cpu.irq_pct', '%', 'Time servicing hardware and software interrupts', '/proc/stat'),
    spec('cpu.context_switches', '/s', 'Context switches per second, whole system', '/proc/stat ctxt'),
    spec('cpu.interrupts', '/s', 'Interrupts serviced per second, whole system', '/proc/stat intr'),
    spec('cpu.runnable', 'tasks', 'Tasks currently runnable (includes the sampler itself)', '/proc/stat procs_running'),
    spec('cpu.load_1m', 'load', '1-minute load average (runnable + uninterruptible tasks)', '/proc/loadavg'),
    spec('cpu.load_5m', 'load', '5-minute load average', '/proc/loadavg'),
    spec('cpu.load_15m', 'load', '15-minute load average', '/proc/loadavg'),
    spec('cpu.thermal_throttle_events', 'count', 'Cumulative core+package thermal-throttle events since boot', `${CPU_SYS}/cpuN/thermal_throttle`)
  ],
  isSupported: (c) => c.reader.exists('/proc/stat'),
  async sample(c, prev): Promise<ProviderOutput> {
    const text = await c.reader.text('/proc/stat')
    const stat = text ? parseProcStatDetail(text) : undefined
    if (!stat?.aggregate) return { readings: [], status: 'unavailable', message: '/proc/stat could not be read or parsed', next: undefined }
    const p = prev as CpuDetailState | undefined
    const topo = p && p.names === (await c.reader.dir(CPU_SYS)).filter((d) => /^cpu\d+$/.test(d)).sort().join(',') ? { map: p.map, names: p.names } : await readCpuMap(c.reader)
    const readings: MetricReading[] = []
    const notes: string[] = []
    let resets = 0
    const pkgRef = (pkg: number) => ({ key: `cpu:package:${pkg}` })
    const pkg0 = pkgRef(topo.map.size ? [...topo.map.values()][0]!.pkg : 0)

    if (p) {
      const dt = c.monoMs - p.at
      const a = stat.aggregate
      const b = p.stat.aggregate!
      const dTotal = a.total - b.total
      if (dTotal < 0 || a.user < b.user) resets++
      else {
        for (const [metric, cur, old] of [['cpu.user_pct', a.user, b.user], ['cpu.system_pct', a.system, b.system], ['cpu.iowait_pct', a.iowait, b.iowait], ['cpu.steal_pct', a.steal, b.steal], ['cpu.irq_pct', a.irq, b.irq]] as const) {
          const v = ratioPercent(cur - old, dTotal)
          if (v !== undefined) readings.push({ ref: pkg0, metric, value: v, unit: '%', source: '/proc/stat' })
        }
      }
      for (const [metric, cur, old, src] of [['cpu.context_switches', stat.ctxt, p.stat.ctxt, '/proc/stat ctxt'], ['cpu.interrupts', stat.intr, p.stat.intr, '/proc/stat intr']] as const) {
        if (cur === undefined || old === undefined) continue
        const r = counterRate(old, cur, dt)
        if (r.reset) resets++
        else if (r.value !== undefined) readings.push({ ref: pkg0, metric, value: r.value, unit: '/s', source: src })
      }
      for (const [cpu, now] of stat.cpus) {
        const old = p.stat.cpus.get(cpu)
        const m = topo.map.get(cpu)
        if (!old || !m) continue // new/onlined CPU has no baseline; a CPU without topology files has no honest device to attach to
        const d = now.total - old.total
        if (d < 0) { resets++; continue }
        const u = ratioPercent(now.busy - old.busy, d)
        if (u !== undefined) readings.push({ ref: { key: `cpu:core:${m.pkg}:${m.core}` }, metric: `cpu.logical_utilization:cpu${cpu}`, value: u, unit: '%', source: `/proc/stat cpu${cpu}` })
      }
    }
    if (stat.running !== undefined) readings.push({ ref: pkg0, metric: 'cpu.runnable', value: stat.running, unit: 'tasks', source: '/proc/stat procs_running' })

    const la = parseLoadavg((await c.reader.text('/proc/loadavg')) ?? '')
    if (la) for (const [metric, v] of [['cpu.load_1m', la.l1], ['cpu.load_5m', la.l5], ['cpu.load_15m', la.l15]] as const) readings.push({ ref: pkg0, metric, value: v, unit: 'load', source: '/proc/loadavg' })

    // Live frequency per logical CPU (only where cpufreq exists; absent in many VMs).
    let freqSeen = 0
    for (const [cpu, m] of topo.map) {
      if (!stat.cpus.has(cpu)) continue // offline
      const khz = await c.reader.num(`${CPU_SYS}/cpu${cpu}/cpufreq/scaling_cur_freq`)
      if (khz === undefined) continue
      freqSeen++
      readings.push({ ref: { key: `cpu:core:${m.pkg}:${m.core}` }, metric: `cpu.frequency:cpu${cpu}`, value: khz / 1000, unit: 'MHz', source: `${CPU_SYS}/cpu${cpu}/cpufreq/scaling_cur_freq` })
    }
    if (topo.map.size && !freqSeen) notes.push('cpufreq frequency not exposed')
    if (!topo.map.size) notes.push('per-CPU topology not exposed: per-CPU series unavailable')

    // Thermal-throttle counters: one core counter per physical core (siblings report the same value), one per package.
    const seenCores = new Set<string>()
    const sums = new Map<number, number>()
    for (const [cpu, m] of topo.map) {
      const ck = `${m.pkg}:${m.core}`
      if (!seenCores.has(ck)) {
        const v = await c.reader.num(`${CPU_SYS}/cpu${cpu}/thermal_throttle/core_throttle_count`)
        if (v !== undefined) { seenCores.add(ck); sums.set(m.pkg, (sums.get(m.pkg) ?? 0) + v) }
      }
    }
    for (const [pkg] of sums) {
      const first = [...topo.map].find(([, m]) => m.pkg === pkg)![0]
      const pv = await c.reader.num(`${CPU_SYS}/cpu${first}/thermal_throttle/package_throttle_count`)
      readings.push({ ref: pkgRef(pkg), metric: 'cpu.thermal_throttle_events', value: (sums.get(pkg) ?? 0) + (pv ?? 0), unit: 'count', source: `${CPU_SYS}/cpuN/thermal_throttle/{core,package}_throttle_count` })
    }

    return { readings, status: notes.length ? 'partial' : 'ok', message: notes.join('; ') || undefined, counterResets: resets, next: { stat, at: c.monoMs, map: topo.map, names: topo.names } satisfies CpuDetailState }
  }
}

// ---------------------------------------------------------------------------------------------
// Pressure stall information
// ---------------------------------------------------------------------------------------------

export const linuxPressureProvider: MetricProvider = {
  id: 'metrics.linux.pressure',
  title: 'Resource pressure (PSI)',
  platforms: ['linux'],
  metrics: [
    spec('pressure.cpu_some_avg10', '%', 'Share of the last 10 s in which at least one task waited for CPU (kernel-computed)', '/proc/pressure/cpu'),
    spec('pressure.memory_some_avg10', '%', 'Share of the last 10 s in which at least one task stalled on memory', '/proc/pressure/memory'),
    spec('pressure.memory_full_avg10', '%', 'Share of the last 10 s in which all non-idle tasks stalled on memory', '/proc/pressure/memory'),
    spec('pressure.io_some_avg10', '%', 'Share of the last 10 s in which at least one task stalled on I/O', '/proc/pressure/io'),
    spec('pressure.io_full_avg10', '%', 'Share of the last 10 s in which all non-idle tasks stalled on I/O', '/proc/pressure/io')
  ],
  isSupported: (c) => c.reader.exists('/proc/pressure'),
  async sample(c): Promise<ProviderOutput> {
    const readings: MetricReading[] = []
    const missing: string[] = []
    const targets: [string, { key: string }, [string, 'some' | 'full'][]][] = [
      ['cpu', { key: 'cpu:package:0' }, [['pressure.cpu_some_avg10', 'some']]],
      ['memory', { key: 'memory:system' }, [['pressure.memory_some_avg10', 'some'], ['pressure.memory_full_avg10', 'full']]],
      ['io', { key: 'system:host' }, [['pressure.io_some_avg10', 'some'], ['pressure.io_full_avg10', 'full']]]
    ]
    for (const [res, ref, items] of targets) {
      const t = await c.reader.text(`/proc/pressure/${res}`)
      const psi = t ? parsePsi(t) : undefined
      if (!psi) { missing.push(res); continue }
      for (const [metric, kind] of items) if (psi[kind]) readings.push({ ref, metric, value: psi[kind]!.avg10, unit: '%', source: `/proc/pressure/${res}` })
    }
    if (missing.length === targets.length) return { readings: [], status: 'unavailable', message: 'PSI is not available (kernel built without CONFIG_PSI or booted with psi=0)', next: undefined }
    return { readings, status: missing.length ? 'partial' : 'ok', message: missing.length ? `not exposed: ${missing.join(', ')}` : undefined, next: undefined }
  }
}

// ---------------------------------------------------------------------------------------------
// Memory detail: swap, caches, paging rates, NUMA nodes
// ---------------------------------------------------------------------------------------------

interface MemDetailState { at: number; vm: Record<string, number> }

function meminfoBytes(text: string, key: string): number | undefined {
  const m = new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm').exec(text)
  return m ? parseInt(m[1]!, 10) * 1024 : undefined
}

export const linuxMemoryDetailProvider: MetricProvider = {
  id: 'metrics.linux.memory_detail',
  title: 'Memory detail (swap, cache, paging, NUMA)',
  platforms: ['linux'],
  metrics: [
    spec('memory.swap_used', 'B', 'Swap in use (SwapTotal − SwapFree)', '/proc/meminfo'),
    spec('memory.swap_utilization', '%', 'Swap in use as a share of swap capacity (absent when no swap is configured)', '/proc/meminfo'),
    spec('memory.cached', 'B', 'Page cache (reclaimable under pressure)', '/proc/meminfo Cached'),
    spec('memory.buffers', 'B', 'Block-device buffers', '/proc/meminfo Buffers'),
    spec('memory.dirty', 'B', 'Modified pages not yet written back', '/proc/meminfo Dirty'),
    spec('memory.page_in_rate', 'B/s', 'Data paged in from block devices (includes ordinary file reads)', '/proc/vmstat pgpgin'),
    spec('memory.page_out_rate', 'B/s', 'Data paged out to block devices (includes ordinary file writes)', '/proc/vmstat pgpgout'),
    spec('memory.swap_in_rate', 'pages/s', 'Pages swapped in from swap', '/proc/vmstat pswpin'),
    spec('memory.swap_out_rate', 'pages/s', 'Pages swapped out to swap', '/proc/vmstat pswpout'),
    spec('memory.major_faults_rate', '/s', 'Major page faults (required disk I/O) per second', '/proc/vmstat pgmajfault'),
    spec('memory.node_utilization:<nodeN>', '%', 'NUMA node memory in use: (MemTotal − MemFree) / MemTotal, includes page cache', '/sys/devices/system/node/nodeN/meminfo')
  ],
  isSupported: (c) => c.reader.exists('/proc/meminfo'),
  async sample(c, prev): Promise<ProviderOutput> {
    const mi = await c.reader.text('/proc/meminfo')
    if (!mi) return { readings: [], status: 'unavailable', message: '/proc/meminfo could not be read', next: undefined }
    const ref = { key: 'memory:system' }
    const readings: MetricReading[] = []
    const g = (k: string) => meminfoBytes(mi, k)
    const swapTotal = g('SwapTotal')
    const swapFree = g('SwapFree')
    if (swapTotal !== undefined && swapFree !== undefined) {
      readings.push({ ref, metric: 'memory.swap_used', value: swapTotal - swapFree, unit: 'B', source: '/proc/meminfo' })
      if (swapTotal > 0) readings.push({ ref, metric: 'memory.swap_utilization', value: ((swapTotal - swapFree) / swapTotal) * 100, unit: '%', source: '/proc/meminfo' })
    }
    for (const [metric, key] of [['memory.cached', 'Cached'], ['memory.buffers', 'Buffers'], ['memory.dirty', 'Dirty']] as const) {
      const v = g(key)
      if (v !== undefined) readings.push({ ref, metric, value: v, unit: 'B', source: `/proc/meminfo ${key}` })
    }

    const vmText = await c.reader.text('/proc/vmstat')
    const vm = vmText ? parseVmstat(vmText) : undefined
    const p = prev as MemDetailState | undefined
    let resets = 0
    if (vm && p) {
      const dt = c.monoMs - p.at
      for (const [metric, key, unit, scale] of [
        ['memory.page_in_rate', 'pgpgin', 'B/s', 1024],
        ['memory.page_out_rate', 'pgpgout', 'B/s', 1024],
        ['memory.swap_in_rate', 'pswpin', 'pages/s', 1],
        ['memory.swap_out_rate', 'pswpout', 'pages/s', 1],
        ['memory.major_faults_rate', 'pgmajfault', '/s', 1]
      ] as const) {
        if (vm[key] === undefined || p.vm[key] === undefined) continue
        const r = counterRate(p.vm[key], vm[key]!, dt)
        if (r.reset) resets++
        else if (r.value !== undefined) readings.push({ ref, metric, value: r.value * scale, unit, source: `/proc/vmstat ${key}` })
      }
    }

    for (const n of (await c.reader.dir('/sys/devices/system/node')).filter((d) => /^node\d+$/.test(d))) {
      const t = await c.reader.text(`/sys/devices/system/node/${n}/meminfo`)
      const m = t ? /^Node\s+\d+\s+MemTotal:\s+(\d+)\s*kB[\s\S]*?^Node\s+\d+\s+MemFree:\s+(\d+)\s*kB/m.exec(t) : null
      if (!m || !Number(m[1])) continue
      readings.push({ ref: { key: `numa:node:${n.slice(4)}` }, metric: `memory.node_utilization:${n}`, value: ((Number(m[1]) - Number(m[2])) / Number(m[1])) * 100, unit: '%', source: `/sys/devices/system/node/${n}/meminfo` })
    }
    return { readings, status: vm ? 'ok' : 'partial', message: vm ? undefined : '/proc/vmstat not readable: paging rates unavailable', counterResets: resets, next: vm ? ({ at: c.monoMs, vm } satisfies MemDetailState) : undefined }
  }
}

export const linuxDetailProviders: MetricProvider[] = [linuxCpuDetailProvider, linuxPressureProvider, linuxMemoryDetailProvider]
export type { SampleContext }
