import type { CommandRunner, RunResult } from '@collectors/core/runner'

/**
 * Small, fixed PowerShell helpers shared by the Windows features. Scripts are never built from free
 * text: values are single-quote-escaped, and commands are passed without a shell.
 */

export const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`

export const runPowerShell = (run: CommandRunner, script: string, timeoutMs = 15_000): Promise<RunResult> =>
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='SilentlyContinue'; ${script}`], { timeoutMs })

/** True when this process can change system settings directly; otherwise a UAC prompt is raised. */
export async function isAdministrator(run: CommandRunner): Promise<boolean> {
  const r = await runPowerShell(run, '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)')
  return r.ok && r.stdout.trim().toLowerCase() === 'true'
}

export interface ElevatedResult { ok: boolean; error: string | null; cancelled: boolean }

const elevatedWrapper = (inner: string): string => {
  const b64 = Buffer.from(inner, 'utf16le').toString('base64')
  return `try { $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-NonInteractive','-EncodedCommand',${psQuote(b64)}) -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`
}

/**
 * Runs a fixed PowerShell script with administrator rights. When the app is not already elevated this
 * raises the normal Windows UAC prompt (the equivalent of the polkit prompt on Linux). A declined
 * prompt is reported separately from a command that ran and failed.
 */
export async function runElevatedPowerShell(run: CommandRunner, script: string, timeoutMs = 120_000): Promise<ElevatedResult> {
  const inner = `$ErrorActionPreference='Stop'; try { ${script}; exit 0 } catch { exit 1 }`
  if (await isAdministrator(run)) {
    const r = await runPowerShell(run, inner, timeoutMs)
    return r.ok ? { ok: true, error: null, cancelled: false } : { ok: false, error: r.stderr.trim() || `exit ${r.code}`, cancelled: false }
  }
  const r = await runPowerShell(run, elevatedWrapper(inner), timeoutMs)
  if (r.ok) return { ok: true, error: null, cancelled: false }
  const message = r.stderr.trim()
  if (/cancel|denied|rejected/i.test(message)) return { ok: false, error: 'Cancelled: the administrator permission prompt was closed, so nothing was changed.', cancelled: true }
  return { ok: false, error: message || `the elevated command failed (exit ${r.code})`, cancelled: false }
}
