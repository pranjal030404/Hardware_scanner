/** Initial schema. Never edit an applied migration; add a new numbered file instead. */
export const sql = `
CREATE TABLE systems (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_scan_at TEXT
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  category TEXT NOT NULL,
  subtype TEXT,
  name TEXT NOT NULL,
  manufacturer TEXT,
  model TEXT,
  description TEXT,
  vendor_id TEXT,
  product_id TEXT,
  bus_type TEXT,
  device_class TEXT,
  driver TEXT,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('ok','error','disabled','unknown')),
  presence TEXT NOT NULL DEFAULT 'present' CHECK (presence IN ('present','missing')),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  last_scanned TEXT NOT NULL,
  source TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  field_sources TEXT NOT NULL DEFAULT '{}',
  UNIQUE (system_id, key)
);
CREATE INDEX idx_devices_category ON devices(system_id, category);
CREATE INDEX idx_devices_presence ON devices(system_id, presence);
CREATE INDEX idx_devices_source ON devices(system_id, source);

CREATE TABLE device_identifiers (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  sensitive INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, kind, value)
);
CREATE INDEX idx_identifiers_lookup ON device_identifiers(kind, value);

CREATE TABLE device_properties (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  source TEXT NOT NULL,
  value_text TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('string','number','boolean')),
  unit TEXT,
  source_property TEXT NOT NULL,
  evidence TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  volatile INTEGER NOT NULL DEFAULT 0,
  sensitive INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, key, source)
);

CREATE TABLE device_relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  target_key TEXT NOT NULL,
  type TEXT NOT NULL,
  directness TEXT NOT NULL CHECK (directness IN ('reported','inferred')),
  source TEXT NOT NULL,
  source_property TEXT,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  observed_at TEXT NOT NULL,
  UNIQUE (device_id, target_key, type, source)
);
CREATE INDEX idx_relationships_target ON device_relationships(target_key);

-- No FK on device_id: history must survive device deletion.
CREATE TABLE device_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id TEXT NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  device_id TEXT,
  device_name TEXT,
  category TEXT,
  collector_id TEXT,
  summary TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_events_at ON device_events(at);
CREATE INDEX idx_events_device ON device_events(device_id, at);

CREATE TABLE metric_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT,
  source TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX idx_metrics_lookup ON metric_samples(device_id, metric, at);

CREATE TABLE diagnostic_findings (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  device_id TEXT,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('informational','low','medium','high','critical')),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '[]',
  confidence REAL,
  recommendation TEXT,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','dismissed','resolved')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_findings_state ON diagnostic_findings(system_id, state);

CREATE TABLE collector_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id TEXT NOT NULL,
  collector_id TEXT NOT NULL,
  collector_version TEXT NOT NULL,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  partial INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  device_count INTEGER,
  limitations TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_runs_collector ON collector_runs(collector_id, started_at);

CREATE TABLE inventory_snapshots (
  id TEXT PRIMARY KEY,
  system_id TEXT NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  label TEXT,
  device_count INTEGER NOT NULL,
  collector_status TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE snapshot_device_records (
  snapshot_id TEXT NOT NULL REFERENCES inventory_snapshots(id) ON DELETE CASCADE,
  device_key TEXT NOT NULL,
  record TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, device_key)
);

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  config TEXT NOT NULL DEFAULT '{}',
  secret_ref TEXT,
  last_test_at TEXT,
  last_test_ok INTEGER
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE knowledge_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL
);
`
