import { describe, expect, it } from 'vitest'
import { SysReader } from '@collectors/core/sysreader'
import type { CommandRunner, RunResult } from '@collectors/core/runner'
import { hyprlandNames, PointingStickControl } from '../src/input-control/pointing-stick'
import { tmpRoot, writeTree } from './helpers/fixtures'

const SYNA = 'SYNA30BD:00 06CB:CE08'

/** The EliteBook layout: two pointing-stick nodes and the touchpad share one name. */
function rig(opts: { env?: Record<string, string>; mice?: string[]; keywordOut?: string } = {}) {
  const root = tmpRoot()
  const node = (n: number, name: string, stick: boolean) => ({
    [`sys/class/input/event${n}/device/name`]: `${name}\n`,
    [`sys/class/input/event${n}/dev`]: `13:${64 + n}\n`,
    [`run/udev/data/c13:${64 + n}`]: stick ? 'E:ID_INPUT_MOUSE=1\nE:ID_INPUT_POINTINGSTICK=1\n' : 'E:ID_INPUT_TOUCHPAD=1\n'
  })
  writeTree(root, { ...node(4, 'AT Translated Set 2 keyboard', false), ...node(12, SYNA, false), ...node(10, SYNA, true), ...node(11, SYNA, true) })
  const calls: string[][] = []
  const ok = (stdout: string): RunResult => ({ ok: true, code: 0, stdout, stderr: '', timedOut: false, notFound: false, truncated: false })
  const run: CommandRunner = async (file, args) => {
    calls.push([file, ...args])
    if (args[0] === '-j') return ok(JSON.stringify({ mice: (opts.mice ?? ['syna30bd:00-06cb:ce08', 'syna30bd:00-06cb:ce08-1', 'syna30bd:00-06cb:ce08-2']).map((name) => ({ name })) }))
    return ok(opts.keywordOut ?? 'ok')
  }
  const ctl = new PointingStickControl({ reader: new SysReader(root), run, env: opts.env ?? { HYPRLAND_INSTANCE_SIGNATURE: 'x' }, platform: 'linux' })
  return { ctl, calls }
}

describe('pointing stick control', () => {
  it('names repeated devices the way Hyprland does', () => {
    expect(hyprlandNames(['A b', 'A b', 'C', 'A b'])).toEqual(['a-b', 'a-b-1', 'c', 'a-b-2'])
  })

  it('finds only the udev-tagged pointing-stick nodes, in numeric order, never the touchpad', async () => {
    const st = await rig().ctl.status()
    expect(st).toMatchObject({ supported: true, method: 'hyprland' })
    expect(st.devices.map((d) => [d.node, d.compositorName])).toEqual([['event10', 'syna30bd:00-06cb:ce08'], ['event11', 'syna30bd:00-06cb:ce08-1']])
  })

  it('switches each stick device through hyprctl with an argument vector', async () => {
    const { ctl, calls } = rig()
    await ctl.setEnabled(false)
    expect(calls.filter((c) => c[1] === 'keyword')).toEqual([
      ['hyprctl', 'keyword', 'device[syna30bd:00-06cb:ce08]:enabled', 'false'],
      ['hyprctl', 'keyword', 'device[syna30bd:00-06cb:ce08-1]:enabled', 'false']
    ])
  })

  it('refuses outside Hyprland, when Hyprland does not list the device, or when hyprctl rejects the change', async () => {
    expect(await rig({ env: {} }).ctl.status()).toMatchObject({ supported: false, reason: expect.stringMatching(/Hyprland/) })
    const r = rig({ mice: ['syna30bd:00-06cb:ce08'] })
    await expect(r.ctl.setEnabled(false)).rejects.toThrow(/does not list/)
    expect(r.calls.some((c) => c[1] === 'keyword')).toBe(false)
    await expect(rig({ keywordOut: 'error' }).ctl.setEnabled(false)).rejects.toThrow(/could not switch/)
  })
})
