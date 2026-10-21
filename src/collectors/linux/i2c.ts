import type { DeviceObservation } from '@shared/schemas'
import { ObservationBuilder, type CollectContext } from '../core/context'
import type { Collector } from '../core/types'
import { finish, pciAncestor, pciKey } from './shared'

const ID = 'linux.i2c'
const ADAPTER = /^i2c-(\d+)$/
const CLIENT = /^(\d+)-([0-9a-f]{4})$/i
/** Bound on adapters and clients so a pathological machine cannot flood the inventory. */
const MAX_NODES = 256

/**
 * Passive I²C/SMBus inventory from the kernel's device model: adapters and the client devices that drivers
 * have ALREADY bound or registered (firmware/ACPI/device-tree described). It never opens /dev/i2c-*, never
 * probes addresses (`i2cdetect`) and never reads or writes a register — probing an unknown bus can corrupt
 * state on some devices, so detection of unlisted chips is intentionally out of scope.
 */
export const linuxI2c: Collector = {
  id: ID,
  version: '1.0.0',
  platforms: ['linux'],
  categories: ['other'],
  permissions: [],
  method: '/sys/bus/i2c/devices (kernel device model; no bus access)',
  timeoutMs: 8000,
  retries: 1,
  isSupported: (ctx) => ctx.reader.exists('/sys/bus/i2c/devices'),
  async collect(ctx: CollectContext) {
    const r = ctx.reader
    const at = ctx.host.now()
    const out: DeviceObservation[] = []
    const names = (await r.dir('/sys/bus/i2c/devices')).slice(0, MAX_NODES * 4)
    const adapterKey = new Map<string, string>()
    // Adapter identity: its name plus the stable parent path, because the i2c-N index changes between boots.
    for (const n of names.filter((x) => ADAPTER.test(x))) {
      if (adapterKey.size >= MAX_NODES) break
      const base = `/sys/bus/i2c/devices/${n}`
      const real = await r.real(base)
      const name = (await r.text(`${base}/name`)) ?? n
      const anchor = real?.split('/').slice(-4, -1).join('/') || n
      const key = `i2c:adapter:${name}:${anchor}`
      adapterKey.set(n.slice(4), key)
      const pci = pciAncestor(real)
      const b = new ObservationBuilder(ID, key, 'other', `I²C adapter: ${name}`, at, { sourceProperty: `${base}/name` })
        .status('ok')
        .field('subtype', 'i2c_adapter', 'sysfs bus/i2c', 'derived')
        .field('busType', 'I2C', 'derived', 'derived')
        .id('i2c_bus', n)
        .prop('bus_index', n, base, { volatile: true })
        .prop('adapter_name', name, `${base}/name`)
      if (pci) b.rel(pciKey(pci), 'bus_attachment', `${base} (sysfs device path)`)
      out.push(b.build())
    }
    let clients = 0
    for (const n of names) {
      const m = CLIENT.exec(n)
      if (!m || clients >= MAX_NODES) continue
      const parent = adapterKey.get(String(Number(m[1])))
      if (!parent) continue
      clients++
      const base = `/sys/bus/i2c/devices/${n}`
      const name = (await r.text(`${base}/name`)) ?? `device ${m[2]}`
      const driver = (await r.link(`${base}/driver`))?.split('/').pop()
      const b = new ObservationBuilder(ID, `${parent}:addr:${m[2]!.toLowerCase()}`, 'other', `I²C device: ${name}`, at, { sourceProperty: `${base}/name` })
        .status('ok')
        .field('subtype', 'i2c_device', 'sysfs bus/i2c', 'derived')
        .field('busType', 'I2C', 'derived', 'derived')
        .field('driver', driver, `${base}/driver`)
        .id('i2c_client', n)
        .prop('address', `0x${m[2]!.slice(-2).toLowerCase()}`, base, { evidence: 'derived' })
        .prop('bound', driver !== undefined, `${base}/driver`)
        .prop('modalias', await r.text(`${base}/modalias`), `${base}/modalias`)
        .rel(parent, 'bus_attachment', `${base} (sysfs device path)`)
      out.push(b.build())
    }
    const extra = [{ kind: 'info' as const, message: 'Passive listing only: addresses are never probed and no register is read or written, so chips the kernel has not been told about are not shown. Unbound devices (no driver) are listed as such.' }]
    return finish(ctx, out, extra)
  }
}
