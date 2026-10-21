import type {
  CertaintyLevel, ComparisonChange, CoverageState, DeviceRef, PropertyChange, RelationshipChange, SnapshotComparison, SnapshotMeta
} from '@shared/schemas'
import type { StoredDevice } from '@shared/stored'

export interface SnapshotData {
  meta: SnapshotMeta
  devices: StoredDevice[]
  /** Persisted records that failed validation (excluded from `devices`). */
  skipped?: number
  /** Identity keys of records that could not be read: those devices are unknown, not absent. */
  skippedKeys?: string[]
}

export interface CompareOptions {
  /** Include volatile properties (live readings/counters). Off by default: they change on every scan. */
  includeVolatile?: boolean
}

const FIELDS = ['name', 'manufacturer', 'model', 'subtype', 'vendorId', 'productId', 'busType', 'driver', 'status', 'deviceClass'] as const
/** Identifier kinds that identify one physical unit regardless of where it is plugged in. */
const UNIT_IDENTIFIERS = new Set(['serial', 'wwid', 'mac_address', 'uniq'])

type Cov = CoverageState | 'absent'

const coverageOf = (s: SnapshotMeta, collectorId: string): Cov => s.collectors.find((c) => c.id === collectorId)?.state ?? 'absent'
const refOf = (d: StoredDevice): DeviceRef => ({ key: d.key, deviceId: d.id, name: d.name, category: d.category, source: d.source })
const covText = (c: Cov): string => (c === 'absent' ? 'was not part of that snapshot' : `was ${c.replace('_', ' ')}`)

/**
 * Compare two snapshots.
 *
 * The central rule: a missing device is reported as REMOVED only if the collector that originally
 * reported it ran to completion in the newer snapshot (and in the older one, so the device was
 * really being observed). Otherwise the difference is `indeterminate` and the reason names the
 * collector whose incompleteness prevents a conclusion. The same caution applies in reverse to
 * "added" devices and to removed/added properties and relationships.
 */
export function compareSnapshots(base: SnapshotData, target: SnapshotData, opts: CompareOptions = {}): SnapshotComparison {
  const includeVolatile = opts.includeVolatile ?? false
  const changes: ComparisonChange[] = []
  const reasons = new Set<string>()
  const baseMap = new Map(base.devices.map((d) => [d.key, d]))
  const targetMap = new Map(target.devices.map((d) => [d.key, d]))
  const baseNames = new Map(base.devices.map((d) => [d.key, d.name]))
  const targetNames = new Map(target.devices.map((d) => [d.key, d.name]))

  let removedCands = base.devices.filter((d) => !targetMap.has(d.key))
  let addedCands = target.devices.filter((d) => !baseMap.has(d.key))
  const pairs: { from: StoredDevice; to: StoredDevice; method: string; confidence: number }[] = []
  const without = <T>(arr: T[], x: T): T[] => arr.filter((y) => y !== x)

  // --- Re-key matching: the same physical unit seen under a different identity key (e.g. moved USB port).
  const shares = (x: StoredDevice, y: StoredDevice): boolean =>
    x.category === y.category && x.identifiers.some((i) => UNIT_IDENTIFIERS.has(i.kind) && y.identifiers.some((j) => j.kind === i.kind && j.value === i.value))
  for (const r of [...removedCands]) {
    const cands = addedCands.filter((a) => shares(r, a))
    // Require a 1:1 match; if several removed devices could claim the same new one, do not guess.
    if (cands.length === 1 && removedCands.filter((o) => shares(o, cands[0]!)).length === 1) {
      pairs.push({ from: r, to: cands[0]!, method: 'same serial/unit identifier', confidence: 0.95 })
      removedCands = without(removedCands, r)
      addedCands = without(addedCands, cands[0]!)
    }
  }
  const sig = (d: StoredDevice): string | null => (d.vendorId && d.productId ? `${d.category}|${d.vendorId}|${d.productId}|${d.name}` : null)
  for (const r of [...removedCands]) {
    const s = sig(r)
    if (!s) continue
    const sameR = removedCands.filter((x) => sig(x) === s)
    const sameA = addedCands.filter((x) => sig(x) === s)
    if (sameR.length === 1 && sameA.length === 1) {
      pairs.push({ from: r, to: sameA[0]!, method: 'same vendor/product IDs and name (heuristic)', confidence: 0.6 })
      removedCands = without(removedCands, r)
      addedCands = without(addedCands, sameA[0]!)
    }
  }

  const unreadable = (s: SnapshotData, key: string): boolean => !!s.skippedKeys?.includes(key)

  // --- Removed
  for (const d of removedCands) {
    if (unreadable(target, d.key)) {
      const why = `The stored record for "${d.name}" in the newer snapshot could not be read, so its presence is unknown`
      reasons.add(why)
      changes.push({ kind: 'indeterminate', device: refOf(d), direction: 'missing_in_target', reason: why })
      continue
    }
    const tgt = coverageOf(target.meta, d.source)
    const src = coverageOf(base.meta, d.source)
    if (tgt === 'complete' && src === 'complete') changes.push({ kind: 'device_removed', device: refOf(d), certainty: 'confirmed' })
    else {
      const why =
        tgt !== 'complete'
          ? `${d.source} ${covText(tgt)} in the newer snapshot, so the absence of "${d.name}" cannot be confirmed`
          : `${d.source} ${covText(src)} in the older snapshot, so "${d.name}" may already have been gone`
      reasons.add(why)
      changes.push({ kind: 'indeterminate', device: refOf(d), direction: 'missing_in_target', reason: why })
    }
  }
  // --- Added
  for (const d of addedCands) {
    if (unreadable(base, d.key)) {
      const why = `The stored record for "${d.name}" in the older snapshot could not be read, so it may not be new`
      reasons.add(why)
      changes.push({ kind: 'indeterminate', device: refOf(d), direction: 'new_in_target', reason: why })
      continue
    }
    const src = coverageOf(base.meta, d.source)
    if (src === 'complete') changes.push({ kind: 'device_added', device: refOf(d), certainty: 'confirmed' })
    else {
      const why = `${d.source} ${covText(src)} in the older snapshot, so "${d.name}" may have been present all along`
      reasons.add(why)
      changes.push({ kind: 'indeterminate', device: refOf(d), direction: 'new_in_target', reason: why })
    }
  }

  // --- Matched devices (same key, or re-keyed pairs)
  const matched: { a: StoredDevice; b: StoredDevice; rekey: (typeof pairs)[number] | null }[] = []
  for (const a of base.devices) {
    const b = targetMap.get(a.key)
    if (b) matched.push({ a, b, rekey: null })
  }
  for (const p of pairs) matched.push({ a: p.from, b: p.to, rekey: p })

  let unchanged = 0
  for (const { a, b, rekey } of matched) {
    const propChanges = diffProperties(a, b, base.meta, target.meta, includeVolatile)
    if (rekey) {
      propChanges.unshift({
        field: 'identity key', kind: 'identity', before: a.key, after: b.key, change: 'changed', certainty: rekey.confidence >= 0.9 ? 'probable' : 'uncertain', source: b.source,
        note: `Matched as the same device by ${rekey.method}; its OS-level identity (port/path) changed.`
      })
      if (rekey.confidence < 0.9) reasons.add(`"${b.name}" was matched across a changed identity by heuristic only`)
    }
    if (propChanges.length) {
      for (const c of propChanges) if (c.certainty === 'uncertain' && c.note) reasons.add(c.note)
      changes.push({ kind: 'property_changed', device: refOf(b), changes: propChanges, rekeyed: rekey ? { from: a.key, to: b.key, method: rekey.method, confidence: rekey.confidence } : null })
    }
    const relChanges = diffRelationships(a, b, base.meta, target.meta, baseNames, targetNames)
    if (relChanges.length) {
      for (const c of relChanges) if (c.certainty === 'uncertain' && c.note) reasons.add(c.note)
      changes.push({ kind: 'relationship_changed', device: refOf(b), changes: relChanges })
    }
    if (!propChanges.length && !relChanges.length) unchanged++
  }

  // --- Coverage changes
  const ids = new Set([...base.meta.collectors.map((c) => c.id), ...target.meta.collectors.map((c) => c.id)])
  for (const id of [...ids].sort()) {
    const before = coverageOf(base.meta, id)
    const after = coverageOf(target.meta, id)
    if (before === after) continue
    const affected = base.devices.filter((d) => d.source === id).length
    const explanation =
      after !== 'complete'
        ? `${id} ${covText(after)} in the newer snapshot: its ${affected} device(s) cannot be confirmed present or removed.`
        : `${id} ${covText(before)} in the older snapshot: devices it reports now may not be new.`
    changes.push({ kind: 'coverage_changed', collectorId: id, before, after, devicesAffected: affected, explanation })
    reasons.add(explanation)
  }

  const count = (k: ComparisonChange['kind']): number => changes.filter((c) => c.kind === k).length
  const skipped = (base.skipped ?? 0) + (target.skipped ?? 0)
  if (skipped) reasons.add(`${skipped} stored device record(s) could not be read and were skipped`)
  return {
    base: base.meta,
    target: target.meta,
    changes: sortChanges(changes),
    summary: {
      added: count('device_added'), removed: count('device_removed'), changed: count('property_changed'), relationshipChanged: count('relationship_changed'),
      coverageChanged: count('coverage_changed'), indeterminate: count('indeterminate'), unchanged
    },
    uncertain: reasons.size > 0,
    reasons: [...reasons],
    skippedRecords: skipped,
    includeVolatile
  }
}

const ORDER: ComparisonChange['kind'][] = ['coverage_changed', 'device_removed', 'device_added', 'property_changed', 'relationship_changed', 'indeterminate']
function sortChanges(c: ComparisonChange[]): ComparisonChange[] {
  const name = (x: ComparisonChange): string => ('device' in x ? x.device.name : x.collectorId)
  return [...c].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || name(a).localeCompare(name(b)))
}

function diffProperties(a: StoredDevice, b: StoredDevice, baseMeta: SnapshotMeta, targetMeta: SnapshotMeta, includeVolatile: boolean): PropertyChange[] {
  const out: PropertyChange[] = []
  const tgtCov = coverageOf(targetMeta, b.source)
  for (const f of FIELDS) {
    if ((a[f] ?? null) === (b[f] ?? null)) continue
    const src = b.fieldSources[f] ?? a.fieldSources[f]
    // A field that vanished may just be something the collector could not read this time.
    const doubtful = b[f] == null && tgtCov !== 'complete'
    out.push({
      field: f, kind: 'field', before: a[f] ?? null, after: b[f] ?? null, change: a[f] == null ? 'added' : b[f] == null ? 'removed' : 'changed',
      certainty: doubtful ? 'uncertain' : 'confirmed', source: src ? `${src.source} · ${src.sourceProperty}` : undefined,
      note: doubtful ? `${b.source} ${covText(tgtCov)} in the newer snapshot, so a missing "${f}" is not confirmed` : undefined
    })
  }
  const use = (d: StoredDevice) => new Map(d.properties.filter((p) => includeVolatile || !p.volatile).map((p) => [`${p.key}\0${p.source}`, p]))
  const pa = use(a)
  const pb = use(b)
  for (const [k, p] of pa) {
    const q = pb.get(k)
    if (!q) {
      const cov = coverageOf(targetMeta, p.source)
      out.push({
        field: p.key, kind: 'property', before: p.sensitive ? '[sensitive]' : p.value, after: null, unit: p.unit, source: `${p.source} · ${p.sourceProperty}`, sensitive: p.sensitive,
        change: 'removed', certainty: cov === 'complete' ? 'confirmed' : 'uncertain',
        note: cov === 'complete' ? undefined : `${p.source} ${covText(cov)} in the newer snapshot, so "${p.key}" being absent is not confirmed`
      })
    } else if (p.value !== q.value || (p.unit ?? null) !== (q.unit ?? null)) {
      out.push({
        field: p.key, kind: 'property', before: p.sensitive ? '[sensitive]' : p.value, after: q.sensitive ? '[sensitive]' : q.value, unit: q.unit, source: `${q.source} · ${q.sourceProperty}`,
        sensitive: p.sensitive || q.sensitive, change: 'changed', certainty: 'confirmed'
      })
    }
  }
  for (const [k, q] of pb) {
    if (pa.has(k)) continue
    const cov = coverageOf(baseMeta, q.source)
    out.push({
      field: q.key, kind: 'property', before: null, after: q.sensitive ? '[sensitive]' : q.value, unit: q.unit, source: `${q.source} · ${q.sourceProperty}`, sensitive: q.sensitive,
      change: 'added', certainty: cov === 'complete' ? 'confirmed' : 'uncertain',
      note: cov === 'complete' ? undefined : `${q.source} ${covText(cov)} in the older snapshot, so "${q.key}" appearing is not confirmed`
    })
  }
  return out
}

function diffRelationships(
  a: StoredDevice, b: StoredDevice, baseMeta: SnapshotMeta, targetMeta: SnapshotMeta, baseNames: Map<string, string>, targetNames: Map<string, string>
): RelationshipChange[] {
  const k = (r: StoredDevice['relationships'][number]): string => `${r.targetKey}\0${r.type}\0${r.source}`
  const ra = new Map(a.relationships.map((r) => [k(r), r]))
  const rb = new Map(b.relationships.map((r) => [k(r), r]))
  const out: RelationshipChange[] = []
  const nm = (key: string): string => targetNames.get(key) ?? baseNames.get(key) ?? key
  const cert = (cov: Cov): CertaintyLevel => (cov === 'complete' ? 'confirmed' : 'uncertain')
  for (const [key, r] of ra) {
    const q = rb.get(key)
    if (!q) {
      const cov = coverageOf(targetMeta, r.source)
      out.push({
        type: r.type, otherName: nm(r.targetKey), change: 'removed', before: { directness: r.directness, confidence: r.confidence }, after: null, source: r.source, certainty: cert(cov),
        note: cov === 'complete' ? undefined : `${r.source} ${covText(cov)} in the newer snapshot, so a missing relationship is not confirmed`
      })
    } else if (r.directness !== q.directness || Math.abs(r.confidence - q.confidence) > 0.001) {
      out.push({
        type: r.type, otherName: nm(r.targetKey), change: 'modified', before: { directness: r.directness, confidence: r.confidence },
        after: { directness: q.directness, confidence: q.confidence }, source: q.source, certainty: 'confirmed'
      })
    }
  }
  for (const [key, q] of rb) {
    if (ra.has(key)) continue
    const cov = coverageOf(baseMeta, q.source)
    out.push({
      type: q.type, otherName: nm(q.targetKey), change: 'added', before: null, after: { directness: q.directness, confidence: q.confidence }, source: q.source, certainty: cert(cov),
      note: cov === 'complete' ? undefined : `${q.source} ${covText(cov)} in the older snapshot, so a new relationship is not confirmed`
    })
  }
  return out
}
