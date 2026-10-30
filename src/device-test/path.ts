import { posix } from 'node:path'
import type { SysReader } from '@collectors/core/sysreader'
import { roleFromUdev } from '../device-control'
import type { PathNode } from './types'

const PCI_CLASS: Record<string, string> = {
  '0c03': 'USB controller', '0c05': 'SMBus controller', '0c80': 'serial bus controller', '0104': 'RAID controller', '0106': 'SATA controller', '0108': 'NVMe controller',
  '0200': 'Ethernet controller', '0280': 'network controller (Wi-Fi)', '0300': 'VGA controller', '0380': 'display controller', '0403': 'audio device', '0480': 'multimedia controller',
  '0600': 'host bridge', '0601': 'ISA bridge', '0604': 'PCI bridge', '0780': 'communication controller', '0880': 'system peripheral', '1180': 'signal processing controller'
}
const USB_IF_CLASS: Record<string, string> = { '01': 'audio', '02': 'communications', '03': 'HID (mouse/keyboard)', '06': 'imaging', '07': 'printer', '08': 'mass storage', '09': 'hub', '0a': 'CDC data', '0e': 'video', 'e0': 'wireless', 'ef': 'miscellaneous', 'fe': 'application specific', 'ff': 'vendor specific' }
const SPEED: Record<string, string> = { '1.5': '1.5 Mb/s (low speed)', '12': '12 Mb/s (full speed)', '480': '480 Mb/s (high speed)', '5000': '5 Gb/s', '10000': '10 Gb/s', '20000': '20 Gb/s' }
/** Directories that only group children; walked through without a node of their own. */
const CONTAINERS = new Set(['input', 'power_supply', 'hidraw', 'net', 'block', 'video4linux', 'bluetooth', 'sound', 'nvme', 'drm', 'usbmisc', 'hwmon'])
const SKIP = new Set(['power', 'subsystem', 'driver', 'firmware_node', 'port', 'physical_node', 'wakeup', 'device', 'of_node', 'iommu', 'iommu_group', 'msi_irqs', 'consumers', 'suppliers', 'queue', 'mq', 'holders', 'slaves', 'trace', 'integrity', 'statistics', 'queues', 'phy80211', 'report_descriptor'])
const MAX_NODES = 80

const tr = (s: string | undefined): string | undefined => s?.trim() || undefined

type Kind = PathNode['kind']

function classify(seg: string): Kind | null {
  if (/^pci[0-9a-f]{4}:[0-9a-f]{2}$/.test(seg)) return 'pci-root'
  if (/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.\d$/.test(seg)) return 'pci'
  if (/^usb\d+$/.test(seg)) return 'usb-root'
  if (/^\d+-[\d.]+$/.test(seg)) return 'usb'
  if (/^\d+-[\d.]+:\d+\.\d+$/.test(seg)) return 'usb-interface'
  if (/^[0-9A-F]{4}:[0-9A-F]{4}:[0-9A-F]{4}\.[0-9A-F]{4}$/.test(seg)) return 'hid'
  if (/^input\d+$/.test(seg)) return 'input'
  if (/^serio\d+$/.test(seg)) return 'serio'
  if (/^i2c-\d+$|^i2c-[A-Z0-9]+:\d+$/.test(seg)) return 'i2c'
  if (/^nvme\d+(n\d+)?$|^(sd[a-z]+|mmcblk\d+)$/.test(seg)) return 'storage'
  if (/^hci\d+$/.test(seg)) return 'bluetooth'
  if (/^video\d+$/.test(seg)) return 'camera'
  return null
}

/** Builds the connection map for one device: its chain of parents and everything below it, read from sysfs. */
export class PathBuilder {
  private count = 0
  constructor(private r: SysReader) {}

  private async driver(dir: string): Promise<string | undefined> {
    const l = await this.r.link(`${dir}/driver`)
    return l ? posix.basename(l) : undefined
  }

  private async node(dir: string, kind: Kind): Promise<PathNode> {
    const r = this.r
    const seg = posix.basename(dir)
    const details: [string, string][] = []
    const add = (k: string, v: string | number | undefined | null): void => { if (v !== undefined && v !== null && v !== '') details.push([k, String(v)]) }
    let title = seg
    const drv = await this.driver(dir)
    switch (kind) {
      case 'pci-root': title = `PCI root complex (${seg})`; break
      case 'pci': {
        const cls = tr(await r.text(`${dir}/class`))?.slice(2, 6)
        title = `${PCI_CLASS[cls ?? ''] ?? 'PCI device'} (${seg})`
        add('Vendor:device', `${tr(await r.text(`${dir}/vendor`))?.slice(2)}:${tr(await r.text(`${dir}/device`))?.slice(2)}`)
        const speed = tr(await r.text(`${dir}/current_link_speed`))
        const width = Number(tr(await r.text(`${dir}/current_link_width`)) ?? 0)
        if (speed && !/unknown/i.test(speed) && width > 0 && width < 255) add('PCIe link', `${speed} x${width}`)
        add('Power state', tr(await r.text(`${dir}/power_state`)))
        break
      }
      case 'usb-root': title = `USB root hub, bus ${seg.slice(3)}`; add('USB version', tr(await r.text(`${dir}/version`))); add('Ports', tr(await r.text(`${dir}/maxchild`))); break
      case 'usb': {
        const product = tr(await r.text(`${dir}/product`))
        title = product ? `${product} (port ${seg})` : `USB device on port ${seg}`
        add('Manufacturer', tr(await r.text(`${dir}/manufacturer`)))
        add('ID', `${tr(await r.text(`${dir}/idVendor`))}:${tr(await r.text(`${dir}/idProduct`))}`)
        add('Speed', SPEED[tr(await r.text(`${dir}/speed`)) ?? ''] ?? tr(await r.text(`${dir}/speed`)))
        add('USB version', tr(await r.text(`${dir}/version`)))
        add('Power request', tr(await r.text(`${dir}/bMaxPower`)))
        add('Power state', tr(await r.text(`${dir}/power/runtime_status`)))
        add('Hub ports', tr(await r.text(`${dir}/maxchild`)) !== '0' ? tr(await r.text(`${dir}/maxchild`)) : undefined)
        break
      }
      case 'usb-interface': {
        const cls = tr(await r.text(`${dir}/bInterfaceClass`)) ?? ''
        title = `Interface ${seg.split(':')[1]} · ${USB_IF_CLASS[cls] ?? `class ${cls}`}`
        add('Endpoints', tr(await r.text(`${dir}/bNumEndpoints`)))
        break
      }
      case 'hid': {
        const name = /HID_NAME=(.*)/.exec((await r.text(`${dir}/uevent`)) ?? '')?.[1]
        title = name ? `${name} (HID)` : `HID device ${seg}`
        add('HID ID', seg)
        break
      }
      case 'input': {
        title = tr(await r.text(`${dir}/name`)) ?? seg
        const ev = (await r.dir(dir)).find((x) => /^event\d+$/.test(x))
        if (ev) {
          add('Event node', `/dev/input/${ev}`)
          const dev = tr(await r.text(`${dir}/${ev}/dev`))
          const role = dev ? roleFromUdev((await r.text(`/run/udev/data/c${dev}`)) ?? '') : null
          add('Role', role ?? 'other')
        }
        add('Physical path', tr(await r.text(`${dir}/phys`)))
        if (tr(await r.text(`${dir}/inhibited`)) === '1') add('Inhibited', 'yes')
        break
      }
      case 'battery': {
        title = `Battery: ${tr(await r.text(`${dir}/model_name`)) ?? seg}`
        add('Charge', tr(await r.text(`${dir}/capacity`)) ? `${tr(await r.text(`${dir}/capacity`))}%` : tr(await r.text(`${dir}/capacity_level`)))
        add('Status', tr(await r.text(`${dir}/status`)))
        add('Online', tr(await r.text(`${dir}/online`)) === '1' ? 'yes' : tr(await r.text(`${dir}/online`)) === '0' ? 'no (asleep or out of range)' : undefined)
        break
      }
      case 'network': title = `Network interface ${seg}`; add('State', tr(await r.text(`${dir}/operstate`))); break
      case 'storage': title = /^nvme\d+$/.test(seg) ? `NVMe controller ${seg}` : `Drive ${seg}`; add('Model', tr(await r.text(`${dir}/model`)) ?? tr(await r.text(`${dir}/device/model`))); break
      case 'camera': title = tr(await r.text(`${dir}/name`)) ?? `Camera ${seg}`; add('Device', `/dev/${seg}`); break
      case 'bluetooth': title = `Bluetooth adapter ${seg}`; break
      case 'serio': title = `PS/2 port (${seg})`; add('Description', tr(await r.text(`${dir}/description`))); break
      case 'i2c': title = `I2C ${seg}`; add('Name', tr(await r.text(`${dir}/name`))); break
      default: break
    }
    add('Driver', drv)
    return { kind, title, sysfs: dir, details, children: [] }
  }

  private kindOf(parent: string, seg: string): Kind | null {
    const c = classify(seg)
    if (c) return c
    const container = posix.basename(parent)
    if (container === 'power_supply') return 'battery'
    if (container === 'net') return 'network'
    return null
  }

  private async children(dir: string, depth: number): Promise<PathNode[]> {
    if (depth > 6) return []
    const out: PathNode[] = []
    for (const seg of await this.r.dir(dir)) {
      if (this.count >= MAX_NODES || SKIP.has(seg) || /^ep_|^event\d+$|^mouse\d+$|^hidraw\d+$/.test(seg)) continue
      const sub = `${dir}/${seg}`
      if (CONTAINERS.has(seg)) { out.push(...(await this.children(sub, depth + 1))); continue }
      const kind = this.kindOf(dir, seg)
      if (!kind) continue
      // Links (subsystem/driver/…) must not be followed: only real child directories belong to this device.
      if ((await this.r.link(sub)) !== undefined) continue
      this.count++
      const n = await this.node(sub, kind)
      n.children = await this.children(sub, depth + 1)
      out.push(n)
    }
    return out
  }

  /** The chain from the root down to `deviceDir` (each node's only child is the next), with the device's own subtree. */
  async build(deviceDir: string): Promise<PathNode | null> {
    this.count = 0
    const segs = deviceDir.split('/').filter(Boolean)
    const chain: PathNode[] = []
    for (let i = 2; i <= segs.length; i++) {
      const dir = `/${segs.slice(0, i).join('/')}`
      const seg = segs[i - 1]!
      const kind = this.kindOf(`/${segs.slice(0, i - 1).join('/')}`, seg)
      if (!kind || i === segs.length) continue
      chain.push(await this.node(dir, kind))
    }
    const lastSeg = segs.at(-1)!
    const target = await this.node(deviceDir, this.kindOf(posix.dirname(deviceDir), lastSeg) ?? 'other')
    target.target = true
    target.children = await this.children(deviceDir, 0)
    for (let i = chain.length - 1; i >= 0; i--) chain[i]!.children = [i === chain.length - 1 ? target : chain[i + 1]!]
    return chain[0] ?? target
  }
}
