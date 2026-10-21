import type { DeviceObservation } from '@shared/schemas'
import { meaningful, ObservationBuilder, type CollectContext } from '../core/context'
import type { Collector } from '../core/types'
import { finish, pciAncestor, pciKey, usbDeviceName, usbKey } from './shared'

const ID = 'linux.bluetooth'

export function parseBluetoothctlDevices(text: string): { mac: string; name: string }[] {
  const out: { mac: string; name: string }[] = []
  for (const line of text.split('\n')) {
    const m = /^Device\s+([0-9A-F]{2}(?::[0-9A-F]{2}){5})\s+(.+)$/i.exec(line.trim())
    if (m) out.push({ mac: m[1]!.toUpperCase(), name: m[2]!.trim() })
  }
  return out
}

export function parseBluetoothctlInfo(text: string): Record<string, string> {
  const o: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^\s+([A-Za-z ]+):\s+(.*)$/.exec(line)
    if (m) o[m[1]!.trim()] = m[2]!.trim()
  }
  return o
}

export const linuxBluetooth: Collector = {
  id: ID,
  version: '1.0.0',
  platforms: ['linux'],
  categories: ['bluetooth'],
  permissions: ['Paired-device details require BlueZ (bluetoothctl) and a running bluetooth service'],
  method: '/sys/class/bluetooth (controllers) + bluetoothctl (paired devices)',
  timeoutMs: 10000,
  retries: 0,
  isSupported: (ctx) => ctx.reader.exists('/sys/class/bluetooth'),
  async collect(ctx: CollectContext) {
    const r = ctx.reader
    const at = ctx.host.now()
    const out: DeviceObservation[] = []
    const limitations = []
    const controllers = (await r.dir('/sys/class/bluetooth')).filter((n) => /^hci\d+$/.test(n))
    let firstKey: string | undefined
    for (const n of controllers) {
      const base = `/sys/class/bluetooth/${n}`
      const real = await r.real(base)
      const usb = usbDeviceName(real)
      const pci = pciAncestor(real)
      const mac = meaningful(await r.text(`${base}/address`))
      const key = `bluetooth:controller:${usb ? ((await usbKey(r, usb)) ?? n) : (pci ?? n)}`
      firstKey ??= key
      const b = new ObservationBuilder(ID, key, 'bluetooth', `Bluetooth controller (${n})`, at, { sourceProperty: `${base} (interface name)`, evidence: 'derived' })
        .status('ok')
        .field('subtype', 'controller', 'bluetooth class', 'derived')
        .field('busType', usb ? 'USB' : pci ? 'PCI' : undefined, 'sysfs device path', 'derived')
        .id('hci', n)
        .id('mac_address', mac, true)
      const blocked = await rfkillBlocked(ctx, n)
      b.prop('rfkill_blocked', blocked, '/sys/class/rfkill/*/soft+hard', { volatile: true })
      if (usb) b.rel(await usbKey(r, usb), 'bus_attachment', `${base} (sysfs device path)`)
      else if (pci) b.rel(pciKey(pci), 'bus_attachment', `${base} (sysfs device path)`)
      out.push(b.build())
    }

    if (controllers.length) {
      const res = await ctx.run('bluetoothctl', ['devices'], { timeoutMs: 4000 })
      if (res.notFound) {
        limitations.push({ kind: 'missing_tool' as const, message: 'bluetoothctl (BlueZ) not found: paired/connected devices are not listed.', target: 'bluetoothctl' })
      } else if (!res.ok) {
        limitations.push({ kind: res.timedOut ? ('timeout' as const) : ('missing_interface' as const), message: `bluetoothctl failed: ${res.stderr.trim().slice(0, 120) || `exit ${res.code}`}. Paired devices are unavailable.`, target: 'bluetoothctl' })
      } else {
        for (const d of parseBluetoothctlDevices(res.stdout)) {
          const info = await ctx.run('bluetoothctl', ['info', d.mac], { timeoutMs: 3000 })
          const f = info.ok ? parseBluetoothctlInfo(info.stdout) : {}
          out.push(
            new ObservationBuilder(ID, `bluetooth:device:${d.mac}`, 'bluetooth', f['Alias'] ?? d.name, at, { sourceProperty: 'bluetoothctl devices' })
              .status('ok')
              .field('subtype', f['Icon'], 'bluetoothctl info Icon')
              .field('busType', 'Bluetooth', 'derived', 'derived')
              .id('mac_address', d.mac, true)
              .prop('paired', f['Paired'] === undefined ? undefined : f['Paired'] === 'yes', 'bluetoothctl info Paired', { volatile: true })
              .prop('connected', f['Connected'] === undefined ? undefined : f['Connected'] === 'yes', 'bluetoothctl info Connected', { volatile: true })
              .prop('trusted', f['Trusted'] === undefined ? undefined : f['Trusted'] === 'yes', 'bluetoothctl info Trusted')
              .prop('rssi', f['RSSI'], 'bluetoothctl info RSSI', { volatile: true })
              .rel(firstKey, 'bus_attachment', 'bluetoothctl (adapter in use)', { directness: 'inferred', confidence: 0.7 })
              .build()
          )
        }
      }
    }
    if (!controllers.length) return { outcome: 'complete' as const, observations: [], limitations: [{ kind: 'info', message: 'No Bluetooth controller present.' }] }
    return finish(ctx, out, limitations)
  }
}

async function rfkillBlocked(ctx: CollectContext, hci: string): Promise<boolean | undefined> {
  for (const rf of await ctx.reader.dir('/sys/class/rfkill')) {
    const base = `/sys/class/rfkill/${rf}`
    if ((await ctx.reader.text(`${base}/type`)) !== 'bluetooth') continue
    if ((await ctx.reader.text(`${base}/name`)) !== hci) continue
    return (await ctx.reader.text(`${base}/soft`)) === '1' || (await ctx.reader.text(`${base}/hard`)) === '1'
  }
  return undefined
}
