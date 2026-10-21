import { describe, expect, it } from 'vitest'
import { SysReader } from '@collectors/core/sysreader'
import { disabledSnapshot, parseProcPidStat, parseVmRss, ProcessMonitor } from '../src/processes'
import { IPC_REQUEST_SCHEMAS } from '../src/shared/ipc'
import { SettingsSchema } from '../src/shared/schemas'
import { tmpRoot, writeTree, type Tree } from './helpers/fixtures'

const stat = (pid: number, name: string, utime: number, stime: number, rss = 100, start = 5, threads = 2) =>
  `${pid} (${name}) S 1 1 1 0 -1 4194560 0 0 0 0 ${utime} ${stime} 0 0 20 0 ${threads} 0 ${start} 1000 ${rss} 0\n`

describe('process parsing', () => {
  it('splits at the LAST parenthesis so names with spaces and parentheses survive', () => {
    expect(parseProcPidStat(7, stat(7, 'Web Content (x) y', 30, 12))).toMatchObject({ name: 'Web Content (x) y', ticks: 42, threads: 2, startTicks: 5, rssPages: 100, state: 'S' })
  })
  it('rejects malformed lines instead of guessing', () => {
    expect(parseProcPidStat(1, 'garbage')).toBeUndefined()
    expect(parseProcPidStat(1, '1 (x) S 1 2')).toBeUndefined()
  })
  it('reads VmRSS and treats kernel threads (no VmRSS) as unknown, not zero', () => {
    expect(parseVmRss('Name:\tx\nVmRSS:\t   2048 kB\n')).toBe(2048 * 1024)
    expect(parseVmRss('Name:\tkthreadd\n')).toBeUndefined()
  })
})

describe('ProcessMonitor', () => {
  const rig = (tree: Tree) => { const root = tmpRoot(); writeTree(root, tree); return { reader: new SysReader(root), write: (t: Tree) => writeTree(root, t) } }
  const proc = (pid: number, name: string, u: number, s: number, rss: number, start = 5): Tree => ({ [`/proc/${pid}/stat`]: stat(pid, name, u, s, rss, start), [`/proc/${pid}/status`]: `Name:\t${name}\nVmRSS:\t${rss * 4} kB\n` })

  it('first sample has memory but no CPU shares; second computes shares from tick deltas over monotonic time', async () => {
    const { reader, write } = rig({ ...proc(10, 'busy', 0, 0, 500), ...proc(11, 'idle', 0, 0, 50) })
    let t = 0
    const m = new ProcessMonitor(reader, () => t, () => 'T')
    const first = await m.snapshot(5)
    expect(first.topCpu).toHaveLength(0)
    expect(first.topMemory[0]).toMatchObject({ pid: 10, cpuPercent: null, rssBytes: 500 * 4 * 1024 })
    expect(first.note).toMatch(/two samples/)
    t = 2000
    write({ ...proc(10, 'busy', 100, 0, 500), ...proc(11, 'idle', 1, 0, 50) }) // 100 ticks = 1 CPU-second in 2 s → 50 %
    const second = await m.snapshot(5)
    expect(second.intervalMs).toBe(2000)
    expect(second.topCpu[0]).toMatchObject({ pid: 10, name: 'busy', cpuPercent: 50 })
    expect(second.topCpu[1]!.cpuPercent).toBe(0.5)
  })
  it('does not compare a reused pid with the old process, and skips tick counter regressions', async () => {
    const { reader, write } = rig({ ...proc(10, 'old', 1000, 0, 10, 5), ...proc(12, 'x', 500, 0, 10, 5) })
    let t = 0
    const m = new ProcessMonitor(reader, () => t)
    await m.snapshot(5)
    t = 1000
    write({ ...proc(10, 'new', 5, 0, 10, 99), ...proc(12, 'x', 400, 0, 10, 5) }) // pid 10 reused (new start time); pid 12 counter went backwards
    const s = await m.snapshot(5)
    expect(s.topCpu).toHaveLength(0)
  })
  it('ignores non-numeric /proc entries and processes that vanish mid-scan, and honours the limit', async () => {
    const tree: Tree = { '/proc/self/stat': 'x', '/proc/99/stat': 'broken' }
    for (let i = 1; i <= 8; i++) Object.assign(tree, proc(i, `p${i}`, 0, 0, i * 10))
    const m = new ProcessMonitor(rig(tree).reader, () => 0)
    const s = await m.snapshot(3)
    expect(s.totalProcesses).toBe(8)
    expect(s.topMemory.map((p) => p.pid)).toEqual([8, 7, 6])
  })
  it('never reads command lines or environment', async () => {
    const { reader } = rig({ ...proc(3, 'sec', 0, 0, 10), '/proc/3/cmdline': 'secret --token=abc\0', '/proc/3/environ': 'KEY=secret\0' })
    const s = await new ProcessMonitor(reader, () => 0).snapshot(5)
    expect(JSON.stringify(s)).not.toMatch(/secret|token/)
  })
})

describe('process monitoring is opt-in and bounded', () => {
  it('is off by default and the IPC limit is validated', () => {
    expect(SettingsSchema.parse({}).processMonitoring).toBe(false)
    expect(disabledSnapshot('T').enabled).toBe(false)
    expect(disabledSnapshot('T', false).note).toMatch(/not available/)
    const s = IPC_REQUEST_SCHEMAS['processes:top']
    expect(s.safeParse({ limit: 15 }).success).toBe(true)
    expect(s.safeParse({ limit: 5000 }).success).toBe(false)
    expect(s.safeParse({ limit: 5, pid: 1 }).success).toBe(false)
    expect(s.safeParse({}).data).toEqual({ limit: 15 })
  })
})
