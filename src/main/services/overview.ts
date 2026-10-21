import type { Overview } from '@shared/schemas'
import type { InventoryRepo } from '../database/repositories'

/** Compose the overview screen from persisted inventory only (no live OS calls). */
export function buildOverview(repo: InventoryRepo, openFindings = 0): Overview {
  const devices = repo.list({})
  const prop = (id: string, key: string): string | undefined => {
    const d = repo.get(id, [])
    const p = d?.properties.find((x) => x.key === key)
    return p ? `${p.value}${p.unit && p.unit !== 'B' ? ' ' + p.unit : ''}` : undefined
  }
  const system: Record<string, string> = {}
  const sys = devices.find((d) => d.category === 'system')
  if (sys) {
    system['Machine'] = sys.name
    for (const [label, key] of [['Operating system', 'os_name'], ['Kernel', 'kernel'], ['Architecture', 'architecture']] as const) {
      const v = prop(sys.id, key)
      if (v) system[label] = v
    }
  }
  const board = devices.find((d) => d.category === 'motherboard')
  if (board) system['Motherboard'] = board.name
  const cpu = devices.find((d) => d.category === 'cpu')
  if (cpu) {
    const th = prop(cpu.id, 'logical_processors')
    const co = prop(cpu.id, 'physical_cores')
    system['Processor'] = cpu.name + (co && th ? ` — ${co} cores / ${th} threads` : '')
  }
  const mem = devices.find((d) => d.category === 'memory' && d.subtype === 'total')
  const memBytes = mem ? Number(repo.get(mem.id, [])?.properties.find((p) => p.key === 'total_bytes')?.value) : NaN
  if (Number.isFinite(memBytes)) system['Memory'] = `${(memBytes / 2 ** 30).toFixed(1)} GiB`
  const modules = devices.filter((d) => d.category === 'memory' && d.subtype === 'module').length
  if (modules) system['Memory modules'] = String(modules)

  const storage: Overview['storage'] = []
  for (const d of devices.filter((x) => x.category === 'storage' && x.subtype === 'partition')) {
    const detail = repo.get(d.id, [])
    const get = (k: string) => detail?.properties.find((p) => p.key === k)?.value
    const mount = get('mount_point')
    const total = Number(get('filesystem_total_bytes') ?? NaN)
    const free = Number(get('free_bytes') ?? NaN)
    if (typeof mount === 'string' && Number.isFinite(total) && Number.isFinite(free) && total > 0) {
      storage.push({ name: d.name, mount, fs: String(get('filesystem') ?? ''), totalBytes: total, usedBytes: total - free })
    }
  }
  const network = devices
    .filter((d) => d.category === 'network' && d.subtype !== 'loopback')
    .map((d) => ({ name: d.name, state: repo.get(d.id, [])?.properties.find((p) => p.key === 'operstate')?.value?.toString() ?? 'unknown', kind: d.subtype ?? 'other' }))
  return { system, counts: repo.counts(), storage, network, openFindings }
}
