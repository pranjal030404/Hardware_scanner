import type { CollectContext } from '../core/context'

/** Normalise PowerShell's "one object → object, many → array, none → empty" JSON behaviour. */
export function asArray<T>(v: unknown): T[] {
  if (v === null || v === undefined || v === '') return []
  return Array.isArray(v) ? (v as T[]) : [v as T]
}

export type PsResult<T> = { ok: true; data: T[] } | { ok: false; kind: 'missing_tool' | 'timeout' | 'error' | 'malformed'; message: string }

/**
 * Run a *constant* PowerShell script (never built from external input) and parse its JSON output.
 * Scripts must end with `| ConvertTo-Json -Depth 4 -Compress`.
 */
export async function runPsJson<T>(ctx: CollectContext, script: string, timeoutMs: number): Promise<PsResult<T>> {
  const res = await ctx.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; ${script}`], {
    timeoutMs,
    maxOutputBytes: 20_000_000
  })
  if (res.notFound) return { ok: false, kind: 'missing_tool', message: 'powershell.exe was not found' }
  if (res.timedOut) return { ok: false, kind: 'timeout', message: `PowerShell query timed out after ${timeoutMs}ms` }
  if (!res.ok) return { ok: false, kind: 'error', message: res.stderr.trim().slice(0, 300) || `PowerShell exited with code ${res.code}` }
  const text = res.stdout.trim()
  if (!text) return { ok: true, data: [] }
  try {
    return { ok: true, data: asArray<T>(JSON.parse(text)) }
  } catch {
    return { ok: false, kind: 'malformed', message: 'PowerShell returned output that is not valid JSON' }
  }
}
