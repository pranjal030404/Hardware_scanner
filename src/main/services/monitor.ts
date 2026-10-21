import { spawn, type ChildProcess } from 'node:child_process'
import type { MonitorStatus } from '@shared/schemas'
import type { EventBus } from './event-bus'
import type { InventoryService } from './inventory'

export interface UdevEvent {
  action: string
  devpath: string
  subsystem: string
}

/** Parse a line of `udevadm monitor --udev` output. */
export function parseUdevLine(line: string): UdevEvent | undefined {
  const m = /^UDEV\s+\[[\d.]+\]\s+(\w+)\s+(\S+)\s+\((\w+)\)\s*$/.exec(line.trim())
  return m ? { action: m[1]!, devpath: m[2]!, subsystem: m[3]! } : undefined
}

export const UDEV_SUBSYSTEMS = ['usb', 'block', 'net', 'input', 'bluetooth', 'drm', 'sound', 'tty', 'video4linux', 'pci']

export interface Watcher {
  stop(): void
}
export type WatcherFactory = (onEvent: (e: UdevEvent) => void, onExit: (reason: string) => void) => Watcher | null

export const udevWatcherFactory: WatcherFactory = (onEvent, onExit) => {
  let child: ChildProcess
  try {
    child = spawn('udevadm', ['monitor', '--udev', ...UDEV_SUBSYSTEMS.flatMap((s) => ['--subsystem-match', s])], { stdio: ['ignore', 'pipe', 'ignore'], shell: false })
  } catch {
    return null
  }
  let buf = ''
  child.stdout?.on('data', (d: Buffer) => {
    buf += d.toString('utf8')
    if (buf.length > 1_000_000) buf = ''
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const ev = parseUdevLine(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (ev) onEvent(ev)
    }
  })
  child.on('error', (e) => onExit(`udevadm could not be started: ${e.message}`))
  child.on('exit', (code) => onExit(`udevadm exited (${code})`))
  return { stop: () => child.kill('SIGTERM') }
}

export interface MonitorOptions {
  intervalSec: number
  debounceMs?: number
  /** Minimum gap between two rescans no matter how many events arrive. */
  minGapMs?: number
}

/**
 * Keeps the inventory current: OS-native notifications (udev) trigger debounced rescans, and a
 * timer rescans periodically as a safety net for missed events and for volatile readings. When
 * udev is unavailable the monitor degrades to polling and says so.
 */
export class MonitorService {
  private watcher: Watcher | null = null
  private timer: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  private paused = false
  private stopped = true
  private restarts = 0
  private lastScanAt: string | null = null
  private lastScanMs = 0
  private mode: MonitorStatus['mode'] = 'stopped'
  private degraded = false
  private message: string | null = null
  private intervalSec: number

  constructor(
    private inv: InventoryService,
    private bus: EventBus,
    private opts: MonitorOptions,
    private factory: WatcherFactory | null
  ) {
    this.intervalSec = opts.intervalSec
  }

  status(): MonitorStatus {
    return { mode: this.mode, degraded: this.degraded, message: this.message, intervalSec: this.intervalSec, lastScanAt: this.lastScanAt, scanning: this.inv.scanning }
  }

  private emit(): void {
    this.bus.publish({ type: 'monitor.status_changed', summary: `Monitoring ${this.mode}${this.degraded ? ' (degraded)' : ''}`, data: { ...this.status() } })
  }

  start(): void {
    this.stopped = false
    this.paused = false
    this.startWatcher()
    this.schedule()
    void this.scanNow()
  }

  private startWatcher(): void {
    this.watcher?.stop()
    this.watcher = null
    if (!this.factory) {
      this.mode = 'polling'
      this.degraded = true
      this.message = 'Native hardware notifications are not available on this platform yet; polling only.'
      return this.emit()
    }
    const w = this.factory(
      (e) => this.onUdev(e),
      (reason) => this.onWatcherExit(reason)
    )
    if (!w) {
      this.mode = 'polling'
      this.degraded = true
      this.message = 'Could not start udev monitor; falling back to polling.'
    } else {
      this.watcher = w
      this.mode = 'udev'
      this.degraded = false
      this.message = null
    }
    this.emit()
  }

  private onWatcherExit(reason: string): void {
    if (this.stopped || this.paused) return
    this.watcher = null
    if (this.restarts < 5) {
      this.restarts++
      this.mode = 'polling'
      this.degraded = true
      this.message = `${reason}; restarting (attempt ${this.restarts}/5), polling meanwhile.`
      this.emit()
      setTimeout(() => !this.stopped && !this.paused && this.startWatcher(), 2000 * this.restarts)
    } else {
      this.mode = 'polling'
      this.degraded = true
      this.message = `${reason}; giving up on native notifications, polling every ${this.intervalSec}s.`
      this.emit()
    }
  }

  private onUdev(e: UdevEvent): void {
    this.restarts = 0
    if (this.paused || this.stopped) return
    void e
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => void this.scanNow(), this.opts.debounceMs ?? 1500)
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => {
      if (!this.paused) void this.scanNow()
    }, this.intervalSec * 1000)
    this.timer.unref?.()
  }

  setInterval(sec: number): void {
    this.intervalSec = sec
    if (!this.stopped) this.schedule()
    this.emit()
  }

  async scanNow(): Promise<void> {
    const gap = this.opts.minGapMs ?? 2000
    if (Date.now() - this.lastScanMs < gap) return
    this.lastScanMs = Date.now()
    try {
      await this.inv.scan()
      this.lastScanAt = new Date().toISOString()
    } catch (e) {
      this.degraded = true
      this.message = `Scan failed: ${(e as Error).message}`
      this.emit()
    }
  }

  setPaused(p: boolean): MonitorStatus {
    this.paused = p
    if (p) {
      this.watcher?.stop()
      this.watcher = null
      this.mode = 'paused'
      this.degraded = false
      this.message = 'Live monitoring paused by user'
      this.emit()
    } else if (!this.stopped) {
      this.startWatcher()
      void this.scanNow()
    }
    return this.status()
  }

  stop(): void {
    this.stopped = true
    this.watcher?.stop()
    this.watcher = null
    if (this.timer) clearInterval(this.timer)
    if (this.debounce) clearTimeout(this.debounce)
    this.mode = 'stopped'
  }
}
