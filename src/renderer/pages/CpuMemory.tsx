import { useMemo, useState } from 'react'
import type { DeviceDetail, MetricSeriesData, MetricSeriesSummary, Property } from '@shared/schemas'
import type { Navigate } from '../App'
import { formatMetric } from '../components/chart-geometry'
import { TimeChart } from '../components/TimeChart'
import { Badge, Empty, ErrorBox, PageHeader, Spinner, formatValue } from '../components/ui'
import { useLoad } from '../hooks/useLoad'
import { selKey, useMetrics, type SeriesSel } from '../hooks/useMetrics'
import { api } from '../services/api'

const WINDOWS = [{ l: '1 min', s: 60 }, { l: '5 min', s: 300 }, { l: '15 min', s: 900 }, { l: '1 hour', s: 3600 }]

/** A property with its provenance in the tooltip: where the value came from and how it was obtained. */
function Kv({ label, p, fmt }: { label: string; p: Property | undefined; fmt?: (v: string | number | boolean) => string }): JSX.Element | null {
  if (!p) return null
  return (
    <div title={`${p.source} · ${p.sourceProperty} · ${p.evidence.replace('_', ' ')}`}>
      <dt>{label}</dt>
      <dd>{fmt ? fmt(p.value) : formatValue(p.value, p.unit)}{p.evidence === 'derived' && <span className="muted small"> (derived)</span>}</dd>
    </div>
  )
}
const find = (d: DeviceDetail | undefined, k: string): Property | undefined => d?.properties.find((p) => p.key === k)
const bytes = (v: string | number | boolean): string => formatMetric(Number(v), 'B')

function LiveBar({ value, stale }: { value: number | null; stale: boolean }): JSX.Element {
  if (value === null) return <span className="muted">—</span>
  return (
    <span className="inline" role="img" aria-label={`${value.toFixed(0)} percent${stale ? ', stale' : ''}`}>
      <span style={{ display: 'inline-block', width: 90, height: 8, background: 'var(--panel-2)', borderRadius: 4, overflow: 'hidden', opacity: stale ? 0.45 : 1 }}>
        <span style={{ display: 'block', width: `${Math.min(100, Math.max(0, value))}%`, height: '100%', background: 'var(--accent)' }} />
      </span>
      <span className="mono small" style={{ minWidth: 38, textAlign: 'right' }}>{value.toFixed(0)}%</span>
    </span>
  )
}

function Chart({ title, source, unit, data, toMs, windowMs, yMax, stale }: { title: string; source: string; unit: string; data: { id: string; label: string; d?: MetricSeriesData; dashed?: boolean }[]; toMs: number; windowMs: number; yMax?: number; stale: boolean }): JSX.Element {
  const have = data.filter((x) => x.d && x.d.points.length)
  return (
    <section className="card metric-card" aria-label={title}>
      <div className="metric-head"><h2>{title}</h2><Badge tone={have.length ? (stale ? 'warn' : 'ok') : 'muted'}>{have.length ? (stale ? 'stale' : 'live') : 'unavailable'}</Badge></div>
      {have.length ? (
        <TimeChart ariaLabel={`${title} over time`} unit={unit} yMin={0} yMax={yMax} toMs={toMs} windowMs={windowMs} stale={stale || have.some((x) => x.d!.stale)}
          series={have.map((x) => ({ id: x.id, label: x.label, points: x.d!.points, intervalMs: x.d!.intervalMs, dashed: x.dashed }))} />
      ) : (
        <p className="muted small">Not collected on this machine, or sampling has not produced data yet. Nothing is estimated.</p>
      )}
      <p className="muted small source">Source: <span className="mono">{source}</span></p>
    </section>
  )
}

export function CpuMemoryPage({ navigate }: { navigate: Navigate }): JSX.Element {
  const [windowSec, setWindowSec] = useState(300)
  const cpuList = useLoad(() => api.listDevices({ category: 'cpu' }), [])
  const memList = useLoad(() => api.listDevices({ category: 'memory' }), [])
  const packages = (cpuList.data ?? []).filter((d) => d.subtype !== 'core')
  const cores = (cpuList.data ?? []).filter((d) => d.subtype === 'core')
  const sysMem = (memList.data ?? []).find((d) => d.key === 'memory:system')
  const swaps = (memList.data ?? []).filter((d) => d.subtype === 'swap')
  const nodes = (memList.data ?? []).filter((d) => d.subtype === 'numa_node')
  const wantIds = [...packages.map((p) => p.id), ...cores.map((c) => c.id), ...(sysMem ? [sysMem.id] : []), ...swaps.map((s) => s.id), ...nodes.map((n) => n.id)]
  const details = useLoad(async () => new Map((await Promise.all(wantIds.map((id) => api.getDevice(id)))).filter((d): d is DeviceDetail => !!d).map((d) => [d.device.id, d] as const)), [wantIds.join()], false)
  const health = useLoad(() => api.collectorHealth(), [])

  const first = useMetrics([], windowSec)
  const all: MetricSeriesSummary[] = first.status?.series ?? []
  const one = (m: string): MetricSeriesSummary | undefined => all.find((s) => s.metric === m)
  const sel = useMemo<SeriesSel[]>(() => {
    const names = ['cpu.user_pct', 'cpu.system_pct', 'cpu.iowait_pct', 'cpu.irq_pct', 'cpu.steal_pct', 'cpu.load_1m', 'cpu.load_5m', 'cpu.load_15m', 'cpu.context_switches', 'cpu.interrupts', 'cpu.thermal_throttle_events',
      'pressure.cpu_some_avg10', 'pressure.memory_some_avg10', 'pressure.memory_full_avg10', 'pressure.io_some_avg10', 'pressure.io_full_avg10',
      'memory.swap_utilization', 'memory.page_in_rate', 'memory.page_out_rate', 'memory.swap_in_rate', 'memory.swap_out_rate', 'memory.major_faults_rate']
    return names.flatMap((m) => { const s = all.find((x) => x.metric === m); return s ? [{ metric: m, deviceId: s.deviceId }] : [] })
  }, [all.map((s) => s.metric + s.deviceId).join('|')]) // eslint-disable-line react-hooks/exhaustive-deps
  const live = useMetrics(sel, windowSec)
  const st = live.status ?? first.status
  const d = (m: string): MetricSeriesData | undefined => { const s = one(m); return s ? live.data.get(selKey({ metric: m, deviceId: s.deviceId })) : undefined }
  const stale = !!st?.paused
  const windowMs = windowSec * 1000
  const toMs = live.now

  const logical = all.filter((s) => s.metric.startsWith('cpu.logical_utilization:'))
  const freq = new Map(all.filter((s) => s.metric.startsWith('cpu.frequency:')).map((s) => [s.metric.slice('cpu.frequency:'.length), s]))
  const cpuNum = (s: MetricSeriesSummary): number => Number(s.metric.slice('cpu.logical_utilization:cpu'.length))
  const memHealth = health.data?.find((h) => h.id === 'linux.memory')
  const eccNote = memHealth?.limitations.find((l) => /ECC/.test(l.message))

  if (cpuList.error) return <><PageHeader title="CPU & Memory" /><ErrorBox message={cpuList.error} onRetry={cpuList.reload} /></>
  if (cpuList.loading && !cpuList.data) return <><PageHeader title="CPU & Memory" /><Spinner /></>
  if (!packages.length) return <><PageHeader title="CPU & Memory" /><Empty title="No processor data yet">Run a scan from the Overview page; the CPU collector has not reported anything.</Empty></>

  const D = details.data
  return (
    <>
      <PageHeader
        title="CPU & Memory"
        subtitle="Topology, caches, frequency policy, pressure and paging — each value names the interface it came from (hover for provenance)"
        actions={<select value={windowSec} onChange={(e) => setWindowSec(Number(e.target.value))} aria-label="Time window">{WINDOWS.map((w) => <option key={w.s} value={w.s}>{w.l}</option>)}</select>}
      />
      {st?.paused && <div className="banner banner-warn" role="status">Sampling is paused: charts and live values are stale.</div>}
      {details.error && <ErrorBox message={details.error} onRetry={details.reload} />}

      {packages.map((p) => {
        const dd = D?.get(p.id)
        const caches = ['l1d', 'l1i', 'l2', 'l3'].filter((c) => find(dd, `cache_${c}_size`))
        return (
          <section className="card" key={p.id} aria-label={`Processor package ${p.name}`}>
            <h2><button className="link" onClick={() => navigate({ page: 'device', id: p.id, from: { page: 'cpu' } })}>{p.name}</button></h2>
            {!dd ? <Spinner /> : (
              <div className="grid">
                <dl className="kv">
                  <Kv label="Cores" p={find(dd, 'topology_cores') ?? find(dd, 'physical_cores')} />
                  <Kv label="Logical processors" p={find(dd, 'logical_processors')} />
                  <Kv label="Threads per core" p={find(dd, 'threads_per_core')} />
                  <Kv label="Dies" p={find(dd, 'dies')} />
                  <Kv label="NUMA nodes" p={find(dd, 'numa_nodes')} />
                  <Kv label="Hybrid layout" p={find(dd, 'hybrid_layout')} />
                  <Kv label="Offline CPUs" p={find(dd, 'offline_cpus')} />
                  <Kv label="Microcode" p={find(dd, 'microcode')} />
                  <Kv label="Virtualisation" p={find(dd, 'flag_vmx') ?? find(dd, 'flag_svm')} fmt={(v) => (v ? 'VT-x / AMD-V flag present' : 'not reported')} />
                </dl>
                <dl className="kv">
                  <Kv label="Frequency driver" p={find(dd, 'scaling_driver')} />
                  <Kv label="Governor" p={find(dd, 'governor')} />
                  <Kv label="Available governors" p={find(dd, 'available_governors')} />
                  <Kv label="Energy preference" p={find(dd, 'energy_performance_preference')} />
                  <Kv label="Boost / turbo" p={find(dd, 'boost_enabled')} fmt={(v) => (v ? 'enabled' : 'disabled')} />
                  <Kv label="Min frequency" p={find(dd, 'min_frequency')} />
                  <Kv label="Max frequency" p={find(dd, 'max_frequency')} />
                  <Kv label="Idle driver" p={find(dd, 'idle_driver')} />
                  <Kv label="Idle states" p={find(dd, 'idle_states')} />
                  {!find(dd, 'scaling_driver') && <div><dt>Frequency</dt><dd className="muted">Not exposed by this OS/interface (no cpufreq).</dd></div>}
                </dl>
                <div>
                  <h3>Caches</h3>
                  {caches.length ? (
                    <table className="table compact">
                      <thead><tr><th>Level</th><th>Size</th><th>Instances</th><th>Shared by</th><th>Ways</th></tr></thead>
                      <tbody>{caches.map((c) => (
                        <tr key={c} title={find(dd, `cache_${c}_size`)?.sourceProperty}>
                          <td>{c.toUpperCase()}</td><td>{bytes(find(dd, `cache_${c}_size`)!.value)}</td><td>{find(dd, `cache_${c}_instances`)?.value ?? '—'}</td>
                          <td>{find(dd, `cache_${c}_shared_by_cpus`)?.value ?? '—'} CPU(s)</td><td>{find(dd, `cache_${c}_ways`)?.value ?? '—'}</td>
                        </tr>))}</tbody>
                    </table>
                  ) : <p className="muted small">Cache hierarchy is not exposed by this OS/interface.</p>}
                </div>
              </div>
            )}
          </section>
        )
      })}

      <section className="card" aria-label="Cores and logical processors">
        <h2>Cores and logical processors <span className="muted small">live values from {one('cpu.logical_utilization:cpu0')?.source ?? '/proc/stat'}</span></h2>
        {!cores.length ? <p className="muted">Per-core topology is not exposed by this OS/interface, so per-processor values are not attributed to any core.</p> : (
          <div className="table-wrap"><table className="table compact">
            <thead><tr><th>Core</th><th>Logical CPU</th><th>NUMA</th><th>Kind</th><th>Utilisation</th><th>Frequency</th></tr></thead>
            <tbody>
              {cores.map((c) => {
                const dd = D?.get(c.id)
                const ids = String(find(dd, 'logical_processors')?.value ?? '').split(', ').filter(Boolean)
                const rows = ids.length ? ids : ['']
                return rows.map((cpu, i) => {
                  const u = logical.find((s) => s.metric === `cpu.logical_utilization:${cpu}` && s.deviceId === c.id)
                  const f = freq.get(cpu)
                  return (
                    <tr key={`${c.id}${cpu}`}>
                      {i === 0 && <td rowSpan={rows.length}><button className="link" onClick={() => navigate({ page: 'device', id: c.id, from: { page: 'cpu' } })}>{c.name}</button></td>}
                      <td className="mono">{cpu || '—'}</td>
                      {i === 0 && <td rowSpan={rows.length}>{String(find(dd, 'numa_node')?.value ?? '—')}</td>}
                      {i === 0 && <td rowSpan={rows.length}>{String(find(dd, 'core_kind')?.value ?? '—')}</td>}
                      <td><LiveBar value={u?.lastValue ?? null} stale={!!u?.stale || stale} /></td>
                      <td className="mono small">{f?.lastValue != null ? `${f.lastValue.toFixed(0)} MHz${f.stale || stale ? ' (stale)' : ''}` : <span className="muted">not exposed</span>}</td>
                    </tr>
                  )
                })
              })}
            </tbody>
          </table></div>
        )}
      </section>

      <div className="grid metrics-grid">
        <Chart title="CPU time split" source="/proc/stat (aggregate)" unit="%" yMax={100} toMs={toMs} windowMs={windowMs} stale={stale}
          data={[{ id: 'u', label: 'User', d: d('cpu.user_pct') }, { id: 's', label: 'System', d: d('cpu.system_pct'), dashed: true }, { id: 'w', label: 'I/O wait', d: d('cpu.iowait_pct') }, { id: 'i', label: 'Interrupts', d: d('cpu.irq_pct'), dashed: true }, { id: 'st', label: 'Steal', d: d('cpu.steal_pct') }]} />
        <Chart title="Resource pressure (PSI, 10 s average)" source="/proc/pressure/{cpu,memory,io} — share of time tasks were stalled" unit="%" yMax={100} toMs={toMs} windowMs={windowMs} stale={stale}
          data={[{ id: 'pc', label: 'CPU', d: d('pressure.cpu_some_avg10') }, { id: 'pm', label: 'Memory', d: d('pressure.memory_some_avg10') }, { id: 'pmf', label: 'Memory (all stalled)', d: d('pressure.memory_full_avg10'), dashed: true }, { id: 'pi', label: 'I/O', d: d('pressure.io_some_avg10') }, { id: 'pif', label: 'I/O (all stalled)', d: d('pressure.io_full_avg10'), dashed: true }]} />
        <Chart title="Load average" source="/proc/loadavg" unit="load" toMs={toMs} windowMs={windowMs} stale={stale}
          data={[{ id: 'l1', label: '1 min', d: d('cpu.load_1m') }, { id: 'l5', label: '5 min', d: d('cpu.load_5m'), dashed: true }, { id: 'l15', label: '15 min', d: d('cpu.load_15m') }]} />
        <Chart title="Context switches and interrupts" source="/proc/stat ctxt, intr (counter deltas)" unit="/s" toMs={toMs} windowMs={windowMs} stale={stale}
          data={[{ id: 'cs', label: 'Context switches', d: d('cpu.context_switches') }, { id: 'in', label: 'Interrupts', d: d('cpu.interrupts'), dashed: true }]} />
        <Chart title="Thermal-throttle events (cumulative since boot)" source="/sys/devices/system/cpu/cpuN/thermal_throttle — a rising line means the CPU reported throttling" unit="count" toMs={toMs} windowMs={windowMs} stale={stale}
          data={[{ id: 'th', label: 'Events', d: d('cpu.thermal_throttle_events') }]} />
      </div>

      <h2 className="section-title">Memory</h2>
      <div className="grid">
        <section className="card" aria-label="System memory">
          <h2>System memory</h2>
          {!sysMem || !D?.get(sysMem.id) ? <Spinner /> : (() => {
            const dd = D.get(sysMem.id)
            return (
              <dl className="kv">
                <Kv label="Installed / usable" p={find(dd, 'total_bytes')} fmt={bytes} />
                <Kv label="Available (as of last scan)" p={find(dd, 'available_bytes')} fmt={bytes} />
                <Kv label="Swap capacity" p={find(dd, 'swap_total_bytes')} fmt={bytes} />
                <Kv label="Transparent huge pages" p={find(dd, 'transparent_hugepages')} />
                <Kv label="Huge pages (total / free)" p={find(dd, 'hugepages_total')} fmt={(v) => `${v} / ${find(dd, 'hugepages_free')?.value ?? '—'} × ${bytes(find(dd, 'hugepage_size_bytes')?.value ?? 0)}`} />
                <Kv label="Swappiness" p={find(dd, 'swappiness')} />
                <div><dt>ECC</dt><dd>{find(dd, 'edac_memory_controllers') ? <>{String(find(dd, 'edac_memory_controllers')!.value)} controller(s) · correctable {String(find(dd, 'ecc_correctable_errors')?.value ?? '—')} · uncorrectable {String(find(dd, 'ecc_uncorrectable_errors')?.value ?? '—')} (since boot)</> : <span className="muted">Not exposed: {eccNote?.message ?? 'no EDAC data'}</span>}</dd></div>
              </dl>
            )
          })()}
          <p className="muted small">"Total" is the memory the OS can use; it can be lower than the installed module capacity. Module details (slots, speed) come from SMBIOS and need elevated access — see the Hardware page.</p>
        </section>
        <section className="card" aria-label="Swap devices">
          <h2>Swap</h2>
          {swaps.length ? <table className="table compact"><thead><tr><th>Device</th><th>Type</th><th>Size</th><th>Used (scan)</th><th>Priority</th></tr></thead><tbody>
            {swaps.map((s) => { const dd = D?.get(s.id); return <tr key={s.id}><td className="mono">{s.name.replace('Swap ', '')}{find(dd, 'compressed_ram') && <span className="muted small"> · compressed RAM</span>}</td><td>{String(find(dd, 'swap_type')?.value ?? '—')}</td><td>{find(dd, 'size_bytes') ? bytes(find(dd, 'size_bytes')!.value) : '—'}</td><td>{find(dd, 'used_bytes') ? bytes(find(dd, 'used_bytes')!.value) : '—'}</td><td>{String(find(dd, 'priority')?.value ?? '—')}</td></tr> })}
          </tbody></table> : <p className="muted">No swap device is configured or /proc/swaps is not exposed.</p>}
        </section>
      </div>

      <section className="card" aria-label="NUMA nodes">
        <h2>NUMA nodes</h2>
        {nodes.length ? (
          <table className="table compact"><thead><tr><th>Node</th><th>Memory</th><th>CPUs</th><th>Distances</th><th>Live use</th></tr></thead><tbody>
            {nodes.map((n) => { const dd = D?.get(n.id); const u = all.find((s) => s.deviceId === n.id && s.metric.startsWith('memory.node_utilization:')); return (
              <tr key={n.id}><td>{n.name}</td><td>{find(dd, 'memory_total_bytes') ? bytes(find(dd, 'memory_total_bytes')!.value) : '—'}</td><td>{String(find(dd, 'cpus')?.value ?? '—')}</td><td className="mono">{String(find(dd, 'distances')?.value ?? '—')}</td><td><LiveBar value={u?.lastValue ?? null} stale={!!u?.stale || stale} /></td></tr>) })}
          </tbody></table>
        ) : <p className="muted">NUMA topology is not exposed by this OS/interface.</p>}
        <p className="muted small">Live use is (MemTotal − MemFree) / MemTotal of the node and includes page cache. A single-node machine is not NUMA-partitioned.</p>
      </section>

      <div className="grid metrics-grid">
        <Chart title="Swap utilisation" source="/proc/meminfo SwapTotal/SwapFree" unit="%" yMax={100} toMs={toMs} windowMs={windowMs} stale={stale} data={[{ id: 'su', label: 'Swap used', d: d('memory.swap_utilization') }]} />
        <Chart title="Paging and swapping" source="/proc/vmstat pgpgin/pgpgout (B/s, includes ordinary file I/O)" unit="B/s" toMs={toMs} windowMs={windowMs} stale={stale} data={[{ id: 'pi', label: 'Paged in', d: d('memory.page_in_rate') }, { id: 'po', label: 'Paged out', d: d('memory.page_out_rate'), dashed: true }]} />
        <Chart title="Swap-in / swap-out" source="/proc/vmstat pswpin/pswpout (pages/s)" unit="pages/s" toMs={toMs} windowMs={windowMs} stale={stale} data={[{ id: 'si', label: 'Swap in', d: d('memory.swap_in_rate') }, { id: 'so', label: 'Swap out', d: d('memory.swap_out_rate'), dashed: true }]} />
        <Chart title="Major page faults" source="/proc/vmstat pgmajfault" unit="/s" toMs={toMs} windowMs={windowMs} stale={stale} data={[{ id: 'mf', label: 'Major faults', d: d('memory.major_faults_rate') }]} />
      </div>
    </>
  )
}
