import type { Category, DeviceStatus, FieldSource, Identifier, Presence, Property, Relationship } from './schemas'

/** A full persisted device record: what rules and snapshots reason over. */
export interface StoredDevice {
  id: string
  key: string
  category: Category
  subtype: string | null
  name: string
  manufacturer: string | null
  model: string | null
  description: string | null
  vendorId: string | null
  productId: string | null
  busType: string | null
  deviceClass: string | null
  driver: string | null
  status: DeviceStatus
  presence: Presence
  firstSeen: string
  lastSeen: string
  lastScanned: string
  source: string
  identifiers: Identifier[]
  properties: Property[]
  relationships: Relationship[]
  fieldSources: Record<string, FieldSource>
}
