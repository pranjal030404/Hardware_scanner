import { spawn } from 'node:child_process'
import { constants, promises as fs } from 'node:fs'
import { createInterface } from 'node:readline'
import { posix } from 'node:path'
import type { SysReader } from '@collectors/core/sysreader'
import type { CommandRunner } from '@collectors/core/runner'
import { inputNodes, type InputNode } from '../device-control'
import { BUTTON_NAMES, BTN_TOUCH, capabilities, EvdevReader, hasBit, InputAggregator, keyName, MAIN_KEYS, REL_HWHEEL, REL_WHEEL, REL_X, ABS_X, type Capabilities } from './evdev'
import { classify, failedAttempts, NETWORK_PROBLEMS, readKernelLog, STORAGE_PROBLEMS, USB_PROBLEMS, usbLines, type KernelLine } from './kernel-log'
import { PathBuilder } from './path'
import { decodeReport, parseDescriptor } from './hid-descriptor'
import { helperStatus, type HelperName, type HelperStatus } from '../privileged/helpers'
import type { CheckResult, CheckStatus, DeepFinding, DeepPhase, DeepProgress, DeepReport, HidrawInfo, InteractiveInfo, LiveState, TargetList, TestReport, TestTarget } from './types'

export interface DeviceTestDeps {
  reader: SysReader
  run: CommandRunner
  platform: string
  /** Input group ids switched off in Settings, and the event nodes they cover. */
  disabledInputNodes: () => Promise<string[]>
  /** Where input event nodes live (tests point this at a fixture directory). */
  devInput?: string
  /** Checks whether this process may open a path (tests replace it). */
  canAccess?: (path: string, mode: number) => Promise<boolean>
  now?: () => number
  /** Starts a process and streams its stdout line by line (tests replace it). */
  spawnStream?: SpawnStream
  /** Whether an installed privileged helper may be used (tests replace it). */
  helper?: (name: HelperName) => Promise<HelperStatus>
  /** Absolute path of the bundled install.sh, shown to the user so they can install the helpers themselves. */
  installScript?: string
}

export interface StreamProc {
  onLine(cb: (line: string) => void): void
  onExit(cb: (code: number | null, stderr: string) => void): void
}
export type SpawnStream = (file: string, args: readonly string[]) => StreamProc

const spawnStream: SpawnStream = (file, args) => {
  const lineCbs: ((l: string) => void)[] = []
  const exitCbs: ((c: number | null, e: string) => void)[] = []
  let stderr = ''
  let child
  try {
    child = spawn(file, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    setImmediate(() => exitCbs.forEach((cb) => cb(-2, (e as Error).message)))
    return { onLine: (cb) => lineCbs.push(cb), onExit: (cb) => exitCbs.push(cb) }
  }
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000)
  createInterface({ input: child.stdout }).on('line', (l) => lineCbs.forEach((cb) => cb(l)))
  child.stderr.on('data', (c: Buffer) => { if (stderr.length < 64_000) stderr += c.toString('utf8') })
  child.on('error', (e: NodeJS.ErrnoException) => { clearTimeout(timer); exitCbs.forEach((cb) => cb(e.code === 'ENOENT' ? -2 : -1, e.message)) })
  child.on('close', (code) => { clearTimeout(timer); exitCbs.forEach((cb) => cb(code, stderr)) })
  return { onLine: (cb) => lineCbs.push(cb), onExit: (cb) => exitCbs.push(cb) }
}

/** HID button usages 1–5 are the standard mouse buttons. */
export const hidButtonName = (b: number): string => ({ 1: 'Left', 2: 'Right', 3: 'Middle (wheel click)', 4: 'Back (side)', 5: 'Forward (side)' } as Record<number, string>)[b] ?? `Button ${b}`

const SPEEDS: Record<string, string> = { '1.5': 'low speed (USB 1, 1.5 Mb/s)', '12': 'full speed (USB 1.1, 12 Mb/s)', '480': 'high speed (USB 2, 480 Mb/s)', '5000': 'SuperSpeed (USB 3, 5 Gb/s)', '10000': 'SuperSpeed+ (10 Gb/s)', '20000': 'SuperSpeed+ (20 Gb/s)' }
const USB_IF_CLASS: Record<string, string> = { '01': 'audio', '02': 'communications', '03': 'HID (mouse/keyboard)', '05': 'physical', '06': 'imaging', '07': 'printer', '08': 'mass storage', '09': 'hub', '0a': 'CDC data', '0b': 'smart card', '0e': 'video', '10': 'audio/video', 'e0': 'wireless (e.g. Bluetooth)', 'ef': 'miscellaneous', 'fe': 'application specific', 'ff': 'vendor specific' }
const RANK: Record<CheckStatus, number> = { fail: 4, warn: 3, pass: 1, info: 0, skip: 0 }
const LIVE_LIMIT_MS = 120_000

const t = (s: string | undefined): string | undefined => s?.trim() || undefined
const check = (id: string, title: string, status: CheckStatus, summary: string, details: string[] = [], fix?: string): CheckResult => ({ id, title, status, summary, details, ...(fix ? { fix } : {}) })
const fmtLines = (ls: readonly KernelLine[], max = 12): string[] => ls.slice(-max).map((l) => `${l.at}  ${l.text}`)

/** Turns the probe's output into findings. Exported for tests. */
export function analyseCapture(hid: HidrawInfo, seconds: number, layout: ReturnType<typeof parseDescriptor>, stdout: string): DeepReport {
  const report: DeepReport = { node: hid.node, name: hid.name, seconds, hidpp: null, reports: 0, pointerReports: 0, motionReports: 0, movedX: 0, movedY: 0, buttons: [], wheelReports: 0, findings: [], samples: [], presses: [], timeline: [], maxStep: 0, evidence: [] }
  const buttons = new Set<number>()
  const presses = new Map<number, number>()
  const timeline = Array.from({ length: seconds }, (_, i) => ({ second: i + 1, reports: 0, motion: 0, presses: 0 }))
  let down = new Set<number>()
  for (const line of stdout.split('\n')) {
    if (line.startsWith('{')) {
      try { const o = JSON.parse(line) as { type: string } & NonNullable<DeepReport['hidpp']>; if (o.type === 'hidpp' && hid.hidpp) { const { type: _t, ...rest } = o; report.hidpp = rest } } catch { /* ignore */ }
      continue
    }
    const m = /^R (\d+) ([0-9a-f]+)$/.exec(line)
    if (!m) continue
    report.reports++
    const ms = Number(m[1])
    const bucket = timeline[Math.min(seconds - 1, Math.floor(ms / 1000))]!
    bucket.reports++
    const d = decodeReport(layout, Buffer.from(m[2]!, 'hex'))
    if (!d) continue
    report.pointerReports++
    const now = new Set(d.buttons)
    for (const b of now) {
      buttons.add(b)
      if (!down.has(b)) { presses.set(b, (presses.get(b) ?? 0) + 1); bucket.presses++ }
    }
    down = now
    if (d.x || d.y) {
      report.motionReports++
      bucket.motion++
      report.movedX += Math.abs(d.x)
      report.movedY += Math.abs(d.y)
      report.maxStep = Math.max(report.maxStep, Math.abs(d.x) + Math.abs(d.y))
    }
    if (d.wheel || d.hwheel) report.wheelReports++
    if (report.samples.length < 12) report.samples.push(`+${m[1]} ms  buttons [${d.buttons.join(',') || '-'}]  x ${d.x}  y ${d.y}  wheel ${d.wheel}`)
    if (report.evidence.length < 40) report.evidence.push({ ms, buttons: d.buttons.map(hidButtonName).join(' + ') || '—', x: d.x, y: d.y, wheel: d.wheel })
  }
  report.presses = [...presses].sort((a, b) => a[0] - b[0]).map(([button, n]) => ({ button, name: hidButtonName(button), presses: n }))
  report.timeline = timeline
  report.buttons = [...buttons].sort((a, b) => a - b)
  const f: DeepFinding[] = report.findings
  const clicked = report.buttons.length > 0 || report.wheelReports > 0
  if (hid.pointer) {
    if (report.reports === 0) f.push({ status: 'fail', title: 'The device sent nothing', detail: `No report arrived in ${seconds} s. If you moved and clicked it during the test, it is not transmitting: check the power switch and battery, and for wireless devices that it is paired with this receiver (re-pair it with the maker's tool, e.g. Solaar for Logitech).` })
    else if (report.motionReports === 0 && clicked) f.push({ status: 'fail', title: 'Confirmed: the mouse itself is sending zero movement', detail: `All ${report.pointerReports} reports it sent had X = 0 and Y = 0, while ${report.buttons.length ? `${report.presses.map((p) => `${p.name} (${p.presses}×)`).join(', ')}` : 'the wheel'} came through. This was read directly from the device, below the driver and desktop: the computer, receiver, radio link and driver are working. The fault is in the mouse's movement sensor or what it sits on. Try a different surface (paper or a mouse pad), clean the sensor window, and fit a fresh battery. If it still sends no movement, the sensor has failed and the mouse needs replacing.` })
    else if (report.motionReports === 0) f.push({ status: 'warn', title: 'No movement or clicks seen', detail: 'Reports arrived but none contained movement or button presses. Run the test again and move and click the device the whole time.' })
    else f.push({ status: 'pass', title: 'The device is sending movement', detail: `${report.motionReports} of ${report.pointerReports} reports carried movement (total ${report.movedX} across, ${report.movedY} up/down). The hardware works. If the pointer still does not move on screen, the movement is lost in software: check it is switched on in Settings → Features & controls → Devices, then unplug and re-plug the receiver.` })
  }
  const h = report.hidpp
  if (hid.hidpp && h && !h.answered) f.push({ status: 'info', title: 'The device did not answer direct queries', detail: 'It was probably asleep when the test started (it wakes when moved or clicked). Battery voltage and firmware could not be read; the raw capture above is still valid.' })
  if (h?.voltage_mV) {
    const v = h.voltage_mV
    f.push(v < 1150
      ? { status: 'fail', title: `Battery voltage is low: ${(v / 1000).toFixed(2)} V`, detail: 'Below about 1.15 V a single AA cell cannot power the sensor reliably even if buttons still work. Fit a fresh battery.' }
      : v < 1300
        ? { status: 'warn', title: `Battery voltage is weak: ${(v / 1000).toFixed(2)} V`, detail: 'Buttons usually keep working at this level, but the movement sensor (the biggest power user) can cut out. Try a fresh battery.' }
        : { status: 'pass', title: `Battery voltage is good: ${(v / 1000).toFixed(2)} V`, detail: 'Power is not the problem.' })
  } else if (h?.battery) {
    const p = h.battery.percent
    f.push(p > 0 && p <= 15 ? { status: 'warn', title: `Battery is low: ${p}%`, detail: 'Fit a fresh battery or charge it.' } : { status: 'info', title: p ? `Battery: ${p}%` : 'Battery level reported without a percentage', detail: 'As reported by the device.' })
  }
  if (h?.dpi) f.push({ status: 'info', title: `Sensor resolution: ${h.dpi} DPI`, detail: 'The sensor configuration answered; this does not prove the sensor sees the surface.' })
  const rank: Record<CheckStatus, number> = { fail: 0, warn: 1, pass: 2, info: 3, skip: 4 }
  f.sort((a, b) => rank[a.status] - rank[b.status])
  return report
}

interface DeepSession {
  id: string
  hid: HidrawInfo
  layout: ReturnType<typeof parseDescriptor>
  seconds: number
  phase: DeepPhase
  captureAt: number | null
  lines: string[]
  result: DeepReport | null
  error: string | null
  live: { reports: number; pointerReports: number; motionReports: number; buttons: Set<number>; wheelReports: number }
}

/** Ground-level device tests built straight from sysfs, the kernel log and the device's own events. */
export class DeviceTester {
  private live: { id: string; target: TestTarget; agg: InputAggregator; reader: EvdevReader; started: number; stoppedReason: string | null; errors: string[]; timer: NodeJS.Timeout } | null = null
  private now: () => number
  private deep: DeepSession | null = null

  constructor(private d: DeviceTestDeps) {
    this.now = d.now ?? Date.now
  }

  private helperStatus(name: HelperName): Promise<HelperStatus> {
    return (this.d.helper ?? ((n: HelperName) => helperStatus(n, this.d.platform)))(name)
  }

  private canAccess(path: string, mode: number): Promise<boolean> {
    return this.d.canAccess ? this.d.canAccess(path, mode) : fs.access(path, mode).then(() => true, () => false)
  }

  // ---- what can be tested ----------------------------------------------------------------------

  async targets(): Promise<TargetList> {
    if (this.d.platform !== 'linux') return { targets: [], attempts: [], kernelLogLimitation: 'Device tests are only implemented on Linux' }
    const r = this.d.reader
    const nodes = await inputNodes(r)
    const nodePaths = new Map<string, string>()
    for (const n of nodes) nodePaths.set(n.node, (await r.real(`/sys/class/input/${n.node}`)) ?? '')
    // The deepest USB device segment in the path owns the node (a hub must not claim its children's nodes).
    const usbOwner = (p: string): string | undefined => p.split('/').filter((s) => /^\d+-[\d.]+$/.test(s)).at(-1)
    const onUsb = (port: string): InputNode[] => nodes.filter((n) => usbOwner(nodePaths.get(n.node)!) === port)
    const out: TestTarget[] = []
    const usbPorts = (await r.dir('/sys/bus/usb/devices')).filter((n) => /^\d+-[\d.]+$/.test(n))
    for (const port of usbPorts) {
      const base = `/sys/bus/usb/devices/${port}`
      const vid = t(await r.text(`${base}/idVendor`))
      const pid = t(await r.text(`${base}/idProduct`))
      const product = t(await r.text(`${base}/product`))
      const maker = t(await r.text(`${base}/manufacturer`))
      const hub = t(await r.text(`${base}/bDeviceClass`)) === '09'
      const mine = onUsb(port).filter((n) => n.role)
      out.push({
        id: `usb:${port}`, kind: 'usb', label: product ?? (vid ? `USB device ${vid}:${pid}` : `USB device on ${port}`),
        detail: [maker, vid && pid ? `${vid}:${pid}` : null, `USB port ${port}`, hub ? 'hub' : null, SPEEDS[t(await r.text(`${base}/speed`)) ?? '']?.split(' (')[0]].filter(Boolean).join(' · '),
        inputNodes: mine.map((n) => n.node), roles: [...new Set(mine.map((n) => n.role!))]
      })
    }
    // Built-in input devices (PS/2 keyboard, I2C touchpad…), grouped by their physical parent.
    const builtIn = new Map<string, InputNode[]>()
    for (const n of nodes) {
      if (!n.role || /\/usb\d+\//.test(nodePaths.get(n.node)!)) continue
      // …/<physical device>/input/inputN/eventM
      const parent = posix.dirname(posix.dirname(posix.dirname(nodePaths.get(n.node)!)))
      builtIn.set(parent, [...(builtIn.get(parent) ?? []), n])
    }
    for (const [parent, ns] of builtIn) {
      const bus = /\/i2c-/.test(parent) ? 'I2C' : /serio/.test(parent) ? 'PS/2 (built-in)' : 'platform'
      out.push({ id: `input:${posix.basename(parent)}`, kind: 'input', label: ns[0]!.name, detail: `built-in ${[...new Set(ns.map((n) => n.role))].join(' + ')} · ${bus}`, inputNodes: ns.map((n) => n.node), roles: [...new Set(ns.map((n) => n.role!))] })
    }
    for (const ifc of await r.dir('/sys/class/net')) {
      if (ifc === 'lo' || !(await r.exists(`/sys/class/net/${ifc}/device`))) continue
      const wireless = await r.exists(`/sys/class/net/${ifc}/wireless`)
      out.push({ id: `net:${ifc}`, kind: 'network', label: `${wireless ? 'Wi-Fi' : 'Network'} adapter ${ifc}`, detail: `driver ${await this.driver(`/sys/class/net/${ifc}/device`) ?? 'none'}`, inputNodes: [], roles: [] })
    }
    for (const b of await r.dir('/sys/block')) {
      if (/^(loop|ram|zram|dm-|sr|md)/.test(b)) continue
      const sectors = Number(await r.text(`/sys/block/${b}/size`)) || 0
      const model = t(await r.text(`/sys/block/${b}/device/model`))
      out.push({ id: `block:${b}`, kind: 'storage', label: model ? `${model} (${b})` : `Drive ${b}`, detail: `${(sectors * 512 / 1e9).toFixed(1)} GB · ${(await r.text(`/sys/block/${b}/removable`))?.trim() === '1' ? 'removable' : 'fixed'}`, inputNodes: [], roles: [] })
    }
    for (const p of await r.dir('/sys/class/power_supply')) {
      if (t(await r.text(`/sys/class/power_supply/${p}/type`)) !== 'Battery') continue
      out.push({ id: `battery:${p}`, kind: 'battery', label: `Battery ${p}`, detail: [t(await r.text(`/sys/class/power_supply/${p}/manufacturer`)), t(await r.text(`/sys/class/power_supply/${p}/model_name`))].filter(Boolean).join(' ') || 'battery', inputNodes: [], roles: [] })
    }
    for (const v of await r.dir('/sys/class/video4linux')) {
      if (t(await r.text(`/sys/class/video4linux/${v}/index`)) !== '0') continue
      out.push({ id: `video:${v}`, kind: 'camera', label: t(await r.text(`/sys/class/video4linux/${v}/name`)) ?? `Camera ${v}`, detail: `/dev/${v} · driver ${await this.driver(`/sys/class/video4linux/${v}/device`) ?? 'none'}`, inputNodes: [], roles: [] })
    }
    for (const h of await r.dir('/sys/class/bluetooth')) {
      if (!/^hci\d+$/.test(h)) continue
      out.push({ id: `bt:${h}`, kind: 'bluetooth', label: `Bluetooth adapter ${h}`, detail: `driver ${await this.driver(`/sys/class/bluetooth/${h}/device`) ?? 'none'}`, inputNodes: [], roles: [] })
    }
    const log = await readKernelLog(this.d.run, 60)
    const present = new Set(usbPorts)
    return { targets: out, attempts: failedAttempts(log.lines, (p) => present.has(p)), kernelLogLimitation: log.limitation }
  }

  private async driver(devPath: string): Promise<string | undefined> {
    const l = await this.d.reader.link(`${devPath}/driver`)
    return l ? posix.basename(l) : undefined
  }

  // ---- automatic checks ------------------------------------------------------------------------

  async run(targetId: string): Promise<TestReport> {
    const target = (await this.targets()).targets.find((x) => x.id === targetId)
    if (!target) throw new Error('That device is no longer connected. Plug it in again and pick it from the list.')
    const log = await readKernelLog(this.d.run, 180)
    const checks: CheckResult[] = []
    const [kind, name] = [target.kind, targetId.slice(targetId.indexOf(':') + 1)]
    if (kind === 'usb') checks.push(...(await this.usbChecks(name, target, log.lines)))
    if (kind === 'network') checks.push(...(await this.netChecks(name, log.lines)))
    if (kind === 'storage') checks.push(...(await this.storageChecks(name, log.lines)))
    if (kind === 'battery') checks.push(...(await this.batteryChecks(name)))
    if (kind === 'camera') checks.push(...(await this.cameraChecks(name, log.lines)))
    if (kind === 'bluetooth') checks.push(...(await this.bluetoothChecks(name, log.lines)))
    const interactive = await this.interactiveInfo(target)
    const dir = await this.deviceDir(target)
    if (dir) checks.push(...(await this.wirelessBatteryChecks(dir)))
    const map = dir ? await new PathBuilder(this.d.reader).build(dir).catch(() => null) : null
    const hid = dir ? await this.hidraws(dir) : []
    const probe = hid.length ? await this.helperStatus('hip-hid-probe') : null
    const deepHelper = { usable: probe?.usable ?? false, reason: probe?.reason ?? null, installCommand: `sudo sh ${this.d.installScript ?? 'resources/linux/install.sh'}` }
    if (target.inputNodes.length) checks.push(...(await this.inputChecks(target, interactive)))
    if (log.limitation) checks.push(check('kernel.log', 'Kernel messages', 'skip', log.limitation))
    const worst = checks.reduce<CheckResult | null>((w, c) => (!w || RANK[c.status] > RANK[w.status] ? c : w), null)
    const status: CheckStatus = worst && RANK[worst.status] >= 3 ? worst.status : 'pass'
    const headline = status === 'pass'
      ? interactive.available ? 'No problems found by the automatic checks. Use the hands-on test below to confirm every button, key and movement works.' : 'No problems found by the automatic checks.'
      : `${worst!.title}: ${worst!.summary}`
    return { target, ranAt: new Date(this.now()).toISOString(), checks, verdict: { status, headline }, interactive, map, hid, deepHelper }
  }

  /** The sysfs directory of the physical device behind a test target. */
  private async deviceDir(target: TestTarget): Promise<string | undefined> {
    const r = this.d.reader
    const name = target.id.slice(target.id.indexOf(':') + 1)
    switch (target.kind) {
      case 'usb': return r.real(`/sys/bus/usb/devices/${name}`)
      case 'input': { const p = target.inputNodes[0] ? await r.real(`/sys/class/input/${target.inputNodes[0]}`) : undefined; return p ? posix.dirname(posix.dirname(posix.dirname(p))) : undefined }
      case 'network': return r.real(`/sys/class/net/${name}/device`)
      case 'storage': return r.real(`/sys/block/${name}`)
      case 'battery': return r.real(`/sys/class/power_supply/${name}`)
      case 'camera': return r.real(`/sys/class/video4linux/${name}`)
      case 'bluetooth': return r.real(`/sys/class/bluetooth/${name}`)
    }
  }

  /** Raw HID interfaces inside a device directory, with what their descriptors say they carry. */
  private async hidraws(dir: string): Promise<HidrawInfo[]> {
    const r = this.d.reader
    const out: HidrawInfo[] = []
    for (const h of (await r.dir('/sys/class/hidraw')).filter((x) => /^hidraw\d+$/.test(x)).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))) {
      const dev = await r.real(`/sys/class/hidraw/${h}/device`)
      if (!dev || (dev !== dir && !dev.startsWith(`${dir}/`))) continue
      const desc = await r.bytes(`/sys/class/hidraw/${h}/device/report_descriptor`)
      const layout = desc ? parseDescriptor(desc) : null
      const hex = desc?.toString('hex') ?? ''
      const name = /HID_NAME=(.*)/.exec((await r.text(`/sys/class/hidraw/${h}/device/uevent`)) ?? '')?.[1] ?? h
      const pointer = !!layout?.fields.some((f) => f.usagePage === 0x01 && f.usage === 0x30)
      // A HID device whose parent is another HID device is connected through it (a receiver).
      const paired = /^[0-9A-F]{4}:[0-9A-F]{4}:[0-9A-F]{4}\.[0-9A-F]{4}$/.test(posix.basename(posix.dirname(dev)))
      out.push({ node: h, name, pointer, hidpp: /0600ff[0-9a-f]*?851[01]/.test(hex), role: paired ? 'paired' : 'device', description: '', dev } as HidrawInfo & { dev: string })
    }
    const all = out as (HidrawInfo & { dev: string })[]
    for (const x of all) {
      if (x.role !== 'paired' && (all.some((y) => y.role === 'paired' && y.dev.startsWith(`${x.dev}/`)) || /receiver/i.test(x.name))) x.role = 'receiver'
      x.description = x.role === 'paired'
        ? x.pointer ? 'The wireless mouse itself, talking through the receiver. Choose this to test the mouse.' : 'A wireless device (for example a keyboard) talking through the receiver.'
        : x.role === 'receiver'
          ? 'The receiver\'s own interface. It only forwards what paired devices send; choose a paired device to test one of them.'
          : x.pointer ? 'The mouse/pointer part of this device.' : 'Another part of this device (keys, media keys or configuration).'
    }
    const rank = (x: HidrawInfo): number => (x.role === 'paired' && x.pointer ? 0 : x.pointer && x.role === 'device' ? 1 : x.role === 'paired' ? 2 : x.pointer ? 3 : 4)
    return all.map(({ dev: _d, ...x }) => x).sort((a, b) => rank(a) - rank(b) || a.node.localeCompare(b.node))
  }

  /**
   * Reads the raw reports a HID device transmits (and, for Logitech HID++, asks it for battery,
   * firmware and DPI) through a privileged probe. Raw HID nodes are root-only, so this asks for the
   * administrator password. It proves whether the device itself is sending movement and clicks.
   * Runs as a session the page polls, so it can show exactly when the capture window starts.
   */
  async deepStart(targetId: string, node: string, seconds: number): Promise<DeepProgress> {
    if (this.deep && (this.deep.phase === 'auth' || this.deep.phase === 'querying' || this.deep.phase === 'capturing')) throw new Error('A deep test is already running.')
    const target = (await this.targets()).targets.find((x) => x.id === targetId)
    if (!target) throw new Error('That device is no longer connected.')
    const dir = await this.deviceDir(target)
    const hid = dir ? (await this.hidraws(dir)).find((h) => h.node === node) : undefined
    if (!hid) throw new Error(`${node} does not belong to this device.`)
    const desc = await this.d.reader.bytes(`/sys/class/hidraw/${node}/device/report_descriptor`)
    if (!desc) throw new Error('Could not read the device\'s report descriptor.')
    const layout = parseDescriptor(desc)
    const probe = await this.helperStatus('hip-hid-probe')
    if (!probe.usable) throw new Error(`The deep test needs the optional privileged helper. ${probe.reason}`)
    const s: DeepSession = {
      id: `deep-${this.now().toString(36)}`, hid, layout, seconds, phase: 'auth', captureAt: null, lines: [], result: null, error: null,
      live: { reports: 0, pointerReports: 0, motionReports: 0, buttons: new Set(), wheelReports: 0 }
    }
    this.deep = s
    const proc = (this.d.spawnStream ?? spawnStream)('pkexec', [probe.path, node, String(seconds), ...(hid.hidpp ? ['hidpp'] : [])])
    proc.onLine((line) => {
      if (s.lines.length < 25_000) s.lines.push(line)
      if (line.startsWith('{')) {
        const type = /"type": ?"(\w+)"/.exec(line)?.[1]
        if (type === 'start') s.phase = 'querying'
        else if (type === 'capture') { s.phase = 'capturing'; s.captureAt = this.now() }
        else if (type === 'done' || type === 'gone') s.phase = 'analysing'
        return
      }
      const m = /^R \d+ ([0-9a-f]+)$/.exec(line)
      if (!m) return
      s.live.reports++
      const d = decodeReport(layout, Buffer.from(m[1]!, 'hex'))
      if (!d) return
      s.live.pointerReports++
      if (d.x || d.y) s.live.motionReports++
      if (d.wheel || d.hwheel) s.live.wheelReports++
      d.buttons.forEach((b) => s.live.buttons.add(b))
    })
    proc.onExit((code, stderr) => {
      if (code === 0) {
        s.result = analyseCapture(hid, seconds, layout, s.lines.join('\n'))
        s.phase = 'done'
        return
      }
      s.phase = 'error'
      s.error = code === -2 ? 'pkexec is not installed, so the app cannot ask for administrator rights.'
        : code === 126 ? 'Cancelled: the password dialog was closed. Nothing was read.'
          : code === 127 ? 'Not authorised: administrator rights were refused.'
            : stderr.split('\n').find((l) => l.startsWith('ERROR '))?.slice(6) ?? (stderr.trim() || `the probe failed (${code})`)
    })
    return this.deepProgress(s.id)
  }

  deepProgress(sessionId: string): DeepProgress {
    const s = this.deep
    if (!s || s.id !== sessionId) throw new Error('This deep test has ended. Start it again.')
    const left = s.phase === 'capturing' && s.captureAt !== null ? Math.max(0, Math.ceil(s.seconds - (this.now() - s.captureAt) / 1000)) : null
    return {
      sessionId: s.id, phase: s.phase, seconds: s.seconds, secondsLeft: left,
      live: { reports: s.live.reports, pointerReports: s.live.pointerReports, motionReports: s.live.motionReports, buttons: [...s.live.buttons].sort((a, b) => a - b).map(hidButtonName), wheelReports: s.live.wheelReports },
      result: s.result, error: s.error
    }
  }

  /** Wireless mice/keyboards report their own battery through the receiver (e.g. Logitech HID++). */
  private async wirelessBatteryChecks(dir: string): Promise<CheckResult[]> {
    const r = this.d.reader
    const out: CheckResult[] = []
    for (const p of await r.dir('/sys/class/power_supply')) {
      const base = `/sys/class/power_supply/${p}`
      if (t(await r.text(`${base}/scope`)) !== 'Device') continue
      const real = await r.real(base)
      if (!real?.startsWith(`${dir}/`)) continue
      const model = t(await r.text(`${base}/model_name`)) ?? p
      const cap = Number(t(await r.text(`${base}/capacity`)) ?? NaN)
      const level = t(await r.text(`${base}/capacity_level`))
      const online = t(await r.text(`${base}/online`))
      const charge = Number.isFinite(cap) ? `${cap}%` : level ? `"${level}"` : 'not reported'
      const details = [`${base}: capacity ${Number.isFinite(cap) ? cap : 'n/a'}, level ${level ?? 'n/a'}, status ${t(await r.text(`${base}/status`)) ?? 'n/a'}, online ${online ?? 'n/a'}`]
      const title = `Battery of ${model}`
      if (online === '0') out.push(check('wireless.battery', title, 'warn', 'The receiver cannot reach it right now. Most wireless devices doze off after a minute idle, so it may just be asleep; otherwise it is switched off, out of range, or its battery is flat.', details, 'Click or move it, then press Check again. If it still shows this, switch it off and on, move it closer to the receiver, or replace the battery.'))
      else if ((Number.isFinite(cap) && cap <= 10) || level === 'Critical') out.push(check('wireless.battery', title, 'fail', `The battery is almost empty (${charge}). Parts that use the most power, like the movement sensor, stop working first.`, details, 'Replace or charge the battery.'))
      else if ((Number.isFinite(cap) && cap <= 25) || level === 'Low') out.push(check('wireless.battery', title, 'warn', `The battery is low (${charge}).`, details, 'Replace or charge the battery soon.'))
      else out.push(check('wireless.battery', title, 'pass', `The device reports its battery as ${charge}.`, details))
    }
    return out
  }

  private async usbChecks(port: string, target: TestTarget, lines: KernelLine[]): Promise<CheckResult[]> {
    const r = this.d.reader
    const base = `/sys/bus/usb/devices/${port}`
    const out: CheckResult[] = []
    const vid = t(await r.text(`${base}/idVendor`))
    const pid = t(await r.text(`${base}/idProduct`))
    out.push(vid && pid
      ? check('usb.detected', 'Detected on the USB bus', 'pass', `The laptop talks to it: ID ${vid}:${pid}${t(await r.text(`${base}/manufacturer`)) ? `, made by ${t(await r.text(`${base}/manufacturer`))}` : ''}.`, [`${base}/idVendor = ${vid}`, `${base}/idProduct = ${pid}`])
      : check('usb.detected', 'Detected on the USB bus', 'fail', 'The device did not report its identity.', [], 'Re-plug it into another port with another cable.'))
    if (t(await r.text(`${base}/authorized`)) === '0') out.push(check('usb.authorized', 'Allowed by USB policy', 'fail', 'The device is blocked by a USB authorization policy (for example usbguard), so no driver may use it.', [`${base}/authorized = 0`], 'Allow it in your USB policy tool (e.g. `usbguard allow-device`).'))
    const config = t(await r.text(`${base}/bConfigurationValue`))
    out.push(config
      ? check('usb.configured', 'Configured', 'pass', `Running configuration ${config}.`)
      : check('usb.configured', 'Configured', 'fail', 'The device was detected but never switched into a working configuration.', [`${base}/bConfigurationValue is empty`], 'This usually means the port cannot supply enough power, or the device rejected the setup. Try a port directly on the laptop (no hub) or a powered hub.'))

    // Interfaces and their drivers.
    const ifaces = (await r.dir(base)).filter((n) => n.startsWith(`${port}:`))
    const ifDetails: string[] = []
    let unbound = 0
    let hid = false
    for (const i of ifaces) {
      const cls = t(await r.text(`${base}/${i}/bInterfaceClass`)) ?? '??'
      if (cls === '03') hid = true
      const drv = await this.driver(`${base}/${i}`)
      if (!drv) unbound++
      ifDetails.push(`${i}: ${USB_IF_CLASS[cls] ?? `class ${cls}`} → ${drv ?? 'no driver'}`)
    }
    if (!ifaces.length) out.push(check('usb.drivers', 'Driver attached', config ? 'warn' : 'skip', 'The device exposes no interfaces yet.'))
    else if (unbound === ifaces.length) out.push(check('usb.drivers', 'Driver attached', 'fail', 'No driver is attached to any part of the device, so nothing can use it.', ifDetails, 'Linux has no driver for this device, or the driver failed to load (see kernel messages below). Search for the ID shown above plus "linux driver".'))
    else out.push(check('usb.drivers', 'Driver attached', unbound ? 'info' : 'pass', unbound ? `${ifaces.length - unbound} of ${ifaces.length} interfaces have a driver (unused interfaces are often normal).` : `Every interface has a driver.`, ifDetails))

    // Link speed versus what the device supports.
    const speed = t(await r.text(`${base}/speed`)) ?? ''
    const version = Number(t(await r.text(`${base}/version`)) ?? '0')
    const speedText = SPEEDS[speed] ?? `${speed} Mb/s`
    if (version >= 3 && Number(speed) <= 480) out.push(check('usb.speed', 'Connection speed', 'warn', `A USB ${version} device is running at ${speedText}.`, [`${base}/version = ${version}`, `${base}/speed = ${speed}`], 'The cable, port or hub only supports USB 2, or the SuperSpeed contacts are dirty or damaged. Use a USB 3 cable and a blue/SS-marked port.'))
    else out.push(check('usb.speed', 'Connection speed', 'pass', `${speedText}${version ? ` (device supports USB ${version})` : ''}.`))

    // Power.
    const maxPower = Number((t(await r.text(`${base}/bMaxPower`)) ?? '0').replace(/mA$/, '')) || 0
    const budget = Number(speed) >= 5000 ? 900 : 500
    const oc = Number(t(await r.text(`${base}/port/over_current_count`)) ?? '0') || 0
    const runtime = t(await r.text(`${base}/power/runtime_status`))
    const control = t(await r.text(`${base}/power/control`))
    const powerDetails = [`requests ${maxPower} mA; this port type provides up to ${budget} mA`, `over-current events on this port: ${oc}`, `power state: ${runtime ?? 'unknown'} (autosuspend: ${control === 'auto' ? 'on' : control === 'on' ? 'off' : 'unknown'})`]
    if (oc > 0) out.push(check('usb.power', 'Power', 'fail', `The port has cut power ${oc} time(s) because the device drew too much current.`, powerDetails, 'Likely a short in the device or cable. Stop using this device on this port; try a powered hub if it is a high-power device.'))
    else if (maxPower > budget) out.push(check('usb.power', 'Power', 'warn', `The device asks for ${maxPower} mA, more than the ${budget} mA this port provides.`, powerDetails, 'Use a powered USB hub or a higher-power port.'))
    else out.push(check('usb.power', 'Power', 'pass', `Asks for ${maxPower} mA, within the port's ${budget} mA.`, powerDetails))

    if (port.includes('.')) out.push(check('usb.hub', 'Connection path', 'info', 'Connected through a USB hub or dock.', [], 'If it misbehaves, plug it straight into the laptop to rule the hub out.'))

    out.push(this.kernelCheck(usbLines(lines, port), USB_PROBLEMS, /new .*USB device number/))

    if (hid && !target.inputNodes.length) out.push(check('input.nodes', 'Input device created', 'fail', 'It presents itself as a mouse/keyboard (HID) but no input device was created, so it cannot move the pointer or type.', ifDetails, 'The HID driver failed to bind; see the kernel messages. Re-plug it; if it persists the device firmware is likely faulty.'))
    return out
  }

  /** Classifies kernel lines for one device. Only problems since the latest (re)connect count against it. */
  private kernelCheck(mine: KernelLine[], problems: typeof USB_PROBLEMS, connectRe?: RegExp): CheckResult {
    if (!mine.length) return check('kernel', 'Kernel messages', 'pass', 'No kernel messages about this device in the last 3 hours.')
    let start = 0
    if (connectRe) mine.forEach((l, i) => { if (connectRe.test(l.text)) start = i })
    const current = classify(mine.slice(start), problems)
    const earlier = classify(mine.slice(0, start), problems)
    const disconnects = mine.filter((l) => /USB disconnect/.test(l.text)).length
    const failing = current.filter((x) => x.problem.severity === 'fail')
    const warning = current.filter((x) => x.problem.severity === 'warn')
    const explain = [...new Set([...failing, ...warning].map((x) => x.problem.explanation))]
    if (failing.length) return check('kernel', 'Kernel messages', 'fail', explain[0]!, fmtLines(mine), explain.slice(1).join(' ') || undefined)
    if (disconnects >= 3) return check('kernel', 'Kernel messages', 'warn', `It disconnected ${disconnects} times in the last 3 hours. A loose connector, worn cable or power-saving that the device does not handle.`, fmtLines(mine), 'Try another cable and port. Wiggle the cable while watching for a disconnect to confirm a loose connector.')
    if (warning.length) return check('kernel', 'Kernel messages', 'warn', explain[0]!, fmtLines(mine))
    const earlierFail = earlier.filter((x) => x.problem.severity === 'fail')
    if (earlierFail.length) return check('kernel', 'Kernel messages', 'warn', `Works now, but earlier connection attempts failed: ${earlierFail[0]!.problem.explanation}`, fmtLines(mine), 'An intermittent cable or port fault is the usual cause.')
    return check('kernel', 'Kernel messages', 'pass', 'Kernel messages show a normal connection.', fmtLines(mine))
  }

  private async interactiveInfo(target: TestTarget): Promise<InteractiveInfo> {
    const none = (reason: string): InteractiveInfo => ({ available: false, reason, nodes: [], buttons: [], hasMotion: false, hasWheel: false, hasHWheel: false, hasTouch: false, isKeyboard: false })
    if (!target.inputNodes.length) return none('This device has no input functions to test by hand.')
    const caps: Capabilities[] = []
    for (const n of target.inputNodes) caps.push(await capabilities(this.d.reader, n))
    const any = (f: (c: Capabilities) => boolean): boolean => caps.some(f)
    const devInput = this.d.devInput ?? '/dev/input'
    const readable = []
    for (const n of target.inputNodes) if (await this.canAccess(`${devInput}/${n}`, constants.R_OK)) readable.push(n)
    const info: InteractiveInfo = {
      available: readable.length > 0,
      reason: readable.length ? null : 'This user cannot read the raw input device. Add yourself to the "input" group (`sudo usermod -aG input $USER`, then log out and in).',
      nodes: readable,
      buttons: Object.keys(BUTTON_NAMES).map(Number).filter((b) => any((c) => hasBit(c.key, b))).map((b) => BUTTON_NAMES[b]!),
      hasMotion: any((c) => hasBit(c.rel, REL_X) || hasBit(c.abs, ABS_X)),
      hasWheel: any((c) => hasBit(c.rel, REL_WHEEL)),
      hasHWheel: any((c) => hasBit(c.rel, REL_HWHEEL)),
      hasTouch: any((c) => hasBit(c.key, BTN_TOUCH)),
      isKeyboard: target.roles.includes('keyboard')
    }
    return info
  }

  private async inputChecks(target: TestTarget, info: InteractiveInfo): Promise<CheckResult[]> {
    const out: CheckResult[] = []
    const nodes = await inputNodes(this.d.reader)
    const desc = target.inputNodes.map((n) => `${n}: ${nodes.find((x) => x.node === n)?.role ?? 'other'} (${nodes.find((x) => x.node === n)?.name ?? '?'})`)
    out.push(check('input.nodes', 'Input device created', 'pass', `The system created ${target.inputNodes.length} input device(s): ${target.roles.join(', ')}.`, desc))
    const abilities = [info.hasMotion ? 'movement' : null, info.buttons.length ? `${info.buttons.length} button(s): ${info.buttons.join(', ')}` : null, info.hasWheel ? 'scroll wheel' : null, info.hasHWheel ? 'horizontal scroll' : null, info.hasTouch ? 'touch' : null, info.isKeyboard ? 'keys' : null].filter(Boolean)
    out.push(check('input.capabilities', 'Reported abilities', 'info', abilities.length ? `It reports ${abilities.join('; ')}.` : 'It reports no buttons or movement.', [], abilities.length ? undefined : 'A device that reports nothing usable is misidentified or faulty.'))
    const off = await this.d.disabledInputNodes()
    const disabled = target.inputNodes.filter((n) => off.includes(n))
    if (disabled.length) out.push(check('input.enabled', 'Switched on', 'warn', 'It is switched off in Settings → Features & controls → Devices, so it will not move the pointer or type. The hands-on test below still reads it.', disabled, 'Switch it back on in Settings if this is the device you want to use.'))
    for (const n of target.inputNodes) {
      if (t(await this.d.reader.text(`/sys/class/input/${n}/device/inhibited`)) === '1') out.push(check('input.inhibited', 'Not inhibited', 'warn', `${n} is inhibited by the system (common for a keyboard or touchpad while a 2-in-1 is folded into tablet mode).`))
    }
    out.push(info.available
      ? check('input.access', 'Hands-on test available', 'pass', 'The raw events can be read, so every button and movement can be tested below.')
      : check('input.access', 'Hands-on test available', 'skip', info.reason ?? 'Not available'))
    return out
  }

  private async netChecks(ifc: string, lines: KernelLine[]): Promise<CheckResult[]> {
    const r = this.d.reader
    const base = `/sys/class/net/${ifc}`
    const out: CheckResult[] = []
    const drv = await this.driver(`${base}/device`)
    out.push(drv ? check('net.driver', 'Driver attached', 'pass', `Driver ${drv}.`) : check('net.driver', 'Driver attached', 'fail', 'No driver is attached.', [], 'Install the driver/firmware for this adapter.'))
    const wireless = await r.exists(`${base}/wireless`)
    if (wireless) {
      const phy = t(await r.text(`${base}/phy80211/name`))
      for (const k of await r.dir('/sys/class/rfkill')) {
        if (t(await r.text(`/sys/class/rfkill/${k}/name`)) !== phy) continue
        const hard = t(await r.text(`/sys/class/rfkill/${k}/hard`)) === '1'
        const soft = t(await r.text(`/sys/class/rfkill/${k}/soft`)) === '1'
        out.push(hard ? check('net.radio', 'Radio switched on', 'fail', 'The radio is blocked by a hardware switch or the wireless key.', [], 'Press the laptop\'s wireless/airplane key or flip its switch.')
          : soft ? check('net.radio', 'Radio switched on', 'fail', 'The radio is switched off in software (airplane mode or Settings → Devices).', [], 'Switch Wi-Fi on in Settings → Features & controls → Devices or turn airplane mode off.')
            : check('net.radio', 'Radio switched on', 'pass', 'The radio is on.'))
      }
    }
    const oper = t(await r.text(`${base}/operstate`))
    const carrier = t(await r.text(`${base}/carrier`))
    out.push(oper === 'up'
      ? check('net.link', 'Link', 'pass', `Connected${t(await r.text(`${base}/speed`)) && Number(await r.text(`${base}/speed`)) > 0 ? ` at ${t(await r.text(`${base}/speed`))} Mb/s` : ''}.`)
      : check('net.link', 'Link', 'warn', wireless ? 'Not connected to a network.' : carrier === '0' ? 'No cable signal (carrier) detected.' : `Link state: ${oper ?? 'unknown'}.`, [`operstate = ${oper}`, `carrier = ${carrier ?? 'n/a'}`], wireless ? 'Connect to a network to test it fully.' : 'Check the cable is seated at both ends and the other end is powered; try another cable.'))
    const stat = async (k: string): Promise<number> => Number(t(await r.text(`${base}/statistics/${k}`)) ?? '0') || 0
    const [rxp, rxe, txe, crc, changes] = [await stat('rx_packets'), await stat('rx_errors'), await stat('tx_errors'), await stat('rx_crc_errors'), Number(t(await r.text(`${base}/carrier_changes`)) ?? '0') || 0]
    const errRate = rxp ? (rxe + crc) / rxp : 0
    const sd = [`rx_packets ${rxp}`, `rx_errors ${rxe}`, `rx_crc_errors ${crc}`, `tx_errors ${txe}`, `carrier_changes ${changes}`]
    if (errRate > 0.01 || txe > 100) out.push(check('net.errors', 'Transmission errors', 'fail', `${(errRate * 100).toFixed(2)}% of received packets were corrupt${txe ? `, ${txe} send errors` : ''}.`, sd, wireless ? 'Weak or noisy signal: move closer to the router.' : 'A damaged cable or port: replace the cable first.'))
    else if (!wireless && changes > 20) out.push(check('net.errors', 'Transmission errors', 'warn', `The link went up and down ${changes} times since boot.`, sd, 'A loose cable or flaky port.'))
    else out.push(check('net.errors', 'Transmission errors', 'pass', 'No significant errors since boot.', sd))
    out.push(this.kernelCheck(lines.filter((l) => l.text.includes(ifc) || (drv !== undefined && l.text.startsWith(`${drv} `))), NETWORK_PROBLEMS))
    return out
  }

  private async storageChecks(dev: string, lines: KernelLine[]): Promise<CheckResult[]> {
    const r = this.d.reader
    const base = `/sys/block/${dev}`
    const out: CheckResult[] = []
    const size = Number(t(await r.text(`${base}/size`)) ?? '0')
    out.push(size > 0 ? check('storage.size', 'Capacity readable', 'pass', `${(size * 512 / 1e9).toFixed(1)} GB.`) : check('storage.size', 'Capacity readable', 'fail', 'The drive reports 0 bytes: no media, or the drive is not responding.', [], 'Re-seat the drive or card; try another reader/enclosure.'))
    if (t(await r.text(`${base}/ro`)) === '1') out.push(check('storage.ro', 'Writable', 'warn', 'The drive is read-only (write-protect switch on an SD card, or the drive locked itself after errors).'))
    const state = t(await r.text(`${base}/device/state`))
    if (state && !['running', 'live'].includes(state)) out.push(check('storage.state', 'Controller state', 'fail', `The drive's controller is in state "${state}".`, [], 'The drive is not operating normally; back up what you can.'))
    const nvme = dev.match(/^(nvme\d+)/)?.[1]
    out.push(this.kernelCheck(lines.filter((l) => l.text.includes(dev) || (nvme !== undefined && l.text.includes(`${nvme}:`))), STORAGE_PROBLEMS))
    out.push(check('storage.smart', 'Drive self-assessment (SMART)', 'skip', 'Reading SMART health needs root. Run `sudo smartctl -H /dev/' + dev + '` for the drive\'s own verdict.'))
    return out
  }

  private async batteryChecks(p: string): Promise<CheckResult[]> {
    const r = this.d.reader
    const base = `/sys/class/power_supply/${p}`
    const num = async (k: string): Promise<number | undefined> => { const v = t(await r.text(`${base}/${k}`)); return v === undefined ? undefined : Number(v) }
    const out: CheckResult[] = []
    if ((await num('present')) === 0) return [check('battery.present', 'Battery present', 'fail', 'No battery is detected in the bay.')]
    const full = (await num('energy_full')) ?? (await num('charge_full'))
    const design = (await num('energy_full_design')) ?? (await num('charge_full_design'))
    if (full && design) {
      const h = Math.round((full / design) * 100)
      out.push(check('battery.health', 'Battery health', h < 60 ? 'fail' : h < 80 ? 'warn' : 'pass', `Holds ${h}% of its original capacity.`, [`full ${full} / design ${design}`], h < 80 ? 'The battery has worn out; replacement restores runtime.' : undefined))
    } else out.push(check('battery.health', 'Battery health', 'skip', 'The battery does not report its design capacity.'))
    const cycles = await num('cycle_count')
    if (cycles) out.push(check('battery.cycles', 'Charge cycles', cycles > 800 ? 'warn' : 'info', `${cycles} charge cycles.`))
    const status = t(await r.text(`${base}/status`))
    const cap = await num('capacity')
    out.push(check('battery.status', 'Charging state', status === 'Unknown' ? 'warn' : 'info', `${status ?? 'unknown'}${cap !== undefined ? `, ${cap}%` : ''}.`, [], status === 'Unknown' ? 'An "Unknown" state while on AC can mean the charger or charging circuit is not working.' : undefined))
    return out
  }

  private async cameraChecks(v: string, lines: KernelLine[]): Promise<CheckResult[]> {
    const out: CheckResult[] = []
    const drv = await this.driver(`/sys/class/video4linux/${v}/device`)
    out.push(drv ? check('camera.driver', 'Driver attached', 'pass', `Driver ${drv}.`) : check('camera.driver', 'Driver attached', 'fail', 'No driver is attached.'))
    const ok = await this.canAccess(`/dev/${v}`, constants.R_OK | constants.W_OK)
    out.push(ok ? check('camera.access', 'Usable by this user', 'pass', `/dev/${v} can be opened.`) : check('camera.access', 'Usable by this user', 'fail', `This user cannot open /dev/${v}.`, [], 'Add yourself to the "video" group, or check a privacy shutter / camera key / BIOS camera switch.'))
    out.push(this.kernelCheck(lines.filter((l) => /uvcvideo|\bvideo\d/.test(l.text)), USB_PROBLEMS))
    return out
  }

  private async bluetoothChecks(h: string, lines: KernelLine[]): Promise<CheckResult[]> {
    const r = this.d.reader
    const out: CheckResult[] = []
    for (const k of await r.dir(`/sys/class/bluetooth/${h}`)) {
      if (!k.startsWith('rfkill')) continue
      const hard = t(await r.text(`/sys/class/bluetooth/${h}/${k}/hard`)) === '1'
      const soft = t(await r.text(`/sys/class/bluetooth/${h}/${k}/soft`)) === '1'
      out.push(hard || soft ? check('bt.radio', 'Radio switched on', 'fail', hard ? 'Blocked by a hardware switch or key.' : 'Switched off in software (airplane mode or Settings → Devices).', [], 'Switch Bluetooth on.') : check('bt.radio', 'Radio switched on', 'pass', 'The radio is on.'))
    }
    const res = await this.d.run('bluetoothctl', ['show'], { timeoutMs: 4000 })
    if (res.ok) {
      const powered = /Powered:\s*yes/.test(res.stdout)
      out.push(powered ? check('bt.powered', 'Adapter powered', 'pass', 'The Bluetooth service has the adapter powered on.') : check('bt.powered', 'Adapter powered', 'warn', 'The adapter is off in the Bluetooth service.', [], 'Turn Bluetooth on in your desktop or run `bluetoothctl power on`.'))
    } else out.push(check('bt.powered', 'Adapter powered', 'skip', res.notFound ? 'bluetoothctl is not installed.' : 'The Bluetooth service did not answer (is bluetooth.service running?).'))
    out.push(this.kernelCheck(lines.filter((l) => l.text.includes(`Bluetooth: ${h}`)), NETWORK_PROBLEMS))
    return out
  }

  // ---- hands-on test ---------------------------------------------------------------------------

  async startLive(targetId: string): Promise<LiveState> {
    await this.stopLive('Replaced by a new test')
    const target = (await this.targets()).targets.find((x) => x.id === targetId)
    if (!target) throw new Error('That device is no longer connected.')
    const info = await this.interactiveInfo(target)
    if (!info.available) throw new Error(info.reason ?? 'Hands-on test not available')
    const buttonCodes = Object.entries(BUTTON_NAMES).filter(([, n]) => info.buttons.includes(n)).map(([c]) => Number(c))
    const agg = new InputAggregator(buttonCodes, info.isKeyboard)
    const id = `live-${this.now().toString(36)}`
    const errors: string[] = []
    const reader = new EvdevReader((evs) => { for (const e of evs) agg.push(e) }, (node, msg) => {
      errors.push(`${node}: ${msg}`)
      if (this.live?.id === id && reader.openCount === 0) void this.stopLive(msg)
    })
    await reader.open(info.nodes, this.d.devInput)
    const timer = setTimeout(() => void this.stopLive('Time limit reached (2 minutes)'), LIVE_LIMIT_MS)
    timer.unref?.()
    this.live = { id, target, agg, reader, started: this.now(), stoppedReason: null, errors, timer }
    return this.liveState(id)
  }

  liveState(sessionId: string): LiveState {
    const l = this.live
    if (!l || l.id !== sessionId) throw new Error('This test session has ended. Start it again.')
    const nowUs = this.now() * 1000
    return { sessionId, running: l.stoppedReason === null, stoppedReason: l.stoppedReason, elapsedMs: this.now() - l.started, limitMs: LIVE_LIMIT_MS, errors: [...l.errors], ...l.agg.state(nowUs), untried: l.target.roles.includes('keyboard') ? this.untriedKeys(sessionId) : [] }
  }

  startStill(sessionId: string, durationMs: number): LiveState {
    const l = this.live
    if (!l || l.id !== sessionId || l.stoppedReason) throw new Error('Start the hands-on test first.')
    l.agg.startStill(durationMs, this.now() * 1000)
    return this.liveState(sessionId)
  }

  /** Keys of the main typing block not pressed yet in this session. */
  untriedKeys(sessionId: string): string[] {
    const l = this.live
    if (!l || l.id !== sessionId) return []
    const pressed = new Set(l.agg.pressedKeyCodes())
    return MAIN_KEYS.filter((k) => !pressed.has(k)).map(keyName)
  }

  async stopLive(reason = 'Stopped'): Promise<void> {
    const l = this.live
    if (!l || l.stoppedReason) return
    l.stoppedReason = reason
    clearTimeout(l.timer)
    await l.reader.close()
  }
}

