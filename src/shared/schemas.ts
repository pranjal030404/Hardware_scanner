import { z } from 'zod'

export const CATEGORIES = [
  'system',
  'motherboard',
  'cpu',
  'memory',
  'pci',
  'usb',
  'hid',
  'storage',
  'network',
  'bluetooth',
  'display',
  'audio',
  'camera',
  'sensor',
  'power',
  'serial',
  'other'
] as const
export const CategorySchema = z.enum(CATEGORIES)
export type Category = z.infer<typeof CategorySchema>

export const PLATFORMS = ['linux', 'win32', 'darwin'] as const
export const PlatformSchema = z.enum(PLATFORMS)
export type Platform = z.infer<typeof PlatformSchema>

export const COLLECTOR_STATUSES = [
  'available',
  'unavailable',
  'unsupported',
  'permission_required',
  'stale',
  'not_scanned',
  'error'
] as const
export const CollectorStatusSchema = z.enum(COLLECTOR_STATUSES)
export type CollectorStatus = z.infer<typeof CollectorStatusSchema>

export const DeviceStatusSchema = z.enum(['ok', 'error', 'disabled', 'unknown'])
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>

/** Lifecycle of a device record in the inventory (distinct from its hardware status). */
export const PresenceSchema = z.enum(['present', 'missing'])
export type Presence = z.infer<typeof PresenceSchema>

/** Where a fact came from. `os_reported` is a value the OS exposed verbatim. */
export const EvidenceSchema = z.enum(['os_reported', 'measured', 'derived', 'database_lookup'])
export type Evidence = z.infer<typeof EvidenceSchema>

export const RELATIONSHIP_TYPES = [
  'physical_parent',
  'bus_attachment',
  'logical_parent',
  'driver_dependency',
  'network_association',
  'audio_route',
  'display_connection',
  'storage_attachment',
  'inferred_relationship'
] as const
export const RelationshipTypeSchema = z.enum(RELATIONSHIP_TYPES)
export type RelationshipType = z.infer<typeof RelationshipTypeSchema>

export const IdentifierSchema = z.object({
  kind: z.string().min(1),
  value: z.string().min(1),
  /** Sensitive identifiers (serials, MACs) are redacted from exports unless the user opts in. */
  sensitive: z.boolean().optional()
})
export type Identifier = z.infer<typeof IdentifierSchema>

const PropValue = z.union([z.string(), z.number(), z.boolean()])

export const PropertySchema = z.object({
  key: z.string().min(1),
  value: PropValue,
  unit: z.string().optional(),
  /** Collector id that reported this property. */
  source: z.string().min(1),
  /** The OS interface (file, API, command field) the value was read from. */
  sourceProperty: z.string().min(1),
  evidence: EvidenceSchema.default('os_reported'),
  observedAt: z.string(),
  /** Changes between scans are not "device updated" events (e.g. live readings). */
  volatile: z.boolean().optional(),
  sensitive: z.boolean().optional()
})
export type Property = z.infer<typeof PropertySchema>

export const RelationshipSchema = z.object({
  targetKey: z.string().min(1),
  type: RelationshipTypeSchema,
  directness: z.enum(['reported', 'inferred']),
  source: z.string().min(1),
  sourceProperty: z.string().optional(),
  /** 0..1. Reported kernel topology is 1; inferred relationships must be lower. */
  confidence: z.number().min(0).max(1),
  observedAt: z.string()
})
export type Relationship = z.infer<typeof RelationshipSchema>

export const FieldSourceSchema = z.object({
  source: z.string(),
  sourceProperty: z.string(),
  evidence: EvidenceSchema
})
export type FieldSource = z.infer<typeof FieldSourceSchema>

export const DeviceObservationSchema = z.object({
  /** Stable identity string, e.g. `pci:0000:00:14.0`. See docs/COLLECTORS.md for per-category rules. */
  key: z.string().min(1),
  category: CategorySchema,
  subtype: z.string().optional(),
  name: z.string().min(1),
  manufacturer: z.string().optional(),
  model: z.string().optional(),
  description: z.string().optional(),
  vendorId: z.string().optional(),
  productId: z.string().optional(),
  busType: z.string().optional(),
  deviceClass: z.string().optional(),
  driver: z.string().optional(),
  status: DeviceStatusSchema.default('unknown'),
  source: z.string().min(1),
  identifiers: z.array(IdentifierSchema).default([]),
  properties: z.array(PropertySchema).default([]),
  relationships: z.array(RelationshipSchema).default([]),
  /** Provenance for the core fields above (name, manufacturer, model, ...). */
  fieldSources: z.record(z.string(), FieldSourceSchema).default({}),
  observedAt: z.string()
})
export type DeviceObservation = z.infer<typeof DeviceObservationSchema>

export const LimitationSchema = z.object({
  kind: z.enum(['permission', 'missing_interface', 'missing_tool', 'unsupported', 'malformed', 'timeout', 'info']),
  message: z.string(),
  /** Path, command or API the limitation relates to. */
  target: z.string().optional(),
  /** What the user can do about it, if anything. */
  remedy: z.string().optional()
})
export type Limitation = z.infer<typeof LimitationSchema>

export const CollectorResultSchema = z.object({
  /**
   * complete: everything this collector can see was read.
   * partial: some data was readable and some was not (see limitations).
   * permission_required / unavailable: nothing useful could be inspected.
   */
  outcome: z.enum(['complete', 'partial', 'permission_required', 'unavailable']),
  observations: z.array(DeviceObservationSchema),
  limitations: z.array(LimitationSchema),
  message: z.string().optional()
})
export type CollectorResult = z.infer<typeof CollectorResultSchema>

export const CollectorHealthSchema = z.object({
  id: z.string(),
  version: z.string(),
  platforms: z.array(PlatformSchema),
  categories: z.array(CategorySchema),
  permissions: z.array(z.string()),
  method: z.string(),
  status: CollectorStatusSchema,
  partial: z.boolean(),
  message: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  deviceCount: z.number().nullable(),
  limitations: z.array(LimitationSchema)
})
export type CollectorHealth = z.infer<typeof CollectorHealthSchema>

// ---------- Events ----------

export const HIP_EVENT_TYPES = [
  'device.discovered',
  'device.updated',
  'device.connected',
  'device.disconnected',
  'device.status_changed',
  'collector.started',
  'collector.completed',
  'collector.failed',
  'metric.sampled',
  'diagnostic.created',
  'diagnostic.resolved',
  'inventory.snapshot_created',
  'monitor.status_changed'
] as const
export const HipEventTypeSchema = z.enum(HIP_EVENT_TYPES)
export type HipEventType = z.infer<typeof HipEventTypeSchema>

export const HipEventSchema = z.object({
  type: HipEventTypeSchema,
  at: z.string(),
  deviceId: z.string().nullable().default(null),
  deviceName: z.string().nullable().default(null),
  category: CategorySchema.nullable().default(null),
  collectorId: z.string().nullable().default(null),
  /** Short human-readable summary. */
  summary: z.string(),
  data: z.record(z.string(), z.unknown()).default({})
})
export type HipEvent = z.infer<typeof HipEventSchema>

// ---------- Settings ----------

export const SettingsSchema = z.object({
  theme: z.enum(['system', 'dark', 'light']).default('system'),
  /** Safety-net rescan interval; udev (when available) triggers earlier rescans. */
  pollIntervalSec: z.number().int().min(10).max(3600).default(60),
  liveMonitoring: z.boolean().default(true),
  eventRetentionDays: z.number().int().min(1).max(3650).default(90),
  maxEvents: z.number().int().min(100).max(1_000_000).default(20_000),
  exportIncludeSerials: z.boolean().default(false),
  exportIncludeMacAddresses: z.boolean().default(false),
  exportIncludeHostname: z.boolean().default(false),
  exportIncludeIpAddresses: z.boolean().default(false),
  /** Diagnostics thresholds (percent of filesystem used). */
  diagDiskWarnPercent: z.number().min(50).max(99).default(85),
  diagDiskCriticalPercent: z.number().min(51).max(100).default(95),
  /** Warn this many °C below a sensor's own reported critical limit. */
  diagTempMarginC: z.number().min(1).max(50).default(10),
  /** Optional absolute fallback for sensors that report no limits; 0 disables (no universal thresholds). */
  diagTempFallbackC: z.number().min(0).max(150).default(0),
  /** Resource-pressure rules: kernel PSI "some" avg10 (% of time tasks stalled) must stay at/above this for most of the window. */
  diagPressureWarnPercent: z.number().min(1).max(95).default(25),
  diagPressureWindowMin: z.number().int().min(2).max(120).default(5),
  /** Sustained swap-in rate (pages/s) that indicates thrashing. */
  diagSwapInPagesPerSec: z.number().min(1).max(1_000_000).default(100),
  /** Look-back for thermal-throttle counter increases. */
  diagThrottleWindowMin: z.number().int().min(5).max(1440).default(30),
  /** Network-down findings are opt-in: a disconnected interface is often normal. */
  diagNetworkDownEnabled: z.boolean().default(false),
  /** How long a missing device keeps producing a finding after it was last seen. */
  diagMissingWindowHours: z.number().int().min(1).max(8760).default(168),
  diagDisabledRules: z.array(z.string().max(64)).max(64).default([]),
  /** Metric sampling is independent of inventory rescans. */
  metricsEnabled: z.boolean().default(true),
  metricsIntervalSec: z.number().int().min(1).max(60).default(5),
  metricsRetentionHours: z.number().int().min(1).max(720).default(24),
  /** Opt-in: reads process names, memory and CPU share. Off by default because process lists are personal data. */
  processMonitoring: z.boolean().default(false)
})
export type Settings = z.infer<typeof SettingsSchema>
export const SETTING_KEYS = Object.keys(SettingsSchema.shape) as (keyof Settings)[]

// ---------- API payloads (main -> renderer) ----------

export const DeviceSummarySchema = z.object({
  id: z.string(),
  key: z.string(),
  category: CategorySchema,
  subtype: z.string().nullable(),
  name: z.string(),
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  vendorId: z.string().nullable(),
  productId: z.string().nullable(),
  busType: z.string().nullable(),
  driver: z.string().nullable(),
  status: DeviceStatusSchema,
  presence: PresenceSchema,
  firstSeen: z.string(),
  lastSeen: z.string(),
  lastScanned: z.string(),
  source: z.string()
})
export type DeviceSummary = z.infer<typeof DeviceSummarySchema>

export const RelatedDeviceSchema = z.object({
  relationshipType: RelationshipTypeSchema,
  directness: z.enum(['reported', 'inferred']),
  confidence: z.number(),
  source: z.string(),
  observedAt: z.string(),
  other: DeviceSummarySchema.pick({ id: true, name: true, category: true, presence: true }),
  /** `parent` = this device points at `other`; `child` = `other` points at this device. */
  direction: z.enum(['parent', 'child'])
})
export type RelatedDevice = z.infer<typeof RelatedDeviceSchema>

export const DeviceDetailSchema = z.object({
  device: DeviceSummarySchema.extend({
    description: z.string().nullable(),
    deviceClass: z.string().nullable(),
    fieldSources: z.record(z.string(), FieldSourceSchema)
  }),
  identifiers: z.array(IdentifierSchema),
  properties: z.array(PropertySchema),
  relationships: z.array(RelatedDeviceSchema),
  events: z.array(HipEventSchema)
})
export type DeviceDetail = z.infer<typeof DeviceDetailSchema>

export const MonitorStatusSchema = z.object({
  mode: z.enum(['udev', 'polling', 'paused', 'stopped']),
  degraded: z.boolean(),
  message: z.string().nullable(),
  intervalSec: z.number(),
  lastScanAt: z.string().nullable(),
  scanning: z.boolean()
})
export type MonitorStatus = z.infer<typeof MonitorStatusSchema>

export const ScanSummarySchema = z.object({
  startedAt: z.string(),
  durationMs: z.number(),
  devices: z.number(),
  added: z.number(),
  removed: z.number(),
  updated: z.number(),
  collectors: z.object({ ok: z.number(), failed: z.number(), unavailable: z.number() })
})
export type ScanSummary = z.infer<typeof ScanSummarySchema>

export const AppInfoSchema = z.object({
  version: z.string(),
  electron: z.string(),
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  schemaVersion: z.number(),
  migrations: z.array(z.object({ version: z.number(), name: z.string(), appliedAt: z.string() })),
  databasePath: z.string()
})
export type AppInfo = z.infer<typeof AppInfoSchema>

export const OverviewSchema = z.object({
  system: z.record(z.string(), z.string()),
  counts: z.record(z.string(), z.number()),
  storage: z.array(
    z.object({ name: z.string(), mount: z.string(), fs: z.string(), totalBytes: z.number(), usedBytes: z.number() })
  ),
  network: z.array(z.object({ name: z.string(), state: z.string(), kind: z.string() })),
  openFindings: z.number()
})
export type Overview = z.infer<typeof OverviewSchema>

// ---------- Diagnostics ----------

export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const
export const SeveritySchema = z.enum(SEVERITIES)
export type Severity = z.infer<typeof SeveritySchema>

export const FINDING_STATUSES = ['active', 'acknowledged', 'resolved', 'dismissed'] as const
export const FindingStatusSchema = z.enum(FINDING_STATUSES)
export type FindingStatus = z.infer<typeof FindingStatusSchema>

export const FINDING_CATEGORIES = ['collector', 'inventory', 'device', 'storage', 'thermal', 'network', 'monitoring', 'power'] as const
export const FindingCategorySchema = z.enum(FINDING_CATEGORIES)
export type FindingCategory = z.infer<typeof FindingCategorySchema>

/** A pointer to an actual stored observation that supports a finding, with the value seen. */
export const EvidenceRefSchema = z.object({
  type: z.enum(['device_field', 'device_property', 'collector_run', 'device_event', 'metric_sample', 'setting', 'monitor_state']),
  /** Device id, collector id, rule setting name... depending on `type`. */
  ref: z.string().min(1),
  key: z.string().optional(),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  unit: z.string().optional(),
  source: z.string().optional(),
  observedAt: z.string(),
  note: z.string().optional()
})
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>

export const FindingSchema = z.object({
  id: z.string().min(1),
  ruleId: z.string().min(1),
  ruleVersion: z.number().int().min(1),
  subjectKey: z.string().min(1),
  severity: SeveritySchema,
  category: FindingCategorySchema,
  title: z.string().min(1),
  description: z.string().min(1),
  deviceIds: z.array(z.string()),
  evidence: z.array(EvidenceRefSchema),
  confidence: z.number().min(0).max(1).nullable(),
  recommendation: z.string(),
  status: FindingStatusSchema,
  firstDetectedAt: z.string(),
  lastSeenAt: z.string(),
  updatedAt: z.string(),
  acknowledgedAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  resolutionReason: z.string().nullable()
})
export type Finding = z.infer<typeof FindingSchema>

export const RuleRunOutcomeSchema = z.enum(['evaluated', 'insufficient_data', 'disabled', 'error'])
export type RuleRunOutcome = z.infer<typeof RuleRunOutcomeSchema>

export const RuleInfoSchema = z.object({
  id: z.string(),
  version: z.number(),
  title: z.string(),
  category: FindingCategorySchema,
  description: z.string(),
  severityPolicy: z.string(),
  dataUsed: z.string(),
  enabled: z.boolean(),
  lastRun: z
    .object({ startedAt: z.string(), durationMs: z.number(), outcome: RuleRunOutcomeSchema, message: z.string().nullable(), findings: z.number() })
    .nullable()
})
export type RuleInfo = z.infer<typeof RuleInfoSchema>

export const DiagnosticsStatusSchema = z.object({
  lastEvaluatedAt: z.string().nullable(),
  evaluating: z.boolean(),
  lastError: z.string().nullable(),
  /** Inventory data feeding the rules is older than the freshness window. */
  dataStale: z.boolean(),
  lastInventoryScanAt: z.string().nullable(),
  counts: z.object({
    bySeverity: z.record(z.string(), z.number()),
    byStatus: z.record(z.string(), z.number())
  }),
  rules: z.array(RuleInfoSchema)
})
export type DiagnosticsStatus = z.infer<typeof DiagnosticsStatusSchema>

export const FindingDetailSchema = z.object({
  finding: FindingSchema,
  rule: RuleInfoSchema.nullable(),
  devices: z.array(z.object({ id: z.string(), name: z.string(), category: CategorySchema, presence: PresenceSchema }))
})
export type FindingDetail = z.infer<typeof FindingDetailSchema>

// ---------- Snapshots ----------

export const COVERAGE_STATES = ['complete', 'partial', 'stale', 'permission_required', 'unavailable', 'unsupported', 'error', 'not_scanned'] as const
export const CoverageStateSchema = z.enum(COVERAGE_STATES)
export type CoverageState = z.infer<typeof CoverageStateSchema>

/** Per-collector state at the moment a snapshot was taken. Only `complete` can vouch for absence. */
export const CollectorCoverageSchema = z.object({
  id: z.string(),
  state: CoverageStateSchema,
  categories: z.array(CategorySchema),
  lastRunAt: z.string().nullable(),
  lastSuccessAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  message: z.string().nullable(),
  limitations: z.array(z.object({ kind: z.string(), message: z.string() })),
  deviceCount: z.number()
})
export type CollectorCoverage = z.infer<typeof CollectorCoverageSchema>

export const SnapshotMetaSchema = z.object({
  id: z.string(),
  label: z.string().nullable(),
  createdAt: z.string(),
  /** When the last inventory scan feeding this snapshot finished. */
  scanAt: z.string().nullable(),
  appVersion: z.string().nullable(),
  schemaVersion: z.number().nullable(),
  /** Random identifier generated locally; never transmitted. */
  machineId: z.string().nullable(),
  deviceCount: z.number(),
  relationshipCount: z.number(),
  propertyCount: z.number(),
  categoryCounts: z.record(z.string(), z.number()),
  collectors: z.array(CollectorCoverageSchema),
  /** True only if every supported collector was complete. */
  complete: z.boolean(),
  limitations: z.array(z.string())
})
export type SnapshotMeta = z.infer<typeof SnapshotMetaSchema>

/** A device record as preserved in a snapshot (full copy, validated on read). */
export const SnapshotDeviceSchema = z.object({
  id: z.string(),
  key: z.string(),
  category: CategorySchema,
  subtype: z.string().nullable(),
  name: z.string(),
  manufacturer: z.string().nullable(),
  model: z.string().nullable(),
  description: z.string().nullable(),
  vendorId: z.string().nullable(),
  productId: z.string().nullable(),
  busType: z.string().nullable(),
  deviceClass: z.string().nullable(),
  driver: z.string().nullable(),
  status: DeviceStatusSchema,
  presence: PresenceSchema,
  firstSeen: z.string(),
  lastSeen: z.string(),
  lastScanned: z.string(),
  source: z.string(),
  identifiers: z.array(IdentifierSchema),
  properties: z.array(PropertySchema),
  relationships: z.array(RelationshipSchema),
  fieldSources: z.record(z.string(), FieldSourceSchema)
})

export const Certainty = z.enum(['confirmed', 'probable', 'uncertain'])
export type CertaintyLevel = z.infer<typeof Certainty>

export const DeviceRefSchema = z.object({ key: z.string(), deviceId: z.string(), name: z.string(), category: CategorySchema, source: z.string() })
export type DeviceRef = z.infer<typeof DeviceRefSchema>

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()])

export const PropertyChangeSchema = z.object({
  field: z.string(),
  kind: z.enum(['field', 'property', 'identity']),
  before: Scalar,
  after: Scalar,
  unit: z.string().optional(),
  /** Collector + interface that reported the value (newer side for changes/additions, older for removals). */
  source: z.string().optional(),
  sensitive: z.boolean().optional(),
  change: z.enum(['changed', 'added', 'removed']),
  certainty: Certainty,
  note: z.string().optional()
})
export type PropertyChange = z.infer<typeof PropertyChangeSchema>

export const RelationshipChangeSchema = z.object({
  type: RelationshipTypeSchema,
  otherName: z.string(),
  change: z.enum(['added', 'removed', 'modified']),
  before: z.object({ directness: z.enum(['reported', 'inferred']), confidence: z.number() }).nullable(),
  after: z.object({ directness: z.enum(['reported', 'inferred']), confidence: z.number() }).nullable(),
  source: z.string(),
  certainty: Certainty,
  note: z.string().optional()
})
export type RelationshipChange = z.infer<typeof RelationshipChangeSchema>

export const ComparisonChangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('device_added'), device: DeviceRefSchema, certainty: Certainty }),
  z.object({ kind: z.literal('device_removed'), device: DeviceRefSchema, certainty: Certainty }),
  z.object({
    kind: z.literal('property_changed'), device: DeviceRefSchema, changes: z.array(PropertyChangeSchema),
    /** Set when the device was matched across a changed identity key. */
    rekeyed: z.object({ from: z.string(), to: z.string(), method: z.string(), confidence: z.number() }).nullable()
  }),
  z.object({ kind: z.literal('relationship_changed'), device: DeviceRefSchema, changes: z.array(RelationshipChangeSchema) }),
  z.object({
    kind: z.literal('coverage_changed'), collectorId: z.string(), before: z.string(), after: z.string(), devicesAffected: z.number(), explanation: z.string()
  }),
  z.object({
    kind: z.literal('indeterminate'), device: DeviceRefSchema, direction: z.enum(['missing_in_target', 'new_in_target']), reason: z.string()
  })
])
export type ComparisonChange = z.infer<typeof ComparisonChangeSchema>

export const SnapshotComparisonSchema = z.object({
  base: SnapshotMetaSchema,
  target: SnapshotMetaSchema,
  changes: z.array(ComparisonChangeSchema),
  summary: z.object({
    added: z.number(), removed: z.number(), changed: z.number(), relationshipChanged: z.number(), coverageChanged: z.number(), indeterminate: z.number(), unchanged: z.number()
  }),
  /** The comparison cannot be fully trusted (see reasons). */
  uncertain: z.boolean(),
  reasons: z.array(z.string()),
  /** Persisted records that failed validation and were skipped. */
  skippedRecords: z.number(),
  includeVolatile: z.boolean()
})
export type SnapshotComparison = z.infer<typeof SnapshotComparisonSchema>

// ---------- Metrics ----------

export const MetricProviderStatusSchema = z.enum(['ok', 'partial', 'unavailable', 'unsupported', 'error', 'paused', 'starting'])
export type MetricProviderStatus = z.infer<typeof MetricProviderStatusSchema>

export const MetricSeriesSummarySchema = z.object({
  metric: z.string(),
  deviceId: z.string(),
  deviceName: z.string(),
  deviceCategory: CategorySchema,
  unit: z.string(),
  source: z.string(),
  lastValue: z.number().nullable(),
  lastAt: z.string().nullable(),
  /** No measurement within the freshness window (or sampling paused). Never shown as healthy. */
  stale: z.boolean()
})
export type MetricSeriesSummary = z.infer<typeof MetricSeriesSummarySchema>

export const MetricProviderInfoSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: MetricProviderStatusSchema,
  message: z.string().nullable(),
  lastSampleAt: z.string().nullable(),
  consecutiveFailures: z.number(),
  counterResets: z.number(),
  invalidReadings: z.number(),
  metrics: z.array(z.object({ metric: z.string(), unit: z.string(), description: z.string(), source: z.string() }))
})
export type MetricProviderInfo = z.infer<typeof MetricProviderInfoSchema>

export const MetricsStatusSchema = z.object({
  enabled: z.boolean(),
  running: z.boolean(),
  paused: z.boolean(),
  intervalSec: z.number(),
  retentionHours: z.number(),
  platformSupported: z.boolean(),
  providers: z.array(MetricProviderInfoSchema),
  series: z.array(MetricSeriesSummarySchema),
  bufferedSamples: z.number(),
  pendingWrites: z.number(),
  storedSamples: z.number()
})
export type MetricsStatus = z.infer<typeof MetricsStatusSchema>

export const MetricSeriesDataSchema = z.object({
  metric: z.string(),
  deviceId: z.string(),
  unit: z.string(),
  source: z.string(),
  points: z.array(z.object({ t: z.number(), v: z.number() })),
  lastAt: z.string().nullable(),
  stale: z.boolean(),
  /** Spacing of raw samples; charts break lines across larger gaps instead of interpolating. */
  intervalMs: z.number()
})
export type MetricSeriesData = z.infer<typeof MetricSeriesDataSchema>
