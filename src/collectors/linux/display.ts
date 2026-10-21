import type { DeviceObservation } from '@shared/schemas'
import { ObservationBuilder, type CollectContext } from '../core/context'
import { parseEdid } from '../core/edid'
import type { Collector } from '../core/types'
import { finish, pciAncestor, pciKey } from './shared'

const ID = 'linux.display'

export const linuxDisplay: Collector = {
  id: ID,
  version: '1.0.0',
  platforms: ['linux'],
  categories: ['display'],
  permissions: [],
  method: '/sys/class/drm connectors + EDID blocks',
  timeoutMs: 8000,
  retries: 1,
  isSupported: (ctx) => ctx.reader.exists('/sys/class/drm'),
  async collect(ctx: CollectContext) {
    const r = ctx.reader
    const at = ctx.host.now()
    const out: DeviceObservation[] = []
    const entries = (await r.dir('/sys/class/drm')).filter((n) => /^card\d+-.+/.test(n))
    for (const n of entries) {
      const base = `/sys/class/drm/${n}`
      const status = await r.text(`${base}/status`)
      if (status !== 'connected') continue
      const connector = n.replace(/^card\d+-/, '')
      const edid = parseEdid(await r.bytes(`${base}/edid`))
      const modes = ((await r.text(`${base}/modes`)) ?? '').split('\n').filter(Boolean)
      const real = await r.real(base)
      const gpu = pciAncestor(real)
      const name = edid?.name ?? (edid ? `${edid.manufacturerId} display` : `Display on ${connector}`)
      const key = edid ? `display:${edid.manufacturerId}:${edid.productCode}:${connector}` : `display:conn:${n}`
      const b = new ObservationBuilder(ID, key, 'display', name, at, {
        sourceProperty: edid?.name ? `${base}/edid monitor name descriptor` : edid ? `${base}/edid manufacturer id` : `${base} (connector)`,
        evidence: edid ? 'os_reported' : 'derived'
      })
        .status((await r.text(`${base}/enabled`)) === 'disabled' ? 'disabled' : 'ok')
        .field('manufacturer', edid?.manufacturerId, `${base}/edid manufacturer id`)
        .field('model', edid?.name, `${base}/edid monitor name`)
        .field('busType', connector.replace(/-\d+$/, ''), `${base} (connector type)`, 'derived')
        .field('subtype', /^(eDP|LVDS|DSI)/.test(connector) ? 'internal_panel' : 'external_display', 'connector type', 'derived')
        .id('connector', connector)
        .id('serial', edid?.serialText, true)
        .id('edid_product', edid ? `${edid.manufacturerId}:${edid.productCode.toString(16).padStart(4, '0')}` : undefined)
        .prop('connector', connector, base)
        .prop('edid_version', edid?.version, `${base}/edid`)
        .prop('manufacture_year', edid?.year, `${base}/edid`)
        .prop('manufacture_week', edid?.week, `${base}/edid`)
        .prop('width_cm', edid?.widthCm, `${base}/edid`, { unit: 'cm' })
        .prop('height_cm', edid?.heightCm, `${base}/edid`, { unit: 'cm' })
        .prop('diagonal_in', edid?.widthCm && edid.heightCm ? Math.round((Math.hypot(edid.widthCm, edid.heightCm) / 2.54) * 10) / 10 : undefined, `${base}/edid`, { unit: 'in', evidence: 'derived' })
        .prop('preferred_resolution', edid?.preferredMode ? `${edid.preferredMode.width}x${edid.preferredMode.height}` : modes[0], edid?.preferredMode ? `${base}/edid detailed timing #1` : `${base}/modes (first entry)`)
        .prop('preferred_refresh', edid?.preferredMode?.refreshHz, `${base}/edid detailed timing #1`, { unit: 'Hz', evidence: 'derived' })
        .prop('mode_count', modes.length || undefined, `${base}/modes`)
        .prop('enabled', await r.text(`${base}/enabled`), `${base}/enabled`, { volatile: true })
      if (gpu) b.rel(pciKey(gpu), 'display_connection', `${base} (sysfs device path)`)
      out.push(b.build())
    }
    const limits = []
    if (out.length) limits.push({ kind: 'info' as const, message: 'Active mode and refresh rate are compositor state and are not exposed in sysfs; the preferred mode from EDID is shown instead.' })
    return finish(ctx, out, limits)
  }
}
