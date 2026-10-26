import type { Collector } from '@collectors/core/types'
import { healthFromOutcome, runCollector, type RunOutcome } from '@collectors/core/collector-runner'
import type { CollectContext } from '@collectors/core/context'
import { contentHash, deviceIdFromKey, diffObservations, mergeObservations } from '@collectors/core/normalize'
import type { CollectorHealth, DeviceObservation, ScanSummary } from '@shared/schemas'
import { transaction, type Db } from '../database/db'
import { CollectorRunRepo, InventoryRepo } from '../database/repositories'
import type { EventBus } from './event-bus'

export interface InventoryDeps {
  db: Db
  collectors: Collector[]
  /** A fresh context per collector: the reader tracks permission-denied paths per run. */
  makeContext: () => CollectContext
  bus: EventBus
  platform: string
  /** Collector ids switched off in Settings. */
  disabled?: () => readonly string[]
}

/**
 * Orchestrates collection → normalisation → persistence → events.
 *
 * Disappearance rule: a device is marked missing only when the collector that originally reported
 * it ran to *complete* success in this scan. A failed, unavailable, permission-limited or partial
 * collector can never remove devices — an inspection failure is not "no device".
 */
export class InventoryService {
  readonly repo: InventoryRepo
  private runs: CollectorRunRepo
  private health = new Map<string, CollectorHealth>()
  private inFlight: Promise<ScanSummary> | null = null
  private rescanQueued = false
  scanning = false

  constructor(private d: InventoryDeps) {
    this.repo = new InventoryRepo(d.db)
    this.runs = new CollectorRunRepo(d.db)
    const lastOk = this.runs.lastSuccess()
    for (const c of d.collectors) {
      this.health.set(c.id, {
        id: c.id, version: c.version, platforms: [...c.platforms], categories: [...c.categories], permissions: [...c.permissions],
        method: c.method, status: c.platforms.includes(d.platform as never) ? 'not_scanned' : 'unsupported', partial: false,
        message: null, lastRunAt: null, lastSuccessAt: lastOk.get(c.id) ?? null, durationMs: null, deviceCount: null, limitations: []
      })
    }
  }

  getHealth(staleAfterMs?: number, now = Date.now()): CollectorHealth[] {
    const off = new Set(this.d.disabled?.() ?? [])
    return [...this.health.values()].map((h) => {
      if (off.has(h.id)) return { ...h, disabled: true }
      // An old successful scan is reported as stale rather than silently "available".
      if (staleAfterMs && h.status === 'available' && h.lastSuccessAt && now - Date.parse(h.lastSuccessAt) > staleAfterMs) {
        return { ...h, status: 'stale' as const, message: 'No successful scan within the expected interval' }
      }
      return h
    })
  }

  /** Coalesces concurrent requests: one scan runs, at most one follow-up is queued. */
  scan(collectorIds?: string[]): Promise<ScanSummary> {
    if (this.inFlight) {
      this.rescanQueued = true
      return this.inFlight
    }
    this.scanning = true
    const p = this.doScan(collectorIds).finally(() => {
      this.inFlight = null
      this.scanning = false
      if (this.rescanQueued) {
        this.rescanQueued = false
        void this.scan().catch((e) => console.error('queued rescan failed', e))
      }
    })
    this.inFlight = p
    return p
  }

  private async doScan(only?: string[]): Promise<ScanSummary> {
    const t0 = performance.now()
    const startedAt = new Date()
    const at = startedAt.toISOString()
    // A disabled collector never runs, so it can never mark its devices missing.
    const off = new Set(this.d.disabled?.() ?? [])
    const selected = this.d.collectors.filter((c) => !off.has(c.id) && (!only || only.includes(c.id)))
    const outcomes = await Promise.all(
      selected.map((c) => {
        this.d.bus.publish({ type: 'collector.started', summary: `${c.id} started`, collectorId: c.id })
        return runCollector(c, this.d.makeContext())
      })
    )
    const summary = this.persist(outcomes, at)
    summary.durationMs = Math.round(performance.now() - t0)
    return summary
  }

  private persist(outcomes: RunOutcome[], at: string): ScanSummary {
    const { db, bus } = this.d
    this.repo.ensureSystem(this.d.platform, at)
    const baseline = this.repo.deviceCount() === 0
    const known = this.repo.known()

    const usable = outcomes.filter((o) => o.status === 'available' && o.result)
    // Supplementary observations (e.g. SMART) may only enrich devices another collector reported in
    // this same scan; otherwise a thin record would overwrite the stored device.
    const primary = usable.filter((o) => !o.collector.supplementary).flatMap((o) => o.result!.observations)
    const primaryKeys = new Set(primary.map((o) => o.key))
    const extras = usable.filter((o) => o.collector.supplementary).flatMap((o) => o.result!.observations.filter((x) => primaryKeys.has(x.key)))
    const observed = mergeObservations([...primary, ...extras])
    const completeCollectors = new Set(usable.filter((o) => o.result!.outcome === 'complete').map((o) => o.collector.id))
    const seenKeys = new Set(observed.map((o) => o.key))
    let added = 0
    let removed = 0
    let updated = 0
    const pending: Parameters<EventBus['publish']>[0][] = []

    transaction(db, () => {
      for (const o of observed) {
        const id = deviceIdFromKey(o.key)
        const hash = contentHash(o)
        const prev = known.get(o.key)
        const ref = { deviceId: id, deviceName: o.name, category: o.category, collectorId: o.source }
        if (!prev) {
          added++
          this.repo.upsert(id, o, hash, at)
          if (!baseline) pending.push({ type: 'device.connected', summary: `${o.name} connected`, ...ref, data: { firstSeen: true, bus: o.busType ?? null } })
        } else if (prev.presence === 'missing') {
          added++
          this.repo.upsert(id, o, hash, at)
          pending.push({ type: 'device.connected', summary: `${o.name} reconnected`, ...ref, data: { returning: true } })
        } else if (prev.hash !== hash) {
          const before = this.repo.loadObservation(id)
          const changes = before ? diffObservations(before, o) : []
          updated++
          this.repo.upsert(id, o, hash, at)
          const statusChanged = before !== undefined && before.status !== o.status
          pending.push({
            type: statusChanged ? 'device.status_changed' : 'device.updated',
            summary: statusChanged ? `${o.name}: status ${before!.status} → ${o.status}` : `${o.name} changed`,
            ...ref,
            data: { changes: changes.slice(0, 20) }
          })
        } else {
          this.repo.upsert(id, o, hash, at) // refreshes volatile readings + last_seen
        }
      }
      const gone = [...known.values()].filter((k) => k.presence === 'present' && !seenKeys.has(k.key) && completeCollectors.has(k.source))
      if (gone.length) this.repo.markMissing(gone.map((g) => g.id), at)
      for (const g of gone) {
        removed++
        pending.push({ type: 'device.disconnected', summary: `${g.name} disconnected`, deviceId: g.id, deviceName: g.name, category: g.category as DeviceObservation['category'], collectorId: g.source })
      }
      this.repo.touchSystemScan(at)
    })

    let ok = 0
    let failed = 0
    let unavailable = 0
    for (const o of outcomes) {
      const prevH = this.health.get(o.collector.id)
      const h = healthFromOutcome(o, prevH?.lastSuccessAt ?? null)
      this.health.set(o.collector.id, h)
      if (o.status === 'unsupported') continue
      this.runs.insert(h)
      if (o.status === 'available') ok++
      else if (o.status === 'error') failed++
      else unavailable++
      if (o.status === 'error' && prevH?.status !== 'error') {
        pending.push({ type: 'collector.failed', summary: `${o.collector.id} failed: ${o.message ?? 'unknown error'}`, collectorId: o.collector.id, data: { message: o.message } })
      }
      bus.publish({ type: 'collector.completed', summary: `${o.collector.id}: ${o.status}`, collectorId: o.collector.id, data: { status: o.status, durationMs: o.durationMs } })
    }
    this.runs.prune()
    for (const e of pending) bus.publish(e)
    return { startedAt: at, durationMs: 0, devices: observed.length, added: baseline ? observed.length : added, removed, updated, collectors: { ok, failed, unavailable } }
  }
}
