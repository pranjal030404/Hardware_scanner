import type { Settings } from '@shared/schemas'

type Row = Record<string, any>

export interface ExportInput {
  devices: Row[]
  identifiers: Row[]
  properties: Row[]
  relationships: Row[]
}

const REDACTED = '[redacted]'

function identifierAllowed(kind: string, s: Settings): boolean {
  if (kind === 'mac_address') return s.exportIncludeMacAddresses
  return s.exportIncludeSerials // serial, uniq, phys and any other sensitive unique identifier
}

function propertyAllowed(key: string, s: Settings): boolean {
  if (key === 'hostname') return s.exportIncludeHostname
  if (key === 'ip_addresses') return s.exportIncludeIpAddresses
  return s.exportIncludeSerials
}

/**
 * Build an inventory export. Sensitive identifiers/properties are replaced with a redaction marker
 * unless the matching privacy setting is enabled. Identity keys (which may embed serial numbers or
 * MAC addresses) are never exported: devices are referenced by their opaque id.
 */
export function buildExport(input: ExportInput, settings: Settings, meta: { appVersion: string; platform: string; now: Date }) {
  const idByKey = new Map(input.devices.map((d) => [d.key as string, d.id as string]))
  let redactions = 0
  const devices = input.devices.map((d) => ({
    id: d.id,
    category: d.category,
    subtype: d.subtype,
    name: d.name,
    manufacturer: d.manufacturer,
    model: d.model,
    vendorId: d.vendor_id,
    productId: d.product_id,
    busType: d.bus_type,
    driver: d.driver,
    status: d.status,
    presence: d.presence,
    firstSeen: d.first_seen,
    lastSeen: d.last_seen,
    source: d.source,
    fieldSources: JSON.parse(d.field_sources),
    identifiers: input.identifiers
      .filter((i) => i.device_id === d.id)
      .map((i) => {
        if (i.sensitive && !identifierAllowed(i.kind, settings)) {
          redactions++
          return { kind: i.kind, value: REDACTED, sensitive: true }
        }
        return { kind: i.kind, value: i.value, ...(i.sensitive ? { sensitive: true } : {}) }
      }),
    properties: input.properties
      .filter((p) => p.device_id === d.id)
      .map((p) => {
        const hide = p.sensitive && !propertyAllowed(p.key, settings)
        if (hide) redactions++
        return {
          key: p.key,
          value: hide ? REDACTED : p.value_type === 'number' ? Number(p.value_text) : p.value_type === 'boolean' ? p.value_text === 'true' : p.value_text,
          unit: p.unit ?? undefined,
          source: p.source,
          sourceProperty: p.source_property,
          evidence: p.evidence,
          observedAt: p.observed_at
        }
      }),
    relationships: input.relationships
      .filter((r) => r.device_id === d.id && idByKey.has(r.target_key))
      .map((r) => ({ targetId: idByKey.get(r.target_key), type: r.type, directness: r.directness, confidence: r.confidence, source: r.source }))
  }))
  return {
    format: 'hardware-intelligence-platform/inventory',
    formatVersion: 1,
    exportedAt: meta.now.toISOString(),
    appVersion: meta.appVersion,
    platform: meta.platform,
    privacy: {
      serialsIncluded: settings.exportIncludeSerials,
      macAddressesIncluded: settings.exportIncludeMacAddresses,
      hostnameIncluded: settings.exportIncludeHostname,
      ipAddressesIncluded: settings.exportIncludeIpAddresses,
      redactedFields: redactions
    },
    devices
  }
}
