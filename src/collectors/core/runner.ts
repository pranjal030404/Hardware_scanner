import { spawn } from 'node:child_process'

export interface RunOptions {
  timeoutMs?: number
  maxOutputBytes?: number
}

export interface RunResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** The executable was not found / could not be started. */
  notFound: boolean
  truncated: boolean
}

export type CommandRunner = (file: string, args: readonly string[], opts?: RunOptions) => Promise<RunResult>

/**
 * Argument-safe process execution: no shell, bounded runtime and output, process killed on
 * timeout. Only used when no direct kernel/native interface exists (e.g. smartctl, bluetoothctl).
 */
export const runCommand: CommandRunner = (file, args, opts = {}) =>
  new Promise((resolve) => {
    const timeoutMs = opts.timeoutMs ?? 5000
    const max = opts.maxOutputBytes ?? 2_000_000
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let truncated = false
    let settled = false
    const done = (r: Partial<RunResult>): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, code: null, stdout, stderr, timedOut, notFound: false, truncated, ...r })
    }
    let child
    try {
      child = spawn(file, [...args], { shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      resolve({ ok: false, code: null, stdout, stderr, timedOut, notFound: true, truncated })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    const collect = (which: 'out' | 'err') => (chunk: Buffer) => {
      if (which === 'out') {
        if (stdout.length + chunk.length > max) {
          truncated = true
          child.kill('SIGKILL')
          return
        }
        stdout += chunk.toString('utf8')
      } else if (stderr.length < 64_000) {
        stderr += chunk.toString('utf8')
      }
    }
    child.stdout.on('data', collect('out'))
    child.stderr.on('data', collect('err'))
    child.on('error', (e: NodeJS.ErrnoException) => done({ notFound: e.code === 'ENOENT' }))
    child.on('close', (code) => done({ ok: code === 0 && !timedOut && !truncated, code }))
  })
