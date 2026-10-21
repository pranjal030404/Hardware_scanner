import type { DeviceObservation } from '@shared/schemas'
import { ObservationBuilder, type CollectContext } from '../core/context'
import type { Collector } from '../core/types'
import { finish, pciAncestor, pciKey, usbDeviceName, usbKey } from './shared'

const ID = 'linux.serial'

export const linuxSerial: Collector = {
  id: ID,
  version: '1.0.0',
  platforms: ['linux'],
  categories: ['serial'],
  permissions: [],
  method: '/sys/class/tty (ttyUSB*, ttyACM*, ttyS* with a real UART)',
  timeoutMs: 5000,
  retries: 1,
  isSupported: (ctx) => ctx.reader.exists('/sys/class/tty'),
  async collect(ctx: CollectContext) {
    const r = ctx.reader
    const at = ctx.host.now()
    const out: DeviceObservation[] = []
    for (const n of await r.dir('/sys/class/tty')) {
      if (!/^(ttyUSB|ttyACM|ttyS)\d+$/.test(n)) continue
      const base = `/sys/class/tty/${n}`
      // Legacy ttyS* nodes exist for non-present UARTs; a UART type of 0 means "unknown/absent".
      if (n.startsWith('ttyS')) {
        const type = await r.num(`${base}/type`)
        if (!type || !(await r.exists(`${base}/device`))) continue
      }
      const real = await r.real(base)
      const usb = usbDeviceName(real)
      const pci = pciAncestor(real)
      const b = new ObservationBuilder(ID, `serial:${n}`, 'serial', `/dev/${n}`, at, { sourceProperty: `${base} (node name)` })
        .status('ok')
        .field('subtype', n.startsWith('ttyUSB') ? 'usb_serial_adapter' : n.startsWith('ttyACM') ? 'usb_cdc_acm' : 'uart', 'node name', 'derived')
        .field('busType', usb ? 'USB' : pci ? 'PCI' : 'platform', 'sysfs device path', 'derived')
        .field('driver', (await r.link(`${base}/device/driver`))?.split('/').pop(), `${base}/device/driver`)
        .id('device_node', `/dev/${n}`)
        .prop('uart_type', await r.num(`${base}/type`), `${base}/type`)
        .prop('port_irq', await r.num(`${base}/irq`), `${base}/irq`)
      if (usb) b.rel(await usbKey(r, usb), 'logical_parent', `${base} (sysfs device path)`)
      else if (pci) b.rel(pciKey(pci), 'logical_parent', `${base} (sysfs device path)`)
      out.push(b.build())
    }
    return finish(ctx, out, [{ kind: 'info', message: 'Passive discovery only: no commands are ever sent to serial ports.' }])
  }
}
