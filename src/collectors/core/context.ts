import type { Category, DeviceObservation, Evidence, FieldSource, Identifier, Platform, Property, Relationship, RelationshipType } from '@shared/schemas'
import * as os from 'node:os'
import * as fsp from 'node:fs/promises'
import { SysReader } from './sysreader'
import { runCommand, type CommandRunner } from './runner'

export interface HostInfo {
  hostname: string
  arch: string
  /** `os.networkInterfaces()` shaped data; injected so fixtures stay deterministic. */
  networkAddresses: Record<string, { address: string; family: string; cidr: string | null; internal: boolean }[]>
  /** Filesystem usage for a mount point; undefined if not statable. */
  statfs: (mount: string) => Promise<{ totalBytes: number; freeBytes: number } | undefined>
  /** Reference time used for observedAt and uptime math. */
  now: () => Date
}

export interface CollectContext {
  reader: SysReader
  run: CommandRunner
  host: HostInfo
  platform: Platform
  signal?: AbortSignal
}

/** Placeholder strings OEM firmware commonly leaves in DMI fields. They are not real values. */
const PLACEHOLDERS = [
  /^to be filled by o\.?e\.?m\.?$/i,
  /^default string$/i,
  /^not specified$/i,
  /^not applicable$/i,
  /^system (product name|manufacturer|version|serial number)$/i,
  /^o\.?e\.?m\.?$/i,
  /^none$/i,
  /^unknown$/i,
  /^n\/a$/i,
  /^0+$/,
  /^(x+|\.+)$/i
]

export function meaningful(v: string | undefined | null): string | undefined {
  if (v === undefined || v === null) return undefined
  const t = v.trim()
  if (!t) return undefined
  return PLACEHOLDERS.some((p) => p.test(t)) ? undefined : t
}

/**
 * Fluent builder so every property/field written by a collector carries its provenance.
 */
export class ObservationBuilder {
  private o: DeviceObservation
  private readonly at: string

  constructor(
    readonly source: string,
    key: string,
    category: Category,
    name: string,
    at: Date,
    nameSource: { sourceProperty: string; evidence?: Evidence }
  ) {
    this.at = at.toISOString()
    this.o = {
      key,
      category,
      name,
      status: 'unknown',
      source,
      identifiers: [],
      properties: [],
      relationships: [],
      fieldSources: {},
      observedAt: this.at
    }
    this.o.fieldSources.name = { source, sourceProperty: nameSource.sourceProperty, evidence: nameSource.evidence ?? 'os_reported' }
  }

  field<K extends 'subtype' | 'manufacturer' | 'model' | 'description' | 'vendorId' | 'productId' | 'busType' | 'deviceClass' | 'driver'>(
    k: K,
    value: string | undefined,
    sourceProperty: string,
    evidence: Evidence = 'os_reported'
  ): this {
    if (value === undefined || value === '') return this
    this.o[k] = value
    this.o.fieldSources[k] = { source: this.source, sourceProperty, evidence } satisfies FieldSource
    return this
  }

  name(value: string, sourceProperty: string, evidence: Evidence = 'os_reported'): this {
    this.o.name = value
    this.o.fieldSources.name = { source: this.source, sourceProperty, evidence }
    return this
  }

  status(s: DeviceObservation['status']): this {
    this.o.status = s
    return this
  }

  id(kind: string, value: string | undefined, sensitive = false): this {
    if (value === undefined || value === '') return this
    const ident: Identifier = { kind, value, ...(sensitive ? { sensitive: true } : {}) }
    this.o.identifiers.push(ident)
    return this
  }

  prop(
    key: string,
    value: string | number | boolean | undefined,
    sourceProperty: string,
    opts: { unit?: string; evidence?: Evidence; volatile?: boolean; sensitive?: boolean } = {}
  ): this {
    if (value === undefined || value === '' || (typeof value === 'number' && !Number.isFinite(value))) return this
    const p: Property = {
      key,
      value,
      source: this.source,
      sourceProperty,
      evidence: opts.evidence ?? 'os_reported',
      observedAt: this.at,
      ...(opts.unit ? { unit: opts.unit } : {}),
      ...(opts.volatile ? { volatile: true } : {}),
      ...(opts.sensitive ? { sensitive: true } : {})
    }
    this.o.properties.push(p)
    return this
  }

  rel(
    targetKey: string | undefined,
    type: RelationshipType,
    sourceProperty: string,
    opts: { directness?: 'reported' | 'inferred'; confidence?: number } = {}
  ): this {
    if (!targetKey) return this
    const directness = opts.directness ?? 'reported'
    const r: Relationship = {
      targetKey,
      type,
      directness,
      source: this.source,
      sourceProperty,
      confidence: opts.confidence ?? (directness === 'reported' ? 1 : 0.5),
      observedAt: this.at
    }
    this.o.relationships.push(r)
    return this
  }

  build(): DeviceObservation {
    return this.o
  }
}

export function defaultHostInfo(): HostInfo {
  return {
    hostname: os.hostname(),
    arch: os.arch(),
    networkAddresses: Object.fromEntries(
      Object.entries(os.networkInterfaces()).map(([k, v]) => [
        k,
        (v ?? []).map((a) => ({ address: a.address, family: String(a.family), cidr: a.cidr, internal: a.internal }))
      ])
    ),
    statfs: async (mount) => {
      try {
        const s = await fsp.statfs(mount)
        return { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize }
      } catch {
        return undefined
      }
    },
    now: () => new Date()
  }
}

export function hostContext(overrides: Partial<CollectContext> = {}): CollectContext {
  return {
    reader: new SysReader('/'),
    run: runCommand,
    host: defaultHostInfo(),
    platform: process.platform as Platform,
    ...overrides
  }
}
