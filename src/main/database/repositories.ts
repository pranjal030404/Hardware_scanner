import type {
  CollectorHealth,
  DeviceDetail,
  DeviceObservation,
  DeviceSummary,
  FieldSource,
  HipEvent,
  Identifier,
  Property,
  Settings
} from '@shared/schemas'
import { CollectorCoverageSchema, DeviceStatusSchema, EvidenceRefSchema, FindingSchema, HipEventSchema, SettingsSchema, SnapshotDeviceSchema } from '@shared/schemas'
import type { SnapshotMeta } from '@shared/schemas'
import type { Finding } from '@shared/schemas'
import type { StoredDevice } from '@shared/stored'
import type { Db } from './db'
import { transaction } from './db'

export const LOCAL_SYSTEM_ID = 'local'

type Row = Record<string, any>

const summaryFromRow = (r: Row): DeviceSummary => ({
  id: r.id,
  key: r.key,
  category: r.category,
  subtype: r.subtype ?? null,
  name: r.name,
  manufacturer: r.manufacturer ?? null,
  model: r.model ?? null,
  vendorId: r.vendor_id ?? null,
  productId: r.product_id ?? null,
  busType: r.bus_type ?? null,
  driver: r.driver ?? null,
  status: DeviceStatusSchema.catch('unknown').parse(r.status),
  presence: r.presence,
  firstSeen: r.first_seen,
  lastSeen: r.last_seen,
  lastScanned: r.last_scanned,
  source: r.source
})

export interface KnownDevice {
  id: string
  key: string
  hash: string
  presence: 'present' | 'missing'
  source: string
  name: string
  category: string
}

export class InventoryRepo {
  constructor(private db: Db) {}

  ensureSystem(platform: string, at: string): string {
    this.db.prepare('INSERT OR IGNORE INTO systems (id, platform, created_at) VALUES (?, ?, ?)').run(LOCAL_SYSTEM_ID, platform, at)
    return LOCAL_SYSTEM_ID
  }

  touchSystemScan(at: string): void {
    this.db.prepare('UPDATE systems SET last_scan_at = ? WHERE id = ?').run(at, LOCAL_SYSTEM_ID)
  }

  deviceCount(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM devices WHERE system_id = ?').get(LOCAL_SYSTEM_ID) as Row).n
  }

  known(): Map<string, KnownDevice> {
    const rows = this.db
      .prepare('SELECT id, key, content_hash, presence, source, name, category FROM devices WHERE system_id = ?')
      .all(LOCAL_SYSTEM_ID) as Row[]
    return new Map(rows.map((r) => [r.key, { id: r.id, key: r.key, hash: r.content_hash, presence: r.presence, source: r.source, name: r.name, category: r.category }]))
  }

  /** Insert or update a device and replace its identifiers/properties/relationships. */
  upsert(id: string, o: DeviceObservation, hash: string, at: string): void {
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO devices (id, system_id, key, category, subtype, name, manufacturer, model, description, vendor_id, product_id,
             bus_type, device_class, driver, status, presence, first_seen, last_seen, last_scanned, source, content_hash, field_sources)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'present',?,?,?,?,?,?)
           ON CONFLICT(system_id, key) DO UPDATE SET
             category=excluded.category, subtype=excluded.subtype, name=excluded.name, manufacturer=excluded.manufacturer,
             model=excluded.model, description=excluded.description, vendor_id=excluded.vendor_id, product_id=excluded.product_id,
             bus_type=excluded.bus_type, device_class=excluded.device_class, driver=excluded.driver, status=excluded.status,
             presence='present', last_seen=excluded.last_seen, last_scanned=excluded.last_scanned, source=excluded.source,
             content_hash=excluded.content_hash, field_sources=excluded.field_sources`
        )
        .run(
          id, LOCAL_SYSTEM_ID, o.key, o.category, o.subtype ?? null, o.name, o.manufacturer ?? null, o.model ?? null,
          o.description ?? null, o.vendorId ?? null, o.productId ?? null, o.busType ?? null, o.deviceClass ?? null,
          o.driver ?? null, o.status, at, at, at, o.source, hash, JSON.stringify(o.fieldSources)
        )
      this.db.prepare('DELETE FROM device_identifiers WHERE device_id = ?').run(id)
      this.db.prepare('DELETE FROM device_properties WHERE device_id = ?').run(id)
      this.db.prepare('DELETE FROM device_relationships WHERE device_id = ?').run(id)
      const insId = this.db.prepare('INSERT OR IGNORE INTO device_identifiers (device_id, kind, value, sensitive) VALUES (?,?,?,?)')
      for (const i of o.identifiers) insId.run(id, i.kind, i.value, i.sensitive ? 1 : 0)
      const insProp = this.db.prepare(
        `INSERT OR REPLACE INTO device_properties (device_id, key, source, value_text, value_type, unit, source_property, evidence, observed_at, volatile, sensitive)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      for (const p of o.properties) {
        insProp.run(id, p.key, p.source, String(p.value), typeof p.value, p.unit ?? null, p.sourceProperty, p.evidence, p.observedAt, p.volatile ? 1 : 0, p.sensitive ? 1 : 0)
      }
      const insRel = this.db.prepare(
        `INSERT OR IGNORE INTO device_relationships (device_id, target_key, type, directness, source, source_property, confidence, observed_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      for (const r of o.relationships) insRel.run(id, r.targetKey, r.type, r.directness, r.source, r.sourceProperty ?? null, r.confidence, r.observedAt)
    })
  }

  /** Refresh last_seen/last_scanned for unchanged devices (and flip missing→present). */
  touch(ids: string[], at: string): void {
    const st = this.db.prepare("UPDATE devices SET last_seen = ?, last_scanned = ?, presence = 'present' WHERE id = ?")
    transaction(this.db, () => ids.forEach((id) => st.run(at, at, id)))
  }

  markMissing(ids: string[], at: string): void {
    const st = this.db.prepare("UPDATE devices SET presence = 'missing', last_scanned = ? WHERE id = ?")
    transaction(this.db, () => ids.forEach((id) => st.run(at, id)))
  }

  /** Reconstruct a prior observation (fields + non-volatile properties) for field-level diffs. */
  loadObservation(id: string): DeviceObservation | undefined {
    const r = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(id) as Row | undefined
    if (!r) return undefined
    const props = this.db.prepare('SELECT * FROM device_properties WHERE device_id = ?').all(id) as Row[]
    return {
      key: r.key, category: r.category, subtype: r.subtype ?? undefined, name: r.name, manufacturer: r.manufacturer ?? undefined,
      model: r.model ?? undefined, description: r.description ?? undefined, vendorId: r.vendor_id ?? undefined,
      productId: r.product_id ?? undefined, busType: r.bus_type ?? undefined, deviceClass: r.device_class ?? undefined,
      driver: r.driver ?? undefined, status: r.status, source: r.source, identifiers: [], relationships: [], fieldSources: {},
      observedAt: r.last_scanned,
      properties: props.map(propFromRow)
    }
  }

  list(f: { category?: string; search?: string; status?: string; includeMissing?: boolean } = {}): DeviceSummary[] {
    const where = ['system_id = ?']
    const args: (string | number)[] = [LOCAL_SYSTEM_ID]
    if (f.category) { where.push('category = ?'); args.push(f.category) }
    if (f.status) { where.push('status = ?'); args.push(f.status) }
    if (!f.includeMissing) where.push("presence = 'present'")
    if (f.search?.trim()) {
      const like = `%${f.search.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`
      where.push(`(name LIKE ? ESCAPE '\\' OR manufacturer LIKE ? ESCAPE '\\' OR model LIKE ? ESCAPE '\\' OR vendor_id LIKE ? ESCAPE '\\'
        OR product_id LIKE ? ESCAPE '\\' OR bus_type LIKE ? ESCAPE '\\' OR driver LIKE ? ESCAPE '\\' OR subtype LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM device_identifiers i WHERE i.device_id = devices.id AND i.sensitive = 0 AND i.value LIKE ? ESCAPE '\\'))`)
      for (let i = 0; i < 9; i++) args.push(like)
    }
    const rows = this.db.prepare(`SELECT * FROM devices WHERE ${where.join(' AND ')} ORDER BY category, name COLLATE NOCASE`).all(...args) as Row[]
    return rows.map(summaryFromRow)
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare("SELECT category, COUNT(*) AS n FROM devices WHERE system_id = ? AND presence = 'present' GROUP BY category").all(LOCAL_SYSTEM_ID) as Row[]
    return Object.fromEntries(rows.map((r) => [r.category, r.n]))
  }

  get(id: string, events: HipEvent[]): DeviceDetail | null {
    const r = this.db.prepare('SELECT * FROM devices WHERE id = ? AND system_id = ?').get(id, LOCAL_SYSTEM_ID) as Row | undefined
    if (!r) return null
    const identifiers = (this.db.prepare('SELECT kind, value, sensitive FROM device_identifiers WHERE device_id = ? ORDER BY kind, value').all(id) as Row[]).map(
      (i): Identifier => ({ kind: i.kind, value: i.value, ...(i.sensitive ? { sensitive: true } : {}) })
    )
    const properties = (this.db.prepare('SELECT * FROM device_properties WHERE device_id = ? ORDER BY key, source').all(id) as Row[]).map(propFromRow)
    const outgoing = this.db
      .prepare(
        `SELECT rel.*, d.id AS oid, d.name AS oname, d.category AS ocat, d.presence AS opres FROM device_relationships rel
         JOIN devices d ON d.key = rel.target_key AND d.system_id = ? WHERE rel.device_id = ?`
      )
      .all(LOCAL_SYSTEM_ID, id) as Row[]
    const incoming = this.db
      .prepare(
        `SELECT rel.*, d.id AS oid, d.name AS oname, d.category AS ocat, d.presence AS opres FROM device_relationships rel
         JOIN devices d ON d.id = rel.device_id WHERE rel.target_key = ? AND d.system_id = ?`
      )
      .all(r.key, LOCAL_SYSTEM_ID) as Row[]
    const mk = (x: Row, direction: 'parent' | 'child') => ({
      relationshipType: x.type, directness: x.directness, confidence: x.confidence, source: x.source, observedAt: x.observed_at, direction,
      other: { id: x.oid, name: x.oname, category: x.ocat, presence: x.opres }
    })
    return {
      device: {
        ...summaryFromRow(r),
        description: r.description ?? null,
        deviceClass: r.device_class ?? null,
        fieldSources: JSON.parse(r.field_sources) as Record<string, FieldSource>
      },
      identifiers,
      properties,
      relationships: [...outgoing.map((x) => mk(x, 'parent')), ...incoming.map((x) => mk(x, 'child'))] as DeviceDetail['relationships'],
      events
    }
  }

  /** Summary rows for the topology graph. */
  edges(): { fromId: string; toId: string; type: string; directness: string; confidence: number; source: string }[] {
    return (
      this.db
        .prepare(
          `SELECT rel.device_id AS fromId, t.id AS toId, rel.type, rel.directness, rel.confidence, rel.source
           FROM device_relationships rel JOIN devices f ON f.id = rel.device_id
           JOIN devices t ON t.key = rel.target_key AND t.system_id = f.system_id
           WHERE f.system_id = ? AND f.presence = 'present' AND t.presence = 'present'`
        )
        .all(LOCAL_SYSTEM_ID) as Row[]
    ).map((r) => ({ fromId: r.fromId, toId: r.toId, type: r.type, directness: r.directness, confidence: r.confidence, source: r.source }))
  }

  /** All device records with identifiers, properties and relationships (3 queries, grouped in memory). */
  loadAll(opts: { includeMissing?: boolean } = {}): StoredDevice[] {
    const where = opts.includeMissing ? '' : " AND presence = 'present'"
    const devs = this.db.prepare(`SELECT * FROM devices WHERE system_id = ?${where} ORDER BY category, name`).all(LOCAL_SYSTEM_ID) as Row[]
    const group = <T extends Row>(rows: T[]): Map<string, T[]> => {
      const m = new Map<string, T[]>()
      for (const r of rows) (m.get(r.device_id) ?? m.set(r.device_id, []).get(r.device_id)!).push(r)
      return m
    }
    const ids = group(this.db.prepare('SELECT i.* FROM device_identifiers i JOIN devices d ON d.id = i.device_id WHERE d.system_id = ?').all(LOCAL_SYSTEM_ID) as Row[])
    const props = group(this.db.prepare('SELECT p.* FROM device_properties p JOIN devices d ON d.id = p.device_id WHERE d.system_id = ?').all(LOCAL_SYSTEM_ID) as Row[])
    const rels = group(this.db.prepare('SELECT r.* FROM device_relationships r JOIN devices d ON d.id = r.device_id WHERE d.system_id = ?').all(LOCAL_SYSTEM_ID) as Row[])
    return devs.map((r): StoredDevice => ({
      ...summaryFromRow(r),
      description: r.description ?? null,
      deviceClass: r.device_class ?? null,
      identifiers: (ids.get(r.id) ?? []).map((i): Identifier => ({ kind: i.kind, value: i.value, ...(i.sensitive ? { sensitive: true } : {}) })),
      properties: (props.get(r.id) ?? []).map(propFromRow),
      relationships: (rels.get(r.id) ?? []).map((x) => ({ targetKey: x.target_key, type: x.type, directness: x.directness, source: x.source, sourceProperty: x.source_property ?? undefined, confidence: x.confidence, observedAt: x.observed_at })),
      fieldSources: JSON.parse(r.field_sources) as Record<string, FieldSource>
    }))
  }

  lastScanAt(): string | null {
    return ((this.db.prepare('SELECT last_scan_at FROM systems WHERE id = ?').get(LOCAL_SYSTEM_ID) as Row | undefined)?.last_scan_at as string | null | undefined) ?? null
  }

  /** Raw rows for exports. */
  exportAll(): { devices: Row[]; identifiers: Row[]; properties: Row[]; relationships: Row[] } {
    return {
      devices: this.db.prepare('SELECT * FROM devices WHERE system_id = ? ORDER BY category, name').all(LOCAL_SYSTEM_ID) as Row[],
      identifiers: this.db.prepare('SELECT i.* FROM device_identifiers i JOIN devices d ON d.id = i.device_id WHERE d.system_id = ?').all(LOCAL_SYSTEM_ID) as Row[],
      properties: this.db.prepare('SELECT p.* FROM device_properties p JOIN devices d ON d.id = p.device_id WHERE d.system_id = ?').all(LOCAL_SYSTEM_ID) as Row[],
      relationships: this.db.prepare('SELECT r.* FROM device_relationships r JOIN devices d ON d.id = r.device_id WHERE d.system_id = ?').all(LOCAL_SYSTEM_ID) as Row[]
    }
  }
}

function propFromRow(p: Row): Property {
  const value = p.value_type === 'number' ? Number(p.value_text) : p.value_type === 'boolean' ? p.value_text === 'true' : p.value_text
  return {
    key: p.key, value, source: p.source, sourceProperty: p.source_property, evidence: p.evidence, observedAt: p.observed_at,
    ...(p.unit ? { unit: p.unit } : {}), ...(p.volatile ? { volatile: true } : {}), ...(p.sensitive ? { sensitive: true } : {})
  }
}

export class EventRepo {
  constructor(private db: Db) {}

  insert(e: HipEvent): void {
    this.db
      .prepare('INSERT INTO device_events (system_id, type, at, device_id, device_name, category, collector_id, summary, data) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(LOCAL_SYSTEM_ID, e.type, e.at, e.deviceId, e.deviceName, e.category, e.collectorId, e.summary, JSON.stringify(e.data))
  }

  private map(r: Row): HipEvent {
    return HipEventSchema.parse({ type: r.type, at: r.at, deviceId: r.device_id, deviceName: r.device_name, category: r.category, collectorId: r.collector_id, summary: r.summary, data: JSON.parse(r.data) })
  }

  recent(limit: number): HipEvent[] {
    return (this.db.prepare('SELECT * FROM device_events ORDER BY at DESC, id DESC LIMIT ?').all(limit) as Row[]).map((r) => this.map(r))
  }

  forDevice(deviceId: string, limit = 50): HipEvent[] {
    return (this.db.prepare('SELECT * FROM device_events WHERE device_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(deviceId, limit) as Row[]).map((r) => this.map(r))
  }

  /** Bounded retention: drop by age first, then by count. Returns rows removed. */
  prune(retentionDays: number, maxEvents: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString()
    const a = this.db.prepare('DELETE FROM device_events WHERE at < ?').run(cutoff)
    const b = this.db
      .prepare('DELETE FROM device_events WHERE id IN (SELECT id FROM device_events ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?)')
      .run(maxEvents)
    return Number(a.changes) + Number(b.changes)
  }
}

export class CollectorRunRepo {
  constructor(private db: Db) {}

  insert(h: CollectorHealth): void {
    this.db
      .prepare('INSERT INTO collector_runs (system_id, collector_id, collector_version, started_at, duration_ms, status, partial, message, device_count, limitations) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(LOCAL_SYSTEM_ID, h.id, h.version, h.lastRunAt ?? new Date().toISOString(), h.durationMs ?? 0, h.status, h.partial ? 1 : 0, h.message, h.deviceCount, JSON.stringify(h.limitations))
  }

  /** Last successful run time per collector, to restore health after a restart. */
  lastSuccess(): Map<string, string> {
    const rows = this.db.prepare("SELECT collector_id, MAX(started_at) AS at FROM collector_runs WHERE status = 'available' GROUP BY collector_id").all() as Row[]
    return new Map(rows.map((r) => [r.collector_id, r.at]))
  }

  prune(keepPerCollector = 200): void {
    this.db
      .prepare(
        `DELETE FROM collector_runs WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY collector_id ORDER BY started_at DESC) rn FROM collector_runs) WHERE rn > ?)`
      )
      .run(keepPerCollector)
  }
}

export class SettingsRepo {
  constructor(private db: Db) {}

  getAll(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Row[]
    const raw: Record<string, unknown> = {}
    for (const r of rows) {
      try {
        raw[r.key] = JSON.parse(r.value)
      } catch {
        /* ignore corrupt value; default applies */
      }
    }
    // Invalid persisted values fall back to defaults field-by-field rather than failing startup.
    const parsed = SettingsSchema.safeParse(raw)
    if (parsed.success) return parsed.data
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw)) {
      const field = (SettingsSchema.shape as Record<string, { safeParse: (x: unknown) => { success: boolean } }>)[k]
      if (field?.safeParse(v).success) clean[k] = v
    }
    return SettingsSchema.parse(clean)
  }

  /** Validates the single key against the schema before persisting; throws on invalid values. */
  set<K extends keyof Settings>(key: K, value: unknown, at = new Date().toISOString()): Settings {
    const field = SettingsSchema.shape[key]
    const v = field.parse(value)
    this.db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at').run(key, JSON.stringify(v), at)
    return this.getAll()
  }
}

const findingFromRow = (r: Row): Finding | null => {
  const parseArr = (t: string): unknown[] => {
    try {
      const v = JSON.parse(t)
      return Array.isArray(v) ? v : []
    } catch {
      return []
    }
  }
  const parsed = FindingSchema.safeParse({
    id: r.id, ruleId: r.rule_id, ruleVersion: r.rule_version, subjectKey: r.subject_key, severity: r.severity, category: r.category,
    title: r.title, description: r.description,
    deviceIds: parseArr(r.device_ids).filter((x): x is string => typeof x === 'string'),
    // Evidence is validated entry by entry: one bad reference never hides the finding.
    evidence: parseArr(r.evidence).flatMap((e) => { const p = EvidenceRefSchema.safeParse(e); return p.success ? [p.data] : [] }),
    confidence: r.confidence ?? null, recommendation: r.recommendation, status: r.status,
    firstDetectedAt: r.first_detected_at, lastSeenAt: r.last_seen_at, updatedAt: r.updated_at,
    acknowledgedAt: r.acknowledged_at ?? null, resolvedAt: r.resolved_at ?? null, resolutionReason: r.resolution_reason ?? null
  })
  return parsed.success ? parsed.data : null
}

export interface RuleRunRecord {
  ruleId: string
  ruleVersion: number
  startedAt: string
  durationMs: number
  outcome: 'evaluated' | 'insufficient_data' | 'disabled' | 'error'
  message: string | null
  findings: number
}

export class DiagnosticsRepo {
  constructor(private db: Db) {}

  /** Insert-or-update the full finding body. Status/timestamps are managed by the engine. */
  upsert(f: Finding): void {
    this.db
      .prepare(
        `INSERT INTO diagnostic_findings (id, system_id, rule_id, rule_version, subject_key, severity, category, title, description, device_ids, evidence,
           confidence, recommendation, status, first_detected_at, last_seen_at, updated_at, acknowledged_at, resolved_at, resolution_reason)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET rule_version=excluded.rule_version, severity=excluded.severity, category=excluded.category, title=excluded.title,
           description=excluded.description, device_ids=excluded.device_ids, evidence=excluded.evidence, confidence=excluded.confidence,
           recommendation=excluded.recommendation, status=excluded.status, first_detected_at=excluded.first_detected_at, last_seen_at=excluded.last_seen_at,
           updated_at=excluded.updated_at, acknowledged_at=excluded.acknowledged_at, resolved_at=excluded.resolved_at, resolution_reason=excluded.resolution_reason`
      )
      .run(f.id, LOCAL_SYSTEM_ID, f.ruleId, f.ruleVersion, f.subjectKey, f.severity, f.category, f.title, f.description, JSON.stringify(f.deviceIds),
        JSON.stringify(f.evidence), f.confidence, f.recommendation, f.status, f.firstDetectedAt, f.lastSeenAt, f.updatedAt, f.acknowledgedAt, f.resolvedAt, f.resolutionReason)
  }

  get(id: string): Finding | null {
    const r = this.db.prepare('SELECT * FROM diagnostic_findings WHERE id = ? AND system_id = ?').get(id, LOCAL_SYSTEM_ID) as Row | undefined
    return r ? findingFromRow(r) : null
  }

  byRule(ruleId: string): Finding[] {
    return (this.db.prepare('SELECT * FROM diagnostic_findings WHERE rule_id = ? AND system_id = ?').all(ruleId, LOCAL_SYSTEM_ID) as Row[]).flatMap((r) => findingFromRow(r) ?? [])
  }

  list(f: { status?: string; severity?: string; category?: string; search?: string; limit?: number } = {}): Finding[] {
    const where = ['system_id = ?']
    const args: (string | number)[] = [LOCAL_SYSTEM_ID]
    if (f.status) { where.push('status = ?'); args.push(f.status) }
    if (f.severity) { where.push('severity = ?'); args.push(f.severity) }
    if (f.category) { where.push('category = ?'); args.push(f.category) }
    if (f.search?.trim()) {
      const like = `%${f.search.trim().replace(/[\\%_]/g, (c) => '\\' + c)}%`
      where.push("(title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR rule_id LIKE ? ESCAPE '\\')")
      args.push(like, like, like)
    }
    args.push(f.limit ?? 500)
    const sevOrder = "CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END"
    return (this.db.prepare(`SELECT * FROM diagnostic_findings WHERE ${where.join(' AND ')} ORDER BY ${sevOrder}, last_seen_at DESC LIMIT ?`).all(...args) as Row[]).flatMap((r) => findingFromRow(r) ?? [])
  }

  counts(): { bySeverity: Record<string, number>; byStatus: Record<string, number> } {
    const bySeverity: Record<string, number> = {}
    const byStatus: Record<string, number> = {}
    for (const r of this.db.prepare('SELECT status, severity, COUNT(*) n FROM diagnostic_findings WHERE system_id = ? GROUP BY status, severity').all(LOCAL_SYSTEM_ID) as Row[]) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + r.n
      // Severity counts describe findings that still need attention.
      if (r.status === 'active' || r.status === 'acknowledged') bySeverity[r.severity] = (bySeverity[r.severity] ?? 0) + r.n
    }
    return { bySeverity, byStatus }
  }

  activeCount(): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM diagnostic_findings WHERE system_id = ? AND status = 'active'").get(LOCAL_SYSTEM_ID) as Row).n
  }

  insertRun(r: RuleRunRecord): void {
    this.db.prepare('INSERT INTO diagnostic_rule_runs (system_id, rule_id, rule_version, started_at, duration_ms, outcome, message, findings) VALUES (?,?,?,?,?,?,?,?)')
      .run(LOCAL_SYSTEM_ID, r.ruleId, r.ruleVersion, r.startedAt, r.durationMs, r.outcome, r.message, r.findings)
  }

  lastRuns(): Map<string, RuleRunRecord> {
    const rows = this.db.prepare(`SELECT * FROM diagnostic_rule_runs WHERE id IN (SELECT MAX(id) FROM diagnostic_rule_runs GROUP BY rule_id)`).all() as Row[]
    return new Map(rows.map((r) => [r.rule_id, { ruleId: r.rule_id, ruleVersion: r.rule_version, startedAt: r.started_at, durationMs: r.duration_ms, outcome: r.outcome, message: r.message ?? null, findings: r.findings }]))
  }

  pruneRuns(keepPerRule = 100): void {
    this.db.prepare('DELETE FROM diagnostic_rule_runs WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY rule_id ORDER BY id DESC) rn FROM diagnostic_rule_runs) WHERE rn > ?)').run(keepPerRule)
  }

  /** Resolved findings older than the cutoff (explicit, user-configured cleanup only). */
  deleteResolvedBefore(iso: string): number {
    return Number(this.db.prepare("DELETE FROM diagnostic_findings WHERE system_id = ? AND status IN ('resolved') AND resolved_at < ?").run(LOCAL_SYSTEM_ID, iso).changes)
  }
}

const metaFromRow = (r: Row): SnapshotMeta => {
  let collectors: SnapshotMeta['collectors'] = []
  try {
    const raw = JSON.parse(r.collector_status)
    if (Array.isArray(raw)) collectors = raw.flatMap((c) => { const p = CollectorCoverageSchema.safeParse(c); return p.success ? [p.data] : [] })
  } catch { /* legacy or corrupt: treated as "no coverage information" */ }
  const parseJson = <T>(t: string, fallback: T): T => { try { return JSON.parse(t) as T } catch { return fallback } }
  const supported = collectors.filter((c) => c.state !== 'unsupported')
  return {
    id: r.id, label: r.label ?? null, createdAt: r.created_at, scanAt: r.scan_at ?? null, appVersion: r.app_version ?? null, schemaVersion: r.schema_version ?? null,
    machineId: r.machine_id ?? null, deviceCount: r.device_count, relationshipCount: r.relationship_count ?? 0, propertyCount: r.property_count ?? 0,
    categoryCounts: parseJson<Record<string, number>>(r.category_counts ?? '{}', {}), collectors,
    // Without coverage information a snapshot can never be called complete.
    complete: supported.length > 0 && supported.every((c) => c.state === 'complete'),
    limitations: parseJson<string[]>(r.limitations ?? '[]', [])
  }
}

export class SnapshotRepo {
  constructor(private db: Db) {}

  machineId(): string {
    const r = this.db.prepare('SELECT machine_id FROM systems WHERE id = ?').get(LOCAL_SYSTEM_ID) as Row | undefined
    return r?.machine_id ?? ''
  }

  setMachineId(id: string): void {
    this.db.prepare('UPDATE systems SET machine_id = ? WHERE id = ? AND machine_id IS NULL').run(id, LOCAL_SYSTEM_ID)
  }

  /** Insert the snapshot and all its records atomically. */
  insert(meta: SnapshotMeta, devices: StoredDevice[]): void {
    transaction(this.db, () => {
      this.db
        .prepare(
          `INSERT INTO inventory_snapshots (id, system_id, created_at, label, device_count, collector_status, app_version, schema_version, machine_id, scan_at,
             relationship_count, property_count, category_counts, limitations) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(meta.id, LOCAL_SYSTEM_ID, meta.createdAt, meta.label, meta.deviceCount, JSON.stringify(meta.collectors), meta.appVersion, meta.schemaVersion, meta.machineId,
          meta.scanAt, meta.relationshipCount, meta.propertyCount, JSON.stringify(meta.categoryCounts), JSON.stringify(meta.limitations))
      const st = this.db.prepare('INSERT INTO snapshot_device_records (snapshot_id, device_key, record, category, source) VALUES (?,?,?,?,?)')
      for (const d of devices) st.run(meta.id, d.key, JSON.stringify(d), d.category, d.source)
    })
  }

  list(): SnapshotMeta[] {
    return (this.db.prepare('SELECT * FROM inventory_snapshots WHERE system_id = ? ORDER BY created_at DESC, id').all(LOCAL_SYSTEM_ID) as Row[]).map(metaFromRow)
  }

  getMeta(id: string): SnapshotMeta | null {
    const r = this.db.prepare('SELECT * FROM inventory_snapshots WHERE id = ? AND system_id = ?').get(id, LOCAL_SYSTEM_ID) as Row | undefined
    return r ? metaFromRow(r) : null
  }

  /** Records are validated individually; unreadable ones are counted, never silently dropped. */
  getDevices(id: string): { devices: StoredDevice[]; skipped: number; skippedKeys: string[] } {
    const devices: StoredDevice[] = []
    const skippedKeys: string[] = []
    for (const r of this.db.prepare('SELECT device_key, record FROM snapshot_device_records WHERE snapshot_id = ?').all(id) as Row[]) {
      try {
        const p = SnapshotDeviceSchema.safeParse(JSON.parse(r.record))
        if (p.success) devices.push(p.data as StoredDevice)
        else skippedKeys.push(r.device_key)
      } catch {
        skippedKeys.push(r.device_key)
      }
    }
    return { devices, skipped: skippedKeys.length, skippedKeys }
  }

  /** Delete exactly the given snapshots (records cascade). Returns how many existed. */
  delete(ids: string[]): number {
    return transaction(this.db, () => {
      const st = this.db.prepare('DELETE FROM inventory_snapshots WHERE id = ? AND system_id = ?')
      let n = 0
      for (const id of ids) n += Number(st.run(id, LOCAL_SYSTEM_ID).changes)
      return n
    })
  }
}

export interface MetricRow { deviceId: string; metric: string; value: number; unit: string; source: string; at: string }
export interface KnownSeries { metric: string; deviceId: string; unit: string; source: string; lastAt: string }

export class MetricRepo {
  constructor(private db: Db) {}

  resolveKey(key: string): string | null {
    const r = this.db.prepare('SELECT id FROM devices WHERE system_id = ? AND key = ?').get(LOCAL_SYSTEM_ID, key) as Row | undefined
    return r?.id ?? null
  }

  resolveIdentifier(kind: string, value: string): string | null {
    const r = this.db.prepare('SELECT i.device_id FROM device_identifiers i JOIN devices d ON d.id = i.device_id WHERE i.kind = ? AND i.value = ? AND d.system_id = ? LIMIT 1').get(kind, value, LOCAL_SYSTEM_ID) as Row | undefined
    return r?.device_id ?? null
  }

  /** One transaction for the whole batch. */
  insertBatch(rows: MetricRow[]): void {
    if (!rows.length) return
    transaction(this.db, () => {
      const st = this.db.prepare('INSERT INTO metric_samples (device_id, metric, value, unit, source, at) VALUES (?,?,?,?,?,?)')
      for (const r of rows) st.run(r.deviceId, r.metric, r.value, r.unit, r.source, r.at)
    })
  }

  window(metric: string, deviceId: string, fromIso: string, beforeIso: string): { t: number; v: number }[] {
    return (this.db.prepare('SELECT at, value FROM metric_samples WHERE metric = ? AND device_id = ? AND at >= ? AND at < ? ORDER BY at').all(metric, deviceId, fromIso, beforeIso) as Row[]).map((r) => ({ t: Date.parse(r.at), v: r.value }))
  }

  known(sinceIso: string): KnownSeries[] {
    return (this.db.prepare(`SELECT metric, device_id, MAX(at) AS last_at, unit, source FROM metric_samples WHERE at >= ? GROUP BY metric, device_id`).all(sinceIso) as Row[])
      .map((r) => ({ metric: r.metric, deviceId: r.device_id, unit: r.unit ?? '', source: r.source, lastAt: r.last_at }))
  }

  prune(beforeIso: string): number {
    return Number(this.db.prepare('DELETE FROM metric_samples WHERE at < ?').run(beforeIso).changes)
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) n FROM metric_samples').get() as Row).n
  }

  devices(ids: string[]): Map<string, { name: string; category: string }> {
    const out = new Map<string, { name: string; category: string }>()
    if (!ids.length) return out
    for (const r of this.db.prepare(`SELECT id, name, category FROM devices WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Row[]) out.set(r.id, { name: r.name, category: r.category })
    return out
  }
}
