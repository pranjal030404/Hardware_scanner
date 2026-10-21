import { promises as fs } from 'node:fs'
import { join, posix } from 'node:path'

const PERMISSION_CODES = new Set(['EACCES', 'EPERM'])

/**
 * Read-only access to a sysfs/procfs-like tree below `root` (default `/`). Collectors never touch
 * the filesystem directly, which keeps them testable against fixture trees and lets us track
 * permission-denied paths so a failed read is never mistaken for "no device".
 */
export class SysReader {
  readonly denied = new Set<string>()

  constructor(readonly root = '/') {}

  get isHost(): boolean {
    return this.root === '/'
  }

  private abs(p: string): string {
    return join(this.root, p)
  }

  private note(e: unknown, p: string): void {
    const code = (e as NodeJS.ErrnoException)?.code
    if (code && PERMISSION_CODES.has(code)) this.denied.add(p)
  }

  /** Trimmed UTF-8 text, or undefined when missing/unreadable (permission failures are recorded). */
  async text(p: string): Promise<string | undefined> {
    try {
      return (await fs.readFile(this.abs(p), 'utf8')).replace(/\0+$/, '').trim()
    } catch (e) {
      this.note(e, p)
      return undefined
    }
  }

  async bytes(p: string): Promise<Buffer | undefined> {
    try {
      return await fs.readFile(this.abs(p))
    } catch (e) {
      this.note(e, p)
      return undefined
    }
  }

  async num(p: string, radix = 10): Promise<number | undefined> {
    const t = await this.text(p)
    if (t === undefined || t === '') return undefined
    const n = parseInt(t, radix)
    return Number.isFinite(n) ? n : undefined
  }

  /** Directory entry names ([] when missing). */
  async dir(p: string): Promise<string[]> {
    try {
      return (await fs.readdir(this.abs(p))).sort()
    } catch (e) {
      this.note(e, p)
      return []
    }
  }

  async exists(p: string): Promise<boolean> {
    try {
      await fs.access(this.abs(p))
      return true
    } catch (e) {
      this.note(e, p)
      return false
    }
  }

  async link(p: string): Promise<string | undefined> {
    try {
      return await fs.readlink(this.abs(p))
    } catch (e) {
      this.note(e, p)
      return undefined
    }
  }

  /**
   * Resolve symlinks and return the path *relative to root* with a leading slash
   * (e.g. `/sys/devices/pci0000:00/0000:00:14.0/usb3/3-1`).
   */
  async real(p: string): Promise<string | undefined> {
    try {
      const r = await fs.realpath(this.abs(p))
      const rootReal = await fs.realpath(this.root)
      const rel = r.startsWith(rootReal) ? r.slice(rootReal.length) : r
      return posix.join('/', rel.split(/[\\/]/).join('/'))
    } catch (e) {
      this.note(e, p)
      return undefined
    }
  }

  deniedList(): string[] {
    return [...this.denied].sort()
  }
}
