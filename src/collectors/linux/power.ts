import type { DeviceObservation } from '@shared/schemas'
import { meaningful, ObservationBuilder, type CollectContext } from '../core/context'
import type { Collector } from '../core/types'
import { finish } from './shared'

const ID = 'linux.power'

export const linuxPower: Collector = {
  id: ID,
  version: '1.0.0',
  platforms: ['linux'],
  categories: ['power'],
  permissions: [],
  method: '/sys/class/power_supply',
  timeoutMs: 5000,
  retries: 1,
  isSupported: (ctx) => ctx.reader.exists('/sys/class/power_supply'),
  async collect(ctx: CollectContext) {
    const r = ctx.reader
    const at = ctx.host.now()
    const out: DeviceObservation[] = []
    for (const n of await r.dir('/sys/class/power_supply')) {
      const base = `/sys/class/power_supply/${n}`
      const type = await r.text(`${base}/type`)
      if (!type) continue
      const isBattery = type === 'Battery'
      const energyFull = await r.num(`${base}/energy_full`)
      const energyDesign = await r.num(`${base}/energy_full_design`)
      const chargeFull = await r.num(`${base}/charge_full`)
      const chargeDesign = await r.num(`${base}/charge_full_design`)
      const full = energyFull ?? chargeFull
      const design = energyDesign ?? chargeDesign
      const model = meaningful(await r.text(`${base}/model_name`))
      const b = new ObservationBuilder(ID, `power:${n}`, 'power', model ? `${model} (${n})` : n, at, { sourceProperty: model ? `${base}/model_name` : `${base} (name)` })
        .status('ok')
        .field('subtype', isBattery ? 'battery' : type.toLowerCase(), `${base}/type`)
        .field('manufacturer', meaningful(await r.text(`${base}/manufacturer`)), `${base}/manufacturer`)
        .field('model', model, `${base}/model_name`)
        .id('serial', meaningful(await r.text(`${base}/serial_number`)), true)
        .prop('technology', meaningful(await r.text(`${base}/technology`)), `${base}/technology`)
        .prop('status', await r.text(`${base}/status`), `${base}/status`, { volatile: true })
        .prop('online', isBattery ? undefined : (await r.num(`${base}/online`)) === 1, `${base}/online`, { volatile: true })
        .prop('capacity_percent', await r.num(`${base}/capacity`), `${base}/capacity`, { unit: '%', volatile: true, evidence: 'measured' })
        .prop('cycle_count', await r.num(`${base}/cycle_count`), `${base}/cycle_count`, { volatile: true })
        .prop('voltage_now', (await r.num(`${base}/voltage_now`)) !== undefined ? (await r.num(`${base}/voltage_now`))! / 1_000_000 : undefined, `${base}/voltage_now`, { unit: 'V', volatile: true, evidence: 'measured' })
        .prop('design_capacity', design !== undefined ? design / 1_000_000 : undefined, `${base}/${energyDesign !== undefined ? 'energy' : 'charge'}_full_design`, { unit: energyDesign !== undefined ? 'Wh' : 'Ah' })
        .prop('full_capacity', full !== undefined ? full / 1_000_000 : undefined, `${base}/${energyFull !== undefined ? 'energy' : 'charge'}_full`, { unit: energyFull !== undefined ? 'Wh' : 'Ah', volatile: true })
        .prop('health_percent', full && design ? Math.round((full / design) * 1000) / 10 : undefined, 'full / design capacity', { unit: '%', volatile: true, evidence: 'derived' })
      out.push(b.build())
    }
    return finish(ctx, out)
  }
}
