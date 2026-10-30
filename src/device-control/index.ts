import type { SysReader } from '@collectors/core/sysreader'
import type { CommandRunner } from '@collectors/core/runner'
import type { DeviceControlItem, InputRole } from '../device-test/types'

export interface DeviceControlDeps {
  reader: SysReader
  run: CommandRunner
  env: NodeJS.ProcessEnv
  platform: string
  /** Input group ids switched off in Settings. */
  disabledInputs: () => readonly string[]
}

export interface InputNode {
  node: string
  name: string
  role: InputRole | null
}

export interface InputGroup {
  id: string
  label: string
  role: InputRole
  nodes: string[]
  /** Names the compositor knows the group's devices by. */
  compositorNames: string[]
}

const POINTERS: readonly InputRole[] = ['mouse', 'touchpad', 'pointing stick', 'touchscreen', 'tablet']

/** udev's classification of an input node (most specific first). */
export function roleFromUdev(udev: string): InputRole | null {
  const has = (p: string): boolean => new RegExp(`^E:ID_INPUT_${p}=1$`, 'm').test(udev)
  if (has('POINTINGSTICK')) return 'pointing stick'
  if (has('TOUCHPAD')) return 'touchpad'
  if (has('TOUCHSCREEN')) return 'touchscreen'
  if (has('TABLET')) return 'tablet'
  if (has('JOYSTICK')) return 'game controller'
  if (has('MOUSE')) return 'mouse'
  if (has('KEYBOARD')) return 'keyboard'
  return null
}

/** Input event nodes in numeric order with their names and udev roles. */
export async function inputNodes(reader: SysReader): Promise<InputNode[]> {
  const nodes = (await reader.dir('/sys/class/input')).filter((n) => /^event\d+$/.test(n)).sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)))
  const out: InputNode[] = []
  for (const node of nodes) {
    const name = (await reader.text(`/sys/class/input/${node}/device/name`))?.trim()
    if (!name) continue
    const dev = (await reader.text(`/sys/class/input/${node}/dev`))?.trim()
    const udev = dev ? ((await reader.text(`/run/udev/data/c${dev}`)) ?? '') : ''
    out.push({ node, name, role: roleFromUdev(udev) })
  }
  return out
}

/** Hyprland's device naming: lower-case, spaces → '-'. Repeats get -1, -2… */
export const hyprlandBase = (name: string): string => name.toLowerCase().replace(/ /g, '-')

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Groups user-facing input nodes into switchable units. Nodes sharing a name share one switch when
 * they have the same role. When one name covers different roles (a touchpad and a pointing stick on
 * one controller), compositor names are paired with kernel nodes by order, which is only trusted
 * when both sides have the same count.
 */
export function groupInputs(nodes: readonly InputNode[], compositor: readonly string[]): { groups: InputGroup[]; unmatched: { label: string; reason: string }[] } {
  const byBase = new Map<string, InputNode[]>()
  for (const n of nodes) {
    const b = hyprlandBase(n.name)
    byBase.set(b, [...(byBase.get(b) ?? []), n])
  }
  const groups: InputGroup[] = []
  const unmatched: { label: string; reason: string }[] = []
  for (const [base, members] of byBase) {
    const roles = [...new Set(members.map((m) => m.role).filter((r): r is InputRole => r !== null))]
    if (!roles.length) continue
    const re = new RegExp(`^${escapeRe(base)}(-(\\d+))?$`)
    const names = compositor.filter((c) => re.test(c)).sort((a, b) => Number(re.exec(a)![2] ?? 0) - Number(re.exec(b)![2] ?? 0))
    const label = members[0]!.name
    if (!names.length) { unmatched.push({ label, reason: 'The compositor does not list this device' }); continue }
    if (roles.length === 1) {
      groups.push({ id: `input:${base}:${roles[0]}`, label, role: roles[0]!, nodes: members.filter((m) => m.role).map((m) => m.node), compositorNames: names })
      continue
    }
    if (names.length !== members.length) {
      unmatched.push({ label, reason: `One name covers ${roles.join(' and ')}, and the compositor's device list cannot be matched to them safely` })
      continue
    }
    for (const role of roles) {
      const idx = members.flatMap((m, i) => (m.role === role ? [i] : []))
      groups.push({ id: `input:${base}:${role}`, label, role, nodes: idx.map((i) => members[i]!.node), compositorNames: idx.map((i) => names[i]!) })
    }
  }
  return { groups, unmatched }
}

interface Radio { idx: number; type: string; device: string; soft: string; hard: string }

/**
 * Switches individual devices on and off without root: input devices through the Hyprland
 * compositor, wireless radios through rfkill. Never switches off the last working keyboard or
 * pointer, so the user cannot lock themselves out.
 */
export class DeviceControl {
  constructor(private d: DeviceControlDeps) {}

  private async compositor(): Promise<{ names: string[] } | { reason: string }> {
    if (this.d.platform !== 'linux') return { reason: 'Only supported on Linux' }
    if (!this.d.env['HYPRLAND_INSTANCE_SIGNATURE']) return { reason: 'Switching input devices is only supported in a Hyprland session' }
    const r = await this.d.run('hyprctl', ['-j', 'devices'], { timeoutMs: 3000 })
    if (!r.ok) return { reason: r.notFound ? 'hyprctl was not found' : `hyprctl failed: ${r.stderr.trim() || r.code}` }
    try {
      const j = JSON.parse(r.stdout) as Record<string, { name: string }[] | undefined>
      return { names: ['keyboards', 'mice', 'touch', 'tablets'].flatMap((k) => (j[k] ?? []).map((x) => x.name)) }
    } catch {
      return { reason: 'Could not read the device list from hyprctl' }
    }
  }

  async inputGroups(): Promise<{ groups: InputGroup[]; reason: string | null; unmatched: { label: string; reason: string }[] }> {
    const c = await this.compositor()
    if ('reason' in c) return { groups: [], reason: c.reason, unmatched: [] }
    const { groups, unmatched } = groupInputs(await inputNodes(this.d.reader), c.names)
    return { groups, reason: null, unmatched }
  }

  private async radios(): Promise<Radio[] | { reason: string }> {
    if (this.d.platform !== 'linux') return { reason: 'Only supported on Linux' }
    const r = await this.d.run('rfkill', ['-J', '-o', 'ID,TYPE,DEVICE,SOFT,HARD'], { timeoutMs: 3000 })
    if (!r.ok) return { reason: r.notFound ? 'rfkill was not found' : `rfkill failed: ${r.stderr.trim() || r.code}` }
    try {
      const j = JSON.parse(r.stdout || '{}') as { rfkilldevices?: { id: number; type: string; device: string; soft: string; hard: string }[] }
      return (j.rfkilldevices ?? []).map((x) => ({ idx: x.id, type: x.type, device: x.device, soft: x.soft, hard: x.hard }))
    } catch {
      return { reason: 'Could not read rfkill output' }
    }
  }

  async list(): Promise<{ items: DeviceControlItem[]; notes: string[] }> {
    const off = new Set(this.d.disabledInputs())
    const notes: string[] = []
    const items: DeviceControlItem[] = []
    const inputs = await this.inputGroups()
    if (inputs.reason) notes.push(inputs.reason)
    for (const u of inputs.unmatched) notes.push(`${u.label}: ${u.reason}`)
    for (const g of inputs.groups) {
      items.push({ id: g.id, kind: 'input', label: g.label, role: g.role, enabled: !off.has(g.id), controllable: true, reason: null, method: `Hyprland (${g.compositorNames.join(', ')}; ${g.nodes.join(', ')})` })
    }
    const radios = await this.radios()
    if ('reason' in radios) notes.push(radios.reason)
    else {
      for (const r of radios) {
        const hard = r.hard === 'blocked'
        items.push({
          id: `radio:${r.type}:${r.device}`, kind: 'radio', label: r.type === 'wlan' ? 'Wi-Fi' : r.type === 'bluetooth' ? 'Bluetooth' : r.type, role: `${r.type} radio (${r.device})`,
          enabled: r.soft !== 'blocked' && !hard, controllable: !hard, reason: hard ? 'Blocked by a hardware switch or firmware key; use the laptop\'s wireless key' : null, method: 'rfkill'
        })
      }
    }
    return { items, notes }
  }

  /** Switches one device. Returns the new disabled-input list for the caller to persist (unchanged for radios). */
  async set(id: string, enabled: boolean): Promise<string[]> {
    const off = new Set(this.d.disabledInputs())
    if (id.startsWith('radio:')) {
      const radios = await this.radios()
      if ('reason' in radios) throw new Error(radios.reason)
      const r = radios.find((x) => `radio:${x.type}:${x.device}` === id)
      if (!r) throw new Error('That radio is no longer present')
      const res = await this.d.run('rfkill', [enabled ? 'unblock' : 'block', String(r.idx)], { timeoutMs: 3000 })
      if (!res.ok) throw new Error(`rfkill could not switch ${r.device}: ${res.stderr.trim() || res.code}`)
      return [...off]
    }
    const { groups, reason } = await this.inputGroups()
    if (reason) throw new Error(reason)
    const g = groups.find((x) => x.id === id)
    if (!g) throw new Error('That input device is not connected')
    if (!enabled) {
      const after = groups.filter((x) => x.id !== id && !off.has(x.id))
      if (g.role === 'keyboard' && !after.some((x) => x.role === 'keyboard')) throw new Error('This is the only keyboard still switched on; switching it off would leave no way to type')
      if (POINTERS.includes(g.role) && !after.some((x) => POINTERS.includes(x.role))) throw new Error('This is the only pointing device still switched on; switching it off would leave no way to move the cursor')
    }
    await this.apply(g, enabled)
    if (enabled) off.delete(id)
    else off.add(id)
    return [...off]
  }

  private async apply(g: InputGroup, enabled: boolean): Promise<void> {
    for (const name of g.compositorNames) {
      const r = await this.d.run('hyprctl', ['keyword', `device[${name}]:enabled`, String(enabled)], { timeoutMs: 3000 })
      if (!r.ok || r.stdout.trim() !== 'ok') throw new Error(`hyprctl could not switch ${name}: ${(r.stdout + r.stderr).trim() || r.code}`)
    }
  }

  /** Re-applies saved "off" switches: the compositor forgets them on logout and when a device is re-plugged. */
  async reapply(): Promise<void> {
    const off = new Set(this.d.disabledInputs())
    if (!off.size) return
    const { groups, reason } = await this.inputGroups()
    if (reason) return
    for (const g of groups) if (off.has(g.id)) await this.apply(g, false)
  }
}
