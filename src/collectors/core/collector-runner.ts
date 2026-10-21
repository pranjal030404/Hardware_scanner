import { CollectorResultSchema, type CollectorHealth, type CollectorResult, type CollectorStatus, type Limitation } from '@shared/schemas'
import type { CollectContext } from './context'
import type { Collector } from './types'

export interface RunOutcome {
  collector: Collector
  status: CollectorStatus
  result: CollectorResult | null
  message: string | null
  durationMs: number
  startedAt: string
  limitations: Limitation[]
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout
  const timeout = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(t))
}

/**
 * Runs one collector with timeout, bounded retries and schema validation. A collector that fails
 * yields status `error` and NO result — callers must never turn that into an empty inventory.
 */
export async function runCollector(collector: Collector, ctx: CollectContext): Promise<RunOutcome> {
  const startedAt = ctx.host.now()
  const t0 = performance.now()
  const finish = (o: Omit<RunOutcome, 'collector' | 'durationMs' | 'startedAt'>): RunOutcome => ({
    collector,
    durationMs: Math.round(performance.now() - t0),
    startedAt: startedAt.toISOString(),
    ...o
  })

  if (!collector.platforms.includes(ctx.platform)) {
    return finish({ status: 'unsupported', result: null, message: `Not supported on ${ctx.platform}`, limitations: [] })
  }
  try {
    if (!(await withTimeout(collector.isSupported(ctx), collector.timeoutMs, `${collector.id}.isSupported`))) {
      return finish({
        status: 'unsupported',
        result: null,
        message: 'Required system interface is not present on this machine',
        limitations: []
      })
    }
  } catch (e) {
    return finish({ status: 'error', result: null, message: errMsg(e), limitations: [] })
  }

  let lastErr = 'unknown error'
  for (let attempt = 0; attempt <= collector.retries; attempt++) {
    // Permission failures recorded by the reader are per-attempt.
    ctx.reader.denied.clear()
    try {
      const raw = await withTimeout(collector.collect(ctx), collector.timeoutMs, collector.id)
      const parsed = CollectorResultSchema.safeParse(raw)
      if (!parsed.success) {
        lastErr = `Collector produced invalid output: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`
        // Invalid output is a bug, not a transient failure: don't retry.
        return finish({ status: 'error', result: null, message: lastErr, limitations: [] })
      }
      const result = parsed.data
      const status: CollectorStatus =
        result.outcome === 'permission_required' ? 'permission_required' : result.outcome === 'unavailable' ? 'unavailable' : 'available'
      return finish({
        status,
        result,
        message: result.message ?? (result.outcome === 'partial' ? 'Partial results; see limitations' : null),
        limitations: result.limitations
      })
    } catch (e) {
      lastErr = errMsg(e)
      if (attempt < collector.retries) await sleep(150 * (attempt + 1))
    }
  }
  return finish({ status: 'error', result: null, message: lastErr, limitations: [] })
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function healthFromOutcome(o: RunOutcome, previousSuccessAt: string | null): CollectorHealth {
  const ok = o.status === 'available'
  return {
    id: o.collector.id,
    version: o.collector.version,
    platforms: [...o.collector.platforms],
    categories: [...o.collector.categories],
    permissions: [...o.collector.permissions],
    method: o.collector.method,
    status: o.status,
    partial: o.result?.outcome === 'partial',
    message: o.message,
    lastRunAt: o.startedAt,
    lastSuccessAt: ok ? o.startedAt : previousSuccessAt,
    durationMs: o.durationMs,
    deviceCount: o.result ? o.result.observations.length : null,
    limitations: o.limitations
  }
}
