import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import type { CollectContext, HostInfo } from '@collectors/core/context'
import { SysReader } from '@collectors/core/sysreader'
import type { CommandRunner, RunResult } from '@collectors/core/runner'

export type Tree = Record<string, string | Buffer | { link: string }>

/** Materialise a sysfs/procfs-like tree. `{link}` targets are absolute paths *inside* the fixture root. */
export function writeTree(root: string, tree: Tree): void {
  for (const [p, v] of Object.entries(tree)) {
    const abs = join(root, p)
    mkdirSync(dirname(abs), { recursive: true })
    if (typeof v === 'object' && !Buffer.isBuffer(v)) {
      symlinkSync(relative(dirname(abs), join(root, v.link)), abs)
    } else {
      writeFileSync(abs, v)
    }
  }
}

export function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), 'hip-fixture-'))
}

/** Build a minimal but realistic EDID base block. */
export function makeEdid(opts: { mfg?: string; product?: number; name?: string; w?: number; h?: number; year?: number } = {}): Buffer {
  const b = Buffer.alloc(128)
  Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]).copy(b)
  const mfg = (opts.mfg ?? 'LGD').split('').map((c) => c.charCodeAt(0) - 64)
  const code = (mfg[0]! << 10) | (mfg[1]! << 5) | mfg[2]!
  b[8] = code >> 8
  b[9] = code & 0xff
  b.writeUInt16LE(opts.product ?? 0x0652, 10)
  b[16] = 12
  b[17] = (opts.year ?? 2021) - 1990
  b[18] = 1
  b[19] = 4
  b[21] = opts.w ?? 30
  b[22] = opts.h ?? 17
  // Detailed timing #1: 1920x1080 @ ~60 Hz (pixel clock 14850 * 10 kHz, htotal 2200, vtotal 1125)
  b.writeUInt16LE(14850, 54)
  b[56] = 1920 & 0xff
  b[57] = 280 & 0xff
  b[58] = ((1920 >> 8) << 4) | (280 >> 8)
  b[59] = 1080 & 0xff
  b[60] = 45
  b[61] = ((1080 >> 8) << 4) | (45 >> 8)
  if (opts.name) {
    const d = 72
    b[d + 3] = 0xfc
    Buffer.from(opts.name.padEnd(13, ' ').slice(0, 12) + '\n', 'latin1').copy(b, d + 5)
  }
  let sum = 0
  for (let i = 0; i < 127; i++) sum = (sum + b[i]!) & 0xff
  b[127] = (256 - sum) & 0xff
  return b
}

const PCI = (addr: string, vendor: string, device: string, cls: string, extra: Tree = {}, parentPath = ''): Tree => {
  const dev = `/sys/devices/pci0000:00${parentPath}/${addr}`
  return {
    [`${dev}/vendor`]: `0x${vendor}\n`,
    [`${dev}/device`]: `0x${device}\n`,
    [`${dev}/class`]: `0x${cls}\n`,
    [`${dev}/revision`]: '0x01\n',
    [`/sys/bus/pci/devices/${addr}`]: { link: dev },
    ...extra
  }
}

export const PCI_IDS = `8086  Intel Corporation
\t9a14  Tiger Lake-LP PCI Express Root Port
\t9a49  Tiger Lake-LP PCI Express Root Port #1
\ta0ed  Tiger Lake-LP USB 3.2 Gen 2x1 xHCI Host Controller
\t9a2f  Wi-Fi 6 AX201
144d  Samsung Electronics Co Ltd
\ta80a  NVMe SSD Controller PM9A1
C 06  Bridge
\t04  PCI bridge
C 0c  Serial bus controller
\t03  USB controller
C 02  Network controller
\t80  Network controller
C 01  Mass storage controller
\t08  Non-Volatile memory controller
`

export const USB_IDS = `046d  Logitech, Inc.
\tc52b  Unifying Receiver
`

export function laptopTree(): Tree {
  const t: Tree = {
    '/proc/version': 'Linux version 6.8.0\n',
    '/proc/sys/kernel/osrelease': '6.8.0-test\n',
    '/proc/uptime': '12345.67 9999.00\n',
    '/etc/os-release': 'NAME="Fedora Linux"\nPRETTY_NAME="Fedora Linux 44"\nVERSION_ID=44\n',
    '/sys/class/dmi/id/sys_vendor': 'HP\n',
    '/sys/class/dmi/id/product_name': 'HP EliteBook 840 G8\n',
    '/sys/class/dmi/id/board_vendor': 'HP\n',
    '/sys/class/dmi/id/board_name': '880D\n',
    '/sys/class/dmi/id/bios_vendor': 'HP\n',
    '/sys/class/dmi/id/bios_version': 'T76 Ver. 01.25.00\n',
    '/sys/class/dmi/id/bios_date': '07/01/2024\n',
    '/sys/class/dmi/id/product_family': 'To Be Filled By O.E.M.\n',
    '/sys/firmware/efi/.keep': '',
    '/proc/cpuinfo':
      'processor\t: 0\nvendor_id\t: GenuineIntel\ncpu family\t: 6\nmodel\t\t: 140\nmodel name\t: 11th Gen Intel(R) Core(TM) i5-1145G7\nstepping\t: 1\nphysical id\t: 0\ncore id\t\t: 0\ncpu cores\t: 2\nflags\t\t: fpu vmx avx avx2 aes\n\n' +
      'processor\t: 1\nvendor_id\t: GenuineIntel\ncpu family\t: 6\nmodel\t\t: 140\nmodel name\t: 11th Gen Intel(R) Core(TM) i5-1145G7\nphysical id\t: 0\ncore id\t\t: 0\ncpu cores\t: 2\nflags\t\t: fpu vmx avx avx2 aes\n\n' +
      'processor\t: 2\nvendor_id\t: GenuineIntel\ncpu family\t: 6\nmodel\t\t: 140\nmodel name\t: 11th Gen Intel(R) Core(TM) i5-1145G7\nphysical id\t: 0\ncore id\t\t: 1\ncpu cores\t: 2\nflags\t\t: fpu vmx avx avx2 aes\n\n' +
      'processor\t: 3\nvendor_id\t: GenuineIntel\ncpu family\t: 6\nmodel\t\t: 140\nmodel name\t: 11th Gen Intel(R) Core(TM) i5-1145G7\nphysical id\t: 0\ncore id\t\t: 1\ncpu cores\t: 2\nflags\t\t: fpu vmx avx avx2 aes\n',
    '/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq': '4400000\n',
    '/sys/devices/system/cpu/cpu0/cpufreq/scaling_governor': 'powersave\n',
    '/proc/meminfo': 'MemTotal:       16384000 kB\nMemAvailable:    8000000 kB\nSwapTotal:       4096000 kB\n',
    '/proc/self/mounts': '/dev/nvme0n1p2 / ext4 rw 0 0\n/dev/nvme0n1p1 /boot/efi vfat rw 0 0\nproc /proc proc rw 0 0\ntmpfs /run tmpfs rw 0 0\n'
  }
  // PCI: host bridge -> root port (bridge 0604) -> NVMe controller; wifi + xHCI on root
  Object.assign(
    t,
    PCI('0000:00:1d.0', '8086', '9a14', '060400', { '/sys/devices/pci0000:00/0000:00:1d.0/driver': { link: '/sys/bus/pci/drivers/pcieport' } }),
    PCI('0000:55:00.0', '144d', 'a80a', '010802', {}, '/0000:00:1d.0'),
    PCI('0000:00:14.3', '8086', '9a2f', '028000', { '/sys/devices/pci0000:00/0000:00:14.3/driver': { link: '/sys/bus/pci/drivers/iwlwifi' } }),
    PCI('0000:00:14.0', '8086', 'a0ed', '0c0330', { '/sys/devices/pci0000:00/0000:00:14.0/driver': { link: '/sys/bus/pci/drivers/xhci_hcd' } }),
    { '/sys/bus/pci/drivers/pcieport/.keep': '', '/sys/bus/pci/drivers/iwlwifi/.keep': '', '/sys/bus/pci/drivers/xhci_hcd/.keep': '' }
  )
  // USB: root hub usb3 on xHCI; keyboard 3-1 directly; hub 3-2 with webcam 3-2.1 behind it
  const xhci = '/sys/devices/pci0000:00/0000:00:14.0'
  const usbDev = (path: string, name: string, vid: string, pid: string, cls: string, extra: Tree = {}): Tree => ({
    [`${path}/idVendor`]: vid + '\n',
    [`${path}/idProduct`]: pid + '\n',
    [`${path}/bDeviceClass`]: cls + '\n',
    [`${path}/speed`]: '480\n',
    [`${path}/version`]: ' 2.00\n',
    [`${path}/busnum`]: '3\n',
    [`/sys/bus/usb/devices/${name}`]: { link: path },
    ...extra
  })
  Object.assign(
    t,
    usbDev(`${xhci}/usb3`, 'usb3', '1d6b', '0003', '09', { [`${xhci}/usb3/product`]: 'xHCI Host Controller\n', [`${xhci}/usb3/manufacturer`]: 'Linux 6.8 xhci-hcd\n' }),
    usbDev(`${xhci}/usb3/3-1`, '3-1', '046d', 'c52b', '00', {
      [`${xhci}/usb3/3-1/product`]: 'USB Receiver\n',
      [`${xhci}/usb3/3-1/manufacturer`]: 'Logitech\n',
      [`${xhci}/usb3/3-1/3-1:1.0/bInterfaceClass`]: '03\n',
      [`${xhci}/usb3/3-1/3-1:1.0/driver`]: { link: '/sys/bus/usb/drivers/usbhid' },
      '/sys/bus/usb/drivers/usbhid/.keep': ''
    }),
    usbDev(`${xhci}/usb3/3-2`, '3-2', '05e3', '0610', '09', { [`${xhci}/usb3/3-2/product`]: 'USB2.1 Hub\n' }),
    usbDev(`${xhci}/usb3/3-2/3-2.1`, '3-2.1', '04f2', 'b6c0', 'ef', {
      [`${xhci}/usb3/3-2/3-2.1/product`]: 'HD Camera\n',
      [`${xhci}/usb3/3-2/3-2.1/serial`]: 'SN-CAM-1234\n'
    })
  )
  // Network: wifi on PCI
  Object.assign(t, {
    '/sys/devices/pci0000:00/0000:00:14.3/net/wlp0s20f3/type': '1\n',
    '/sys/devices/pci0000:00/0000:00:14.3/net/wlp0s20f3/operstate': 'up\n',
    '/sys/devices/pci0000:00/0000:00:14.3/net/wlp0s20f3/carrier': '1\n',
    '/sys/devices/pci0000:00/0000:00:14.3/net/wlp0s20f3/address': 'aa:bb:cc:dd:ee:ff\n',
    '/sys/devices/pci0000:00/0000:00:14.3/net/wlp0s20f3/mtu': '1500\n',
    '/sys/devices/pci0000:00/0000:00:14.3/net/wlp0s20f3/wireless/.keep': '',
    '/sys/devices/pci0000:00/0000:00:14.3/net/wlp0s20f3/statistics/rx_bytes': '1000\n',
    '/sys/devices/pci0000:00/0000:00:14.3/net/wlp0s20f3/statistics/tx_bytes': '500\n',
    '/sys/devices/pci0000:00/0000:00:14.3/net/wlp0s20f3/device': { link: '/sys/devices/pci0000:00/0000:00:14.3' },
    '/sys/class/net/wlp0s20f3': { link: '/sys/devices/pci0000:00/0000:00:14.3/net/wlp0s20f3' },
    '/sys/devices/virtual/net/lo/type': '772\n',
    '/sys/devices/virtual/net/lo/operstate': 'unknown\n',
    '/sys/class/net/lo': { link: '/sys/devices/virtual/net/lo' }
  })
  // Storage: NVMe behind bridge, 2 partitions
  const nvme = '/sys/devices/pci0000:00/0000:00:1d.0/0000:55:00.0/nvme/nvme0/nvme0n1'
  Object.assign(t, {
    [`${nvme}/size`]: '1000000\n',
    [`${nvme}/removable`]: '0\n',
    [`${nvme}/queue/rotational`]: '0\n',
    [`${nvme}/wwid`]: 'eui.0025385b21500001\n',
    [`${nvme}/device/model`]: 'Samsung SSD 980\n',
    [`${nvme}/device/serial`]: 'S6ABC123\n',
    [`${nvme}/nvme0n1p1/partition`]: '1\n',
    [`${nvme}/nvme0n1p1/size`]: '200000\n',
    [`${nvme}/nvme0n1p1/uevent`]: 'PARTNAME=EFI System Partition\n',
    [`${nvme}/nvme0n1p2/partition`]: '2\n',
    [`${nvme}/nvme0n1p2/size`]: '800000\n',
    '/sys/class/nvme/nvme0/state': 'live\n', '/sys/class/nvme/nvme0/transport': 'pcie\n', '/sys/class/nvme/nvme0/firmware_rev': '2B2QGXA7\n',
    [`${nvme}/queue/physical_block_size`]: '4096\n',
    '/sys/block/nvme0n1': { link: nvme }
  })
  // Power, hwmon, drm, input, audio
  Object.assign(t, {
    '/sys/class/power_supply/BAT0/type': 'Battery\n',
    '/sys/class/power_supply/BAT0/status': 'Discharging\n',
    '/sys/class/power_supply/BAT0/capacity': '73\n',
    '/sys/class/power_supply/BAT0/energy_full': '50000000\n',
    '/sys/class/power_supply/BAT0/energy_full_design': '60000000\n',
    '/sys/class/power_supply/BAT0/model_name': 'Primary\n',
    '/sys/class/power_supply/BAT0/serial_number': 'BATSERIAL1\n',
    '/sys/devices/platform/coretemp.0/hwmon/hwmon6/name': 'coretemp\n',
    '/sys/devices/platform/coretemp.0/hwmon/hwmon6/temp1_input': '45000\n',
    '/sys/devices/platform/coretemp.0/hwmon/hwmon6/temp1_label': 'Package id 0\n',
    '/sys/devices/platform/coretemp.0/hwmon/hwmon6/temp1_crit': '100000\n',
    '/sys/class/hwmon/hwmon6': { link: '/sys/devices/platform/coretemp.0/hwmon/hwmon6' },
    '/sys/devices/pci0000:00/0000:00:14.3/.keep': '',
    '/sys/class/drm/card1-eDP-1/status': 'connected\n',
    '/sys/class/drm/card1-eDP-1/modes': '1920x1080\n1280x720\n',
    '/sys/class/drm/card1-eDP-1/edid': makeEdid({ name: 'LP140WF9' }),
    '/sys/class/drm/card1-DP-1/status': 'disconnected\n',
    '/proc/asound/cards': ' 0 [PCH            ]: HDA-Intel - HDA Intel PCH\n                      HDA Intel PCH at 0x601c218000 irq 177\n',
    '/sys/devices/pci0000:00/0000:00:14.3/sound/card0/.keep': '',
    '/sys/class/sound/card0': { link: '/sys/devices/pci0000:00/0000:00:14.3/sound/card0' },
    '/proc/bus/input/devices':
      'I: Bus=0011 Vendor=0001 Product=0001 Version=ab41\nN: Name="AT Translated Set 2 keyboard"\nP: Phys=isa0060/serio0/input0\nS: Sysfs=/devices/platform/i8042/serio0/input/input3\nU: Uniq=\nH: Handlers=sysrq kbd event3 leds\nB: EV=120013\n\n' +
      'I: Bus=0003 Vendor=046d Product=c52b Version=0111\nN: Name="Logitech USB Receiver Mouse"\nP: Phys=usb-0000:00:14.0-1/input0\nS: Sysfs=/devices/pci0000:00/0000:00:14.0/usb3/3-1/3-1:1.0/0003:046D:C52B.0001/input/input5\nU: Uniq=\nH: Handlers=mouse0 event5\nB: EV=17\n\n' +
      'I: Bus=0019 Vendor=0000 Product=0001 Version=0000\nN: Name="Power Button"\nP: Phys=PNP0C0C/button/input0\nS: Sysfs=/devices/LNXSYSTM:00/LNXPWRBN:00/input/input0\nU: Uniq=\nH: Handlers=kbd event0\nB: EV=3\n'
  })
  return t
}

export function fixtureHost(over: Partial<HostInfo> = {}): HostInfo {
  return {
    hostname: 'fixture-host',
    arch: 'x64',
    networkAddresses: { wlp0s20f3: [{ address: '192.168.1.20', family: 'IPv4', cidr: '192.168.1.20/24', internal: false }] },
    statfs: async (mount) => (mount === '/' ? { totalBytes: 400_000_000, freeBytes: 100_000_000 } : undefined),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    ...over
  }
}

export const noCommands: CommandRunner = async () => ({ ok: false, code: null, stdout: '', stderr: '', timedOut: false, notFound: true, truncated: false })

export function ctxFor(root: string, over: Partial<CollectContext> = {}): CollectContext {
  return { reader: new SysReader(root), run: noCommands, host: fixtureHost(), platform: 'linux', ...over }
}

export const ok = (stdout: string): RunResult => ({ ok: true, code: 0, stdout, stderr: '', timedOut: false, notFound: false, truncated: false })
