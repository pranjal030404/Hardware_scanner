import type { EvidenceRef } from '@shared/schemas'
import type { DiagnosticRule, RuleFinding, RuleResult } from './types'

const DAY = 86_400_000

/** Tuning is switched on, but writable controls cannot be used because the privileged helper is missing or not the reviewed version. */
const permissionRequired: DiagnosticRule = {
  id: 'performance.permission_required', version: 1, title: 'Tuning controls need the privileged helper', category: 'performance',
  description: 'Reports when tuning controls are switched on in Settings but the optional privileged helper is not installed or does not match this version. This is a setup step, not a hardware fault.',
  severityPolicy: 'Always info: monitoring keeps working without the helper.',
  dataUsed: 'Settings → tuning controls switch; the installed helper check (owner, permissions, contents, polkit policy).',
  evaluate(ctx): RuleResult {
    const p = ctx.performance
    if (!p) return { status: 'insufficient_data', reason: 'Performance tuning is not available on this platform' }
    if (!p.tuningEnabled || p.helperUsable) return { status: 'evaluated', findings: [] }
    return {
      status: 'evaluated',
      findings: [{
        subject: 'perf-helper', severity: 'info', title: 'Tuning controls are read-only until the helper is installed', deviceIds: [],
        description: p.helperReason ?? 'The privileged helper is not available.',
        evidence: [{ type: 'setting', ref: 'perfTuningEnabled', value: true, observedAt: ctx.now.toISOString(), note: p.helperReason ?? undefined }],
        recommendation: 'Install it yourself with `sudo sh resources/linux/install.sh` (docs/PERFORMANCE.md), or switch tuning controls off in Settings. Nothing is changed by the application.'
      }]
    }
  }
}

/** The last change was applied but the kernel reports different values than requested. */
const verificationFailed: DiagnosticRule = {
  id: 'performance.control_verification_failed', version: 1, title: 'A tuning change did not take effect as requested', category: 'performance',
  description: 'After every tuning change the application reads each setting back from the kernel. This reports settings whose read-back value differs from what was requested (for example a value the driver clamped, or one that tuned or firmware overrode).',
  severityPolicy: 'Some settings confirmed and some not → low; none confirmed → medium.',
  dataUsed: 'The most recent tuning transaction and its per-setting read-back results.',
  evaluate(ctx): RuleResult {
    const tx = ctx.performance?.lastTx
    if (!ctx.performance) return { status: 'insufficient_data', reason: 'Performance tuning is not available on this platform' }
    if (!tx || (tx.status !== 'mismatch' && tx.status !== 'partially_verified')) return { status: 'evaluated', findings: [] }
    const bad = tx.items.filter((i) => i.verification === 'mismatch')
    if (!bad.length) return { status: 'evaluated', findings: [] }
    const evidence: EvidenceRef[] = bad.map((i) => ({ type: 'tuning_transaction', ref: String(tx.id), key: i.controlId, value: i.effective, observedAt: tx.finishedAt ?? tx.startedAt, note: `requested ${i.requested}, read back ${i.effective ?? 'unknown'}` }))
    return {
      status: 'evaluated',
      findings: [{
        subject: `tx:${tx.id}`, severity: tx.status === 'mismatch' ? 'medium' : 'low', deviceIds: [],
        title: `${bad.length} setting${bad.length === 1 ? '' : 's'} from “${tx.label}” did not stick`,
        description: bad.map((i) => `${i.label}: requested ${i.requested}, the kernel reports ${i.effective ?? 'unknown'}`).join('; ') + '.',
        evidence,
        recommendation: 'Undo the change on the Performance Tuning page if it is not wanted. A driver may round values, and tuned or the firmware can override settings; check `tuned-adm active` if a tuned profile is in use.'
      }]
    }
  }
}

/** A failed change could not be fully put back. */
const notRestored: DiagnosticRule = {
  id: 'performance.configuration_not_restored', version: 1, title: 'Settings could not be restored after a failed change', category: 'performance',
  description: 'When a tuning change fails part-way, the application puts back every setting that had already changed and reads it back. This reports settings that could not be confirmed as restored.',
  severityPolicy: 'Always medium: the system may be running with settings nobody chose.',
  dataUsed: 'Tuning transactions whose rollback was not verified, within the history retention period.',
  evaluate(ctx): RuleResult {
    const p = ctx.performance
    if (!p) return { status: 'insufficient_data', reason: 'Performance tuning is not available on this platform' }
    const findings: RuleFinding[] = p.failedRollbacks.map((tx) => {
      const bad = tx.items.filter((i) => i.verification === 'rollback_failed')
      return {
        subject: `rollback:${tx.id}`, severity: 'medium', deviceIds: [],
        title: `“${tx.label}” left ${bad.length} setting${bad.length === 1 ? '' : 's'} changed`,
        description: bad.map((i) => i.message ?? i.label).join(' '),
        evidence: bad.map((i) => ({ type: 'tuning_transaction', ref: String(tx.id), key: i.controlId, value: i.effective, observedAt: tx.finishedAt ?? tx.startedAt, note: `was ${i.previous ?? 'unknown'}` })),
        recommendation: 'Use “Restore original settings” or “Restore stock” on the Performance Tuning page. sysfs values reset on reboot, but a tuned profile does not, so do not rely on a restart alone.'
      }
    })
    return { status: 'evaluated', findings }
  }
}

/** The last test session ended in an error. */
const testFailed: DiagnosticRule = {
  id: 'performance.test_failed', version: 1, title: 'A performance test did not complete', category: 'performance',
  description: 'Reports when the most recent performance test session ended with an error (the workload or telemetry failed, or the application stopped during it). A test stopped by the user is not a failure.',
  severityPolicy: 'Low: investigate if it repeats.',
  dataUsed: 'The most recent performance test session.',
  evaluate(ctx): RuleResult {
    const t = ctx.performance?.lastTest
    if (!ctx.performance) return { status: 'insufficient_data', reason: 'Performance tuning is not available on this platform' }
    if (!t || t.status !== 'failed' || ctx.now.getTime() - Date.parse(t.startedAt) > 7 * DAY) return { status: 'evaluated', findings: [] }
    return {
      status: 'evaluated',
      findings: [{
        subject: `test:${t.id}`, severity: 'low', deviceIds: [], title: 'The last performance test did not complete', description: t.error ?? 'The test ended with an error.',
        evidence: [{ type: 'test_session', ref: String(t.id), key: 'status', value: t.status, observedAt: t.finishedAt ?? t.startedAt, note: t.error ?? undefined }],
        recommendation: 'Run the test again. If it fails with the current tuning but not with Stock settings, the tuning may be unstable: restore stock settings.'
      }]
    }
  }
}

/** During a recent test, the CPU came close to the limit the device itself reports. */
const thermalLimit: DiagnosticRule = {
  id: 'performance.thermal_limit_approaching', version: 1, title: 'CPU came close to its own temperature limit under test', category: 'performance',
  description: 'Compares the highest CPU temperature measured during the most recent test session (last 24 h) with the critical limit the sensor itself reports. No universal threshold is used: without a reported limit nothing is concluded. Ongoing throttling is reported by the cpu.thermal_throttle rule.',
  severityPolicy: 'Within the configured margin (Settings → temperature warning margin) → medium; at or above the limit → high.',
  dataUsed: 'Maximum temperature and the sensor-reported limit recorded in the latest test session.',
  evaluate(ctx): RuleResult {
    const t = ctx.performance?.lastTest
    if (!ctx.performance) return { status: 'insufficient_data', reason: 'Performance tuning is not available on this platform' }
    if (!t || ctx.now.getTime() - Date.parse(t.startedAt) > DAY) return { status: 'evaluated', findings: [] }
    const max = t.summary.maxTemperatureC
    const limit = t.summary.temperatureLimitC
    if (max === null || limit === null) return { status: 'evaluated', findings: [] }
    if (max < limit - ctx.settings.diagTempMarginC) return { status: 'evaluated', findings: [] }
    return {
      status: 'evaluated',
      findings: [{
        subject: `test:${t.id}`, severity: max >= limit ? 'high' : 'medium', deviceIds: [],
        title: `CPU reached ${max.toFixed(0)} °C in a test (its limit is ${limit.toFixed(0)} °C)`,
        description: `During the ${t.mode} test at ${t.startedAt}${t.profile ? ` with the ${t.profile} profile in effect` : ''}, the CPU came within ${Math.max(0, limit - max).toFixed(0)} °C of the critical limit its sensor reports.`,
        evidence: [{ type: 'test_session', ref: String(t.id), key: 'maxTemperatureC', value: max, unit: '°C', observedAt: t.finishedAt ?? t.startedAt, note: `sensor-reported limit ${limit} °C` }],
        recommendation: 'Lower raised power limits (Restore stock), clean vents and fans, and avoid soft surfaces. The CPU protects itself by slowing down, but sustained operation at its limit shortens battery and component life.'
      }]
    }
  }
}

export const PERFORMANCE_RULES: DiagnosticRule[] = [permissionRequired, verificationFailed, notRestored, testFailed, thermalLimit]
