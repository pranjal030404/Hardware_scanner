/**
 * Read-only CPU topology from sysfs: logical processors → cores → packages, cache hierarchy,
 * NUMA association, cpufreq policy and hybrid-core kind. Pure parsers are exported for tests; the
 * reader never writes and treats every file as optional (absent ≠ zero).
 */
import type { SysReader } from '../core/sysreader'

const CPU_DIR = '/sys/devices/system/cpu'
const MAX_CPUS = 1024

/** "0-3,8,10-11" → [0,1,2,3,8,10,11]. Malformed or absurdly large lists yield undefined. */
export function parseCpuList(text: string | undefined): number[] | undefined {
  if (text === undefined) return undefined
  const t = text.trim()
  if (t === '') return []
  const out: number[] = []
  for (const part of t.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim())
    if (!m) return undefined
    const a = Number(m[1])
    const b = m[2] === undefined ? a : Number(m[2])
    if (b < a || b - a > MAX_CPUS || out.length + (b - a + 1) > MAX_CPUS) return undefined
    for (let i = a; i <= b; i++) out.push(i)
  }
  return out
}

/** sysfs cache size strings ("48K", "12288K", "2M", "1G") → bytes. */
export function parseCacheSize(text: string | undefined): number | undefined {
  const m = /^(\d+)\s*([KMG]?)$/i.exec((text ?? '').trim())
  if (!m) return undefined
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2]!.toUpperCase() as '' | 'K' | 'M' | 'G']
  return Number(m[1]) * mult
}

export interface CacheInfo {
  level: number
  /** Data, Instruction or Unified, as reported. */
  type: string
  sizeBytes?: number
  ways?: number
  lineSize?: number
  sets?: number
  sharedCpus: number[]
}

export interface LogicalCpu {
  cpu: number
  online: boolean
  packageId?: number
  coreId?: number
  dieId?: number
  siblings?: number[]
  numaNode?: number
  caches: CacheInfo[]
  /** Only present for online CPUs whose cpufreq directory exists. */
  hasCpufreq: boolean
}

export interface FreqPolicy {
  driver?: string
  governors?: string[]
  epp?: string
  maxKhz?: number
  minKhz?: number
  /** True when turbo/boost is reported enabled, false when disabled, undefined when not exposed. */
  boost?: boolean
  boostSource?: string
}

export interface CpuTopology {
  cpus: LogicalCpu[]
  hybrid?: { performance: number[]; efficiency: number[] }
  policy: FreqPolicy
  idleStates: string[]
  idleDriver?: string
  truncated: boolean
}

export const cacheShort = (c: Pick<CacheInfo, 'level' | 'type'>): string =>
  `L${c.level}${c.type === 'Data' ? 'd' : c.type === 'Instruction' ? 'i' : ''}`

async function readCache(r: SysReader, base: string): Promise<CacheInfo[]> {
  const out: CacheInfo[] = []
  for (const idx of (await r.dir(`${base}/cache`)).filter((d) => /^index\d+$/.test(d))) {
    const p = `${base}/cache/${idx}`
    const level = await r.num(`${p}/level`)
    const type = await r.text(`${p}/type`)
    if (level === undefined || !type) continue
    out.push({
      level,
      type,
      sizeBytes: parseCacheSize(await r.text(`${p}/size`)),
      ways: await r.num(`${p}/ways_of_associativity`),
      lineSize: await r.num(`${p}/coherency_line_size`),
      sets: await r.num(`${p}/number_of_sets`),
      sharedCpus: parseCpuList(await r.text(`${p}/shared_cpu_list`)) ?? []
    })
  }
  return out
}

export async function readCpuTopology(r: SysReader): Promise<CpuTopology | undefined> {
  const names = (await r.dir(CPU_DIR)).filter((d) => /^cpu\d+$/.test(d))
  if (!names.length) return undefined
  const ids = names.map((n) => Number(n.slice(3))).sort((a, b) => a - b)
  const truncated = ids.length > MAX_CPUS
  const cpus: LogicalCpu[] = []
  for (const cpu of ids.slice(0, MAX_CPUS)) {
    const base = `${CPU_DIR}/cpu${cpu}`
    // cpu0 usually has no `online` file (cannot be offlined): absent means online.
    const onlineTxt = await r.text(`${base}/online`)
    const online = onlineTxt === undefined ? true : onlineTxt === '1'
    const t = `${base}/topology`
    const siblingsTxt = (await r.text(`${t}/thread_siblings_list`)) ?? (await r.text(`${t}/core_cpus_list`))
    const node = (await r.dir(base)).find((d) => /^node\d+$/.test(d))
    cpus.push({
      cpu,
      online,
      packageId: await r.num(`${t}/physical_package_id`),
      coreId: await r.num(`${t}/core_id`),
      dieId: await r.num(`${t}/die_id`),
      siblings: parseCpuList(siblingsTxt),
      numaNode: node ? Number(node.slice(4)) : undefined,
      caches: online ? await readCache(r, base) : [],
      hasCpufreq: await r.exists(`${base}/cpufreq`)
    })
  }

  const perf = parseCpuList(await r.text('/sys/devices/cpu_core/cpus'))
  const eff = parseCpuList(await r.text('/sys/devices/cpu_atom/cpus'))
  const hybrid = perf?.length && eff?.length ? { performance: perf, efficiency: eff } : undefined

  const fq = `${CPU_DIR}/cpu0/cpufreq`
  const noTurbo = await r.text(`${CPU_DIR}/intel_pstate/no_turbo`)
  const boostFile = await r.text(`${CPU_DIR}/cpufreq/boost`)
  const maxKhz = await r.num(`${fq}/cpuinfo_max_freq`)
  const minKhz = await r.num(`${fq}/cpuinfo_min_freq`)
  const policy: FreqPolicy = {
    driver: await r.text(`${fq}/scaling_driver`),
    governors: (await r.text(`${fq}/scaling_available_governors`))?.split(/\s+/).filter(Boolean),
    epp: await r.text(`${fq}/energy_performance_preference`),
    maxKhz,
    minKhz,
    ...(noTurbo !== undefined
      ? { boost: noTurbo === '0', boostSource: `${CPU_DIR}/intel_pstate/no_turbo (inverted)` }
      : boostFile !== undefined
        ? { boost: boostFile === '1', boostSource: `${CPU_DIR}/cpufreq/boost` }
        : {})
  }

  const idleStates: string[] = []
  for (const s of (await r.dir(`${CPU_DIR}/cpu0/cpuidle`)).filter((d) => /^state\d+$/.test(d)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))) {
    const n = await r.text(`${CPU_DIR}/cpu0/cpuidle/${s}/name`)
    if (n) idleStates.push(n)
  }
  const idleDriver = await r.text(`${CPU_DIR}/cpuidle/current_driver`)
  return { cpus, hybrid, policy, idleStates, idleDriver, truncated }
}

export interface CoreGroup {
  packageId: number
  coreId: number
  cpus: LogicalCpu[]
}

/** Group online+offline logical CPUs by (package, core). CPUs with no topology files are not grouped (never guessed). */
export function groupCores(topo: CpuTopology): { cores: CoreGroup[]; ungrouped: number[] } {
  const map = new Map<string, CoreGroup>()
  const ungrouped: number[] = []
  for (const c of topo.cpus) {
    if (c.packageId === undefined || c.coreId === undefined) {
      ungrouped.push(c.cpu)
      continue
    }
    const k = `${c.packageId}:${c.coreId}`
    const g = map.get(k) ?? { packageId: c.packageId, coreId: c.coreId, cpus: [] }
    g.cpus.push(c)
    map.set(k, g)
  }
  return { cores: [...map.values()].sort((a, b) => a.packageId - b.packageId || a.coreId - b.coreId), ungrouped }
}

export interface CacheSummary {
  name: string
  type: string
  level: number
  sizeBytes?: number
  ways?: number
  lineSize?: number
  /** Distinct physical instances (distinct sharing sets) among the given CPUs. */
  instances: number
  /** Logical CPUs sharing one instance (largest set seen). */
  sharedBy: number
}

/** Summarise cache levels over a set of logical CPUs; instances are counted by distinct `shared_cpu_list`. */
export function summarizeCaches(cpus: LogicalCpu[]): CacheSummary[] {
  const by = new Map<string, { c: CacheInfo; sets: Set<string> }>()
  for (const cpu of cpus) {
    for (const c of cpu.caches) {
      const k = `${c.level}/${c.type}`
      const e = by.get(k) ?? { c, sets: new Set<string>() }
      e.sets.add(c.sharedCpus.join(',') || `cpu${cpu.cpu}`)
      if ((c.sharedCpus.length ?? 0) > (e.c.sharedCpus.length ?? 0)) e.c = c
      by.set(k, e)
    }
  }
  return [...by.values()]
    .map(({ c, sets }) => ({ name: cacheShort(c), type: c.type, level: c.level, sizeBytes: c.sizeBytes, ways: c.ways, lineSize: c.lineSize, instances: sets.size, sharedBy: Math.max(1, c.sharedCpus.length) }))
    .sort((a, b) => a.level - b.level || a.type.localeCompare(b.type))
}
