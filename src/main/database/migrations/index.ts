import { sql as m001 } from './001_initial'
import { sql as m002 } from './002_diagnostics'
import { sql as m003 } from './003_snapshots'
import { sql as m004 } from './004_metrics'

export interface Migration {
  version: number
  name: string
  sql: string
}

/** Append-only, strictly increasing versions. */
export const MIGRATIONS: Migration[] = [{ version: 1, name: 'initial_schema', sql: m001 },
  { version: 2, name: 'diagnostics_v2', sql: m002 },
  { version: 3, name: 'snapshots_v2', sql: m003 },
  { version: 4, name: 'metrics_indexes', sql: m004 }
]
