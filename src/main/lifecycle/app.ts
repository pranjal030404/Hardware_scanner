import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, session, shell, type WebContents } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { allCollectors } from '@collectors/index'
import { hostContext } from '@collectors/core/context'
import { EVENT_CHANNEL } from '@shared/api'
import { IPC_CHANNELS } from '@shared/ipc'
import type { Settings } from '@shared/schemas'
import { backupDatabase, listMigrations, MigrationError, openDatabase, schemaVersion } from '../database/db'
import { EventRepo, SettingsRepo } from '../database/repositories'
import { dispatch, type Handlers } from '../ipc/dispatch'
import { devToolsAllowed, DEV_CSP, isSafeExternalUrl, isTrustedUrl, PRODUCTION_CSP, WINDOW_WEB_PREFERENCES, type Origins } from '../security/policy'
import { APP_INDEX_URL, APP_ORIGIN, APP_SCHEME, resolveAppAsset } from '../security/app-protocol'
import { EventBus } from '../services/event-bus'
import { buildExport } from '../services/export'
import { InventoryService } from '../services/inventory'
import { MonitorService, udevWatcherFactory } from '../services/monitor'
import { buildOverview } from '../services/overview'
import { DiagnosticsService } from '../services/diagnostics'
import { SnapshotService } from '../services/snapshots'
import { MetricsService } from '../services/metrics'
import { providersForPlatform } from '../../metrics'
import * as os from 'node:os'
import { disabledSnapshot, ProcessMonitor } from '../../processes'
import { SysReader } from '@collectors/core/sysreader'
import { runCommand } from '@collectors/core/runner'
import { DeviceControl } from '../../device-control'
import { DeviceTester } from '../../device-test/engine'
import { PerformanceService } from '../../performance'
import { PerformanceRepo } from '../database/performance-repo'
import { CircuitRepo } from '../database/circuit-repo'
import { helperStatus } from '../../privileged/helpers'

// Must run before app 'ready'. The renderer is served from this scheme, not file://, so the packaged
// binary can keep the GrantFileProtocolExtraPrivileges fuse disabled.
protocol.registerSchemesAsPrivileged([{ scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }])

const isDev = !app.isPackaged && !!process.env['ELECTRON_RENDERER_URL']

function origins(): Origins {
  return { appUrlPrefix: isDev ? process.env['ELECTRON_RENDERER_URL']! : APP_ORIGIN }
}

export async function startApp(): Promise<void> {
  // HIP_DB_PATH is a test/development override; a packaged build always uses the per-user data directory.
  const dbPath = (!app.isPackaged && process.env['HIP_DB_PATH']) || join(app.getPath('userData'), 'inventory.sqlite')
  let db
  try {
    db = openDatabase(dbPath)
  } catch (e) {
    const msg = e instanceof MigrationError ? e.message : `Could not open the inventory database: ${(e as Error).message}`
    dialog.showErrorBox('Hardware Intelligence Platform', `${msg}\n\nDatabase: ${dbPath}\nNo data was deleted.`)
    app.exit(1)
    return
  }

  const settingsRepo = new SettingsRepo(db)
  const eventRepo = new EventRepo(db)
  const bus = new EventBus(eventRepo)
  const platform = process.platform
  const inventory = new InventoryService({ db, collectors: allCollectors, makeContext: () => hostContext(), bus, platform, disabled: () => settingsRepo.getAll().disabledCollectors })
  const settings = (): Settings => settingsRepo.getAll()
  const monitor = new MonitorService(inventory, bus, { intervalSec: settings().pollIntervalSec }, platform === 'linux' ? udevWatcherFactory : null)

  const metrics = new MetricsService({
    db, providers: providersForPlatform(platform), platform, getSettings: settings, bus,
    makeContext: (monoMs) => ({ reader: new SysReader('/'), os, monoMs })
  })

  // Performance tuning. Monitoring needs no privileges; writable controls need the optional, separately installed helper.
  const circuits = new CircuitRepo(db)
  const perfRepo = new PerformanceRepo(db)
  const startedAt = new Date().toISOString()
  perfRepo.closeInterrupted(startedAt)
  perfRepo.closeInterruptedTests(startedAt)
  let perfHelper = { usable: false, reason: null as string | null }
  const refreshPerfHelper = (): Promise<void> => helperStatus('hip-perf-helper', platform).then((h) => { perfHelper = { usable: h.usable, reason: h.reason } }, () => undefined)
  void refreshPerfHelper()
  const perf = new PerformanceService({
    reader: new SysReader('/'), run: runCommand, platform, store: perfRepo, threads: os.cpus().length,
    tuningEnabled: () => settings().perfTuningEnabled,
    limits: () => ({ maxTestSeconds: settings().perfTestMaxSec, minIntervalMs: settings().perfTestMinIntervalMs }),
    cpus: () => os.cpus().map((c) => ({ model: c.model, speed: c.speed })),
    exists: (p) => fs.access(p).then(() => true, () => false)
  })

  const diagnostics = new DiagnosticsService({
    db, inventory: inventory.repo, events: eventRepo, bus, getSettings: settings, getMonitor: () => monitor.status(),
    getCollectors: () => inventory.getHealth(Math.max(settings().pollIntervalSec * 5000, 300_000)),
    getMetrics: () => metrics.status(),
    getMetricWindow: (metric, windowMs) => {
      const series = metrics.status().series.filter((x) => x.metric === metric)
      return series.map((x) => {
        const d = metrics.query([{ metric, deviceId: x.deviceId }], windowMs, 600)[0]!
        return { deviceId: x.deviceId, deviceName: x.deviceName, metric, unit: d.unit, source: d.source, points: d.points, stale: d.stale }
      })
    },
    getPerformance: () => platform === 'linux'
      ? { tuningEnabled: settings().perfTuningEnabled, helperUsable: perfHelper.usable, helperReason: perfHelper.reason, lastTx: perfRepo.recentTx(1)[0] ?? null, failedRollbacks: perfRepo.failedRollbacks(), lastTest: perfRepo.tests(1)[0] ?? null }
      : null
  })

  const snapshots = new SnapshotService({ db, inventory, appVersion: app.getVersion(), freshMs: () => Math.max(settings().pollIntervalSec * 3000, 120_000) })

  const procMon = new ProcessMonitor(new SysReader('/'), () => performance.now())
  const devices = new DeviceControl({ reader: new SysReader('/'), run: runCommand, env: process.env, platform, disabledInputs: () => settings().disabledInputs })
  const tester = new DeviceTester({
    reader: new SysReader('/'), run: runCommand, platform,
    installScript: app.isPackaged ? join(process.resourcesPath, 'linux', 'install.sh') : join(app.getAppPath(), 'resources', 'linux', 'install.sh'),
    disabledInputNodes: async () => {
      const off = new Set(settings().disabledInputs)
      if (!off.size) return []
      return (await devices.inputGroups()).groups.filter((g) => off.has(g.id)).flatMap((g) => g.nodes)
    }
  })
  const handlers: Handlers = {
    'app:info': () => ({
      version: app.getVersion(), electron: process.versions.electron ?? '', node: process.versions.node, platform, arch: process.arch,
      schemaVersion: schemaVersion(db), migrations: listMigrations(db), databasePath: dbPath
    }),
    'overview:get': () => buildOverview(inventory.repo, diagnostics.repo.activeCount()),
    'inventory:list': (f) => inventory.repo.list(f),
    'inventory:get': ({ id }) => inventory.repo.get(id, eventRepo.forDevice(id)),
    'inventory:scan': ({ collectorIds }) => inventory.scan(collectorIds),
    'topology:get': () => ({ nodes: inventory.repo.list({}), edges: inventory.repo.edges() as never }),
    'diagnostics:status': () => diagnostics.status(),
    'diagnostics:list': (f) => diagnostics.list(f),
    'diagnostics:get': ({ id }) => diagnostics.detail(id),
    'diagnostics:setStatus': ({ id, action, reason }) => diagnostics.setStatus(id, action, reason),
    'diagnostics:evaluate': () => (diagnostics.evaluate(), diagnostics.status()),
    'diagnostics:setRuleEnabled': ({ ruleId, enabled }) => {
      if (!diagnostics.hasRule(ruleId)) throw new Error(`Unknown rule: ${ruleId}`)
      const off = new Set(settings().diagDisabledRules)
      if (enabled) off.delete(ruleId)
      else off.add(ruleId)
      settingsRepo.set('diagDisabledRules', [...off])
      diagnostics.evaluate()
      return diagnostics.status()
    },
    'snapshots:list': () => snapshots.list(),
    'snapshots:get': ({ id }) => snapshots.get(id),
    'snapshots:create': async ({ label, rescan }) => {
      const meta = await snapshots.create({ label, rescan })
      bus.publish({ type: 'inventory.snapshot_created', summary: `Snapshot created${meta.label ? `: ${meta.label}` : ''} (${meta.deviceCount} devices${meta.complete ? '' : ', incomplete coverage'})`, data: { snapshotId: meta.id, complete: meta.complete } })
      return meta
    },
    'snapshots:compare': ({ baseId, targetId, includeVolatile }) => snapshots.compare(baseId, targetId, { includeVolatile }),
    'snapshots:delete': ({ ids }) => ({ deleted: snapshots.delete(ids) }),
    'metrics:status': () => metrics.status(),
    'metrics:query': ({ series, windowSec, maxPoints }) => metrics.query(series, windowSec * 1000, maxPoints),
    'metrics:setPaused': ({ paused }) => (metrics.setPaused(paused), metrics.status()),
    'processes:top': ({ limit }) => {
      const now = new Date().toISOString()
      if (platform !== 'linux') return disabledSnapshot(now, false)
      // Opt-in only: when switched off nothing is read and any baseline is dropped.
      if (!settings().processMonitoring) { procMon.reset(); return disabledSnapshot(now) }
      return procMon.snapshot(limit)
    },
    'collectors:health': () => inventory.getHealth(settings().pollIntervalSec * 1000 * 5),
    'events:recent': ({ limit }) => eventRepo.recent(limit),
    'monitor:status': () => monitor.status(),
    'monitor:setPaused': ({ paused }) => monitor.setPaused(paused),
    'settings:get': () => settings(),
    'devices:controls': () => devices.list(),
    'devices:setEnabled': async ({ id, enabled }) => {
      // Switch the device first: a switch that could not be applied is not saved.
      settingsRepo.set('disabledInputs', await devices.set(id, enabled))
      return devices.list()
    },
    'perf:state': async () => { await refreshPerfHelper(); return perf.state() },
    'perf:live': () => perf.live(),
    // Every change ends with a diagnostics pass so verification problems surface as findings.
    'perf:applyProfile': async ({ id }) => { try { return await perf.applyProfile(id) } finally { diagnostics.schedule(200) } },
    'perf:applyCustom': async ({ label, values }) => { try { return await perf.applyCustom(values, label) } finally { diagnostics.schedule(200) } },
    'perf:restore': async ({ target }) => { try { return await perf.restore(target) } finally { diagnostics.schedule(200) } },
    'perf:history': ({ limit }) => perf.history(limit),
    'perf:saveProfile': ({ name }) => perf.saveProfile(name),
    'perf:deleteProfile': ({ id }) => perf.deleteProfile(id),
    'perf:testStart': async ({ mode, seconds, intervalMs }) => {
      const p = await perf.startTest(mode, seconds, intervalMs)
      void perf.tests.settled().then(() => diagnostics.schedule(200))
      return p
    },
    'perf:testPoll': () => perf.tests.progress(),
    'perf:testCancel': () => perf.tests.cancel(),
    'perf:tests': ({ limit }) => perf.listTests(limit),
    'perf:test': ({ id }) => perf.getTest(id),
    'circuit:list': () => circuits.list(),
    'circuit:save': ({ id, name, design }) => circuits.save(id, name, design, new Date().toISOString()),
    'circuit:load': ({ id }) => circuits.load(id),
    'circuit:delete': ({ id }) => (circuits.remove(id), circuits.list()),
    'devtest:targets': () => tester.targets(),
    'devtest:check': ({ targetId }) => tester.run(targetId),
    'devtest:deepStart': ({ targetId, node, seconds }) => tester.deepStart(targetId, node, seconds),
    'devtest:deepPoll': ({ sessionId }) => tester.deepProgress(sessionId),
    'devtest:liveStart': ({ targetId }) => tester.startLive(targetId),
    'devtest:livePoll': ({ sessionId }) => tester.liveState(sessionId),
    'devtest:liveStill': ({ sessionId, durationMs }) => tester.startStill(sessionId, durationMs),
    'devtest:liveStop': async () => (await tester.stopLive('Stopped'), null),
    'settings:set': ({ key, value }) => {
      const next = settingsRepo.set(key, value)
      if (key === 'pollIntervalSec') monitor.setInterval(next.pollIntervalSec)
      if (key === 'liveMonitoring') monitor.setPaused(!next.liveMonitoring)
      if (key === 'theme') nativeTheme.themeSource = next.theme
      if (key.startsWith('diag') || key === 'disabledCollectors' || key === 'perfTuningEnabled') diagnostics.schedule(200)
      if (key.startsWith('metrics')) metrics.applySettings()
      return next
    },
    'export:inventory': async () => {
      const res = await dialog.showSaveDialog({ title: 'Export inventory', defaultPath: `hardware-inventory-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: 'JSON', extensions: ['json'] }] })
      if (res.canceled || !res.filePath) return { saved: false }
      const out = buildExport(inventory.repo.exportAll(), settings(), { appVersion: app.getVersion(), platform, now: new Date() })
      await fs.writeFile(res.filePath, JSON.stringify(out, null, 2), { encoding: 'utf8', mode: 0o600 })
      return { saved: true, path: res.filePath, devices: out.devices.length }
    },
    'database:backup': async () => {
      const res = await dialog.showSaveDialog({ title: 'Back up database', defaultPath: `inventory-backup-${new Date().toISOString().slice(0, 10)}.sqlite` })
      if (res.canceled || !res.filePath) return { saved: false }
      await fs.rm(res.filePath, { force: true })
      backupDatabase(db, res.filePath)
      return { saved: true, path: res.filePath }
    }
  }

  nativeTheme.themeSource = settings().theme

  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, (event, payload) => dispatch(channel, payload, event.senderFrame?.url, handlers, origins()))
  }

  const broadcast = (): (() => void) =>
    bus.subscribe((e) => {
      for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(EVENT_CHANNEL, e)
    })
  broadcast()

  await app.whenReady()
  if (!isDev) registerAppProtocol()
  hardenSession()
  createWindow()
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow())

  // Initial scan runs in the background; the UI renders immediately and updates from events.
  diagnostics.start()
  void metrics.start()
  if (settings().liveMonitoring) monitor.start()
  else void inventory.scan()
  // The compositor forgets device switches on logout and when a device is re-plugged: re-apply saved "off" switches.
  const reapply = (): void => void devices.reapply().catch((e) => console.warn('device switches:', (e as Error).message))
  reapply()
  let reapplyTimer: NodeJS.Timeout | null = null
  bus.subscribe((e) => {
    if (e.type !== 'device.connected') return
    if (reapplyTimer) clearTimeout(reapplyTimer)
    reapplyTimer = setTimeout(reapply, 1500)
  })

  let closing = false
  app.on('before-quit', (e) => {
    if (closing) return
    closing = true
    e.preventDefault()
    monitor.stop()
    diagnostics.stop()
    metrics.stop()
    // A running test is stopped and recorded as cancelled before the database closes.
    void perf.tests.cancel().catch(() => undefined).finally(() => shutdown())
  })
  const shutdown = (): void => {
    try {
      eventRepo.prune(settings().eventRetentionDays, settings().maxEvents)
      perfRepo.prune(settings().perfHistoryDays)
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      db.close()
    } catch (err) {
      console.error('shutdown cleanup failed', err)
    }
    app.quit()
  }
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

/** Serve the bundled renderer from out/renderer only: known asset types, GET/HEAD, no path escape. */
function registerAppProtocol(): void {
  const rendererDir = join(__dirname, '../renderer')
  protocol.handle(APP_SCHEME, async (request) => {
    const r = resolveAppAsset(rendererDir, request.url, request.method)
    if (!r.ok) return new Response(null, { status: r.status })
    try {
      const body = await fs.readFile(r.path)
      return new Response(request.method === 'HEAD' ? null : body, {
        headers: { 'Content-Type': r.contentType, 'Content-Security-Policy': PRODUCTION_CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}

function hardenSession(): void {
  const csp = isDev ? DEV_CSP : PRODUCTION_CSP
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
  })
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
}

function lockdown(wc: WebContents): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, url) => {
    if (!isTrustedUrl(url, origins())) e.preventDefault()
  })
  wc.on('will-attach-webview', (e) => e.preventDefault())
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 960, minHeight: 600, show: false, title: 'Hardware Intelligence Platform',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f6f7f9',
    webPreferences: { ...WINDOW_WEB_PREFERENCES, devTools: devToolsAllowed(app.isPackaged, process.env), preload: join(__dirname, '../preload/index.js') }
  })
  lockdown(win.webContents)
  win.once('ready-to-show', () => win.show())
  if (isDev) void win.loadURL(process.env['ELECTRON_RENDERER_URL']!)
  else void win.loadURL(APP_INDEX_URL)
}
