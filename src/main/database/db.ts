import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, type Migration } from './migrations'

export class MigrationError extends Error {
  constructor(message: string, readonly version?: number) {
    super(message)
    this.name = 'MigrationError'
  }
}

export interface MigrationRecord {
  version: number
  name: string
  appliedAt: string
}

const checksum = (m: Migration): string => createHash('sha256').update(m.sql).digest('hex').slice(0, 16)

export type Db = DatabaseSync

/**
 * Open (or create) the database, apply pending migrations transactionally and return the handle.
 * - Refuses to open a database written by a newer app version (no silent downgrade).
 * - Refuses to run if an already-applied migration was modified.
 * - Copies the file to `<path>.pre-v<N>.bak` before migrating an existing, non-empty database.
 */
export function openDatabase(path: string, migrations: Migration[] = MIGRATIONS): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const existed = path !== ':memory:' && existsSync(path)
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;')
  try {
    migrate(db, migrations, existed ? path : undefined)
  } catch (e) {
    db.close()
    throw e
  }
  return db
}

export function migrate(db: Db, migrations: Migration[], backupSource?: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)`)
  const applied = db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as {
    version: number
    name: string
    checksum: string
  }[]
  const latest = migrations[migrations.length - 1]?.version ?? 0
  const current = applied[applied.length - 1]?.version ?? 0
  if (current > latest) {
    throw new MigrationError(
      `Database schema v${current} is newer than this application supports (v${latest}). Update the application; the database was not modified.`,
      current
    )
  }
  for (const a of applied) {
    const m = migrations.find((x) => x.version === a.version)
    if (!m) throw new MigrationError(`Applied migration v${a.version} (${a.name}) is unknown to this build`, a.version)
    if (checksum(m) !== a.checksum) {
      throw new MigrationError(`Migration v${a.version} (${a.name}) was modified after being applied; refusing to continue`, a.version)
    }
  }
  const pending = migrations.filter((m) => m.version > current).sort((a, b) => a.version - b.version)
  if (!pending.length) return
  if (backupSource && current > 0) {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    copyFileSync(backupSource, `${backupSource}.pre-v${pending[0]!.version}.bak`)
  }
  for (const m of pending) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(m.sql)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString(),
        checksum(m)
      )
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw new MigrationError(`Migration v${m.version} (${m.name}) failed and was rolled back: ${(e as Error).message}`, m.version)
    }
  }
}

export function listMigrations(db: Db): MigrationRecord[] {
  return (db.prepare('SELECT version, name, applied_at AS appliedAt FROM schema_migrations ORDER BY version').all() as unknown) as MigrationRecord[]
}

export function schemaVersion(db: Db): number {
  const r = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null }
  return r.v ?? 0
}

/** Consistent online backup (VACUUM INTO) that does not copy WAL side files. */
export function backupDatabase(db: Db, destination: string): void {
  if (existsSync(destination)) throw new Error('Backup destination already exists')
  db.prepare('VACUUM INTO ?').run(destination)
}

/** Run `fn` inside a transaction; rolls back on throw. Nested calls join the outer transaction. */
export function transaction<T>(db: Db, fn: () => T): T {
  if (db.isTransaction) return fn()
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
