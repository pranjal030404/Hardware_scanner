import type { SysReader } from '@collectors/core/sysreader'
import type { CommandRunner } from '@collectors/core/runner'

export interface PointingStickDevice {
  /** Kernel event node, e.g. "event10". */
  node: string
  name: string
  /** The name the compositor knows this device by. */
  compositorName: string
}

export interface PointingStickStatus {
  /** Whether this session can switch the pointing stick on and off. */
  supported: boolean
  method: 'hyprland' | null
  /** Why switching is not possible (null when supported). */
  reason: string | null
  devices: PointingStickDevice[]
}

export interface PointingStickDeps {
  reader: SysReader
  run: CommandRunner
  env: NodeJS.ProcessEnv
  platform: string
}

/** Hyprland's device naming: lower-case, spaces → '-', repeats of a name get -1, -2… in libinput add order. */
export function hyprlandNames(names: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return names.map((n) => {
    const base = n.toLowerCase().replace(/ /g, '-')
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}-${count}`
  })
}

/** Input event nodes in numeric order, with their names and whether udev tagged them as a pointing stick. */
async function inputNodes(reader: SysReader): Promise<{ node: string; name: string; stick: boolean }[]> {
  const nodes = (await reader.dir('/sys/class/input')).filter((n) => /^event\d+$/.test(n)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
  const out: { node: string; name: string; stick: boolean }[] = []
  for (const node of nodes) {
    const name = (await reader.text(`/sys/class/input/${node}/device/name`))?.trim()
    if (!name) continue
    const dev = (await reader.text(`/sys/class/input/${node}/dev`))?.trim()
    const udev = dev ? await reader.text(`/run/udev/data/c${dev}`) : undefined
    out.push({ node, name, stick: /^E:ID_INPUT_POINTINGSTICK=1$/m.test(udev ?? '') })
  }
  return out
}

/**
 * Switches the laptop pointing stick (TrackPoint-style nub) on or off for the current desktop
 * session. Uses the compositor's per-device switch, so it needs no root and is undone by
 * switching it back on (or by logging out). Only Hyprland is supported today.
 */
export class PointingStickControl {
  constructor(private d: PointingStickDeps) {}

  async status(): Promise<PointingStickStatus> {
    const none = (reason: string, devices: PointingStickDevice[] = []): PointingStickStatus => ({ supported: false, method: null, reason, devices })
    if (this.d.platform !== 'linux') return none('Only supported on Linux')
    const nodes = await inputNodes(this.d.reader)
    const names = hyprlandNames(nodes.map((n) => n.name))
    const devices = nodes.flatMap((n, i) => (n.stick ? [{ node: n.node, name: n.name, compositorName: names[i]! }] : []))
    if (!devices.length) return none('No pointing stick was found on this computer')
    if (!this.d.env['HYPRLAND_INSTANCE_SIGNATURE']) return none('Switching is only supported in a Hyprland session', devices)
    // Only act on names Hyprland actually reports, so a naming mismatch can never switch off another device.
    const r = await this.d.run('hyprctl', ['-j', 'devices'], { timeoutMs: 3000 })
    if (!r.ok) return none(r.notFound ? 'hyprctl was not found' : `hyprctl failed: ${r.stderr.trim() || r.code}`, devices)
    let known: Set<string>
    try {
      known = new Set((JSON.parse(r.stdout) as { mice?: { name: string }[] }).mice?.map((m) => m.name) ?? [])
    } catch {
      return none('Could not read the device list from hyprctl', devices)
    }
    const missing = devices.filter((x) => !known.has(x.compositorName))
    if (missing.length) return none(`Hyprland does not list ${missing.map((m) => m.compositorName).join(', ')}`, devices)
    return { supported: true, method: 'hyprland', reason: null, devices }
  }

  /** Applies the switch; throws with a readable message when it cannot. */
  async setEnabled(enabled: boolean): Promise<PointingStickStatus> {
    const st = await this.status()
    if (!st.supported) throw new Error(st.reason ?? 'Not supported')
    for (const dev of st.devices) {
      const r = await this.d.run('hyprctl', ['keyword', `device[${dev.compositorName}]:enabled`, String(enabled)], { timeoutMs: 3000 })
      if (!r.ok || r.stdout.trim() !== 'ok') throw new Error(`hyprctl could not switch ${dev.compositorName}: ${(r.stdout + r.stderr).trim() || r.code}`)
    }
    return st
  }
}
