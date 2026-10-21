import type { DeviceObservation } from '@shared/schemas'
import { ObservationBuilder, type CollectContext } from '../core/context'
import type { Collector } from '../core/types'
import { finish, pciAncestor, pciKey } from './shared'

const ID = 'linux.sensors'

const KINDS: { prefix: string; label: string; unit: string; divisor: number }[] = [
  { prefix: 'temp', label: 'temperature', unit: '°C', divisor: 1000 },
  { prefix: 'fan', label: 'fan', unit: 'RPM', divisor: 1 },
  { prefix: 'in', label: 'voltage', unit: 'V', divisor: 1000 },
  { prefix: 'power', label: 'power', unit: 'W', divisor: 1_000_000 },
  { prefix: 'curr', label: 'current', unit: 'A', divisor: 1000 }
]

/**
 * Identity of a hwmon chip. hwmon numbering is not stable across boots, so identity is the chip name
 * plus the parent device path. Shared with the metrics sampler so readings attach to the same device.
 */
export async function hwmonIdentity(reader: import('../core/sysreader').SysReader, h: string): Promise<{ key: string; chip: string; real: string | undefined }> {
  const base = `/sys/class/hwmon/${h}`
  const chip = (await reader.text(`${base}/name`)) ?? h
  const real = await reader.real(base)
  const parentPath = real?.split('/').slice(0, -2).join('/') ?? ''
  const anchor = parentPath.split('/').slice(-2).join('/') || h
  return { key: `sensor:${chip}:${anchor}`, chip, real }
}

export const linuxSensors: Collector = {
  id: ID,
  version: '1.0.0',
  platforms: ['linux'],
  categories: ['sensor'],
  permissions: [],
  method: '/sys/class/hwmon',
  timeoutMs: 8000,
  retries: 1,
  isSupported: (ctx) => ctx.reader.exists('/sys/class/hwmon'),
  async collect(ctx: CollectContext) {
    const r = ctx.reader
    const at = ctx.host.now()
    const out: DeviceObservation[] = []
    for (const h of await r.dir('/sys/class/hwmon')) {
      const base = `/sys/class/hwmon/${h}`
      const { key, chip, real } = await hwmonIdentity(r, h)
      const files = await r.dir(`${base}/`)
      const b = new ObservationBuilder(ID, key, 'sensor', chip, at, { sourceProperty: `${base}/name` })
        .status('ok')
        .field('subtype', 'hwmon', 'sysfs class', 'derived')
        .id('hwmon', h)
        .prop('hwmon_index', h, base, { volatile: true })
      let channels = 0
      for (const kind of KINDS) {
        const inputs = files.filter((f) => new RegExp(`^${kind.prefix}\\d+_input$`).test(f))
        for (const f of inputs) {
          const idx = f.replace('_input', '')
          const raw = await r.num(`${base}/${f}`)
          if (raw === undefined) continue
          channels++
          const label = (await r.text(`${base}/${idx}_label`)) ?? idx
          const val = Math.round((raw / kind.divisor) * 100) / 100
          b.prop(`${kind.label}:${label}`, val, `${base}/${f}`, { unit: kind.unit, volatile: true, evidence: 'measured' })
          if (kind.prefix === 'temp') {
            const crit = await r.num(`${base}/${idx}_crit`)
            const max = await r.num(`${base}/${idx}_max`)
            // Thresholds are reported by the sensor's driver, not chosen by us.
            if (crit !== undefined) b.prop(`temperature_crit:${label}`, crit / 1000, `${base}/${idx}_crit`, { unit: '°C' })
            if (max !== undefined) b.prop(`temperature_max:${label}`, max / 1000, `${base}/${idx}_max`, { unit: '°C' })
          }
        }
      }
      if (!channels) continue
      b.prop('channel_count', channels, base)
      const pci = pciAncestor(real)
      if (pci) b.rel(pciKey(pci), 'logical_parent', `${base} (sysfs device path)`)
      out.push(b.build())
    }
    return finish(ctx, out)
  }
}
