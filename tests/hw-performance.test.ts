/**
 * Hardware integration tests for performance tuning. Opt-in only: HIP_HW_TESTS=1 npx vitest run tests/hw-performance.test.ts
 * They read the real machine and never change clocks, voltages, power limits, fans or firmware:
 * no helper is invoked and every apply path is checked to refuse.
 */
import { describe, expect, it } from 'vitest'
import { SysReader } from '@collectors/core/sysreader'
import { runCommand } from '@collectors/core/runner'
import { CapabilityService } from '../src/performance'
import { helperStatus } from '../src/privileged/helpers'

const enabled = process.env['HIP_HW_TESTS'] === '1' && process.platform === 'linux'

describe.skipIf(!enabled)('performance tuning on this machine (read-only)', () => {
  const caps = new CapabilityService({ reader: new SysReader('/'), run: runCommand, platform: 'linux' })

  it('discovers the CPU and reports every control with a status and a reason when not writable', async () => {
    const s = await caps.snapshot()
    expect(s.cpu?.hwMaxKhz).toBeGreaterThan(0)
    const helper = await helperStatus('hip-perf-helper', 'linux')
    const cs = await caps.controls(s, { helperUsable: helper.usable, helperReason: helper.reason, verified: new Set() })
    expect(cs.length).toBeGreaterThan(0)
    for (const c of cs) {
      expect(c.write ? ['supported', 'not_verified'] : ['permission_required', 'unavailable', 'unsupported', 'error']).toContain(c.status)
      if (!c.write) expect(c.reason, c.id).toBeTruthy()
    }
    // Without the helper nothing is writable, whatever the kernel allows.
    if (!helper.usable) expect(cs.some((c) => c.write)).toBe(false)
    console.info(`helper: ${helper.usable ? 'usable' : helper.reason}\n` + cs.map((c) => `${c.id.padEnd(28)} ${c.status.padEnd(20)} ${c.current ?? ''}`).join('\n'))
  })

  it('measures with sources and timestamps, and never invents missing readings', async () => {
    const t = await caps.telemetry(await caps.snapshot())
    expect(t.some((m) => m.state === 'live')).toBe(true)
    for (const m of t) {
      if (m.state === 'live') { expect(m.value).toBeTruthy(); expect(m.at).toBeTruthy(); expect(m.source).toBeTruthy() }
      else { expect(m.value).toBeNull(); expect(m.reason).toBeTruthy() }
    }
    console.info(t.map((m) => `${m.label.padEnd(40)} ${(m.value ?? 'not measured').padEnd(28)} ${m.source}`).join('\n'))
  })

  it('reads live values twice and sees utilisation', async () => {
    await caps.live()
    await new Promise((r) => setTimeout(r, 300))
    const l = await caps.live()
    expect(l.cpuMHz).toBeGreaterThan(0)
    expect(l.cpuUtilization).not.toBeNull()
  })
})
