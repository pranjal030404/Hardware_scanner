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
