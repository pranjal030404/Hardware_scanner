import type { Category, CollectorResult, Platform } from '@shared/schemas'
import type { CollectContext } from './context'

export interface Collector {
  /** Stable id, e.g. `linux.pci`. Persisted; do not rename lightly. */
  readonly id: string
  readonly version: string
  readonly platforms: readonly Platform[]
  readonly categories: readonly Category[]
  /** Human-readable permissions needed for full results (empty = none). */
  readonly permissions: readonly string[]
  /** How data is obtained, shown in the collector health screen. */
  readonly method: string
  readonly timeoutMs: number
  readonly retries: number
  /**
   * Supplementary collectors only enrich devices that another collector reported in the same scan
   * (e.g. SMART health onto a disk). They can never create or replace a device on their own.
   */
  readonly supplementary?: boolean
  isSupported(ctx: CollectContext): Promise<boolean>
  collect(ctx: CollectContext): Promise<CollectorResult>
}
