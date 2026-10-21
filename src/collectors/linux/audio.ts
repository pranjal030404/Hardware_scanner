import type { DeviceObservation } from '@shared/schemas'
import { ObservationBuilder, type CollectContext } from '../core/context'
import type { Collector } from '../core/types'
import { finish, pciAncestor, pciKey, usbDeviceName, usbKey } from './shared'

const ID = 'linux.audio'

/** `/proc/asound/cards`: ` 0 [PCH            ]: HDA-Intel - HDA Intel PCH` followed by a long-name line. */
export function parseAsoundCards(text: string): { index: number; id: string; driver: string; shortName: string; longName?: string }[] {
  const out: { index: number; id: string; driver: string; shortName: string; longName?: string }[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(\d+)\s+\[(\S+)\s*\]:\s+(\S+)\s+-\s+(.*)$/.exec(lines[i]!)
    if (m) out.push({ index: +m[1]!, id: m[2]!, driver: m[3]!, shortName: m[4]!.trim(), longName: lines[i + 1]?.trim() })
  }
  return out
}

export const linuxAudio: Collector = {
  id: ID,
  version: '1.0.0',
  platforms: ['linux'],
  categories: ['audio'],
  permissions: [],
  method: '/proc/asound/cards + /sys/class/sound',
  timeoutMs: 5000,
  retries: 1,
  isSupported: (ctx) => ctx.reader.exists('/proc/asound/cards') || ctx.reader.exists('/sys/class/sound'),
  async collect(ctx: CollectContext) {
    const r = ctx.reader
    const at = ctx.host.now()
    const text = await r.text('/proc/asound/cards')
    const out: DeviceObservation[] = []
    for (const c of parseAsoundCards(text ?? '')) {
      const base = `/sys/class/sound/card${c.index}`
      const real = await r.real(base)
      const usb = usbDeviceName(real)
      const pci = pciAncestor(real)
      const b = new ObservationBuilder(ID, `audio:card:${c.id}`, 'audio', c.shortName, at, { sourceProperty: '/proc/asound/cards' })
        .status('ok')
        .field('subtype', 'sound_card', 'ALSA card', 'derived')
        .field('driver', c.driver, '/proc/asound/cards')
        .field('busType', usb ? 'USB' : pci ? 'PCI' : undefined, 'sysfs device path', 'derived')
        .field('description', c.longName, '/proc/asound/cards (long name)')
        .id('alsa_card', `card${c.index}`)
        .id('alsa_id', c.id)
        .prop('card_index', c.index, '/proc/asound/cards', { volatile: true })
      if (usb) b.rel(await usbKey(r, usb), 'logical_parent', `${base} (sysfs device path)`)
      else if (pci) b.rel(pciKey(pci), 'logical_parent', `${base} (sysfs device path)`)
      out.push(b.build())
    }
    const lim = [{ kind: 'info' as const, message: 'ALSA cards only. PipeWire/PulseAudio endpoints (sinks, sources, routing) are not yet collected.' }]
    return finish(ctx, out, lim)
  }
}
