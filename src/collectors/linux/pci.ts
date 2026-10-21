import type { DeviceObservation } from '@shared/schemas'
import { ObservationBuilder, type CollectContext } from '../core/context'
import type { Collector } from '../core/types'
import { finish, hex, PCI_ADDR, pciAncestor, pciIds, pciKey } from './shared'

const ID = 'linux.pci'

/** `TOTAL_ERR_COR 3` line of an `aer_dev_*` file. Per-bit lines are ignored; absent/malformed → undefined. */
export function parseAerTotal(text: string | undefined): number | undefined {
  const m = /^TOTAL_ERR_\w+\s+(\d+)\s*$/m.exec(text ?? '')
  return m ? Number(m[1]) : undefined
}

/** Link widths of 0 and 255 are sysfs sentinels (integrated or non-PCIe-link devices), not real widths. */
export function validLinkWidth(n: number | undefined): number | undefined {
  return n !== undefined && Number.isInteger(n) && n >= 1 && n <= 32 ? n : undefined
}

/** Leading number of a sysfs link-speed string such as `16.0 GT/s PCIe`; `Unknown speed` → undefined. */
export function parseLinkSpeed(text: string | undefined): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*GT\/s/.exec(text ?? '')
  return m ? Number(m[1]) : undefined
}

export const linuxPci: Collector = {
  id: ID,
  version: '1.0.0',
  platforms: ['linux'],
  categories: ['pci'],
  permissions: [],
  method: '/sys/bus/pci/devices + hwdata pci.ids name lookup',
  timeoutMs: 8000,
  retries: 1,
  isSupported: (ctx) => ctx.reader.exists('/sys/bus/pci/devices'),
  async collect(ctx: CollectContext) {
    const r = ctx.reader
    const at = ctx.host.now()
    const ids = await pciIds()
    const names = (await r.dir('/sys/bus/pci/devices')).filter((n) => PCI_ADDR.test(n))
    const out: DeviceObservation[] = []
    for (const addr of names) {
      const base = `/sys/bus/pci/devices/${addr}`
      const vendor = hex(await r.text(`${base}/vendor`), 4)
      const device = hex(await r.text(`${base}/device`), 4)
      const classCode = hex(await r.text(`${base}/class`), 6)
      if (!vendor || !device) continue
      const subVendor = hex(await r.text(`${base}/subsystem_vendor`), 4)
      const subDevice = hex(await r.text(`${base}/subsystem_device`), 4)
      const vendorName = ids.vendor(vendor)
      const deviceName = ids.device(vendor, device)
      const className = classCode ? (ids.className(classCode.slice(0, 4)) ?? ids.className(classCode.slice(0, 2))) : undefined
      const driverLink = await r.link(`${base}/driver`)
      const driver = driverLink?.split('/').pop()
      const real = await r.real(base)
      const parent = pciAncestor(real, true)
      const isBridge = classCode?.startsWith('0604') ?? false
      const isHost = classCode?.startsWith('0600') ?? false
      const name = deviceName ?? `PCI device ${vendor}:${device}`
      const b = new ObservationBuilder(ID, pciKey(addr), 'pci', name, at, {
        sourceProperty: deviceName ? 'pci.ids lookup (vendor:device)' : 'derived from vendor:device ids',
        evidence: deviceName ? 'database_lookup' : 'derived'
      })
        .status('ok')
        .field('manufacturer', vendorName, 'pci.ids lookup (vendor id)', 'database_lookup')
        .field('model', deviceName, 'pci.ids lookup (device id)', 'database_lookup')
        .field('vendorId', vendor, `${base}/vendor`)
        .field('productId', device, `${base}/device`)
        .field('busType', 'PCI', 'derived', 'derived')
        .field('deviceClass', className ?? classCode, className ? 'pci.ids class lookup' : `${base}/class`, className ? 'database_lookup' : 'os_reported')
        .field('subtype', isBridge ? 'bridge' : isHost ? 'host_bridge' : className?.toLowerCase().replace(/\s+/g, '_'), 'pci.ids class lookup', 'database_lookup')
        .field('driver', driver, `${base}/driver`)
        .id('pci_address', addr)
        .id('pci_ids', `${vendor}:${device}`)
        .id('pci_subsystem', subVendor && subDevice ? `${subVendor}:${subDevice}` : undefined)
        .prop('class_code', classCode, `${base}/class`)
        .prop('revision', hex(await r.text(`${base}/revision`), 2), `${base}/revision`)
        .prop('subsystem_vendor', subVendor, `${base}/subsystem_vendor`)
        .prop('subsystem_device', subDevice, `${base}/subsystem_device`)
        .prop('link_speed', await r.text(`${base}/current_link_speed`), `${base}/current_link_speed`)
        .prop('link_width', validLinkWidth(await r.num(`${base}/current_link_width`)), `${base}/current_link_width`)
        .prop('max_link_speed', await r.text(`${base}/max_link_speed`), `${base}/max_link_speed`)
        .prop('max_link_width', validLinkWidth(await r.num(`${base}/max_link_width`)), `${base}/max_link_width`)
        .prop('numa_node', (await r.num(`${base}/numa_node`)) !== -1 ? await r.num(`${base}/numa_node`) : undefined, `${base}/numa_node`)
        .prop('iommu_group', (await r.link(`${base}/iommu_group`))?.split('/').pop(), `${base}/iommu_group`)
        .prop('power_state', await r.text(`${base}/power_state`), `${base}/power_state`, { volatile: true })
        .prop('enabled', (await r.num(`${base}/enable`)) === 1 ? true : (await r.exists(`${base}/enable`)) ? false : undefined, `${base}/enable`, { volatile: true })
      // AER counters count errors since boot; absent files mean "not exposed", never zero errors.
      for (const [key, file] of [['aer_correctable_errors', 'aer_dev_correctable'], ['aer_nonfatal_errors', 'aer_dev_nonfatal'], ['aer_fatal_errors', 'aer_dev_fatal']] as const) {
        b.prop(key, parseAerTotal(await r.text(`${base}/${file}`)), `${base}/${file}`, { volatile: true })
      }
      b.prop('local_cpulist', await r.text(`${base}/local_cpulist`), `${base}/local_cpulist`)
        .prop('runtime_pm_status', await r.text(`${base}/power/runtime_status`), `${base}/power/runtime_status`, { volatile: true })
      // The upstream port's capability bounds what this device can negotiate; derived from the parent's own sysfs files.
      if (parent) {
        const pbase = `/sys/bus/pci/devices/${parent}`
        b.prop('upstream_max_link_speed', await r.text(`${pbase}/max_link_speed`), `${pbase}/max_link_speed`, { evidence: 'derived' })
          .prop('upstream_max_link_width', validLinkWidth(await r.num(`${pbase}/max_link_width`)), `${pbase}/max_link_width`, { evidence: 'derived' })
      }
      // Out-of-tree/vendor modules expose `version`; in-tree modules usually do not, which is "not exposed", not "unknown driver".
      if (driver) {
        b.prop('driver_module_version', await r.text(`/sys/module/${driver.replace(/[^\w-]/g, '_')}/version`), `/sys/module/${driver}/version`)
          .prop('driver_srcversion', await r.text(`/sys/module/${driver.replace(/[^\w-]/g, '_')}/srcversion`), `/sys/module/${driver}/srcversion`)
      }
      const card = (await r.dir(`${base}/drm`)).find((n) => /^card\d+$/.test(n))
      if (card) {
        const dbase = `${base}/drm/${card}`
        const connectors = (await r.dir(dbase)).filter((n) => n.startsWith(`${card}-`))
        const connected: string[] = []
        for (const c of connectors) if ((await r.text(`${dbase}/${c}/status`)) === 'connected') connected.push(c.slice(card.length + 1))
        b.prop('drm_card', card, dbase)
          .prop('drm_connector_count', connectors.length, dbase)
          .prop('drm_connected_outputs', connected.join(', ') || (connectors.length ? 'none' : undefined), `${dbase}/<connector>/status`, { volatile: true })
          .prop('gpu_freq_max_mhz', await r.num(`${dbase}/gt_RP0_freq_mhz`), `${dbase}/gt_RP0_freq_mhz`, { unit: 'MHz' })
          .prop('gpu_freq_limit_mhz', await r.num(`${dbase}/gt_max_freq_mhz`), `${dbase}/gt_max_freq_mhz`, { unit: 'MHz', volatile: true })
          .prop('vram_total_bytes', await r.num(`${base}/mem_info_vram_total`), `${base}/mem_info_vram_total`, { unit: 'B' })
      }
      if (parent) b.rel(pciKey(parent), 'bus_attachment', `${base} (sysfs device path)`)
      else b.rel('system:host', 'logical_parent', 'sysfs root complex', { directness: 'inferred', confidence: 0.6 })
      out.push(b.build())
    }
    const extra = []
    if (!(await pciIds()).vendor('8086') && !(await pciIds()).vendor('10de')) {
      extra.push({ kind: 'missing_tool' as const, message: 'pci.ids database not found (install hwdata / pciutils). Device names fall back to vendor:device IDs.', target: 'pci.ids' })
    }
    return finish(ctx, out, extra)
  }
}
