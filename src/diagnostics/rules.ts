import { PERFORMANCE_RULES } from './rules-performance'
import type { CollectorHealth, EvidenceRef, Severity } from '@shared/schemas'
import type { StoredDevice } from '@shared/stored'
import { HARDWARE_RULES } from './rules-hardware'
import { isFresh, type DiagnosticRule, type RuleContext, type RuleFinding } from './types'

const prop = (d: StoredDevice, key: string) => d.properties.find((p) => p.key === key)
const num = (d: StoredDevice, key: string): number | undefined => {
  const v = prop(d, key)?.value
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
const propEvidence = (d: StoredDevice, key: string, note?: string): EvidenceRef[] => {
  const p = prop(d, key)
  return p ? [{ type: 'device_property', ref: d.id, key, value: p.value, unit: p.unit, source: `${p.source} · ${p.sourceProperty}`, observedAt: p.observedAt, note }] : []
}

/** A collector's data counts as current only if it succeeded recently and completely enough to trust. */
const collectorUsable = (ctx: RuleContext, id: string): boolean => {
  const h = ctx.collectors.find((c) => c.id === id)
  return !!h && h.status === 'available' && isFresh(h.lastSuccessAt, ctx)
}
const fmtBytes = (n: number): string => `${(n / 2 ** 30).toFixed(1)} GiB`

// ---------------------------------------------------------------------------------------------

const collectorHealth: DiagnosticRule = {
  id: 'collector.health',
  version: 1,
  title: 'Collector failed or needs permission',
  category: 'collector',
  description: 'Reports hardware collectors that errored, cannot read their data source, or are missing a permission or tool.',
  severityPolicy: 'error → medium; permission required → low; tool/interface unavailable or partial permission limits → info.',
  dataUsed: 'Latest run status and limitations of every supported collector.',
  evaluate(ctx) {
    const scanned = ctx.collectors.filter((c) => !c.disabled && c.status !== 'unsupported' && c.status !== 'not_scanned' && c.lastRunAt)
    if (!scanned.length) return { status: 'insufficient_data', reason: 'No collector has run yet' }
    const findings: RuleFinding[] = []
    for (const c of scanned) {
      const evidence: EvidenceRef[] = [{ type: 'collector_run', ref: c.id, key: 'status', value: c.status, source: c.method, observedAt: c.lastRunAt!, note: c.message ?? undefined }]
      const limit = c.limitations.find((l) => l.kind !== 'info')
      let severity: Severity | null = null
      let title = ''
      let description = ''
      let rec = ''
      if (c.status === 'error') {
        severity = 'medium'
        title = `Collector ${c.id} failed`
        description = `The ${c.id} collector could not complete its last run (${c.message ?? 'unknown error'}). Its devices are kept as last known and are NOT treated as removed.`
        rec = 'Press Rescan on the Collectors page. If it keeps failing, check the message above and the interface it reads; the rest of the inventory is unaffected.'
      } else if (c.status === 'permission_required') {
        severity = 'low'
        title = `${c.id} needs additional permission`
        description = `${c.id} could not read its data source without more privileges, so this part of the hardware is unknown (not healthy, not faulty).${limit ? ' ' + limit.message : ''}`
        rec = limit?.remedy ?? 'Grant read access to the interface named on the Collectors page. The app never escalates privileges or runs privileged commands automatically.'
      } else if (c.status === 'unavailable') {
        severity = 'info'
        title = `${c.id} is unavailable`
        description = `${c.id} could not inspect anything: ${c.message ?? limit?.message ?? 'a required tool or interface is missing'}.`
        rec = limit?.remedy ?? 'Install the missing tool (see the Collectors page) if you want this information.'
      } else if (c.status === 'available' && c.partial && limit && limit.kind === 'permission') {
        severity = 'info'
        title = `${c.id} has limited visibility`
        description = limit.message
        rec = limit.remedy ?? 'Only needed if you want the missing details.'
      }
      if (severity) findings.push({ subject: `collector:${c.id}`, severity, title, description, deviceIds: [], evidence, recommendation: rec })
    }
    return { status: 'evaluated', findings }
  }
}

const inventoryStale: DiagnosticRule = {
  id: 'inventory.stale',
  version: 1,
  title: 'Inventory data is stale',
  category: 'inventory',
  description: 'Reports when no inventory scan has succeeded within the staleness window, so displayed hardware state may be out of date.',
  severityPolicy: 'stale while monitoring is active → medium; stale because monitoring is paused → info.',
  dataUsed: 'Time of the last scan, monitoring state, per-collector last success.',
  evaluate(ctx) {
    if (!ctx.lastInventoryScanAt) return { status: 'insufficient_data', reason: 'No scan has completed yet' }
    const findings: RuleFinding[] = []
    const age = ctx.now.getTime() - Date.parse(ctx.lastInventoryScanAt)
    if (age > ctx.staleMs) {
      const paused = ctx.monitor?.mode === 'paused'
      findings.push({
        subject: 'inventory',
        severity: paused ? 'info' : 'medium',
        title: 'Hardware inventory has not been refreshed recently',
        description: `The last scan finished ${Math.round(age / 60000)} minutes ago${paused ? ' and live monitoring is paused' : ''}. Devices shown may no longer match the machine.`,
        deviceIds: [],
        evidence: [{ type: 'monitor_state', ref: 'inventory', key: 'lastScanAt', value: ctx.lastInventoryScanAt, observedAt: ctx.now.toISOString(), note: `stale after ${Math.round(ctx.staleMs / 1000)}s` }],
        recommendation: paused ? 'Resume monitoring or press Rescan.' : 'Press Rescan; if scans keep failing see the Collectors page.'
      })
    }
    for (const c of ctx.collectors) {
      if (c.status === 'stale') {
        findings.push({
          subject: `collector-stale:${c.id}`, severity: 'low', title: `${c.id} has no recent successful scan`,
          description: `${c.id} last succeeded at ${c.lastSuccessAt}. Its data is treated as out of date.`, deviceIds: [],
          evidence: [{ type: 'collector_run', ref: c.id, key: 'lastSuccessAt', value: c.lastSuccessAt ?? 'never', observedAt: c.lastRunAt ?? ctx.now.toISOString() }],
          recommendation: 'Rescan this collector from the Collectors page.'
        })
      }
    }
    return { status: 'evaluated', findings }
  }
}

const deviceOsError: DiagnosticRule = {
  id: 'device.os_error',
  version: 1,
  title: 'Device reports an operating-system error',
  category: 'device',
  description: 'Reports devices that the operating system itself marks as being in an error state (for example a Windows PnP problem code). Absence from a scan is never treated as an error.',
  severityPolicy: 'authoritative OS error state → medium (confidence 0.9).',
  dataUsed: 'Device status plus the OS-reported problem/health properties; only from collectors with a fresh successful scan.',
  evaluate(ctx) {
    const present = ctx.devices.filter((d) => d.presence === 'present')
    const retain = present.filter((d) => d.status === 'error' && !collectorUsable(ctx, d.source)).map((d) => `device:${d.id}`)
    const findings: RuleFinding[] = present
      .filter((d) => d.status === 'error' && collectorUsable(ctx, d.source))
      .map((d) => {
        const src = d.fieldSources['status']
        const detailKeys = ['problem_code', 'pnp_status', 'health_status', 'operational_status']
        const code = detailKeys.map((k) => prop(d, k)).find(Boolean)
        return {
          subject: `device:${d.id}`, severity: 'medium' as const, confidence: 0.9,
          title: `${d.name} reports an error`,
          description: `The operating system reports this ${d.category} device in an error state${code ? ` (${code.key.replace(/_/g, ' ')}: ${String(code.value)})` : ''}. This comes from the OS, not from this app's inference.`,
          deviceIds: [d.id],
          evidence: [
            { type: 'device_field' as const, ref: d.id, key: 'status', value: d.status, source: src ? `${src.source} · ${src.sourceProperty}` : d.source, observedAt: d.lastScanned },
            ...detailKeys.flatMap((k) => propEvidence(d, k))
          ],
          recommendation: 'Reconnect the device or restart it, then check the OS device log (Device Manager on Windows, `dmesg`/journal on Linux). No automatic fix is applied.'
        }
      })
    return { status: 'evaluated', findings, retain }
  }
}

const IGNORED_FS = new Set(['squashfs', 'iso9660', 'udf', 'erofs', 'cramfs'])

const storageSpace: DiagnosticRule = {
  id: 'storage.space',
  version: 1,
  title: 'Filesystem is nearly full',
  category: 'storage',
  description: 'Compares used space of mounted filesystems with configurable thresholds (Settings → Diagnostics).',
  severityPolicy: 'used ≥ warning threshold (default 85%) → medium; ≥ critical threshold (default 95%) → high. Read-only image filesystems and tiny volumes are ignored.',
  dataUsed: 'Partition properties total/free bytes from a fresh storage scan.',
  evaluate(ctx) {
    if (!collectorUsable(ctx, 'linux.storage') && !collectorUsable(ctx, 'windows.storage')) return { status: 'insufficient_data', reason: 'No fresh storage scan' }
    const warn = ctx.settings.diagDiskWarnPercent
    const crit = Math.max(ctx.settings.diagDiskCriticalPercent, warn)
    const findings: RuleFinding[] = []
    const retain: string[] = []
    for (const d of ctx.devices.filter((x) => x.category === 'storage' && x.subtype === 'partition' && x.presence === 'present')) {
      const mount = prop(d, 'mount_point')?.value
      const total = num(d, 'filesystem_total_bytes')
      const free = num(d, 'free_bytes')
      const fs = String(prop(d, 'filesystem')?.value ?? '')
      if (typeof mount !== 'string' || total === undefined || free === undefined || IGNORED_FS.has(fs) || total < 64 * 2 ** 20) continue
      if (!collectorUsable(ctx, d.source) || !isFresh(prop(d, 'free_bytes')?.observedAt, ctx)) { retain.push(`device:${d.id}`); continue }
      const used = ((total - free) / total) * 100
      if (used < warn) continue
      const critical = used >= crit
      findings.push({
        subject: `device:${d.id}`, severity: critical ? 'high' : 'medium',
        title: `${mount} is ${used.toFixed(0)}% full`,
        description: `${mount} (${fs || 'filesystem'}) has ${fmtBytes(free)} free of ${fmtBytes(total)}. Threshold: ${critical ? crit : warn}% used.`,
        deviceIds: [d.id],
        evidence: [...propEvidence(d, 'free_bytes'), ...propEvidence(d, 'filesystem_total_bytes'), { type: 'setting', ref: critical ? 'diagDiskCriticalPercent' : 'diagDiskWarnPercent', value: critical ? crit : warn, unit: '%', observedAt: ctx.now.toISOString() }],
        recommendation: 'Free space by removing files you no longer need or moving them elsewhere. Nothing is deleted automatically.'
      })
    }
    return { status: 'evaluated', findings, retain }
  }
}

const storageSmart: DiagnosticRule = {
  id: 'storage.smart',
  version: 1,
  title: 'Drive health warning (SMART)',
  category: 'storage',
  description: 'Reports warnings in SMART health data the collector was permitted to read. If SMART cannot be read the rule says nothing about drive health; see the collector finding.',
  severityPolicy: 'overall SMART FAILED → critical; NVMe critical warning or ≥100% life used → high; ≥90% life used or media errors → medium; reallocated sectors → low.',
  dataUsed: 'smart_passed, nvme_* and reallocated_sectors properties from linux.smart.',
  evaluate(ctx) {
    if (!collectorUsable(ctx, 'linux.smart')) return { status: 'insufficient_data', reason: 'SMART data is unavailable or stale (permission, tool or no recent scan)' }
    const findings: RuleFinding[] = []
    for (const d of ctx.devices.filter((x) => x.category === 'storage' && x.presence === 'present')) {
      const passed = prop(d, 'smart_passed')?.value
      const used = num(d, 'nvme_percentage_used')
      const cw = num(d, 'nvme_critical_warning')
      const media = num(d, 'nvme_media_errors')
      const realloc = num(d, 'reallocated_sectors')
      const reasons: { sev: Severity; text: string; keys: string[] }[] = []
      if (passed === false) reasons.push({ sev: 'critical', text: 'The drive reports an overall SMART health status of FAILED.', keys: ['smart_passed'] })
      if (cw !== undefined && cw > 0) reasons.push({ sev: 'high', text: `The NVMe critical-warning flags are non-zero (0x${cw.toString(16)}).`, keys: ['nvme_critical_warning'] })
      if (used !== undefined && used >= 100) reasons.push({ sev: 'high', text: `The drive reports ${used}% of its rated life used.`, keys: ['nvme_percentage_used'] })
      else if (used !== undefined && used >= 90) reasons.push({ sev: 'medium', text: `The drive reports ${used}% of its rated life used.`, keys: ['nvme_percentage_used'] })
      if (media !== undefined && media > 0) reasons.push({ sev: 'medium', text: `The drive logged ${media} media/data-integrity error(s).`, keys: ['nvme_media_errors'] })
      if (realloc !== undefined && realloc > 0) reasons.push({ sev: 'low', text: `${realloc} sector(s) have been reallocated.`, keys: ['reallocated_sectors'] })
      if (!reasons.length) continue
      const order: Severity[] = ['info', 'low', 'medium', 'high', 'critical']
      const sev = reasons.map((r) => r.sev).sort((a, b) => order.indexOf(b) - order.indexOf(a))[0]!
      findings.push({
        subject: `device:${d.id}`, severity: sev, confidence: 1,
        title: `${d.name}: drive health warning`, description: reasons.map((r) => r.text).join(' '), deviceIds: [d.id],
        evidence: reasons.flatMap((r) => r.keys.flatMap((k) => propEvidence(d, k))),
        recommendation: sev === 'critical' || sev === 'high' ? 'Back up important data now, then consult the drive vendor’s diagnostics. The app does not modify the drive.' : 'Keep an eye on this value and make sure you have a recent backup.'
      })
    }
    return { status: 'evaluated', findings }
  }
}

const sensorTemperature: DiagnosticRule = {
  id: 'sensor.temperature',
  version: 1,
  title: 'Temperature near or above the sensor’s own limits',
  category: 'thermal',
  description: 'Compares temperature readings with the critical/maximum limits the sensor driver itself reports. There is no universal threshold: a sensor that reports no limits is not evaluated unless you set a fallback in Settings.',
  severityPolicy: 'at/above reported critical → critical; at/above reported max → high; within the configured margin (default 10 °C) of critical → medium. Optional fallback threshold → medium.',
  dataUsed: 'temperature:<label> readings with temperature_crit/temperature_max properties from hwmon, from a fresh sensors scan.',
  evaluate(ctx) {
    if (!collectorUsable(ctx, 'linux.sensors')) return { status: 'insufficient_data', reason: 'No fresh sensor scan' }
    const margin = ctx.settings.diagTempMarginC
    const fallback = ctx.settings.diagTempFallbackC
    const findings: RuleFinding[] = []
    for (const d of ctx.devices.filter((x) => x.category === 'sensor' && x.presence === 'present')) {
      for (const p of d.properties.filter((x) => x.key.startsWith('temperature:') && typeof x.value === 'number')) {
        if (!isFresh(p.observedAt, ctx)) continue
        const label = p.key.slice('temperature:'.length)
        const t = p.value as number
        const crit = num(d, `temperature_crit:${label}`)
        const max = num(d, `temperature_max:${label}`)
        let sev: Severity | null = null
        let why = ''
        if (crit !== undefined && crit > 0 && t >= crit) { sev = 'critical'; why = `at or above the sensor’s critical limit of ${crit} °C` }
        else if (max !== undefined && max > 0 && t >= max) { sev = 'high'; why = `at or above the sensor’s maximum of ${max} °C` }
        else if (crit !== undefined && crit > 0 && t >= crit - margin) { sev = 'medium'; why = `within ${margin} °C of the sensor’s critical limit of ${crit} °C` }
        else if (crit === undefined && max === undefined && fallback > 0 && t >= fallback) { sev = 'medium'; why = `above your configured fallback threshold of ${fallback} °C (this sensor reports no limits)` }
        if (!sev) continue
        findings.push({
          subject: `device:${d.id}:${label}`, severity: sev, confidence: 1,
          title: `${d.name} ${label}: ${t} °C`, description: `The reading is ${why}.`, deviceIds: [d.id],
          evidence: [
            { type: 'device_property', ref: d.id, key: p.key, value: t, unit: '°C', source: `${p.source} · ${p.sourceProperty}`, observedAt: p.observedAt },
            ...propEvidence(d, `temperature_crit:${label}`), ...propEvidence(d, `temperature_max:${label}`)
          ],
          recommendation: 'Check airflow and fans, close heavy workloads and make sure vents are not blocked. A single brief reading may be a spike; the finding clears when the reading drops.'
        })
      }
    }
    return { status: 'evaluated', findings }
  }
}

const networkLinkDown: DiagnosticRule = {
  id: 'network.link_down',
  version: 1,
  title: 'Network interface is disconnected',
  category: 'network',
  description: 'Opt-in (Settings → Diagnostics). Reports physical Wi-Fi/Ethernet interfaces whose link is down. Disabled by default because a disconnected interface is often normal.',
  severityPolicy: 'always low, and only when enabled, the interface is physical and the state came from a fresh network scan.',
  dataUsed: 'operstate and carrier properties of physical network interfaces.',
  evaluate(ctx) {
    if (!ctx.settings.diagNetworkDownEnabled) return { status: 'evaluated', findings: [] }
    if (!collectorUsable(ctx, 'linux.network') && !collectorUsable(ctx, 'windows.network')) return { status: 'insufficient_data', reason: 'No fresh network scan' }
    const findings: RuleFinding[] = []
    for (const d of ctx.devices.filter((x) => x.category === 'network' && x.presence === 'present' && (x.subtype === 'wifi' || x.subtype === 'ethernet'))) {
      const state = prop(d, 'operstate')
      if (!state || !isFresh(state.observedAt, ctx) || !collectorUsable(ctx, d.source)) continue
      if (String(state.value).toLowerCase() !== 'down') continue
      findings.push({
        subject: `device:${d.id}`, severity: 'low', confidence: 0.8,
        title: `${d.name} (${d.subtype}) is disconnected`, description: 'The interface link state is down. This is normal if you intentionally disabled it or are not on that network.',
        deviceIds: [d.id], evidence: [...propEvidence(d, 'operstate'), ...propEvidence(d, 'carrier')],
        recommendation: 'Check the cable or Wi-Fi connection, or disable this rule if the state is intentional.'
      })
    }
    return { status: 'evaluated', findings }
  }
}

const PERIPHERAL = new Set(['usb', 'hid', 'camera', 'bluetooth', 'serial', 'audio'])

const deviceMissing: DiagnosticRule = {
  id: 'device.missing',
  version: 1,
  title: 'Previously seen device is no longer detected',
  category: 'device',
  description: 'Reports devices that disappeared after a successful, complete scan of their category. A removed peripheral is informational; an internal component that vanished is a warning, never proof of a fault.',
  severityPolicy: 'removable peripherals → info; internal components (PCI, CPU, memory, internal storage, panel, battery…) → medium with confidence 0.6. Never critical.',
  dataUsed: 'Device presence + owning collector status, limited to devices last seen within the reporting window (default 7 days).',
  evaluate(ctx) {
    const windowMs = ctx.settings.diagMissingWindowHours * 3_600_000
    const findings: RuleFinding[] = []
    const retain: string[] = []
    for (const d of ctx.devices.filter((x) => x.presence === 'missing')) {
      if (ctx.now.getTime() - Date.parse(d.lastSeen) > windowMs) continue
      const h = ctx.collectors.find((c) => c.id === d.source)
      // Only a collector that currently runs to completion can vouch for an absence.
      if (!h || h.status !== 'available' || h.partial) { retain.push(`device:${d.id}`); continue }
      const removable = PERIPHERAL.has(d.category) || d.subtype === 'removable' || (d.category === 'storage' && d.busType === 'USB')
      findings.push({
        subject: `device:${d.id}`, severity: removable ? 'info' : 'medium', confidence: removable ? 1 : 0.6,
        title: removable ? `${d.name} was disconnected` : `${d.name} is no longer detected`,
        description: removable
          ? `This ${d.category} device was last seen ${d.lastSeen} and was not present in the latest complete scan. This is normal if it was unplugged.`
          : `This internal ${d.category} component was last seen ${d.lastSeen} and is absent from the latest complete scan. That can mean a hardware, driver, firmware or configuration change; it is not by itself proof of failure.`,
        deviceIds: [d.id],
        evidence: [
          { type: 'device_field', ref: d.id, key: 'presence', value: 'missing', source: d.source, observedAt: d.lastScanned },
          { type: 'collector_run', ref: d.source, key: 'status', value: `${h.status}${h.partial ? ' (partial)' : ' (complete)'}`, observedAt: h.lastRunAt ?? ctx.now.toISOString() }
        ],
        recommendation: removable ? 'Nothing to do if this was intentional. Reconnect it to clear this finding.' : 'Check whether anything changed (BIOS/firmware update, driver change, hardware work). Reboot once; if it stays missing, consult the vendor.'
      })
    }
    return { status: 'evaluated', findings, retain }
  }
}

const monitoringState: DiagnosticRule = {
  id: 'monitoring.state',
  version: 1,
  title: 'Live monitoring is degraded or paused',
  category: 'monitoring',
  description: 'Reports when live hardware monitoring is paused or has fallen back to periodic polling, so changes may be noticed later than usual.',
  severityPolicy: 'degraded → low; paused by the user → info.',
  dataUsed: 'Monitoring mode and degradation message.',
  evaluate(ctx) {
    if (!ctx.monitor) return { status: 'insufficient_data', reason: 'Monitoring state unknown' }
    const findings: RuleFinding[] = []
    const ev = (): EvidenceRef[] => [{ type: 'monitor_state', ref: 'monitor', key: 'mode', value: ctx.monitor!.mode, observedAt: ctx.now.toISOString(), note: ctx.monitor!.message ?? undefined }]
    if (ctx.monitor.mode === 'paused') findings.push({ subject: 'monitor:paused', severity: 'info', title: 'Live monitoring is paused', description: 'You paused monitoring. Hardware changes are not detected until it is resumed.', deviceIds: [], evidence: ev(), recommendation: 'Resume monitoring from the Events page.' })
    else if (ctx.monitor.degraded) findings.push({ subject: 'monitor:degraded', severity: 'low', title: 'Live monitoring is degraded', description: ctx.monitor.message ?? 'Native notifications are unavailable; changes are found by periodic rescans.', deviceIds: [], evidence: ev(), recommendation: 'On Linux make sure `udevadm` is installed and usable. Polling still works.' })
    return { status: 'evaluated', findings }
  }
}

const metricsAvailability: DiagnosticRule = {
  id: 'metrics.availability',
  version: 1,
  title: 'Metric sampling is failing, stalled or paused',
  category: 'monitoring',
  description: 'Reports metric providers that error repeatedly or have stopped producing measurements, and sampling that is paused, so charts are not mistaken for current data. A provider whose source simply does not exist on this machine (for example no battery) is normal and not reported.',
  severityPolicy: 'provider erroring → low; provider stalled (no sample for 5 intervals) → low; sampling paused by the user → info.',
  dataUsed: 'Metric sampler provider status and last-sample times.',
  evaluate(ctx) {
    const m = ctx.metrics
    if (!m) return { status: 'insufficient_data', reason: 'Metric sampler state unknown' }
    if (!m.enabled || !m.platformSupported) return { status: 'evaluated', findings: [] }
    const at = ctx.now.toISOString()
    const findings: RuleFinding[] = []
    if (m.paused) {
      findings.push({
        subject: 'metrics:paused', severity: 'info', title: 'Metric sampling is paused', description: 'Charts on the Monitor page show the last collected data, not the current state.', deviceIds: [],
        evidence: [{ type: 'monitor_state', ref: 'metrics', key: 'paused', value: true, observedAt: at }], recommendation: 'Resume sampling from the Monitor page.'
      })
      return { status: 'evaluated', findings }
    }
    const stallMs = Math.max(m.intervalSec * 5000, 30_000)
    for (const p of m.providers) {
      if (p.status === 'error') {
        findings.push({
          subject: `metrics:${p.id}`, severity: 'low', title: `${p.title}: sampling is failing`,
          description: `The ${p.id} provider failed ${p.consecutiveFailures} time(s) in a row: ${p.message ?? 'unknown error'}. Its charts are marked stale.`, deviceIds: [],
          evidence: [{ type: 'monitor_state', ref: p.id, key: 'status', value: p.status, observedAt: at, note: p.message ?? undefined }],
          recommendation: 'Check that the interface named on the Monitor page is readable. Sampling retries automatically and the finding clears when it recovers.'
        })
      } else if ((p.status === 'ok' || p.status === 'partial') && p.lastSampleAt && ctx.now.getTime() - Date.parse(p.lastSampleAt) > stallMs) {
        findings.push({
          subject: `metrics:${p.id}`, severity: 'low', title: `${p.title}: no recent samples`,
          description: `The last successful sample was at ${p.lastSampleAt}, longer than ${Math.round(stallMs / 1000)} seconds ago.`, deviceIds: [],
          evidence: [{ type: 'monitor_state', ref: p.id, key: 'lastSampleAt', value: p.lastSampleAt, observedAt: at }], recommendation: 'Sampling may be blocked or the app was suspended. It resumes automatically.'
        })
      }
    }
    return { status: 'evaluated', findings }
  }
}

const WATCHED = /^(model|manufacturer|size_bytes):/

const propertyChanged: DiagnosticRule = {
  id: 'device.property_changed',
  version: 1,
  title: 'Identity-level property changed unexpectedly',
  category: 'device',
  description: 'Reports recent changes to properties that normally never change for the same hardware (model, manufacturer, capacity). Ordinary status or naming changes are ignored.',
  severityPolicy: 'always low (confidence 0.7): the change is real, but its cause (firmware update, different hardware in the same slot, OS naming) is not known.',
  dataUsed: 'device.updated events of the last 24 hours with field-level diffs from complete scans.',
  evaluate(ctx) {
    const since = ctx.now.getTime() - 24 * 3_600_000
    const findings: RuleFinding[] = []
    for (const e of ctx.recentEvents) {
      if (e.type !== 'device.updated' || !e.deviceId || Date.parse(e.at) < since) continue
      const changes = Array.isArray(e.data['changes']) ? (e.data['changes'] as unknown[]).filter((c): c is string => typeof c === 'string' && WATCHED.test(c)) : []
      const dev = ctx.devices.find((d) => d.id === e.deviceId)
      if (!changes.length || !dev || dev.presence !== 'present') continue
      for (const c of changes) {
        const field = c.split(':')[0]!
        findings.push({
          subject: `device:${dev.id}:${field}`, severity: 'low', confidence: 0.7,
          title: `${dev.name}: ${field.replace(/_/g, ' ')} changed`, description: `Observed change: ${c}. This normally does not change for the same hardware.`, deviceIds: [dev.id],
          evidence: [{ type: 'device_event', ref: dev.id, key: field, value: c, source: e.collectorId ?? undefined, observedAt: e.at }],
          recommendation: 'If you did not update firmware or swap hardware, check whether a different device now occupies this slot or port.'
        })
      }
    }
    return { status: 'evaluated', findings }
  }
}

export const DIAGNOSTIC_RULES: DiagnosticRule[] = [
  collectorHealth, inventoryStale, deviceOsError, storageSpace, storageSmart, sensorTemperature, networkLinkDown, deviceMissing, monitoringState, metricsAvailability, propertyChanged, ...HARDWARE_RULES, ...PERFORMANCE_RULES
]

export type { CollectorHealth }
