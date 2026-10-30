import { sql as m001 } from './001_initial'
import { sql as m002 } from './002_diagnostics'
import { sql as m003 } from './003_snapshots'
import { sql as m004 } from './004_metrics'
import { sql as m005 } from './005_performance'
import { sql as m006 } from './006_circuits'

export interface Migration {
  version: number
  name: string
  sql: string
}

/** Append-only, strictly increasing versions. */
export const MIGRATIONS: Migration[] = [{ version: 1, name: 'initial_schema', sql: m001 },
  { version: 2, name: 'diagnostics_v2', sql: m002 },
  { version: 3, name: 'snapshots_v2', sql: m003 },
  { version: 4, name: 'metrics_indexes', sql: m004 },
  { version: 5, name: 'performance_tuning', sql: m005 },
  { version: 6, name: 'circuit_designs', sql: m006 }
]
