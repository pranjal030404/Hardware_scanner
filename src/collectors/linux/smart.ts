import type { DeviceObservation } from '@shared/schemas'
import { ObservationBuilder, type CollectContext } from '../core/context'
import type { Collector } from '../core/types'

const ID = 'linux.smart'

export interface SmartSummary {
  passed?: boolean
  temperatureC?: number
  powerOnHours?: number
  percentageUsed?: number
  criticalWarning?: number
  mediaErrors?: number
  reallocatedSectors?: number
  model?: string
}

/** Parse `smartctl --json -a` output (ATA + NVMe). */
export function parseSmartctl(json: string): SmartSummary | undefined {
  let j: any
  try {
    j = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!j || typeof j !== 'object' || !j.smartctl) return undefined
  const s: SmartSummary = { model: j.model_name }
  if (typeof j.smart_status?.passed === 'boolean') s.passed = j.smart_status.passed
  if (typeof j.temperature?.current === 'number') s.temperatureC = j.temperature.current
  if (typeof j.power_on_time?.hours === 'number') s.powerOnHours = j.power_on_time.hours
  const nvme = j.nvme_smart_health_information_log
  if (nvme) {
    s.percentageUsed = nvme.percentage_used
    s.criticalWarning = nvme.critical_warning
    s.mediaErrors = nvme.media_errors
  }
  const realloc = j.ata_smart_attributes?.table?.find((a: any) => a.id === 5)
  if (realloc) s.reallocatedSectors = realloc.raw?.value
  return s
}

/**
 * SMART health. smartctl needs raw device access, which normally means root; without it this
 * collector reports `permission_required` instead of pretending drives are healthy.
 */
export const linuxSmart: Collector = {
  id: ID,
  version: '1.0.0',
  platforms: ['linux'],
  categories: ['storage'],
  permissions: ['Read access to block devices (typically root) and smartmontools'],
  method: 'smartctl --json -a /dev/<disk> (argument-safe, read-only)',
  timeoutMs: 30000,
  retries: 0,
  supplementary: true,
  isSupported: (ctx) => ctx.reader.exists('/sys/block'),
  async collect(ctx: CollectContext) {
    const at = ctx.host.now()
    const disks = (await ctx.reader.dir('/sys/block')).filter((n) => /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|hd[a-z]+)$/.test(n))
    if (!disks.length) return { outcome: 'complete' as const, observations: [], limitations: [{ kind: 'info' as const, message: 'No physical disks to query.' }] }
    const out: DeviceObservation[] = []
    let denied = 0
    let tool = true
    const limitations = []
    for (const d of disks) {
      const res = await ctx.run('smartctl', ['--json', '-a', `/dev/${d}`], { timeoutMs: 10000 })
      if (res.notFound) {
        tool = false
        break
      }
      // smartctl uses bit flags in the exit code; bit 1 = cannot open device (permission).
      const parsed = parseSmartctl(res.stdout)
      const msgs: string[] = (() => {
        try {
          return (JSON.parse(res.stdout).smartctl?.messages ?? []).map((m: any) => String(m.string))
        } catch {
          return []
        }
      })()
      if (!parsed || msgs.some((m) => /permission denied|operation not permitted/i.test(m)) || /permission denied/i.test(res.stderr)) {
        denied++
        continue
      }
      // Key must match the storage collector's derived key; both derive from the same sysfs attributes.
      const wwid = (await ctx.reader.text(`/sys/block/${d}/wwid`)) ?? (await ctx.reader.text(`/sys/block/${d}/device/wwid`))
      const serial = await ctx.reader.text(`/sys/block/${d}/device/serial`)
      const model = await ctx.reader.text(`/sys/block/${d}/device/model`)
      const key = wwid ? `storage:wwid:${wwid.replace(/\s+/g, '_')}` : serial && model ? `storage:sn:${model}:${serial}` : `storage:dev:${d}`
      out.push(
        new ObservationBuilder(ID, key, 'storage', parsed.model ?? d, at, { sourceProperty: 'smartctl model_name' })
          .prop('smart_passed', parsed.passed, 'smartctl smart_status.passed', { volatile: true, evidence: 'measured' })
          .prop('smart_temperature', parsed.temperatureC, 'smartctl temperature.current', { unit: '°C', volatile: true, evidence: 'measured' })
          .prop('power_on_hours', parsed.powerOnHours, 'smartctl power_on_time.hours', { unit: 'h', volatile: true, evidence: 'measured' })
          .prop('nvme_percentage_used', parsed.percentageUsed, 'smartctl nvme_smart_health_information_log.percentage_used', { unit: '%', volatile: true, evidence: 'measured' })
          .prop('nvme_critical_warning', parsed.criticalWarning, 'smartctl nvme_smart_health_information_log.critical_warning', { volatile: true, evidence: 'measured' })
          .prop('nvme_media_errors', parsed.mediaErrors, 'smartctl nvme_smart_health_information_log.media_errors', { volatile: true, evidence: 'measured' })
          .prop('reallocated_sectors', parsed.reallocatedSectors, 'smartctl ata_smart_attributes id 5', { volatile: true, evidence: 'measured' })
          .build()
      )
    }
    if (!tool) {
      return { outcome: 'unavailable' as const, observations: [], limitations: [{ kind: 'missing_tool' as const, message: 'smartctl (smartmontools) is not installed; drive health is unavailable.', target: 'smartctl', remedy: 'Install smartmontools.' }] }
    }
    if (denied === disks.length) {
      return {
        outcome: 'permission_required' as const,
        observations: [],
        limitations: [{ kind: 'permission' as const, message: 'SMART data requires raw access to block devices. Drive health is unknown, not healthy.', target: 'smartctl', remedy: 'Grant read access to the disk devices (e.g. run once with sudo, or add a udev rule / use smartd). The app never runs as root by default.' }]
      }
    }
    if (denied) limitations.push({ kind: 'permission' as const, message: `${denied} of ${disks.length} disk(s) could not be queried.`, target: 'smartctl' })
    return { outcome: denied ? ('partial' as const) : ('complete' as const), observations: out, limitations }
  }
}
