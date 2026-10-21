import { describe, expect, it } from 'vitest'
import { runCollector } from '@collectors/core/collector-runner'
import { linuxCollectors } from '@collectors/linux'
import { cacheShort, groupCores, parseCacheSize, parseCpuList, readCpuTopology, summarizeCaches } from '@collectors/linux/cpu-topology'
import { activeChoice, parseNodeDistance, parseNodeMeminfo, parseSwaps } from '@collectors/linux/memory'
import { SysReader } from '@collectors/core/sysreader'
import type { DeviceObservation } from '@shared/schemas'
import { ctxFor, tmpRoot, writeTree, type Tree } from './helpers/fixtures'

const get = (id: string) => linuxCollectors.find((c) => c.id === id)!
const prop = (o: DeviceObservation | undefined, k: string) => o?.properties.find((p) => p.key === k)

describe('parsers', () => {
  it('parses cpu lists strictly', () => {
    expect(parseCpuList('0-3,8,10-11\n')).toEqual([0, 1, 2, 3, 8, 10, 11])
    expect(parseCpuList('')).toEqual([])
    expect(parseCpuList(undefined)).toBeUndefined()
    for (const bad of ['a', '3-1', '1,,2', '0-999999', '1-', '0x4']) expect(parseCpuList(bad), bad).toBeUndefined()
  })
  it('parses cache sizes', () => {
    expect(parseCacheSize('48K')).toBe(49152)
    expect(parseCacheSize('1280K')).toBe(1310720)
    expect(parseCacheSize('32M')).toBe(33554432)
    expect(parseCacheSize('')).toBeUndefined()
    expect(parseCacheSize('big')).toBeUndefined()
    expect(cacheShort({ level: 1, type: 'Data' })).toBe('L1d')
    expect(cacheShort({ level: 3, type: 'Unified' })).toBe('L3')
  })
  it('parses swaps, node meminfo, distances and THP choice; rejects malformed rows', () => {
    const swaps = parseSwaps('Filename\tType\tSize\tUsed\tPriority\n/dev/zram0 partition 8388604 755488 100\nbroken row\n/swapfile file x y z\n')
    expect(swaps).toEqual([{ name: '/dev/zram0', type: 'partition', sizeBytes: 8388604 * 1024, usedBytes: 755488 * 1024, priority: 100 }])
    expect(parseNodeMeminfo('Node 1 MemTotal:  2048 kB\nNode 1 MemFree:  1024 kB\nNode 1 HugePages_Total: 0\nNode 1 Active(anon):  4 kB\n')).toEqual({ MemTotal: 2048 * 1024, MemFree: 1024 * 1024, 'Active(anon)': 4096 })
    expect(parseNodeDistance('10 21\n')).toEqual([10, 21])
    expect(parseNodeDistance('10 x')).toBeUndefined()
    expect(activeChoice('always [madvise] never')).toBe('madvise')
    expect(activeChoice('never')).toBeUndefined()
  })
})

/** Synthetic two-socket machine: 2 packages × 2 cores × 2 threads, 2 NUMA nodes, cpu7 offline. FIXTURE, not real hardware. */
function serverTree(): Tree {
  const t: Tree = {
    '/proc/cpuinfo': [0, 1, 2, 3, 4, 5, 6].map((i) => `processor\t: ${i}\nvendor_id\t: GenuineIntel\ncpu family\t: 6\nmodel name\t: Test CPU\nphysical id\t: ${i < 4 ? 0 : 1}\ncore id\t\t: ${(i % 4) >> 1}\nflags\t\t: fpu vmx avx2 sse4_2\n`).join('\n'),
    '/sys/devices/system/cpu/cpu0/cpufreq/scaling_driver': 'acpi-cpufreq\n',
    '/sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors': 'performance powersave\n',
    '/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq': '3000000\n',
    '/sys/devices/system/cpu/cpufreq/boost': '1\n',
    '/sys/devices/system/cpu/cpu0/cpuidle/state0/name': 'POLL\n',
    '/sys/devices/system/cpu/cpu0/cpuidle/state1/name': 'C1\n',
    '/sys/devices/system/cpu/cpuidle/current_driver': 'intel_idle\n'
  }
  for (let i = 0; i < 8; i++) {
    const pkg = i < 4 ? 0 : 1
    const base = `/sys/devices/system/cpu/cpu${i}`
    const core = (i % 4) >> 1
    const sib = i % 2 === 0 ? `${i},${i + 1}` : `${i - 1},${i}`
    Object.assign(t, {
      [`${base}/topology/physical_package_id`]: `${pkg}\n`,
      [`${base}/topology/core_id`]: `${core}\n`,
      [`${base}/topology/die_id`]: '0\n',
      [`${base}/topology/thread_siblings_list`]: `${sib}\n`,
      [`${base}/cache/index0/level`]: '1\n', [`${base}/cache/index0/type`]: 'Data\n', [`${base}/cache/index0/size`]: '32K\n', [`${base}/cache/index0/shared_cpu_list`]: `${sib}\n`, [`${base}/cache/index0/ways_of_associativity`]: '8\n', [`${base}/cache/index0/coherency_line_size`]: '64\n',
      [`${base}/cache/index1/level`]: '3\n', [`${base}/cache/index1/type`]: 'Unified\n', [`${base}/cache/index1/size`]: '16384K\n', [`${base}/cache/index1/shared_cpu_list`]: pkg === 0 ? '0-3\n' : '4-7\n',
      [`${base}/node${pkg}`]: { link: `/sys/devices/system/node/node${pkg}` }
    })
    if (i === 7) t[`${base}/online`] = '0\n'
    else if (i > 0) t[`${base}/online`] = '1\n'
  }
  t['/sys/devices/system/node/node0/cpulist'] = '0-3\n'
  t['/sys/devices/system/node/node1/cpulist'] = '4-7\n'
  return t
}

describe('linux.cpu deep topology (fixture)', () => {
  it('builds packages, cores, caches, NUMA association, cpufreq policy and offline CPUs from sysfs', async () => {
    const r = tmpRoot()
    writeTree(r, serverTree())
    const o = await runCollector(get('linux.cpu'), ctxFor(r))
    const obs = o.result!.observations
    const pkgs = obs.filter((d) => d.key.startsWith('cpu:package:'))
    const cores = obs.filter((d) => d.key.startsWith('cpu:core:'))
    expect(pkgs).toHaveLength(2)
    expect(cores.map((c) => c.key).sort()).toEqual(['cpu:core:0:0', 'cpu:core:0:1', 'cpu:core:1:0', 'cpu:core:1:1'])
    const c00 = cores.find((c) => c.key === 'cpu:core:0:0')!
    expect(prop(c00, 'logical_processors')?.value).toBe('cpu0, cpu1')
    expect(prop(c00, 'numa_node')?.value).toBe(0)
    expect(prop(c00, 'cache_l1d_size')?.value).toBe(32768)
    expect(prop(c00, 'cache_l3_size')).toBeUndefined() // shared level is attributed to the package, not the core
    const rel = c00.relationships[0]!
    expect(rel).toMatchObject({ type: 'physical_parent', targetKey: 'cpu:package:0', directness: 'reported' })
    // core 1 of package 1 has cpu7 offline: the core is still reported, and flagged not fully online
    const c11 = cores.find((c) => c.key === 'cpu:core:1:1')!
    expect(prop(c11, 'online')?.value).toBe(false)
    const p1 = pkgs.find((p) => p.key === 'cpu:package:1')!
    expect(prop(p1, 'topology_cores')?.value).toBe(2)
    expect(prop(p1, 'threads_per_core')?.value).toBe(2)
    expect(prop(p1, 'offline_cpus')?.value).toBe(1)
    expect(prop(p1, 'numa_nodes')?.value).toBe('1')
    expect(prop(p1, 'cache_l3_instances')?.value).toBe(1)
    expect(prop(p1, 'cache_l3_shared_by_cpus')?.value).toBe(4)
    expect(prop(p1, 'cache_l1d_instances')?.value).toBe(2)
    expect(prop(p1, 'scaling_driver')?.value).toBe('acpi-cpufreq')
    expect(prop(p1, 'boost_enabled')).toMatchObject({ value: true, evidence: 'derived' })
    expect(prop(p1, 'idle_states')?.value).toBe('POLL, C1')
    expect(prop(p1, 'flags')?.value).toContain('avx2')
    // every property carries its provenance
    for (const d of obs) for (const p of d.properties) { expect(p.sourceProperty, `${d.key}.${p.key}`).toBeTruthy(); expect(p.source).toBe('linux.cpu') }
  })

  it('degrades with an explicit limitation, not invented data, when sysfs topology is absent (VM-like)', async () => {
    const r = tmpRoot()
    writeTree(r, { '/proc/cpuinfo': 'processor\t: 0\nmodel name\t: Virtual CPU\nflags\t\t: fpu hypervisor\n' })
    const o = await runCollector(get('linux.cpu'), ctxFor(r))
    const obs = o.result!.observations
    expect(obs).toHaveLength(1)
    expect(prop(obs[0], 'topology_cores')).toBeUndefined()
    expect(prop(obs[0], 'scaling_driver')).toBeUndefined()
    expect(o.result!.limitations.some((l) => l.kind === 'missing_interface' && /topology/.test(l.message))).toBe(true)
  })

  it('never groups CPUs whose topology files are missing and caps the work', async () => {
    const r = tmpRoot()
    writeTree(r, { '/sys/devices/system/cpu/cpu0/topology/core_id': '0\n', '/sys/devices/system/cpu/cpu1/online': '1\n' })
    const topo = (await readCpuTopology(new SysReader(r)))!
    const { cores, ungrouped } = groupCores(topo)
    expect(cores).toEqual([])
    expect(ungrouped).toEqual([0, 1])
    expect(summarizeCaches(topo.cpus)).toEqual([])
  })

  it('reports hybrid layout only when both kernel PMU cpu lists exist', async () => {
    const r = tmpRoot()
    writeTree(r, { ...serverTree(), '/sys/devices/cpu_core/cpus': '0-3\n', '/sys/devices/cpu_atom/cpus': '4-7\n' })
    const o = await runCollector(get('linux.cpu'), ctxFor(r))
    const p0 = o.result!.observations.find((d) => d.key === 'cpu:package:0')!
    expect(prop(p0, 'hybrid_layout')?.value).toBe('4 performance + 0 efficiency logical processors')
    expect(prop(o.result!.observations.find((d) => d.key === 'cpu:core:0:0'), 'core_kind')?.value).toBe('performance')
    const r2 = tmpRoot()
    writeTree(r2, { ...serverTree(), '/sys/devices/cpu_core/cpus': '0-3\n' })
    const o2 = await runCollector(get('linux.cpu'), ctxFor(r2))
    expect(prop(o2.result!.observations.find((d) => d.key === 'cpu:package:0'), 'hybrid_layout')).toBeUndefined()
  })
})

describe('linux.memory deep (fixture)', () => {
  const base: Tree = {
    '/proc/meminfo': 'MemTotal: 2048000 kB\nMemAvailable: 1000000 kB\nSwapTotal: 1000 kB\nHugepagesize: 2048 kB\nHugePages_Total: 16\nHugePages_Free: 4\n',
    '/proc/swaps': 'Filename\tType\tSize\tUsed\tPriority\n/dev/zram0 partition 1000 10 100\n',
    '/sys/kernel/mm/transparent_hugepage/enabled': 'always [madvise] never\n',
    '/proc/sys/vm/swappiness': '60\n',
    '/sys/devices/system/node/node0/meminfo': 'Node 0 MemTotal: 1024000 kB\n',
    '/sys/devices/system/node/node0/cpulist': '0-3\n',
    '/sys/devices/system/node/node0/distance': '10 21\n',
    '/sys/devices/system/node/node1/meminfo': 'Node 1 MemTotal: 1024000 kB\n',
    '/sys/devices/system/node/node1/cpulist': '\n', // memory-only node
    '/sys/devices/system/node/node1/distance': '21 10\n'
  }
  it('reports NUMA nodes, swap devices, huge pages and THP with provenance; memory-only node is not given CPUs', async () => {
    const r = tmpRoot()
    writeTree(r, base)
    const o = await runCollector(get('linux.memory'), ctxFor(r))
    const obs = o.result!.observations
    const sys = obs.find((d) => d.key === 'memory:system')!
    expect(prop(sys, 'hugepages_total')?.value).toBe(16)
    expect(prop(sys, 'transparent_hugepages')?.value).toBe('madvise')
    expect(prop(sys, 'hugepage_size_bytes')?.value).toBe(2097152)
    const n1 = obs.find((d) => d.key === 'numa:node:1')!
    expect(prop(n1, 'cpus')?.value).toMatch(/memory-only/)
    expect(prop(n1, 'cpu_count')?.value).toBe(0)
    expect(prop(obs.find((d) => d.key === 'numa:node:0'), 'distances')?.value).toBe('10 21')
    const swap = obs.find((d) => d.key === 'memory:swap:/dev/zram0')!
    expect(prop(swap, 'compressed_ram')).toMatchObject({ value: true, evidence: 'derived' })
    expect(prop(swap, 'used_bytes')).toMatchObject({ value: 10240, volatile: true })
  })
  it('states plainly that ECC is not exposed when no EDAC controller exists (it does not guess)', async () => {
    const r = tmpRoot()
    writeTree(r, base)
    const o = await runCollector(get('linux.memory'), ctxFor(r))
    const sys = o.result!.observations.find((d) => d.key === 'memory:system')!
    expect(prop(sys, 'ecc_correctable_errors')).toBeUndefined()
    expect(prop(sys, 'ecc_uncorrectable_errors')).toBeUndefined()
    expect(o.result!.limitations.some((l) => /ECC status and memory-error counters are not exposed/.test(l.message))).toBe(true)
  })
  it('sums EDAC counters across controllers and marks them measured + volatile', async () => {
    const r = tmpRoot()
    writeTree(r, { ...base, '/sys/devices/system/edac/mc/mc0/ce_count': '3\n', '/sys/devices/system/edac/mc/mc0/ue_count': '0\n', '/sys/devices/system/edac/mc/mc1/ce_count': '4\n', '/sys/devices/system/edac/mc/mc1/ue_count': '1\n' })
    const o = await runCollector(get('linux.memory'), ctxFor(r))
    const sys = o.result!.observations.find((d) => d.key === 'memory:system')!
    expect(prop(sys, 'ecc_correctable_errors')).toMatchObject({ value: 7, evidence: 'measured', volatile: true })
    expect(prop(sys, 'ecc_uncorrectable_errors')?.value).toBe(1)
    expect(prop(sys, 'edac_memory_controllers')?.value).toBe(2)
    expect(o.result!.limitations.some((l) => /ECC status/.test(l.message))).toBe(false)
  })
  it('survives missing NUMA/swap interfaces', async () => {
    const r = tmpRoot()
    writeTree(r, { '/proc/meminfo': 'MemTotal: 1024 kB\nMemAvailable: 512 kB\n' })
    const o = await runCollector(get('linux.memory'), ctxFor(r))
    expect(o.result!.observations.map((d) => d.key)).toEqual(['memory:system'])
    expect(o.result!.limitations.some((l) => /NUMA/.test(l.message))).toBe(true)
  })
})
