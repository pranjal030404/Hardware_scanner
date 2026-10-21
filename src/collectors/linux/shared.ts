import { promises as fs } from 'node:fs'
import type { CollectorResult, DeviceObservation, Limitation } from '@shared/schemas'
import type { CollectContext } from '../core/context'
import { emptyIds, parseIds, type IdDatabase } from '../core/ids'
import type { SysReader } from '../core/sysreader'

export const PCI_ADDR = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i
export const USB_DEV = /^(usb\d+|\d+-\d+(\.\d+)*)$/
export const pciKey = (addr: string): string => `pci:${addr.toLowerCase()}`

const PCI_IDS_PATHS = ['/usr/share/hwdata/pci.ids', '/usr/share/misc/pci.ids', '/usr/share/pci.ids']
const USB_IDS_PATHS = ['/usr/share/hwdata/usb.ids', '/usr/share/misc/usb.ids', '/usr/share/usb.ids']

const cache = new Map<string, Promise<IdDatabase>>()

async function loadFirst(paths: string[]): Promise<IdDatabase> {
  for (const p of paths) {
    try {
      return parseIds(await fs.readFile(p, 'utf8'))
    } catch {
      /* try next */
    }
  }
  return emptyIds
}

/** ID databases are host files (not part of a fixture tree); tests can pass their own via `ctx`. */
export function pciIds(): Promise<IdDatabase> {
  if (!cache.has('pci')) cache.set('pci', loadFirst(PCI_IDS_PATHS))
  return cache.get('pci')!
}
export function usbIds(): Promise<IdDatabase> {
  if (!cache.has('usb')) cache.set('usb', loadFirst(USB_IDS_PATHS))
  return cache.get('usb')!
}
export function setIdDatabasesForTest(pci: IdDatabase | undefined, usb: IdDatabase | undefined): void {
  cache.clear()
  if (pci) cache.set('pci', Promise.resolve(pci))
  if (usb) cache.set('usb', Promise.resolve(usb))
}

export const hex = (v: string | undefined, width: number): string | undefined => {
  if (!v) return undefined
  const n = parseInt(v.replace(/^0x/i, ''), 16)
  return Number.isFinite(n) ? n.toString(16).padStart(width, '0') : undefined
}

/** The nearest PCI function in a sysfs device path, e.g. for a netdev or block device. */
export function pciAncestor(realPath: string | undefined, skipSelf = false): string | undefined {
  if (!realPath) return undefined
  const segs = realPath.split('/').filter((s) => PCI_ADDR.test(s))
  if (!segs.length) return undefined
  return skipSelf ? segs[segs.length - 2] : segs[segs.length - 1]
}

/** The nearest USB device (not interface) in a sysfs device path. */
export function usbDeviceName(realPath: string | undefined): string | undefined {
  if (!realPath) return undefined
  const segs = realPath.split('/').filter((s) => /^\d+-\d+(\.\d+)*$/.test(s))
  return segs[segs.length - 1]
}

/**
 * Identity key for a USB device. With a serial number the key survives moving the device to a
 * different port; without one, the bus port path is the best available stable identity.
 */
export async function usbKey(reader: SysReader, name: string): Promise<string | undefined> {
  const base = `/sys/bus/usb/devices/${name}`
  const vid = await reader.text(`${base}/idVendor`)
  const pid = await reader.text(`${base}/idProduct`)
  if (!vid || !pid) return undefined
  const serial = await reader.text(`${base}/serial`)
  return serial ? `usb:${vid}:${pid}:sn:${serial}` : `usb:${vid}:${pid}:port:${name}`
}

export function finish(
  ctx: CollectContext,
  observations: DeviceObservation[],
  limitations: Limitation[] = [],
  opts: { message?: string; requireAnyIf?: boolean } = {}
): CollectorResult {
  const denied = ctx.reader.deniedList()
  const all = [...limitations]
  // A collector that already explained its permission problem specifically needs no generic note.
  if (denied.length && !all.some((l) => l.kind === 'permission')) {
    const sample = denied.slice(0, 3).join(', ')
    all.push({
      kind: 'permission',
      message: `${denied.length} path(s) were not readable by this user (e.g. ${sample}); related fields are unavailable, not empty.`,
      target: denied[0],
      remedy: 'Run with elevated read access to /sys/firmware or the listed paths if you need these details.'
    })
  }
  const blocking = all.some((l) => l.kind === 'permission' || l.kind === 'timeout' || l.kind === 'missing_tool')
  let outcome: CollectorResult['outcome'] = blocking ? 'partial' : 'complete'
  if (!observations.length && denied.length) outcome = 'permission_required'
  return { outcome, observations, limitations: all, message: opts.message }
}
