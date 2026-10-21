/**
 * Install/upgrade/limited-environment checks against a PACKAGED build (AppImage or unpacked binary).
 *   HIP_E2E_PACKAGED=<binary> node tests/e2e/packaged.mjs
 * Complements `HIP_E2E_PACKAGED=… node tests/e2e/run.mjs` (the full UI suite). Every scenario uses a
 * private XDG_CONFIG_HOME, so the real user's data is never touched. Requires a display and tsx
 * (to seed an "old release" database). Linux only: see docs/PACKAGING.md for Windows.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readlinkSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { closeBrowser, connect } from './cdp.mjs'

const root = new URL('../..', import.meta.url).pathname
const bin = process.env['HIP_E2E_PACKAGED']
if (!bin || !existsSync(bin)) { console.error('Set HIP_E2E_PACKAGED to the packaged binary'); process.exit(2) }
// Defaults are strict (a real machine). CI runners are virtual machines/containers with sparse sysfs and
// often no udev, so the workflow relaxes exactly these two expectations: HIP_E2E_MIN_DEVICES, HIP_E2E_UDEV=optional.
const MIN_DEVICES = Number(process.env['HIP_E2E_MIN_DEVICES'] ?? 20)
const UDEV_OPTIONAL = process.env['HIP_E2E_UDEV'] === 'optional'
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  → ${detail}`}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 40000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true } catch { /* retry */ } await sleep(250) } return false }
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

function launch(home, extraEnv = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const env = { ...process.env, XDG_CONFIG_HOME: join(home, 'config'), APPIMAGE_EXTRACT_AND_RUN: '1', HIP_ENABLE_DEBUGGING: '1', ...extraEnv }
  delete env.HIP_DB_PATH
  const child = spawn(bin, [`--remote-debugging-port=${port}`], { cwd: home, env, stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  const exited = new Promise((res) => child.on('exit', (code, sig) => res(code ?? sig)))
  return { child, exited, port, stderr: () => stderr }
}
async function stop(app, c) {
  try { c?.close() } catch { /* ignore */ }
  await closeBrowser(app.port).catch(() => {})
  return Promise.race([app.exited, sleep(15000).then(() => 'timeout')])
}

/** TCP ports in LISTEN state that are owned by `rootPid` or any of its descendants (Linux /proc). */
function listeningPortsOfTree(rootPid) {
  const parent = new Map()
  for (const d of readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try { parent.set(Number(d), Number(readFileSync(`/proc/${d}/stat`, 'utf8').replace(/^.*\) \S+ /, '').split(' ')[0])) } catch { /* process vanished */ }
  }
  const tree = new Set([rootPid])
  for (let grew = true; grew;) { grew = false; for (const [pid, ppid] of parent) if (tree.has(ppid) && !tree.has(pid)) { tree.add(pid); grew = true } }
  const inodes = new Map() // socket inode -> port
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try { for (const line of readFileSync(f, 'utf8').split('\n').slice(1)) { const c = line.trim().split(/\s+/); if (c[3] === '0A') inodes.set(c[9], parseInt(c[1].split(':')[1], 16)) } } catch { /* ipv6 off */ }
  }
  const ports = new Set()
  for (const pid of tree) {
    try { for (const fd of readdirSync(`/proc/${pid}/fd`)) { const m = /^socket:\[(\d+)\]$/.exec(readlinkSync(`/proc/${pid}/fd/${fd}`)); if (m && inodes.has(m[1])) ports.add(inodes.get(m[1])) } } catch { /* gone / not ours */ }
  }
  return [...ports]
}
const seed = (dbPath, schema) => spawnSync('npx', ['tsx', join(root, 'scripts/seed-db.ts'), dbPath, '--schema', String(schema)], { cwd: root, encoding: 'utf8' })
const homes = []
const newHome = () => { const h = mkdtempSync(join(tmpdir(), 'hip-pkg-')); homes.push(h); return h }

try {
  // 1. First installation / first launch: database is created in the per-user directory ------------
  const h1 = newHome()
  let app = launch(h1)
  let c
  check('first launch: app starts', await until(async () => (c = await connect(app.port)) !== undefined))
  const info1 = await c.evaluate('window.hip.appInfo()')
  const dbPath = info1.databasePath
  check('first launch: database created under XDG config (not the install location)', dbPath.startsWith(join(h1, 'config')) && existsSync(dbPath), dbPath)
  check('first launch: all migrations applied', info1.schemaVersion >= 4 && info1.migrations.length === info1.schemaVersion)
  check('first launch: no backup file (nothing to back up)', !readdirSync(join(dbPath, '..')).some((f) => f.endsWith('.bak')))
  check('first launch: runs unprivileged', process.getuid() !== 0)
  check('first launch: real OS scan produced devices', await until(() => c.evaluate('window.hip.listDevices().then(d => d.length >= ' + MIN_DEVICES + ')')))
  const sys = await c.evaluate('window.hip.listDevices().then(d => d.map(x => x.category))')
  check('first launch: real categories present (cpu, storage, usb or network)', ['cpu', 'storage', 'usb', 'network'].some((k) => sys.includes(k)), [...new Set(sys)].join())
  // udev + periodic rescans in the packaged app
  const mon = await c.evaluate('window.hip.monitorStatus()')
  check('packaged: udev native notifications active (not degraded)', (mon.mode === 'udev' && !mon.degraded) || (UDEV_OPTIONAL && mon.mode === 'polling' && /udev|poll/i.test(mon.message ?? '')), JSON.stringify(mon))
  const scanAt = mon.lastScanAt
  await c.evaluate("window.hip.setSetting('pollIntervalSec', 10)")
  check('packaged: periodic rescan fires without user action', await until(async () => (await c.evaluate('window.hip.monitorStatus()')).lastScanAt !== scanAt, 40000))
  const code1 = await stop(app, c)
  check('first launch: graceful shutdown (exit code 0)', code1 === 0, String(code1))
  const wal = dbPath + '-wal'
  check('shutdown: WAL checkpointed into the main database file', !existsSync(wal) || statSync(wal).size === 0)
  const dbInspect = new DatabaseSync(dbPath, { readOnly: true })
  check('shutdown: inventory persisted in SQLite', dbInspect.prepare('SELECT COUNT(*) n FROM devices').get().n >= MIN_DEVICES)
  dbInspect.close()
  // restart reuses the same data
  app = launch(h1)
  check('restart: previous inventory available immediately', await until(async () => (c = await connect(app.port)) !== undefined) && await c.evaluate('window.hip.listDevices().then(d => d.length >= ' + MIN_DEVICES + ')'))
  check('restart: settings persisted', (await c.evaluate('window.hip.getSettings()')).pollIntervalSec === 10)
  await stop(app, c)

  // 2. Upgrade with existing user data ------------------------------------------------------------------
  const h2 = newHome()
  const up = join(h1, 'config', dbPath.split('/config/')[1])
  const db2 = join(h2, 'config', dbPath.split('/config/')[1])
  const s = seed(db2, 3)
  check('upgrade: seeded a schema-v3 database as an older release would leave it', s.status === 0, s.stderr)
  void up
  app = launch(h2)
  check('upgrade: new version starts on the old database', await until(async () => (c = await connect(app.port)) !== undefined))
  const info2 = await c.evaluate('window.hip.appInfo()')
  check('upgrade: migrated to the current schema', info2.schemaVersion >= 4 && info2.databasePath === db2, JSON.stringify(info2.migrations.map((m) => m.version)))
  const st = await c.evaluate('window.hip.getSettings()')
  check('upgrade: user settings kept', st.theme === 'light' && st.pollIntervalSec === 77, JSON.stringify(st))
  check('upgrade: user events kept', await c.evaluate("window.hip.recentEvents(500).then(e => e.some(x => x.summary === 'SEEDED-BY-OLD-RELEASE'))"))
  const bak = db2 + '.pre-v4.bak'
  check('upgrade: pre-migration backup written', existsSync(bak))
  if (existsSync(bak)) { const b = new DatabaseSync(bak, { readOnly: true }); check('upgrade: backup holds the old (v3) data', b.prepare('SELECT MAX(version) v FROM schema_migrations').get().v === 3 && b.prepare("SELECT COUNT(*) n FROM device_events WHERE summary = 'SEEDED-BY-OLD-RELEASE'").get().n === 1); b.close() }
  await stop(app, c)

  // 3. Database from a NEWER release is refused and left untouched --------------------------------------
  const h3 = newHome()
  const db3 = join(h3, 'config', dbPath.split('/config/')[1])
  seed(db3, 99)
  const before = sha(db3)
  app = launch(h3)
  const code3 = await Promise.race([app.exited, sleep(30000).then(() => 'timeout')])
  check('downgrade: app refuses to open a newer database (exit 1)', code3 === 1, String(code3))
  check('downgrade: error says no data was changed and names the cause', /newer than this application/.test(app.stderr()), app.stderr().slice(0, 300))
  check('downgrade: newer database file is byte-identical afterwards', sha(db3) === before)
  if (code3 === 'timeout') app.child.kill('SIGKILL')

  // 4. Missing optional tools / restricted environment -------------------------------------------------
  const h4 = newHome()
  // A PATH holding only generic coreutils (the AppImage launcher stub needs a few): no udevadm,
  // smartctl, lsusb, bluetoothctl, ip, nmcli, ... so every optional tool is "not installed".
  const minBin = join(h4, 'minbin')
  mkdirSync(minBin)
  for (const t of ['sh', 'bash', 'env', 'mktemp', 'mkdir', 'rm', 'ls', 'dirname', 'basename', 'readlink', 'cat', 'chmod', 'uname', 'id', 'ln', 'cp', 'mv', 'sleep', 'realpath', 'head', 'tail', 'tr', 'cut', 'sed', 'grep', 'wc', 'touch', 'true', 'false', 'test', 'echo', 'printf', 'dd', 'find', 'xargs']) {
    for (const d of ['/usr/bin', '/bin']) if (existsSync(join(d, t))) { symlinkSync(join(d, t), join(minBin, t)); break }
  }
  check('limited env: optional tools are really absent from PATH', ['udevadm', 'smartctl', 'lsusb', 'bluetoothctl', 'ip', 'lspci'].every((t) => !existsSync(join(minBin, t))))
  app = launch(h4, { PATH: minBin })
  check('limited env (PATH has no tools): app starts', await until(async () => (c = await connect(app.port)) !== undefined))
  check('limited env: scan still completes with sysfs/procfs data', await until(() => c.evaluate('window.hip.listDevices().then(d => d.length > 5)')))
  const health = await c.evaluate('window.hip.collectorHealth()')
  const linux = health.filter((h) => h.platforms.includes('linux'))
  const smart = linux.find((h) => h.id === 'linux.smart')
  const bt = linux.find((h) => h.id === 'linux.bluetooth')
  check('limited env: SMART collector reports unavailable with an explanation (tool missing)', smart?.status === 'unavailable' && /smartctl|not installed|not found/i.test(`${smart.message} ${JSON.stringify(smart.limitations)}`), JSON.stringify(smart))
  check('limited env: no Linux collector is in a failed/crashed state', linux.every((h) => h.status !== 'error' && h.status !== 'failed'), linux.map((h) => `${h.id}:${h.status}`).join())
  console.log(`      info  bluetooth without bluetoothctl → ${bt?.status}: ${bt?.message ?? JSON.stringify(bt?.limitations)}`)
  const mon4 = await c.evaluate('window.hip.monitorStatus()')
  check('limited env: monitor falls back to polling with an explanation', mon4.mode === 'polling' && /udev|poll/i.test(mon4.message ?? ''), JSON.stringify(mon4))
  const code4 = await stop(app, c)
  check('limited env: clean exit', code4 === 0, String(code4))

  // 5. Debugging endpoints ----------------------------------------------------------------------------------
  // (a) Ordinary launch: no TCP listener may exist anywhere in the app's process tree.
  const h5 = newHome()
  const env5 = { ...process.env, XDG_CONFIG_HOME: join(h5, 'config'), APPIMAGE_EXTRACT_AND_RUN: '1' }
  delete env5.HIP_ENABLE_DEBUGGING; delete env5.HIP_DB_PATH
  const plain = spawn(bin, [], { cwd: h5, env: env5, stdio: 'ignore', detached: true }) // own process group: the AppImage wrapper does not forward signals
  const plainExit = new Promise((res) => plain.on('exit', (code, sig) => res(code ?? sig)))
  await sleep(12000)
  const alive = plain.exitCode === null
  const open = listeningPortsOfTree(plain.pid)
  check('debug: normal packaged launch stays running', alive)
  check('debug: normal packaged launch opens NO listening TCP port', open.length === 0, `listening: ${open.join()}`)
  try { process.kill(-plain.pid, 'SIGTERM') } catch { /* already gone */ }
  await Promise.race([plainExit, sleep(15000)])
  try { process.kill(-plain.pid, 'SIGKILL') } catch { /* gone */ }
  // (b) Attempt to enable remote debugging without the explicit opt-in.
  for (const sw of ['--remote-debugging-port=0', '--remote-debugging-pipe', '--inspect=0']) {
    const port = 20000 + Math.floor(Math.random() * 20000)
    const arg = sw.endsWith('=0') && sw.includes('port') ? `--remote-debugging-port=${port}` : sw
    const h = newHome()
    const e = { ...env5, XDG_CONFIG_HOME: join(h, 'config') }
    const t0 = Date.now()
    const ch = spawn(bin, [arg], { cwd: h, env: e, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''; ch.stderr.on('data', (d) => { err += d })
    const ex = new Promise((res) => ch.on('exit', (code, sig) => res(code ?? sig)))
    let reachedBriefly = false
    for (let i = 0; i < 300 && ch.exitCode === null; i++) { if (arg.includes('port=')) { try { const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(100) }); if (r.ok) reachedBriefly = true } catch { /* not listening */ } } await sleep(50) }
    const code = await Promise.race([ex, sleep(20000).then(() => 'timeout')])
    if (code === 'timeout') ch.kill('SIGKILL')
    check(`debug: packaged build refuses ${arg.replace(/\d{5}/, 'N')} (exit code 2)`, code === 2, `exit=${code} stderr=${err.slice(0, 200)}`)
    check(`debug: refusal message names the switch`, /not accepted by packaged builds/.test(err))
    if (arg.includes('port=')) {
      let after = false
      try { after = (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })).ok } catch { /* closed */ }
      check('debug: no debugging endpoint remains after the refusal', !after)
      console.log(`      info  endpoint answered before the app exited: ${reachedBriefly} (Chromium opens it before JS runs; exit after ${Date.now() - t0} ms)`)
    }
    check('debug: refusal leaves no database behind (nothing started)', !existsSync(join(h, 'config', 'Hardware Intelligence Platform', 'inventory.sqlite')))
  }
} catch (e) {
  check('packaged run completed without exceptions', false, e.stack ?? String(e))
} finally {
  for (const h of homes) { try { rmSync(h, { recursive: true, force: true }) } catch { /* ignore */ } }
}
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} packaged checks passed`)
process.exit(failed.length ? 1 : 0)
