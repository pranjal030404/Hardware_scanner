/**
 * Evidence-based rules over live metric history and counters: resource pressure (kernel PSI), swap
 * thrashing, thermal-throttle events and ECC error counters. None of them judges a single sample:
 * pressure/thrash need most of a configurable window, throttle events need an actual counter increase,
 * and a missing or stale series yields "insufficient data" / "retain", never a pass or a failure.
 */
import type { EvidenceRef, Severity } from '@shared/schemas'
import type { StoredDevice } from '@shared/stored'
import { isFresh, type DiagnosticRule, type MetricWindow, type RuleContext, type RuleFinding, type RuleResult } from './types'

const MIN_POINTS = 6
const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
const iso = (t: number): string => new Date(t).toISOString()

export interface SustainedStats { n: number; coverageMs: number; fractionAbove: number; median: number; max: number }

/** Statistics of a series against a threshold. Returns undefined when there are too few samples to say anything. */
export function sustainedStats(points: { t: number; v: number }[], threshold: number): SustainedStats | undefined {
  if (points.length < MIN_POINTS) return undefined
  const vs = points.map((p) => p.v)
  return {
    n: points.length,
    coverageMs: points[points.length - 1]!.t - points[0]!.t,
    fractionAbove: vs.filter((v) => v >= threshold).length / vs.length,
    median: median(vs),
    max: Math.max(...vs)
  }
}

interface SustainedSpec {
  id: string
  title: string
  category: 'monitoring' | 'thermal' | 'storage' | 'device'
  description: string
  severityPolicy: string
  metric: string
  threshold: (ctx: RuleContext) => number
  unit: string
  subjectLabel: string
  explain: (name: string, thr: number, st: SustainedStats, minutes: number) => string
  recommendation: string
}

function sustainedRule(spec: SustainedSpec): DiagnosticRule {
  return {
    id: spec.id,
    version: 1,
    title: spec.title,
    category: spec.category,
    description: spec.description,
    severityPolicy: spec.severityPolicy,
    dataUsed: `Metric history of ${spec.metric} over the configured window (sampler must be running).`,
    evaluate(ctx): RuleResult {
      if (!ctx.metricWindow || !ctx.metrics) return { status: 'insufficient_data', reason: 'Metric history is not available' }
      if (!ctx.metrics.enabled || !ctx.metrics.running) return { status: 'insufficient_data', reason: 'Metric sampling is off or not running' }
      const windowMs = ctx.settings.diagPressureWindowMin * 60_000
      const series = ctx.metricWindow(spec.metric, windowMs)
      if (!series.length) return { status: 'insufficient_data', reason: `No ${spec.metric} series has been recorded (interface not exposed by this kernel/OS, or sampling just started)` }
      const thr = spec.threshold(ctx)
      const findings: RuleFinding[] = []
      const retain: string[] = []
      for (const s of series) {
        const subject = `device:${s.deviceId}`
        const pts = s.points.filter((p) => p.t >= ctx.now.getTime() - windowMs)
        const st = s.stale ? undefined : sustainedStats(pts, thr)
        // Not enough fresh data to judge: leave any existing finding as it is rather than resolving or raising it.
        if (!st || st.coverageMs < windowMs * 0.8) { retain.push(subject); continue }
        const minutes = Math.round(st.coverageMs / 60_000)
        if (st.fractionAbove >= 0.8 && st.median >= thr) {
          const sev: Severity = st.median >= thr * 2 ? 'medium' : 'low'
          const first = pts[0]!
          const last = pts[pts.length - 1]!
          const ev: EvidenceRef[] = [
            { type: 'metric_sample', ref: s.deviceId, key: s.metric, value: Math.round(st.median * 100) / 100, unit: spec.unit, source: s.source, observedAt: iso(last.t), note: `median of ${st.n} samples over ${minutes} min; ${Math.round(st.fractionAbove * 100)}% of samples ≥ ${thr}${spec.unit}; max ${Math.round(st.max * 100) / 100}${spec.unit}` },
            { type: 'metric_sample', ref: s.deviceId, key: s.metric, value: Math.round(first.v * 100) / 100, unit: spec.unit, source: s.source, observedAt: iso(first.t), note: 'first sample in window' },
            { type: 'metric_sample', ref: s.deviceId, key: s.metric, value: Math.round(last.v * 100) / 100, unit: spec.unit, source: s.source, observedAt: iso(last.t), note: 'latest sample' },
            { type: 'setting', ref: 'diagnostics', key: 'threshold', value: thr, unit: spec.unit, observedAt: ctx.now.toISOString() }
          ]
          findings.push({
            subject, severity: sev, confidence: 0.9,
            title: `${s.deviceName}: ${spec.subjectLabel}`, description: spec.explain(s.deviceName, thr, st, minutes), deviceIds: [s.deviceId], evidence: ev,
            recommendation: spec.recommendation
          })
        } else if (st.median >= thr * 0.8) {
          retain.push(subject) // hysteresis: close to the threshold keeps an existing finding open instead of flapping
        }
      }
      return { status: 'evaluated', findings, retain }
    }
  }
}

const psi = (resource: string) =>
  `Verify: run \`cat /proc/pressure/${resource}\` (some avg10/avg60/avg300) while the symptom is present and compare with the Monitor chart; \`top\`/\`htop\` shows the tasks involved.`

export const cpuPressure = sustainedRule({
  id: 'cpu.pressure', title: 'Sustained CPU pressure', category: 'monitoring',
  description: 'Reports when, for most of the configured window, tasks were runnable but waiting for a CPU, as measured by the kernel’s pressure-stall information (PSI). It reflects contention, not merely high utilisation.',
  severityPolicy: 'median PSI ≥ threshold with ≥80% of samples above it → low; median ≥ 2× threshold → medium. Needs ≥6 samples covering ≥80% of the window; otherwise no verdict.',
  metric: 'pressure.cpu_some_avg10', threshold: (c) => c.settings.diagPressureWarnPercent, unit: '%', subjectLabel: 'sustained CPU pressure',
  explain: (_n, thr, st, min) => `At least one task was waiting for CPU time for a median of ${st.median.toFixed(1)}% of each 10-second interval across ${min} minutes (threshold ${thr}%). This indicates CPU contention, not necessarily a fault.`,
  recommendation: `Find the busy processes and decide whether the load is expected; reduce concurrent work or check for runaway tasks. ${psi('cpu')} The application changes nothing.`
})

export const memoryPressure = sustainedRule({
  id: 'memory.pressure', title: 'Sustained memory pressure', category: 'monitoring',
  description: 'Reports when tasks repeatedly stalled waiting for memory (reclaim, swap, refaults) for most of the window, from kernel PSI. Low free memory alone is normal on Linux and is not reported.',
  severityPolicy: 'median PSI ≥ threshold with ≥80% of samples above it → low; median ≥ 2× threshold → medium.',
  metric: 'pressure.memory_some_avg10', threshold: (c) => c.settings.diagPressureWarnPercent, unit: '%', subjectLabel: 'sustained memory pressure',
  explain: (_n, thr, st, min) => `Tasks stalled on memory for a median of ${st.median.toFixed(1)}% of each 10-second interval across ${min} minutes (threshold ${thr}%).`,
  recommendation: `Close memory-hungry applications or add RAM/swap capacity if this recurs. ${psi('memory')} Also compare swap activity on the Memory view.`
})

export const ioPressure = sustainedRule({
  id: 'io.pressure', title: 'Sustained I/O pressure', category: 'storage',
  description: 'Reports when tasks repeatedly stalled waiting for block I/O for most of the window (kernel PSI). It says tasks waited, not which device is at fault.',
  severityPolicy: 'median PSI ≥ threshold with ≥80% of samples above it → low; median ≥ 2× threshold → medium.',
  metric: 'pressure.io_some_avg10', threshold: (c) => c.settings.diagPressureWarnPercent, unit: '%', subjectLabel: 'sustained I/O pressure',
  explain: (_n, thr, st, min) => `Tasks stalled on I/O for a median of ${st.median.toFixed(1)}% of each 10-second interval across ${min} minutes (threshold ${thr}%).`,
  recommendation: `Check which process is reading/writing heavily (\`iotop\`, \`pidstat -d\`) and the drive's health on the Storage view. ${psi('io')}`
})

export const swapThrash = sustainedRule({
  id: 'memory.swap_thrash', title: 'Sustained swap-in activity', category: 'monitoring',
  description: 'Reports a sustained rate of pages being read back from swap, which means the working set does not fit in RAM. Swap that is merely occupied but idle is not reported.',
  severityPolicy: 'median swap-in ≥ threshold pages/s with ≥80% of samples above it → low; ≥ 2× threshold → medium.',
  metric: 'memory.swap_in_rate', threshold: (c) => c.settings.diagSwapInPagesPerSec, unit: 'pages/s', subjectLabel: 'sustained swap-in',
  explain: (_n, thr, st, min) => `Pages were read back from swap at a median of ${st.median.toFixed(0)} pages/s over ${min} minutes (threshold ${thr} pages/s).`,
  recommendation: 'Reduce memory use or add RAM. With zram swap this is CPU-cheap, so judge it together with memory pressure. Verify: `vmstat 5` (si column) or `grep pswpin /proc/vmstat` twice a few seconds apart.'
})

/** Thermal-throttle counters only ever increase while the machine runs; an increase inside the window is the evidence. */
export const thermalThrottle: DiagnosticRule = {
  id: 'cpu.thermal_throttle', version: 1, title: 'CPU thermal-throttle events', category: 'thermal',
  description: 'Reports when the CPU’s cumulative thermal-throttle counters increased inside the look-back window, i.e. the processor itself reported that it reduced performance for thermal reasons. The counter being non-zero since boot is not enough.',
  severityPolicy: 'counter increased in 1–2 sampling intervals → low; in ≥3 separate intervals → medium. A counter that decreases (reboot/reset) is discarded, not counted.',
  dataUsed: 'cpu.thermal_throttle_events metric history (sum of per-core and per-package counters from sysfs).',
  evaluate(ctx): RuleResult {
    if (!ctx.metricWindow || !ctx.metrics) return { status: 'insufficient_data', reason: 'Metric history is not available' }
    if (!ctx.metrics.enabled || !ctx.metrics.running) return { status: 'insufficient_data', reason: 'Metric sampling is off or not running' }
    const windowMs = ctx.settings.diagThrottleWindowMin * 60_000
    const series = ctx.metricWindow('cpu.thermal_throttle_events', windowMs)
    if (!series.length) return { status: 'insufficient_data', reason: 'No thermal-throttle counters are exposed on this machine (non-Intel CPU, virtual machine or unsupported kernel)' }
    const findings: RuleFinding[] = []
    for (const s of series) {
      const pts = s.points.filter((p) => p.t >= ctx.now.getTime() - windowMs)
      let total = 0
      let intervals = 0
      let firstInc: { t: number; v: number } | undefined
      let lastInc: { t: number; v: number } | undefined
      for (let i = 1; i < pts.length; i++) {
        const d = pts[i]!.v - pts[i - 1]!.v
        if (d > 0) { total += d; intervals++; firstInc ??= pts[i - 1]; lastInc = pts[i] }
      }
      if (!total || !firstInc || !lastInc) continue
      const sev: Severity = intervals >= 3 ? 'medium' : 'low'
      findings.push({
        subject: `device:${s.deviceId}`, severity: sev, confidence: 0.95,
        title: `${s.deviceName}: thermal throttling reported`,
        description: `The processor’s thermal-throttle counters rose by ${total} in ${intervals} sampling interval(s) during the last ${ctx.settings.diagThrottleWindowMin} minutes. The CPU reported that it reduced performance for thermal reasons; occasional events under heavy load are normal on compact laptops.`,
        deviceIds: [s.deviceId],
        evidence: [
          { type: 'metric_sample', ref: s.deviceId, key: s.metric, value: firstInc.v, unit: 'count', source: s.source, observedAt: iso(firstInc.t), note: 'counter before the first increase' },
          { type: 'metric_sample', ref: s.deviceId, key: s.metric, value: lastInc.v, unit: 'count', source: s.source, observedAt: iso(lastInc.t), note: 'counter at the latest increase' }
        ],
        recommendation: 'Check vents, fans and dust, avoid soft surfaces, and compare with the temperature and frequency charts. Verify: `grep . /sys/devices/system/cpu/cpu0/thermal_throttle/*_throttle_count` twice under load. Nothing is changed by the application.'
      })
    }
    return { status: 'evaluated', findings }
  }
}

const prop = (d: StoredDevice, key: string) => d.properties.find((p) => p.key === key)

/** EDAC counters exist only on platforms with an EDAC driver; absent counters are "not exposed", never "no errors". */
export const eccErrors: DiagnosticRule = {
  id: 'memory.ecc_errors', version: 1, title: 'Memory ECC errors reported', category: 'device',
  description: 'Reports correctable and uncorrectable error counts that the platform’s memory controller (EDAC) has logged since boot. If no EDAC driver is present the rule has no data and says so; it never assumes error-free memory.',
  severityPolicy: 'uncorrectable errors > 0 → high; correctable errors > 0 → medium.',
  dataUsed: 'ecc_correctable_errors / ecc_uncorrectable_errors properties of the system memory device (linux.memory).',
  evaluate(ctx): RuleResult {
    const mem = ctx.devices.find((d) => d.key === 'memory:system' && d.presence === 'present')
    const ce = prop(mem ?? ({ properties: [] } as unknown as StoredDevice), 'ecc_correctable_errors')
    const ue = prop(mem ?? ({ properties: [] } as unknown as StoredDevice), 'ecc_uncorrectable_errors')
    if (!mem || (!ce && !ue)) return { status: 'insufficient_data', reason: 'ECC/EDAC error counters are not exposed by this machine' }
    if (!isFresh((ue ?? ce)!.observedAt, ctx)) return { status: 'insufficient_data', reason: 'ECC counters are stale (no recent memory scan)' }
    const findings: RuleFinding[] = []
    const ueN = typeof ue?.value === 'number' ? ue.value : 0
    const ceN = typeof ce?.value === 'number' ? ce.value : 0
    if (ueN > 0 || ceN > 0) {
      const ev = [ue, ce].filter((x): x is NonNullable<typeof x> => !!x).map((p) => ({ type: 'device_property' as const, ref: mem.id, key: p.key, value: p.value, source: `${p.source} · ${p.sourceProperty}`, observedAt: p.observedAt }))
      findings.push({
        subject: `device:${mem.id}`, severity: ueN > 0 ? 'high' : 'medium', confidence: 1,
        title: ueN > 0 ? 'Uncorrectable memory errors reported' : 'Correctable memory errors reported',
        description: `The memory controller has logged ${ueN} uncorrectable and ${ceN} correctable error(s) since the system booted. Counters reset at reboot, so this reflects the current uptime only.`,
        deviceIds: [mem.id], evidence: ev,
        recommendation: 'Back up important data. If the count keeps rising, run a full memory test (e.g. memtest86+) and reseat or replace the affected module. Verify: `grep . /sys/devices/system/edac/mc/mc*/{ce,ue}_count`. The application changes nothing.'
      })
    }
    return { status: 'evaluated', findings }
  }
}

const pciDevices = (ctx: RuleContext): StoredDevice[] => ctx.devices.filter((d) => d.category === 'pci' && d.presence === 'present')
const num = (d: StoredDevice, key: string): number | undefined => {
  const v = prop(d, key)?.value
  return typeof v === 'number' ? v : undefined
}
const propEvidence = (d: StoredDevice, keys: string[]): EvidenceRef[] =>
  keys.flatMap((k) => {
    const p = prop(d, k)
    return p ? [{ type: 'device_property' as const, ref: d.id, key: p.key, value: p.value, source: `${p.source} · ${p.sourceProperty}`, observedAt: p.observedAt }] : []
  })

/** Correctable AER errors are routine on healthy links at low counts, so they only matter beyond this many since boot. */
const AER_CORRECTABLE_NOTICE = 100

/** PCIe Advanced Error Reporting counters. Missing files mean AER is not exposed for that device, never "no errors". */
export const pciAerErrors: DiagnosticRule = {
  id: 'pci.aer_errors', version: 1, title: 'PCIe link errors reported', category: 'device',
  description: 'Reports PCIe Advanced Error Reporting totals the kernel has counted for a device since boot. Devices without AER counters are skipped; absence is not evidence of a healthy link.',
  severityPolicy: `fatal > 0 → high; non-fatal > 0 → medium; correctable ≥ ${AER_CORRECTABLE_NOTICE} → low (small correctable counts are routine and not reported).`,
  dataUsed: 'aer_fatal_errors / aer_nonfatal_errors / aer_correctable_errors properties of PCI devices (linux.pci, /sys/bus/pci/devices/*/aer_dev_*).',
  evaluate(ctx): RuleResult {
    const withAer = pciDevices(ctx).filter((d) => prop(d, 'aer_fatal_errors') || prop(d, 'aer_nonfatal_errors') || prop(d, 'aer_correctable_errors'))
    if (withAer.length === 0) return { status: 'insufficient_data', reason: 'No PCI device exposes AER error counters (unsupported platform, or not collected yet)' }
    const fresh = withAer.filter((d) => isFresh((prop(d, 'aer_fatal_errors') ?? prop(d, 'aer_nonfatal_errors') ?? prop(d, 'aer_correctable_errors'))!.observedAt, ctx))
    if (fresh.length === 0) return { status: 'insufficient_data', reason: 'AER counters are stale (no recent PCI scan)' }
    const findings: RuleFinding[] = []
    for (const d of fresh) {
      const fatal = num(d, 'aer_fatal_errors') ?? 0
      const nonfatal = num(d, 'aer_nonfatal_errors') ?? 0
      const cor = num(d, 'aer_correctable_errors') ?? 0
      let severity: Severity | undefined
      if (fatal > 0) severity = 'high'
      else if (nonfatal > 0) severity = 'medium'
      else if (cor >= AER_CORRECTABLE_NOTICE) severity = 'low'
      if (!severity) continue
      findings.push({
        subject: `device:${d.id}`, severity, confidence: 0.9,
        title: `PCIe errors reported for ${d.name}`,
        description: `The kernel counted ${fatal} fatal, ${nonfatal} non-fatal and ${cor} correctable PCIe error(s) for this device since boot. Counters reset at reboot. Correctable errors are recovered by the link layer; they point at signal quality or a marginal slot/cable, not at data loss.`,
        deviceIds: [d.id], evidence: propEvidence(d, ['aer_fatal_errors', 'aer_nonfatal_errors', 'aer_correctable_errors']),
        recommendation: 'Reseat the card or drive, check for a BIOS/firmware update, and watch whether the counts keep rising. Verify: `grep . /sys/bus/pci/devices/<address>/aer_dev_*` and `journalctl -k | grep -i aer`. The application changes nothing.'
      })
    }
    return { status: 'evaluated', findings }
  }
}

/**
 * Link width is compared (not speed): a device that trains narrower than both its own and its upstream
 * port's capability is a real downtraining. Link *speed* is deliberately not judged, because GPUs, NVMe
 * drives and bridges legitimately drop to a lower speed when idle (ASPM / dynamic link speed).
 */
export const pciLinkWidth: DiagnosticRule = {
  id: 'pci.link_width', version: 1, title: 'PCIe link narrower than capability', category: 'device',
  description: 'Compares the negotiated PCIe link width with the smaller of the device’s and its upstream port’s maximum. Speed is not compared, since idle speed reduction is normal power management.',
  severityPolicy: 'negotiated width below both maxima → low (informational for intentional bifurcation or shared lanes).',
  dataUsed: 'link_width, max_link_width and upstream_max_link_width properties of PCI devices (linux.pci). The upstream value is read from the parent bridge’s own sysfs files.',
  evaluate(ctx): RuleResult {
    const candidates = pciDevices(ctx).filter((d) => num(d, 'link_width') !== undefined && num(d, 'max_link_width') !== undefined && num(d, 'upstream_max_link_width') !== undefined)
    if (candidates.length === 0) return { status: 'insufficient_data', reason: 'No PCI device reports both its negotiated width and the upstream port’s capability' }
    const fresh = candidates.filter((d) => isFresh(prop(d, 'link_width')!.observedAt, ctx))
    if (fresh.length === 0) return { status: 'insufficient_data', reason: 'PCIe link data is stale (no recent PCI scan)' }
    const findings: RuleFinding[] = []
    for (const d of fresh) {
      const cur = num(d, 'link_width')!
      const own = num(d, 'max_link_width')!
      const up = num(d, 'upstream_max_link_width')!
      const capable = Math.min(own, up)
      if (cur <= 0 || capable <= 0 || cur >= capable) continue
      findings.push({
        subject: `device:${d.id}`, severity: 'low', confidence: 0.7,
        title: `${d.name} runs at x${cur} but x${capable} is possible`,
        description: `Negotiated width is x${cur}; the device supports up to x${own} and its upstream port up to x${up}. This is usually a platform design choice (shared or bifurcated lanes, a narrower slot), a seating problem, or a marginal link. The sample is read from sysfs and may be taken while the link is training.`,
        deviceIds: [d.id], evidence: propEvidence(d, ['link_width', 'max_link_width', 'upstream_max_link_width']),
        recommendation: 'Check the motherboard manual for the slot’s lane allocation, then reseat the device. Verify: `cat /sys/bus/pci/devices/<address>/{current,max}_link_width`. The application changes nothing.'
      })
    }
    return { status: 'evaluated', findings }
  }
}

const USB_WINDOW_MS = 30 * 60_000
const USB_RECONNECTS = 3

/** Repeated disconnect/reconnect of one USB device. Events are the only evidence; a single replug is normal. */
export const usbReconnect: DiagnosticRule = {
  id: 'usb.reconnect', version: 1, title: 'USB device repeatedly reconnecting', category: 'device',
  description: `Counts disconnect events per USB device in the last ${USB_WINDOW_MS / 60_000} minutes. Fewer than ${USB_RECONNECTS} is treated as normal replugging.`,
  severityPolicy: `${USB_RECONNECTS}+ disconnects → low; 6+ → medium.`,
  dataUsed: 'Persisted device.disconnected events for USB devices (udev/polling event pipeline).',
  evaluate(ctx): RuleResult {
    if (!ctx.monitor) return { status: 'insufficient_data', reason: 'Device event monitoring state is unknown' }
    const since = ctx.now.getTime() - USB_WINDOW_MS
    const byDevice = new Map<string, { name: string; times: string[] }>()
    for (const e of ctx.recentEvents) {
      if (e.type !== 'device.disconnected' || e.category !== 'usb' || !e.deviceId) continue
      if (Date.parse(e.at) < since) continue
      const g = byDevice.get(e.deviceId) ?? { name: e.deviceName ?? e.deviceId, times: [] }
      g.times.push(e.at)
      byDevice.set(e.deviceId, g)
    }
    const findings: RuleFinding[] = []
    for (const [id, g] of byDevice) {
      if (g.times.length < USB_RECONNECTS) continue
      findings.push({
        subject: `device:${id}`, severity: g.times.length >= 6 ? 'medium' : 'low', confidence: 0.75,
        title: `${g.name} disconnected ${g.times.length} times in ${USB_WINDOW_MS / 60_000} minutes`,
        description: 'The device repeatedly left and rejoined the USB bus. Common causes are a loose or damaged cable, an underpowered hub or port, or power-saving suspend on the device. Intentional unplugging also produces these events, so this is a prompt to look, not a diagnosis.',
        deviceIds: [id],
        evidence: g.times.slice(0, 10).map((t) => ({ type: 'device_event' as const, ref: id, key: 'device.disconnected', value: g.name, observedAt: t })),
        recommendation: 'Try another cable or port and avoid unpowered hubs. Verify: `journalctl -k | grep -i usb` shows the disconnect reasons. The application changes nothing.'
      })
    }
    return { status: 'evaluated', findings }
  }
}

/** The kernel's NVMe controller state; anything other than `live` means the controller is not serving I/O normally. */
export const nvmeState: DiagnosticRule = {
  id: 'storage.nvme_state', version: 1, title: 'NVMe controller not in normal state', category: 'storage',
  description: 'Reads the kernel’s state for each NVMe controller (live, resetting, connecting, deleting, dead). It is the OS view of the controller, not the drive’s SMART health.',
  severityPolicy: '`dead` → high; other non-`live` states → low, since resetting/connecting are transient.',
  dataUsed: 'nvme_state property of NVMe storage devices (linux.storage, /sys/class/nvme/<ctrl>/state).',
  evaluate(ctx): RuleResult {
    const drives = ctx.devices.filter((d) => d.category === 'storage' && d.presence === 'present' && prop(d, 'nvme_state'))
    if (drives.length === 0) return { status: 'insufficient_data', reason: 'No NVMe controller state has been collected' }
    const findings: RuleFinding[] = []
    for (const d of drives) {
      const p = prop(d, 'nvme_state')!
      if (!isFresh(p.observedAt, ctx) || p.value === 'live') continue
      findings.push({
        subject: `device:${d.id}`, severity: p.value === 'dead' ? 'high' : 'low', confidence: p.value === 'dead' ? 0.9 : 0.5,
        title: `NVMe controller for ${d.name} is "${String(p.value)}"`,
        description: 'The kernel reports the NVMe controller is not in its normal `live` state. Transient states such as resetting or connecting can appear briefly during power transitions; `dead` means the kernel gave up on the controller.',
        deviceIds: [d.id], evidence: propEvidence(d, ['nvme_state']),
        recommendation: 'Check `dmesg | grep -i nvme` for timeouts or resets and update the drive firmware and BIOS. If the state persists, back up data. The application changes nothing.'
      })
    }
    return { status: 'evaluated', findings }
  }
}

export const HARDWARE_RULES: DiagnosticRule[] = [cpuPressure, memoryPressure, ioPressure, swapThrash, thermalThrottle, eccErrors, pciAerErrors, pciLinkWidth, usbReconnect, nvmeState]
export type { MetricWindow }
