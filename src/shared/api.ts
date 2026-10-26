/**
 * Types and constants shared with the preload script. This module must stay free of runtime
 * imports (notably zod): a sandboxed preload cannot require node_modules.
 */
import type { MetricSeriesData, MetricsStatus, SnapshotComparison, SnapshotMeta, DiagnosticsStatus, Finding, FindingDetail, FindingStatus, Severity, FindingCategory, AppInfo, CollectorHealth, DeviceDetail, DeviceSummary, HipEvent, MonitorStatus, Overview, ScanSummary, Settings, Category, DeviceStatus } from './schemas'

import type { ProcessSnapshot } from '../processes'
import type { PointingStickStatus } from '../input-control/pointing-stick'

export const EVENT_CHANNEL = 'hip:event'

export interface InventoryFilter {
  category?: Category
  search?: string
  status?: DeviceStatus
  includeMissing?: boolean
}

export interface TopologyEdge {
  fromId: string
  toId: string
  type: string
  directness: 'reported' | 'inferred'
  confidence: number
  source: string
}

export interface TopologyData {
  nodes: DeviceSummary[]
  /** `fromId` is the dependent device, `toId` is the device it attaches to (its parent). */
  edges: TopologyEdge[]
}

export interface FindingFilter {
  status?: FindingStatus
  severity?: Severity
  category?: FindingCategory
  search?: string
}

export type ExportResult = { saved: boolean; path?: string; devices?: number }

export interface IpcResponses {
  'app:info': AppInfo
  'overview:get': Overview
  'inventory:list': DeviceSummary[]
  'inventory:get': DeviceDetail | null
  'inventory:scan': ScanSummary
  'topology:get': TopologyData
  'collectors:health': CollectorHealth[]
  'metrics:status': MetricsStatus
  'processes:top': ProcessSnapshot
  'input:pointingStick': PointingStickStatus
  'metrics:query': MetricSeriesData[]
  'metrics:setPaused': MetricsStatus
  'snapshots:list': SnapshotMeta[]
  'snapshots:get': SnapshotMeta | null
  'snapshots:create': SnapshotMeta
  'snapshots:compare': SnapshotComparison
  'snapshots:delete': { deleted: number }
  'diagnostics:status': DiagnosticsStatus
  'diagnostics:list': Finding[]
  'diagnostics:get': FindingDetail | null
  'diagnostics:setStatus': Finding
  'diagnostics:evaluate': DiagnosticsStatus
  'diagnostics:setRuleEnabled': DiagnosticsStatus
  'events:recent': HipEvent[]
  'monitor:status': MonitorStatus
  'monitor:setPaused': MonitorStatus
  'settings:get': Settings
  'settings:set': Settings
  'export:inventory': ExportResult
  'database:backup': ExportResult
}

/** The only object exposed to the renderer (via contextBridge). */
export interface HipApi {
  appInfo(): Promise<AppInfo>
  overview(): Promise<Overview>
  listDevices(filter?: InventoryFilter): Promise<DeviceSummary[]>
  getDevice(id: string): Promise<DeviceDetail | null>
  scan(collectorIds?: string[]): Promise<ScanSummary>
  topology(): Promise<TopologyData>
  collectorHealth(): Promise<CollectorHealth[]>
  metricsStatus(): Promise<MetricsStatus>
  topProcesses(limit?: number): Promise<ProcessSnapshot>
  pointingStickStatus(): Promise<PointingStickStatus>
  queryMetrics(series: { metric: string; deviceId: string }[], windowSec: number, maxPoints?: number): Promise<MetricSeriesData[]>
  setMetricsPaused(paused: boolean): Promise<MetricsStatus>
  listSnapshots(): Promise<SnapshotMeta[]>
  getSnapshot(id: string): Promise<SnapshotMeta | null>
  createSnapshot(label?: string, rescan?: boolean): Promise<SnapshotMeta>
  compareSnapshots(baseId: string, targetId: string, includeVolatile?: boolean): Promise<SnapshotComparison>
  deleteSnapshots(ids: string[]): Promise<{ deleted: number }>
  diagnosticsStatus(): Promise<DiagnosticsStatus>
  listFindings(filter?: FindingFilter): Promise<Finding[]>
  getFinding(id: string): Promise<FindingDetail | null>
  setFindingStatus(id: string, action: 'acknowledge' | 'dismiss' | 'resolve' | 'reopen', reason?: string): Promise<Finding>
  evaluateDiagnostics(): Promise<DiagnosticsStatus>
  setDiagnosticRuleEnabled(ruleId: string, enabled: boolean): Promise<DiagnosticsStatus>
  recentEvents(limit?: number): Promise<HipEvent[]>
  monitorStatus(): Promise<MonitorStatus>
  setMonitorPaused(paused: boolean): Promise<MonitorStatus>
  getSettings(): Promise<Settings>
  setSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<Settings>
  exportInventory(): Promise<ExportResult>
  backupDatabase(): Promise<ExportResult>
  /** Subscribe to pushed events; returns an unsubscribe function. */
  onEvent(listener: (event: HipEvent) => void): () => void
}
