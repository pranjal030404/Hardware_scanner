import type { DeviceObservation } from '@shared/schemas'
import { meaningful, ObservationBuilder, type CollectContext } from '../core/context'
import type { Collector } from '../core/types'
import { finish } from './shared'

const ID = 'linux.system'
const DMI = '/sys/class/dmi/id'

function parseOsRelease(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of (text ?? '').split('\n')) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]!] = m[2]!.replace(/^"|"$/g, '')
  }
  return out
}

/** "HP" + "HP EliteBook 840" -> "HP EliteBook 840" (firmware often repeats the vendor in the product string). */
export function displayName(vendor: string | undefined, product: string | undefined): string {
  if (vendor && product && product.toLowerCase().startsWith(vendor.toLowerCase())) return product
  return [vendor, product].filter(Boolean).join(' ')
}

export const linuxSystem: Collector = {
  id: ID,
  version: '1.0.0',
  platforms: ['linux'],
  categories: ['system', 'motherboard'],
  permissions: ['Serial numbers and UUID (root-only DMI attributes) are intentionally not collected'],
  method: 'procfs + /sys/class/dmi/id + /etc/os-release',
  timeoutMs: 5000,
  retries: 1,
  async isSupported(ctx) {
    return (await ctx.reader.exists('/proc/version')) || (await ctx.reader.exists(DMI))
  },
  async collect(ctx: CollectContext) {
    const r = ctx.reader
    const at = ctx.host.now()
    const out: DeviceObservation[] = []
    const osr = parseOsRelease(await r.text('/etc/os-release'))
    const kernel = await r.text('/proc/sys/kernel/osrelease')
    const uptime = parseFloat((await r.text('/proc/uptime'))?.split(' ')[0] ?? '')

    const vendor = meaningful(await r.text(`${DMI}/sys_vendor`))
    const product = meaningful(await r.text(`${DMI}/product_name`))
    const family = meaningful(await r.text(`${DMI}/product_family`))
    const version = meaningful(await r.text(`${DMI}/product_version`))
    const chassisType = await r.num(`${DMI}/chassis_type`)

    const sys = new ObservationBuilder(ID, 'system:host', 'system', displayName(vendor, product) || ctx.host.hostname, at, {
      sourceProperty: vendor || product ? 'dmi/sys_vendor+product_name' : 'os.hostname',
      evidence: vendor || product ? 'os_reported' : 'derived'
    })
      .status('ok')
      .field('manufacturer', vendor, `${DMI}/sys_vendor`)
      .field('model', product, `${DMI}/product_name`)
      .prop('product_family', family, `${DMI}/product_family`)
      .prop('product_version', version, `${DMI}/product_version`)
      .prop('hostname', ctx.host.hostname, 'os.hostname()', { sensitive: true })
      .prop('os_name', osr.PRETTY_NAME ?? osr.NAME, '/etc/os-release PRETTY_NAME')
      .prop('os_version', osr.VERSION_ID, '/etc/os-release VERSION_ID')
      .prop('kernel', kernel, '/proc/sys/kernel/osrelease')
      .prop('architecture', ctx.host.arch, 'os.arch()')
      .prop('uptime_seconds', Number.isFinite(uptime) ? Math.round(uptime) : undefined, '/proc/uptime', { unit: 's', volatile: true, evidence: 'measured' })
      .prop('chassis_type_code', chassisType, `${DMI}/chassis_type`)
    out.push(sys.build())

    const boardVendor = meaningful(await r.text(`${DMI}/board_vendor`))
    const boardName = meaningful(await r.text(`${DMI}/board_name`))
    const biosVendor = meaningful(await r.text(`${DMI}/bios_vendor`))
    const biosVersion = meaningful(await r.text(`${DMI}/bios_version`))
    const biosDate = meaningful(await r.text(`${DMI}/bios_date`))
    if (boardVendor || boardName || biosVendor || biosVersion) {
      const board = new ObservationBuilder(ID, 'motherboard:main', 'motherboard', [boardVendor, boardName].filter(Boolean).join(' ') || 'Motherboard (model not exposed)', at, {
        sourceProperty: boardName ? `${DMI}/board_name` : 'unavailable',
        evidence: boardName ? 'os_reported' : 'derived'
      })
        .status('ok')
        .field('manufacturer', boardVendor, `${DMI}/board_vendor`)
        .field('model', boardName, `${DMI}/board_name`)
        .prop('board_version', meaningful(await r.text(`${DMI}/board_version`)), `${DMI}/board_version`)
        .prop('bios_vendor', biosVendor, `${DMI}/bios_vendor`)
        .prop('bios_version', biosVersion, `${DMI}/bios_version`)
        .prop('bios_date', biosDate, `${DMI}/bios_date`)
        .prop('ec_firmware_release', meaningful(await r.text(`${DMI}/ec_firmware_release`)), `${DMI}/ec_firmware_release`)
        .prop('boot_mode', (await r.exists('/sys/firmware/efi')) ? 'UEFI' : 'Legacy BIOS', '/sys/firmware/efi', { evidence: 'derived' })
        .rel('system:host', 'logical_parent', 'dmi', { directness: 'inferred', confidence: 0.9 })
      out.push(board.build())
    }
    return finish(ctx, out)
  }
}
