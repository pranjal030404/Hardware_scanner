/**
 * Test helper: create a database as an OLDER release would have left it (migrations up to
 * `--schema N`), holding recognisable user data, so upgrade behaviour can be checked against a
 * packaged build:  tsx scripts/seed-db.ts <db path> --schema 3
 * `--schema 99` fakes a database written by a newer release.
 */
import { openDatabase } from '../src/main/database/db'
import { MIGRATIONS } from '../src/main/database/migrations'

const path = process.argv[2]
const idx = process.argv.indexOf('--schema')
const target = idx > 0 ? Number(process.argv[idx + 1]) : 3
if (!path || !Number.isInteger(target)) {
  console.error('usage: seed-db.ts <path> --schema N')
  process.exit(2)
}
const db = openDatabase(path, MIGRATIONS.filter((m) => m.version <= target))
db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('theme', JSON.stringify('light'), new Date().toISOString())
db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('pollIntervalSec', JSON.stringify(77), new Date().toISOString())
db.prepare('INSERT INTO systems (id, platform, created_at) VALUES (?, ?, ?)').run('seed-system', 'linux', new Date().toISOString())
db.prepare('INSERT INTO device_events (system_id, type, at, summary) VALUES (?, ?, ?, ?)').run('seed-system', 'device.connected', new Date().toISOString(), 'SEEDED-BY-OLD-RELEASE')
if (target > 4) db.prepare('INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)').run(target, 'from_the_future', new Date().toISOString(), 'x')
db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
db.close()
