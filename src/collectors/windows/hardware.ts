import type { DeviceObservation, Limitation } from '@shared/schemas'
import { meaningful, ObservationBuilder, type CollectContext } from '../core/context'
import type { Collector } from '../core/types'
import { runPsJson } from './powershell'

/**
 * Windows hardware depth: CPU cache/virtualisation, memory ECC and slot capacity, GPUs, batteries and ACPI
 * thermal zones. STATUS: fixture-tested parsers only — never run on a real Windows machine. Several fields
 * differ in meaning from their Linux counterparts and are labelled accordingly (see docs/COLLECTORS.md).
 */
const ID = 'windows.hardware'

const HW_SCRIPT =
  "[pscustomobject]@{cpu=@(Get-CimInstance Win32_Processor | Select-Object ProcessorId,Family,Revision,L2CacheSize,L3CacheSize,CurrentClockSpeed,VirtualizationFirmwareEnabled,SecondLevelAddressTranslationExtensions);" +
  "memarr=@(Get-CimInstance Win32_PhysicalMemoryArray | Select-Object MemoryErrorCorrection,MaxCapacity,MemoryDevices);" +
  "gpu=@(Get-CimInstance Win32_VideoController | Select-Object Name,AdapterCompatibility,DriverVersion,DriverDate,PNPDeviceID,AdapterRAM,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate,Status);" +
  "bat=@(Get-CimInstance Win32_Battery | Select-Object DeviceID,Name,EstimatedChargeRemaining,BatteryStatus,DesignCapacity,Chemistry)} | ConvertTo-Json -Depth 4 -Compress"
/** root/wmi thermal zones normally need Administrator, so they are queried separately and may legitimately fail. */
const THERMAL_SCRIPT = "Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | Select-Object InstanceName,CurrentTemperature,CriticalTripPoint | ConvertTo-Json -Depth 3 -Compress"

export interface WinHardwareData {
  cpu?: { ProcessorId?: string; Family?: number; Revision?: number; L2CacheSize?: number; L3CacheSize?: number; CurrentClockSpeed?: number; VirtualizationFirmwareEnabled?: boolean; SecondLevelAddressTranslationExtensions?: boolean }[]
  memarr?: { MemoryErrorCorrection?: number; MaxCapacity?: number; MemoryDevices?: number }[]
  gpu?: { Name?: string; AdapterCompatibility?: string; DriverVersion?: string; DriverDate?: string; PNPDeviceID?: string; AdapterRAM?: number; CurrentHorizontalResolution?: number; CurrentVerticalResolution?: number; CurrentRefreshRate?: number; Status?: string }[]
  bat?: { DeviceID?: string; Name?: string; EstimatedChargeRemaining?: number; BatteryStatus?: number; DesignCapacity?: number; Chemistry?: number }[]
}
export interface WinThermalRow { InstanceName?: string; CurrentTemperature?: number; CriticalTripPoint?: number }

const arr = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])

/** Win32_PhysicalMemoryArray.MemoryErrorCorrection codes. "Unknown" stays unknown; it is not "no ECC". */
export const ECC_TYPES: Record<number, string> = { 1: 'other', 2: 'unknown', 3: 'none', 4: 'parity', 5: 'single-bit ECC', 6: 'multi-bit ECC', 7: 'CRC' }
export const BATTERY_STATUS: Record<number, string> = { 1: 'discharging', 2: 'on AC', 3: 'fully charged', 4: 'low', 5: 'critical', 6: 'charging', 7: 'charging and high', 8: 'charging and low', 9: 'charging and critical', 10: 'undefined', 11: 'partially charged' }

/** MSAcpi_ThermalZoneTemperature reports tenths of kelvin. Values outside a physical range are treated as invalid. */
export function kelvinTenthsToCelsius(v: number | undefined): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined
  const c = v / 10 - 273.15
  return c > -50 && c < 200 ? Math.round(c * 10) / 10 : undefined
}

/** CIM_DATETIME `20240315000000.000000-000` or an ISO string → ISO date. */
export function cimDate(v: string | undefined): string | undefined {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(v ?? '')
  return m ? `${m[1]}-${m[2]}-${m[3]}` : v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString().slice(0, 10) : undefined
}

export function observationsFromWindowsHardware(d: WinHardwareData, thermal: WinThermalRow[], ctx: CollectContext): DeviceObservation[] {
  const at = ctx.host.now()
  const out: DeviceObservation[] = []
  // Keys equal those of windows.system so the properties merge onto the same inventory records.
  arr(d.cpu).forEach((c, i) =>
    out.push(
      new ObservationBuilder(ID, `cpu:package:${i}`, 'cpu', 'Processor', at, { sourceProperty: 'Win32_Processor' })
        .status('ok')
        .prop('l2_cache_total', c.L2CacheSize, 'Win32_Processor.L2CacheSize', { unit: 'KB' })
        .prop('l3_cache_total', c.L3CacheSize, 'Win32_Processor.L3CacheSize', { unit: 'KB' })
        .prop('current_frequency', c.CurrentClockSpeed, 'Win32_Processor.CurrentClockSpeed', { unit: 'MHz', volatile: true })
        .prop('family', c.Family, 'Win32_Processor.Family')
        .prop('revision', c.Revision, 'Win32_Processor.Revision')
        .prop('processor_id', c.ProcessorId, 'Win32_Processor.ProcessorId')
        // Firmware switch state, not proof that a hypervisor is usable; Windows may also hide it when Hyper-V is active.
        .prop('virtualization_firmware_enabled', c.VirtualizationFirmwareEnabled, 'Win32_Processor.VirtualizationFirmwareEnabled')
        .prop('slat_supported', c.SecondLevelAddressTranslationExtensions, 'Win32_Processor.SecondLevelAddressTranslationExtensions')
        .build()
    )
  )
  const arrMem = arr(d.memarr)[0]
  if (arrMem) {
    const ecc = arrMem.MemoryErrorCorrection === undefined ? undefined : (ECC_TYPES[arrMem.MemoryErrorCorrection] ?? `code ${arrMem.MemoryErrorCorrection}`)
    out.push(
      new ObservationBuilder(ID, 'memory:system', 'memory', 'System memory', at, { sourceProperty: 'Win32_PhysicalMemoryArray' })
        .status('ok')
        .prop('ecc_type', ecc, 'Win32_PhysicalMemoryArray.MemoryErrorCorrection')
        .prop('max_capacity_bytes', typeof arrMem.MaxCapacity === 'number' ? arrMem.MaxCapacity * 1024 : undefined, 'Win32_PhysicalMemoryArray.MaxCapacity (KB × 1024)', { unit: 'B', evidence: 'derived' })
        .prop('slot_count', arrMem.MemoryDevices, 'Win32_PhysicalMemoryArray.MemoryDevices')
        .build()
    )
  }
  for (const g of arr(d.gpu)) {
    const id = g.PNPDeviceID
    if (!id) continue
    const b = new ObservationBuilder(ID, `gpu:win:${id.toLowerCase()}`, 'display', meaningful(g.Name) ?? 'Display adapter', at, { sourceProperty: 'Win32_VideoController.Name' })
      .status(g.Status === 'OK' ? 'ok' : g.Status === 'Error' ? 'error' : 'unknown')
      .field('subtype', 'gpu', 'Win32_VideoController', 'derived')
      .field('manufacturer', meaningful(g.AdapterCompatibility), 'Win32_VideoController.AdapterCompatibility')
      .field('driver', g.DriverVersion ? `driver ${g.DriverVersion}` : undefined, 'Win32_VideoController.DriverVersion')
      .id('instance_id', id)
      .prop('driver_version', g.DriverVersion, 'Win32_VideoController.DriverVersion')
      .prop('driver_date', cimDate(g.DriverDate), 'Win32_VideoController.DriverDate')
      // AdapterRAM is a 32-bit field: it saturates near 4 GiB, so it is not shown as dedicated video memory.
      .prop('adapter_ram_reported', typeof g.AdapterRAM === 'number' && g.AdapterRAM > 0 && g.AdapterRAM < 0xfffffff0 ? g.AdapterRAM : undefined, 'Win32_VideoController.AdapterRAM', { unit: 'B' })
      .prop('current_mode', g.CurrentHorizontalResolution && g.CurrentVerticalResolution ? `${g.CurrentHorizontalResolution}×${g.CurrentVerticalResolution}${g.CurrentRefreshRate ? ` @ ${g.CurrentRefreshRate} Hz` : ''}` : undefined, 'Win32_VideoController.Current*', { volatile: true })
    out.push(b.build())
  }
  for (const bat of arr(d.bat)) {
    out.push(
      new ObservationBuilder(ID, `power:win:battery:${bat.DeviceID ?? 'main'}`, 'power', meaningful(bat.Name) ?? 'Battery', at, { sourceProperty: 'Win32_Battery.Name' })
        .status('ok')
        .field('subtype', 'battery', 'Win32_Battery', 'derived')
        .prop('charge_percent', bat.EstimatedChargeRemaining, 'Win32_Battery.EstimatedChargeRemaining', { unit: '%', volatile: true, evidence: 'os_reported' })
        .prop('battery_status', bat.BatteryStatus === undefined ? undefined : (BATTERY_STATUS[bat.BatteryStatus] ?? `code ${bat.BatteryStatus}`), 'Win32_Battery.BatteryStatus', { volatile: true })
        // Many firmwares report 0 here, which means "not provided", not a dead battery.
        .prop('design_capacity', bat.DesignCapacity && bat.DesignCapacity > 0 ? bat.DesignCapacity : undefined, 'Win32_Battery.DesignCapacity', { unit: 'mWh' })
        .build()
    )
  }
  thermal.forEach((z, i) => {
    const c = kelvinTenthsToCelsius(z.CurrentTemperature)
    if (c === undefined) return
    const crit = kelvinTenthsToCelsius(z.CriticalTripPoint)
    out.push(
      new ObservationBuilder(ID, `sensor:win:thermalzone:${z.InstanceName ?? i}`, 'sensor', `ACPI thermal zone ${i}`, at, { sourceProperty: 'MSAcpi_ThermalZoneTemperature' })
        .status('ok')
        .field('subtype', 'thermal_zone', 'MSAcpi_ThermalZoneTemperature', 'derived')
        // An ACPI zone is a firmware-defined region; it is NOT the CPU die temperature.
        .prop('temperature:ACPI zone', c, 'MSAcpi_ThermalZoneTemperature.CurrentTemperature (tenths K → °C)', { unit: '°C', volatile: true, evidence: 'derived' })
        .prop('temperature_crit:ACPI zone', crit, 'MSAcpi_ThermalZoneTemperature.CriticalTripPoint', { unit: '°C', evidence: 'derived' })
        .build()
    )
  })
  return out
}

export const windowsHardware: Collector = {
  id: ID,
  version: '0.1.0',
  platforms: ['win32'],
  categories: ['cpu', 'memory', 'display', 'power', 'sensor'],
  permissions: ['ACPI thermal zones (root/wmi) normally require Administrator'],
  method: 'PowerShell Get-CimInstance (Win32_Processor, PhysicalMemoryArray, VideoController, Battery; root/wmi MSAcpi_ThermalZoneTemperature)',
  timeoutMs: 40000,
  retries: 1,
  isSupported: async (ctx) => ctx.platform === 'win32',
  async collect(ctx: CollectContext) {
    const main = await runPsJson<WinHardwareData>(ctx, HW_SCRIPT, 25000)
    if (!main.ok) return { outcome: 'unavailable' as const, observations: [] as DeviceObservation[], limitations: [{ kind: main.kind === 'error' ? ('missing_interface' as const) : main.kind, message: main.message } satisfies Limitation] }
    const limitations: Limitation[] = [{ kind: 'info', message: 'Windows exposes different details than Linux: no per-core frequency, cache topology or NUMA data from this collector, and GPU memory is not reported because Win32_VideoController.AdapterRAM saturates at 4 GiB.' }]
    const th = await runPsJson<WinThermalRow>(ctx, THERMAL_SCRIPT, 10000)
    let thermal: WinThermalRow[] = []
    if (th.ok) thermal = th.data
    else limitations.push({ kind: 'permission', message: `ACPI thermal zones are unavailable (${th.message}). They usually need Administrator and many machines expose none.` })
    return { outcome: 'complete' as const, observations: observationsFromWindowsHardware((main.data[0] ?? {}) as WinHardwareData, thermal, ctx), limitations }
  }
}
