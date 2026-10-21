import type { DeviceObservation, Limitation } from '@shared/schemas'
import { meaningful, ObservationBuilder, type CollectContext } from '../core/context'
import type { Collector } from '../core/types'
import { runPsJson } from './powershell'
import { windowsHardware } from './hardware'
import { categoryForPnp, mapBusType, parsePnpId, statusForPnp, type PnpRow } from './parsers'

/**
 * Windows collectors. STATUS: implemented against documented CIM/PnP cmdlet output and covered by
 * fixture parser tests only. They have NOT been executed on a real Windows machine. Parent/child
 * relationships come from DEVPKEY_Device_Parent; a SetupAPI/CfgMgr32 native helper is the planned
 * replacement for authoritative hierarchy and for device arrival/removal notifications.
 */

const fail = (kind: 'missing_tool' | 'timeout' | 'error' | 'malformed', message: string) => ({
  outcome: 'unavailable' as const,
  observations: [] as DeviceObservation[],
  limitations: [{ kind: kind === 'error' ? ('missing_interface' as const) : kind, message } satisfies Limitation]
})

const SYSTEM_SCRIPT =
  "[pscustomobject]@{cs=(Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model,SystemType,TotalPhysicalMemory);" +
  "bios=(Get-CimInstance Win32_BIOS | Select-Object Manufacturer,SMBIOSBIOSVersion,ReleaseDate);" +
  "board=(Get-CimInstance Win32_BaseBoard | Select-Object Manufacturer,Product,Version);" +
  "os=(Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture,LastBootUpTime);" +
  "cpu=@(Get-CimInstance Win32_Processor | Select-Object Name,Manufacturer,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed,SocketDesignation);" +
  "mem=@(Get-CimInstance Win32_PhysicalMemory | Select-Object BankLabel,DeviceLocator,Capacity,Speed,ConfiguredClockSpeed,Manufacturer,PartNumber,SMBIOSMemoryType)} | ConvertTo-Json -Depth 4 -Compress"

export interface WinSystemData {
  cs?: { Manufacturer?: string; Model?: string; SystemType?: string; TotalPhysicalMemory?: number }
  bios?: { Manufacturer?: string; SMBIOSBIOSVersion?: string; ReleaseDate?: string }
  board?: { Manufacturer?: string; Product?: string; Version?: string }
  os?: { Caption?: string; Version?: string; BuildNumber?: string; OSArchitecture?: string }
  cpu?: { Name?: string; Manufacturer?: string; NumberOfCores?: number; NumberOfLogicalProcessors?: number; MaxClockSpeed?: number; SocketDesignation?: string }[]
  mem?: { BankLabel?: string; DeviceLocator?: string; Capacity?: string | number; Speed?: number; ConfiguredClockSpeed?: number; Manufacturer?: string; PartNumber?: string }[]
}

const arr = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])

export function observationsFromWindowsSystem(d: WinSystemData, ctx: CollectContext): DeviceObservation[] {
  const ID = 'windows.system'
  const at = ctx.host.now()
  const out: DeviceObservation[] = []
  const vendor = meaningful(d.cs?.Manufacturer)
  const model = meaningful(d.cs?.Model)
  out.push(
    new ObservationBuilder(ID, 'system:host', 'system', [vendor, model].filter(Boolean).join(' ') || ctx.host.hostname, at, { sourceProperty: 'Win32_ComputerSystem Manufacturer+Model' })
      .status('ok')
      .field('manufacturer', vendor, 'Win32_ComputerSystem.Manufacturer')
      .field('model', model, 'Win32_ComputerSystem.Model')
      .prop('hostname', ctx.host.hostname, 'os.hostname()', { sensitive: true })
      .prop('os_name', d.os?.Caption, 'Win32_OperatingSystem.Caption')
      .prop('os_version', d.os?.Version, 'Win32_OperatingSystem.Version')
      .prop('os_build', d.os?.BuildNumber, 'Win32_OperatingSystem.BuildNumber')
      .prop('architecture', d.os?.OSArchitecture ?? d.cs?.SystemType, 'Win32_OperatingSystem.OSArchitecture')
      .build()
  )
  if (d.board) {
    out.push(
      new ObservationBuilder(ID, 'motherboard:main', 'motherboard', [meaningful(d.board.Manufacturer), meaningful(d.board.Product)].filter(Boolean).join(' ') || 'Motherboard (model not exposed)', at, { sourceProperty: 'Win32_BaseBoard' })
        .status('ok')
        .field('manufacturer', meaningful(d.board.Manufacturer), 'Win32_BaseBoard.Manufacturer')
        .field('model', meaningful(d.board.Product), 'Win32_BaseBoard.Product')
        .prop('board_version', meaningful(d.board.Version), 'Win32_BaseBoard.Version')
        .prop('bios_vendor', meaningful(d.bios?.Manufacturer), 'Win32_BIOS.Manufacturer')
        .prop('bios_version', meaningful(d.bios?.SMBIOSBIOSVersion), 'Win32_BIOS.SMBIOSBIOSVersion')
        .build()
    )
  }
  arr(d.cpu).forEach((c, i) =>
    out.push(
      new ObservationBuilder(ID, `cpu:package:${i}`, 'cpu', c.Name?.trim() || 'Unknown processor', at, { sourceProperty: 'Win32_Processor.Name' })
        .status('ok')
        .field('manufacturer', c.Manufacturer, 'Win32_Processor.Manufacturer')
        .field('model', c.Name?.trim(), 'Win32_Processor.Name')
        .prop('physical_cores', c.NumberOfCores, 'Win32_Processor.NumberOfCores')
        .prop('logical_processors', c.NumberOfLogicalProcessors, 'Win32_Processor.NumberOfLogicalProcessors')
        .prop('max_frequency', c.MaxClockSpeed, 'Win32_Processor.MaxClockSpeed', { unit: 'MHz' })
        .prop('socket', c.SocketDesignation, 'Win32_Processor.SocketDesignation')
        .build()
    )
  )
  if (d.cs?.TotalPhysicalMemory) {
    out.push(
      new ObservationBuilder(ID, 'memory:system', 'memory', 'System memory', at, { sourceProperty: 'derived', evidence: 'derived' })
        .status('ok')
        .field('subtype', 'total', 'derived', 'derived')
        .prop('total_bytes', Number(d.cs.TotalPhysicalMemory), 'Win32_ComputerSystem.TotalPhysicalMemory', { unit: 'B', evidence: 'measured' })
        .build()
    )
  }
  arr(d.mem).forEach((m, i) => {
    const cap = Number(m.Capacity)
    out.push(
      new ObservationBuilder(ID, `memory:module:${m.DeviceLocator ?? i}`, 'memory', [meaningful(m.Manufacturer), Number.isFinite(cap) ? `${Math.round(cap / 2 ** 30)} GB` : undefined].filter(Boolean).join(' ') || `Memory module ${i}`, at, { sourceProperty: 'Win32_PhysicalMemory' })
        .status('ok')
        .field('subtype', 'module', 'derived', 'derived')
        .field('manufacturer', meaningful(m.Manufacturer), 'Win32_PhysicalMemory.Manufacturer')
        .field('model', meaningful(m.PartNumber?.trim()), 'Win32_PhysicalMemory.PartNumber')
        .prop('size_bytes', Number.isFinite(cap) ? cap : undefined, 'Win32_PhysicalMemory.Capacity', { unit: 'B' })
        .prop('speed', m.Speed, 'Win32_PhysicalMemory.Speed', { unit: 'MT/s' })
        .prop('configured_speed', m.ConfiguredClockSpeed, 'Win32_PhysicalMemory.ConfiguredClockSpeed', { unit: 'MT/s' })
        .prop('locator', m.DeviceLocator, 'Win32_PhysicalMemory.DeviceLocator')
        .rel('memory:system', 'logical_parent', 'Win32_PhysicalMemory', { directness: 'inferred', confidence: 0.9 })
        .build()
    )
  })
  return out
}

export const windowsSystem: Collector = {
  id: 'windows.system',
  version: '0.1.0',
  platforms: ['win32'],
  categories: ['system', 'motherboard', 'cpu', 'memory'],
  permissions: [],
  method: 'PowerShell Get-CimInstance (Win32_ComputerSystem, BIOS, BaseBoard, Processor, PhysicalMemory)',
  timeoutMs: 30000,
  retries: 1,
  isSupported: async (ctx) => ctx.platform === 'win32',
  async collect(ctx) {
    const r = await runPsJson<{ cs: WinSystemData['cs']; bios: WinSystemData['bios']; board: WinSystemData['board']; os: WinSystemData['os']; cpu: WinSystemData['cpu']; mem: WinSystemData['mem'] }>(ctx, SYSTEM_SCRIPT, 25000)
    if (!r.ok) return fail(r.kind, r.message)
    const obs = observationsFromWindowsSystem((r.data[0] ?? {}) as WinSystemData, ctx)
    return { outcome: 'complete' as const, observations: obs, limitations: [] }
  }
}

const PNP_SCRIPT =
  "Get-PnpDevice -PresentOnly | ForEach-Object { $p = $null; try { $p = (Get-PnpDeviceProperty -InstanceId $_.InstanceId -KeyName 'DEVPKEY_Device_Parent' -ErrorAction Stop).Data } catch {}; " +
  "[pscustomobject]@{InstanceId=$_.InstanceId;FriendlyName=$_.FriendlyName;Class=$_.Class;Manufacturer=$_.Manufacturer;Status=$_.Status;Problem=[string]$_.Problem;Service=$_.Service;Parent=$p} } | ConvertTo-Json -Depth 3 -Compress"

export function observationsFromPnp(rows: PnpRow[], ctx: CollectContext): DeviceObservation[] {
  const ID = 'windows.pnp'
  const at = ctx.host.now()
  const out: DeviceObservation[] = []
  const keyFor = (id: string): string => `win:pnp:${id.toLowerCase()}`
  const known = new Set<string>()
  const mapped = rows.map((row) => ({ row, cat: categoryForPnp(row) })).filter((x) => x.cat)
  for (const { row } of mapped) known.add(row.InstanceId.toLowerCase())
  for (const { row, cat } of mapped) {
    if (!row.InstanceId) continue
    const ids = parsePnpId(row.InstanceId)
    const b = new ObservationBuilder(ID, keyFor(row.InstanceId), cat!.category, row.FriendlyName || row.InstanceId, at, {
      sourceProperty: row.FriendlyName ? 'Get-PnpDevice.FriendlyName' : 'Get-PnpDevice.InstanceId',
      evidence: row.FriendlyName ? 'os_reported' : 'derived'
    })
      .status(statusForPnp(row))
      .field('subtype', cat!.subtype, 'PnP class', 'derived')
      .field('manufacturer', meaningful(row.Manufacturer), 'Get-PnpDevice.Manufacturer')
      .field('vendorId', ids.vendorId, 'InstanceId VID/VEN')
      .field('productId', ids.productId, 'InstanceId PID/DEV')
      .field('busType', ids.bus, 'InstanceId bus prefix', 'derived')
      .field('deviceClass', row.Class ?? undefined, 'Get-PnpDevice.Class')
      .field('driver', row.Service ?? undefined, 'Get-PnpDevice.Service')
      .id('instance_id', row.InstanceId)
      .prop('problem_code', row.Problem === null || row.Problem === undefined ? undefined : String(row.Problem), 'Get-PnpDevice.Problem')
      .prop('pnp_status', row.Status ?? undefined, 'Get-PnpDevice.Status')
    if (row.Parent && known.has(row.Parent.toLowerCase())) b.rel(keyFor(row.Parent), 'bus_attachment', 'DEVPKEY_Device_Parent')
    out.push(b.build())
  }
  return out
}

export const windowsPnp: Collector = {
  id: 'windows.pnp',
  version: '0.1.0',
  platforms: ['win32'],
  categories: ['pci', 'usb', 'hid', 'camera', 'bluetooth', 'audio', 'display', 'serial', 'power', 'storage', 'other'],
  permissions: [],
  method: 'PowerShell Get-PnpDevice + DEVPKEY_Device_Parent',
  timeoutMs: 120000,
  retries: 0,
  isSupported: async (ctx) => ctx.platform === 'win32',
  async collect(ctx) {
    const r = await runPsJson<PnpRow>(ctx, PNP_SCRIPT, 110000)
    if (!r.ok) return fail(r.kind, r.message)
    return { outcome: 'complete' as const, observations: observationsFromPnp(r.data, ctx), limitations: [{ kind: 'info' as const, message: 'Hierarchy comes from DEVPKEY_Device_Parent. Arrival/removal is detected by polling until the native notification helper exists.' }] }
  }
}

const NET_SCRIPT =
  "Get-NetAdapter -Physical | Select-Object Name,InterfaceDescription,Status,MacAddress,LinkSpeed,MediaType,PhysicalMediaType,DriverFileName,InterfaceGuid,ifIndex | ConvertTo-Json -Depth 3 -Compress"

export interface NetAdapterRow {
  Name: string
  InterfaceDescription?: string
  Status?: string
  MacAddress?: string
  LinkSpeed?: string
  PhysicalMediaType?: string
  DriverFileName?: string
  InterfaceGuid?: string
}

export function observationsFromNetAdapters(rows: NetAdapterRow[], ctx: CollectContext): DeviceObservation[] {
  const ID = 'windows.network'
  const at = ctx.host.now()
  return rows.map((a) =>
    new ObservationBuilder(ID, `net:${a.InterfaceGuid ?? a.Name}`, 'network', a.Name, at, { sourceProperty: 'Get-NetAdapter.Name' })
      .status(a.Status === 'Up' ? 'ok' : a.Status === 'Disabled' ? 'disabled' : 'unknown')
      .field('model', a.InterfaceDescription, 'Get-NetAdapter.InterfaceDescription')
      .field('subtype', /802\.11|wireless|native/i.test(a.PhysicalMediaType ?? '') ? 'wifi' : /802\.3|ethernet/i.test(a.PhysicalMediaType ?? '') ? 'ethernet' : 'other', 'Get-NetAdapter.PhysicalMediaType', 'derived')
      .field('driver', a.DriverFileName, 'Get-NetAdapter.DriverFileName')
      .id('interface_name', a.Name)
      .id('mac_address', a.MacAddress, true)
      .prop('operstate', a.Status, 'Get-NetAdapter.Status', { volatile: true })
      .prop('link_speed_text', a.LinkSpeed, 'Get-NetAdapter.LinkSpeed', { volatile: true })
      .build()
  )
}

export const windowsNetwork: Collector = {
  id: 'windows.network',
  version: '0.1.0',
  platforms: ['win32'],
  categories: ['network'],
  permissions: [],
  method: 'PowerShell Get-NetAdapter -Physical',
  timeoutMs: 20000,
  retries: 1,
  isSupported: async (ctx) => ctx.platform === 'win32',
  async collect(ctx) {
    const r = await runPsJson<NetAdapterRow>(ctx, NET_SCRIPT, 15000)
    if (!r.ok) return fail(r.kind, r.message)
    return { outcome: 'complete' as const, observations: observationsFromNetAdapters(r.data, ctx), limitations: [] }
  }
}

const DISK_SCRIPT =
  "Get-PhysicalDisk | Select-Object FriendlyName,MediaType,BusType,HealthStatus,OperationalStatus,Size,SerialNumber,FirmwareVersion,DeviceId | ConvertTo-Json -Depth 3 -Compress"

export interface PhysicalDiskRow {
  FriendlyName?: string
  MediaType?: string
  BusType?: number | string
  HealthStatus?: string
  OperationalStatus?: string
  Size?: number
  SerialNumber?: string
  FirmwareVersion?: string
  DeviceId?: string
}

export function observationsFromDisks(rows: PhysicalDiskRow[], ctx: CollectContext): DeviceObservation[] {
  const ID = 'windows.storage'
  const at = ctx.host.now()
  return rows.map((d) => {
    const serial = meaningful(d.SerialNumber?.trim())
    const key = serial && d.FriendlyName ? `storage:sn:${d.FriendlyName}:${serial}` : `storage:dev:win${d.DeviceId ?? d.FriendlyName}`
    return new ObservationBuilder(ID, key, 'storage', d.FriendlyName ?? `Disk ${d.DeviceId}`, at, { sourceProperty: 'Get-PhysicalDisk.FriendlyName' })
      .status(d.HealthStatus === 'Healthy' ? 'ok' : d.HealthStatus ? 'error' : 'unknown')
      .field('model', d.FriendlyName, 'Get-PhysicalDisk.FriendlyName')
      .field('busType', mapBusType(d.BusType), 'Get-PhysicalDisk.BusType')
      .field('subtype', d.MediaType?.toLowerCase(), 'Get-PhysicalDisk.MediaType')
      .id('serial', serial, true)
      .prop('size_bytes', d.Size, 'Get-PhysicalDisk.Size', { unit: 'B' })
      .prop('firmware', d.FirmwareVersion, 'Get-PhysicalDisk.FirmwareVersion')
      .prop('health_status', d.HealthStatus, 'Get-PhysicalDisk.HealthStatus', { volatile: true })
      .prop('operational_status', d.OperationalStatus, 'Get-PhysicalDisk.OperationalStatus', { volatile: true })
      .build()
  })
}

export const windowsStorage: Collector = {
  id: 'windows.storage',
  version: '0.1.0',
  platforms: ['win32'],
  categories: ['storage'],
  permissions: ['Get-PhysicalDisk may require Administrator for full health details'],
  method: 'PowerShell Get-PhysicalDisk',
  timeoutMs: 20000,
  retries: 1,
  isSupported: async (ctx) => ctx.platform === 'win32',
  async collect(ctx) {
    const r = await runPsJson<PhysicalDiskRow>(ctx, DISK_SCRIPT, 15000)
    if (!r.ok) return fail(r.kind, r.message)
    return { outcome: 'complete' as const, observations: observationsFromDisks(r.data, ctx), limitations: [{ kind: 'info' as const, message: 'Partitions/volumes and SMART attributes are not yet collected on Windows.' }] }
  }
}

export const windowsCollectors: Collector[] = [windowsSystem, windowsPnp, windowsNetwork, windowsStorage, windowsHardware]
