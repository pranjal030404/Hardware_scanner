import type { DeviceObservation, Limitation } from '@shared/schemas'
import { meaningful, ObservationBuilder, type CollectContext } from '../core/context'
import type { Collector } from '../core/types'
import { finish } from './shared'
import { parseCpuList } from './cpu-topology'

const ID = 'linux.memory'

export interface MemoryModule {
  locator?: string
  bank?: string
  sizeMiB?: number
  speedMTs?: number
  configuredSpeedMTs?: number
  manufacturer?: string
  partNumber?: string
  serial?: string
  type?: string
  formFactor?: string
}

const MEM_TYPES: Record<number, string> = { 0x12: 'DDR', 0x13: 'DDR2', 0x18: 'DDR3', 0x1a: 'DDR4', 0x1b: 'LPDDR', 0x1c: 'LPDDR2', 0x1d: 'LPDDR3', 0x1e: 'LPDDR4', 0x22: 'DDR5', 0x23: 'LPDDR5' }
const FORM_FACTORS: Record<number, string> = { 0x09: 'DIMM', 0x0d: 'SODIMM', 0x0b: 'RIMM', 0x0c: 'SODIMM', 0x0f: 'FB-DIMM', 0x10: 'Die' }

/** Parse one raw SMBIOS Type 17 (Memory Device) structure. Returns undefined for an empty slot or a bad structure. */
export function parseSmbiosType17(raw: Buffer): MemoryModule | undefined {
  if (raw.length < 0x15 || raw[0] !== 17) return undefined
  const len = raw[1]!
  if (len < 0x15 || raw.length < len) return undefined
  const strings = raw
    .subarray(len)
    .toString('latin1')
    .split('\0')
  const str = (idx: number): string | undefined => (idx > 0 ? meaningful(strings[idx - 1]) : undefined)
  const sizeRaw = raw.readUInt16LE(0x0c)
  let sizeMiB: number | undefined
  if (sizeRaw === 0) return undefined // empty slot
  if (sizeRaw === 0xffff) sizeMiB = undefined
  else if (sizeRaw === 0x7fff && len >= 0x20) sizeMiB = raw.readUInt32LE(0x1c) & 0x7fffffff
  else sizeMiB = sizeRaw & 0x8000 ? (sizeRaw & 0x7fff) / 1024 : sizeRaw
  const m: MemoryModule = {
    sizeMiB,
    formFactor: FORM_FACTORS[raw[0x0e]!],
    locator: str(raw[0x10]!),
    bank: str(raw[0x11]!),
    type: MEM_TYPES[raw[0x12]!],
    manufacturer: len > 0x17 ? str(raw[0x17]!) : undefined,
    serial: len > 0x18 ? str(raw[0x18]!) : undefined,
    partNumber: len > 0x1a ? str(raw[0x1a]!) : undefined
  }
  const speed = raw.readUInt16LE(0x15)
  if (speed && speed !== 0xffff) m.speedMTs = speed
  if (len >= 0x22) {
    const cs = raw.readUInt16LE(0x20)
    if (cs && cs !== 0xffff) m.configuredSpeedMTs = cs
  }
  return m
}

export function parseMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line)
    if (m) out[m[1]!] = parseInt(m[2]!, 10) * 1024
  }
  return out
}

export interface SwapDevice { name: string; type: string; sizeBytes: number; usedBytes: number; priority: number }

/** /proc/swaps (sizes in KiB). Malformed rows are skipped. */
export function parseSwaps(text: string): SwapDevice[] {
  const out: SwapDevice[] = []
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/)
    if (f.length < 5) continue
    const [name, type, size, used, prio] = [f[0]!, f[1]!, Number(f[2]), Number(f[3]), Number(f[4])]
    if (![size, used, prio].every(Number.isFinite)) continue
    out.push({ name, type, sizeBytes: size * 1024, usedBytes: used * 1024, priority: prio })
  }
  return out
}

/** A NUMA node's own meminfo: lines look like `Node 0 MemTotal:  16384 kB`. */
export function parseNodeMeminfo(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of text.split('\n')) {
    const m = /^Node\s+\d+\s+(\w+(?:\(\w+\))?):\s+(\d+)\s*kB/.exec(line)
    if (m) out[m[1]!] = parseInt(m[2]!, 10) * 1024
  }
  return out
}

/** `10 21 21` → distances to nodes 0,1,2 in kernel units (10 = local). */
export function parseNodeDistance(text: string | undefined): number[] | undefined {
  if (text === undefined) return undefined
  const v = text.trim().split(/\s+/).map(Number)
  return v.length && v.every((n) => Number.isInteger(n) && n >= 0) ? v : undefined
}

/** `always [madvise] never` → the bracketed (active) choice. */
export function activeChoice(text: string | undefined): string | undefined {
  return text ? /\[([^\]]+)\]/.exec(text)?.[1] : undefined
}

export const linuxMemory: Collector = {
  id: ID,
  version: '1.1.0',
  platforms: ['linux'],
  categories: ['memory'],
  permissions: ['Module details (SMBIOS type 17) are readable only by root via /sys/firmware/dmi/entries'],
  method: '/proc/meminfo + SMBIOS entries in /sys/firmware/dmi/entries',
  timeoutMs: 5000,
  retries: 1,
  isSupported: (ctx) => ctx.reader.exists('/proc/meminfo'),
  async collect(ctx: CollectContext) {
    const r = ctx.reader
    const at = ctx.host.now()
    const meminfo = await r.text('/proc/meminfo')
    if (!meminfo) return { outcome: 'unavailable' as const, observations: [], limitations: [{ kind: 'missing_interface' as const, message: '/proc/meminfo could not be read' }] }
    const mi = parseMeminfo(meminfo)
    const out: DeviceObservation[] = []
    out.push(
      new ObservationBuilder(ID, 'memory:system', 'memory', 'System memory', at, { sourceProperty: 'derived', evidence: 'derived' })
        .status('ok')
        .field('subtype', 'total', 'derived', 'derived')
        .prop('total_bytes', mi['MemTotal'], '/proc/meminfo MemTotal', { unit: 'B', evidence: 'measured' })
        .prop('swap_total_bytes', mi['SwapTotal'], '/proc/meminfo SwapTotal', { unit: 'B', evidence: 'measured' })
        .prop('available_bytes', mi['MemAvailable'], '/proc/meminfo MemAvailable', { unit: 'B', volatile: true, evidence: 'measured' })
        .prop('hugepage_size_bytes', mi['Hugepagesize'], '/proc/meminfo Hugepagesize', { unit: 'B' })
        .prop('hugepages_total', hugeCount(meminfo, 'HugePages_Total'), '/proc/meminfo HugePages_Total')
        .prop('hugepages_free', hugeCount(meminfo, 'HugePages_Free'), '/proc/meminfo HugePages_Free', { volatile: true })
        .prop('transparent_hugepages', activeChoice(await r.text('/sys/kernel/mm/transparent_hugepage/enabled')), '/sys/kernel/mm/transparent_hugepage/enabled')
        .prop('overcommit_policy', await r.text('/proc/sys/vm/overcommit_memory'), '/proc/sys/vm/overcommit_memory')
        .prop('swappiness', await r.num('/proc/sys/vm/swappiness'), '/proc/sys/vm/swappiness')
        .build()
    )
    const limitations: Limitation[] = []

    // Swap devices (zram, partitions, files) as the kernel reports them.
    const swaps = parseSwaps((await r.text('/proc/swaps')) ?? '')
    swaps.forEach((sw, i) => {
      out.push(
        new ObservationBuilder(ID, `memory:swap:${sw.name}`, 'memory', `Swap ${sw.name}`, at, { sourceProperty: '/proc/swaps name' })
          .status('ok')
          .field('subtype', 'swap', 'derived', 'derived')
          .prop('swap_type', sw.type, '/proc/swaps type')
          .prop('size_bytes', sw.sizeBytes, '/proc/swaps size', { unit: 'B', evidence: 'measured' })
          .prop('used_bytes', sw.usedBytes, '/proc/swaps used', { unit: 'B', evidence: 'measured', volatile: true })
          .prop('priority', sw.priority, '/proc/swaps priority')
          .prop('compressed_ram', sw.name.includes('zram') ? true : undefined, 'device name contains zram', { evidence: 'derived' })
          .rel('memory:system', 'logical_parent', '/proc/swaps')
          .build()
      )
      void i
    })

    // NUMA nodes: memory and CPUs per node, with kernel-reported distances.
    const nodeNames = (await r.dir('/sys/devices/system/node')).filter((d) => /^node\d+$/.test(d)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
    for (const n of nodeNames) {
      const base = `/sys/devices/system/node/${n}`
      const nm = parseNodeMeminfo((await r.text(`${base}/meminfo`)) ?? '')
      const cpus = parseCpuList(await r.text(`${base}/cpulist`))
      const dist = parseNodeDistance(await r.text(`${base}/distance`))
      out.push(
        new ObservationBuilder(ID, `numa:node:${n.slice(4)}`, 'memory', `NUMA node ${n.slice(4)}`, at, { sourceProperty: base })
          .status('ok')
          .field('subtype', 'numa_node', 'derived', 'derived')
          .prop('memory_total_bytes', nm['MemTotal'], `${base}/meminfo MemTotal`, { unit: 'B', evidence: 'measured' })
          .prop('cpus', cpus ? (cpus.length ? `${cpus.length} logical (${cpus[0]}–${cpus[cpus.length - 1]})` : 'none (memory-only node)') : undefined, `${base}/cpulist`)
          .prop('cpu_count', cpus?.length, `${base}/cpulist`)
          .prop('distances', dist?.join(' '), `${base}/distance`)
          .prop('hugepages_2048kB', await r.num(`${base}/hugepages/hugepages-2048kB/nr_hugepages`), `${base}/hugepages/hugepages-2048kB/nr_hugepages`)
          .rel('memory:system', 'logical_parent', base)
          .build()
      )
    }
    if (!nodeNames.length) limitations.push({ kind: 'missing_interface', message: 'NUMA topology (/sys/devices/system/node) is not exposed.', target: '/sys/devices/system/node' })

    // ECC / memory-controller error counters exist only when an EDAC driver is loaded for the platform.
    const mcs = (await r.dir('/sys/devices/system/edac/mc')).filter((d) => /^mc\d+$/.test(d))
    if (mcs.length) {
      let ce = 0
      let ue = 0
      let have = false
      for (const mc of mcs) {
        const c = await r.num(`/sys/devices/system/edac/mc/${mc}/ce_count`)
        const u = await r.num(`/sys/devices/system/edac/mc/${mc}/ue_count`)
        if (c !== undefined) { ce += c; have = true }
        if (u !== undefined) { ue += u; have = true }
      }
      const sys = out[0]!
      const add = (key: string, value: number, sp: string): void => {
        sys.properties.push({ key, value, source: ID, sourceProperty: sp, evidence: 'measured', observedAt: at.toISOString(), volatile: true })
      }
      sys.properties.push({ key: 'edac_memory_controllers', value: mcs.length, source: ID, sourceProperty: '/sys/devices/system/edac/mc/mcN', evidence: 'os_reported', observedAt: at.toISOString() })
      if (have) {
        add('ecc_correctable_errors', ce, '/sys/devices/system/edac/mc/mcN/ce_count (sum, since boot)')
        add('ecc_uncorrectable_errors', ue, '/sys/devices/system/edac/mc/mcN/ue_count (sum, since boot)')
      }
    } else {
      limitations.push({ kind: 'info', message: 'ECC status and memory-error counters are not exposed on this machine (no EDAC memory controller registered). This does not mean the memory is or is not ECC.', target: '/sys/devices/system/edac/mc' })
    }

    const entries = (await r.dir('/sys/firmware/dmi/entries')).filter((e) => e.startsWith('17-'))
    let modules = 0
    let unreadable = 0
    for (const e of entries) {
      const raw = await r.bytes(`/sys/firmware/dmi/entries/${e}/raw`)
      if (!raw) {
        unreadable++
        continue
      }
      const mod = parseSmbiosType17(raw)
      if (!mod) continue
      modules++
      const slot = mod.locator ?? e
      const name = [mod.manufacturer, mod.sizeMiB ? `${Math.round(mod.sizeMiB / 1024)} GB` : undefined, mod.type].filter(Boolean).join(' ') || `Memory module ${slot}`
      out.push(
        new ObservationBuilder(ID, `memory:module:${e}`, 'memory', name, at, { sourceProperty: 'SMBIOS type 17', evidence: 'os_reported' })
          .status('ok')
          .field('subtype', 'module', 'SMBIOS type 17', 'derived')
          .field('manufacturer', mod.manufacturer, `${e}/raw manufacturer`)
          .field('model', mod.partNumber, `${e}/raw part number`)
          .field('busType', mod.type, `${e}/raw memory type`)
          .id('serial', mod.serial, true)
          .id('dmi_entry', e)
          .prop('locator', mod.locator, `${e}/raw device locator`)
          .prop('bank', mod.bank, `${e}/raw bank locator`)
          .prop('size_bytes', mod.sizeMiB !== undefined ? Math.round(mod.sizeMiB * 1024 * 1024) : undefined, `${e}/raw size`, { unit: 'B' })
          .prop('form_factor', mod.formFactor, `${e}/raw form factor`)
          .prop('speed', mod.speedMTs, `${e}/raw speed`, { unit: 'MT/s' })
          .prop('configured_speed', mod.configuredSpeedMTs, `${e}/raw configured speed`, { unit: 'MT/s' })
          .rel('memory:system', 'logical_parent', 'SMBIOS type 17', { directness: 'inferred', confidence: 0.9 })
          .build()
      )
    }
    if (!entries.length && !r.denied.size) {
      limitations.push({ kind: 'missing_interface' as const, message: 'No SMBIOS memory device entries exposed (virtual machine or firmware without SMBIOS).', target: '/sys/firmware/dmi/entries' })
    } else if (unreadable && !modules) {
      limitations.push({
        kind: 'permission' as const,
        message: 'Installed memory modules (slots, speed, vendor) cannot be read without elevated privileges; only total capacity is shown.',
        target: '/sys/firmware/dmi/entries/17-*/raw',
        remedy: 'Run the application with read access to /sys/firmware/dmi/entries (typically root). Not required for any other feature.'
      })
    }
    return finish(ctx, out, limitations)
  }
}

function hugeCount(text: string, key: string): number | undefined {
  const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text)
  return m ? parseInt(m[1]!, 10) : undefined
}
