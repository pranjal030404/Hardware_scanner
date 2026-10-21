/**
 * Snapshots v2. Adds what a trustworthy comparison needs: per-collector coverage at capture time,
 * versions, a machine-local random identity (never uploaded) and denormalised counts. Device records
 * remain self-contained JSON copies so snapshots never depend on mutable current rows.
 */
export const sql = `
ALTER TABLE systems ADD COLUMN machine_id TEXT;

ALTER TABLE inventory_snapshots ADD COLUMN app_version TEXT;
ALTER TABLE inventory_snapshots ADD COLUMN schema_version INTEGER;
ALTER TABLE inventory_snapshots ADD COLUMN machine_id TEXT;
ALTER TABLE inventory_snapshots ADD COLUMN scan_at TEXT;
ALTER TABLE inventory_snapshots ADD COLUMN relationship_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inventory_snapshots ADD COLUMN property_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inventory_snapshots ADD COLUMN category_counts TEXT NOT NULL DEFAULT '{}';
ALTER TABLE inventory_snapshots ADD COLUMN limitations TEXT NOT NULL DEFAULT '[]';

ALTER TABLE snapshot_device_records ADD COLUMN category TEXT;
ALTER TABLE snapshot_device_records ADD COLUMN source TEXT;
CREATE INDEX idx_snapshots_created ON inventory_snapshots(system_id, created_at);
`
