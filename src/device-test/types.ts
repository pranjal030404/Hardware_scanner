/** Types shared by the device-test engine, the main process and the renderer (types only: the preload imports this). */

export type TargetKind = 'usb' | 'input' | 'network' | 'storage' | 'battery' | 'camera' | 'bluetooth'

export type InputRole = 'keyboard' | 'mouse' | 'touchpad' | 'pointing stick' | 'touchscreen' | 'tablet' | 'game controller'

export interface TestTarget {
  /** Stable for the life of the connection, e.g. "usb:3-1", "net:wlp0s20f3". */
  id: string
  kind: TargetKind
  label: string
  /** One line of what it is and where it is attached. */
  detail: string
  /** Input event nodes that belong to this device (e.g. ["event6"]); empty for non-input devices. */
  inputNodes: string[]
  roles: InputRole[]
}

/** A kernel message about a USB connection that never became a working device. */
export interface ConnectionAttempt {
  port: string
  at: string
  message: string
  explanation: string
  /** The port currently has a working device on it. */
  nowPresent: boolean
}

export interface TargetList {
  targets: TestTarget[]
  attempts: ConnectionAttempt[]
  /** Why the kernel log could not be read (null when it could). */
  kernelLogLimitation: string | null
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'info' | 'skip'

export interface CheckResult {
  id: string
  title: string
  status: CheckStatus
  summary: string
  /** Raw evidence: file values, kernel lines. */
  details: string[]
  /** What to do about a warn/fail. */
  fix?: string
}

export interface InteractiveInfo {
  available: boolean
  reason: string | null
  nodes: string[]
  buttons: string[]
  hasMotion: boolean
  hasWheel: boolean
  hasHWheel: boolean
  hasTouch: boolean
  isKeyboard: boolean
}

/** A raw HID interface of the tested device that the deep test can read. */
export interface HidrawInfo {
  node: string
  name: string
  /** paired = a device connected through a receiver (e.g. the mouse); receiver = the receiver's own interface. */
  role: 'paired' | 'receiver' | 'device'
  /** Plain-language description of what this part is. */
  description: string
  /** The descriptor has button/X/Y fields (a pointing device). */
  pointer: boolean
  /** The device speaks Logitech HID++ (can be queried for battery, firmware, DPI). */
  hidpp: boolean
}

export interface DeepFinding {
  status: CheckStatus
  title: string
  detail: string
}

export interface DeepReport {
  node: string
  name: string
  seconds: number
  hidpp: { answered: boolean; protocol?: string; name?: string; firmware?: string[]; battery?: { percent: number; levelBits?: number; status: number }; voltage_mV?: number; dpi?: number } | null
  reports: number
  pointerReports: number
  motionReports: number
  movedX: number
  movedY: number
  buttons: number[]
  wheelReports: number
  findings: DeepFinding[]
  /** First decoded pointer reports, as evidence. */
  samples: string[]
  /** Presses seen per button (only buttons that were pressed). */
  presses: { button: number; name: string; presses: number }[]
  /** Activity per second of the capture. */
  timeline: { second: number; reports: number; motion: number; presses: number }[]
  /** Largest single movement report (|x| + |y|). */
  maxStep: number
  evidence: { ms: number; buttons: string; x: number; y: number; wheel: number }[]
}

export type DeepPhase = 'auth' | 'querying' | 'capturing' | 'analysing' | 'done' | 'error'

export interface DeepProgress {
  sessionId: string
  phase: DeepPhase
  seconds: number
  /** Seconds of capture left (capturing phase only). */
  secondsLeft: number | null
  live: { reports: number; pointerReports: number; motionReports: number; buttons: string[]; wheelReports: number }
  result: DeepReport | null
  error: string | null
}

/** One step in a device's connection map (controller → hub → device → interfaces → inputs). */
export interface PathNode {
  kind: 'pci-root' | 'pci' | 'usb-root' | 'usb' | 'usb-interface' | 'hid' | 'input' | 'serio' | 'i2c' | 'storage' | 'bluetooth' | 'camera' | 'battery' | 'network' | 'other'
  title: string
  sysfs: string
  details: [string, string][]
  children: PathNode[]
  /** The device that was tested. */
  target?: boolean
}

export interface TestReport {
  target: TestTarget
  ranAt: string
  checks: CheckResult[]
  verdict: { status: CheckStatus; headline: string }
  interactive: InteractiveInfo
  /** Where the device sits in the system, with details of every step. */
  map: PathNode | null
  hid: HidrawInfo[]
  /** Whether the deep hardware test can run: it needs the optional, user-installed privileged helper. */
  deepHelper: { usable: boolean; reason: string | null; installCommand: string }
}

export interface ButtonStats {
  name: string
  presses: number
  /** Presses that followed a release by less than the chatter threshold (a switch bouncing). */
  chatter: number
  down: boolean
  /** How long it has been held, when down (ms). */
  heldMs: number
}

export interface LiveState {
  sessionId: string
  running: boolean
  /** Why it stopped (time limit, device gone, stopped by user). */
  stoppedReason: string | null
  elapsedMs: number
  limitMs: number
  events: number
  dropped: number
  motion: { left: number; right: number; up: number; down: number; events: number }
  wheel: { up: number; down: number; left: number; right: number }
  buttons: ButtonStats[]
  touch: { touches: number; maxFingers: number; travel: number }
  /** Keyboard: distinct key names pressed, most recent last. Never stored. */
  keys: string[]
  keyPresses: number
  /** Main-block keys not pressed yet (keyboards only). */
  untried: string[]
  stuck: string[]
  /** Median interval between motion reports while moving, as a rate. */
  reportRateHz: number | null
  /** Longest pause between motion reports during continuous movement (ms). */
  maxMotionGapMs: number | null
  still: { phase: 'idle' | 'running' | 'done'; motion: number; events: number }
  errors: string[]
}

export interface DeviceControlItem {
  id: string
  kind: 'input' | 'radio'
  label: string
  role: string
  enabled: boolean
  controllable: boolean
  reason: string | null
  method: string
}
