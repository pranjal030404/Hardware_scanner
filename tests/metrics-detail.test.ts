import { describe, expect, it } from 'vitest'
import { isValidReading } from '../src/metrics/derive'
import { linuxCpuDetailProvider, linuxMemoryDetailProvider, linuxPressureProvider, parseLoadavg, parseProcStatDetail, parsePsi, parseVmstat } from '../src/metrics/providers/linux-detail'
import type { OsInfo, SampleContext } from '../src/metrics/types'
import { SysReader } from '@collectors/core/sysreader'
import { tmpRoot, writeTree, type Tree } from './helpers/fixtures'

const os0: OsInfo = { cpus: () => [], totalmem: () => 0, freemem: () => 0 }
function rig(tree: Tree = {}) {
  const root = tmpRoot()
  writeTree(root, tree)
  return { ctx: (monoMs: number): SampleContext => ({ reader: new SysReader(root), os: os0, monoMs }), write: (t: Tree) => writeTree(root, t) }
}
const stat = (cpus: [number, number, number, number][], extra = '') =>
  `cpu  ${cpus.reduce((a, c) => a + c[0], 0)} 0 ${cpus.reduce((a, c) => a + c[1], 0)} ${cpus.reduce((a, c) => a + c[2], 0)} ${cpus.reduce((a, c) => a + c[3], 0)} 0 0 0 0 0\n` +
  cpus.map((c, i) => `cpu${i} ${c[0]} 0 ${c[1]} ${c[2]} ${c[3]} 0 0 0 0 0`).join('\n') + `\n${extra}`
const topo = (n: number): Tree => Object.fromEntries(Array.from({ length: n }, (_, i) => [[`/sys/devices/system/cpu/cpu${i}/topology/physical_package_id`, '0\n'], [`/sys/devices/system/cpu/cpu${i}/topology/core_id`, `${i >> 1}\n`]]).flat())
const val = (r: { readings: { metric: string; value: number }[] }, m: string) => r.readings.find((x) => x.metric === m)?.value

describe('procfs parsers', () => {
  it('parses /proc/stat per CPU and counters, and rejects malformed rows', () => {
    const s = parseProcStatDetail('cpu 10 0 5 80 3 1 1 0\ncpu0 5 0 2 40 1 0 0 0\ncpuX 1 2 3 4\ncpu1 a b c d\nctxt 1000\nintr 500 1 2\nprocs_running 3\nprocs_blocked 0\n')
    expect([...s.cpus.keys()]).toEqual([0])
    expect(s.aggregate).toMatchObject({ user: 10, system: 5, iowait: 3, irq: 2, total: 100, busy: 100 - 83 })
    expect(s).toMatchObject({ ctxt: 1000, intr: 500, running: 3, blocked: 0 })
    expect(parseProcStatDetail('garbage').aggregate).toBeUndefined()
  })
  it('parses PSI, loadavg and vmstat', () => {
    expect(parsePsi('some avg10=0.43 avg60=0.84 avg300=2.47 total=397894248\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n')).toMatchObject({ some: { avg10: 0.43 }, full: { total: 0 } })
    expect(parsePsi('cpu is bad')).toBeUndefined()
    expect(parseLoadavg('0.52 0.80 1.10 3/1420 99999\n')).toEqual({ l1: 0.52, l5: 0.8, l15: 1.1, running: 3, total: 1420 })
    expect(parseLoadavg('x y z')).toBeUndefined()
    expect(parseVmstat('pgpgin 10\nbad line here\npswpout 3\n')).toEqual({ pgpgin: 10, pswpout: 3 })
  })
  it('new units reject negative values', () => {
    for (const u of ['/s', 'pages/s', 'count', 'tasks', 'load', 'MHz']) { expect(isValidReading(-1, u)).toBe(false); expect(isValidReading(0, u)).toBe(true) }
  })
})

describe('metrics.linux.cpu_detail (fixture)', () => {
  const base = (): Tree => ({ ...topo(4), '/proc/loadavg': '1.50 1.00 0.50 2/300 1\n' })

  it('first sample gives instantaneous values only; second gives deltas per logical CPU attached to the physical core', async () => {
    const r = rig({ ...base(), '/proc/stat': stat([[10, 5, 85, 0], [0, 0, 100, 0], [50, 50, 0, 0], [0, 0, 100, 0]], 'ctxt 1000\nintr 2000\nprocs_running 2\n') })
    const first = await linuxCpuDetailProvider.sample(r.ctx(0), undefined)
    expect(val(first, 'cpu.load_1m')).toBe(1.5)
    expect(val(first, 'cpu.runnable')).toBe(2)
    expect(first.readings.some((x) => x.metric.startsWith('cpu.logical_utilization'))).toBe(false) // no baseline → no value (not zero)
    expect(first.readings.some((x) => x.metric === 'cpu.context_switches')).toBe(false)
    r.write({ '/proc/stat': stat([[30, 10, 160, 0], [0, 0, 200, 0], [100, 100, 0, 0], [0, 0, 200, 0]], 'ctxt 3000\nintr 2600\nprocs_running 1\n') })
    const second = await linuxCpuDetailProvider.sample(r.ctx(2000), first.next)
    // cpu0: busy +25 (20 user + 5 system) of total +100 → 25 %; cpu2: busy +100 of +100 → 100 %; cpu1: idle only → 0 %
    const per = Object.fromEntries(second.readings.filter((x) => x.metric.startsWith('cpu.logical_utilization')).map((x) => [x.metric, x]))
    expect(per['cpu.logical_utilization:cpu0']!.value).toBeCloseTo(25)
    expect(per['cpu.logical_utilization:cpu2']!.value).toBeCloseTo(100)
    expect(per['cpu.logical_utilization:cpu1']!.value).toBe(0)
    expect(per['cpu.logical_utilization:cpu0']!.ref).toEqual({ key: 'cpu:core:0:0' })
    expect(per['cpu.logical_utilization:cpu3']!.ref).toEqual({ key: 'cpu:core:0:1' })
    expect(val(second, 'cpu.context_switches')).toBe(1000) // 2000 over 2 s
    expect(val(second, 'cpu.interrupts')).toBe(300)
    expect(val(second, 'cpu.user_pct')).toBeCloseTo(17.5, 5) // aggregate user +70 over total +400
    expect(second.status).toBe('partial') // no cpufreq in this fixture: stated, not faked
    expect(second.message).toMatch(/cpufreq frequency not exposed/)
    expect(second.readings.some((x) => x.metric.startsWith('cpu.frequency'))).toBe(false)
  })

  it('counter reset (e.g. after resume/hotplug) drops the delta, counts the reset, and re-baselines', async () => {
    const r = rig({ ...base(), '/proc/stat': stat([[500, 100, 400, 0], [0, 0, 0, 0]], 'ctxt 9000\nintr 9000\n') })
    const first = await linuxCpuDetailProvider.sample(r.ctx(0), undefined)
    r.write({ '/proc/stat': stat([[5, 1, 4, 0], [0, 0, 0, 0]], 'ctxt 10\nintr 10\n') })
    const second = await linuxCpuDetailProvider.sample(r.ctx(1000), first.next)
    expect(second.counterResets).toBeGreaterThanOrEqual(1)
    expect(second.readings.filter((x) => /user_pct|context_switches|interrupts|logical_utilization/.test(x.metric))).toEqual([])
    r.write({ '/proc/stat': stat([[15, 1, 14, 0], [0, 0, 0, 0]], 'ctxt 110\nintr 60\n') })
    const third = await linuxCpuDetailProvider.sample(r.ctx(2000), second.next)
    expect(val(third, 'cpu.context_switches')).toBe(100)
  })

  it('a CPU that goes offline or appears produces no bogus delta; zero elapsed ticks produce no value', async () => {
    const r = rig({ ...base(), '/proc/stat': stat([[10, 10, 80, 0], [10, 10, 80, 0], [10, 10, 80, 0], [10, 10, 80, 0]]) })
    const first = await linuxCpuDetailProvider.sample(r.ctx(0), undefined)
    r.write({ '/proc/stat': stat([[10, 10, 80, 0], [10, 10, 80, 0]]) }) // cpu2/3 offlined, no ticks elapsed on 0/1
    const second = await linuxCpuDetailProvider.sample(r.ctx(1000), first.next)
    expect(second.readings.filter((x) => x.metric.startsWith('cpu.logical_utilization'))).toEqual([]) // total delta 0 → undefined
  })

  it('reads live frequency and counts each physical core throttle counter once (siblings share it)', async () => {
    const t: Tree = { ...base(), '/proc/stat': stat([[1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 1, 1, 0]]) }
    for (let i = 0; i < 4; i++) {
      t[`/sys/devices/system/cpu/cpu${i}/cpufreq/scaling_cur_freq`] = `${(2 + i) * 500000}\n`
      t[`/sys/devices/system/cpu/cpu${i}/thermal_throttle/core_throttle_count`] = '7\n' // each sibling reports the same core's value
      t[`/sys/devices/system/cpu/cpu${i}/thermal_throttle/package_throttle_count`] = '3\n'
    }
    const r = rig(t)
    const out = await linuxCpuDetailProvider.sample(r.ctx(0), undefined)
    expect(out.readings.find((x) => x.metric === 'cpu.frequency:cpu2')).toMatchObject({ value: 2000, unit: 'MHz', ref: { key: 'cpu:core:0:1' } })
    expect(val(out, 'cpu.thermal_throttle_events')).toBe(7 + 7 + 3) // two cores + one package counter, not 4×7
    expect(out.status).toBe('ok')
  })

  it('without topology files there is no honest device for per-CPU series: they are omitted and the reason is stated', async () => {
    const r = rig({ '/proc/stat': stat([[1, 1, 1, 0]]), '/proc/loadavg': '0.1 0.1 0.1 1/2 3\n' })
    const first = await linuxCpuDetailProvider.sample(r.ctx(0), undefined)
    r.write({ '/proc/stat': stat([[5, 4, 9, 0]]) })
    const second = await linuxCpuDetailProvider.sample(r.ctx(1000), first.next)
    expect(second.readings.some((x) => x.metric.startsWith('cpu.logical_utilization'))).toBe(false)
    expect(second.message).toMatch(/topology not exposed/)
    expect(val(second, 'cpu.system_pct')).toBeGreaterThan(0)
  })

  it('reports unavailable when /proc/stat is unreadable', async () => {
    const out = await linuxCpuDetailProvider.sample(rig({}).ctx(0), undefined)
    expect(out.status).toBe('unavailable')
  })
})

describe('metrics.linux.pressure (fixture)', () => {
  it('reports each resource from its own PSI file and says which are missing', async () => {
    const r = rig({
      '/proc/pressure/cpu': 'some avg10=12.50 avg60=1.00 avg300=1.00 total=1\n',
      '/proc/pressure/memory': 'some avg10=0.10 avg60=0 avg300=0 total=1\nfull avg10=0.05 avg60=0 avg300=0 total=1\n'
    })
    const out = await linuxPressureProvider.sample(r.ctx(0), undefined)
    expect(val(out, 'pressure.cpu_some_avg10')).toBe(12.5)
    expect(val(out, 'pressure.memory_full_avg10')).toBe(0.05)
    expect(out.readings.some((x) => x.metric.startsWith('pressure.io'))).toBe(false)
    expect(out.status).toBe('partial')
    expect(out.message).toMatch(/io/)
  })
  it('unavailable (not zero) without PSI', async () => {
    expect((await linuxPressureProvider.sample(rig({}).ctx(0), undefined)).status).toBe('unavailable')
  })
})

describe('metrics.linux.memory_detail (fixture)', () => {
  const mem = (swapFree: number) => `MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 800 kB\nSwapFree: ${swapFree} kB\nCached: 100 kB\nBuffers: 10 kB\nDirty: 5 kB\n`
  it('computes swap use, cache, paging rates (resets safe) and per-NUMA-node utilisation', async () => {
    const r = rig({
      '/proc/meminfo': mem(600),
      '/proc/vmstat': 'pgpgin 1000\npgpgout 500\npswpin 10\npswpout 20\npgmajfault 5\n',
      '/sys/devices/system/node/node0/meminfo': 'Node 0 MemTotal: 400 kB\nNode 0 MemFree: 100 kB\n',
      '/sys/devices/system/node/node1/meminfo': 'Node 1 MemTotal: 0 kB\nNode 1 MemFree: 0 kB\n'
    })
    const a = await linuxMemoryDetailProvider.sample(r.ctx(0), undefined)
    expect(val(a, 'memory.swap_used')).toBe(200 * 1024)
    expect(val(a, 'memory.swap_utilization')).toBe(25)
    expect(val(a, 'memory.cached')).toBe(100 * 1024)
    expect(a.readings.find((x) => x.metric === 'memory.node_utilization:node0')).toMatchObject({ value: 75, ref: { key: 'numa:node:0' } })
    expect(a.readings.some((x) => x.metric.includes('node1'))).toBe(false) // zero-size node: no division by zero, no value
    expect(a.readings.some((x) => /_rate$/.test(x.metric))).toBe(false)
    r.write({ '/proc/vmstat': 'pgpgin 3000\npgpgout 500\npswpin 30\npswpout 20\npgmajfault 15\n' })
    const b = await linuxMemoryDetailProvider.sample(r.ctx(2000), a.next)
    expect(val(b, 'memory.page_in_rate')).toBe(1000 * 1024)
    expect(val(b, 'memory.page_out_rate')).toBe(0)
    expect(val(b, 'memory.swap_in_rate')).toBe(10)
    expect(val(b, 'memory.major_faults_rate')).toBe(5)
    r.write({ '/proc/vmstat': 'pgpgin 1\npgpgout 1\npswpin 1\npswpout 1\npgmajfault 1\n' })
    const c = await linuxMemoryDetailProvider.sample(r.ctx(4000), b.next)
    expect(c.counterResets).toBe(5)
    expect(c.readings.some((x) => /_rate$/.test(x.metric))).toBe(false)
  })
  it('omits swap utilisation when no swap is configured and degrades without /proc/vmstat', async () => {
    const r = rig({ '/proc/meminfo': 'MemTotal: 1000 kB\nMemAvailable: 500 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n' })
    const out = await linuxMemoryDetailProvider.sample(r.ctx(0), undefined)
    expect(val(out, 'memory.swap_used')).toBe(0)
    expect(val(out, 'memory.swap_utilization')).toBeUndefined()
    expect(out.status).toBe('partial')
    expect(out.message).toMatch(/vmstat/)
  })
})

describe('metrics.linux.gpu', () => {
  const card = '/sys/devices/pci0000:00/0000:00:02.0'
  const tree = (extra: Tree = {}): Tree => ({ [`${card}/vendor`]: '0x8086\n', '/sys/class/drm/card1': { link: `${card}/drm/card1` }, [`${card}/drm/card1/device`]: { link: card }, ...extra })
  it('reads only counters the driver exposes, attached to the PCI device key', async () => {
    const { linuxGpuProvider } = await import('../src/metrics/providers/linux')
    const { ctx } = rig(tree({ [`${card}/drm/card1/gt_act_freq_mhz`]: '450\n' }))
    const r = await linuxGpuProvider.sample(ctx(0), undefined)
    expect(r.status).toBe('ok')
    expect(r.readings).toEqual([expect.objectContaining({ metric: 'gpu.frequency', value: 450, unit: 'MHz', ref: { key: 'pci:0000:00:02.0' } })])
    expect(r.readings.some((x) => x.metric === 'gpu.utilization')).toBe(false) // never fabricated
  })
  it('is unavailable (not zero) with no counters, and rejects out-of-range busy values', async () => {
    const { linuxGpuProvider } = await import('../src/metrics/providers/linux')
    expect((await linuxGpuProvider.sample(rig(tree()).ctx(0), undefined)).status).toBe('unavailable')
    const bad = rig(tree({ [`${card}/drm/card1/device/gpu_busy_percent`]: '250\n' }))
    expect((await linuxGpuProvider.sample(bad.ctx(0), undefined)).readings).toHaveLength(0)
  })
})
