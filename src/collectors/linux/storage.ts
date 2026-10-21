import type { DeviceObservation } from '@shared/schemas'
import { meaningful, ObservationBuilder, type CollectContext } from '../core/context'
import type { Collector } from '../core/types'
import { finish, pciAncestor, pciKey, usbDeviceName, usbKey } from './shared'

/** sysfs uses -1 for "no NUMA affinity"; that is the absence of a value, not node -1. */
const nonNegative = (n: number | undefined): number | undefined => (n !== undefined && n >= 0 ? n : undefined)

const ID = 'linux.storage'

export interface Mount {
  source: string
  mount: string
  fs: string
}

const PSEUDO_FS = new Set(['proc', 'sysfs', 'tmpfs', 'devtmpfs', 'devpts', 'cgroup', 'cgroup2', 'securityfs', 'debugfs', 'tracefs', 'configfs', 'fusectl', 'pstore', 'bpf', 'mqueue', 'hugetlbfs', 'autofs', 'binfmt_misc', 'efivarfs', 'ramfs', 'overlay', 'squashfs', 'nsfs', 'selinuxfs', 'fuse.portal', 'fuse.gvfsd-fuse'])

const unescapeMount = (s: string): string => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))

export function parseMounts(text: string): Mount[] {
  const out: Mount[] = []
  for (const line of text.split('\n')) {
    const f = line.split(' ')
    if (f.length < 3 || !f[0]!.startsWith('/dev/')) continue
    if (PSEUDO_FS.has(f[2]!)) continue
    out.push({ source: f[0]!, mount: unescapeMount(f[1]!), fs: f[2]! })
  }
  return out
}

export const linuxStorage: Collector = {
  id: ID,
  version: '1.0.0',
  platforms: ['linux'],
  categories: ['storage'],
  permissions: [],
  method: '/sys/block + /proc/self/mounts + statfs',
  timeoutMs: 8000,
  retries: 1,
  isSupported: (ctx) => ctx.reader.exists('/sys/block'),
  async collect(ctx: CollectContext) {
    const r = ctx.reader
    const at = ctx.host.now()
    const mounts = parseMounts((await r.text('/proc/self/mounts')) ?? '')
    const out: DeviceObservation[] = []

    for (const n of await r.dir('/sys/block')) {
      if (/^(loop|ram)\d+$/.test(n)) continue
      const base = `/sys/block/${n}`
      const sectors = await r.num(`${base}/size`)
      const real = await r.real(base)
      if (!sectors && /^(sr|fd)\d+$/.test(n) === false && real?.includes('/virtual/')) continue
      const sizeBytes = sectors !== undefined ? sectors * 512 : undefined
      const isNvme = n.startsWith('nvme')
      const usb = usbDeviceName(real)
      const pci = pciAncestor(real)
      const model = meaningful(await r.text(`${base}/device/model`))
      const vendor = meaningful(await r.text(`${base}/device/vendor`))
      const serial = meaningful(await r.text(`${base}/device/serial`)) ?? meaningful(await r.text(`${base}/device/serial_number`))
      const wwid = meaningful(await r.text(`${base}/wwid`)) ?? meaningful(await r.text(`${base}/device/wwid`))
      const rotational = await r.num(`${base}/queue/rotational`)
      const removable = await r.num(`${base}/removable`)
      const virtual = !!real?.includes('/devices/virtual/')
      const bus = isNvme ? 'NVMe' : usb ? 'USB' : real?.includes('/ata') ? 'SATA/ATA' : real?.includes('/virtio') ? 'virtio' : virtual ? 'virtual' : real?.includes('/mmc') ? 'MMC' : undefined
      const subtype = virtual ? 'virtual_disk' : isNvme ? 'nvme_ssd' : rotational === 1 ? 'hdd' : rotational === 0 ? 'ssd_or_flash' : 'disk'
      const key = wwid ? `storage:wwid:${wwid.replace(/\s+/g, '_')}` : serial && model ? `storage:sn:${model}:${serial}` : `storage:dev:${n}`
      const diskKey = key

      const b = new ObservationBuilder(ID, key, 'storage', model ?? n, at, { sourceProperty: model ? `${base}/device/model` : `${base} (kernel name)` })
        .status('ok')
        .field('manufacturer', vendor, `${base}/device/vendor`)
        .field('model', model, `${base}/device/model`)
        .field('busType', bus, 'sysfs device path', 'derived')
        .field('subtype', subtype, '/queue/rotational + device path', 'derived')
        .field('driver', (await r.link(`${base}/device/device/driver`))?.split('/').pop() ?? (await r.link(`${base}/device/driver`))?.split('/').pop(), `${base}/device/driver`)
        .id('block_device', n)
        .id('wwid', wwid)
        .id('serial', serial, true)
        .prop('size_bytes', sizeBytes, `${base}/size × 512`, { unit: 'B', evidence: 'derived' })
        .prop('rotational', rotational === undefined ? undefined : rotational === 1, `${base}/queue/rotational`)
        .prop('removable', removable === undefined ? undefined : removable === 1, `${base}/removable`)
        .prop('read_only', (await r.num(`${base}/ro`)) === 1, `${base}/ro`)
        .prop('logical_block_size', await r.num(`${base}/queue/logical_block_size`), `${base}/queue/logical_block_size`, { unit: 'B' })
        .prop('physical_block_size', await r.num(`${base}/queue/physical_block_size`), `${base}/queue/physical_block_size`, { unit: 'B' })
        .prop('firmware', meaningful(await r.text(`${base}/device/firmware_rev`)), `${base}/device/firmware_rev`)
        .prop('rev', meaningful(await r.text(`${base}/device/rev`)), `${base}/device/rev`)
        .prop('scheduler', (await r.text(`${base}/queue/scheduler`))?.match(/\[(.+?)\]/)?.[1], `${base}/queue/scheduler`)
        .prop('kernel_name', n, `${base}`)
      if (isNvme) {
        // `nvme0n1` → controller `nvme0` (namespace suffix stripped). Controller state is the kernel's view, not the drive's SMART health.
        const ctrl = `/sys/class/nvme/${n.replace(/n\d+$/, '')}`
        b.prop('nvme_state', await r.text(`${ctrl}/state`), `${ctrl}/state`, { volatile: true })
          .prop('nvme_transport', await r.text(`${ctrl}/transport`), `${ctrl}/transport`)
          .prop('nvme_firmware', meaningful(await r.text(`${ctrl}/firmware_rev`)), `${ctrl}/firmware_rev`)
          .prop('nvme_queue_count', await r.num(`${ctrl}/queue_count`), `${ctrl}/queue_count`)
          .prop('nvme_numa_node', nonNegative(await r.num(`${ctrl}/numa_node`)), `${ctrl}/numa_node`)
      }
      if (usb) b.rel(await usbKey(r, usb), 'storage_attachment', `${base} (sysfs device path)`)
      else if (pci) b.rel(pciKey(pci), 'storage_attachment', `${base} (sysfs device path)`)
      out.push(b.build())

      // Partitions
      for (const p of (await r.dir(base)).filter((d) => d.startsWith(n))) {
        const pbase = `${base}/${p}`
        const pnum = await r.num(`${pbase}/partition`)
        if (pnum === undefined) continue
        const psectors = await r.num(`${pbase}/size`)
        const m = mounts.find((mm) => mm.source === `/dev/${p}`)
        const usage = m && ctx.host.statfs ? await ctx.host.statfs(m.mount) : undefined
        const uevent = (await r.text(`${pbase}/uevent`)) ?? ''
        const partName = /^PARTNAME=(.+)$/m.exec(uevent)?.[1]
        const pb = new ObservationBuilder(ID, `${diskKey}:part:${pnum}`, 'storage', partName ? `${partName} (${p})` : p, at, { sourceProperty: partName ? `${pbase}/uevent PARTNAME` : `${pbase} (kernel name)` })
          .status('ok')
          .field('subtype', 'partition', 'sysfs partition attribute', 'derived')
          .field('busType', bus, 'sysfs device path', 'derived')
          .id('block_device', p)
          .prop('partition_number', pnum, `${pbase}/partition`)
          .prop('size_bytes', psectors !== undefined ? psectors * 512 : undefined, `${pbase}/size × 512`, { unit: 'B', evidence: 'derived' })
          .prop('mount_point', m?.mount, '/proc/self/mounts')
          .prop('filesystem', m?.fs, '/proc/self/mounts')
          .prop('used_bytes', usage ? usage.totalBytes - usage.freeBytes : undefined, 'statfs(mount)', { unit: 'B', volatile: true, evidence: 'measured' })
          .prop('free_bytes', usage?.freeBytes, 'statfs(mount)', { unit: 'B', volatile: true, evidence: 'measured' })
          .prop('filesystem_total_bytes', usage?.totalBytes, 'statfs(mount)', { unit: 'B', evidence: 'measured' })
          .rel(diskKey, 'storage_attachment', `${pbase} (sysfs parent)`)
        out.push(pb.build())
      }
    }
    return finish(ctx, out)
  }
}
