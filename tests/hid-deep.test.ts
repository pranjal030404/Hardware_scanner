import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { analyseCapture, DeviceTester, type SpawnStream } from '../src/device-test/engine'
import { SysReader } from '@collectors/core/sysreader'
import { tmpRoot, writeTree } from './helpers/fixtures'
import { decodeReport, parseDescriptor } from '../src/device-test/hid-descriptor'
import type { HidrawInfo } from '../src/device-test/types'

/** The report descriptor of a Logitech wireless mouse (PID 4022) behind a Unifying/nano receiver. */
const LOGITECH = Buffer.from('05010902a10185020901a1000509190129101500250195107501810205011601f826ff07750c95020930093181061581257f7508950109388106050c0a380295018106c0c0050c0901a101850375109502150126ff0219012aff028100c00600ff0901a101851075089506150026ff000901810009019100c00600ff0902a101851175089513150026ff000902810009029100c00600ff0904a10185207508950e150026ff0009418100094191008521951f150026ff000942810009429100c0', 'hex')
const mouse: HidrawInfo = { node: 'hidraw6', name: 'Logitech Wireless Mouse PID:4022', pointer: true, hidpp: true, role: 'paired', description: '' }
const layout = parseDescriptor(LOGITECH)
/** Report 0x02: 16 button bits, 12-bit X and Y, wheel, horizontal wheel. */
const report = (buttons: number, x: number, y: number, wheel = 0): string => {
  const b = Buffer.alloc(8)
  b[0] = 0x02; b.writeUInt16LE(buttons, 1)
  const xy = ((x & 0xfff) | ((y & 0xfff) << 12)) >>> 0
  b[3] = xy & 0xff; b[4] = (xy >> 8) & 0xff; b[5] = (xy >> 16) & 0xff; b[6] = wheel & 0xff
  return b.toString('hex')
}

describe('HID report descriptor', () => {
  it('finds buttons, 12-bit X/Y and both wheels in a real Logitech descriptor', () => {
    const f = layout.fields.filter((x) => x.reportId === 2)
    expect(f.filter((x) => x.usagePage === 9)).toHaveLength(16)
    expect(f.find((x) => x.usage === 0x30)).toMatchObject({ bit: 16, size: 12, signed: true })
    expect(f.find((x) => x.usage === 0x31)).toMatchObject({ bit: 28, size: 12, signed: true })
    expect(f.find((x) => x.usagePage === 0x0c)).toMatchObject({ usage: 0x238, bit: 48, size: 8 })
  })

  it('decodes signed movement and ignores HID++ traffic', () => {
    expect(decodeReport(layout, Buffer.from(report(1, 5, -3, -1), 'hex'))).toEqual({ buttons: [1], x: 5, y: -3, wheel: -1, hwheel: 0 })
    expect(decodeReport(layout, Buffer.from('10ff001b00005a', 'hex'))).toBeNull()
  })
})

describe('deep capture analysis', () => {
  const capture = (lines: string[], hidpp: object = { answered: false }): string => [JSON.stringify({ type: 'hidpp', ...hidpp }), '{"type":"capture","seconds":12}', ...lines, '{"type":"done"}'].join('\n')

  it('proves a mouse is sending clicks but zero movement (sensor fault, not the PC)', () => {
    const r = analyseCapture(mouse, 12, layout, capture(['R 100 ' + report(1, 0, 0), 'R 180 ' + report(0, 0, 0), 'R 400 ' + report(2, 0, 0), 'R 410 10ff0400000000'], { answered: true, protocol: '4.2', voltage_mV: 1240 }))
    expect(r).toMatchObject({ reports: 4, pointerReports: 3, motionReports: 0, buttons: [1, 2] })
    expect(r.findings.map((f) => [f.status, f.title])).toEqual([
      ['fail', 'Confirmed: the mouse itself is sending zero movement'],
      ['warn', 'Battery voltage is weak: 1.24 V']
    ])
    expect(r.findings[0]!.detail).toMatch(/Left \(1×\), Right \(1×\) came through.*computer, receiver, radio link and driver are working/s)
    expect(r.presses).toEqual([{ button: 1, name: 'Left', presses: 1 }, { button: 2, name: 'Right', presses: 1 }])
    expect(r.timeline.slice(0, 2)).toEqual([{ second: 1, reports: 4, motion: 0, presses: 2 }, { second: 2, reports: 0, motion: 0, presses: 0 }])
    expect(r.evidence[0]).toEqual({ ms: 100, buttons: 'Left', x: 0, y: 0, wheel: 0 })
  })

  it('reports working hardware when movement arrives', () => {
    const r = analyseCapture(mouse, 12, layout, capture(['R 10 ' + report(0, 4, -2), 'R 18 ' + report(0, -7, 1)]))
    expect(r).toMatchObject({ motionReports: 2, movedX: 11, movedY: 3, maxStep: 8 })
    expect(r.findings[0]).toMatchObject({ status: 'pass', title: 'The device is sending movement' })
    expect(r.findings.some((f) => f.title === 'The device did not answer direct queries')).toBe(true)
  })

  it('reports a silent device', () => {
    expect(analyseCapture(mouse, 12, layout, capture([])).findings[0]).toMatchObject({ status: 'fail', title: 'The device sent nothing' })
  })
})

describe('privileged HID probe script', () => {
  const run = (...args: string[]) => spawnSync('python3', ['-I', 'resources/linux/hip-hid-probe', ...args], { encoding: 'utf8' })
  it('accepts only a hidraw node name and a 3–20 s capture', () => {
    expect(run('../../etc/passwd', '5').stderr).toMatch(/usage/)
    expect(run('hidraw6', '60').stderr).toMatch(/3-20 seconds/)
    expect(run('hidraw6; rm -rf /', '5').stderr).toMatch(/usage/)
    expect(run('hidraw999', '5').stderr).toMatch(/cannot open \/dev\/hidraw999/)
  })
})

describe('deep test session', () => {
  /** A receiver on 3-4 with its own interface (hidraw4) and a paired mouse (hidraw6). */
  function rig() {
    const root = tmpRoot()
    const usb = 'sys/devices/pci0000:00/0000:00:14.0/usb3/3-4'
    const recv = `${usb}/3-4:1.1/0003:046D:C534.0009`
    const m = `${recv}/0003:046D:4022.000B`
    writeTree(root, {
      [`${usb}/idVendor`]: '046d\n', [`${usb}/idProduct`]: 'c534\n', [`${usb}/product`]: 'USB Receiver\n',
      'sys/bus/usb/devices/3-4': { link: usb },
      [`${recv}/uevent`]: 'HID_NAME=Logitech USB Receiver\n', [`${recv}/report_descriptor`]: LOGITECH, [`${recv}/hidraw/hidraw4/dev`]: '',
      [`${m}/uevent`]: 'HID_NAME=Logitech Wireless Mouse PID:4022\n', [`${m}/report_descriptor`]: LOGITECH, [`${m}/hidraw/hidraw6/dev`]: '',
      'sys/class/hidraw/hidraw4': { link: `${recv}/hidraw/hidraw4` }, 'sys/class/hidraw/hidraw6': { link: `${m}/hidraw/hidraw6` },
      [`${recv}/hidraw/hidraw4/device`]: { link: recv }, [`${m}/hidraw/hidraw6/device`]: { link: m }
    })
    let now = 1_000_000
    let emit: (l: string) => void = () => undefined
    let exit: (c: number | null, e: string) => void = () => undefined
    const calls: string[][] = []
    const spawnStream: SpawnStream = (file, args) => { calls.push([file, ...args]); return { onLine: (cb) => (emit = cb), onExit: (cb) => (exit = cb) } }
    const t = new DeviceTester({ reader: new SysReader(root), run: async () => ({ ok: false, code: 1, stdout: '', stderr: '', timedOut: false, notFound: true, truncated: false }), platform: 'linux', disabledInputNodes: async () => [], spawnStream, now: () => now, helper: async (name) => ({ name, path: `/usr/local/libexec/hardware-intelligence/${name}`, usable: true, reason: null }) })
    return { t, calls, emit: (l: string) => emit(l), exit: (c: number | null, e = '') => exit(c, e), advance: (ms: number) => (now += ms) }
  }

  it('lists the paired mouse first and explains each part', async () => {
    const r = await rig().t.run('usb:3-4')
    expect(r.hid.map((h) => [h.node, h.role])).toEqual([['hidraw6', 'paired'], ['hidraw4', 'receiver']])
    expect(r.hid[0]!.description).toMatch(/wireless mouse itself/)
    expect(r.deepHelper).toMatchObject({ usable: true, reason: null, installCommand: expect.stringMatching(/^sudo sh .*install\.sh$/) })
  })

  it('reports each phase, counts down the capture and returns the analysis', async () => {
    const r = rig()
    let p = await r.t.deepStart('usb:3-4', 'hidraw6', 12)
    expect(p.phase).toBe('auth')
    // Only the installed, verified helper is run: no interpreter, no script text on the command line.
    expect(r.calls[0]).toEqual(['pkexec', '/usr/local/libexec/hardware-intelligence/hip-hid-probe', 'hidraw6', '12', 'hidpp'])
    r.emit('{"type": "start"}')
    expect(r.t.deepProgress(p.sessionId).phase).toBe('querying')
    r.emit('{"type": "hidpp", "answered": true, "voltage_mV": 1100}')
    r.emit('{"type": "capture", "seconds": 12}')
    r.advance(3500)
    r.emit('R 100 ' + report(1, 0, 0))
    p = r.t.deepProgress(p.sessionId)
    expect(p).toMatchObject({ phase: 'capturing', secondsLeft: 9, live: { reports: 1, pointerReports: 1, motionReports: 0, buttons: ['Left'] } })
    r.emit('{"type": "done", "reports": 1}')
    r.exit(0)
    p = r.t.deepProgress(p.sessionId)
    expect(p.phase).toBe('done')
    expect(p.result!.findings.map((f) => f.title)).toEqual(['Confirmed: the mouse itself is sending zero movement', 'Battery voltage is low: 1.10 V'])
  })

  it('explains a closed password dialog and refuses parts of other devices', async () => {
    const r = rig()
    const p = await r.t.deepStart('usb:3-4', 'hidraw6', 12)
    r.exit(126)
    expect(r.t.deepProgress(p.sessionId)).toMatchObject({ phase: 'error', error: expect.stringMatching(/Cancelled/) })
    await expect(r.t.deepStart('usb:3-4', 'hidraw9', 12)).rejects.toThrow(/does not belong/)
  })
})

