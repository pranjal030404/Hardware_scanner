import { randomUUID } from 'node:crypto'
import { compareSnapshots, type CompareOptions } from '../../snapshots/compare'
import type { CollectorCoverage, CollectorHealth, CoverageState, SnapshotComparison, SnapshotMeta } from '@shared/schemas'
import type { Db } from '../database/db'
import { schemaVersion } from '../database/db'
import { SnapshotRepo, type InventoryRepo } from '../database/repositories'
import type { InventoryService } from './inventory'

export interface SnapshotDeps {
  db: Db
  inventory: InventoryService
  appVersion: string
  /** Collector data older than this is "stale" and cannot vouch for absence. */
  freshMs: () => number
  clock?: () => Date
}

/** Map a collector's live health to the coverage state recorded in a snapshot. */
export function coverageState(h: CollectorHealth, now: Date, freshMs: number): CoverageState {
  switch (h.status) {
    case 'available':
      if (h.partial) return 'partial'
      return h.lastSuccessAt && now.getTime() - Date.parse(h.lastSuccessAt) <= freshMs ? 'complete' : 'stale'
    case 'stale': return 'stale'
    case 'permission_required': return 'permission_required'
    case 'unavailable': return 'unavailable'
    case 'unsupported': return 'unsupported'
    case 'error': return 'error'
    default: return 'not_scanned'
  }
}

export class SnapshotService {
  readonly repo: SnapshotRepo
  private clock: () => Date

  constructor(private d: SnapshotDeps) {
    this.repo = new SnapshotRepo(d.db)
    this.clock = d.clock ?? (() => new Date())
  }

  private ensureMachineId(): string {
    let id = this.repo.machineId()
    if (!id) {
      this.repo.setMachineId(randomUUID())
      id = this.repo.machineId()
    }
    return id
  }

  /**
   * Take a snapshot. By default a fresh scan runs first so the snapshot reflects "now". The capture
   * itself is one synchronous section (no awaits): devices, collector coverage and scan time are read
   * in the same tick, so a concurrent scan cannot interleave and mix incompatible observations.
   */
  async create(opts: { label?: string; rescan?: boolean } = {}): Promise<SnapshotMeta> {
    let rescanNote: string | null = null
    if (opts.rescan !== false) {
      try {
        await this.d.inventory.scan()
      } catch (e) {
        rescanNote = `Fresh scan failed before capture: ${(e as Error).message}`
      }
    }
    return this.capture(opts.label, rescanNote)
  }

  capture(label?: string, extraLimitation: string | null = null): SnapshotMeta {
    const now = this.clock()
    const inv: InventoryRepo = this.d.inventory.repo
    const freshMs = this.d.freshMs()
    const health = this.d.inventory.getHealth()
    const devices = inv.loadAll() // present devices only: a snapshot is what was observed
    const collectors: CollectorCoverage[] = health.map((h) => ({
      id: h.id, state: coverageState(h, now, freshMs), categories: h.categories, lastRunAt: h.lastRunAt, lastSuccessAt: h.lastSuccessAt, durationMs: h.durationMs,
      message: h.message, limitations: h.limitations.map((l) => ({ kind: l.kind, message: l.message })), deviceCount: devices.filter((x) => x.source === h.id).length
    }))
    const categoryCounts: Record<string, number> = {}
    for (const dv of devices) categoryCounts[dv.category] = (categoryCounts[dv.category] ?? 0) + 1
    const supported = collectors.filter((c) => c.state !== 'unsupported')
    const limitations = [
      ...supported.filter((c) => c.state !== 'complete').map((c) => `${c.id}: ${c.state.replace('_', ' ')}${c.message ? ` — ${c.message}` : ''}`),
      ...(extraLimitation ? [extraLimitation] : [])
    ]
    const meta: SnapshotMeta = {
      id: `snap_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
      label: label?.trim() || null,
      createdAt: now.toISOString(),
      scanAt: inv.lastScanAt(),
      appVersion: this.d.appVersion,
      schemaVersion: schemaVersion(this.d.db),
      machineId: this.ensureMachineId(),
      deviceCount: devices.length,
      relationshipCount: devices.reduce((n, x) => n + x.relationships.length, 0),
      propertyCount: devices.reduce((n, x) => n + x.properties.length, 0),
      categoryCounts,
      collectors,
      complete: supported.length > 0 && supported.every((c) => c.state === 'complete'),
      limitations
    }
    this.repo.insert(meta, devices)
    return meta
  }

  list(): SnapshotMeta[] {
    return this.repo.list()
  }

  get(id: string): SnapshotMeta | null {
    return this.repo.getMeta(id)
  }

  compare(baseId: string, targetId: string, opts: CompareOptions = {}): SnapshotComparison {
    if (baseId === targetId) throw new Error('Choose two different snapshots to compare')
    const a = this.repo.getMeta(baseId)
    const b = this.repo.getMeta(targetId)
    if (!a || !b) throw new Error('Snapshot not found')
    const da = this.repo.getDevices(baseId)
    const db = this.repo.getDevices(targetId)
    return compareSnapshots({ meta: a, devices: da.devices, skipped: da.skipped, skippedKeys: da.skippedKeys }, { meta: b, devices: db.devices, skipped: db.skipped, skippedKeys: db.skippedKeys }, opts)
  }

  /** Delete exactly the snapshots the user selected. There is no automatic retention. */
  delete(ids: string[]): number {
    return this.repo.delete([...new Set(ids)])
  }
}
