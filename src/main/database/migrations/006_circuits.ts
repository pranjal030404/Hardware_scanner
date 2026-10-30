/** Virtual circuit lab: saved designs, stored as validated JSON. */
export const sql = `
CREATE TABLE circuit_designs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  parts INTEGER NOT NULL,
  wires INTEGER NOT NULL,
  design TEXT NOT NULL
);
CREATE INDEX idx_circuit_updated ON circuit_designs(updated_at);
`
