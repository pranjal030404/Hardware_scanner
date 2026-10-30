import { spawnSync } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SysReader } from '@collectors/core/sysreader'
import type { CommandRunner, RunResult } from '@collectors/core/runner'
import { openDatabase } from '../src/main/database/db'
import { PerformanceRepo } from '../src/main/database/performance-repo'
import { CapabilityService, hashWorkload, parseOd, PerformanceService, summarise, unlockedCpu } from '../src/performance'
import { builtinAssignments, makePlan, validate } from '../src/performance/profiles'
import { windowsState } from '../src/performance/windows'
import { helperStatus, HELPER_SOURCES, type HelperFs } from '../src/privileged/helpers'
import { PERFORMANCE_RULES } from '../src/diagnostics/rules-performance'
import type { RuleContext } from '../src/diagnostics/types'
import type { TestSample, TxRecord } from '../src/performance/types'
import { SettingsSchema } from '@shared/schemas'
import { IPC_REQUEST_SCHEMAS } from '@shared/ipc'
import { needsReview, pendingChanges, toDisplay, toRaw } from '../src/renderer/pages/performance-logic'
import { tmpRoot, writeTree, type Tree } from './helpers/fixtures'

const HELPER = 'resources/linux/hip-perf-helper'

/** An 8-thread Tiger Lake laptop like the one this was built on (2 frequency domains to keep it short). */
function laptop(over: Tree = {}): string {
  const root = tmpRoot()
  const pol: Tree = {}
  for (let i = 0; i < 2; i++) {
    const p = `sys/devices/system/cpu/cpufreq/policy${i}`
    Object.assign(pol, {
      [`${p}/scaling_driver`]: 'intel_pstate\n', [`${p}/cpuinfo_min_freq`]: '400000\n', [`${p}/cpuinfo_max_freq`]: '4400000\n',
      [`${p}/scaling_min_freq`]: '400000\n', [`${p}/scaling_max_freq`]: '4400000\n', [`${p}/scaling_cur_freq`]: `${1200000 + i * 1000000}\n`,
      [`${p}/scaling_governor`]: 'powersave\n', [`${p}/scaling_available_governors`]: 'performance powersave\n',
      [`${p}/energy_performance_preference`]: 'balance_performance\n', [`${p}/energy_performance_available_preferences`]: 'default performance balance_performance balance_power power \n'
    })
  }
  writeTree(root, {
    ...pol,
    'proc/cpuinfo': 'processor\t: 0\nmodel name\t: 11th Gen Intel(R) Core(TM) i5-1145G7 @ 2.60GHz\n',
    'proc/stat': 'cpu  100 0 100 800 0 0 0 0 0 0\n',
    'sys/devices/system/cpu/cpufreq/policy0/base_frequency': '2600000\n',
    'sys/devices/system/cpu/intel_pstate/status': 'active\n', 'sys/devices/system/cpu/intel_pstate/no_turbo': '0\n', 'sys/devices/system/cpu/intel_pstate/min_perf_pct': '9\n',
    'sys/devices/system/cpu/intel_pstate/max_perf_pct': '100\n', 'sys/devices/system/cpu/intel_pstate/hwp_dynamic_boost': '0\n',
    'sys/devices/system/cpu/cpu0/thermal_throttle/core_throttle_count': '3\n', 'sys/devices/system/cpu/cpu0/thermal_throttle/package_throttle_count': '2\n',
    'sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw': '28000000\n', 'sys/class/powercap/intel-rapl:0/constraint_0_max_power_uw': '28000000\n',
    'sys/class/powercap/intel-rapl:0/constraint_1_power_limit_uw': '51000000\n', 'sys/class/powercap/intel-rapl:0/constraint_0_name': 'long_term\n',
    'sys/class/powercap/intel-rapl:0/constraint_1_name': 'short_term\n', 'sys/class/powercap/intel-rapl:0/constraint_0_time_window_us': '27983872\n',
    'sys/class/drm/card1/gt_RP0_freq_mhz': '1300\n', 'sys/class/drm/card1/gt_RPn_freq_mhz': '100\n', 'sys/class/drm/card1/gt_RP1_freq_mhz': '650\n',
    'sys/class/drm/card1/gt_min_freq_mhz': '100\n', 'sys/class/drm/card1/gt_max_freq_mhz': '1100\n', 'sys/class/drm/card1/gt_boost_freq_mhz': '1100\n', 'sys/class/drm/card1/gt_act_freq_mhz': '650\n',
    'sys/class/drm/card1/device/vendor': '0x8086\n',
    'sys/class/hwmon/hwmon5/name': 'coretemp\n', 'sys/class/hwmon/hwmon5/temp1_input': '61000\n', 'sys/class/hwmon/hwmon5/temp1_crit': '100000\n',
    ...over
  })
  return root
}

const helper = (root: string, ...args: string[]) => spawnSync('sh', [HELPER, ...args], { env: { HIP_ROOT: root }, encoding: 'utf8' })
const file = (root: string, p: string): string => readFileSync(join(root, p), 'utf8').trim()
const ok = (stdout: string, code = 0): RunResult => ({ ok: code === 0, code, stdout, stderr: '', timedOut: false, notFound: false, truncated: false })
const noTools: CommandRunner = async () => ({ ...ok(''), ok: false, notFound: true })
const usable = async () => ({ name: 'hip-perf-helper' as const, path: '/usr/local/libexec/hardware-intelligence/hip-perf-helper', usable: true, reason: null })
const runHelper = (root: string, args: readonly string[]): RunResult => {
  const r = spawnSync('sh', [HELPER, ...args], { env: { HIP_ROOT: root }, encoding: 'utf8' })
  return { ok: r.status === 0, code: r.status, stdout: r.stdout, stderr: r.stderr, timedOut: false, notFound: false, truncated: false }
}

/**
 * The full service on a fixture machine. "pkexec" runs the real helper script unprivileged against the
 * fixture tree, so apply → read-back → rollback is exercised end to end without touching the host.
 */
function rig(opts: { tuning?: boolean; helperUsable?: boolean; tamper?: (root: string, args: string[]) => RunResult | null | Promise<RunResult | null> } = {}) {
  const root = laptop()
  const db = openDatabase(':memory:')
  const repo = new PerformanceRepo(db)
  const calls: string[][] = []
  const run: CommandRunner = async (file, args) => {
    calls.push([file, ...args])
    if (file !== 'pkexec') return { ...ok(''), ok: false, notFound: true }
    const t = await opts.tamper?.(root, [...args])
    return t ?? runHelper(root, args.slice(1))
  }
  let tuning = opts.tuning ?? true
  let clock = Date.parse('2026-10-27T06:00:00Z')
  const svc = new PerformanceService({
    reader: new SysReader(root), run, platform: 'linux', store: repo, threads: 2, tuningEnabled: () => tuning,
    limits: () => ({ maxTestSeconds: 300, minIntervalMs: 250 }),
    helper: opts.helperUsable === false ? async () => ({ name: 'hip-perf-helper', path: '', usable: false, reason: 'The privileged helper is not installed.' }) : usable,
    now: () => new Date((clock += 1000)), rateWindowMs: 0
  })
  return { svc, repo, root, calls, setTuning: (v: boolean) => (tuning = v), pk: () => calls.filter((c) => c[0] === 'pkexec').map((c) => c.slice(2)) }
}

describe('privileged helper (run unprivileged against a fixture tree)', () => {
  it('writes whitelisted settings, using each policy\'s own limit for "max"', () => {
    const root = laptop()
    const r = helper(root, 'cpu.governor=performance', 'cpu.epp=performance', 'cpu.turbo=1', 'cpu.max_khz=max', 'igpu.card1.max_mhz=1300', 'rapl.pl1_uw=40000000')
    expect(r.status).toBe(0)
    expect(file(root, 'sys/devices/system/cpu/cpufreq/policy1/scaling_governor')).toBe('performance')
    expect(file(root, 'sys/devices/system/cpu/cpufreq/policy1/scaling_max_freq')).toBe('4400000')
    expect(file(root, 'sys/class/drm/card1/gt_max_freq_mhz')).toBe('1300')
    expect(file(root, 'sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw')).toBe('40000000')
  })

  it('rejects values beyond hardware limits, injection attempts and unknown ids, writing nothing', () => {
    const root = laptop()
    const cases: [string, RegExp][] = [
      ['igpu.card1.max_mhz=1400', /100\.\.1300/], ['cpu.max_khz=5000000', /400000\.\.4400000/], ['rapl.pl1_uw=57000000', /5000000\.\.56000000/],
      ['cpu.governor=ondemand', /not available/], ['igpu.card1;rm.max_mhz=1', /bad GPU name|no such GPU/], ['fs.write=/etc/passwd', /unknown setting/],
      ['cpu.turbo=1; reboot', /outside|not a whole number/], ['tuned.profile=$(id)', /bad profile name/], ['cpu.governor', /expected id=value/]
    ]
    for (const [arg, err] of cases) {
      const r = helper(root, 'cpu.governor=performance', arg)
      expect(r.status, arg).toBe(2)
      expect(r.stderr, arg).toMatch(err)
    }
    expect(file(root, 'sys/devices/system/cpu/cpufreq/policy0/scaling_governor')).toBe('powersave')
  })

  it('validates AMD overdrive clocks and handles the xe GPU driver', () => {
    const od = 'OD_SCLK:\n0: 500Mhz\n1: 2500Mhz\nOD_RANGE:\nSCLK:     500Mhz       2800Mhz\n'
    const xe = 'sys/class/drm/card0/device/tile0/gt0/freq0'
    const root = laptop({ 'sys/class/drm/card2/device/pp_od_clk_voltage': od, [`${xe}/rp0_freq`]: '1500\n', [`${xe}/rpn_freq`]: '100\n', [`${xe}/max_freq`]: '1200\n' })
    expect(helper(root, 'amdgpu.card2.sclk_mhz=2900').stderr).toMatch(/500\.\.2800/)
    expect(helper(root, 'amdgpu.card2.sclk_mhz=2600').stdout).toMatch(/s 1 2600\nOK .* = c/)
    expect(helper(root, 'igpu.card0.max_mhz=1500').status).toBe(0)
    expect(file(root, `${xe}/max_freq`)).toBe('1500')
    expect(helper(root, 'igpu.card0.boost_mhz=1500').stderr).toMatch(/no boost clock/)
  })
})

describe('installed helper verification', () => {
  const fake = (o: { dirUid?: number; dirMode?: number; uid?: number; mode?: number; link?: boolean; content?: string; noPolicy?: boolean; missing?: boolean }): HelperFs => ({
    async lstat(p) {
      if (p.endsWith('.policy')) { if (o.noPolicy) throw new Error('ENOENT'); return { uid: 0, mode: 0o644, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false } }
      if (p.endsWith('hardware-intelligence')) return { uid: o.dirUid ?? 0, mode: o.dirMode ?? 0o755, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false }
      if (o.missing) throw new Error('ENOENT')
      return { uid: o.uid ?? 0, mode: o.mode ?? 0o755, isFile: () => !o.link, isDirectory: () => false, isSymbolicLink: () => !!o.link }
    },
    async readFile() { return o.content ?? HELPER_SOURCES['hip-perf-helper'] }
  })
  it('accepts only a root-owned, unmodified helper with its polkit policy', async () => {
    expect(await helperStatus('hip-perf-helper', 'linux', fake({}))).toMatchObject({ usable: true })
    const reasons: [Parameters<typeof fake>[0], RegExp][] = [
      [{ missing: true }, /not installed/], [{ uid: 1000 }, /not owned by root/], [{ mode: 0o775 }, /modified by non-root/], [{ link: true }, /not a regular file/],
      [{ content: '#!/bin/sh\nrm -rf /\n' }, /differs from the version/], [{ noPolicy: true }, /polkit policy/], [{ dirMode: 0o777 }, /only root can write/], [{ mode: 0o644 }, /not executable/]
    ]
    for (const [o, re] of reasons) expect((await helperStatus('hip-perf-helper', 'linux', fake(o))).reason, JSON.stringify(o)).toMatch(re)
    expect((await helperStatus('hip-perf-helper', 'win32', fake({}))).usable).toBe(false)
  })
})

describe('capability discovery', () => {
  it('reports per-control status with evidence: writable+helper = not verified; read-only file = unavailable; absent = explained', async () => {
    const root = laptop()
    chmodSync(join(root, 'sys/devices/system/cpu/intel_pstate/hwp_dynamic_boost'), 0o444)
    const caps = new CapabilityService({ reader: new SysReader(root), run: noTools, platform: 'linux', rateWindowMs: 0 })
    const s = await caps.snapshot()
    const cs = await caps.controls(s, { helperUsable: true, helperReason: null, verified: new Set(['cpu.governor']) })
    const by = Object.fromEntries(cs.map((c) => [c.id, c]))
    expect(by['cpu.governor']).toMatchObject({ status: 'supported', read: true, write: true, options: ['performance', 'powersave'], current: 'powersave' })
    expect(by['cpu.epp']).toMatchObject({ status: 'not_verified', write: true })
    expect(by['cpu.dynamic_boost']).toMatchObject({ status: 'unavailable', write: false })
    expect(by['cpu.dynamic_boost']!.reason).toMatch(/read-only/)
    expect(by['cpu.max_khz']).toMatchObject({ min: 400000, max: 4400000, unit: 'GHz', scale: 1e6, persistence: 'runtime' })
    expect(by['rapl.pl1_uw']).toMatchObject({ max: 56e6, rangeSource: 'safety ceiling: 2× the firmware rating', risk: 'medium' })
    expect(by['cpu.multiplier']).toMatchObject({ status: 'unsupported', write: false })
    expect(by['cpu.multiplier']!.reason).toMatch(/Locked by the manufacturer.*4\.40 GHz/)
    expect(by['cpu.voltage_offset']!.reason).toMatch(/No documented kernel interface/)
    expect(by['igpu.card1.overclock']!.reason).toMatch(/1300 MHz/)
    const noHelper = await caps.controls(s, { helperUsable: false, helperReason: 'not installed', verified: new Set() })
    expect(noHelper.find((c) => c.id === 'cpu.governor')).toMatchObject({ status: 'permission_required', write: false, reason: 'not installed' })
  })

  it('measures with sources and marks what this machine does not expose as not measured', async () => {
    const caps = new CapabilityService({ reader: new SysReader(laptop()), run: noTools, platform: 'linux', rateWindowMs: 0 })
    const t = await caps.telemetry(await caps.snapshot())
    const by = Object.fromEntries(t.map((m) => [m.label, m]))
    expect(by['CPU clock (observed, average)']).toMatchObject({ value: '1700 MHz', state: 'live', source: '/sys/devices/system/cpu/cpufreq/policy*/scaling_cur_freq' })
    expect(by['CPU temperature']).toMatchObject({ value: '61 °C (device limit 100 °C)', source: '/sys/class/hwmon/hwmon5/temp1_input' })
    expect(by['Thermal-throttle events since boot']!.value).toBe('5')
    expect(by['CPU package power']).toMatchObject({ state: 'unavailable', value: null })
    expect(by['CPU package power']!.reason).toMatch(/root only/)
    expect(by['GPU card1 utilisation']).toMatchObject({ state: 'unavailable' })
    expect(by['Fan speed']).toMatchObject({ state: 'unavailable' })
    expect(t.every((m) => m.state !== 'live' || (m.at && m.source))).toBe(true)
  })

  it('fingerprints the hardware configuration, not its settings', async () => {
    const f = async (over: Tree) => { const c = new CapabilityService({ reader: new SysReader(laptop(over)), run: noTools, platform: 'linux' }); return c.fingerprint(await c.snapshot()) }
    expect(await f({})).toBe(await f({ 'sys/devices/system/cpu/cpufreq/policy0/scaling_governor': 'performance\n' }))
    expect(await f({})).not.toBe(await f({ 'sys/class/drm/card1/gt_RP0_freq_mhz': '1450\n' }))
  })
})

describe('profiles', () => {
  it('plans built-ins from the device; Stock uses documented defaults and lists what it cannot know', async () => {
    const caps = new CapabilityService({ reader: new SysReader(laptop()), run: noTools, platform: 'linux' })
    const s = await caps.snapshot()
    const stock = builtinAssignments(s, 'stock')
    expect(Object.fromEntries(stock.assignments)).toMatchObject({ 'cpu.governor': 'powersave', 'cpu.epp': 'default', 'rapl.pl1_uw': '28000000', 'igpu.card1.max_mhz': '1300', 'igpu.card1.min_mhz': '100' })
    expect(stock.notes.get('cpu.governor')).toMatch(/intel_pstate driver’s default in active mode/)
    expect(stock.skipped).toEqual(['Short boost power (PL2): the firmware reports no factory value, left unchanged'])
    const controls = await caps.controls(s, { helperUsable: true, helperReason: null, verified: new Set() })
    const balanced = makePlan(caps, s, controls, 'balanced', 'Balanced', true, builtinAssignments(s, 'balanced').assignments)
    expect(balanced.changes.map((c) => [c.label, c.from, c.to])).toEqual([['Graphics highest clock (card1)', '1100 MHz', '1300 MHz'], ['Graphics boost clock (card1)', '1100 MHz', '1300 MHz']])
    expect(builtinAssignments(s, 'quiet').assignments).toContainEqual(['igpu.card1.max_mhz', '650'])
  })

  it('Maximum takes every writable control to the upper limit the hardware reports, and invents none', async () => {
    const caps = new CapabilityService({ reader: new SysReader(laptop()), run: noTools, platform: 'linux' })
    const s = await caps.snapshot()
    const m = builtinAssignments(s, 'maximum')
    expect(Object.fromEntries(m.assignments)).toEqual({
      'cpu.governor': 'performance', 'cpu.epp': 'performance', 'cpu.turbo': '1', 'cpu.max_khz': 'max', 'cpu.min_khz': 'max', 'cpu.max_perf_pct': '100',
      'cpu.min_perf_pct': '100', 'cpu.dynamic_boost': '1', 'igpu.card1.max_mhz': '1300', 'igpu.card1.boost_mhz': '1300', 'igpu.card1.min_mhz': '1300'
    })
    expect(m.notes.get('cpu.min_khz')).toMatch(/pinned at the maximum/)
    expect(m.skipped.join(' | ')).toMatch(/CPU clock above 4\.40 GHz: locked by the manufacturer.*no upper limit, so none is assumed/)
    const controls = await caps.controls(s, { helperUsable: true, helperReason: null, verified: new Set() })
    const plan = makePlan(caps, s, controls, 'maximum', 'Maximum', true, m.assignments, m.notes, m.skipped, null, m.risks)
    expect(plan.changes.find((c) => c.id === 'cpu.min_khz')).toMatchObject({ from: '0.40 GHz', to: '4.40 GHz', risk: 'high' })
    expect(plan.changes.find((c) => c.id === 'cpu.dynamic_boost')).toMatchObject({ risk: 'low' })
    // Lowering a power limit (Stock bringing 30 W back to the 28 W rating) is not risky.
    const hot = new CapabilityService({ reader: new SysReader(laptop({ 'sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw': '30000000\n' })), run: noTools, platform: 'linux' })
    const hs = await hot.snapshot()
    const stock = builtinAssignments(hs, 'stock')
    const sp = makePlan(hot, hs, await hot.controls(hs, { helperUsable: true, helperReason: null, verified: new Set() }), 'stock', 'Stock', true, stock.assignments, stock.notes, stock.skipped, null, stock.risks)
    expect(sp.changes.find((c) => c.id === 'rapl.pl1_uw')).toMatchObject({ from: '30 W', to: '28 W', risk: 'low' })
    // AMD and NVIDIA: the driver's / card's own maxima.
    const s2 = { ...s, amds: [{ card: 'card2', name: 'RX', level: 'auto', od: { sclk: [500, 2800] as [number, number], mclk: [674, 1200] as [number, number], curSclk: 2500, curMclk: 1000 }, cap: { cur: 200e6, min: 100e6, max: 250e6, def: 200e6 } }], nvidia: { name: 'RTX', limit: 170, def: 170, min: 100, max: 200 } }
    expect(Object.fromEntries(builtinAssignments(s2, 'maximum').assignments)).toMatchObject({ 'amdgpu.card2.level': 'manual', 'amdgpu.card2.sclk_mhz': '2800', 'amdgpu.card2.mclk_mhz': '1200', 'amdgpu.card2.power_cap_uw': '250000000', 'nvidia.power_w': '200' })
  })

  it('reports memory and explains that its clock is set by firmware', async () => {
    const t17 = Buffer.alloc(0x28); t17[0] = 17; t17[1] = 0x28; t17.writeUInt16LE(8192, 0x0c); t17.writeUInt16LE(3200, 0x15); t17.writeUInt16LE(2933, 0x20)
    const root = laptop({ 'proc/meminfo': 'MemTotal:       16000000 kB\nMemAvailable:    8000000 kB\n', 'sys/firmware/dmi/entries/17-0/raw': t17 })
    const caps = new CapabilityService({ reader: new SysReader(root), run: noTools, platform: 'linux', rateWindowMs: 0 })
    const s = await caps.snapshot()
    const devs = await caps.devices(s, { helperUsable: true, helperReason: null, verified: new Set(), originals: new Map() })
    const mem = devs.find((d) => d.id === 'memory')!
    expect(mem.summary).toMatch(/15\.3 GiB installed · 1 module · speed 2933 MT\/s/)
    expect(mem.settings[1]).toMatchObject({ allowed: 'rated 3200 MT/s', adjustable: false })
    expect(mem.controls).toEqual([expect.objectContaining({ id: 'memory.clock', status: 'unsupported', write: false })])
    expect((await caps.telemetry(s)).find((x) => x.label === 'Memory in use')).toMatchObject({ value: '7.6 of 15.3 GiB', source: '/proc/meminfo' })
  })

  it('validates requested values against the control', async () => {
    const caps = new CapabilityService({ reader: new SysReader(laptop()), run: noTools, platform: 'linux' })
    const s = await caps.snapshot()
    const byId = new Map((await caps.controls(s, { helperUsable: true, helperReason: null, verified: new Set() })).map((c) => [c.id, c]))
    expect(validate(byId, 'cpu.governor', 'ondemand')).toMatch(/not offered/)
    expect(validate(byId, 'rapl.pl1_uw', '57000000')).toMatch(/above the allowed maximum/)
    expect(validate(byId, 'igpu.card1.max_mhz', '1e3')).toMatch(/not a whole number/)
    expect(validate(byId, 'cpu.multiplier', '50')).toMatch(/Locked/)
    expect(validate(byId, 'nope', '1')).toMatch(/no such control/)
    expect(validate(byId, 'cpu.max_khz', 'max')).toBeNull()
  })
})

describe('tuning transactions', () => {
  it('applies a profile, reads every setting back and records previous/requested/effective values', async () => {
    const r = rig()
    const res = await r.svc.applyProfile('performance')
    const tx = res.transaction!
    expect(tx.status).toBe('verified')
    expect(tx.items.map((i) => [i.controlId, i.previous, i.requested, i.effective, i.verification])).toEqual([
      ['cpu.governor', 'powersave', 'performance', 'performance', 'verified'], ['cpu.epp', 'balance_performance', 'performance', 'performance', 'verified'],
      ['cpu.dynamic_boost', 'off', 'on', 'on', 'verified'], ['igpu.card1.max_mhz', '1100 MHz', '1300 MHz', '1300 MHz', 'verified'],
      ['igpu.card1.boost_mhz', '1100 MHz', '1300 MHz', '1300 MHz', 'verified'], ['igpu.card1.min_mhz', '100 MHz', '650 MHz', '650 MHz', 'verified']
    ])
    expect(file(r.root, 'sys/class/drm/card1/gt_min_freq_mhz')).toBe('650')
    // A control becomes "verified here" only after a successful read-back.
    expect(res.state.devices.flatMap((d) => d.controls).find((c) => c.id === 'cpu.governor')!.status).toBe('supported')
    expect(res.state.matches).toBe('performance')
    // Applying again changes nothing and runs nothing.
    expect((await r.svc.applyProfile('performance')).transaction).toBeNull()
    expect(r.pk()).toHaveLength(1)
  })

  it('reports a mismatch when the kernel does not keep the requested value', async () => {
    // The fake kernel clamps the GPU clock to 1200 MHz instead of 1300.
    const r = rig({ tamper: (root, args) => { const out = runHelper(root, args.slice(1)); writeFileSync(join(root, 'sys/class/drm/card1/gt_max_freq_mhz'), '1200\n'); return out } })
    const tx = (await r.svc.applyCustom([{ id: 'igpu.card1.max_mhz', value: '1300' }, { id: 'cpu.governor', value: 'performance' }], 'test')).transaction!
    expect(tx.status).toBe('partially_verified')
    expect(tx.items.find((i) => i.controlId === 'igpu.card1.max_mhz')).toMatchObject({ verification: 'mismatch', effective: '1200 MHz', message: 'Requested 1300 MHz, the kernel reports 1200 MHz.' })
  })

  it('rolls back what changed when the helper fails part-way, and verifies the rollback', async () => {
    let n = 0
    // First call: only the governor is written, then the helper "fails"; the second call (rollback) runs normally.
    const r = rig({ tamper: (root, args) => { if (n++ > 0) return null; runHelper(root, [args[1]!]); return { ...ok('', 2), stderr: 'ERROR the kernel refused 1300 for /sys/class/drm/card1/gt_max_freq_mhz' } } })
    const tx = (await r.svc.applyCustom([{ id: 'cpu.governor', value: 'performance' }, { id: 'igpu.card1.max_mhz', value: '1300' }], 'partial')).transaction!
    expect(tx.status).toBe('rolled_back')
    expect(tx.error).toMatch(/kernel refused 1300.*were restored/)
    expect(tx.items.map((i) => [i.controlId, i.verification])).toEqual([['cpu.governor', 'rolled_back'], ['igpu.card1.max_mhz', 'not_applied']])
    expect(file(r.root, 'sys/devices/system/cpu/cpufreq/policy0/scaling_governor')).toBe('powersave')
    expect(r.pk()[1]).toEqual(['cpu.governor=powersave'])
  })

  it('records a rollback that could not be confirmed', async () => {
    const r = rig({ tamper: (root, args) => { if (args[1] === 'cpu.governor=performance') { runHelper(root, args.slice(1)); return { ...ok('', 2), stderr: 'ERROR boom' } } return { ...ok('', 2), stderr: 'ERROR still broken' } } })
    const tx = (await r.svc.applyCustom([{ id: 'cpu.governor', value: 'performance' }], 'y')).transaction!
    expect(tx.status).toBe('rollback_failed')
    expect(tx.items[0]).toMatchObject({ verification: 'rollback_failed' })
    expect(tx.items[0]!.message).toMatch(/Could not be put back \(still broken\)/)
    expect(r.repo.failedRollbacks().map((t) => t.id)).toEqual([tx.id])
  })

  it('refuses without validation, permission or the settings switch, changing nothing', async () => {
    await expect(rig().svc.applyCustom([{ id: 'rapl.pl1_uw', value: '99000000' }], 'x')).rejects.toThrow(/Nothing was changed.*above the allowed maximum/)
    await expect(rig().svc.applyCustom([{ id: 'rapl.pl1_uw', value: '55000000' }], 'x')).rejects.toThrow(/PL1\) cannot be higher/)
    await expect(rig({ tuning: false }).svc.applyProfile('performance')).rejects.toThrow(/switched off in Settings/)
    const r = rig({ helperUsable: false })
    await expect(r.svc.applyProfile('performance')).rejects.toThrow(/not installed/)
    expect(r.pk()).toEqual([])
    await expect(rig().svc.applyProfile('custom:99')).rejects.toThrow(/Unknown profile/)
  })

  it('serialises: a second change while one is running is refused', async () => {
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const r = rig({ tamper: async () => { await gate; return null } })
    const first = r.svc.applyCustom([{ id: 'cpu.governor', value: 'performance' }], 'first')
    await new Promise((res) => setTimeout(res, 30))
    await expect(r.svc.applyCustom([{ id: 'cpu.epp', value: 'power' }], 'second')).rejects.toThrow(/Another tuning change/)
    await expect(r.svc.startTest('monitor', 30, 1000)).rejects.toThrow(/Another tuning change/)
    release()
    expect((await first).transaction!.status).toBe('verified')
  })

  it('undoes the last change and restores the original values', async () => {
    const r = rig()
    await r.svc.applyProfile('performance')
    await r.svc.applyCustom([{ id: 'rapl.pl1_uw', value: '35000000' }], 'More power')
    const undo = (await r.svc.restore('undo')).transaction!
    expect(undo).toMatchObject({ kind: 'rollback', label: 'Undo: More power', status: 'verified' })
    expect(file(r.root, 'sys/class/powercap/intel-rapl:0/constraint_0_power_limit_uw')).toBe('28000000')
    const orig = (await r.svc.restore('original')).transaction!
    expect(orig.status).toBe('verified')
    expect(file(r.root, 'sys/devices/system/cpu/cpufreq/policy0/scaling_governor')).toBe('powersave')
    expect(file(r.root, 'sys/class/drm/card1/gt_max_freq_mhz')).toBe('1100')
    expect(r.svc.history().map((t) => [t.label, t.status])).toEqual([['Restore original settings', 'verified'], ['Undo: More power', 'verified'], ['More power', 'rolled_back'], ['Performance', 'verified']])
  })

  it('saves profiles for this hardware only', async () => {
    const r = rig()
    await r.svc.saveProfile('Mine')
    const st = (await r.svc.applyProfile('performance')).state
    const mine = st.profiles.find((p) => p.title === 'Mine')!
    expect(mine).toMatchObject({ builtin: false, compatible: true })
    expect(mine.changes.map((c) => c.id)).toContain('cpu.governor')
    r.repo.saveProfile('Other laptop', 'deadbeefdeadbeef', [['cpu.governor', 'performance']], '2026-10-27T00:00:00Z')
    const other = (await r.svc.state()).profiles.find((p) => p.title === 'Other laptop')!
    expect(other).toMatchObject({ compatible: false })
    expect(other.incompatibleReason).toMatch(/different hardware/)
    await expect(r.svc.applyProfile(other.id)).rejects.toThrow(/different hardware/)
  })
})

describe('test sessions', () => {
  const live = () => ({ at: '', cpuMHz: 3000, cpuMaxMHz: 4400, cpuUtilization: 99, gpuMHz: 0, gpuMaxMHz: 1300, temperatureC: 80, temperatureLimitC: 100, throttleEvents: 5, sources: {} })

  it('summarises honestly: score, sustained change, throttling and that it does not prove stability', () => {
    const samples: TestSample[] = Array.from({ length: 9 }, (_, i) => ({ tMs: i * 1000, cpuMHz: 4000 - i * 100, temperatureC: 90 + i, utilization: 100, throttleEvents: 5 + (i > 6 ? 2 : 0), gpuMHz: null, throughput: i < 3 ? 1000 : i < 6 ? 900 : 800 }))
    const s = summarise('benchmark', samples, 9 * 900 * 2 ** 20, 9, 100, 5)
    expect(s).toMatchObject({ score: 900, avgMHz: 3600, maxTemperatureC: 98, throttleEvents: 2, sustainedChangePct: -20 })
    expect(s.notes.join(' ')).toMatch(/does not prove that the settings are stable.*2 thermal-throttle events.*within 5 °C.*fell 20 %/)
  })

  it('runs, records samples, and blocks tuning while it runs; cancel stops it', async () => {
    const r = rig()
    let bytes = 0
    const d = (r.svc.tests as unknown as { d: { workload: unknown; live: unknown } }).d
    d.workload = () => ({ bytes: () => (bytes += 50 * 2 ** 20), stop: async () => undefined })
    d.live = async () => live()
    const p = await r.svc.startTest('benchmark', 30, 250)
    expect(p.session.status).toBe('running')
    await expect(r.svc.applyProfile('performance')).rejects.toThrow(/performance test is running/)
    await expect(r.svc.startTest('monitor', 30, 250)).rejects.toThrow(/already running/)
    await new Promise((res) => setTimeout(res, 700))
    const done = await r.svc.tests.cancel()
    expect(done!.session.status).toBe('cancelled')
    expect(done!.samples.length).toBeGreaterThanOrEqual(1)
    expect(r.svc.listTests()[0]).toMatchObject({ status: 'cancelled', mode: 'benchmark', threads: 2 })
    expect(r.svc.getTest(done!.session.id)!.samples.length).toBe(done!.samples.length)
    // The lock is released: tuning works again.
    expect((await r.svc.applyProfile('performance')).transaction!.status).toBe('verified')
  })

  it('the built-in workload really hashes data in worker threads and stops on request', async () => {
    const w = hashWorkload(1, (e) => { throw e })
    await new Promise((res) => setTimeout(res, 400))
    const b = w.bytes()
    await w.stop()
    expect(b).toBeGreaterThan(0)
    expect(b % 2 ** 20).toBe(0)
  })

  it('enforces the configured limits', async () => {
    const r = rig()
    await expect(r.svc.startTest('benchmark', 301, 1000)).rejects.toThrow(/longest allowed test is 300 s/)
    await expect(r.svc.startTest('benchmark', 60, 100)).rejects.toThrow(/shortest allowed sampling interval is 250 ms/)
  })
})

describe('performance diagnostics', () => {
  const tx = (status: TxRecord['status'], items: Partial<TxRecord['items'][number]>[]): TxRecord => ({ id: 7, startedAt: '2026-10-27T06:00:00Z', finishedAt: '2026-10-27T06:00:01Z', kind: 'profile', label: 'Performance', fingerprint: 'f', status, error: null, items: items.map((i) => ({ controlId: 'igpu.card1.max_mhz', label: 'GPU max', previousRaw: '1100', previous: '1100 MHz', requestedRaw: '1300', requested: '1300 MHz', effective: '1200 MHz', verification: 'mismatch' as const, message: null, ...i })) })
  const ctx = (p: Partial<NonNullable<RuleContext['performance']>>): RuleContext => ({
    now: new Date('2026-10-27T07:00:00Z'), settings: SettingsSchema.parse({}), devices: [], collectors: [], monitor: null, lastInventoryScanAt: null, recentEvents: [], freshMs: 1, staleMs: 1,
    performance: { tuningEnabled: true, helperUsable: true, helperReason: null, lastTx: null, failedRollbacks: [], lastTest: null, ...p }
  })
  const run = (id: string, c: RuleContext) => PERFORMANCE_RULES.find((r) => r.id === id)!.evaluate(c)

  it('cites evidence and never treats a missing helper as a hardware fault', () => {
    expect(run('performance.permission_required', ctx({ helperUsable: false, helperReason: 'not installed' }))).toMatchObject({ findings: [{ severity: 'info', description: 'not installed' }] })
    expect(run('performance.permission_required', ctx({ tuningEnabled: false, helperUsable: false }))).toMatchObject({ findings: [] })
    expect(run('performance.control_verification_failed', ctx({ lastTx: tx('partially_verified', [{}]) }))).toMatchObject({ findings: [{ severity: 'low', evidence: [{ type: 'tuning_transaction', ref: '7', value: '1200 MHz' }] }] })
    expect(run('performance.configuration_not_restored', ctx({ failedRollbacks: [tx('rollback_failed', [{ verification: 'rollback_failed', message: 'still 1300' }])] }))).toMatchObject({ findings: [{ severity: 'medium' }] })
    const test = { id: 3, startedAt: '2026-10-27T06:30:00Z', finishedAt: '2026-10-27T06:31:00Z', mode: 'benchmark' as const, durationS: 60, intervalMs: 1000, threads: 8, status: 'completed' as const, fingerprint: 'f', txId: 7, profile: 'performance', error: null, summary: { score: 1, avgMHz: 1, maxMHz: 1, maxTemperatureC: 96, temperatureLimitC: 100, throttleEvents: 0, sustainedChangePct: 0, notes: [] } }
    expect(run('performance.thermal_limit_approaching', ctx({ lastTest: test }))).toMatchObject({ findings: [{ severity: 'medium', evidence: [{ type: 'test_session', value: 96 }] }] })
    expect(run('performance.thermal_limit_approaching', ctx({ lastTest: { ...test, summary: { ...test.summary, temperatureLimitC: null } } }))).toMatchObject({ findings: [] })
    expect(run('performance.test_failed', ctx({ lastTest: { ...test, status: 'failed', error: 'workload crashed' } }))).toMatchObject({ findings: [{ severity: 'low' }] })
    expect(run('performance.test_failed', ctx({ lastTest: { ...test, status: 'cancelled' } }))).toMatchObject({ findings: [] })
    expect(run('performance.permission_required', { ...ctx({}), performance: null })).toMatchObject({ status: 'insufficient_data' })
  })
})

describe('Windows', () => {
  it('is monitoring only and never claims writable controls', async () => {
    const st = await windowsState({
      run: async () => ok('NVIDIA GeForce RTX 3060, 54, 21.5, 3, 210, 405, 512, 12288\r\n'), now: () => new Date('2026-10-27T06:00:00Z'),
      cpus: () => [{ model: 'Intel(R) Core(TM) i7-12700K', speed: 3600 }], exists: async (p) => p.includes('System32')
    })
    expect(st).toMatchObject({ monitoringOnly: true, tuningEnabled: false, profiles: [] })
    expect(st.devices.flatMap((d) => d.controls).every((c) => !c.write && c.status === 'unavailable')).toBe(true)
    expect(st.telemetry.find((m) => m.label === 'NVIDIA GeForce RTX 3060 temperature')).toMatchObject({ value: '54 °C', state: 'live', source: 'nvidia-smi --query-gpu' })
  })
})

describe('IPC and renderer helpers', () => {
  it('accepts only plain tokens and known profiles', () => {
    const custom = IPC_REQUEST_SCHEMAS['perf:applyCustom']
    expect(custom.safeParse({ label: 'x', values: [{ id: 'cpu.governor', value: 'performance' }] }).success).toBe(true)
    for (const value of ['$(reboot)', 'a b', 'x;y', '../x', '']) expect(custom.safeParse({ label: 'x', values: [{ id: 'cpu.governor', value }] }).success, value).toBe(false)
    expect(custom.safeParse({ label: 'x', values: [{ id: 'cpu/../x', value: '1' }] }).success).toBe(false)
    expect(IPC_REQUEST_SCHEMAS['perf:applyProfile'].safeParse({ id: 'performance' }).success).toBe(true)
    expect(IPC_REQUEST_SCHEMAS['perf:applyProfile'].safeParse({ id: 'maximum' }).success).toBe(true)
    expect(IPC_REQUEST_SCHEMAS['perf:applyProfile'].safeParse({ id: 'turbo' }).success).toBe(false)
    expect(IPC_REQUEST_SCHEMAS['perf:testStart'].safeParse({ mode: 'benchmark', seconds: 5, intervalMs: 1000 }).success).toBe(false)
  })

  it('converts display units, builds the review list and decides when review is required', () => {
    const c = { id: 'rapl.pl1_uw', deviceId: 'power', label: 'PL1', status: 'not_verified' as const, read: true, write: true, current: '28 W', currentRaw: '28000000', min: 5e6, max: 56e6, unit: 'W', scale: 1e6, step: 1e6, source: '', persistence: 'runtime' as const, rebootRequired: false as const, restorable: true, risk: 'medium' as const, reason: null }
    expect(toDisplay(c, '28000000')).toBe('28')
    expect(toRaw(c, '33.4')).toBe('33000000')
    expect(toRaw(c, '999')).toBe('56000000')
    expect(toRaw(c, 'abc')).toBeNull()
    const ch = pendingChanges([c], { 'rapl.pl1_uw': '35000000' })
    expect(ch).toEqual([{ id: 'rapl.pl1_uw', label: 'PL1', from: '28 W', to: '35 W', raw: '35000000', risk: 'high' }])
    expect(needsReview(ch, false)).toBe(true)
    expect(needsReview(pendingChanges([c], { 'rapl.pl1_uw': '20000000' }), false)).toBe(false)
  })

  it('recognises unlocked CPUs and parses amdgpu overdrive tables', () => {
    expect(unlockedCpu('11th Gen Intel(R) Core(TM) i5-1145G7 @ 2.60GHz')).toBe(false)
    expect(unlockedCpu('Intel(R) Core(TM) i9-13900K')).toBe(true)
    expect(unlockedCpu('AMD Ryzen 7 5800U with Radeon Graphics')).toBe(false)
    expect(parseOd('OD_SCLK:\n0: 500Mhz\n1: 2500Mhz\nOD_RANGE:\nSCLK:     500Mhz       2800Mhz\n')).toMatchObject({ sclk: [500, 2800], curSclk: 2500 })
  })
})

describe('performance history storage', () => {
  it('migrates, prunes by age and closes work left running by a crash', () => {
    const db = openDatabase(':memory:')
    const repo = new PerformanceRepo(db)
    const id = repo.startTx('profile', 'old', 'f', [{ controlId: 'cpu.governor', label: 'g', previousRaw: 'powersave', previous: 'powersave', requestedRaw: 'performance', requested: 'performance', effective: null, verification: 'pending', message: null }], '2020-01-01T00:00:00Z')
    expect(repo.closeInterrupted('2026-10-27T00:00:00Z')).toBe(1)
    expect(repo.getTx(id)).toMatchObject({ status: 'unverifiable' })
    expect(repo.getTx(id)!.error).toMatch(/stopped before this change could be verified/)
    expect(repo.prune(90, new Date('2026-10-27T00:00:00Z'))).toBe(1)
    expect(repo.recentTx(10)).toEqual([])
    expect((db.prepare('SELECT COUNT(*) AS n FROM perf_transaction_items').get() as { n: number }).n).toBe(0)
  })
})
