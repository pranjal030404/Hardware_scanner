import { chmodSync } from 'node:fs'
import { describe, expect, it, beforeAll } from 'vitest'
import { runCollector } from '@collectors/core/collector-runner'
import { parseIds } from '@collectors/core/ids'
import { linuxCollectors } from '@collectors/linux'
import { setIdDatabasesForTest } from '@collectors/linux/shared'
import { parseSmartctl } from '@collectors/linux/smart'
import { parseMounts } from '@collectors/linux/storage'
import { describeEndpoint } from '@collectors/linux/usb'
import { parseLinkSpeed, validLinkWidth } from '@collectors/linux/pci'
import { parseEdid } from '@collectors/core/edid'
import { ctxFor, laptopTree, makeEdid, ok, PCI_IDS, tmpRoot, USB_IDS, writeTree } from './helpers/fixtures'
import type { Collector } from '@collectors/core/types'

const get = (id: string): Collector => linuxCollectors.find((c) => c.id === id)!

let root: string
beforeAll(() => {
  root = tmpRoot()
  writeTree(root, laptopTree())
  setIdDatabasesForTest(parseIds(PCI_IDS), parseIds(USB_IDS))
})

const run = async (id: string, r = root, over = {}) => {
  const o = await runCollector(get(id), ctxFor(r, over))
  return o
}

describe('linux.system', () => {
  it('reads DMI, drops OEM placeholder strings and never invents values', async () => {
    const o = await run('linux.system')
    expect(o.status).toBe('available')
    const sys = o.result!.observations.find((d) => d.category === 'system')!
    expect(sys.name).toBe('HP EliteBook 840 G8') // vendor not repeated
    expect(sys.properties.find((p) => p.key === 'product_family')).toBeUndefined() // "To Be Filled By O.E.M."
    expect(sys.properties.find((p) => p.key === 'kernel')?.value).toBe('6.8.0-test')
    const board = o.result!.observations.find((d) => d.category === 'motherboard')!
    expect(board.model).toBe('880D')
    expect(board.properties.find((p) => p.key === 'boot_mode')?.value).toBe('UEFI')
    expect(board.fieldSources.model?.sourceProperty).toContain('board_name')
  })
  it('does not emit a motherboard when DMI exposes nothing', async () => {
    const r = tmpRoot()
    writeTree(r, { '/proc/version': 'x', '/proc/uptime': '1 1' })
    const o = await run('linux.system', r)
    expect(o.result!.observations.map((d) => d.category)).toEqual(['system'])
  })
})

describe('linux.cpu', () => {
  it('groups logical processors per package and counts cores', async () => {
    const o = await run('linux.cpu')
    const [cpu] = o.result!.observations
    expect(cpu!.properties.find((p) => p.key === 'logical_processors')?.value).toBe(4)
    expect(cpu!.properties.find((p) => p.key === 'physical_cores')?.value).toBe(2)
    expect(cpu!.properties.find((p) => p.key === 'max_frequency')?.value).toBe(4400)
    expect(cpu!.properties.find((p) => p.key === 'flag_vmx')?.value).toBe(true)
    expect(cpu!.properties.find((p) => p.key === 'flag_avx512f')?.value).toBe(false)
  })
})

describe('linux.pci', () => {
  it('resolves names via pci.ids with database_lookup evidence and bridge topology', async () => {
    const o = await run('linux.pci')
    const obs = o.result!.observations
    const nvme = obs.find((d) => d.key === 'pci:0000:55:00.0')!
    expect(nvme.name).toBe('NVMe SSD Controller PM9A1')
    expect(nvme.manufacturer).toBe('Samsung Electronics Co Ltd')
    expect(nvme.fieldSources.name?.evidence).toBe('database_lookup')
    const rel = nvme.relationships.find((r) => r.type === 'bus_attachment')!
    expect(rel.targetKey).toBe('pci:0000:00:1d.0')
    expect(rel.directness).toBe('reported')
    expect(obs.find((d) => d.key === 'pci:0000:00:1d.0')!.subtype).toBe('bridge')
    expect(obs.find((d) => d.key === 'pci:0000:00:1d.0')!.driver).toBe('pcieport')
  })
  it('collects AER totals, local CPUs, runtime PM and the upstream port capability; missing AER files stay absent', async () => {
    const r = tmpRoot()
    const P = '/sys/devices/pci0000:00/0000:00:1d.0'
    const D = `${P}/0000:55:00.0`
    writeTree(r, {
      [`${P}/vendor`]: '0x8086\n', [`${P}/device`]: '0x9a14\n', [`${P}/class`]: '0x060400\n', [`${P}/max_link_width`]: '4\n', [`${P}/max_link_speed`]: '16.0 GT/s PCIe\n',
      [`${D}/vendor`]: '0x144d\n', [`${D}/device`]: '0xa80a\n', [`${D}/class`]: '0x010802\n', [`${D}/max_link_width`]: '4\n', [`${D}/current_link_width`]: '2\n',
      [`${D}/aer_dev_correctable`]: 'RxErr 0\nBadTLP 2\nTOTAL_ERR_COR 7\n', [`${D}/aer_dev_fatal`]: 'Undefined 0\nTOTAL_ERR_FATAL 0\n', [`${D}/aer_dev_nonfatal`]: 'garbage\n',
      [`${D}/local_cpulist`]: '0-7\n', [`${D}/power/runtime_status`]: 'suspended\n',
      '/sys/bus/pci/devices/0000:00:1d.0': { link: P }, '/sys/bus/pci/devices/0000:55:00.0': { link: D }
    })
    const d = (await run('linux.pci', r)).result!.observations.find((x) => x.key === 'pci:0000:55:00.0')!
    const v = (k: string) => d.properties.find((p) => p.key === k)
    expect(v('aer_correctable_errors')?.value).toBe(7)
    expect(v('aer_fatal_errors')?.value).toBe(0)
    expect(v('aer_nonfatal_errors')).toBeUndefined() // malformed → absent, not zero
    expect(v('local_cpulist')?.value).toBe('0-7')
    expect(v('runtime_pm_status')?.value).toBe('suspended')
    expect(v('upstream_max_link_width')).toMatchObject({ value: 4, evidence: 'derived' })
    expect(v('link_width')?.value).toBe(2)
    expect(validLinkWidth(0)).toBeUndefined()
    expect(validLinkWidth(255)).toBeUndefined()
    expect(parseLinkSpeed('16.0 GT/s PCIe')).toBe(16)
    expect(parseLinkSpeed('Unknown speed')).toBeUndefined()
  })
  it('falls back to IDs (not an invented name) when the database does not know the device', async () => {
    const r = tmpRoot()
    writeTree(r, { '/sys/devices/pci0000:00/0000:00:09.0/vendor': '0xdead\n', '/sys/devices/pci0000:00/0000:00:09.0/device': '0xbeef\n', '/sys/devices/pci0000:00/0000:00:09.0/class': '0x058000\n', '/sys/bus/pci/devices/0000:00:09.0': { link: '/sys/devices/pci0000:00/0000:00:09.0' } })
    const o = await run('linux.pci', r)
    const d = o.result!.observations[0]!
    expect(d.name).toBe('PCI device dead:beef')
    expect(d.fieldSources.name?.evidence).toBe('derived')
    expect(d.manufacturer).toBeUndefined()
  })
})

describe('linux.usb descriptors', () => {
  it('describes endpoints defensively and bounds nothing it cannot validate', () => {
    expect(describeEndpoint('ep_81', 'Interrupt', 'in', '0010')).toBe('0x81 Interrupt in 16B')
    expect(describeEndpoint('ep_02', 'Bogus', 'sideways', 'zz')).toBe('0x02')
    expect(describeEndpoint('epx', 'Bulk', 'in', '40')).toBeUndefined()
  })
  it('collects revision, endpoints and port over-current count from sysfs', async () => {
    const r = tmpRoot()
    const D = '/sys/devices/pci0000:00/0000:00:14.0/usb3/3-10'
    writeTree(r, {
      [`${D}/idVendor`]: '8087\n', [`${D}/idProduct`]: '0026\n', [`${D}/bcdDevice`]: '0002\n', [`${D}/bDeviceClass`]: 'e0\n', [`${D}/bDeviceProtocol`]: '01\n',
      [`${D}/3-10:1.0/bInterfaceClass`]: 'e0\n', [`${D}/3-10:1.0/ep_81/type`]: 'Interrupt\n', [`${D}/3-10:1.0/ep_81/direction`]: 'in\n', [`${D}/3-10:1.0/ep_81/wMaxPacketSize`]: '0010\n',
      [`${D}/port/over_current_count`]: '2\n', [`${D}/port/connect_type`]: 'hardwired\n',
      '/sys/bus/usb/devices/3-10': { link: D }
    })
    const d = (await run('linux.usb', r)).result!.observations[0]!
    const v = (k: string) => d.properties.find((p) => p.key === k)?.value
    expect(v('device_revision')).toBe('0002')
    expect(v('endpoints')).toBe('1.0:0x81 Interrupt in 16B')
    expect(v('port_over_current_count')).toBe(2)
    expect(v('port_connect_type')).toBe('hardwired')
  })
})

describe('linux.pci driver and DRM data', () => {
  it('reads driver module version and DRM outputs when exposed, and nothing when not', async () => {
    const r = tmpRoot()
    const D = '/sys/devices/pci0000:00/0000:00:02.0'
    writeTree(r, {
      [`${D}/vendor`]: '0x8086\n', [`${D}/device`]: '0x9a49\n', [`${D}/class`]: '0x030000\n',
      [`${D}/driver`]: { link: '/sys/bus/pci/drivers/i915' }, '/sys/module/i915/version': '1.6.0\n',
      [`${D}/drm/card1/card1-eDP-1/status`]: 'connected\n', [`${D}/drm/card1/card1-DP-1/status`]: 'disconnected\n', [`${D}/drm/card1/gt_RP0_freq_mhz`]: '1300\n',
      '/sys/bus/pci/devices/0000:00:02.0': { link: D }
    })
    const d = (await run('linux.pci', r)).result!.observations[0]!
    const v = (k: string) => d.properties.find((p) => p.key === k)?.value
    expect(v('driver_module_version')).toBe('1.6.0')
    expect(v('driver_srcversion')).toBeUndefined()
    expect(v('drm_connected_outputs')).toBe('eDP-1')
    expect(v('drm_connector_count')).toBe(2)
    expect(v('gpu_freq_max_mhz')).toBe(1300)
  })
})

describe('linux.usb', () => {
  it('builds the hub hierarchy from the sysfs path and uses serial-aware identity', async () => {
    const o = await run('linux.usb')
    const obs = o.result!.observations
    const cam = obs.find((d) => d.name === 'HD Camera')!
    expect(cam.key).toBe('usb:04f2:b6c0:sn:SN-CAM-1234') // survives moving to another port
    const hub = obs.find((d) => d.name === 'USB2.1 Hub')!
    expect(cam.relationships[0]).toMatchObject({ targetKey: hub.key, type: 'bus_attachment', directness: 'reported' })
    const root3 = obs.find((d) => d.key === 'usb:root:usb3')!
    expect(root3.subtype).toBe('root_hub')
    expect(root3.relationships[0]).toMatchObject({ targetKey: 'pci:0000:00:14.0', type: 'bus_attachment' })
    const rcv = obs.find((d) => d.name === 'USB Receiver')!
    expect(rcv.subtype).toBe('hid')
    expect(rcv.driver).toBe('usbhid')
    expect(rcv.identifiers.find((i) => i.kind === 'serial')).toBeUndefined()
    expect(cam.identifiers.find((i) => i.kind === 'serial')?.sensitive).toBe(true)
  })
})

describe('linux.input', () => {
  it('classifies keyboards/pointers from kernel capability data and links USB HID to its USB device', async () => {
    const o = await run('linux.input')
    const obs = o.result!.observations
    expect(obs.find((d) => d.name === 'AT Translated Set 2 keyboard')!.subtype).toBe('keyboard')
    expect(obs.find((d) => d.name === 'Power Button')!.subtype).not.toBe('keyboard')
    const mouse = obs.find((d) => d.name.includes('Mouse'))!
    expect(mouse.subtype).toBe('pointer')
    expect(mouse.relationships[0]).toMatchObject({ targetKey: 'usb:046d:c52b:port:3-1', type: 'bus_attachment' })
    expect(mouse.busType).toBe('USB')
    expect(obs.find((d) => d.name.startsWith('AT'))!.busType).toBe('i8042 (PS/2)') // not USB: no false assumption
  })
})

describe('linux.network', () => {
  it('reports state, flags MAC/IP as sensitive and ties the interface to its PCI device logically', async () => {
    const o = await run('linux.network')
    const w = o.result!.observations.find((d) => d.key === 'net:wlp0s20f3')!
    expect(w.subtype).toBe('wifi')
    expect(w.status).toBe('ok')
    expect(w.identifiers.find((i) => i.kind === 'mac_address')?.sensitive).toBe(true)
    expect(w.properties.find((p) => p.key === 'ip_addresses')).toMatchObject({ sensitive: true, volatile: true })
    expect(w.relationships[0]).toMatchObject({ targetKey: 'pci:0000:00:14.3', type: 'logical_parent' })
    expect(o.result!.observations.find((d) => d.key === 'net:lo')!.subtype).toBe('loopback')
  })
})

describe('linux.storage', () => {
  it('reports disk, partitions, mount usage and attachment to the controller', async () => {
    const o = await run('linux.storage')
    const obs = o.result!.observations
    const disk = obs.find((d) => d.subtype === 'nvme_ssd')!
    expect(disk.key).toBe('storage:wwid:eui.0025385b21500001')
    expect(disk.busType).toBe('NVMe')
    expect(disk.properties.find((p) => p.key === 'size_bytes')?.value).toBe(512_000_000)
    expect(disk.relationships[0]).toMatchObject({ targetKey: 'pci:0000:55:00.0', type: 'storage_attachment' })
    expect(disk.identifiers.find((i) => i.kind === 'serial')?.sensitive).toBe(true)
    expect(disk.properties.find((p) => p.key === 'nvme_state')?.value).toBe('live')
    expect(disk.properties.find((p) => p.key === 'nvme_transport')?.value).toBe('pcie')
    expect(disk.properties.find((p) => p.key === 'physical_block_size')?.value).toBe(4096)
    const p2 = obs.find((d) => d.key.endsWith(':part:2'))!
    expect(p2.properties.find((p) => p.key === 'mount_point')?.value).toBe('/')
    expect(p2.properties.find((p) => p.key === 'used_bytes')?.value).toBe(300_000_000)
    expect(p2.relationships[0]).toMatchObject({ targetKey: disk.key, type: 'storage_attachment' })
    expect(obs.find((d) => d.key.endsWith(':part:1'))!.name).toContain('EFI System Partition')
  })
  it('parses mounts and skips pseudo filesystems', () => {
    expect(parseMounts('proc /proc proc rw 0 0\n/dev/sda1 /mnt/my\\040disk ext4 rw 0 0\n/dev/loop1 /snap/x squashfs ro 0 0\n')).toEqual([{ source: '/dev/sda1', mount: '/mnt/my disk', fs: 'ext4' }])
  })
})

describe('linux.display / power / sensors / audio', () => {
  it('parses EDID and only reports connected connectors', async () => {
    const o = await run('linux.display')
    expect(o.result!.observations).toHaveLength(1)
    const d = o.result!.observations[0]!
    expect(d.name).toBe('LP140WF9')
    expect(d.manufacturer).toBe('LGD')
    expect(d.subtype).toBe('internal_panel')
    expect(d.properties.find((p) => p.key === 'preferred_resolution')?.value).toBe('1920x1080')
    expect(d.properties.find((p) => p.key === 'diagonal_in')?.value).toBeCloseTo(13.6, 1)
    expect(d.relationships).toHaveLength(0) // GPU parent not in this fixture's device path: no invented link
  })
  it('rejects corrupt EDID instead of guessing', () => {
    const bad = makeEdid()
    bad[30] ^= 0xff
    expect(parseEdid(bad)).toBeUndefined()
    expect(parseEdid(Buffer.alloc(10))).toBeUndefined()
  })
  it('derives battery health from reported capacities', async () => {
    const o = await run('linux.power')
    const b = o.result!.observations.find((d) => d.subtype === 'battery')!
    expect(b.properties.find((p) => p.key === 'health_percent')?.value).toBe(83.3)
    expect(b.properties.find((p) => p.key === 'health_percent')?.evidence).toBe('derived')
  })
  it('reads hwmon with sensor-reported thresholds and marks readings volatile', async () => {
    const o = await run('linux.sensors')
    const s = o.result!.observations[0]!
    const t = s.properties.find((p) => p.key === 'temperature:Package id 0')!
    expect(t).toMatchObject({ value: 45, unit: '°C', volatile: true, evidence: 'measured' })
    expect(s.properties.find((p) => p.key === 'temperature_crit:Package id 0')?.value).toBe(100)
  })
  it('parses ALSA cards', async () => {
    const o = await run('linux.audio')
    expect(o.result!.observations[0]).toMatchObject({ key: 'audio:card:PCH', driver: 'HDA-Intel' })
  })
})

describe('permission & failure semantics', () => {
  it('reports permission_required, never an empty-but-healthy inventory', async () => {
    const r = tmpRoot()
    writeTree(r, { '/sys/firmware/dmi/entries/17-0/raw': Buffer.alloc(40), '/proc/meminfo': '' })
    chmodSync(`${r}/sys/firmware/dmi/entries/17-0/raw`, 0o000)
    const o = await run('linux.memory', r)
    // /proc/meminfo is empty -> unavailable; the denied path is not misreported as "no modules"
    expect(o.status).not.toBe('available')
    if (process.getuid?.() !== 0) {
      writeTree(r, { '/proc/meminfo': 'MemTotal: 1024 kB\n' })
      const o2 = await run('linux.memory', r)
      expect(o2.status).toBe('available')
      expect(o2.result!.outcome).toBe('partial')
      expect(o2.limitations.some((l) => l.kind === 'permission' && /elevated/.test(l.message))).toBe(true)
    }
  })
  it('marks missing interfaces unsupported, and exceptions as error with no result', async () => {
    const empty = tmpRoot()
    expect((await run('linux.pci', empty)).status).toBe('unsupported')
    const boom: Collector = { ...get('linux.cpu'), id: 'x.boom', retries: 1, isSupported: async () => true, collect: async () => { throw new Error('kaboom') } }
    const o = await runCollector(boom, ctxFor(root))
    expect(o.status).toBe('error')
    expect(o.result).toBeNull()
    expect(o.message).toBe('kaboom')
  })
  it('enforces the timeout', async () => {
    const slow: Collector = { ...get('linux.cpu'), id: 'x.slow', timeoutMs: 30, retries: 0, collect: () => new Promise(() => {}) }
    const o = await runCollector(slow, ctxFor(root))
    expect(o.status).toBe('error')
    expect(o.message).toMatch(/timed out/)
  })
  it('rejects schema-invalid collector output', async () => {
    const bad: Collector = { ...get('linux.cpu'), id: 'x.bad', collect: async () => ({ outcome: 'complete', observations: [{ key: '' } as never], limitations: [] }) }
    const o = await runCollector(bad, ctxFor(root))
    expect(o.status).toBe('error')
    expect(o.message).toMatch(/invalid output/)
  })
  it('refuses to run on the wrong platform', async () => {
    const o = await runCollector(get('linux.cpu'), ctxFor(root, { platform: 'win32' }))
    expect(o.status).toBe('unsupported')
  })
})

describe('linux.smart', () => {
  const nvmeJson = JSON.stringify({ smartctl: { messages: [] }, model_name: 'Samsung SSD 980', smart_status: { passed: true }, temperature: { current: 38 }, power_on_time: { hours: 1200 }, nvme_smart_health_information_log: { percentage_used: 3, critical_warning: 0, media_errors: 0 } })
  it('parses NVMe health', () => {
    expect(parseSmartctl(nvmeJson)).toMatchObject({ passed: true, temperatureC: 38, percentageUsed: 3, powerOnHours: 1200 })
    expect(parseSmartctl('not json')).toBeUndefined()
  })
  it('reports permission_required when smartctl cannot open the device', async () => {
    const denied = JSON.stringify({ smartctl: { messages: [{ string: '/dev/nvme0n1: Permission denied' }] } })
    const o = await run('linux.smart', root, { run: async () => ({ ...ok(denied), ok: false, code: 2 }) })
    expect(o.status).toBe('permission_required')
    expect(o.result!.observations).toHaveLength(0)
    expect(o.limitations[0]!.message).toMatch(/unknown, not healthy/)
  })
  it('is unavailable (not healthy) when smartctl is not installed', async () => {
    const o = await run('linux.smart')
    expect(o.status).toBe('unavailable')
    expect(o.limitations[0]!.kind).toBe('missing_tool')
  })
  it('emits health properties keyed to the storage device when smartctl succeeds', async () => {
    const o = await run('linux.smart', root, { run: async () => ok(nvmeJson) })
    expect(o.status).toBe('available')
    const d = o.result!.observations[0]!
    expect(d.key).toBe('storage:wwid:eui.0025385b21500001')
    expect(d.properties.find((p) => p.key === 'smart_passed')).toMatchObject({ value: true, evidence: 'measured', volatile: true })
  })
})

describe('linux.bluetooth', () => {
  it('lists BlueZ devices when available and flags them as inferred attachments', async () => {
    const r = tmpRoot()
    writeTree(r, {
      '/sys/devices/pci0000:00/0000:00:14.0/usb3/3-10/idVendor': '8087\n', '/sys/devices/pci0000:00/0000:00:14.0/usb3/3-10/idProduct': '0026\n',
      '/sys/devices/pci0000:00/0000:00:14.0/usb3/3-10/bluetooth/hci0/address': 'AA:BB:CC:00:11:22\n',
      '/sys/bus/usb/devices/3-10': { link: '/sys/devices/pci0000:00/0000:00:14.0/usb3/3-10' },
      '/sys/class/bluetooth/hci0': { link: '/sys/devices/pci0000:00/0000:00:14.0/usb3/3-10/bluetooth/hci0' }
    })
    const runner = async (_f: string, args: readonly string[]) =>
      args[0] === 'devices' ? ok('Device F8:5C:7D:9C:B0:2B JBL TUNE700BT\n') : ok('Device F8:5C:7D:9C:B0:2B (public)\n\tAlias: JBL TUNE700BT\n\tPaired: yes\n\tConnected: no\n\tIcon: audio-headset\n')
    const o = await run('linux.bluetooth', r, { run: runner })
    const dev = o.result!.observations.find((d) => d.key.startsWith('bluetooth:device:'))!
    expect(dev.subtype).toBe('audio-headset')
    expect(dev.properties.find((p) => p.key === 'connected')?.value).toBe(false)
    expect(dev.relationships[0]).toMatchObject({ directness: 'inferred' })
    expect(dev.relationships[0]!.confidence).toBeLessThan(1)
    expect(dev.identifiers.find((i) => i.kind === 'mac_address')?.sensitive).toBe(true)
  })
  it('degrades with a missing_tool limitation when bluetoothctl is absent', async () => {
    const r = tmpRoot()
    writeTree(r, { '/sys/class/bluetooth/hci0/address': 'AA:BB:CC:00:11:22\n' })
    const o = await run('linux.bluetooth', r)
    expect(o.result!.outcome).toBe('partial')
    expect(o.limitations.some((l) => l.kind === 'missing_tool')).toBe(true)
  })
})

describe('linux.i2c', () => {
  it('lists adapters and registered clients passively, with stable keys and bounded info', async () => {
    const r = tmpRoot()
    const A = '/sys/devices/pci0000:00/0000:00:1f.4/i2c-15'
    writeTree(r, {
      [`${A}/name`]: 'SMBus I801 adapter\n', [`${A}/15-0050/name`]: 'spd5118\n', [`${A}/15-0050/modalias`]: 'i2c:spd5118\n', [`${A}/15-0036/name`]: 'x\n',
      [`${A}/15-0050/driver`]: { link: '/sys/bus/i2c/drivers/spd5118' },
      '/sys/bus/i2c/devices/i2c-15': { link: A }, '/sys/bus/i2c/devices/15-0050': { link: `${A}/15-0050` }, '/sys/bus/i2c/devices/15-0036': { link: `${A}/15-0036` },
      '/sys/bus/i2c/devices/99-0050': { link: '/sys/devices/x/99-0050' }
    })
    const obs = (await run('linux.i2c', r)).result!.observations
    expect(obs).toHaveLength(3) // orphan client of unknown adapter 99 is skipped
    const ad = obs.find((o) => o.subtype === 'i2c_adapter')!
    expect(ad.key).not.toMatch(/i2c-15$/) // bus index is not part of the identity
    expect(ad.relationships[0]).toMatchObject({ targetKey: 'pci:0000:00:1f.4', type: 'bus_attachment' })
    const spd = obs.find((o) => o.name.includes('spd5118'))!
    expect(spd.driver).toBe('spd5118')
    expect(spd.properties.find((p) => p.key === 'address')?.value).toBe('0x50')
    expect(spd.properties.find((p) => p.key === 'bound')?.value).toBe(true)
    expect(obs.find((o) => o.name === 'I²C device: x')!.properties.find((p) => p.key === 'bound')?.value).toBe(false)
  })
  it('is unsupported without the bus directory', async () => {
    expect((await run('linux.i2c', tmpRoot())).status).toBe('unsupported')
  })
})
