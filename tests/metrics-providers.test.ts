import { describe, expect, it } from 'vitest'
import { counterRate, isValidReading, ratioPercent } from '../src/metrics/derive'
import {
  linuxBatteryProvider, linuxCpuProvider, linuxDiskProvider, linuxMemoryProvider, linuxNetworkProvider, linuxThermalProvider, parseBlockStat, parseProcStat
} from '../src/metrics/providers/linux'
import { osCpuProvider, osMemoryProvider } from '../src/metrics/providers/os'
import type { OsInfo, SampleContext } from '../src/metrics/types'
import { SysReader } from '@collectors/core/sysreader'
import { tmpRoot, writeTree, type Tree } from './helpers/fixtures'

const os0: OsInfo = { cpus: () => [], totalmem: () => 0, freemem: () => 0 }
function rig(tree: Tree = {}) {
  const root = tmpRoot()
  writeTree(root, tree)
  const ctx = (monoMs: number, os: OsInfo = os0): SampleContext => ({ reader: new SysReader(root), os, monoMs })
  return { root, ctx, write: (t: Tree) => writeTree(root, t) }
}

describe('derive', () => {
  it('counterRate: normal delta, first sample, bad dt, reset', () => {
    expect(counterRate(1000, 3000, 2000)).toEqual({ value: 1000, reset: false })
    expect(counterRate(undefined, 5, 1000)).toEqual({ reset: false })
    for (const dt of [0, -5, NaN, undefined]) expect(counterRate(1, 2, dt as number)).toEqual({ reset: false })
    expect(counterRate(5000, 100, 1000)).toEqual({ reset: true }) // reset: never a negative rate
    expect(counterRate(1, -2, 1000).value).toBeUndefined()
    expect(counterRate(7, 7, 1000)).toEqual({ value: 0, reset: false }) // a real zero is a real zero
  })
  it('ratioPercent never divides by zero and clamps', () => {
    expect(ratioPercent(50, 200)).toBe(25)
    expect(ratioPercent(1, 0)).toBeUndefined()
    expect(ratioPercent(-1, 10)).toBeUndefined()
    expect(ratioPercent(500, 100)).toBe(100)
    expect(ratioPercent(NaN, 10)).toBeUndefined()
  })
  it('isValidReading rejects nonsense by unit', () => {
    expect(isValidReading(50, '%')).toBe(true)
    for (const [v, u] of [[NaN, '%'], [101, '%'], [-1, '%'], [-5, 'B/s'], [1e16, 'B'], [500, '°C'], [Infinity, 'W']] as const) expect(isValidReading(v, u)).toBe(false)
    expect(isValidReading(-12, 'W')).toBe(true) // discharge power is signed
  })
})

describe('cpu provider', () => {
  const stat = (u: number, n: number, s: number, i: number, w = 0) => `cpu  ${u} ${n} ${s} ${i} ${w} 0 0 0 0 0\ncpu0 1 1 1 1 0 0 0 0 0 0\n`
  it('parses the aggregate line', () => {
    expect(parseProcStat(stat(100, 0, 50, 850, 0))).toEqual({ busy: 150, total: 1000 })
    expect(parseProcStat(stat(100, 0, 50, 800, 50))).toEqual({ busy: 150, total: 1000 }) // iowait counts as idle
    expect(parseProcStat('garbage')).toBeUndefined()
    expect(parseProcStat('cpu  a b c d')).toBeUndefined()
  })
  it('needs two samples; computes utilisation; handles counter reset and recovery', async () => {
    const r = rig({ '/proc/stat': stat(100, 0, 50, 850) })
    const a = await linuxCpuProvider.sample(r.ctx(0), undefined)
    expect(a.readings).toEqual([]) // no baseline: no fabricated 0%
    r.write({ '/proc/stat': stat(200, 0, 100, 1700) }) // +150 busy of +1000 total
    const b = await linuxCpuProvider.sample(r.ctx(5000), a.next)
    expect(b.readings[0]).toMatchObject({ metric: 'cpu.utilization', unit: '%', source: '/proc/stat', ref: { key: 'cpu:package:0' } })
    expect(b.readings[0]!.value).toBeCloseTo(15.0)
    r.write({ '/proc/stat': stat(10, 0, 5, 20) }) // counters went backwards
    const c = await linuxCpuProvider.sample(r.ctx(10000), b.next)
    expect(c.readings).toEqual([]); expect(c.counterResets).toBe(1)
    r.write({ '/proc/stat': stat(110, 0, 55, 120) })
    const d = await linuxCpuProvider.sample(r.ctx(15000), c.next)
    expect(d.readings[0]!.value).toBeCloseTo(60) // recovered against the new baseline
    r.write({ '/proc/stat': stat(110, 0, 55, 120) }) // identical: zero elapsed ticks
    expect((await linuxCpuProvider.sample(r.ctx(20000), d.next)).readings).toEqual([])
  })
  it('reports unavailable for an unreadable source', async () => {
    const r = rig({ '/proc/stat': 'nope' })
    expect((await linuxCpuProvider.sample(r.ctx(0), undefined)).status).toBe('unavailable')
  })
})

describe('memory provider', () => {
  it('derives utilisation from MemAvailable', async () => {
    const r = rig({ '/proc/meminfo': 'MemTotal: 1000 kB\nMemAvailable: 250 kB\n' })
    const o = await linuxMemoryProvider.sample(r.ctx(0), undefined)
    expect(o.readings.map((x) => [x.metric, x.value, x.unit])).toEqual([['memory.utilization', 75, '%'], ['memory.available', 250 * 1024, 'B']])
  })
  it('is unavailable (not 0%) without MemAvailable', async () => {
    const r = rig({ '/proc/meminfo': 'MemTotal: 1000 kB\n' })
    expect(await linuxMemoryProvider.sample(r.ctx(0), undefined)).toMatchObject({ status: 'unavailable', readings: [] })
  })
})

describe('network provider', () => {
  const nic = (n: string, rx: number, tx: number): Tree => ({ [`/sys/class/net/${n}/statistics/rx_bytes`]: `${rx}\n`, [`/sys/class/net/${n}/statistics/tx_bytes`]: `${tx}\n` })
  it('rates come from counter deltas over monotonic time; first sample and new interfaces have no rate', async () => {
    const r = rig(nic('eth0', 1000, 500))
    const a = await linuxNetworkProvider.sample(r.ctx(0), undefined)
    expect(a.readings).toEqual([])
    r.write({ ...nic('eth0', 6000, 1500), ...nic('wlan0', 100, 100) })
    const b = await linuxNetworkProvider.sample(r.ctx(5000), a.next)
    const by = Object.fromEntries(b.readings.map((x) => [x.metric, x]))
    expect(by['network.rx_rate']).toMatchObject({ value: 1000, unit: 'B/s', ref: { key: 'net:eth0' }, source: '/sys/class/net/eth0/statistics/rx_bytes' })
    expect(by['network.tx_rate']!.value).toBe(200)
    expect(b.readings.every((x) => 'key' in x.ref && x.ref.key === 'net:eth0')).toBe(true) // wlan0 just appeared
    r.write({ ...nic('eth0', 7000, 1700), ...nic('wlan0', 1100, 600) })
    expect((await linuxNetworkProvider.sample(r.ctx(10000), b.next)).readings.some((x) => 'key' in x.ref && x.ref.key === 'net:wlan0')).toBe(true)
  })
  it('counter reset yields no negative rate and is counted; vanished interfaces are ignored', async () => {
    const r = rig({ ...nic('eth0', 9000, 9000), ...nic('gone', 1, 1) })
    const a = await linuxNetworkProvider.sample(r.ctx(0), undefined)
    const r2 = rig(nic('eth0', 10, 10))
    const b = await linuxNetworkProvider.sample(r2.ctx(1000), a.next)
    expect(b.readings).toEqual([]); expect(b.counterResets).toBe(2)
    expect(b.next).toMatchObject({ counters: { eth0: { rx: 10, tx: 10 } } })
  })
  it('a stalled clock (dt <= 0) produces no rate instead of dividing by zero', async () => {
    const r = rig(nic('eth0', 1, 1))
    const a = await linuxNetworkProvider.sample(r.ctx(1000), undefined)
    r.write(nic('eth0', 99, 99))
    expect((await linuxNetworkProvider.sample(r.ctx(1000), a.next)).readings).toEqual([])
  })
})

describe('disk provider', () => {
  const stat = (rs: number, ws: number, ticks: number) => `100 0 ${rs} 0 50 0 ${ws} 0 0 ${ticks} 0\n`
  it('parses stat', () => { expect(parseBlockStat(stat(8, 16, 30))).toEqual({ readSectors: 8, writeSectors: 16, ioTicksMs: 30 }); expect(parseBlockStat('1 2')).toBeUndefined() })
  it('computes throughput (sectors×512) and busy%; ignores partitions and virtual devices; capacity is never I/O', async () => {
    const r = rig({ '/sys/block/nvme0n1/stat': stat(0, 0, 0), '/sys/block/nvme0n1p1/stat': stat(0, 0, 0), '/sys/block/zram0/stat': stat(0, 0, 0), '/sys/block/nvme0n1/size': '1000000\n' })
    const a = await linuxDiskProvider.sample(r.ctx(0), undefined)
    r.write({ '/sys/block/nvme0n1/stat': stat(2000, 4000, 1000) })
    const b = await linuxDiskProvider.sample(r.ctx(2000), a.next)
    const by = Object.fromEntries(b.readings.map((x) => [x.metric, x]))
    expect(by['disk.read_rate']).toMatchObject({ value: 512_000, unit: 'B/s', ref: { identifier: { kind: 'block_device', value: 'nvme0n1' } } })
    expect(by['disk.write_rate']!.value).toBe(1_024_000)
    expect(by['disk.busy']).toMatchObject({ value: 50, unit: '%' })
    expect(b.readings.every((x) => 'identifier' in x.ref && x.ref.identifier.value === 'nvme0n1')).toBe(true)
    expect(Object.keys(by).some((m) => /size|capacity|free/.test(m))).toBe(false)
  })
  it('a reset skips the tick for that disk', async () => {
    const r = rig({ '/sys/block/sda/stat': stat(5000, 5000, 5000) })
    const a = await linuxDiskProvider.sample(r.ctx(0), undefined)
    r.write({ '/sys/block/sda/stat': stat(10, 10, 10) })
    const b = await linuxDiskProvider.sample(r.ctx(1000), a.next)
    expect(b.readings).toEqual([]); expect(b.counterResets).toBe(1)
  })
})

describe('battery provider', () => {
  const bat = (extra: Tree): Tree => ({ '/sys/class/power_supply/BAT0/type': 'Battery\n', ...extra })
  it('reports charge and signed power from the driver status', async () => {
    const r = rig(bat({ '/sys/class/power_supply/BAT0/capacity': '73\n', '/sys/class/power_supply/BAT0/status': 'Discharging\n', '/sys/class/power_supply/BAT0/power_now': '8500000\n' }))
    const o = await linuxBatteryProvider.sample(r.ctx(0), undefined)
    expect(o.readings.map((x) => [x.metric, x.value])).toEqual([['battery.charge', 73], ['battery.power', -8.5]])
    const c = rig(bat({ '/sys/class/power_supply/BAT0/status': 'Charging\n', '/sys/class/power_supply/BAT0/current_now': '2000000\n', '/sys/class/power_supply/BAT0/voltage_now': '12000000\n' }))
    expect((await linuxBatteryProvider.sample(c.ctx(0), undefined)).readings[0]).toMatchObject({ metric: 'battery.power', value: 24 })
  })
  it('does not guess direction for an unknown status; reports unavailable without a battery', async () => {
    const r = rig(bat({ '/sys/class/power_supply/BAT0/capacity': '50\n', '/sys/class/power_supply/BAT0/status': 'Unknown\n', '/sys/class/power_supply/BAT0/power_now': '5000000\n' }))
    expect((await linuxBatteryProvider.sample(r.ctx(0), undefined)).readings.map((x) => x.metric)).toEqual(['battery.charge'])
    const ac = rig({ '/sys/class/power_supply/AC/type': 'Mains\n', '/sys/class/power_supply/AC/online': '1\n' })
    expect(await linuxBatteryProvider.sample(ac.ctx(0), undefined)).toMatchObject({ status: 'unavailable', readings: [] })
  })
})

describe('thermal provider', () => {
  const hw = '/sys/devices/platform/coretemp.0/hwmon/hwmon6'
  const tree = (): Tree => ({
    [`${hw}/name`]: 'coretemp\n', [`${hw}/temp1_input`]: '45500\n', [`${hw}/temp1_label`]: 'Package id 0\n', [`${hw}/fan1_input`]: '3200\n',
    '/sys/class/hwmon/hwmon6': { link: hw }
  })
  it('reads temperatures (°C) and fans (RPM) keyed like the sensors collector', async () => {
    const r = rig(tree())
    const o = await linuxThermalProvider.sample(r.ctx(0), undefined)
    expect(o.readings.map((x) => [x.metric, x.value, x.unit]).sort()).toEqual([['fan:fan1', 3200, 'RPM'], ['temperature:Package id 0', 45.5, '°C']])
    expect(o.readings[0]!.ref).toEqual({ key: 'sensor:coretemp:platform/coretemp.0' })
  })
  it('caches channel discovery and degrades to partial when a channel disappears', async () => {
    const r = rig(tree())
    const a = await linuxThermalProvider.sample(r.ctx(0), undefined)
    const { rmSync } = await import('node:fs')
    rmSync(`${r.root}${hw}/fan1_input`)
    const b = await linuxThermalProvider.sample(r.ctx(1000), a.next) // within the discovery cache
    expect(b.status).toBe('partial'); expect(b.readings).toHaveLength(1)
    expect(b.message).toMatch(/unreadable/)
  })
  it('unavailable when no sensors exist', async () => {
    const r = rig({ '/sys/class/hwmon/.keep': '' })
    expect((await linuxThermalProvider.sample(r.ctx(0), undefined)).status).toBe('unavailable')
  })
})

describe('os fallbacks (Windows/macOS; fixture only)', () => {
  const cpus = (busy: number, idle: number) => [{ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } }]
  it('cpu from os.cpus() deltas with reset handling', async () => {
    const r = rig()
    const a = await osCpuProvider.sample(r.ctx(0, { ...os0, cpus: () => cpus(100, 900) }), undefined)
    expect(a.readings).toEqual([])
    const b = await osCpuProvider.sample(r.ctx(1000, { ...os0, cpus: () => cpus(300, 1700) }), a.next)
    expect(b.readings[0]!.value).toBeCloseTo(20)
    const c = await osCpuProvider.sample(r.ctx(2000, { ...os0, cpus: () => cpus(1, 1) }), b.next)
    expect(c.counterResets).toBe(1)
  })
  it('memory from os; unavailable for nonsense', async () => {
    const r = rig()
    expect((await osMemoryProvider.sample(r.ctx(0, { ...os0, totalmem: () => 1000, freemem: () => 400 }), undefined)).readings[0]!.value).toBe(60)
    expect((await osMemoryProvider.sample(r.ctx(0, os0), undefined)).status).toBe('unavailable')
  })
})
