import type { SysReader } from '../collectors/core/sysreader'

/** Which inventory device a measurement belongs to. Resolved to a stored device id by the sampler. */
export type DeviceRef = { key: string } | { identifier: { kind: string; value: string } }

export interface MetricReading {
  ref: DeviceRef
  /** e.g. `cpu.utilization`, `network.rx_rate`, `temperature:Package id 0`. */
  metric: string
  value: number
  unit: string
  /** The OS interface the value was derived from. */
  source: string
}

export interface MetricSpec {
  metric: string
  unit: string
  description: string
  source: string
}

/** Subset of Node's `os` module so providers are testable and platform-neutral. */
export interface OsInfo {
  cpus(): { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[]
  totalmem(): number
  freemem(): number
}

export interface SampleContext {
  reader: SysReader
  os: OsInfo
  /** Monotonic milliseconds for rate calculations (wall-clock jumps must not distort rates). */
  monoMs: number
}

export interface ProviderOutput {
  readings: MetricReading[]
  status: 'ok' | 'partial' | 'unavailable'
  message?: string
  /** Counter wraps/resets seen this tick (dropped, never turned into negative rates). */
  counterResets?: number
  /** Opaque state handed back on the next call (previous counters etc.). */
  next: unknown
}

export interface MetricProvider {
  readonly id: string
  readonly title: string
  readonly platforms: readonly NodeJS.Platform[]
  readonly metrics: readonly MetricSpec[]
  isSupported(ctx: SampleContext): Promise<boolean>
  /** `prev` is the `next` of the previous call (undefined on the first call or after a pause/failure). */
  sample(ctx: SampleContext, prev: unknown): Promise<ProviderOutput>
}
