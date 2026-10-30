import { describe, expect, it } from 'vitest'
import { SysReader } from '@collectors/core/sysreader'
import type { CommandRunner, RunResult } from '@collectors/core/runner'
import { DeviceControl, groupInputs, roleFromUdev, type InputNode } from '../src/device-control'
import { DeviceTester } from '../src/device-test/engine'
import { PathBuilder } from '../src/device-test/path'
import { EVENT_SIZE, hasBit, InputAggregator, parseBitmap, parseEvents, type InputEvent } from '../src/device-test/evdev'
import { classify, failedAttempts, parseKernelLog, STORAGE_PROBLEMS, USB_PROBLEMS, usbLines } from '../src/device-test/kernel-log'
import type { InteractiveInfo, LiveState, PathNode } from '../src/device-test/types'
import { liveFindings, tiles } from '../src/renderer/pages/device-test-logic'
import { tmpRoot, writeTree, type Tree } from './helpers/fixtures'

const ok = (stdout: string): RunResult => ({ ok: true, code: 0, stdout, stderr: '', timedOut: false, notFound: false, truncated: false })
const SYNA = 'SYNA30BD:00 06CB:CE08'

describe('input grouping for device switches', () => {
  const n = (node: string, name: string, role: InputNode['role']): InputNode => ({ node, name, role })

  it('reads udev roles, most specific first', () => {
    expect(roleFromUdev('E:ID_INPUT_MOUSE=1\nE:ID_INPUT_POINTINGSTICK=1\n')).toBe('pointing stick')
    expect(roleFromUdev('E:ID_INPUT_KEY=1\n')).toBeNull()
    expect(roleFromUdev('E:ID_INPUT_KEY=1\nE:ID_INPUT_KEYBOARD=1\n')).toBe('keyboard')
  })

  it('splits one controller into pointing stick and touchpad by order, and merges same-role nodes', () => {
    const { groups } = groupInputs(
      [n('event4', 'AT Translated Set 2 keyboard', 'keyboard'), n('event5', 'Combo', 'keyboard'), n('event9', 'Combo', null), n('event10', SYNA, 'pointing stick'), n('event11', SYNA, 'pointing stick'), n('event12', SYNA, 'touchpad'), n('event2', 'Power Button', null)],
      ['at-translated-set-2-keyboard', 'combo', 'syna30bd:00-06cb:ce08', 'syna30bd:00-06cb:ce08-1', 'syna30bd:00-06cb:ce08-2', 'power-button']
    )
    expect(groups.map((g) => [g.id, g.compositorNames])).toEqual([
      ['input:at-translated-set-2-keyboard:keyboard', ['at-translated-set-2-keyboard']],
      ['input:combo:keyboard', ['combo']],
      ['input:syna30bd:00-06cb:ce08:pointing stick', ['syna30bd:00-06cb:ce08', 'syna30bd:00-06cb:ce08-1']],
      ['input:syna30bd:00-06cb:ce08:touchpad', ['syna30bd:00-06cb:ce08-2']]
    ])
  })

  it('refuses to guess when mixed roles cannot be paired one to one', () => {
    const r = groupInputs([n('event10', SYNA, 'pointing stick'), n('event12', SYNA, 'touchpad')], ['syna30bd:00-06cb:ce08'])
    expect(r.groups).toEqual([])
    expect(r.unmatched[0]!.reason).toMatch(/cannot be matched to them safely/)
  })
})

describe('DeviceControl', () => {
  function rig(disabled: string[] = []) {
    const root = tmpRoot()
    const node = (num: number, name: string, udev: string): Tree => ({ [`sys/class/input/event${num}/device/name`]: name, [`sys/class/input/event${num}/dev`]: `13:${64 + num}`, [`run/udev/data/c13:${64 + num}`]: udev })
    writeTree(root, { ...node(4, 'Kbd', 'E:ID_INPUT_KEYBOARD=1\n'), ...node(6, 'Mouse', 'E:ID_INPUT_MOUSE=1\n'), ...node(12, 'Pad', 'E:ID_INPUT_TOUCHPAD=1\n') })
    const calls: string[][] = []
    const run: CommandRunner = async (file, args) => {
      calls.push([file, ...args])
      if (file === 'hyprctl' && args[0] === '-j') return ok(JSON.stringify({ keyboards: [{ name: 'kbd' }], mice: [{ name: 'mouse' }, { name: 'pad' }] }))
      if (file === 'rfkill' && args[0] === '-J') return ok(JSON.stringify({ rfkilldevices: [{ id: 1, type: 'wlan', device: 'phy0', soft: 'unblocked', hard: 'unblocked' }, { id: 0, type: 'bluetooth', device: 'hci0', soft: 'blocked', hard: 'blocked' }] }))
      return ok('ok')
    }
    let off = disabled
    const ctl = new DeviceControl({ reader: new SysReader(root), run, env: { HYPRLAND_INSTANCE_SIGNATURE: 'x' }, platform: 'linux', disabledInputs: () => off })
    return { ctl, calls, setOff: (x: string[]) => (off = x) }
  }

  it('lists inputs and radios with their state; hardware-blocked radios cannot be switched', async () => {
    const { items } = await rig(['input:mouse:mouse']).ctl.list()
    expect(items.map((i) => [i.id, i.enabled, i.controllable])).toEqual([
      ['input:kbd:keyboard', true, true], ['input:mouse:mouse', false, true], ['input:pad:touchpad', true, true],
      ['radio:wlan:phy0', true, true], ['radio:bluetooth:hci0', false, false]
    ])
  })

  it('switches an input through hyprctl and returns the new disabled list', async () => {
    const r = rig()
    expect(await r.ctl.set('input:pad:touchpad', false)).toEqual(['input:pad:touchpad'])
    expect(r.calls.at(-1)).toEqual(['hyprctl', 'keyword', 'device[pad]:enabled', 'false'])
  })

  it('never switches off the last keyboard or the last pointer', async () => {
    await expect(rig().ctl.set('input:kbd:keyboard', false)).rejects.toThrow(/only keyboard/)
    await expect(rig(['input:mouse:mouse']).ctl.set('input:pad:touchpad', false)).rejects.toThrow(/only pointing device/)
  })

  it('switches radios through rfkill by their current index', async () => {
    const r = rig()
    await r.ctl.set('radio:wlan:phy0', false)
    expect(r.calls.at(-1)).toEqual(['rfkill', 'block', '1'])
  })

  it('re-applies saved switches', async () => {
    const r = rig(['input:mouse:mouse'])
    await r.ctl.reapply()
    expect(r.calls.filter((c) => c[1] === 'keyword')).toEqual([['hyprctl', 'keyword', 'device[mouse]:enabled', 'false']])
  })
})

describe('kernel log interpretation', () => {
  const log = parseKernelLog([
    '2026-10-27T05:00:00+0530 host kernel: nvme nvme0: pci function 0000:55:00.0',
    '2026-10-27T05:01:00+0530 host kernel: usb 3-2: new full-speed USB device number 9 using xhci_hcd',
    '2026-10-27T05:01:01+0530 host kernel: usb 3-2: device descriptor read/64, error -71',
    '2026-10-27T05:01:03+0530 host kernel: usb usb3-port2: unable to enumerate USB device',
    '2026-10-27T05:02:00+0530 host kernel: usb 3-1.2: new full-speed USB device number 10 using xhci_hcd',
    '2026-10-27T05:02:00+0530 host other: not kernel'
  ].join('\n'))

  it('parses only kernel lines and finds a device and its port', () => {
    expect(log).toHaveLength(5)
    expect(usbLines(log, '3-2').map((l) => l.text)).toEqual([
      'usb 3-2: new full-speed USB device number 9 using xhci_hcd', 'usb 3-2: device descriptor read/64, error -71', 'usb usb3-port2: unable to enumerate USB device'
    ])
    expect(usbLines(log, '3-1')).toEqual([]) // 3-1.2 is a different device
  })

  it('reports failed connection attempts with a plain explanation', () => {
    const a = failedAttempts(log, () => false)
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ port: '3-2', nowPresent: false, explanation: expect.stringMatching(/could not talk to it/) })
  })

  it('does not report an error that a successful retry on the same port followed', () => {
    const retried = parseKernelLog([
      '2026-10-29T11:22:19+05:30 fedora kernel: usb 3-5: new full-speed USB device number 8 using xhci_hcd',
      '2026-10-29T11:22:19+05:30 fedora kernel: usb 3-5: device descriptor read/64, error -71',
      '2026-10-29T11:22:20+05:30 fedora kernel: usb 3-5: New USB device found, idVendor=0020, idProduct=0b21, bcdDevice= 1.00',
      '2026-10-29T11:47:07+05:30 fedora kernel: usb 3-5: USB disconnect, device number 8'
    ].join('\n'))
    expect(failedAttempts(retried, () => false)).toEqual([])
    // A new failure after the device left is reported again.
    const again = parseKernelLog('2026-10-29T12:00:00+05:30 fedora kernel: usb 3-5: device descriptor read/64, error -71')
    expect(failedAttempts([...retried, ...again], () => false)).toHaveLength(1)
  })

  it('does not mistake "pci function" for an uncorrectable-read (UNC) error', () => {
    expect(classify(log, STORAGE_PROBLEMS)).toEqual([])
    expect(classify(parseKernelLog('2026-10-27T05:00:00+0530 h kernel: ata1.00: error: { UNC }'), STORAGE_PROBLEMS)).toHaveLength(1)
    expect(classify(usbLines(log, '3-2'), USB_PROBLEMS).map((x) => x.problem.severity)).toEqual(['fail', 'fail'])
  })
})

describe('evdev decoding', () => {
  it('parses capability bitmaps (most significant word first)', () => {
    const m = parseBitmap('1f0000 0 0 0 0')
    expect(hasBit(m, 0x110)).toBe(true) // BTN_LEFT
    expect(hasBit(m, 0x115)).toBe(false)
    expect(hasBit(parseBitmap('143'), 8)).toBe(true) // REL_WHEEL
  })

  it('parses 24-byte input_event records', () => {
    const b = Buffer.alloc(EVENT_SIZE * 2)
    b.writeBigInt64LE(5n, 0); b.writeBigInt64LE(250n, 8); b.writeUInt16LE(2, 16); b.writeUInt16LE(0, 18); b.writeInt32LE(-3, 20)
    b.writeBigInt64LE(5n, 24); b.writeBigInt64LE(251n, 32); b.writeUInt16LE(1, 40); b.writeUInt16LE(0x110, 42); b.writeInt32LE(1, 44)
    expect(parseEvents(b)).toEqual([{ t: 5_000_250, type: 2, code: 0, value: -3 }, { t: 5_000_251, type: 1, code: 0x110, value: 1 }])
  })

  it('counts motion, wheel, presses and detects a bouncing switch', () => {
    const a = new InputAggregator([0x110, 0x111], false)
    const ev = (t: number, type: number, code: number, value: number): InputEvent => ({ t, type, code, value })
    a.push(ev(1_000_000, 2, 0, -30)); a.push(ev(1_008_000, 2, 1, 20)); a.push(ev(1_016_000, 2, 8, 1))
    a.push(ev(2_000_000, 1, 0x110, 1)); a.push(ev(2_080_000, 1, 0x110, 0))
    a.push(ev(2_090_000, 1, 0x110, 1)); a.push(ev(2_150_000, 1, 0x110, 0)) // 10 ms after release: bounce
    a.push(ev(3_000_000, 1, 0x110, 1)); a.push(ev(3_100_000, 1, 0x110, 0)) // a human double click
    const s = a.state(4_000_000)
    expect(s.motion).toMatchObject({ left: 30, down: 20 })
    expect(s.wheel.up).toBe(1)
    expect(s.buttons[0]).toMatchObject({ name: 'Left button', presses: 3, chatter: 1 })
    expect(s.buttons[1]).toMatchObject({ presses: 0 })
  })

  it('measures drift in a hold-still window and flags held-down buttons as stuck', () => {
    const a = new InputAggregator([0x110], true)
    a.startStill(3000, 10_000_000)
    a.push({ t: 10_500_000, type: 2, code: 0, value: 12 })
    a.push({ t: 11_000_000, type: 2, code: 1, value: -9 })
    a.push({ t: 11_000_000, type: 1, code: 30, value: 1 }) // "A" pressed and never released
    a.push({ t: 11_000_000, type: 1, code: 0x110, value: 1 })
    const s = a.state(25_000_000)
    expect(s.still).toEqual({ phase: 'done', motion: 21, events: 2 })
    expect(s.keys).toEqual(['A'])
    expect(s.stuck.sort()).toEqual(['A', 'Left button'])
  })
})

describe('hands-on findings', () => {
  const info: InteractiveInfo = { available: true, reason: null, nodes: ['event6'], buttons: ['Left button', 'Right button'], hasMotion: true, hasWheel: true, hasHWheel: false, hasTouch: false, isKeyboard: false }
  const base: LiveState = {
    sessionId: 's', running: true, stoppedReason: null, elapsedMs: 10_000, limitMs: 120_000, events: 0, dropped: 0,
    motion: { left: 0, right: 0, up: 0, down: 0, events: 0 }, wheel: { up: 0, down: 0, left: 0, right: 0 },
    buttons: [{ name: 'Left button', presses: 0, chatter: 0, down: false, heldMs: 0 }, { name: 'Right button', presses: 0, chatter: 0, down: false, heldMs: 0 }],
    touch: { touches: 0, maxFingers: 0, travel: 0 }, keys: [], keyPresses: 0, untried: [], stuck: [], reportRateHz: null, maxMotionGapMs: null,
    still: { phase: 'idle', motion: 0, events: 0 }, errors: []
  }

  it('explains a device that is detected but sends nothing', () => {
    expect(liveFindings(info, base)[0]).toMatchObject({ status: 'fail', title: 'No signal from the device', detail: expect.stringMatching(/battery/) })
  })

  it('reports a worn switch, drift and what has not been tried', () => {
    const s: LiveState = { ...base, events: 400, motion: { left: 100, right: 100, up: 90, down: 5, events: 300 }, buttons: [{ name: 'Left button', presses: 9, chatter: 4, down: false, heldMs: 0 }, base.buttons[1]!], still: { phase: 'done', motion: 60, events: 12 } }
    const f = liveFindings(info, s)
    expect(f.map((x) => [x.status, x.title])).toEqual([
      ['fail', 'Left button double-clicks by itself'], ['fail', 'Pointer drifts on its own'], ['info', 'Not tried yet']
    ])
    expect(f[2]!.detail).toMatch(/move down, press right button, scroll up, scroll down/)
    expect(tiles(info, s).find((t) => t.key === 'Left button')).toMatchObject({ done: true, bad: 'double-fired 4×' })
  })
})

describe('DeviceTester on a fixture machine', () => {
  function machine(log: string) {
    const root = tmpRoot()
    const usb = 'sys/devices/pci0000:00/0000:00:14.0/usb3'
    writeTree(root, {
      // A USB mouse on 3-1, working.
      [`${usb}/3-1/idVendor`]: '046d', [`${usb}/3-1/idProduct`]: 'c077', [`${usb}/3-1/product`]: 'USB Optical Mouse', [`${usb}/3-1/manufacturer`]: 'Logitech',
      [`${usb}/3-1/bConfigurationValue`]: '1', [`${usb}/3-1/speed`]: '1.5', [`${usb}/3-1/version`]: ' 2.00', [`${usb}/3-1/bMaxPower`]: '100mA', [`${usb}/3-1/bDeviceClass`]: '00',
      [`${usb}/3-1/3-1:1.0/bInterfaceClass`]: '03', [`${usb}/3-1/3-1:1.0/driver`]: { link: 'sys/bus/usb/drivers/usbhid' },
      [`${usb}/3-1/3-1:1.0/0003:046D:C077.0001/input/input5/event6/device`]: { link: `${usb}/3-1/3-1:1.0/0003:046D:C077.0001/input/input5` },
      [`${usb}/3-1/3-1:1.0/0003:046D:C077.0001/input/input5/name`]: 'Logitech USB Optical Mouse',
      [`${usb}/3-1/3-1:1.0/0003:046D:C077.0001/input/input5/capabilities/key`]: '70000 0 0 0 0',
      [`${usb}/3-1/3-1:1.0/0003:046D:C077.0001/input/input5/capabilities/rel`]: '143',
      [`${usb}/3-1/3-1:1.0/0003:046D:C077.0001/input/input5/capabilities/abs`]: '0',
      [`${usb}/3-1/3-1:1.0/0003:046D:C077.0001/input/input5/event6/dev`]: '13:70',
      'sys/class/input/event6': { link: `${usb}/3-1/3-1:1.0/0003:046D:C077.0001/input/input5/event6` },
      'run/udev/data/c13:70': 'E:ID_INPUT_MOUSE=1\n',
      // A device on 3-2 that enumerated but never got configured.
      [`${usb}/3-2/idVendor`]: '1234', [`${usb}/3-2/idProduct`]: '5678', [`${usb}/3-2/bConfigurationValue`]: '', [`${usb}/3-2/speed`]: '12', [`${usb}/3-2/version`]: ' 2.00', [`${usb}/3-2/bMaxPower`]: '0mA',
      'sys/bus/usb/devices/3-1': { link: `${usb}/3-1` },
      'sys/bus/usb/devices/3-2': { link: `${usb}/3-2` },
      'sys/bus/usb/drivers/usbhid/.keep': '',
      'dev/input/event6': '',
      [`${usb}/3-1/3-1:1.0/0003:046D:C077.0001/power_supply/hidpp_battery_0/scope`]: 'Device\n',
      [`${usb}/3-1/3-1:1.0/0003:046D:C077.0001/power_supply/hidpp_battery_0/model_name`]: 'Wireless Mouse\n',
      [`${usb}/3-1/3-1:1.0/0003:046D:C077.0001/power_supply/hidpp_battery_0/capacity_level`]: 'Low\n',
      [`${usb}/3-1/3-1:1.0/0003:046D:C077.0001/power_supply/hidpp_battery_0/online`]: '1\n',
      'sys/class/power_supply/hidpp_battery_0': { link: `${usb}/3-1/3-1:1.0/0003:046D:C077.0001/power_supply/hidpp_battery_0` }
    })
    const run: CommandRunner = async (file) => (file === 'journalctl' ? ok(log) : { ...ok(''), ok: false, notFound: true })
    return new DeviceTester({ reader: new SysReader(root), run, platform: 'linux', disabledInputNodes: async () => ['event6'], devInput: `${root}/dev/input`, canAccess: async () => true })
  }

  it('lists USB devices with their input nodes and reports failed attempts on empty ports', async () => {
    const t = machine('2026-10-27T05:01:01+0530 h kernel: usb 3-4: device not accepting address 7, error -71\n')
    const list = await t.targets()
    expect(list.targets.map((x) => [x.id, x.label, x.inputNodes, x.roles])).toEqual([
      ['usb:3-1', 'USB Optical Mouse', ['event6'], ['mouse']],
      ['usb:3-2', 'USB device 1234:5678', [], []]
    ])
    expect(list.attempts).toMatchObject([{ port: '3-4', nowPresent: false }])
  })

  it('passes a healthy mouse but notes it is switched off, and offers the hands-on test', async () => {
    const r = await machine('').run('usb:3-1')
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c.status]))
    expect(by).toMatchObject({ 'usb.detected': 'pass', 'usb.configured': 'pass', 'usb.drivers': 'pass', 'usb.power': 'pass', kernel: 'pass', 'input.enabled': 'warn', 'input.access': 'pass', 'wireless.battery': 'warn' })
    expect(r.checks.find((c) => c.id === 'wireless.battery')).toMatchObject({ title: 'Battery of Wireless Mouse', summary: expect.stringMatching(/low \("Low"\)/) })
    expect(r.interactive).toMatchObject({ available: true, buttons: ['Left button', 'Right button', 'Middle button (wheel click)'], hasMotion: true, hasWheel: true })
    expect(r.verdict.status).toBe('warn')
  })

  it('explains why an unconfigured device with protocol errors does not work', async () => {
    const r = await machine([
      '2026-10-27T05:01:00+0530 h kernel: usb 3-2: new full-speed USB device number 9 using xhci_hcd',
      '2026-10-27T05:01:01+0530 h kernel: usb 3-2: device descriptor read/64, error -71'
    ].join('\n')).run('usb:3-2')
    expect(r.verdict.status).toBe('fail')
    expect(r.checks.find((c) => c.id === 'usb.configured')).toMatchObject({ status: 'fail' })
    expect(r.checks.find((c) => c.id === 'kernel')).toMatchObject({ status: 'fail', summary: expect.stringMatching(/protocol error/) })
  })
})

describe('connection map', () => {
  it('shows only this device: its parents from the PCI root and everything below it', async () => {
    const root = tmpRoot()
    const usb = 'sys/devices/pci0000:00/0000:00:14.0/usb3'
    writeTree(root, {
      'sys/devices/pci0000:00/0000:00:14.0/class': '0x0c0330\n', 'sys/devices/pci0000:00/0000:00:14.0/vendor': '0x8086\n', 'sys/devices/pci0000:00/0000:00:14.0/device': '0xa0ed\n',
      'sys/devices/pci0000:00/0000:00:14.0/current_link_speed': 'Unknown\n',
      [`${usb}/version`]: ' 2.00\n', [`${usb}/3-4/product`]: 'USB Receiver\n', [`${usb}/3-4/idVendor`]: '046d\n', [`${usb}/3-4/idProduct`]: 'c534\n', [`${usb}/3-4/speed`]: '12\n',
      [`${usb}/3-4/3-4:1.1/bInterfaceClass`]: '03\n',
      [`${usb}/3-4/3-4:1.1/0003:046D:C534.0009/uevent`]: 'HID_NAME=Logitech USB Receiver\n',
      [`${usb}/3-4/3-4:1.1/0003:046D:C534.0009/0003:046D:4022.000B/uevent`]: 'HID_NAME=Logitech Wireless Mouse\n',
      [`${usb}/3-4/3-4:1.1/0003:046D:C534.0009/0003:046D:4022.000B/input/input62/name`]: 'Logitech Wireless Mouse PID:4022\n',
      [`${usb}/3-4/3-4:1.1/0003:046D:C534.0009/0003:046D:4022.000B/input/input62/event24/dev`]: '13:88\n',
      [`${usb}/3-4/3-4:1.1/0003:046D:C534.0009/0003:046D:4022.000B/power_supply/hidpp_battery_0/model_name`]: 'Wireless Mouse\n',
      [`${usb}/3-4/3-4:1.1/0003:046D:C534.0009/0003:046D:4022.000B/power_supply/hidpp_battery_0/online`]: '0\n',
      [`${usb}/3-4/3-4:1.1/0003:046D:C534.0009/subsystem`]: { link: 'sys/bus/hid' },
      [`${usb}/3-5/product`]: 'Another device\n',
      'run/udev/data/c13:88': 'E:ID_INPUT_MOUSE=1\n'
    })
    const map = (await new PathBuilder(new SysReader(root)).build(`/${usb}/3-4`))!
    const flat: string[] = []
    const walk = (n: PathNode, d: number): void => { flat.push(`${'-'.repeat(d)}${n.target ? '*' : ''}${n.title}`); n.children.forEach((c) => walk(c, d + 1)) }
    walk(map, 0)
    expect(flat).toEqual([
      'PCI root complex (pci0000:00)', '-USB controller (0000:00:14.0)', '--USB root hub, bus 3', '---*USB Receiver (port 3-4)',
      '----Interface 1.1 · HID (mouse/keyboard)', '-----Logitech USB Receiver (HID)', '------Logitech Wireless Mouse (HID)',
      '-------Logitech Wireless Mouse PID:4022', '-------Battery: Wireless Mouse'
    ])
    const mouse = map.children[0]!.children[0]!.children[0]!.children[0]!.children[0]!.children[0]!
    expect(mouse.children[0]!.details).toEqual(expect.arrayContaining([['Event node', '/dev/input/event24'], ['Role', 'mouse']]))
    expect(mouse.children[1]!.details).toContainEqual(['Online', 'no (asleep or out of range)'])
    expect(map.children[0]!.details.some(([k]) => k === 'PCIe link')).toBe(false) // "Unknown" link speed is not shown
  })
})

describe('a mouse whose buttons work but which does not move', () => {
  it('points at the sensor, surface and battery rather than the link', () => {
    const info: InteractiveInfo = { available: true, reason: null, nodes: ['event24'], buttons: ['Left button', 'Right button'], hasMotion: true, hasWheel: true, hasHWheel: false, hasTouch: false, isKeyboard: false }
    const s: LiveState = {
      sessionId: 's', running: true, stoppedReason: null, elapsedMs: 12_000, limitMs: 120_000, events: 40, dropped: 0,
      motion: { left: 0, right: 0, up: 0, down: 0, events: 0 }, wheel: { up: 3, down: 2, left: 0, right: 0 },
      buttons: [{ name: 'Left button', presses: 6, chatter: 0, down: false, heldMs: 0 }, { name: 'Right button', presses: 2, chatter: 0, down: false, heldMs: 0 }],
      touch: { touches: 0, maxFingers: 0, travel: 0 }, keys: [], keyPresses: 0, untried: [], stuck: [], reportRateHz: null, maxMotionGapMs: null,
      still: { phase: 'idle', motion: 0, events: 0 }, errors: []
    }
    const f = liveFindings(info, s)
    expect(f[0]).toMatchObject({ status: 'fail', title: 'Buttons work, but no movement is reported', detail: expect.stringMatching(/surface.*cotton bud.*battery.*red light/s) })
    expect(f.some((x) => x.title === 'No signal from the device')).toBe(false)
  })
})

