/** Types shared by the performance module, the main process and the renderer (types only). */

export type BuiltinProfileId = 'stock' | 'quiet' | 'balanced' | 'performance' | 'maximum'

/**
 * supported      writable interface present, helper usable, and a past change was read back on this machine
 * not_verified   writable interface present and helper usable, never confirmed by read-back here yet
 * permission_required  writable interface present but the privileged helper is missing/unverified
 * unavailable    the device reports it but the kernel exposes it read-only (or the tool is missing)
 * unsupported    this device does not have it
 * error          reading it failed
 */
export type ControlStatus = 'supported' | 'not_verified' | 'permission_required' | 'unavailable' | 'unsupported' | 'error'
export type Risk = 'low' | 'medium' | 'high'

export interface PerfControl {
  /** Helper setting id, e.g. "cpu.governor", "rapl.pl1_uw", "igpu.card1.max_mhz". */
  id: string
  deviceId: string
  label: string
  status: ControlStatus
  read: boolean
  write: boolean
  /** Current value in words, when it can be read. */
  current: string | null
  /** Raw current value as the helper understands it. */
  currentRaw: string | null
  /** For numeric controls: range in raw units. */
  min?: number
  max?: number
  unit?: string
  /** Display scale: shown = raw / scale. */
  scale?: number
  step?: number
  /** Where the range comes from (driver range, firmware rating, safety ceiling…). */
  rangeSource?: string
  /** For choice controls: the values this device offers. */
  options?: string[]
  /** The file or tool the value is read from and written to. */
  source: string
  /** runtime = lost at reboot (sysfs); persistent = the system keeps it across reboots (e.g. tuned's active profile). */
  persistence: 'runtime' | 'persistent'
  rebootRequired: false
  restorable: boolean
  risk: Risk
  reason: string | null
}

export type MeasurementState = 'live' | 'stale' | 'unavailable'

export interface Measurement {
  label: string
  value: string | null
  source: string
  at: string | null
  state: MeasurementState
  reason?: string
}

export interface PerfSetting {
  label: string
  current: string
  allowed: string
  best: string
  adjustable: boolean
}

export interface PerfKnob {
  id: string
  label: string
  unit: string
  scale: number
  current: number
  stock: number
  stockSource: string
  min: number
  max: number
  maxSource: string
  step: number
  help: string
}

export interface PerfDevice {
  id: string
  kind: 'cpu' | 'power' | 'igpu' | 'amdgpu' | 'nvidia' | 'memory' | 'system'
  label: string
  summary: string
  /** Monitoring only: nothing on this device can be changed from here. */
  monitoringOnly: boolean
  settings: PerfSetting[]
  controls: PerfControl[]
  overclock: { supported: boolean; reason: string; knobs: PerfKnob[] }
}

export interface PresetChange {
  /** Helper setting id. */
  id: string
  label: string
  from: string
  to: string
  /** Raw value that will be requested. */
  raw: string
  risk: Risk
  /** Why this value (e.g. "kernel default for intel_pstate active mode"). */
  note?: string
}

export interface ProfilePlan {
  /** Built-in id, or "custom:<n>" for a saved profile. */
  id: string
  title: string
  builtin: boolean
  summary: string
  /** False when a saved profile belongs to different hardware or asks for something this device cannot do. */
  compatible: boolean
  incompatibleReason: string | null
  changes: PresetChange[]
  unchanged: PresetChange[]
  /** Settings the profile would like to set but this device does not report (left unchanged). */
  skipped: string[]
}

export type TxStatus = 'running' | 'verified' | 'partially_verified' | 'mismatch' | 'failed' | 'rolled_back' | 'rollback_failed' | 'unverifiable'
export type ItemVerification = 'pending' | 'verified' | 'mismatch' | 'unverifiable' | 'not_applied' | 'rolled_back' | 'rollback_failed'

export interface TxItem {
  controlId: string
  label: string
  previousRaw: string | null
  previous: string | null
  requestedRaw: string
  requested: string
  /** Read back from the kernel after applying (null when it could not be read). */
  effective: string | null
  verification: ItemVerification
  message: string | null
}

export interface TxRecord {
  id: number
  startedAt: string
  finishedAt: string | null
  kind: 'profile' | 'custom' | 'restore' | 'rollback'
  label: string
  fingerprint: string
  status: TxStatus
  error: string | null
  items: TxItem[]
}

export interface HelperInfo {
  usable: boolean
  path: string
  reason: string | null
}

export interface PerfState {
  supported: boolean
  /** Windows/other: what is shown is monitoring only. */
  monitoringOnly: boolean
  reason: string | null
  platform: string
  fingerprint: string
  /** Settings → tuning controls switch. */
  tuningEnabled: boolean
  helper: HelperInfo
  devices: PerfDevice[]
  telemetry: Measurement[]
  profiles: ProfilePlan[]
  tuned: { active: string | null; available: string[]; recommended: string | null } | null
  /** The built-in profile whose every setting already matches, if any. */
  matches: string | null
  lastTransaction: TxRecord | null
  /** What "Undo last change" and "Restore original" would do (null = nothing recorded). */
  canUndo: boolean
  canRestoreOriginal: boolean
  busy: 'tuning' | 'testing' | null
}

export interface PerfLive {
  at: string
  cpuMHz: number | null
  cpuMaxMHz: number | null
  cpuUtilization: number | null
  gpuMHz: number | null
  gpuMaxMHz: number | null
  temperatureC: number | null
  temperatureLimitC: number | null
  throttleEvents: number | null
  sources: Record<string, string>
}

export interface PerfApplyResult {
  state: PerfState
  transaction: TxRecord | null
}

// ---- stability / performance testing -----------------------------------------------------------

export type TestMode = 'benchmark' | 'monitor'
export type TestStatus = 'running' | 'completed' | 'cancelled' | 'failed'

export interface TestSample {
  tMs: number
  cpuMHz: number | null
  temperatureC: number | null
  utilization: number | null
  throttleEvents: number | null
  gpuMHz: number | null
  /** Benchmark only: workload throughput in this interval (MB/s). */
  throughput: number | null
}

export interface TestSummary {
  /** Benchmark only: SHA-256 throughput over the whole run (MB/s, all threads). */
  score: number | null
  avgMHz: number | null
  maxMHz: number | null
  maxTemperatureC: number | null
  temperatureLimitC: number | null
  throttleEvents: number | null
  /** Throughput in the last third versus the first third, in percent (negative = it slowed down). */
  sustainedChangePct: number | null
  notes: string[]
}

export interface TestSession {
  id: number
  startedAt: string
  finishedAt: string | null
  mode: TestMode
  durationS: number
  intervalMs: number
  threads: number
  status: TestStatus
  fingerprint: string
  txId: number | null
  profile: string | null
  summary: TestSummary
  error: string | null
}

export interface TestProgress {
  session: TestSession
  elapsedMs: number
  samples: TestSample[]
}
