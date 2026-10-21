import { HipEventSchema, type HipEvent, type HipEventType } from '@shared/schemas'
import type { EventRepo } from '../database/repositories'

/** Event types that are history (persisted). The rest are transient UI signals. */
const PERSISTED: ReadonlySet<HipEventType> = new Set([
  'device.discovered', 'device.updated', 'device.connected', 'device.disconnected', 'device.status_changed',
  'collector.failed', 'diagnostic.created', 'diagnostic.resolved', 'inventory.snapshot_created'
])

export type Listener = (e: HipEvent) => void

/**
 * Validates, de-duplicates, persists and fans out events. Duplicate suppression only applies to
 * identical (type, device, summary) events inside a short window, so a udev burst that triggers
 * several rescans does not produce repeated timeline entries.
 */
export class EventBus {
  private listeners = new Set<Listener>()
  private recent = new Map<string, number>()

  constructor(private repo: EventRepo | null, private dedupeWindowMs = 2000, private clock: () => number = Date.now) {}

  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  publish(input: Omit<HipEvent, 'at' | 'deviceId' | 'deviceName' | 'category' | 'collectorId' | 'data'> & Partial<HipEvent>): HipEvent | null {
    const parsed = HipEventSchema.safeParse({ at: new Date(this.clock()).toISOString(), ...input })
    if (!parsed.success) throw new Error(`Invalid event: ${parsed.error.issues[0]?.message}`)
    const e = parsed.data
    const now = this.clock()
    const sig = `${e.type}|${e.deviceId ?? ''}|${e.summary}`
    const last = this.recent.get(sig)
    if (last !== undefined && now - last < this.dedupeWindowMs) return null
    this.recent.set(sig, now)
    if (this.recent.size > 500) for (const [k, t] of this.recent) if (now - t > this.dedupeWindowMs) this.recent.delete(k)
    if (this.repo && PERSISTED.has(e.type)) this.repo.insert(e)
    for (const l of this.listeners) {
      try {
        l(e)
      } catch (err) {
        console.error('event listener failed', err)
      }
    }
    return e
  }
}
