import { mkdtempSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { backupDatabase, listMigrations, MigrationError, migrate, openDatabase, schemaVersion, transaction } from '../src/main/database/db'
import { MIGRATIONS } from '../src/main/database/migrations'
import { EventRepo, InventoryRepo, SettingsRepo } from '../src/main/database/repositories'
import { DatabaseSync } from 'node:sqlite'
import { AT, obs } from './helpers/factory'
import { contentHash, deviceIdFromKey } from '@collectors/core/normalize'
import { HipEventSchema } from '@shared/schemas'

const tmp = () => mkdtempSync(join(tmpdir(), 'hip-db-'))

describe('migrations', () => {
  it('creates every required table and records the version', () => {
    const db = openDatabase(':memory:')
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name)
    for (const t of ['systems', 'devices', 'device_identifiers', 'device_properties', 'device_relationships', 'device_events', 'metric_samples', 'diagnostic_findings', 'collector_runs', 'inventory_snapshots', 'snapshot_device_records', 'integrations', 'settings', 'knowledge_items']) expect(tables).toContain(t)
    expect(schemaVersion(db)).toBe(MIGRATIONS.at(-1)!.version)
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 })
  })
  it('is repeatable: reopening a file database applies nothing twice', () => {
    const p = join(tmp(), 'a.sqlite')
    openDatabase(p).close()
    const db = openDatabase(p)
    expect(listMigrations(db)).toHaveLength(MIGRATIONS.length)
  })
  it('rolls back a failing migration, keeps prior data and reports a meaningful error', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, [{ version: 1, name: 'one', sql: 'CREATE TABLE t(a)' }])
    db.exec('INSERT INTO t VALUES (1)')
    expect(() => migrate(db, [{ version: 1, name: 'one', sql: 'CREATE TABLE t(a)' }, { version: 2, name: 'bad', sql: 'CREATE TABLE u(a); INSERT INTO nope VALUES (1)' }])).toThrow(MigrationError)
    expect(schemaVersion(db)).toBe(1)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='u'").get()).toBeUndefined() // partial DDL rolled back
    expect(db.prepare('SELECT COUNT(*) c FROM t').get()).toMatchObject({ c: 1 })
  })
  it('refuses a database from a newer app and a tampered applied migration', () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, [{ version: 1, name: 'one', sql: 'CREATE TABLE t(a)' }, { version: 2, name: 'two', sql: 'CREATE TABLE u(a)' }])
    expect(() => migrate(db, [{ version: 1, name: 'one', sql: 'CREATE TABLE t(a)' }])).toThrow(/newer than this application/)
    const db2 = new DatabaseSync(':memory:')
    migrate(db2, [{ version: 1, name: 'one', sql: 'CREATE TABLE t(a)' }])
    expect(() => migrate(db2, [{ version: 1, name: 'one', sql: 'CREATE TABLE t(a, b)' }])).toThrow(/modified after being applied/)
  })
  it('backs up an existing database before migrating it', () => {
    const dir = tmp(); const p = join(dir, 'b.sqlite')
    const db = new DatabaseSync(p)
    migrate(db, [{ version: 1, name: 'one', sql: 'CREATE TABLE t(a)' }])
    migrate(db, [{ version: 1, name: 'one', sql: 'CREATE TABLE t(a)' }, { version: 2, name: 'two', sql: 'CREATE TABLE u(a)' }], p)
    db.close()
    expect(readdirSync(dir).some((f) => f.endsWith('.pre-v2.bak'))).toBe(true)
  })
  it('creates a consistent online backup and refuses to overwrite', () => {
    const dir = tmp(); const db = openDatabase(join(dir, 'x.sqlite'))
    new SettingsRepo(db).set('theme', 'dark')
    const dest = join(dir, 'backup.sqlite')
    backupDatabase(db, dest)
    expect(new SettingsRepo(openDatabase(dest)).getAll().theme).toBe('dark')
    expect(() => backupDatabase(db, dest)).toThrow(/already exists/)
  })
  it('transaction() rolls back on throw', () => {
    const db = openDatabase(':memory:')
    expect(() => transaction(db, () => { db.exec("INSERT INTO settings VALUES ('a','1','x')"); throw new Error('no') })).toThrow('no')
    expect(db.prepare('SELECT COUNT(*) c FROM settings').get()).toMatchObject({ c: 0 })
  })
})

describe('InventoryRepo', () => {
  const setup = () => { const db = openDatabase(':memory:'); const r = new InventoryRepo(db); r.ensureSystem('linux', AT); return { db, r } }
  const put = (r: InventoryRepo, o = obs('usb:1:2:port:3-1', { name: 'Keyboard', manufacturer: 'Acme' })) => { const id = deviceIdFromKey(o.key); r.upsert(id, o, contentHash(o), AT); return id }

  it('round-trips a device with identifiers, typed properties, provenance and relationships', () => {
    const { r } = setup()
    const parent = obs('pci:0', { category: 'pci', name: 'xHCI' })
    const o = obs('usb:1:2:port:3-1', {
      name: 'Keyboard', identifiers: [{ kind: 'serial', value: 'S1', sensitive: true }],
      properties: [
        { key: 'speed', value: 480, unit: 'Mb/s', source: 'linux.usb', sourceProperty: '/speed', evidence: 'os_reported', observedAt: AT },
        { key: 'removable', value: true, source: 'linux.usb', sourceProperty: '/removable', evidence: 'os_reported', observedAt: AT, volatile: true },
        { key: 'label', value: '007', source: 'linux.usb', sourceProperty: '/l', evidence: 'os_reported', observedAt: AT }
      ],
      relationships: [{ targetKey: 'pci:0', type: 'bus_attachment', directness: 'reported', source: 'linux.usb', confidence: 1, observedAt: AT }],
      fieldSources: { name: { source: 'linux.usb', sourceProperty: '/product', evidence: 'os_reported' } }
    })
    put(r, parent); const id = put(r, o)
    const d = r.get(id, [])!
    expect(d.properties.find((p) => p.key === 'speed')).toMatchObject({ value: 480, unit: 'Mb/s' })
    expect(d.properties.find((p) => p.key === 'removable')).toMatchObject({ value: true, volatile: true })
    expect(d.properties.find((p) => p.key === 'label')!.value).toBe('007') // numeric-looking string stays a string
    expect(d.identifiers[0]).toMatchObject({ kind: 'serial', sensitive: true })
    expect(d.device.fieldSources.name!.sourceProperty).toBe('/product')
    expect(d.relationships).toHaveLength(1)
    expect(d.relationships[0]).toMatchObject({ direction: 'parent', other: { name: 'xHCI' } })
    const pd = r.get(deviceIdFromKey('pci:0'), [])!
    expect(pd.relationships[0]).toMatchObject({ direction: 'child', other: { name: 'Keyboard' } })
  })
  it('upsert is idempotent and preserves first_seen', () => {
    const { r } = setup()
    const o = obs('k'); const id = deviceIdFromKey('k')
    r.upsert(id, o, contentHash(o), '2026-01-01T00:00:00Z')
    r.upsert(id, { ...o, name: 'renamed' }, 'h2', '2026-02-01T00:00:00Z')
    const d = r.get(id, [])!.device
    expect(r.deviceCount()).toBe(1)
    expect(d).toMatchObject({ name: 'renamed', firstSeen: '2026-01-01T00:00:00Z', lastSeen: '2026-02-01T00:00:00Z' })
  })
  it('search and filters use parameters (no injection) and match names/ids', () => {
    const { r } = setup()
    put(r, obs('a', { name: 'Logitech Receiver', vendorId: '046d' })); put(r, obs('b', { name: 'Webcam', category: 'camera' }))
    expect(r.list({ search: 'logi' })).toHaveLength(1)
    expect(r.list({ search: '046d' })).toHaveLength(1)
    expect(r.list({ category: 'camera' })).toHaveLength(1)
    expect(r.list({ search: "'; DROP TABLE devices; --" })).toHaveLength(0)
    expect(r.list({ search: '%' })).toHaveLength(0) // wildcard is escaped
    expect(r.deviceCount()).toBe(2)
  })
  it('does not let sensitive identifiers be searched', () => {
    const { r } = setup()
    put(r, obs('a', { identifiers: [{ kind: 'serial', value: 'SECRET123', sensitive: true }] }))
    expect(r.list({ search: 'SECRET123' })).toHaveLength(0)
  })
  it('hides missing devices by default and resurrects them on touch', () => {
    const { r } = setup(); const id = put(r)
    r.markMissing([id], AT)
    expect(r.list({})).toHaveLength(0); expect(r.list({ includeMissing: true })).toHaveLength(1)
    r.touch([id], AT); expect(r.list({})).toHaveLength(1)
  })
})

describe('EventRepo & SettingsRepo', () => {
  it('prunes by age and by count', () => {
    const db = openDatabase(':memory:'); const e = new EventRepo(db)
    const mk = (at: string) => HipEventSchema.parse({ type: 'device.updated', at, summary: at })
    for (let i = 0; i < 10; i++) e.insert(mk(`2026-01-${String(i + 10).padStart(2, '0')}T00:00:00.000Z`))
    e.insert(mk('2020-01-01T00:00:00.000Z'))
    expect(e.prune(365, 5, new Date('2026-02-01'))).toBe(6)
    expect(e.recent(100)).toHaveLength(5)
    expect(e.recent(1)[0]!.at).toBe('2026-01-19T00:00:00.000Z')
  })
  it('validates settings, applies defaults and survives corrupt rows', () => {
    const db = openDatabase(':memory:'); const s = new SettingsRepo(db)
    expect(s.getAll()).toMatchObject({ theme: 'system', pollIntervalSec: 60, exportIncludeSerials: false })
    expect(s.set('pollIntervalSec', 30).pollIntervalSec).toBe(30)
    expect(() => s.set('pollIntervalSec', 1)).toThrow()
    expect(() => s.set('theme', 'neon')).toThrow()
    db.prepare("INSERT OR REPLACE INTO settings VALUES ('theme','\"neon\"','x')").run()
    db.prepare("INSERT OR REPLACE INTO settings VALUES ('maxEvents','{bad','x')").run()
    expect(s.getAll()).toMatchObject({ theme: 'system', pollIntervalSec: 30 })
  })
})
