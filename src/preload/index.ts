import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { EVENT_CHANNEL, type HipApi } from '@shared/api'
import type { HipEvent } from '@shared/schemas'

/**
 * The renderer's entire capability surface. Each method maps to exactly one whitelisted channel;
 * there is no generic invoke/send, and no Node, fs or shell access is exposed.
 */
const api: HipApi = {
  appInfo: () => ipcRenderer.invoke('app:info'),
  overview: () => ipcRenderer.invoke('overview:get'),
  listDevices: (filter = {}) => ipcRenderer.invoke('inventory:list', filter),
  getDevice: (id) => ipcRenderer.invoke('inventory:get', { id }),
  scan: (collectorIds) => ipcRenderer.invoke('inventory:scan', collectorIds ? { collectorIds } : {}),
  topology: () => ipcRenderer.invoke('topology:get'),
  collectorHealth: () => ipcRenderer.invoke('collectors:health'),
  metricsStatus: () => ipcRenderer.invoke('metrics:status'),
  deviceControls: () => ipcRenderer.invoke('devices:controls'),
  setDeviceEnabled: (id, enabled) => ipcRenderer.invoke('devices:setEnabled', { id, enabled }),
  performanceState: () => ipcRenderer.invoke('perf:state'),
  performanceLive: () => ipcRenderer.invoke('perf:live'),
  applyPerformanceProfile: (id) => ipcRenderer.invoke('perf:applyProfile', { id }),
  applyPerformanceValues: (label, values) => ipcRenderer.invoke('perf:applyCustom', { label, values }),
  restorePerformance: (target) => ipcRenderer.invoke('perf:restore', { target }),
  performanceHistory: (limit) => ipcRenderer.invoke('perf:history', limit === undefined ? {} : { limit }),
  savePerformanceProfile: (name) => ipcRenderer.invoke('perf:saveProfile', { name }),
  deletePerformanceProfile: (id) => ipcRenderer.invoke('perf:deleteProfile', { id }),
  startPerformanceTest: (mode, seconds, intervalMs) => ipcRenderer.invoke('perf:testStart', { mode, seconds, intervalMs }),
  pollPerformanceTest: () => ipcRenderer.invoke('perf:testPoll'),
  cancelPerformanceTest: () => ipcRenderer.invoke('perf:testCancel'),
  performanceTests: (limit) => ipcRenderer.invoke('perf:tests', limit === undefined ? {} : { limit }),
  performanceTest: (id) => ipcRenderer.invoke('perf:test', { id }),
  listCircuits: () => ipcRenderer.invoke('circuit:list'),
  saveCircuit: (name, design, id) => ipcRenderer.invoke('circuit:save', id === undefined ? { name, design } : { id, name, design }),
  loadCircuit: (id) => ipcRenderer.invoke('circuit:load', { id }),
  deleteCircuit: (id) => ipcRenderer.invoke('circuit:delete', { id }),
  testTargets: () => ipcRenderer.invoke('devtest:targets'),
  runDeviceTest: (targetId) => ipcRenderer.invoke('devtest:check', { targetId }),
  startDeepTest: (targetId, node, seconds) => ipcRenderer.invoke('devtest:deepStart', { targetId, node, seconds }),
  pollDeepTest: (sessionId) => ipcRenderer.invoke('devtest:deepPoll', { sessionId }),
  startLiveTest: (targetId) => ipcRenderer.invoke('devtest:liveStart', { targetId }),
  pollLiveTest: (sessionId) => ipcRenderer.invoke('devtest:livePoll', { sessionId }),
  startStillTest: (sessionId, durationMs) => ipcRenderer.invoke('devtest:liveStill', { sessionId, durationMs }),
  stopLiveTest: () => ipcRenderer.invoke('devtest:liveStop'),
  topProcesses: (limit) => ipcRenderer.invoke('processes:top', limit === undefined ? {} : { limit }),
  queryMetrics: (series, windowSec, maxPoints) => ipcRenderer.invoke('metrics:query', { series, windowSec, ...(maxPoints === undefined ? {} : { maxPoints }) }),
  setMetricsPaused: (paused) => ipcRenderer.invoke('metrics:setPaused', { paused }),
  listSnapshots: () => ipcRenderer.invoke('snapshots:list'),
  getSnapshot: (id) => ipcRenderer.invoke('snapshots:get', { id }),
  createSnapshot: (label, rescan) => ipcRenderer.invoke('snapshots:create', { ...(label ? { label } : {}), ...(rescan === undefined ? {} : { rescan }) }),
  compareSnapshots: (baseId, targetId, includeVolatile) => ipcRenderer.invoke('snapshots:compare', { baseId, targetId, ...(includeVolatile === undefined ? {} : { includeVolatile }) }),
  deleteSnapshots: (ids) => ipcRenderer.invoke('snapshots:delete', { ids }),
  diagnosticsStatus: () => ipcRenderer.invoke('diagnostics:status'),
  listFindings: (filter = {}) => ipcRenderer.invoke('diagnostics:list', filter),
  getFinding: (id) => ipcRenderer.invoke('diagnostics:get', { id }),
  setFindingStatus: (id, action, reason) => ipcRenderer.invoke('diagnostics:setStatus', reason ? { id, action, reason } : { id, action }),
  evaluateDiagnostics: () => ipcRenderer.invoke('diagnostics:evaluate'),
  setDiagnosticRuleEnabled: (ruleId, enabled) => ipcRenderer.invoke('diagnostics:setRuleEnabled', { ruleId, enabled }),
  recentEvents: (limit = 100) => ipcRenderer.invoke('events:recent', { limit }),
  monitorStatus: () => ipcRenderer.invoke('monitor:status'),
  setMonitorPaused: (paused) => ipcRenderer.invoke('monitor:setPaused', { paused }),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSetting: (key, value) => ipcRenderer.invoke('settings:set', { key, value }),
  exportInventory: () => ipcRenderer.invoke('export:inventory'),
  backupDatabase: () => ipcRenderer.invoke('database:backup'),
  onEvent: (listener) => {
    const h = (_e: IpcRendererEvent, ev: HipEvent): void => listener(ev)
    ipcRenderer.on(EVENT_CHANNEL, h)
    return () => ipcRenderer.removeListener(EVENT_CHANNEL, h)
  }
}

contextBridge.exposeInMainWorld('hip', api)
