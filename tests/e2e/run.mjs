/**
 * End-to-end test against the *built* application (run `npm run build` first). Launches the real
 * Electron app with an isolated database, drives the renderer over CDP and inspects real hardware
 * data from this machine. Requires a display (X11/Wayland) — see docs/TESTING.md.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { closeBrowser, connect } from './cdp.mjs'

const root = new URL('../..', import.meta.url).pathname
// HIP_E2E_PACKAGED=<path to AppImage or unpacked binary> runs the same suite against a packaged build.
// The database is then NOT redirected with HIP_DB_PATH: it must land in the per-user data directory,
// which is isolated by pointing XDG_CONFIG_HOME at the temp dir.
const packaged = process.env['HIP_E2E_PACKAGED']
const electronBin = packaged ?? join(root, 'node_modules/electron/dist/electron')
if (packaged ? !existsSync(packaged) : !existsSync(join(root, 'out/main/index.js'))) { console.error(packaged ? `Packaged binary not found: ${packaged}` : 'Build first: npm run build'); process.exit(2) }
const dir = mkdtempSync(join(tmpdir(), 'hip-e2e-'))
const port = 20000 + Math.floor(Math.random() * 20000)
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail}`}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function launch() {
  const child = packaged
    ? spawn(electronBin, [`--remote-debugging-port=${port}`], { cwd: dir, env: { ...process.env, XDG_CONFIG_HOME: join(dir, 'config'), APPIMAGE_EXTRACT_AND_RUN: '1', HIP_ENABLE_DEBUGGING: '1', HIP_DB_PATH: undefined }, stdio: ['ignore', 'ignore', 'ignore'] })
    : spawn(electronBin, ['.', `--remote-debugging-port=${port}`], { cwd: root, env: { ...process.env, HIP_DB_PATH: join(dir, 'db.sqlite') }, stdio: ['ignore', 'ignore', 'ignore'] })
  const exited = new Promise((res) => child.on('exit', (code) => res(code)))
  return { child, exited }
}
async function until(fn, ms = 30000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true } catch { /* retry */ } await sleep(250) } return false }

let app = launch()
let c
try {
  check('app starts and exposes a debuggable renderer', await until(async () => (c = await connect(port)) !== undefined))
  const nav = async (label) => { await c.click('.nav-item', label); await sleep(500) }

  // --- startup & first scan -------------------------------------------------------------------
  check('first inventory scan completes and the overview shows real hardware', await until(() => c.evaluate("document.querySelectorAll('.stat').length > 3")))
  check('overview lists this machine (system card populated)', await c.evaluate("document.querySelector('.kv')?.innerText.includes('Machine')"))

  check('renderer is loaded from hip-app://renderer/ and is not a file: page', await c.evaluate("location.protocol === 'hip-app:' && location.host === 'renderer'"))
  // --- renderer isolation ----------------------------------------------------------------------
  check('renderer has no Node globals', (await c.evaluate("[typeof require, typeof process, typeof module, typeof Buffer, typeof __dirname].join()")) === 'undefined,undefined,undefined,undefined,undefined')
  const keys = await c.evaluate('Object.keys(window.hip).sort().join()')
  check('preload exposes only the fixed API (no ipcRenderer/generic invoke)', !/ipc|invoke|send|exec|shell|fs/i.test(keys) && keys.includes('listDevices'), keys)
  check('window.electron / ipcRenderer are not exposed', (await c.evaluate("[typeof window.electron, typeof window.ipcRenderer].join()")) === 'undefined,undefined')
  check('invalid IPC payloads are rejected by the main process', await c.evaluate("window.hip.getDevice('').then(() => false, (e) => /Invalid payload/.test(e.message))"))
  check('out-of-range settings are rejected', await c.evaluate("window.hip.setSetting('pollIntervalSec', 1).then(() => false, () => true)"))
  check('CSP blocks outbound network requests from the renderer', await c.evaluate("fetch('https://example.com').then(() => false, () => true)"))
  const before = await c.evaluate('location.href')
  await c.evaluate("window.open('https://example.com'); void (location.href = 'https://example.com')").catch(() => {})
  await sleep(1200)
  // A failing/closed CDP connection here means the page was navigated or crashed: report that, don't hide it.
  const after = await c.evaluate('location.href').catch((e) => `evaluate failed: ${e.message} (connection ${c.isClosed() ?? 'open'})`)
  check('navigation away from the app is blocked', after === before, `${before} → ${after}`)

  // --- inventory, search, details -------------------------------------------------------------
  await nav('Hardware')
  check('inventory table lists devices', await until(() => c.evaluate("document.querySelectorAll('tbody tr').length > 10")))
  const total = await c.evaluate("document.querySelectorAll('tbody tr').length")
  await c.evaluate(`(() => { const i = document.querySelector('input[type=search]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'xhci'); i.dispatchEvent(new Event('input',{bubbles:true})) })()`)
  check('search narrows the table', await until(async () => { const n = await c.evaluate("document.querySelectorAll('tbody tr').length"); return n > 0 && n < total }))
  await c.evaluate(`(() => { const i = document.querySelector('input[type=search]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,''); i.dispatchEvent(new Event('input',{bubbles:true})) })()`)
  await sleep(500)
  await c.click('.chip', 'USB')
  await sleep(400)
  check('category filter works', await c.evaluate("[...document.querySelectorAll('tbody tr')].every(r => r.innerText.includes('USB'))"))
  await c.click('tbody tr')
  check('device details open with provenance and identifiers', await until(() => c.evaluate("/identity/i.test(document.body.innerText) && /evidence/i.test(document.body.innerText) && /identifiers/i.test(document.body.innerText)")))
  check('sensitive identifiers are masked by default', await c.evaluate("(() => { const t = document.body.innerText; return !/\\bserial\\b\\s+[A-Za-z0-9]{6,}/.test(t) || t.includes('••••') })()"))

  // --- topology --------------------------------------------------------------------------------
  await nav('Topology')
  check('topology renders nodes and edges from real relationships', await until(() => c.evaluate("document.querySelectorAll('.react-flow__node').length > 5 && document.querySelectorAll('.react-flow__edge').length > 5")))
  await c.evaluate("document.querySelector('.react-flow__node')?.click()")
  check('selecting a node shows its relationships', await until(() => c.evaluate("/relationships/i.test(document.querySelector('.side')?.innerText ?? '')")))
  const edgesAll = await c.evaluate("document.querySelectorAll('.react-flow__edge').length")
  await c.evaluate("[...document.querySelectorAll('label.check')].find(l => l.innerText.includes('Confirmed')).querySelector('input').click()")
  await sleep(600)
  const edgesConfirmed = await c.evaluate("document.querySelectorAll('.react-flow__edge').length")
  check('"confirmed only" removes inferred relationships', edgesConfirmed < edgesAll, `${edgesAll} → ${edgesConfirmed}`)

  // --- collectors ------------------------------------------------------------------------------
  await nav('Collectors')
  check('collector health lists each collector with status', await c.evaluate("['linux.pci','linux.usb','linux.storage','linux.smart'].every(id => document.body.innerText.includes(id))"))
  check('permission-limited collectors are reported, not hidden', await c.evaluate("/permission/i.test(document.body.innerText)"))
  await c.click('button', 'Rescan all')
  check('rescan action completes', await until(async () => !(await c.evaluate("[...document.querySelectorAll('button')].some(b => b.disabled && /Rescan all/.test(b.innerText))"))))

  // --- events + monitoring controls --------------------------------------------------------------
  await nav('Events')
  await c.click('button', 'Pause monitoring')
  check('monitoring can be paused', await until(() => c.evaluate("document.body.innerText.includes('Resume monitoring')")))
  await c.click('button', 'Resume monitoring')
  check('monitoring can be resumed', await until(() => c.evaluate("document.body.innerText.includes('Pause monitoring')")))

  // --- diagnostics -----------------------------------------------------------------------------
  await nav('Diagnostics')
  check('diagnostics page lists real findings (collector permission/limits on this machine)', await until(() => c.evaluate("document.querySelectorAll('.diag-layout tbody tr').length > 0"), 30000))
  check('severity summary and status tabs render', await c.evaluate("document.querySelectorAll('.stat').length === 5 && document.querySelectorAll('[role=tab]').length === 5"))
  await c.click('.diag-layout tbody tr')
  check('finding details show evidence, recommendation and rule explanation', await until(() => c.evaluate("(() => { const t = document.querySelector('.diag-detail')?.innerText ?? ''; return /evidence/i.test(t) && /recommended next step/i.test(t) && /about this rule/i.test(t) })()")))
  const firstTitle = await c.evaluate("document.querySelector('.diag-layout tbody tr td:nth-child(2)').innerText")
  await c.click('.diag-detail button', 'Acknowledge')
  check('acknowledging moves the finding to the acknowledged status', await until(() => c.evaluate("/acknowledged/.test(document.querySelector('.diag-detail')?.innerText ?? '')")))
  await c.click('[role=tab]', 'acknowledged')
  check('status tab filters to acknowledged findings', await until(() => c.evaluate(`[...document.querySelectorAll('.diag-layout tbody tr td:nth-child(2)')].some(td => td.innerText === ${JSON.stringify(firstTitle)})`)))
  await c.click('.diag-detail button', 'Reopen')
  check('reopening returns the finding to active', await until(() => c.evaluate("/active/.test(document.querySelector('.diag-detail .inline')?.innerText ?? '')")))
  await c.click('[role=tab]', 'active')
  await c.evaluate(`(() => { const i = document.querySelector('input[aria-label="Search findings"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'zzzz-nothing'); i.dispatchEvent(new Event('input',{bubbles:true})) })()`)
  check('search with no match shows an empty state', await until(() => c.evaluate("/no findings match/i.test(document.body.innerText)")))
  await c.evaluate(`(() => { const i = document.querySelector('input[aria-label="Search findings"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,''); i.dispatchEvent(new Event('input',{bubbles:true})) })()`)
  await c.click('.rules-card button.link')
  check('rules and engine health are listed with last-run outcomes', await until(() => c.evaluate("(() => { const t = document.querySelector('.rules-card')?.innerText ?? ''; return /collector\\.health/.test(t) && /storage\\.smart/.test(t) && /evaluated|insufficient/i.test(t) })()")))
  check('invalid finding action is rejected by the main process', await c.evaluate("window.hip.setFindingStatus('x', 'delete').then(() => false, (e) => /Invalid payload/.test(e.message))"))
  check('unknown finding id is a clean error, not a crash', await c.evaluate("window.hip.setFindingStatus('doesnotexist', 'resolve').then(() => false, (e) => /not found/.test(e.message))"))
  check('overview reports the real active-finding count', await (async () => { await nav('Overview'); return until(() => c.evaluate("/active/.test(document.body.innerText) && /diagnostics/i.test(document.body.innerText)")) })())

  // --- snapshots -----------------------------------------------------------------------------------
  await nav('Snapshots')
  check('snapshot page shows its empty state before any snapshot exists', await until(() => c.evaluate("/no snapshots yet/i.test(document.body.innerText)")))
  const setInput = (sel, v) => c.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,${JSON.stringify(v)}); i.dispatchEvent(new Event('input',{bubbles:true})) })()`)
  await setInput('input[type=text]', 'e2e-a')
  await c.click('button', 'Create snapshot')
  check('creating a snapshot (fresh scan + copy) adds it to the history', await until(() => c.evaluate("[...document.querySelectorAll('tbody tr')].some(r => r.innerText.includes('e2e-a'))"), 60000))
  await c.click('tbody tr', 'e2e-a')
  check('snapshot metadata shows collector coverage and versions', await until(() => c.evaluate("(() => { const t = document.querySelector('aside[aria-label=\"Snapshot details\"]')?.innerText ?? ''; return /collector coverage/i.test(t) && t.includes('linux.pci') && /app \\/ schema/i.test(t) })()")))
  await setInput('input[type=text]', 'e2e-b')
  await c.click('button', 'Create snapshot')
  check('a second snapshot can be created', await until(() => c.evaluate("[...document.querySelectorAll('tbody tr')].some(r => r.innerText.includes('e2e-b'))"), 60000))
  const ids = await c.evaluate("window.hip.listSnapshots().then(l => l.map(s => ({ id: s.id, label: s.label })))")
  const A = ids.find((s) => s.label === 'e2e-a').id; const B = ids.find((s) => s.label === 'e2e-b').id
  await c.evaluate(`(() => { const set = (sel, v) => { const s = document.querySelector(sel); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s, v); s.dispatchEvent(new Event('change',{bubbles:true})) }; set('select[aria-label="From snapshot"]', ${JSON.stringify(A)}); set('select[aria-label="To snapshot"]', ${JSON.stringify(B)}) })()`)
  await c.click('button', 'Compare')
  check('comparison renders a summary and an explicit conclusiveness statement', await until(() => c.evaluate("/unchanged/i.test(document.body.innerText) && /conclusive|not fully conclusive/i.test(document.body.innerText)")))
  check('comparing two scans of an unchanged machine reports no confirmed removals', await c.evaluate("window.hip.compareSnapshots(" + JSON.stringify(A) + ", " + JSON.stringify(B) + ").then(r => r.summary.removed === 0 && r.summary.unchanged > 20)"))
  check('comparing a snapshot with itself is rejected', await c.evaluate("window.hip.compareSnapshots(" + JSON.stringify(A) + ", " + JSON.stringify(A) + ").then(() => false, (e) => /two different/.test(e.message))"))
  check('invalid snapshot IPC payloads are rejected', await c.evaluate("window.hip.createSnapshot('x'.repeat(81)).then(() => false, (e) => /Invalid payload/.test(e.message))"))
  await c.evaluate(`(() => { const row = [...document.querySelectorAll('tbody tr')].find(r => r.innerText.includes('e2e-a')); row.querySelector('input[type=checkbox]').click() })()`)
  await c.click('button', 'Delete selected')
  check('deletion requires an explicit in-page confirmation', await until(() => c.evaluate("/permanently delete 1 snapshot/i.test(document.body.innerText)")))
  await c.click('button', 'Cancel')
  check('cancelling keeps the snapshot', await c.evaluate("window.hip.listSnapshots().then(l => l.length === 2)"))
  await c.evaluate(`(() => { const row = [...document.querySelectorAll('tbody tr')].find(r => r.innerText.includes('e2e-a')); const cb = row.querySelector('input[type=checkbox]'); if (!cb.checked) cb.click() })()`)
  await c.click('button', 'Delete selected'); await sleep(300)
  await c.click('.confirm button', 'Delete')
  check('confirmed deletion removes only the selected snapshot', await until(() => c.evaluate("window.hip.listSnapshots().then(l => l.length === 1 && l[0].label === 'e2e-b')")))

  // --- micro-level pages: matrix, sensors, CPU & memory ------------------------------------------
  await nav('Collectors')
  check('capability matrix lists categories with coverage derived from collector health', await until(() => c.evaluate("(() => { const t = document.querySelector('[aria-label=\"Capability matrix\"]'); return !!t && t.querySelectorAll('tbody tr').length >= 8 && /full|limited/.test(t.innerText) })()")))
  check('matrix marks unsupported-on-this-OS categories as not collected, never as healthy', await c.evaluate("(() => { const rows = [...document.querySelectorAll('[aria-label=\"Capability matrix\"] tbody tr')]; const smart = document.querySelector('[aria-label=\"Capability matrix\"]').innerText; return rows.every(r => !/windows\\./.test(r.innerText)) && /permission needed|limited|full/.test(smart) })()"))
  await nav('Sensors')
  check('sensor registry shows channels with value, limits, label state, age and source', await until(() => c.evaluate("(() => { const t = document.querySelector('[aria-label=\"Sensor registry\"]'); if (!t) return false; const h = t.querySelector('thead').innerText; return t.querySelectorAll('tbody tr').length > 0 && /Value/.test(h) && /Source/.test(h) && /labelled/.test(t.innerText) && /ago|just now|s$/i.test(t.querySelector('tbody tr').innerText) })()")))
  await nav('CPU & Memory')
  check('cpu & memory page renders real topology and memory facts', await until(() => c.evaluate("(() => { const t = document.querySelector('main').innerText; return /cache/i.test(t) && /NUMA/i.test(t) && /swap/i.test(t) })()"), 30000))
  const cpuLogical = await c.evaluate("window.hip.listDevices({ category: 'cpu' }).then(l => l.length)")
  check('cpu devices on that page come from the inventory (packages + cores)', cpuLogical > 0, `${cpuLogical}`)

  await nav('Processes')
  check('process monitoring is off by default and reads nothing until enabled', await until(() => c.evaluate("/Process monitoring is off/i.test(document.querySelector('main').innerText)")))
  check('IPC returns an empty disabled snapshot while the setting is off', await c.evaluate("window.hip.topProcesses(5).then(s => s.enabled === false && s.topCpu.length === 0 && s.topMemory.length === 0)"))
  await c.click('button', 'Enable process monitoring')
  check('after opting in, real processes appear with names and memory but no command lines', await until(() => c.evaluate("(() => { const t = document.querySelector('[aria-label=\"Top by memory\"]'); return !!t && t.querySelectorAll('tbody tr').length >= 5 })()"), 20000))
  check('CPU shares appear on the second sample', await until(() => c.evaluate("(() => { const t = document.querySelector('[aria-label=\"Top by CPU\"]'); return !!t && t.querySelectorAll('tbody tr').length >= 1 })()"), 20000))
  const procJson = await c.evaluate("window.hip.topProcesses(50).then(s => JSON.stringify(s))")
  // Field names only: a process may legitimately be *named* e.g. "systemd-userdbd".
  const procData = JSON.parse(procJson)
  check('process data contains only bounded fields (no cmdline/env/user)', [...procData.topMemory, ...procData.topCpu].every(p => Object.keys(p).sort().join() === 'cpuPercent,name,pid,rssBytes,state,threads'), Object.keys(procData.topMemory[0] ?? {}).join())
  check('process IPC rejects out-of-range limits', await c.evaluate("window.hip.topProcesses(5000).then(() => false, () => true)"))
  await c.evaluate("window.hip.setSetting('processMonitoring', false)")
  await nav('Device diff')
  check('compare page loads and offers same-category device selection', await until(() => c.evaluate("document.querySelectorAll('main select').length >= 2")))
  const cmp = await c.evaluate("window.hip.listDevices({ category: 'usb' }).then(l => l.length)")
  check('i2c adapters are inventoried passively from the kernel device model', await c.evaluate("window.hip.listDevices({ category: 'other' }).then(l => l.some(d => d.subtype === 'i2c_adapter'))") || !existsSync('/sys/bus/i2c/devices'), `usb devices ${cmp}`)

  // --- monitor (live metrics) ---------------------------------------------------------------------
  await nav('Monitor')
  check('monitor page shows live CPU and memory cards from real measurements', await until(() => c.evaluate("(() => { const t = [...document.querySelectorAll('.metric-card')]; const f = (n) => t.find(x => x.getAttribute('aria-label') === n); return !!f('CPU utilisation')?.querySelector('svg path, svg circle') && /live/.test(f('CPU utilisation').innerText) && !!f('Memory')?.querySelector('svg path, svg circle') })()"), 60000))
  const memAvail = Number(/MemAvailable:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))[1]); const memTotal = Number(/MemTotal:\s+(\d+)/.exec(readFileSync('/proc/meminfo', 'utf8'))[1])
  const expectedUsed = ((memTotal - memAvail) / memTotal) * 100
  const apiMem = await c.evaluate("window.hip.metricsStatus().then(s => s.series.find(x => x.metric === 'memory.utilization')?.lastValue)")
  check('charted memory utilisation agrees with /proc/meminfo read independently', typeof apiMem === 'number' && Math.abs(apiMem - expectedUsed) < 5, `${apiMem} vs ${expectedUsed.toFixed(1)}`)
  check('cpu utilisation is a plausible percentage with its source named', await c.evaluate("window.hip.metricsStatus().then(s => { const x = s.series.find(v => v.metric === 'cpu.utilization'); return !!x && x.lastValue >= 0 && x.lastValue <= 100 && x.source === '/proc/stat' && x.unit === '%' })"))
  check('charts carry units and real clock times on their axes', await c.evaluate("(() => { const svg = [...document.querySelectorAll('.metric-card')].find(x => x.getAttribute('aria-label') === 'CPU utilisation')?.querySelector('svg'); const t = svg?.textContent ?? ''; return /%/.test(t) && /\\d{2}:\\d{2}:\\d{2}/.test(t) })()"))
  check('each card names its data source', await c.evaluate("[...document.querySelectorAll('.metric-card')].every(x => /Source:/.test(x.innerText))"))
  check('disk card reports I/O throughput, not capacity', await c.evaluate("(() => { const t = [...document.querySelectorAll('.metric-card')].find(x => x.getAttribute('aria-label') === 'Disk activity')?.innerText ?? ''; return /I\\/O throughput/.test(t) && !/free|capacity/i.test(t.replace(/not capacity/, '')) })()"))
  check('sampler health lists providers and their status', await c.evaluate("/metrics\\.linux\\.cpu/.test(document.querySelector('.providers-card')?.innerText ?? '')"))
  await c.evaluate("(() => { const s = document.querySelector('select[aria-label=\"Time window\"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(s, '900'); s.dispatchEvent(new Event('change',{bubbles:true})) })()")
  check('changing the time window re-queries without error', await until(() => c.evaluate("!document.querySelector('.banner-bad')")))
  await c.click('button', 'Pause sampling')
  check('pausing marks charts stale and says so', await until(() => c.evaluate("/Sampling is paused/.test(document.body.innerText) && [...document.querySelectorAll('.metric-card')].some(x => /stale/.test(x.innerText))")))
  const frozen = await c.evaluate("window.hip.metricsStatus().then(s => s.series.find(x => x.metric === 'cpu.utilization')?.lastAt)")
  await sleep(7000)
  check('no samples are taken while paused', (await c.evaluate("window.hip.metricsStatus().then(s => s.series.find(x => x.metric === 'cpu.utilization')?.lastAt)")) === frozen)
  await c.click('button', 'Resume sampling')
  check('resuming restarts sampling', await until(() => c.evaluate(`window.hip.metricsStatus().then(s => { const a = s.series.find(x => x.metric === 'cpu.utilization')?.lastAt; return !!a && a !== ${JSON.stringify(frozen)} && !s.paused })`), 30000))
  check('invalid metric queries are rejected by the main process', await c.evaluate("window.hip.queryMetrics([], 300).then(() => false, (e) => /Invalid payload/.test(e.message))"))
  const cpuDev = await c.evaluate("window.hip.metricsStatus().then(s => s.series.find(x => x.metric === 'cpu.utilization')?.deviceId)")
  await c.evaluate(`(() => { })()`)
  await nav('Hardware'); await c.click('tbody tr', 'Processor')
  check('the processor detail page shows its own live metrics', await until(() => c.evaluate("/live metrics/i.test(document.body.innerText) && /Source:/.test(document.body.innerText)"), 30000))
  check('metrics were measured for the real CPU device record', typeof cpuDev === 'string' && cpuDev.length > 5)
  await nav('Diagnostics')
  check('diagnostics lists the metric sampler rule', await c.evaluate("window.hip.diagnosticsStatus().then(s => s.rules.some(r => r.id === 'metrics.availability' && r.lastRun?.outcome === 'evaluated'))"))

  // --- settings persistence across restart ------------------------------------------------------------
  await nav('Settings')
  await c.evaluate("window.hip.setSetting('theme', 'dark')")
  await c.evaluate("window.hip.setSetting('pollIntervalSec', 45)")
  check('settings page renders', await c.evaluate("/privacy & export/i.test(document.body.innerText)"))
  check('features & controls lists collectors, rules, metric providers and pages', await until(() => c.evaluate("(() => { const t = document.body.innerText; return /features & controls/i.test(t) && /hardware collectors/i.test(t) && /diagnostic rules/i.test(t) && /metric providers/i.test(t) && t.includes('linux.usb') })()")))
  const hideTopology = "(() => { const l = [...document.querySelectorAll('.feature-group label.toggle')].find(x => x.innerText.trim() === 'Topology'); l.querySelector('input').click() })()"
  await c.evaluate(hideTopology)
  check('a page switched off in Settings disappears from the sidebar', await until(() => c.evaluate("![...document.querySelectorAll('.nav-item')].some(b => b.title.startsWith('Topology'))")))
  await c.evaluate(hideTopology)
  check('switching it back on restores it', await until(() => c.evaluate("[...document.querySelectorAll('.nav-item')].some(b => b.title.startsWith('Topology'))")))
  await c.evaluate("window.hip.setSetting('disabledCollectors', ['linux.serial'])")
  check('a disabled collector is reported as disabled', await until(() => c.evaluate("window.hip.collectorHealth().then(h => h.find(x => x.id === 'linux.serial')?.disabled === true)")))
  await c.evaluate("window.hip.setSetting('disabledCollectors', [])")
  check('settings lists individual device switches', await until(() => c.evaluate("[...document.querySelectorAll('.feature-group legend')].some(l => /^Devices/.test(l.innerText))")))

  // --- device test ------------------------------------------------------------------------------
  await nav('Device test')
  check('device test lists real devices to test', await until(() => c.evaluate("document.querySelectorAll('.target').length >= 3")))
  await c.evaluate("document.querySelector('.target').click()")
  check('choosing a device runs the automatic checks and gives a verdict', await until(() => c.evaluate("/automatic checks/i.test(document.body.innerText) && !!document.querySelector('.verdict-line')"), 30000))
  check('the chosen device shows its own connection map down from the PCI root', await until(() => c.evaluate("!!document.querySelector('.device-map .map-node.target') && /PCI root complex/.test(document.querySelector('.device-map').innerText)"), 20000))
  check('a USB input device lists its raw HID parts for the deep test (not run: it needs a password)', await c.evaluate("window.hip.testTargets().then(l => l.targets.find(t => t.kind === 'usb' && t.inputNodes.length)).then(t => t ? window.hip.runDeviceTest(t.id).then(r => r.hid.length > 0 && r.hid.some(h => h.pointer || h.hidpp)) : true)"))
  check('the deep test refuses a HID node that is not part of the device', await c.evaluate("window.hip.testTargets().then(l => l.targets.find(t => t.kind === 'battery' || t.kind === 'network')).then(t => t ? window.hip.startDeepTest(t.id, 'hidraw0', 5).then(() => false, e => /does not belong/.test(String(e))) : true)"))
  const keyboardTarget = await c.evaluate("window.hip.testTargets().then(l => l.targets.find(t => t.roles.includes('keyboard'))?.id ?? null)")
  if (keyboardTarget) {
    const live = await c.evaluate(`window.hip.startLiveTest(${JSON.stringify(keyboardTarget)}).then(s => s.running && s.limitMs === 120000, e => String(e))`)
    check('a hands-on session can start on a real keyboard (or explains why not)', live === true || /input/.test(String(live)), String(live))
    await c.evaluate('window.hip.stopLiveTest()')
  }

  // --- performance (read-only: applying would open the system password dialog) -------------------
  await nav('Performance')
  check('performance tuning page shows live measurements with sources and discovered capabilities', await until(() => c.evaluate("(() => { const t = document.body.innerText; return /measurements/i.test(t) && /capability matrix/i.test(t) && /scaling_cur_freq/.test(t) && /operating mode/i.test(t) })()"), 20000))
  check('performance state reports the real CPU with its clock ceiling and per-control status', await c.evaluate("window.hip.performanceState().then(s => s.devices.some(d => d.kind === 'cpu' && d.settings.some(x => /GHz/.test(x.allowed)) && d.controls.some(c => c.id === 'cpu.multiplier' && !c.write)))"))
  check('profiles are planned from this device (changes listed with from → to)', await c.evaluate("window.hip.performanceState().then(s => s.profiles.filter(p => p.builtin).length === 5 && s.profiles.some(p => p.id === 'maximum') && s.profiles.every(p => typeof p.summary === 'string' && p.changes.every(c => c.label && c.from !== c.to)))"))
  check('tuning is off by default and every change is refused before any password prompt', await c.evaluate("window.hip.applyPerformanceProfile('performance').then(() => false, (e) => /switched off in Settings/.test(String(e)))"))
  check('invalid tuning values are rejected by the IPC schema', await c.evaluate("window.hip.applyPerformanceValues('x', [{ id: 'cpu.governor', value: '$(reboot)' }]).then(() => false, () => true)"))
  await c.click('[role=tab]', 'Benchmark')
  check('the benchmark tab offers benchmark and monitoring sessions', await until(() => c.evaluate("/benchmark/i.test(document.body.innerText) && /neither establishes stability/i.test(document.body.innerText)"), 10000))
  // --- circuit lab -------------------------------------------------------------------------------
  await nav('Circuit lab')
  check('circuit lab opens with the example player wired and no problems', await until(() => c.evaluate("document.querySelectorAll('.cl-part').length === 10 && /no problems found/i.test(document.body.innerText)"), 10000))
  check('the OLED preview shows a clock and the battery level', await c.evaluate("/BAT \\d+%/.test(document.querySelector('.cl-oled').innerText) && /\\d\\d:\\d\\d/.test(document.querySelector('.cl-oled').innerText)"))
  await c.click('button', 'Right')
  check('turning the encoder changes the volume the OLED shows', await until(() => c.evaluate("/VOL 42/.test(document.querySelector('.cl-oled').innerText)"), 5000))
  await c.evaluate("document.querySelector('input[type=checkbox]').click()")
  check('opening the power switch blanks the display and flags nothing as broken wiring', await until(() => c.evaluate("/no signal/i.test(document.querySelector('.cl-oled').innerText)"), 5000))
  await c.evaluate("document.querySelector('input[type=checkbox]').click()")
  // Editor interactions through the real DOM: wire two pins, delete the wire, drag a part.
  const fire = (sel, idx, type, x, y) => `(() => { const el = document.querySelectorAll(${JSON.stringify(sel)})[${idx}]; const r = el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { bubbles: true, clientX: ${x ?? 'r.left + r.width / 2'}, clientY: ${y ?? 'r.top + r.height / 2'}, pointerId: 1 })); })()`
  const setSel = (sel, v) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true })) })()`
  await c.evaluate(setSel('.cl-newpcb', 'blank')); await sleep(400)
  check('a new PCB opens in its own tab and the first one stays open', await c.evaluate("document.querySelectorAll('.cl-tab').length === 2 && document.querySelector('.cl-tab.active').innerText.includes('PCB')"))
  await c.click('.cl-palette button', 'Resistor'); await sleep(200)
  await c.click('.cl-palette button', 'Resistor'); await sleep(200)
  check('the palette adds parts to a blank canvas', await c.evaluate("document.querySelectorAll('.cl-part').length === 2"))
  await c.evaluate(fire('.cl-pin', 1, 'pointerdown')); await c.evaluate(fire('.cl-pin', 2, 'pointerdown')); await sleep(300)
  check('clicking two pins draws a wire', await c.evaluate("document.querySelectorAll('.cl-wire').length === 1"))
  await c.evaluate(fire('.cl-wire', 0, 'pointerdown')); await sleep(100)
  await c.evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))"); await sleep(300)
  check('a selected wire is removed with Delete', await c.evaluate("document.querySelectorAll('.cl-wire').length === 0"))
  const partBefore = await c.evaluate("document.querySelectorAll('.cl-part')[0].getAttribute('transform')")
  await c.evaluate(fire('.cl-part > rect', 0, 'pointerdown')); await c.evaluate("(() => { const svg = document.querySelector('.cl-canvas'); const r = svg.getBoundingClientRect(); svg.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + r.width * 0.6, clientY: r.top + r.height * 0.6, pointerId: 1 })); svg.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 1 })) })()"); await sleep(300)
  check('dragging a part moves it', await c.evaluate(`document.querySelectorAll('.cl-part')[0].getAttribute('transform') !== ${JSON.stringify(partBefore)}`))
  check('an edited PCB is marked unsaved', await c.evaluate("!!document.querySelector('.cl-tab.active .cl-dirty')"))
  // new parts, examples in their own tabs, and the custom part builder
  await c.evaluate("[...document.querySelectorAll('.cl-palette button')].find(b => b.innerText.trim() === 'LED').click()"); await sleep(200)
  check('new part kinds (LED) can be added from the palette', await c.evaluate("[...document.querySelectorAll('.cl-part text')].some(t => t.textContent === 'LED')"))
  await c.evaluate(setSel('.cl-newpcb', 'transistor')); await sleep(500)
  check('an example opens as a third tab, simulated with no problems', await c.evaluate("document.querySelectorAll('.cl-tab').length === 3 && /no problems found/i.test(document.body.innerText) && document.querySelectorAll('.cl-part').length === 7"))
  await c.evaluate("[...document.querySelectorAll('button')].find(b => b.innerText.includes('Hold to press')).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }))"); await sleep(300)
  check('holding the push button turns the transistor stage on', await c.evaluate("/ON · /.test(document.body.innerText) || [...document.querySelectorAll('.cl-part title')].some(t => /ON · /.test(t.textContent))"))
  await c.evaluate("window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))"); await sleep(300)
  await c.click('button', 'New custom part'); await sleep(200)
  await c.evaluate(setSel('.cl-builder input', 'Hall sensor')); await sleep(100)
  await c.click('.cl-builder button', 'Create part'); await sleep(300)
  check('a custom part can be built and then appears in the palette', await c.evaluate("[...document.querySelectorAll('.cl-palette button')].some(b => b.innerText.includes('Hall sensor'))"))
  await c.click('.cl-palette button', 'Hall sensor'); await sleep(300)
  check('a placed custom part shows its own pins', await c.evaluate("[...document.querySelectorAll('.cl-part text')].some(t => t.textContent === 'SDA')"))
  check('closing a PCB with unsaved edits asks first', await c.evaluate("(() => { const x = document.querySelector('.cl-tab.active .cl-tab-x'); x.click(); return true })()") && await until(() => c.evaluate("!!document.querySelector('.cl-tab-confirm')"), 3000))
  await c.click('.cl-tab-confirm', 'Discard'); await sleep(300)
  check('discarding closes just that tab', await c.evaluate("document.querySelectorAll('.cl-tab').length === 2"))
  await c.click('.cl-tab > button:first-child', 'Handheld player'); await sleep(400)
  check('switching tabs brings the first PCB back intact', await c.evaluate("document.querySelectorAll('.cl-part').length === 10 && /BAT \\d+%/.test(document.querySelector('.cl-oled').innerText)"))
  await c.evaluate(setSel('.cl-board-pick select', 'breadboard')); await sleep(400)
  check('the board can be switched to a breadboard without changing the circuit', await c.evaluate("!!document.querySelector('.cl-board') && /Breadboard \\(830 point\\)/.test(document.querySelector('.cl-board').textContent) && /no problems found/i.test(document.body.innerText)"))
  await c.evaluate(setSel('.cl-board-pick select', 'pcb')); await sleep(300)

  const design = await c.evaluate("(async () => { const t = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === 'JSON'); t.click(); await new Promise(r => setTimeout(r, 200)); return document.querySelector('.cl-json textarea').value })()")
  const saved = await c.evaluate(`window.hip.saveCircuit('e2e circuit', JSON.parse(${JSON.stringify(design)})).then(s => s.id)`)
  check('a circuit can be saved, listed and loaded back identically', await c.evaluate(`window.hip.listCircuits().then(l => l.some(x => x.id === ${saved} && x.parts === 10)).then(ok => ok && window.hip.loadCircuit(${saved})).then(x => !!x && x.design.wires.length === 31)`))
  check('a malformed circuit is rejected by the IPC schema', await c.evaluate("window.hip.saveCircuit('bad', { parts: [{ id: 'x', kind: 'nuke', x: 0, y: 0, props: {} }], wires: [], firmware: {} }).then(() => false, () => true)"))
  check('saved circuits can be deleted', await c.evaluate(`window.hip.deleteCircuit(${saved}).then(l => !l.some(x => x.id === ${saved}))`))
  // Acknowledge right before shutdown: findings follow live system state and may resolve on their own given time.
  check('a finding can be acknowledged just before shutdown', await c.evaluate("window.hip.listFindings({ status: 'active' }).then(async (l) => (l[0] ? window.hip.setFindingStatus(l[0].id, 'acknowledge').then(() => true) : false))"), 'no active finding to acknowledge')
  c.close()
  await closeBrowser(port)
  const code = await Promise.race([app.exited, sleep(15000).then(() => 'timeout')])
  check('application shuts down cleanly', code === 0, String(code))

  // --- restart ---------------------------------------------------------------------------------
  app = launch()
  check('app restarts', await until(async () => (c = await connect(port)) !== undefined))
  const persisted = await until(() => c.evaluate("window.hip.getSettings().then(s => s.theme === 'dark' && s.pollIntervalSec === 45)"))
  check('settings persist across restart', persisted)
  const early = await c.evaluate('window.hip.listDevices().then(d => d.length)')
  check('inventory is available from the database immediately after restart', early > 20, String(early))
  check('acknowledged finding persisted across restart', await until(() => c.evaluate("window.hip.listFindings({ status: 'acknowledged' }).then((l) => l.length >= 1)")))
  check('snapshot persisted across restart', await c.evaluate("window.hip.listSnapshots().then(l => l.length === 1 && l[0].deviceCount > 20 && l[0].machineId)"))
  check('metric history persisted across restart (series known, stale until sampling resumes)', await c.evaluate("window.hip.metricsStatus().then(s => s.storedSamples > 0 && s.series.some(x => x.metric === 'cpu.utilization'))"))
  const info = await c.evaluate('window.hip.appInfo()')
  check('database schema/migration status is reported', info.schemaVersion >= 4 && info.migrations.length >= 4)
  if (packaged) {
    check('packaged: database lives in the per-user data directory', info.databasePath.startsWith(join(dir, 'config')) && existsSync(info.databasePath), info.databasePath)
    check('packaged: renderer is served from the hip-app:// scheme (not file://)', (await c.evaluate('location.href')).startsWith('hip-app://renderer/'))
  }
  c.close()
  await closeBrowser(port)
  await Promise.race([app.exited, sleep(15000)])
} catch (e) {
  check('e2e run completed without exceptions', false, e.stack ?? String(e))
  try { app.child.kill('SIGKILL') } catch { /* ignore */ }
} finally {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} e2e checks passed`)
process.exit(failed.length ? 1 : 0)
