import { createHash } from 'node:crypto'
import type { DeviceObservation, Identifier, Property, Relationship } from '@shared/schemas'

/** Short, stable, opaque id derived from the identity key. */
export function deviceIdFromKey(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 20)
}

const FIELDS = ['subtype', 'manufacturer', 'model', 'description', 'vendorId', 'productId', 'busType', 'deviceClass', 'driver'] as const

/**
 * Merge observations of the same device (same key) from multiple collectors. The first observation
 * wins for scalar fields, later ones only fill gaps — and each field keeps the provenance of the
 * observation it came from. Properties are keyed by (key, source) so two collectors can disagree
 * visibly instead of one silently overwriting the other.
 */
export function mergeObservations(list: DeviceObservation[]): DeviceObservation[] {
  const byKey = new Map<string, DeviceObservation>()
  for (const obs of list) {
    const cur = byKey.get(obs.key)
    if (!cur) {
      byKey.set(obs.key, structuredClone(obs))
      continue
    }
    for (const f of FIELDS) {
      if (cur[f] === undefined && obs[f] !== undefined) {
        cur[f] = obs[f]
        if (obs.fieldSources[f]) cur.fieldSources[f] = obs.fieldSources[f]
      }
    }
    if (cur.status === 'unknown' && obs.status !== 'unknown') cur.status = obs.status
    // An explicit error from any source must not be hidden by another source's "ok".
    if (obs.status === 'error') cur.status = 'error'
    cur.identifiers = dedupe(cur.identifiers.concat(obs.identifiers), (i: Identifier) => `${i.kind}\0${i.value}`)
    cur.properties = dedupe(cur.properties.concat(obs.properties), (p: Property) => `${p.key}\0${p.source}`)
    cur.relationships = dedupe(
      cur.relationships.concat(obs.relationships),
      (r: Relationship) => `${r.targetKey}\0${r.type}\0${r.source}`
    )
  }
  return [...byKey.values()]
}

function dedupe<T>(items: T[], keyOf: (t: T) => string): T[] {
  const seen = new Map<string, T>()
  for (const it of items) if (!seen.has(keyOf(it))) seen.set(keyOf(it), it)
  return [...seen.values()]
}

/**
 * Hash of everything that, if changed, means the device itself changed. Volatile properties
 * (live readings, counters) and observation timestamps are excluded.
 */
export function contentHash(o: DeviceObservation): string {
  const stable = {
    c: o.category,
    st: o.subtype ?? null,
    n: o.name,
    m: o.manufacturer ?? null,
    mo: o.model ?? null,
    v: o.vendorId ?? null,
    p: o.productId ?? null,
    b: o.busType ?? null,
    d: o.driver ?? null,
    s: o.status,
    ids: o.identifiers.map((i) => `${i.kind}=${i.value}`).sort(),
    props: o.properties
      .filter((p) => !p.volatile)
      .map((p) => `${p.key}@${p.source}=${String(p.value)}${p.unit ?? ''}`)
      .sort()
  }
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex').slice(0, 32)
}

/** Field-level diff for `device.updated` events. */
export function diffObservations(prev: DeviceObservation, next: DeviceObservation): string[] {
  const changes: string[] = []
  for (const f of ['name', 'manufacturer', 'model', 'driver', 'status', 'subtype', 'busType'] as const) {
    if ((prev[f] ?? null) !== (next[f] ?? null)) changes.push(`${f}: ${prev[f] ?? '—'} → ${next[f] ?? '—'}`)
  }
  const pm = new Map(prev.properties.filter((p) => !p.volatile).map((p) => [`${p.key}@${p.source}`, p]))
  for (const p of next.properties.filter((p) => !p.volatile)) {
    const old = pm.get(`${p.key}@${p.source}`)
    if (!old) changes.push(`${p.key}: added ${String(p.value)}${p.unit ? ' ' + p.unit : ''}`)
    else if (old.value !== p.value) changes.push(`${p.key}: ${String(old.value)} → ${String(p.value)}${p.unit ? ' ' + p.unit : ''}`)
    pm.delete(`${p.key}@${p.source}`)
  }
  for (const [k] of pm) changes.push(`${k.split('@')[0]}: removed`)
  return changes
}
