import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runCollector } from '@collectors/core/collector-runner'
import { asArray, runPsJson } from '@collectors/windows/powershell'
import { categoryForPnp, mapBusType, parsePnpId, statusForPnp } from '@collectors/windows/parsers'
import { observationsFromDisks, observationsFromNetAdapters, observationsFromPnp, observationsFromWindowsSystem, windowsCollectors, windowsPnp, windowsSystem } from '@collectors/windows'
import { cimDate, kelvinTenthsToCelsius, observationsFromWindowsHardware, windowsHardware } from '@collectors/windows/hardware'
import { ctxFor, fixtureHost, ok, tmpRoot } from './helpers/fixtures'

/**
 * These are FIXTURE tests: they validate parsing/normalisation of representative PowerShell/CIM
 * output. They do not prove the collectors work on a real Windows machine (see IMPLEMENTATION_STATUS).
 */
const pnp = JSON.parse(readFileSync('tests/fixtures/windows/pnp.json', 'utf8'))
const win = (run: any) => ctxFor(tmpRoot(), { platform: 'win32', run, host: fixtureHost() })

describe('windows PnP parsing (fixture)', () => {
  const obs = observationsFromPnp(pnp, win(undefined))
  const by = (id: string) => obs.find((o) => o.identifiers.some((i) => i.value.startsWith(id)))!

  it('extracts vendor/product IDs and bus from instance IDs', () => {
    expect(parsePnpId('USB\\VID_046D&PID_C52B\\5&2F3E1C0&0&2')).toEqual({ bus: 'USB', vendorId: '046d', productId: 'c52b' })
    expect(parsePnpId('PCI\\VEN_8086&DEV_A0ED&SUBSYS_0A1F103C&REV_20\\3&1')).toMatchObject({ bus: 'PCI', vendorId: '8086', productId: 'a0ed' })
    expect(parsePnpId('ACPI\\PNP0A08\\0')).toEqual({ bus: 'ACPI', vendorId: undefined, productId: undefined })
  })
  it('skips software-only and network-class devices (network has its own collector)', () => {
    expect(obs.find((o) => o.name === 'Volume Manager')).toBeUndefined()
    expect(obs.find((o) => /Wi-Fi/.test(o.name))).toBeUndefined()
  })
  it('categorises by PnP class and subtype', () => {
    expect(by('HID\\VID_046D')).toMatchObject({ category: 'hid', subtype: 'hid' }) // HIDClass is generic; not assumed to be a keyboard
    expect(categoryForPnp({ InstanceId: 'ACPI\\PNP0303\\0', Class: 'Keyboard' })).toEqual({ category: 'hid', subtype: 'keyboard' })
    expect(by('USB\\VID_04F2')).toMatchObject({ category: 'camera' })
    expect(by('SCSI\\DISK')).toMatchObject({ category: 'storage' })
    expect(by('USB\\ROOT_HUB30')).toMatchObject({ category: 'usb', subtype: 'hub' })
    expect(categoryForPnp({ InstanceId: 'XYZ\\1', Class: 'Mystery' })).toEqual({ category: 'other' })
  })
  it('maps OS problem codes to device status instead of assuming ok', () => {
    expect(by('USB\\VID_04F2')!.status).toBe('error')
    expect(by('USB\\VID_1234')!.status).toBe('disabled')
    expect(by('USB\\VID_046D')!.status).toBe('ok')
    expect(statusForPnp({ InstanceId: 'x', Status: 'Unknown' })).toBe('unknown')
    expect(statusForPnp({ InstanceId: 'x', Problem: 10 })).toBe('error')
  })
  it('keeps parent relationships only when the parent is itself in the inventory', () => {
    const kbd = by('HID\\VID_046D')
    expect(kbd.relationships).toHaveLength(1)
    expect(kbd.relationships[0]).toMatchObject({ type: 'bus_attachment', directness: 'reported', sourceProperty: 'DEVPKEY_Device_Parent' })
    const xhci = by('PCI\\VEN_8086&DEV_A0ED')
    expect(xhci.relationships).toHaveLength(0) // parent ACPI\PNP0A08 is not an inventoried device
    expect(by('SCSI\\DISK').relationships).toHaveLength(0)
  })
  it('does not fabricate names: falls back to the instance id with derived evidence', () => {
    const d = by('USB\\VID_1234')
    expect(d.name).toBe('USB\\VID_1234&PID_0001\\7&0')
    expect(d.fieldSources.name?.evidence).toBe('derived')
    expect(d.manufacturer).toBeUndefined()
  })
})

describe('windows system / network / disk parsing (fixture)', () => {
  it('builds system, motherboard, cpu and memory modules; drops placeholder strings', () => {
    const obs = observationsFromWindowsSystem(
      {
        cs: { Manufacturer: 'LENOVO', Model: '20XW', TotalPhysicalMemory: 17179869184 },
        board: { Manufacturer: 'LENOVO', Product: 'To be filled by O.E.M.', Version: 'SDK0J40697 WIN' },
        os: { Caption: 'Microsoft Windows 11 Pro', Version: '10.0.22631', BuildNumber: '22631', OSArchitecture: '64-bit' },
        cpu: [{ Name: '11th Gen Intel(R) Core(TM) i7-1165G7 ', NumberOfCores: 4, NumberOfLogicalProcessors: 8, MaxClockSpeed: 2800 }],
        mem: [{ DeviceLocator: 'ChannelA-DIMM0', Capacity: '8589934592', Speed: 3200, Manufacturer: 'Samsung', PartNumber: 'M471A1K43DB1-CWE ' }, { DeviceLocator: 'ChannelB-DIMM0', Capacity: 8589934592, Manufacturer: 'Samsung' }]
      },
      win(undefined)
    )
    expect(obs.find((o) => o.category === 'system')).toMatchObject({ name: 'LENOVO 20XW' })
    expect(obs.find((o) => o.category === 'motherboard')!.model).toBeUndefined() // placeholder dropped
    expect(obs.find((o) => o.category === 'cpu')!.name).toBe('11th Gen Intel(R) Core(TM) i7-1165G7')
    expect(obs.filter((o) => o.subtype === 'module')).toHaveLength(2)
    expect(obs.find((o) => o.category === 'memory' && o.subtype === 'module')!.model).toBe('M471A1K43DB1-CWE')
    expect(obs.find((o) => o.key === 'memory:system')!.properties[0]!.value).toBe(17179869184)
  })
  it('maps network adapters and sensitive MAC addresses', () => {
    const [a] = observationsFromNetAdapters([{ Name: 'Wi-Fi', InterfaceDescription: 'Intel AX201', Status: 'Up', MacAddress: 'AA-BB-CC-DD-EE-FF', PhysicalMediaType: 'Native 802.11', InterfaceGuid: '{GUID}' }], win(undefined))
    expect(a).toMatchObject({ key: 'net:{GUID}', subtype: 'wifi', status: 'ok' })
    expect(a!.identifiers.find((i) => i.kind === 'mac_address')?.sensitive).toBe(true)
  })
  it('maps disks and reports health problems as errors', () => {
    const obs = observationsFromDisks([{ FriendlyName: 'Samsung SSD', MediaType: 'SSD', BusType: 17, HealthStatus: 'Warning', Size: 512000000000, SerialNumber: ' S123 ' }], win(undefined))
    expect(obs[0]).toMatchObject({ busType: 'NVMe', status: 'error', subtype: 'ssd' })
    expect(obs[0]!.identifiers[0]).toMatchObject({ kind: 'serial', value: 'S123', sensitive: true })
    expect(mapBusType(99)).toBeUndefined()
  })
})

describe('PowerShell runner semantics', () => {
  it('normalises single objects, arrays and empty output', () => {
    expect(asArray({ a: 1 })).toEqual([{ a: 1 }]); expect(asArray([1, 2])).toEqual([1, 2]); expect(asArray(null)).toEqual([]); expect(asArray('')).toEqual([])
  })
  it('passes a fixed argument vector (no shell string building) and parses JSON', async () => {
    let seen: { file: string; args: readonly string[] } | undefined
    const r = await runPsJson<{ a: number }>(win(async (file: string, args: readonly string[]) => ((seen = { file, args }), ok('{"a":1}'))), 'Get-Thing | ConvertTo-Json', 1000)
    expect(r).toEqual({ ok: true, data: [{ a: 1 }] })
    expect(seen!.file).toBe('powershell.exe')
    expect(seen!.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
  })
  it.each([
    ['missing powershell', { ...ok(''), ok: false, notFound: true }, 'missing_tool'],
    ['timeout', { ...ok(''), ok: false, timedOut: true }, 'timeout'],
    ['non-zero exit', { ...ok(''), ok: false, code: 1, stderr: 'Access denied' }, 'error'],
    ['malformed output', ok('<<not json>>'), 'malformed']
  ] as const)('reports %s as a failure, never as an empty result', async (_n, res, kind) => {
    const r = await runPsJson(win(async () => res as never), 'x', 1000)
    expect(r).toMatchObject({ ok: false, kind })
  })
  it('collector surfaces PowerShell failure as unavailable with a limitation, not an empty inventory', async () => {
    const o = await runCollector(windowsPnp, win(async () => ({ ...ok(''), ok: false, notFound: true })))
    expect(o.status).toBe('unavailable')
    expect(o.limitations[0]!.kind).toBe('missing_tool')
    expect(o.result!.observations).toHaveLength(0)
  })
  it('end-to-end through the runner with fixture output', async () => {
    const o = await runCollector(windowsPnp, win(async () => ok(JSON.stringify(pnp))))
    expect(o.status).toBe('available')
    expect(o.result!.observations.length).toBeGreaterThan(5)
  })
  it('windows collectors are unsupported on Linux', async () => {
    for (const c of windowsCollectors) expect((await runCollector(c, ctxFor(tmpRoot()))).status).toBe('unsupported')
    void windowsSystem
  })
})

describe('windows hardware depth (fixture only — never run on Windows)', () => {
  const data = {
    cpu: [{ L2CacheSize: 5120, L3CacheSize: 12288, CurrentClockSpeed: 2800, VirtualizationFirmwareEnabled: true, Family: 198 }],
    memarr: [{ MemoryErrorCorrection: 3, MaxCapacity: 67108864, MemoryDevices: 2 }],
    gpu: [{ Name: 'Intel(R) Iris(R) Xe Graphics', AdapterCompatibility: 'Intel Corporation', DriverVersion: '31.0.101.4502', DriverDate: '20231115000000.000000-000', PNPDeviceID: 'PCI\\VEN_8086&DEV_9A49\\3&11583659&0&10', AdapterRAM: 4294967295, CurrentHorizontalResolution: 1920, CurrentVerticalResolution: 1080, CurrentRefreshRate: 60, Status: 'OK' }],
    bat: [{ DeviceID: 'BAT0', Name: 'DELL 123', EstimatedChargeRemaining: 88, BatteryStatus: 6, DesignCapacity: 0 }]
  }
  const obs = observationsFromWindowsHardware(data, [{ InstanceName: 'ACPI\\ThermalZone\\TZ00_0', CurrentTemperature: 3232, CriticalTripPoint: 3732 }, { CurrentTemperature: 0 }], win(undefined))
  it('maps fields with explicit meaning and caveats', () => {
    const p = (o: any, k: string) => o.properties.find((x: any) => x.key === k)
    const cpu = obs.find((o) => o.key === 'cpu:package:0')!
    expect(p(cpu, 'l3_cache_total')).toMatchObject({ value: 12288, unit: 'KB' })
    expect(p(cpu, 'virtualization_firmware_enabled').value).toBe(true)
    expect(p(obs.find((o) => o.key === 'memory:system')!, 'ecc_type').value).toBe('none')
    expect(p(obs.find((o) => o.key === 'memory:system')!, 'max_capacity_bytes').value).toBe(67108864 * 1024)
    const gpu = obs.find((o) => o.key.startsWith('gpu:win:'))!
    expect(p(gpu, 'adapter_ram_reported')).toBeUndefined() // saturated 32-bit field is not VRAM
    expect(p(gpu, 'driver_date').value).toBe('2023-11-15')
    expect(p(gpu, 'current_mode').value).toBe('1920×1080 @ 60 Hz')
    const bat = obs.find((o) => o.category === 'power')!
    expect(p(bat, 'battery_status').value).toBe('charging')
    expect(p(bat, 'design_capacity')).toBeUndefined() // 0 = not provided
  })
  it('converts ACPI thermal zones and drops invalid readings', () => {
    expect(kelvinTenthsToCelsius(3232)).toBe(50.1)
    expect(kelvinTenthsToCelsius(0)).toBeUndefined()
    expect(kelvinTenthsToCelsius(Number.NaN)).toBeUndefined()
    const zones = obs.filter((o) => o.category === 'sensor')
    expect(zones).toHaveLength(1)
    expect(zones[0]!.properties.find((x) => x.key === 'temperature:ACPI zone')?.evidence).toBe('derived')
    expect(cimDate('garbage')).toBeUndefined()
  })
  it('degrades gracefully: thermal failure is a permission limitation, main failure is unavailable', async () => {
    const run = async (_cmd: string, args: string[]) => (args[3]!.includes('MSAcpi') ? { ...ok(''), ok: false, code: 1, stderr: 'Access denied' } : ok(JSON.stringify(data)))
    const o = await runCollector(windowsHardware, win(run))
    expect(o.limitations.some((l) => l.kind === 'permission')).toBe(true)
    expect(o.result!.observations.some((x) => x.key === 'cpu:package:0')).toBe(true)
    const bad = await runCollector(windowsHardware, win(async () => ({ ...ok(''), ok: false, notFound: true })))
    expect(bad.status).not.toBe('available')
  })
})
