/**
 * Opt-in process monitor. It is deliberately narrow: kernel `comm` names (at most 15 characters), state,
 * thread count, memory and CPU share. Command lines, environment, open files and user names are never
 * read, because they routinely contain secrets. It is Linux-only and read-only.
 */
import type { SysReader } from '../collectors/core/sysreader'

export interface ProcessRow {
  pid: number
  name: string
  state: string
  threads: number | null
  rssBytes: number | null
  /** Percent of ONE logical CPU over the last interval (can exceed 100 for multi-threaded processes); null when no baseline exists. */
  cpuPercent: number | null
}

export interface ProcessSnapshot {
  enabled: boolean
  supported: boolean
  /** Why the list is empty or partial, in plain words. */
  note?: string
  takenAt: string
  /** Milliseconds between the two samples CPU shares are computed from; null on the first sample. */
  intervalMs: number | null
  totalProcesses: number
  topCpu: ProcessRow[]
  topMemory: ProcessRow[]
}

export interface RawProc { pid: number; name: string; state: string; ticks: number; startTicks: number; threads: number; rssPages: number }

/** Parse `/proc/<pid>/stat`. The name sits in parentheses and may itself contain spaces and parentheses, so split at the LAST `)`. */
export function parseProcPidStat(pid: number, text: string): RawProc | undefined {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return undefined
  const f = text.slice(close + 2).trim().split(/\s+/)
  // f[0] = field 3 (state); utime = field 14, stime = 15, num_threads = 20, starttime = 22, rss = 24.
  const n = (i: number): number => Number(f[i])
  const utime = n(11), stime = n(12), threads = n(17), start = n(19), rss = n(21)
  if (![utime, stime, threads, start, rss].every(Number.isFinite) || !f[0]) return undefined
  return { pid, name: text.slice(open + 1, close).slice(0, 32), state: f[0], ticks: utime + stime, startTicks: start, threads, rssPages: Math.max(0, rss) }
}

/** `VmRSS:  12345 kB` → bytes. Kernel threads have no VmRSS line (undefined, not zero). */
export function parseVmRss(status: string | undefined): number | undefined {
  const m = /^VmRSS:\s+(\d+)\s+kB/m.exec(status ?? '')
  return m ? Number(m[1]) * 1024 : undefined
}

const MAX_PIDS = 8192

export class ProcessMonitor {
  private prev: { at: number; ticks: Map<string, number> } | undefined

  /** `clkTck` is USER_HZ, which is 100 on every mainstream Linux architecture. */
  constructor(private readonly reader: SysReader, private readonly monoMs: () => number, private readonly nowIso: () => string = () => new Date().toISOString(), private readonly clkTck = 100) {}

  async snapshot(limit: number): Promise<ProcessSnapshot> {
    const at = this.monoMs()
    const pids = (await this.reader.dir('/proc')).filter((n) => /^\d+$/.test(n)).slice(0, MAX_PIDS)
    const raws: RawProc[] = []
    for (const p of pids) {
      const text = await this.reader.text(`/proc/${p}/stat`)
      const parsed = text ? parseProcPidStat(Number(p), text) : undefined
      if (parsed) raws.push(parsed) // processes that exit mid-scan simply vanish from the list
    }
    const ticks = new Map(raws.map((r) => [`${r.pid}:${r.startTicks}`, r.ticks]))
    const dtSec = this.prev ? (at - this.prev.at) / 1000 : undefined
    const usable = dtSec !== undefined && dtSec > 0.2
    const cpuOf = (r: RawProc): number | null => {
      if (!usable) return null
      const before = this.prev!.ticks.get(`${r.pid}:${r.startTicks}`) // pid reuse changes startTicks, so a reused pid has no baseline
      if (before === undefined || r.ticks < before) return null
      return ((r.ticks - before) / this.clkTck / dtSec!) * 100
    }
    const rows = raws.map((r) => ({ raw: r, cpu: cpuOf(r) }))
    const topCpu = rows.filter((x) => x.cpu !== null).sort((a, b) => b.cpu! - a.cpu!).slice(0, limit)
    const topMem = [...rows].sort((a, b) => b.raw.rssPages - a.raw.rssPages).filter((x) => x.raw.rssPages > 0).slice(0, limit)
    const toRow = async (x: { raw: RawProc; cpu: number | null }): Promise<ProcessRow> => ({
      pid: x.raw.pid, name: x.raw.name, state: x.raw.state, threads: x.raw.threads,
      rssBytes: parseVmRss(await this.reader.text(`/proc/${x.raw.pid}/status`)) ?? null,
      cpuPercent: x.cpu === null ? null : Math.round(x.cpu * 10) / 10
    })
    const out: ProcessSnapshot = {
      enabled: true, supported: true, takenAt: this.nowIso(), intervalMs: usable ? Math.round(dtSec! * 1000) : null, totalProcesses: raws.length,
      topCpu: await Promise.all(topCpu.map(toRow)), topMemory: await Promise.all(topMem.map(toRow))
    }
    if (!usable) out.note = 'CPU shares need two samples; they appear on the next refresh.'
    if (this.reader.denied.size) out.note = `${out.note ? out.note + ' ' : ''}Some processes are hidden from this user (hidepid or permissions), so the list may be incomplete.`
    this.prev = { at, ticks }
    return out
  }

  /** Forget the baseline (used when monitoring is switched off so stale counters are never compared later). */
  reset(): void { this.prev = undefined }
}

export const disabledSnapshot = (nowIso: string, supported = true): ProcessSnapshot => ({
  enabled: false, supported, takenAt: nowIso, intervalMs: null, totalProcesses: 0, topCpu: [], topMemory: [],
  note: supported ? 'Process monitoring is off. Enable it in Settings; only process names, memory and CPU share are read.' : 'Process monitoring is not available on this operating system.'
})
