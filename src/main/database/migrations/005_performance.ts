/**
 * Performance tuning: every change is a transaction with per-control previous, requested and read-back
 * (effective) values, so it can be verified, undone and audited. Custom profiles are tied to a
 * device fingerprint (a hash of model and reported limits, no serials). Test sessions keep a bounded
 * set of samples.
 */
export const sql = `
CREATE TABLE perf_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT
);
CREATE INDEX idx_perf_tx_started ON perf_transactions(started_at);

CREATE TABLE perf_transaction_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_id INTEGER NOT NULL REFERENCES perf_transactions(id) ON DELETE CASCADE,
  control_id TEXT NOT NULL,
  label TEXT NOT NULL,
  previous_raw TEXT,
  previous TEXT,
  requested_raw TEXT NOT NULL,
  requested TEXT NOT NULL,
  effective TEXT,
  verification TEXT NOT NULL,
  message TEXT
);
CREATE INDEX idx_perf_items_tx ON perf_transaction_items(tx_id);
CREATE INDEX idx_perf_items_control ON perf_transaction_items(control_id, verification);

CREATE TABLE perf_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL,
  settings TEXT NOT NULL
);

CREATE TABLE perf_test_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  mode TEXT NOT NULL,
  duration_s INTEGER NOT NULL,
  interval_ms INTEGER NOT NULL,
  threads INTEGER NOT NULL,
  status TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  tx_id INTEGER,
  profile TEXT,
  summary TEXT NOT NULL DEFAULT '{}',
  error TEXT
);
CREATE INDEX idx_perf_tests_started ON perf_test_sessions(started_at);

CREATE TABLE perf_test_samples (
  session_id INTEGER NOT NULL REFERENCES perf_test_sessions(id) ON DELETE CASCADE,
  t_ms INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX idx_perf_samples_session ON perf_test_samples(session_id, t_ms);
`
