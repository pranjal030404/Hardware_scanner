import { ratioPercent } from '../derive'
import type { MetricProvider, ProviderOutput } from '../types'

/**
 * Cross-platform fallbacks built on Node's `os` module (used on Windows/macOS where /proc does not
 * exist). Same metric names as the Linux providers. NOTE: only fixture-tested; never run on Windows.
 */
interface OsCpuState { busy: number; total: number }

export const osCpuProvider: MetricProvider = {
  id: 'metrics.os.cpu',
  title: 'CPU utilisation (os module)',
  platforms: ['win32', 'darwin'],
  metrics: [{ metric: 'cpu.utilization', unit: '%', description: 'Share of CPU time not idle, from os.cpus() times', source: 'os.cpus()' }],
  isSupported: async () => true,
  async sample(c, prev): Promise<ProviderOutput> {
    let busy = 0
    let total = 0
    for (const cpu of c.os.cpus()) {
      const t = cpu.times
      busy += t.user + t.nice + t.sys + t.irq
      total += t.user + t.nice + t.sys + t.irq + t.idle
    }
    if (!total) return { readings: [], status: 'unavailable', message: 'os.cpus() returned no data', next: undefined }
    const p = prev as OsCpuState | undefined
    const readings = []
    let resets = 0
    if (p) {
      if (total < p.total) resets++
      else {
        const u = ratioPercent(busy - p.busy, total - p.total)
        if (u !== undefined) readings.push({ ref: { key: 'cpu:package:0' }, metric: 'cpu.utilization', value: u, unit: '%', source: 'os.cpus()' })
      }
    }
    return { readings, status: 'ok', counterResets: resets, next: { busy, total } satisfies OsCpuState }
  }
}

export const osMemoryProvider: MetricProvider = {
  id: 'metrics.os.memory',
  title: 'Memory (os module)',
  platforms: ['win32', 'darwin'],
  metrics: [
    { metric: 'memory.utilization', unit: '%', description: 'Memory in use from os.totalmem()/os.freemem()', source: 'os.totalmem/freemem' },
    { metric: 'memory.available', unit: 'B', description: 'Free memory reported by the OS', source: 'os.freemem()' }
  ],
  isSupported: async () => true,
  async sample(c): Promise<ProviderOutput> {
    const total = c.os.totalmem()
    const free = c.os.freemem()
    if (!(total > 0) || !(free >= 0)) return { readings: [], status: 'unavailable', message: 'os memory info unavailable', next: undefined }
    const ref = { key: 'memory:system' }
    return {
      readings: [
        { ref, metric: 'memory.utilization', value: ((total - free) / total) * 100, unit: '%', source: 'os.totalmem/freemem' },
        { ref, metric: 'memory.available', value: free, unit: 'B', source: 'os.freemem()' }
      ],
      status: 'ok', next: undefined
    }
  }
}

export const osProviders: MetricProvider[] = [osCpuProvider, osMemoryProvider]
