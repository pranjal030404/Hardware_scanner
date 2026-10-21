import type { DeviceDetail, Property } from '@shared/schemas'

export const KINDS = ['temperature', 'fan', 'voltage', 'power', 'current'] as const
type Kind = (typeof KINDS)[number]
/** Readings older than this relative to now are shown as stale; the inventory rescan is the only source here. */
export const STALE_MS = 5 * 60_000
/** hwmon channels without a `*_label` file fall back to their raw name (`temp1`); their physical meaning is unknown. */
export const UNLABELLED = /^(temp|fan|in|power|curr)\d+$/

export interface Row { chip: string; deviceId: string; kind: Kind; label: string; p: Property; crit?: Property; max?: Property }

export function rowsOf(details: DeviceDetail[]): Row[] {
  const rows: Row[] = []
  for (const d of details) {
    for (const p of d.properties) {
      const i = p.key.indexOf(':')
      const kind = p.key.slice(0, i) as Kind
      if (i < 0 || !KINDS.includes(kind)) continue
      const label = p.key.slice(i + 1)
      rows.push({
        chip: d.device.name, deviceId: d.device.id, kind, label, p,
        crit: d.properties.find((x) => x.key === `temperature_crit:${label}`),
        max: d.properties.find((x) => x.key === `temperature_max:${label}`)
      })
    }
  }
  return rows
}

