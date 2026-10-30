import { Worker } from 'node:worker_threads'
import type { PerfLive, TestMode, TestProgress, TestSample, TestSession, TestStatus, TestSummary } from './types'
import type { PerfLock } from './transactions'

export interface TestStore {
  startTest(s: Omit<TestSession, 'id' | 'finishedAt' | 'summary' | 'error' | 'status'>): number
  finishTest(id: number, status: TestStatus, summary: TestSummary, samples: TestSample[], error: string | null, at: string): void
}

/** A running workload: reports how many bytes it has hashed so far; stop() ends it. */
export interface Workload {
  bytes(): number
  stop(): Promise<void>
}
export type WorkloadFactory = (threads: number, onError: (e: Error) => void) => Workload

/**
 * The benchmark: every thread hashes a 1 MiB buffer with SHA-256 in a loop, yielding every ~50 ms so
 * it can be stopped. It is a real, repeatable CPU workload; its score is what was measured here.
 */
const WORKER = `
const { parentPort } = require('node:worker_threads')
const { createHash } = require('node:crypto')
const buf = Buffer.alloc(1 << 20, 7)
let bytes = 0, stop = false
parentPort.on('message', (m) => { if (m === 'stop') stop = true })
const chunk = () => {
  const end = Date.now() + 50
  while (Date.now() < end) { createHash('sha256').update(buf).digest(); bytes += buf.length }
  parentPort.postMessage(bytes)
  if (!stop) setImmediate(chunk)
}
chunk()
`

export const hashWorkload: WorkloadFactory = (threads, onError) => {
  const counts = new Array<number>(threads).fill(0)
  const workers = Array.from({ length: threads }, (_, i) => {
    const w = new Worker(WORKER, { eval: true })
    w.on('message', (b: number) => { counts[i] = b })
    w.on('error', onError)
    return w
  })
  return {
    bytes: () => counts.reduce((a, b) => a + b, 0),
    stop: async () => { await Promise.all(workers.map((w) => w.terminate())) }
  }
}

export interface StabilityDeps {
  live: () => Promise<PerfLive>
  store: TestStore
  lock: PerfLock
  threads: number
  fingerprint: () => Promise<string>
  /** Latest tuning transaction and matching profile, recorded with the session for before/after comparison. */
  context: () => Promise<{ txId: number | null; profile: string | null }>
  workload?: WorkloadFactory
  now?: () => number
  maxSamples?: number
}

interface Running {
  session: TestSession
  started: number
  samples: TestSample[]
  workload: Workload | null
  timer: NodeJS.Timeout
  lastBytes: number
  lastAt: number
  throttleStart: number | null
  done: Promise<void>
  finish: (status: TestStatus, error: string | null) => Promise<void>
}

const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

export function summarise(mode: TestMode, samples: TestSample[], totalBytes: number, seconds: number, limit: number | null, throttleStart: number | null): TestSummary {
  const mhz = samples.map((s) => s.cpuMHz).filter((x): x is number => x !== null)
  const temps = samples.map((s) => s.temperatureC).filter((x): x is number => x !== null)
  const thr = samples.map((s) => s.throttleEvents).filter((x): x is number => x !== null)
  const tp = samples.map((s) => s.throughput).filter((x): x is number => x !== null)
  const third = Math.floor(tp.length / 3)
  const sustained = mode === 'benchmark' && third >= 2 ? ((avg(tp.slice(-third))! - avg(tp.slice(0, third))!) / avg(tp.slice(0, third))!) * 100 : null
  const maxT = temps.length ? Math.max(...temps) : null
  const throttles = thr.length && throttleStart !== null ? thr[thr.length - 1]! - throttleStart : null
  const notes = ['This measures how this workload ran and what the hardware did meanwhile. It does not prove that the settings are stable: instability can take hours, or a different workload, to appear.']
  if (mode === 'monitor') notes.push('Monitoring only: no load was generated, so these readings reflect whatever the computer was doing.')
  if (throttles && throttles > 0) notes.push(`The CPU reported ${throttles} thermal-throttle event${throttles === 1 ? '' : 's'} during the test: it slowed itself down because of heat.`)
  if (maxT !== null && limit !== null && maxT >= limit - 5) notes.push(`The temperature reached ${maxT.toFixed(0)} °C, within 5 °C of the device's own limit (${limit.toFixed(0)} °C).`)
  if (sustained !== null && sustained < -10) notes.push(`Throughput fell ${Math.abs(sustained).toFixed(0)} % from the start to the end of the run: the hardware could not sustain its initial speed (heat or power limits).`)
  return {
    score: mode === 'benchmark' && seconds > 0 ? Math.round(totalBytes / 2 ** 20 / seconds) : null,
    avgMHz: mhz.length ? Math.round(avg(mhz)!) : null, maxMHz: mhz.length ? Math.max(...mhz) : null,
    maxTemperatureC: maxT, temperatureLimitC: limit, throttleEvents: throttles,
    sustainedChangePct: sustained === null ? null : Math.round(sustained), notes
  }
}

/** Controlled test sessions: one at a time, never while settings are being changed, cancellable, recorded. */
export class StabilityService {
  private current: Running | null = null

  constructor(private d: StabilityDeps) {}

  private now(): number { return this.d.now?.() ?? Date.now() }

  async start(mode: TestMode, durationS: number, intervalMs: number): Promise<TestProgress> {
    if (this.current && this.current.session.status === 'running') throw new Error('A test is already running.')
    this.d.lock.take('testing')
    try {
      const startedAt = this.now()
      const ctx = await this.d.context()
      const threads = mode === 'benchmark' ? Math.max(1, this.d.threads) : 0
      const base = { startedAt: new Date(startedAt).toISOString(), mode, durationS, intervalMs, threads, fingerprint: await this.d.fingerprint(), txId: ctx.txId, profile: ctx.profile }
      const id = this.d.store.startTest(base)
      const session: TestSession = { ...base, id, finishedAt: null, status: 'running', summary: summarise(mode, [], 0, 0, null, null), error: null }
      let failure: Error | null = null
      const workload = mode === 'benchmark' ? (this.d.workload ?? hashWorkload)(threads, (e) => { failure = e }) : null
      await this.d.live() // baseline for utilisation deltas
      const first = await this.d.live()
      let resolveDone!: () => void
      const run: Running = {
        session, started: startedAt, samples: [], workload, lastBytes: 0, lastAt: startedAt, throttleStart: first.throttleEvents,
        done: new Promise<void>((r) => (resolveDone = r)),
        timer: setInterval(() => void tick(), intervalMs),
        finish: async (status, error) => {
          if (run.session.status !== 'running') return
          clearInterval(run.timer)
          run.session.status = status
          const total = workload?.bytes() ?? 0
          await workload?.stop()
          const seconds = (this.now() - startedAt) / 1000
          run.session.summary = summarise(mode, run.samples, total, seconds, first.temperatureLimitC, run.throttleStart)
          run.session.error = error
          run.session.finishedAt = new Date(this.now()).toISOString()
          this.d.store.finishTest(id, status, run.session.summary, run.samples, error, run.session.finishedAt)
          this.d.lock.release()
          resolveDone()
        }
      }
      const max = this.d.maxSamples ?? 3600
      const tick = async (): Promise<void> => {
        if (run.session.status !== 'running') return
        const t = this.now()
        if (failure) return run.finish('failed', `The workload stopped with an error: ${(failure as Error).message}`)
        try {
          const l = await this.d.live()
          const b = workload?.bytes() ?? 0
          const dt = (t - run.lastAt) / 1000
          const tp = workload && dt > 0 ? Math.round((b - run.lastBytes) / 2 ** 20 / dt) : null
          run.lastBytes = b
          run.lastAt = t
          if (run.samples.length < max) run.samples.push({ tMs: t - startedAt, cpuMHz: l.cpuMHz, temperatureC: l.temperatureC, utilization: l.cpuUtilization, throttleEvents: l.throttleEvents, gpuMHz: l.gpuMHz, throughput: tp })
        } catch (e) {
          return run.finish('failed', `Telemetry failed: ${(e as Error).message}`)
        }
        if (t - startedAt >= durationS * 1000) await run.finish('completed', null)
      }
      this.current = run
      return this.progress()!
    } catch (e) {
      this.d.lock.release()
      throw e
    }
  }

  progress(): TestProgress | null {
    const c = this.current
    if (!c) return null
    return { session: { ...c.session }, elapsedMs: (c.session.finishedAt ? Date.parse(c.session.finishedAt) : this.now()) - c.started, samples: [...c.samples] }
  }

  async cancel(): Promise<TestProgress | null> {
    const c = this.current
    if (c && c.session.status === 'running') await c.finish('cancelled', 'Stopped by the user')
    return this.progress()
  }

  /** Waits for the running session to end (tests and shutdown). */
  async settled(): Promise<void> { await this.current?.done }
}
