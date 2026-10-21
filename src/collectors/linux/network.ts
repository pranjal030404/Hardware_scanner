import type { DeviceObservation } from '@shared/schemas'
import { ObservationBuilder, type CollectContext } from '../core/context'
import type { Collector } from '../core/types'
import { finish, pciAncestor, pciKey, usbDeviceName, usbKey } from './shared'

const ID = 'linux.network'
const ARPHRD: Record<number, string> = { 1: 'ethernet', 772: 'loopback', 801: 'ieee80211', 768: 'tunnel', 776: 'sit', 778: 'gre', 65534: 'none' }

export const linuxNetwork: Collector = {
  id: ID,
  version: '1.0.0',
  platforms: ['linux'],
  categories: ['network'],
  permissions: [],
  method: '/sys/class/net + os.networkInterfaces()',
  timeoutMs: 5000,
  retries: 1,
  isSupported: (ctx) => ctx.reader.exists('/sys/class/net'),
  async collect(ctx: CollectContext) {
    const r = ctx.reader
    const at = ctx.host.now()
    const out: DeviceObservation[] = []
    for (const n of await r.dir('/sys/class/net')) {
      const base = `/sys/class/net/${n}`
      const real = await r.real(base)
      const isVirtual = !!real?.includes('/devices/virtual/')
      const type = await r.num(`${base}/type`)
      const wireless = await r.exists(`${base}/wireless`)
      const kind = isVirtual ? (n === 'lo' ? 'loopback' : 'virtual') : wireless ? 'wifi' : (ARPHRD[type ?? -1] ?? 'other')
      const operstate = await r.text(`${base}/operstate`)
      const carrier = await r.text(`${base}/carrier`)
      const speed = await r.num(`${base}/speed`)
      const driver = (await r.link(`${base}/device/driver`))?.split('/').pop()
      const addrs = ctx.host.networkAddresses[n] ?? []
      const b = new ObservationBuilder(ID, `net:${n}`, 'network', n, at, { sourceProperty: `${base} (interface name)` })
        .status(operstate === 'up' || operstate === 'unknown' || operstate === 'dormant' ? 'ok' : operstate === 'down' ? 'disabled' : 'unknown')
        .field('subtype', kind, 'derived from /type, /wireless, device path', 'derived')
        .field('busType', real?.includes('/usb') ? 'USB' : real && pciAncestor(real) ? 'PCI' : undefined, 'sysfs device path', 'derived')
        .field('driver', driver, `${base}/device/driver`)
        .id('interface_name', n)
        .id('mac_address', await r.text(`${base}/address`), true)
        .prop('operstate', operstate, `${base}/operstate`, { volatile: true })
        .prop('carrier', carrier === undefined ? undefined : carrier === '1', `${base}/carrier`, { volatile: true })
        .prop('link_speed', speed !== undefined && speed > 0 ? speed : undefined, `${base}/speed`, { unit: 'Mb/s', volatile: true })
        .prop('duplex', await r.text(`${base}/duplex`), `${base}/duplex`, { volatile: true })
        .prop('mtu', await r.num(`${base}/mtu`), `${base}/mtu`)
        .prop('rx_bytes', await r.num(`${base}/statistics/rx_bytes`), `${base}/statistics/rx_bytes`, { unit: 'B', volatile: true, evidence: 'measured' })
        .prop('tx_bytes', await r.num(`${base}/statistics/tx_bytes`), `${base}/statistics/tx_bytes`, { unit: 'B', volatile: true, evidence: 'measured' })
        .prop('rx_errors', await r.num(`${base}/statistics/rx_errors`), `${base}/statistics/rx_errors`, { volatile: true, evidence: 'measured' })
        .prop('tx_errors', await r.num(`${base}/statistics/tx_errors`), `${base}/statistics/tx_errors`, { volatile: true, evidence: 'measured' })
        .prop('ip_addresses', addrs.map((a) => a.cidr ?? a.address).join(', ') || undefined, 'os.networkInterfaces()', { volatile: true, sensitive: true })
      const usb = usbDeviceName(real)
      const pci = pciAncestor(real)
      if (usb) {
        // netdev is a logical interface created by the driver of the USB device it sits on.
        const k = await usbKey(r, usb)
        b.rel(k, 'logical_parent', `${base} (sysfs device path)`)
      } else if (pci) {
        b.rel(pciKey(pci), 'logical_parent', `${base} (sysfs device path)`)
      }
      out.push(b.build())
    }
    return finish(ctx, out)
  }
}
