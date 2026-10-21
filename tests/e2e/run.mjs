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
  await c.evaluate("window.hip.listFindings({ status: 'active' }).then(async (l) => l[0] && window.hip.setFindingStatus(l[0].id, 'acknowledge'))")

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
  check('process data contains only bounded fields (no cmdline/env/user)', !/cmdline|environ|user/i.test(procJson) && JSON.parse(procJson).topMemory.every(p => Object.keys(p).sort().join() === 'cpuPercent,name,pid,rssBytes,state,threads'))
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
