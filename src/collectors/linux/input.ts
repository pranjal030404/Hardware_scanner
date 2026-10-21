import type { DeviceObservation } from '@shared/schemas'
import { meaningful, ObservationBuilder, type CollectContext } from '../core/context'
import type { Collector } from '../core/types'
import { finish, pciAncestor, pciKey, usbDeviceName, usbKey } from './shared'

const ID = 'linux.input'

export interface InputDevice {
  bus: string
  vendor: string
  product: string
  version: string
  name: string
  phys?: string
  sysfs?: string
  uniq?: string
  handlers: string[]
  ev: bigint
}

const BUS: Record<string, string> = { '0001': 'PCI', '0003': 'USB', '0005': 'Bluetooth', '0006': 'virtual', '0010': 'ISA', '0011': 'i8042 (PS/2)', '0018': 'I2C', '0019': 'host/platform', '001c': 'SPI' }

/** Parse /proc/bus/input/devices. */
export function parseInputDevices(text: string): InputDevice[] {
  const out: InputDevice[] = []
  for (const block of text.split(/\n\s*\n/)) {
    const d: Partial<InputDevice> = { handlers: [], ev: 0n }
    for (const line of block.split('\n')) {
      const t = line.slice(3)
      switch (line[0]) {
        case 'I': {
          const m = /Bus=(\w+) Vendor=(\w+) Product=(\w+) Version=(\w+)/.exec(t)
          if (m) Object.assign(d, { bus: m[1], vendor: m[2], product: m[3], version: m[4] })
          break
        }
        case 'N':
          d.name = /Name="(.*)"/.exec(t)?.[1]
          break
        case 'P':
          d.phys = /Phys=(.*)/.exec(t)?.[1]
          break
        case 'S':
          d.sysfs = /Sysfs=(.*)/.exec(t)?.[1]
          break
        case 'U':
          d.uniq = /Uniq=(.*)/.exec(t)?.[1]
          break
        case 'H':
          d.handlers = (/Handlers=(.*)/.exec(t)?.[1] ?? '').split(/\s+/).filter(Boolean)
          break
        case 'B': {
          const m = /EV=(\w+)/.exec(t)
          if (m) d.ev = BigInt('0x' + m[1])
          break
        }
      }
    }
    if (d.name && d.bus) out.push(d as InputDevice)
  }
  return out
}

const EV_KEY = 1n << 1n
const EV_REP = 1n << 20n
const EV_ABS = 1n << 3n

export function classifyInput(d: InputDevice): string {
  const h = d.handlers
  if (/touchpad|trackpad/i.test(d.name)) return 'touchpad'
  if (d.bus === '0000' && /\b(headphone|headset|hdmi|line (in|out)|mic|speaker)\b|jack/i.test(d.name)) return 'audio_jack_sense'
  if (h.some((x) => /^js\d+/.test(x))) return 'game_controller'
  if (h.some((x) => /^mouse\d+$/.test(x))) return d.ev & EV_ABS && /touch/i.test(d.name) ? 'touchscreen' : 'pointer'
  if (h.includes('kbd') && d.ev & EV_REP && d.ev & EV_KEY) return 'keyboard'
  if (/button|switch|lid/i.test(d.name)) return 'button'
  return 'other_input'
}

export const linuxInput: Collector = {
  id: ID,
  version: '1.0.0',
  platforms: ['linux'],
  categories: ['hid'],
  permissions: [],
  method: '/proc/bus/input/devices',
  timeoutMs: 5000,
  retries: 1,
  isSupported: (ctx) => ctx.reader.exists('/proc/bus/input/devices'),
  async collect(ctx: CollectContext) {
    const r = ctx.reader
    const at = ctx.host.now()
    const text = await r.text('/proc/bus/input/devices')
    if (text === undefined) return { outcome: 'unavailable' as const, observations: [], limitations: [{ kind: 'missing_interface' as const, message: '/proc/bus/input/devices could not be read' }] }
    const out: DeviceObservation[] = []
    const seen = new Set<string>()
    for (const d of parseInputDevices(text)) {
      const busCode = d.bus.toLowerCase().padStart(4, '0')
      const subtype = classifyInput(d)
      // Identity: bus + ids + name (+ unique id if reported). Several event nodes can share the same
      // name on one device (e.g. "Keyboard" / "Consumer Control"); the name keeps them apart.
      let key = `hid:${busCode}:${d.vendor}:${d.product}:${d.name}`.toLowerCase().replace(/\s+/g, '_')
      if (d.uniq) key += `:${d.uniq}`
      if (seen.has(key)) key += `:${d.phys ?? seen.size}`
      seen.add(key)
      const real = d.sysfs ? await r.real(`/sys${d.sysfs}`) : undefined
      const usb = usbDeviceName(real ?? d.sysfs)
      const pci = pciAncestor(real ?? d.sysfs)
      const b = new ObservationBuilder(ID, key, 'hid', d.name, at, { sourceProperty: '/proc/bus/input/devices N: Name' })
        .status('ok')
        .field('subtype', subtype, 'Handlers + EV capability bits', 'derived')
        .field('vendorId', d.vendor.toLowerCase().padStart(4, '0'), '/proc/bus/input/devices I: Vendor')
        .field('productId', d.product.toLowerCase().padStart(4, '0'), '/proc/bus/input/devices I: Product')
        .field('busType', BUS[busCode] ?? `bus 0x${busCode}`, '/proc/bus/input/devices I: Bus')
        .id('input_ids', `${d.vendor.toLowerCase()}:${d.product.toLowerCase()}`)
        .id('phys', meaningful(d.phys), true)
        .id('uniq', meaningful(d.uniq), true)
        .prop('handlers', d.handlers.join(' '), '/proc/bus/input/devices H: Handlers')
        .prop('version', d.version, '/proc/bus/input/devices I: Version')
      if (usb) b.rel(await usbKey(r, usb), 'bus_attachment', '/proc/bus/input/devices S: Sysfs')
      else if (pci) b.rel(pciKey(pci), 'bus_attachment', '/proc/bus/input/devices S: Sysfs')
      out.push(b.build())
    }
    return finish(ctx, out)
  }
}

export const linuxVideo: Collector = {
  id: 'linux.video',
  version: '1.0.0',
  platforms: ['linux'],
  categories: ['camera'],
  permissions: [],
  method: '/sys/class/video4linux',
  timeoutMs: 5000,
  retries: 1,
  isSupported: (ctx) => ctx.reader.exists('/sys/class/video4linux'),
  async collect(ctx: CollectContext) {
    const r = ctx.reader
    const at = ctx.host.now()
    const out: DeviceObservation[] = []
    const names = await r.dir('/sys/class/video4linux')
    // A physical camera exposes several nodes (capture + metadata); collapse by parent device.
    const byParent = new Map<string, { names: string[]; label: string; usb?: string; pci?: string }>()
    for (const n of names) {
      const base = `/sys/class/video4linux/${n}`
      const real = await r.real(base)
      const label = (await r.text(`${base}/name`)) ?? n
      const usb = usbDeviceName(real)
      const parent = usb ?? pciAncestor(real) ?? n
      const e = byParent.get(parent) ?? { names: [], label, usb, pci: pciAncestor(real) }
      e.names.push(n)
      byParent.set(parent, e)
    }
    for (const [parent, e] of byParent) {
      const b = new ObservationBuilder('linux.video', `camera:${parent}:${e.label}`.replace(/\s+/g, '_'), 'camera', e.label, at, { sourceProperty: '/sys/class/video4linux/*/name' })
        .status('ok')
        .field('subtype', 'video_capture', 'video4linux class', 'derived')
        .field('busType', e.usb ? 'USB' : e.pci ? 'PCI' : undefined, 'sysfs device path', 'derived')
        .id('v4l_nodes', e.names.join(','))
        .prop('device_nodes', e.names.map((n) => `/dev/${n}`).join(', '), '/sys/class/video4linux')
      if (e.usb) b.rel(await usbKey(r, e.usb), 'bus_attachment', 'sysfs device path')
      else if (e.pci) b.rel(pciKey(e.pci), 'bus_attachment', 'sysfs device path')
      out.push(b.build())
    }
    return finish(ctx, out)
  }
}
