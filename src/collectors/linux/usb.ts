import type { DeviceObservation } from '@shared/schemas'
import { meaningful, ObservationBuilder, type CollectContext } from '../core/context'
import type { Collector } from '../core/types'
import { finish, hex, pciAncestor, pciKey, USB_DEV, usbIds, usbKey } from './shared'

const ID = 'linux.usb'

export const USB_CLASSES: Record<string, string> = {
  '01': 'audio',
  '02': 'communications',
  '03': 'hid',
  '05': 'physical',
  '06': 'imaging',
  '07': 'printer',
  '08': 'mass_storage',
  '09': 'hub',
  '0a': 'cdc_data',
  '0b': 'smart_card',
  '0e': 'video',
  '0f': 'personal_healthcare',
  '10': 'audio_video',
  e0: 'wireless_controller',
  ef: 'miscellaneous',
  fe: 'application_specific',
  ff: 'vendor_specific'
}

/** Endpoint summaries are bounded: a device with many interfaces must not produce an unbounded property. */
const MAX_ENDPOINTS = 32
const EP_TYPES = new Set(['Control', 'Isoc', 'Bulk', 'Interrupt'])

/** `ep_81` → `0x81 Bulk in 512B`. Unknown/malformed values are omitted rather than guessed. */
export function describeEndpoint(dir: string, type: string | undefined, direction: string | undefined, maxPacket: string | undefined): string | undefined {
  const m = /^ep_([0-9a-f]{2})$/i.exec(dir)
  if (!m) return undefined
  const size = maxPacket && /^[0-9a-f]{1,4}$/i.test(maxPacket) ? `${parseInt(maxPacket, 16)}B` : undefined
  const t = type && EP_TYPES.has(type) ? type : undefined
  const d = direction && /^(in|out|both)$/.test(direction) ? direction : undefined
  return [`0x${m[1]!.toLowerCase()}`, t, d, size].filter(Boolean).join(' ')
}

const SPEEDS: Record<string, string> = { '1.5': 'Low Speed (1.5 Mb/s)', '12': 'Full Speed (12 Mb/s)', '480': 'High Speed (480 Mb/s)', '5000': 'SuperSpeed (5 Gb/s)', '10000': 'SuperSpeed+ (10 Gb/s)', '20000': 'SuperSpeed+ (20 Gb/s)' }

export const linuxUsb: Collector = {
  id: ID,
  version: '1.0.0',
  platforms: ['linux'],
  categories: ['usb'],
  permissions: [],
  method: '/sys/bus/usb/devices (kernel device model) + hwdata usb.ids',
  timeoutMs: 8000,
  retries: 1,
  isSupported: (ctx) => ctx.reader.exists('/sys/bus/usb/devices'),
  async collect(ctx: CollectContext) {
    const r = ctx.reader
    const at = ctx.host.now()
    const ids = await usbIds()
    const names = (await r.dir('/sys/bus/usb/devices')).filter((n) => USB_DEV.test(n))
    const out: DeviceObservation[] = []

    // Key lookup table so relationships point at the final (serial-aware) identity keys.
    const keyOf = new Map<string, string>()
    for (const n of names) {
      const k = n.startsWith('usb') ? `usb:root:${n}` : await usbKey(r, n)
      if (k) keyOf.set(n, k)
    }

    for (const n of names) {
      const key = keyOf.get(n)
      if (!key) continue
      const base = `/sys/bus/usb/devices/${n}`
      const isRoot = n.startsWith('usb')
      const vid = await r.text(`${base}/idVendor`)
      const pid = await r.text(`${base}/idProduct`)
      const manufacturerStr = meaningful(await r.text(`${base}/manufacturer`))
      const productStr = meaningful(await r.text(`${base}/product`))
      const serial = meaningful(await r.text(`${base}/serial`))
      const devClass = hex(await r.text(`${base}/bDeviceClass`), 2)
      const speed = await r.text(`${base}/speed`)
      const real = await r.real(base)

      // Interface classes decide the subtype when the device class is "defined at interface level" (00).
      const interfaces = (await r.dir(base)).filter((d) => d.startsWith(`${n}:`))
      const endpoints: string[] = []
      const ifClasses = new Set<string>()
      const drivers = new Set<string>()
      for (const i of interfaces) {
        const c = hex(await r.text(`${base}/${i}/bInterfaceClass`), 2)
        if (c) ifClasses.add(c)
        const d = (await r.link(`${base}/${i}/driver`))?.split('/').pop()
        if (d) drivers.add(d)
        for (const ep of (await r.dir(`${base}/${i}`)).filter((e) => /^ep_[0-9a-f]{2}$/i.test(e))) {
          if (endpoints.length >= MAX_ENDPOINTS) break
          const desc = describeEndpoint(ep, await r.text(`${base}/${i}/${ep}/type`), await r.text(`${base}/${i}/${ep}/direction`), await r.text(`${base}/${i}/${ep}/wMaxPacketSize`))
          if (desc) endpoints.push(`${i.slice(n.length + 1)}:${desc}`)
        }
      }
      const classCode = devClass && devClass !== '00' ? devClass : [...ifClasses][0]
      const subtype = isRoot ? 'root_hub' : devClass === '09' ? 'hub' : classCode ? (USB_CLASSES[classCode] ?? `class_${classCode}`) : 'device'
      const dbName = vid && pid ? ids.device(vid, pid) : undefined
      const vendorName = manufacturerStr ?? (vid ? ids.vendor(vid) : undefined)
      const name = productStr ?? dbName ?? (isRoot ? `USB root hub (${n})` : `USB device ${vid}:${pid}`)
      const nameSrc = productStr ? `${base}/product` : dbName ? 'usb.ids lookup' : 'derived from ids'
      const nameEv = productStr ? ('os_reported' as const) : dbName ? ('database_lookup' as const) : ('derived' as const)

      const b = new ObservationBuilder(ID, key, 'usb', name, at, { sourceProperty: nameSrc, evidence: nameEv })
        .status('ok')
        .field('manufacturer', vendorName, manufacturerStr ? `${base}/manufacturer` : 'usb.ids lookup', manufacturerStr ? 'os_reported' : 'database_lookup')
        .field('model', productStr ?? dbName, productStr ? `${base}/product` : 'usb.ids lookup', productStr ? 'os_reported' : 'database_lookup')
        .field('vendorId', vid, `${base}/idVendor`)
        .field('productId', pid, `${base}/idProduct`)
        .field('busType', 'USB', 'derived', 'derived')
        .field('subtype', subtype, 'bDeviceClass / bInterfaceClass', 'derived')
        .field('deviceClass', classCode ? (USB_CLASSES[classCode] ?? classCode) : undefined, `${base}/bDeviceClass`)
        .field('driver', [...drivers].join(', ') || undefined, `${base}/<interface>/driver`)
        .id('usb_port_path', n)
        .id('usb_ids', vid && pid ? `${vid}:${pid}` : undefined)
        .id('serial', serial, true)
        .prop('usb_version', await r.text(`${base}/version`), `${base}/version`)
        .prop('speed', speed ? (SPEEDS[speed] ?? `${speed} Mb/s`) : undefined, `${base}/speed`)
        .prop('max_power', await r.text(`${base}/bMaxPower`), `${base}/bMaxPower`)
        .prop('configuration_count', await r.num(`${base}/bNumConfigurations`), `${base}/bNumConfigurations`)
        .prop('interface_count', await r.num(`${base}/bNumInterfaces`), `${base}/bNumInterfaces`)
        .prop('interface_classes', [...ifClasses].map((c) => USB_CLASSES[c] ?? c).join(', ') || undefined, `${base}/<interface>/bInterfaceClass`, { evidence: 'derived' })
        .prop('bus_number', await r.num(`${base}/busnum`), `${base}/busnum`)
        .prop('device_number', await r.num(`${base}/devnum`), `${base}/devnum`, { volatile: true })
        .prop('removable', await r.text(`${base}/removable`), `${base}/removable`)
        .prop('authorized', (await r.num(`${base}/authorized`)) === 1, `${base}/authorized`)
        .prop('device_revision', await r.text(`${base}/bcdDevice`), `${base}/bcdDevice`)
        .prop('device_protocol', hex(await r.text(`${base}/bDeviceProtocol`), 2), `${base}/bDeviceProtocol`)
        .prop('endpoints', endpoints.length ? endpoints.join('; ') : undefined, `${base}/<interface>/ep_*/{type,direction,wMaxPacketSize}`)
        .prop('port_connect_type', await r.text(`${base}/port/connect_type`), `${base}/port/connect_type`)
        .prop('port_over_current_count', await r.num(`${base}/port/over_current_count`), `${base}/port/over_current_count`, { volatile: true })
        .prop('runtime_status', await r.text(`${base}/power/runtime_status`), `${base}/power/runtime_status`, { volatile: true })

      // Topology as enumerated by the kernel: a USB device hangs off its upstream hub port.
      const segs = real?.split('/') ?? []
      const i = segs.lastIndexOf(n)
      const parentSeg = i > 0 ? segs[i - 1] : undefined
      if (parentSeg && USB_DEV.test(parentSeg)) {
        b.rel(keyOf.get(parentSeg), 'bus_attachment', `${base} (sysfs device path)`)
      } else if (isRoot) {
        const pci = pciAncestor(real)
        if (pci) b.rel(pciKey(pci), 'bus_attachment', `${base} (sysfs device path)`)
      }
      out.push(b.build())
    }
    return finish(ctx, out)
  }
}
