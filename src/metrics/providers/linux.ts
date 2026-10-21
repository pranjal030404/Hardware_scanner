import { hwmonIdentity } from '../../collectors/linux/sensors'
import { counterRate, ratioPercent } from '../derive'
import type { MetricProvider, MetricReading, ProviderOutput, SampleContext } from '../types'

const spec = (metric: string, unit: string, description: string, source: string) => ({ metric, unit, description, source })

// ---------------------------------------------------------------------------------------------
// CPU utilisation from /proc/stat (aggregate line)
// ---------------------------------------------------------------------------------------------

export interface CpuTimes { busy: number; total: number }

/** Parse the aggregate `cpu` line. guest/guest_nice are already included in user/nice and are excluded. */
export function parseProcStat(text: string): CpuTimes | undefined {
  const line = text.split('\n').find((l) => /^cpu\s/.test(l))
  if (!line) return undefined
  const f = line.trim().split(/\s+/).slice(1, 9).map(Number)
  if (f.length < 4 || f.some((n) => !Number.isFinite(n))) return undefined
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = f as [number, number, number, number, number?, number?, number?, number?]
  const idleAll = idle + iowait
  const total = user + nice + system + idleAll + irq + softirq + steal
  return { busy: total - idleAll, total }
}

export const linuxCpuProvider: MetricProvider = {
  id: 'metrics.linux.cpu',
  title: 'CPU utilisation',
  platforms: ['linux'],
  metrics: [spec('cpu.utilization', '%', 'Share of CPU time not idle, all logical processors combined', '/proc/stat')],
  isSupported: (c) => c.reader.exists('/proc/stat'),
  async sample(c, prev): Promise<ProviderOutput> {
    const text = await c.reader.text('/proc/stat')
    const cur = text ? parseProcStat(text) : undefined
    if (!cur) return { readings: [], status: 'unavailable', message: '/proc/stat could not be read or parsed', next: undefined }
    const p = prev as CpuTimes | undefined
    const readings: MetricReading[] = []
    let resets = 0
    if (p) {
      const dTotal = cur.total - p.total
      if (dTotal < 0) resets++
      else {
        const u = ratioPercent(cur.busy - p.busy, dTotal)
        if (u !== undefined) readings.push({ ref: { key: 'cpu:package:0' }, metric: 'cpu.utilization', value: u, unit: '%', source: '/proc/stat' })
      }
    }
    return { readings, status: 'ok', counterResets: resets, next: cur }
  }
}

// ---------------------------------------------------------------------------------------------
// Memory from /proc/meminfo
// ---------------------------------------------------------------------------------------------

export const linuxMemoryProvider: MetricProvider = {
  id: 'metrics.linux.memory',
  title: 'Memory',
  platforms: ['linux'],
  metrics: [
    spec('memory.utilization', '%', 'Memory in use: (MemTotal − MemAvailable) / MemTotal', '/proc/meminfo'),
    spec('memory.available', 'B', 'Memory available to applications (MemAvailable)', '/proc/meminfo')
  ],
  isSupported: (c) => c.reader.exists('/proc/meminfo'),
  async sample(c): Promise<ProviderOutput> {
    const text = await c.reader.text('/proc/meminfo')
    const get = (k: string): number | undefined => {
      const m = new RegExp(`^${k}:\\s+(\\d+)\\s*kB`, 'm').exec(text ?? '')
      return m ? parseInt(m[1]!, 10) * 1024 : undefined
    }
    const total = get('MemTotal')
    const avail = get('MemAvailable')
    if (!total || avail === undefined) return { readings: [], status: 'unavailable', message: 'MemTotal/MemAvailable not exposed by /proc/meminfo', next: undefined }
    const ref = { key: 'memory:system' }
    return {
      readings: [
        { ref, metric: 'memory.utilization', value: ((total - avail) / total) * 100, unit: '%', source: '/proc/meminfo' },
        { ref, metric: 'memory.available', value: avail, unit: 'B', source: '/proc/meminfo' }
      ],
      status: 'ok', next: undefined
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Network throughput from /sys/class/net/<if>/statistics (per-interface byte counters)
// ---------------------------------------------------------------------------------------------

interface NetState { at: number; counters: Record<string, { rx: number; tx: number }> }

export const linuxNetworkProvider: MetricProvider = {
  id: 'metrics.linux.network',
  title: 'Network throughput',
  platforms: ['linux'],
  metrics: [
    spec('network.rx_rate', 'B/s', 'Receive rate from the interface byte counter delta', '/sys/class/net/<if>/statistics/rx_bytes'),
    spec('network.tx_rate', 'B/s', 'Transmit rate from the interface byte counter delta', '/sys/class/net/<if>/statistics/tx_bytes')
  ],
  isSupported: (c) => c.reader.exists('/sys/class/net'),
  async sample(c, prev): Promise<ProviderOutput> {
    const p = prev as NetState | undefined
    const dt = p ? c.monoMs - p.at : undefined
    const counters: NetState['counters'] = {}
    const readings: MetricReading[] = []
    let resets = 0
    const ifaces = await c.reader.dir('/sys/class/net')
    for (const n of ifaces) {
      const rx = await c.reader.num(`/sys/class/net/${n}/statistics/rx_bytes`)
      const tx = await c.reader.num(`/sys/class/net/${n}/statistics/tx_bytes`)
      if (rx === undefined || tx === undefined) continue
      counters[n] = { rx, tx }
      const old = p?.counters[n] // an interface that just appeared has no baseline: no rate yet
      if (!old) continue
      for (const [metric, a, b, file] of [['network.rx_rate', old.rx, rx, 'rx_bytes'], ['network.tx_rate', old.tx, tx, 'tx_bytes']] as const) {
        const r = counterRate(a, b, dt)
        if (r.reset) resets++
        else if (r.value !== undefined) readings.push({ ref: { key: `net:${n}` }, metric, value: r.value, unit: 'B/s', source: `/sys/class/net/${n}/statistics/${file}` })
      }
    }
    if (!ifaces.length) return { readings: [], status: 'unavailable', message: 'No network interfaces', next: undefined }
    return { readings, status: 'ok', counterResets: resets, next: { at: c.monoMs, counters } satisfies NetState }
  }
}

// ---------------------------------------------------------------------------------------------
// Disk I/O from /sys/block/<disk>/stat
// ---------------------------------------------------------------------------------------------

interface DiskStat { readSectors: number; writeSectors: number; ioTicksMs: number }
interface DiskState { at: number; disks: Record<string, DiskStat> }

/** Fields per Documentation/block/stat: [2] sectors read, [6] sectors written, [9] io_ticks (ms busy). */
export function parseBlockStat(text: string): DiskStat | undefined {
  const f = text.trim().split(/\s+/).map(Number)
  if (f.length < 10 || f.slice(0, 10).some((n) => !Number.isFinite(n))) return undefined
  return { readSectors: f[2]!, writeSectors: f[6]!, ioTicksMs: f[9]! }
}

const WHOLE_DISK = /^(sd[a-z]+|nvme\d+n\d+|vd[a-z]+|hd[a-z]+|mmcblk\d+|xvd[a-z]+)$/

export const linuxDiskProvider: MetricProvider = {
  id: 'metrics.linux.disk',
  title: 'Disk I/O',
  platforms: ['linux'],
  metrics: [
    spec('disk.read_rate', 'B/s', 'Data read from the device (sectors × 512)', '/sys/block/<disk>/stat'),
    spec('disk.write_rate', 'B/s', 'Data written to the device (sectors × 512)', '/sys/block/<disk>/stat'),
    spec('disk.busy', '%', 'Share of time the device had I/O in flight (io_ticks) — not capacity', '/sys/block/<disk>/stat')
  ],
  isSupported: (c) => c.reader.exists('/sys/block'),
  async sample(c, prev): Promise<ProviderOutput> {
    const p = prev as DiskState | undefined
    const dt = p ? c.monoMs - p.at : undefined
    const disks: DiskState['disks'] = {}
    const readings: MetricReading[] = []
    let resets = 0
    const names = (await c.reader.dir('/sys/block')).filter((n) => WHOLE_DISK.test(n))
    for (const n of names) {
      const txt = await c.reader.text(`/sys/block/${n}/stat`)
      const cur = txt ? parseBlockStat(txt) : undefined
      if (!cur) continue
      disks[n] = cur
      const old = p?.disks[n]
      if (!old || dt === undefined) continue
      const ref = { identifier: { kind: 'block_device', value: n } }
      const src = `/sys/block/${n}/stat`
      const rd = counterRate(old.readSectors, cur.readSectors, dt)
      const wr = counterRate(old.writeSectors, cur.writeSectors, dt)
      const ticks = counterRate(old.ioTicksMs, cur.ioTicksMs, dt)
      if (rd.reset || wr.reset || ticks.reset) { resets++; continue }
      if (rd.value !== undefined) readings.push({ ref, metric: 'disk.read_rate', value: rd.value * 512, unit: 'B/s', source: src })
      if (wr.value !== undefined) readings.push({ ref, metric: 'disk.write_rate', value: wr.value * 512, unit: 'B/s', source: src })
      const busy = ratioPercent(cur.ioTicksMs - old.ioTicksMs, dt)
      if (busy !== undefined) readings.push({ ref, metric: 'disk.busy', value: busy, unit: '%', source: src })
    }
    if (!names.length) return { readings: [], status: 'unavailable', message: 'No physical block devices exposed', next: undefined }
    return { readings, status: 'ok', counterResets: resets, next: { at: c.monoMs, disks } satisfies DiskState }
  }
}

// ---------------------------------------------------------------------------------------------
// Battery from /sys/class/power_supply/BAT*
// ---------------------------------------------------------------------------------------------

export const linuxBatteryProvider: MetricProvider = {
  id: 'metrics.linux.battery',
  title: 'Battery',
  platforms: ['linux'],
  metrics: [
    spec('battery.charge', '%', 'Charge level reported by the battery driver', '/sys/class/power_supply/<bat>/capacity'),
    spec('battery.power', 'W', 'Charge (+) or discharge (−) power; only when the driver exposes power_now or current×voltage', '/sys/class/power_supply/<bat>/power_now')
  ],
  isSupported: async (c) => (await c.reader.dir('/sys/class/power_supply')).length > 0,
  async sample(c): Promise<ProviderOutput> {
    const readings: MetricReading[] = []
    let found = 0
    for (const n of await c.reader.dir('/sys/class/power_supply')) {
      const base = `/sys/class/power_supply/${n}`
      if ((await c.reader.text(`${base}/type`)) !== 'Battery') continue
      found++
      const ref = { key: `power:${n}` }
      const cap = await c.reader.num(`${base}/capacity`)
      if (cap !== undefined) readings.push({ ref, metric: 'battery.charge', value: cap, unit: '%', source: `${base}/capacity` })
      const status = await c.reader.text(`${base}/status`)
      let uw = await c.reader.num(`${base}/power_now`)
      let src = `${base}/power_now`
      if (uw === undefined) {
        const ua = await c.reader.num(`${base}/current_now`)
        const uv = await c.reader.num(`${base}/voltage_now`)
        if (ua !== undefined && uv !== undefined) { uw = (Math.abs(ua) * uv) / 1_000_000; src = `${base}/current_now × voltage_now` }
      }
      // Sign comes from the reported status; with an unknown status the direction is not guessed.
      if (uw !== undefined && (status === 'Charging' || status === 'Discharging')) {
        const w = Math.abs(uw) / 1_000_000
        readings.push({ ref, metric: 'battery.power', value: status === 'Charging' ? w : -w, unit: 'W', source: src })
      }
    }
    if (!found) return { readings: [], status: 'unavailable', message: 'No battery present', next: undefined }
    return { readings, status: 'ok', next: undefined }
  }
}

// ---------------------------------------------------------------------------------------------
// Temperatures and fans from hwmon
// ---------------------------------------------------------------------------------------------

interface HwmonChannel { key: string; metric: string; unit: string; divisor: number; path: string }
interface ThermalState { discoveredAt: number; channels: HwmonChannel[] }
const REDISCOVER_MS = 60_000

async function discoverHwmon(c: SampleContext): Promise<HwmonChannel[]> {
  const out: HwmonChannel[] = []
  for (const h of await c.reader.dir('/sys/class/hwmon')) {
    const base = `/sys/class/hwmon/${h}`
    const files = await c.reader.dir(base)
    const inputs = files.filter((f) => /^(temp|fan)\d+_input$/.test(f))
    if (!inputs.length) continue
    const { key } = await hwmonIdentity(c.reader, h)
    for (const f of inputs) {
      const idx = f.replace('_input', '')
      const label = (await c.reader.text(`${base}/${idx}_label`)) ?? idx
      const isTemp = idx.startsWith('temp')
      // Same naming as the sensors collector's properties so the UI can line the two up.
      out.push({ key, metric: `${isTemp ? 'temperature' : 'fan'}:${label}`, unit: isTemp ? '°C' : 'RPM', divisor: isTemp ? 1000 : 1, path: `${base}/${f}` })
    }
  }
  return out
}

export const linuxThermalProvider: MetricProvider = {
  id: 'metrics.linux.thermal',
  title: 'Temperatures and fans',
  platforms: ['linux'],
  metrics: [
    spec('temperature:<sensor>', '°C', 'Temperature reported by a hwmon sensor', '/sys/class/hwmon/hwmonN/tempN_input'),
    spec('fan:<sensor>', 'RPM', 'Fan speed reported by a hwmon sensor', '/sys/class/hwmon/hwmonN/fanN_input')
  ],
  isSupported: (c) => c.reader.exists('/sys/class/hwmon'),
  async sample(c, prev): Promise<ProviderOutput> {
    let st = prev as ThermalState | undefined
    // Channel discovery is cached: hwmon layout does not change between ticks.
    if (!st || c.monoMs - st.discoveredAt > REDISCOVER_MS) st = { discoveredAt: c.monoMs, channels: await discoverHwmon(c) }
    const readings: MetricReading[] = []
    let missing = 0
    for (const ch of st.channels) {
      const raw = await c.reader.num(ch.path)
      if (raw === undefined) { missing++; continue }
      readings.push({ ref: { key: ch.key }, metric: ch.metric, value: raw / ch.divisor, unit: ch.unit, source: ch.path })
    }
    if (!st.channels.length) return { readings: [], status: 'unavailable', message: 'No temperature or fan sensors exposed', next: st }
    return { readings, status: missing ? 'partial' : 'ok', message: missing ? `${missing} sensor channel(s) unreadable this tick` : undefined, next: st }
  }
}



// ---------------------------------------------------------------------------------------------
// GPU from DRM sysfs. Only counters the driver actually exposes are sampled (i915/xe frequency,
// amdgpu busy % and VRAM); there is no vendor-tool dependency and nothing is derived from other values.
// ---------------------------------------------------------------------------------------------

export const linuxGpuProvider: MetricProvider = {
  id: 'metrics.linux.gpu',
  title: 'GPU (DRM sysfs)',
  platforms: ['linux'],
  metrics: [
    spec('gpu.frequency', 'MHz', 'Actual graphics clock reported by the driver (i915/xe gt_act_freq_mhz, else gt_cur_freq_mhz)', '/sys/class/drm/<card>/gt_act_freq_mhz'),
    spec('gpu.utilization', '%', 'Graphics engine busy share (amdgpu only)', '/sys/class/drm/<card>/device/gpu_busy_percent'),
    spec('gpu.memory_used', 'B', 'Dedicated VRAM in use (amdgpu only)', '/sys/class/drm/<card>/device/mem_info_vram_used')
  ],
  isSupported: async (c) => (await c.reader.dir('/sys/class/drm')).some((n) => /^card\d+$/.test(n)),
  async sample(c): Promise<ProviderOutput> {
    const readings: MetricReading[] = []
    for (const card of (await c.reader.dir('/sys/class/drm')).filter((n) => /^card\d+$/.test(n))) {
      const base = `/sys/class/drm/${card}`
      const addr = (await c.reader.real(`${base}/device`))?.split('/').pop()
      if (!addr || !/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.\d$/i.test(addr)) continue
      const ref = { key: `pci:${addr.toLowerCase()}` }
      const act = await c.reader.num(`${base}/gt_act_freq_mhz`)
      const cur = act === undefined ? await c.reader.num(`${base}/gt_cur_freq_mhz`) : undefined
      // Reported 0 MHz means the GT is in a sleep state (RC6), which is a real reading; negative values are invalid.
      const f = act ?? cur
      if (f !== undefined && f >= 0) readings.push({ ref, metric: 'gpu.frequency', value: f, unit: 'MHz', source: `${base}/${act !== undefined ? 'gt_act_freq_mhz' : 'gt_cur_freq_mhz'}` })
      const busy = await c.reader.num(`${base}/device/gpu_busy_percent`)
      if (busy !== undefined && busy >= 0 && busy <= 100) readings.push({ ref, metric: 'gpu.utilization', value: busy, unit: '%', source: `${base}/device/gpu_busy_percent` })
      const vram = await c.reader.num(`${base}/device/mem_info_vram_used`)
      if (vram !== undefined && vram >= 0) readings.push({ ref, metric: 'gpu.memory_used', value: vram, unit: 'B', source: `${base}/device/mem_info_vram_used` })
    }
    if (!readings.length) return { readings, status: 'unavailable', message: 'No DRM counters exposed by the GPU driver', next: undefined }
    return { readings, status: 'ok', next: undefined }
  }
}

export const linuxProviders: MetricProvider[] = [linuxCpuProvider, linuxMemoryProvider, linuxNetworkProvider, linuxDiskProvider, linuxBatteryProvider, linuxThermalProvider, linuxGpuProvider]
