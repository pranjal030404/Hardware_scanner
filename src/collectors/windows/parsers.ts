import type { Category } from '@shared/schemas'

export interface PnpRow {
  InstanceId: string
  FriendlyName?: string | null
  Class?: string | null
  Manufacturer?: string | null
  Status?: string | null
  Problem?: number | string | null
  Parent?: string | null
  Service?: string | null
}

export interface ParsedPnpId {
  bus: string
  vendorId?: string
  productId?: string
}

/** `USB\VID_046D&PID_C52B\5&...` and `PCI\VEN_8086&DEV_9A49&SUBSYS_...` */
export function parsePnpId(id: string): ParsedPnpId {
  const bus = id.split('\\')[0]!.toUpperCase()
  const vid = /VID_([0-9A-F]{4})/i.exec(id)?.[1] ?? /VEN_([0-9A-F]{4})/i.exec(id)?.[1]
  const pid = /PID_([0-9A-F]{4})/i.exec(id)?.[1] ?? /DEV_([0-9A-F]{4})/i.exec(id)?.[1]
  return { bus, vendorId: vid?.toLowerCase(), productId: pid?.toLowerCase() }
}

/** Map a Windows PnP class (and bus prefix) to our categories. Unknown classes stay `other`. */
export function categoryForPnp(row: PnpRow): { category: Category; subtype?: string } | undefined {
  const cls = (row.Class ?? '').toLowerCase()
  const bus = row.InstanceId.split('\\')[0]!.toUpperCase()
  if (bus === 'ROOT' || bus === 'SWD' || bus === 'HTREE') return undefined // software/virtual devices
  switch (cls) {
    case 'keyboard':
      return { category: 'hid', subtype: 'keyboard' }
    case 'mouse':
      return { category: 'hid', subtype: 'pointer' }
    case 'hidclass':
      return { category: 'hid', subtype: 'hid' }
    case 'camera':
    case 'image':
      return { category: 'camera', subtype: 'video_capture' }
    case 'bluetooth':
      return { category: 'bluetooth' }
    case 'media':
    case 'audioendpoint':
      return { category: 'audio' }
    case 'monitor':
      return { category: 'display', subtype: 'monitor' }
    case 'ports':
      return { category: 'serial' }
    case 'battery':
      return { category: 'power', subtype: 'battery' }
    case 'diskdrive':
    case 'cdrom':
    case 'scsiadapter':
      return { category: 'storage' }
    case 'net':
      return undefined // covered by windows.network with richer data
    case 'usb':
      return { category: 'usb', subtype: /hub/i.test(row.FriendlyName ?? '') ? 'hub' : 'device' }
  }
  if (bus === 'USB') return { category: 'usb', subtype: 'device' }
  if (bus === 'PCI') return { category: 'pci' }
  return { category: 'other' }
}

/** Win32 ConfigManagerErrorCode / PnP problem code → status. 0 and null mean no problem. */
export function statusForPnp(row: PnpRow): 'ok' | 'error' | 'disabled' | 'unknown' {
  const p = typeof row.Problem === 'string' ? parseInt(row.Problem.replace(/\D/g, ''), 10) : row.Problem
  if (p === 22 || /^CM_PROB_DISABLED$/i.test(String(row.Problem ?? ''))) return 'disabled'
  if (p && p !== 0) return 'error'
  const s = (row.Status ?? '').toLowerCase()
  if (s === 'ok') return 'ok'
  if (s === 'error' || s === 'degraded') return 'error'
  return 'unknown'
}

export const mapBusType = (n: number | string | null | undefined): string | undefined => {
  const t = typeof n === 'string' ? n : ({ 3: 'ATA', 7: 'USB', 8: 'RAID', 10: 'SAS', 11: 'SATA', 17: 'NVMe', 12: 'SD', 13: 'MMC' } as Record<number, string>)[n as number]
  return t || undefined
}
