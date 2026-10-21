/**
 * Diagnostics v2. The v1 `diagnostic_findings` table could not express rule versions, stable subject
 * identity, last-seen, acknowledgement or resolution reasons, and its CHECK constraints used a
 * different vocabulary ('informational'/'open'). No released code wrote to it; any legacy rows are
 * carried over with the vocabulary mapped.
 */
export const sql = `
ALTER TABLE diagnostic_findings RENAME TO diagnostic_findings_v1;
DROP INDEX IF EXISTS idx_findings_state;

CREATE TABLE diagnostic_findings (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  subject_key TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info','low','medium','high','critical')),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  device_ids TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '[]',
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  recommendation TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','acknowledged','resolved','dismissed')),
  first_detected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  acknowledged_at TEXT,
  resolved_at TEXT,
  resolution_reason TEXT,
  UNIQUE (system_id, rule_id, subject_key)
);
CREATE INDEX idx_findings_status ON diagnostic_findings(system_id, status, severity);
CREATE INDEX idx_findings_rule ON diagnostic_findings(rule_id);

INSERT INTO diagnostic_findings
  (id, system_id, rule_id, rule_version, subject_key, severity, category, title, description, device_ids, evidence,
   confidence, recommendation, status, first_detected_at, last_seen_at, updated_at, resolved_at)
SELECT id, system_id, rule_id, 1, id,
       CASE severity WHEN 'informational' THEN 'info' ELSE severity END,
       category, title, description,
       CASE WHEN device_id IS NULL THEN '[]' ELSE json_array(device_id) END,
       CASE WHEN json_valid(evidence) THEN evidence ELSE '[]' END,
       confidence, COALESCE(recommendation, ''),
       CASE state WHEN 'open' THEN 'active' ELSE state END,
       created_at, COALESCE(resolved_at, created_at), COALESCE(resolved_at, created_at), resolved_at
FROM diagnostic_findings_v1;
DROP TABLE diagnostic_findings_v1;

CREATE TABLE diagnostic_rule_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  rule_version INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('evaluated','insufficient_data','disabled','error')),
  message TEXT,
  findings INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_rule_runs ON diagnostic_rule_runs(rule_id, started_at);
`
