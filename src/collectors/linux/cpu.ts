import type { DeviceObservation, Limitation } from '@shared/schemas'
import { ObservationBuilder, type CollectContext } from '../core/context'
import type { Collector } from '../core/types'
import { finish } from './shared'
import { groupCores, readCpuTopology, summarizeCaches, type CpuTopology, type LogicalCpu } from './cpu-topology'

const ID = 'linux.cpu'

export interface CpuInfoBlock {
  [k: string]: string
}

export function parseCpuInfo(text: string): CpuInfoBlock[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => {
      const o: CpuInfoBlock = {}
      for (const line of block.split('\n')) {
        const i = line.indexOf(':')
        if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim()
      }
      return o
    })
    .filter((b) => b['processor'] !== undefined)
}

const join = (xs: (string | number)[]): string => xs.join(', ')
const mhz = (khz: number | undefined): number | undefined => (khz === undefined ? undefined : Math.round(khz / 1000))

function addPackageTopology(b: ObservationBuilder, topo: CpuTopology, cpus: LogicalCpu[], flags: Set<string>): void {
  const T = '/sys/devices/system/cpu/cpuN/topology'
  const { cores } = groupCores({ ...topo, cpus })
  const threads = cores.length ? Math.max(...cores.map((c) => c.cpus.length)) : undefined
  const dies = new Set(cpus.map((c) => c.dieId).filter((d): d is number => d !== undefined))
  const nodes = [...new Set(cpus.map((c) => c.numaNode).filter((n): n is number => n !== undefined))].sort((a, c) => a - c)
  const offline = cpus.filter((c) => !c.online).length
  b.prop('topology_cores', cores.length || undefined, `${T}/core_id (distinct per package)`, { evidence: 'derived' })
    .prop('threads_per_core', threads, `${T}/thread_siblings_list`, { evidence: 'derived' })
    .prop('dies', dies.size || undefined, `${T}/die_id (distinct)`, { evidence: 'derived' })
    .prop('numa_nodes', nodes.length ? join(nodes) : undefined, '/sys/devices/system/cpu/cpuN/nodeM')
    .prop('offline_cpus', offline || undefined, '/sys/devices/system/cpu/cpuN/online', { evidence: 'derived' })
    .prop('flags', [...flags].sort().join(' ') || undefined, '/proc/cpuinfo flags')
  if (topo.hybrid) {
    const inPkg = (xs: number[]): number => xs.filter((x) => cpus.some((c) => c.cpu === x)).length
    b.prop('hybrid_layout', `${inPkg(topo.hybrid.performance)} performance + ${inPkg(topo.hybrid.efficiency)} efficiency logical processors`, '/sys/devices/cpu_core/cpus, /sys/devices/cpu_atom/cpus')
  }
  for (const c of summarizeCaches(cpus)) {
    const k = `cache_${c.name.toLowerCase()}`
    const src = `/sys/devices/system/cpu/cpuN/cache/indexM (${c.name})`
    b.prop(`${k}_size`, c.sizeBytes, `${src}/size`, { unit: 'B' })
      .prop(`${k}_instances`, c.instances, `${src}/shared_cpu_list (distinct sets)`, { evidence: 'derived' })
      .prop(`${k}_shared_by_cpus`, c.sharedBy, `${src}/shared_cpu_list`)
      .prop(`${k}_ways`, c.ways, `${src}/ways_of_associativity`)
      .prop(`${k}_line_size`, c.lineSize, `${src}/coherency_line_size`, { unit: 'B' })
  }
  const p = topo.policy
  const F = '/sys/devices/system/cpu/cpu0/cpufreq'
  b.prop('scaling_driver', p.driver, `${F}/scaling_driver`)
    .prop('available_governors', p.governors?.length ? join(p.governors) : undefined, `${F}/scaling_available_governors`)
    .prop('energy_performance_preference', p.epp, `${F}/energy_performance_preference`)
    .prop('boost_enabled', p.boost, p.boostSource ?? 'cpufreq boost', { evidence: 'derived' })
    .prop('idle_driver', topo.idleDriver, '/sys/devices/system/cpu/cpuidle/current_driver')
    .prop('idle_states', topo.idleStates.length ? join(topo.idleStates) : undefined, '/sys/devices/system/cpu/cpu0/cpuidle/stateN/name')
}

/** One device per physical core, linked to its package by the kernel's own topology files. */
function coreObservations(ctx: CollectContext, at: Date, topo: CpuTopology, cpus: LogicalCpu[], pkg: string): DeviceObservation[] {
  const { cores } = groupCores({ ...topo, cpus })
  const kindOf = (cpu: number): string | undefined => (topo.hybrid ? (topo.hybrid.performance.includes(cpu) ? 'performance' : topo.hybrid.efficiency.includes(cpu) ? 'efficiency' : undefined) : undefined)
  void ctx
  return cores.map((g) => {
    const ids = g.cpus.map((c) => c.cpu).sort((a, b) => a - b)
    const T = '/sys/devices/system/cpu/cpuN/topology'
    const b = new ObservationBuilder(ID, `cpu:core:${pkg}:${g.coreId}`, 'cpu', `Core ${g.coreId} (package ${g.packageId})`, at, { sourceProperty: `${T}/core_id`, evidence: 'os_reported' })
      .status(g.cpus.some((c) => c.online) ? 'ok' : 'disabled')
      .field('subtype', 'core', 'derived', 'derived')
      .field('busType', 'cpu', 'derived', 'derived')
      .prop('logical_processors', join(ids.map((i) => `cpu${i}`)), `${T}/thread_siblings_list`)
      .prop('threads', ids.length, `${T}/thread_siblings_list`, { evidence: 'derived' })
      .prop('online', g.cpus.every((c) => c.online), '/sys/devices/system/cpu/cpuN/online')
      .prop('numa_node', g.cpus[0]?.numaNode, '/sys/devices/system/cpu/cpuN/nodeM')
      .prop('core_kind', kindOf(ids[0]!), '/sys/devices/cpu_core|cpu_atom/cpus')
    for (const c of summarizeCaches(g.cpus.filter((x) => x.online))) {
      // Only caches private to this core are attributed to it; shared levels belong to the package.
      const private_ = g.cpus.every((x) => x.caches.filter((y) => y.level === c.level && y.type === c.type).every((y) => y.sharedCpus.every((s) => ids.includes(s))))
      if (private_) b.prop(`cache_${c.name.toLowerCase()}_size`, c.sizeBytes, `/sys/devices/system/cpu/cpuN/cache/indexM/size (${c.name})`, { unit: 'B' })
    }
    b.rel(`cpu:package:${pkg}`, 'physical_parent', `${T}/physical_package_id`)
    return b.build()
  })
}

const NOTABLE_FLAGS = ['vmx', 'svm', 'avx', 'avx2', 'avx512f', 'aes', 'sse4_2', 'hypervisor', 'fma', 'sha_ni']

export const linuxCpu: Collector = {
  id: ID,
  version: '1.1.0',
  platforms: ['linux'],
  categories: ['cpu'],
  permissions: [],
  method: '/proc/cpuinfo + /sys/devices/system/cpu (topology, cache, cpufreq, cpuidle, node)',
  timeoutMs: 5000,
  retries: 1,
  isSupported: (ctx) => ctx.reader.exists('/proc/cpuinfo'),
  async collect(ctx: CollectContext) {
    const r = ctx.reader
    const at = ctx.host.now()
    const text = await r.text('/proc/cpuinfo')
    if (!text) return { outcome: 'unavailable' as const, observations: [], limitations: [{ kind: 'missing_interface' as const, message: '/proc/cpuinfo could not be read' }] }
    const blocks = parseCpuInfo(text)
    // One record per physical package; fall back to a single package when `physical id` is absent (ARM, VMs).
    const packages = new Map<string, CpuInfoBlock[]>()
    for (const b of blocks) {
      const k = b['physical id'] ?? '0'
      packages.set(k, [...(packages.get(k) ?? []), b])
    }
    const out: DeviceObservation[] = []
    const topo = await readCpuTopology(r)
    const limitations: Limitation[] = []
    if (!topo) limitations.push({ kind: 'missing_interface', message: 'Per-CPU topology (/sys/devices/system/cpu/cpuN) is not exposed; cores, caches and NUMA association are unavailable.', target: '/sys/devices/system/cpu' })
    else if (topo.truncated) limitations.push({ kind: 'info', message: 'More than 1024 logical processors: only the first 1024 were inspected.', target: '/sys/devices/system/cpu' })
    if (topo && !topo.policy.driver) limitations.push({ kind: 'missing_interface', message: 'cpufreq is not exposed (virtual machine, or no scaling driver): frequency policy and live frequency are unavailable, not zero.', target: '/sys/devices/system/cpu/cpu0/cpufreq' })
    for (const [pkg, procs] of packages) {
      const first = procs[0]!
      const model = first['model name'] ?? first['Model'] ?? first['Hardware'] ?? first['cpu'] ?? 'Unknown processor'
      const coreIds = new Set(procs.map((p) => `${p['core id'] ?? p['processor']}`))
      const flags = new Set((first['flags'] ?? first['Features'] ?? '').split(/\s+/).filter(Boolean))
      const cpuDir = '/sys/devices/system/cpu'
      const maxKhz = await r.num(`${cpuDir}/cpu0/cpufreq/cpuinfo_max_freq`)
      const minKhz = await r.num(`${cpuDir}/cpu0/cpufreq/cpuinfo_min_freq`)
      const governor = await r.text(`${cpuDir}/cpu0/cpufreq/scaling_governor`)
      const online = await r.text(`${cpuDir}/online`)
      const smt = await r.text(`${cpuDir}/smt/active`)
      const b = new ObservationBuilder(ID, `cpu:package:${pkg}`, 'cpu', model, at, { sourceProperty: '/proc/cpuinfo model name' })
        .status('ok')
        .field('manufacturer', first['vendor_id'] ?? first['CPU implementer'], '/proc/cpuinfo vendor_id')
        .field('model', model, '/proc/cpuinfo model name')
        .field('busType', 'cpu', 'derived', 'derived')
        .prop('logical_processors', procs.length, '/proc/cpuinfo processor count')
        .prop('physical_cores', first['cpu cores'] ? parseInt(first['cpu cores']!, 10) : coreIds.size, first['cpu cores'] ? '/proc/cpuinfo cpu cores' : '/proc/cpuinfo core id count', first['cpu cores'] ? {} : { evidence: 'derived' })
        .prop('family', first['cpu family'], '/proc/cpuinfo cpu family')
        .prop('model_number', first['model'], '/proc/cpuinfo model')
        .prop('stepping', first['stepping'], '/proc/cpuinfo stepping')
        .prop('microcode', first['microcode'], '/proc/cpuinfo microcode')
        .prop('cache_size', first['cache size'], '/proc/cpuinfo cache size')
        .prop('max_frequency', maxKhz !== undefined ? Math.round(maxKhz / 1000) : undefined, `${cpuDir}/cpu0/cpufreq/cpuinfo_max_freq`, { unit: 'MHz' })
        .prop('min_frequency', minKhz !== undefined ? Math.round(minKhz / 1000) : undefined, `${cpuDir}/cpu0/cpufreq/cpuinfo_min_freq`, { unit: 'MHz' })
        .prop('governor', governor, `${cpuDir}/cpu0/cpufreq/scaling_governor`)
        .prop('online_cpus', online, `${cpuDir}/online`)
        .prop('smt_active', smt === undefined ? undefined : smt === '1', `${cpuDir}/smt/active`)
      for (const f of NOTABLE_FLAGS) b.prop(`flag_${f}`, flags.has(f), '/proc/cpuinfo flags', { evidence: 'derived' })
      if (topo) {
        const inPkg = topo.cpus.filter((c) => (c.packageId ?? (packages.size === 1 ? Number(pkg) : -1)) === Number(pkg))
        addPackageTopology(b, topo, inPkg, flags)
        out.push(b.build())
        out.push(...coreObservations(ctx, at, topo, inPkg, pkg))
      } else {
        out.push(b.build())
      }
    }
    return finish(ctx, out, limitations)
  }
}
