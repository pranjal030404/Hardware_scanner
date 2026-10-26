import { Pause, Play } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { MetricProviderInfo, MetricSeriesData, MetricSeriesSummary } from '@shared/schemas'
import type { Navigate } from '../App'
import { formatMetric } from '../components/chart-geometry'
import { TimeChart } from '../components/TimeChart'
import { Badge, ErrorBox, PageHeader, Spinner, timeAgo } from '../components/ui'
import { selKey, useMetrics, type SeriesSel } from '../hooks/useMetrics'
import { api } from '../services/api'

const WINDOWS = [{ l: '1 min', s: 60 }, { l: '5 min', s: 300 }, { l: '15 min', s: 900 }, { l: '1 hour', s: 3600 }, { l: '6 hours', s: 21600 }, { l: '24 hours', s: 86400 }]
const INTERVALS = [1, 2, 5, 10, 30, 60]
const PROVIDER_TONE = { ok: 'ok', partial: 'warn', unavailable: 'muted', unsupported: 'muted', error: 'bad', paused: 'muted', starting: 'info', disabled: 'muted' } as const

/** Name the source the provider actually reported; the Linux path text is only shown for Linux-path sources. */
function srcLabel(actual: string | undefined, linuxText: string): string {
  if (!actual) return `${linuxText} — Linux providers only`
  return actual.startsWith('/') ? linuxText : actual
}

function CardShell({ title, latest, state, source, children, note }: { title: string; latest?: string; state: 'live' | 'stale' | 'unavailable' | 'waiting'; source: string; children?: React.ReactNode; note?: string }): JSX.Element {
  return (
    <section className="card metric-card" aria-label={title}>
      <div className="metric-head">
        <h2>{title}</h2>
        <span className="inline">
          {latest && <b className="metric-latest">{latest}</b>}
          <Badge tone={state === 'live' ? 'ok' : state === 'waiting' ? 'info' : 'warn'}>{state === 'live' ? 'live' : state === 'stale' ? 'stale' : state === 'waiting' ? 'waiting' : 'unavailable'}</Badge>
        </span>
      </div>
      {note && <p className={state === 'live' ? 'muted small' : 'banner banner-warn small-banner'}>{note}</p>}
      {children}
      <p className="muted small source">Source: <span className="mono">{source}</span></p>
    </section>
  )
}

export function MonitorPage({ navigate }: { navigate: Navigate }): JSX.Element {
  const [windowSec, setWindowSec] = useState(300)
  const [iface, setIface] = useState<string>('')
  const [disk, setDisk] = useState<string>('')
  const [tempSel, setTempSel] = useState<Set<string>>(new Set())
  const [probe, setProbe] = useState<SeriesSel[]>([])
  const first = useMetrics([], windowSec)
  const all = first.status?.series ?? []

  // Series available per family (from the status listing).
  const byMetric = (m: string | RegExp): MetricSeriesSummary[] => all.filter((s) => (typeof m === 'string' ? s.metric === m : m.test(s.metric)))
  const cpu = byMetric('cpu.utilization')[0]
  const mem = byMetric('memory.utilization')[0]
  const memAvail = byMetric('memory.available')[0]
  const nets = [...new Set(byMetric('network.rx_rate').map((s) => s.deviceId))]
  const disks = [...new Set(byMetric('disk.read_rate').map((s) => s.deviceId))]
  const batt = byMetric('battery.charge')[0]
  const gpu = byMetric('gpu.frequency')[0]
  const gpuBusy = byMetric('gpu.utilization')[0]
  const temps = byMetric(/^temperature:/)
  const fans = byMetric(/^fan:/)
  const name = (id: string): string => all.find((s) => s.deviceId === id)?.deviceName ?? id

  useEffect(() => { if (!iface && nets.length) setIface(nets.find((n) => name(n) !== 'lo') ?? nets[0]!) }, [nets.join()]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!disk && disks.length) setDisk(disks[0]!) }, [disks.join()]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!tempSel.size && temps.length) setTempSel(new Set(temps.slice(0, 4).map((t) => selKey(t)))) }, [temps.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const wanted = useMemo<SeriesSel[]>(() => {
    const s: SeriesSel[] = []
    if (cpu) s.push({ metric: cpu.metric, deviceId: cpu.deviceId })
    if (mem) s.push({ metric: mem.metric, deviceId: mem.deviceId })
    if (iface) s.push({ metric: 'network.rx_rate', deviceId: iface }, { metric: 'network.tx_rate', deviceId: iface })
    if (disk) s.push({ metric: 'disk.read_rate', deviceId: disk }, { metric: 'disk.write_rate', deviceId: disk }, { metric: 'disk.busy', deviceId: disk })
    if (batt) s.push({ metric: 'battery.charge', deviceId: batt.deviceId }, { metric: 'battery.power', deviceId: batt.deviceId })
    if (gpu) s.push({ metric: gpu.metric, deviceId: gpu.deviceId })
    if (gpuBusy) s.push({ metric: gpuBusy.metric, deviceId: gpuBusy.deviceId })
    for (const t of temps) if (tempSel.has(selKey(t))) s.push({ metric: t.metric, deviceId: t.deviceId })
    for (const f of fans.slice(0, 4)) s.push({ metric: f.metric, deviceId: f.deviceId })
    return s.slice(0, 40)
  }, [cpu?.deviceId, mem?.deviceId, iface, disk, batt?.deviceId, temps.length, tempSel, fans.length]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setProbe(wanted), [wanted])
  const live = useMetrics(probe, windowSec)
  const st = live.status ?? first.status
  const d = (metric: string, deviceId: string): MetricSeriesData | undefined => live.data.get(selKey({ metric, deviceId }))
  const toMs = live.now
  const windowMs = windowSec * 1000
  const paused = !!st?.paused

  const providerFor = (metric: string): MetricProviderInfo | undefined => st?.providers.find((p) => p.metrics.some((m) => m.metric === metric || (m.metric.endsWith('<sensor>') && metric.startsWith(m.metric.replace('<sensor>', '')))))
  const stateOf = (metric: string, series: MetricSeriesSummary[] | undefined, data?: MetricSeriesData[]): { state: 'live' | 'stale' | 'unavailable' | 'waiting'; note?: string } => {
    if (!st) return { state: 'waiting' }
    if (!st.enabled) return { state: 'unavailable', note: 'Metric sampling is disabled in Settings.' }
    if (!st.platformSupported) return { state: 'unavailable', note: 'No metric providers exist for this operating system yet.' }
    const p = providerFor(metric)
    if (!series?.length) {
      if (p?.status === 'unavailable' || p?.status === 'unsupported' || p?.status === 'error') return { state: 'unavailable', note: p.message ?? 'This measurement is not exposed on this machine.' }
      if (!p) return { state: 'unavailable', note: 'No provider reports this measurement on this platform.' }
      return { state: 'waiting', note: 'Waiting for the first measurements…' }
    }
    const stale = (data ?? []).some((x) => x.stale) || series.every((x) => x.stale)
    if (paused) return { state: 'stale', note: 'Sampling is paused. The chart shows the last collected data, not the current state.' }
    if (stale) return { state: 'stale', note: `No recent measurement (last ${timeAgo(series[0]?.lastAt)}). The values shown are old.` }
    if (p?.status === 'error') return { state: 'stale', note: `Provider error: ${p.message}` }
    return { state: 'live' }
  }

  const toggleTemp = (k: string): void => setTempSel((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const lastOf = (x: MetricSeriesData | undefined): number | undefined => x?.points[x.points.length - 1]?.v
  const chartSeries = (items: { id: string; label: string; data?: MetricSeriesData; dashed?: boolean }[]) =>
    items.filter((i) => i.data).map((i) => ({ id: i.id, label: i.label, points: i.data!.points, intervalMs: i.data!.intervalMs, dashed: i.dashed }))

  const cpuD = cpu && d(cpu.metric, cpu.deviceId)
  const memD = mem && d(mem.metric, mem.deviceId)
  const rx = iface ? d('network.rx_rate', iface) : undefined
  const tx = iface ? d('network.tx_rate', iface) : undefined
  const rd = disk ? d('disk.read_rate', disk) : undefined
  const wr = disk ? d('disk.write_rate', disk) : undefined
  const busy = disk ? d('disk.busy', disk) : undefined
  const bc = batt && d('battery.charge', batt.deviceId)
  const bp = batt && d('battery.power', batt.deviceId)
  const gpuF = gpu && d(gpu.metric, gpu.deviceId)
  const gpuU = gpuBusy && d(gpuBusy.metric, gpuBusy.deviceId)
  const tempSeries = temps.filter((t) => tempSel.has(selKey(t)))

  if (first.error && !st) return <><PageHeader title="Monitor" /><ErrorBox message={first.error} onRetry={first.reload} /></>
  if (!st) return <><PageHeader title="Monitor" /><Spinner /></>

  return (
    <>
      <PageHeader
        title="Monitor"
        subtitle={`Measured from the operating system every ${st.intervalSec}s · kept ${st.retentionHours}h · ${st.storedSamples.toLocaleString()} samples stored`}
        actions={
          <>
            <select value={windowSec} onChange={(e) => setWindowSec(Number(e.target.value))} aria-label="Time window">{WINDOWS.map((w) => <option key={w.s} value={w.s}>{w.l}</option>)}</select>
            <select value={st.intervalSec} onChange={(e) => void api.setSetting('metricsIntervalSec', Number(e.target.value)).then(live.reload)} aria-label="Sampling interval">{INTERVALS.map((i) => <option key={i} value={i}>every {i}s</option>)}</select>
            <button className="btn" onClick={() => void api.setMetricsPaused(!paused).then(live.reload)} aria-pressed={paused} disabled={!st.enabled}>{paused ? <><Play size={14} /> Resume sampling</> : <><Pause size={14} /> Pause sampling</>}</button>
          </>
        }
      />
      {paused && <div className="banner banner-warn" role="status">Sampling is paused. Charts show the last collected data and are marked stale.</div>}
      {!st.enabled && <div className="banner banner-warn" role="status">Metric sampling is turned off. <button className="btn btn-sm" onClick={() => void api.setSetting('metricsEnabled', true).then(live.reload)}>Turn on</button></div>}
      {live.error && <ErrorBox message={live.error} onRetry={live.reload} />}

      <div className="grid metrics-grid">
        <CardShell title="CPU utilisation" latest={lastOf(cpuD) !== undefined ? formatMetric(lastOf(cpuD)!, '%') : undefined} source={srcLabel(cpuD?.source, '/proc/stat (all logical processors combined)')} {...stateOf('cpu.utilization', cpu ? [cpu] : [], cpuD ? [cpuD] : [])}>
          {cpuD && <TimeChart ariaLabel="CPU utilisation over time" series={chartSeries([{ id: 'cpu', label: 'CPU', data: cpuD }])} toMs={toMs} windowMs={windowMs} unit="%" yMin={0} yMax={100} stale={paused || cpuD.stale} />}
        </CardShell>

        <CardShell title="Memory" latest={lastOf(memD) !== undefined ? `${formatMetric(lastOf(memD)!, '%')} used` : undefined} source={srcLabel(memD?.source, '/proc/meminfo (MemTotal − MemAvailable)')} {...stateOf('memory.utilization', mem ? [mem] : [], memD ? [memD] : [])}
          note={memAvail?.lastValue != null ? `${formatMetric(memAvail.lastValue, 'B')} available to applications` : undefined}>
          {memD && <TimeChart ariaLabel="Memory utilisation over time" series={chartSeries([{ id: 'mem', label: 'Used', data: memD }])} toMs={toMs} windowMs={windowMs} unit="%" yMin={0} yMax={100} stale={paused || memD.stale} />}
        </CardShell>

        <CardShell title="Network throughput" latest={rx ? `↓ ${formatMetric(lastOf(rx) ?? NaN, 'B/s')}  ↑ ${formatMetric(lastOf(tx) ?? NaN, 'B/s')}` : undefined} source={srcLabel(rx?.source, '/sys/class/net/<interface>/statistics (byte counter deltas)')} {...stateOf('network.rx_rate', byMetric('network.rx_rate'), [rx, tx].filter((x): x is MetricSeriesData => !!x))}>
          {nets.length > 1 && <label className="field inline-field"><span>Interface</span><select value={iface} onChange={(e) => setIface(e.target.value)}>{nets.map((n) => <option key={n} value={n}>{name(n)}</option>)}</select></label>}
          {(rx || tx) && <TimeChart ariaLabel={`Network throughput of ${name(iface)} over time`} series={chartSeries([{ id: 'rx', label: 'Receive', data: rx }, { id: 'tx', label: 'Transmit', data: tx, dashed: true }])} toMs={toMs} windowMs={windowMs} unit="B/s" yMin={0} stale={paused || !!rx?.stale} />}
        </CardShell>

        <CardShell title="Disk activity" latest={rd ? `R ${formatMetric(lastOf(rd) ?? NaN, 'B/s')}  W ${formatMetric(lastOf(wr) ?? NaN, 'B/s')}` : undefined} source={srcLabel(rd?.source, '/sys/block/<disk>/stat — I/O throughput and busy time, not capacity')} {...stateOf('disk.read_rate', byMetric('disk.read_rate'), [rd, wr].filter((x): x is MetricSeriesData => !!x))}>
          {disks.length > 1 && <label className="field inline-field"><span>Disk</span><select value={disk} onChange={(e) => setDisk(e.target.value)}>{disks.map((n) => <option key={n} value={n}>{name(n)}</option>)}</select></label>}
          {(rd || wr) && <TimeChart ariaLabel={`Disk throughput of ${name(disk)} over time`} series={chartSeries([{ id: 'rd', label: 'Read', data: rd }, { id: 'wr', label: 'Write', data: wr, dashed: true }])} toMs={toMs} windowMs={windowMs} unit="B/s" yMin={0} stale={paused || !!rd?.stale} />}
          {busy && <><p className="muted small">Busy time (share of time the device had I/O in flight)</p><TimeChart ariaLabel="Disk busy time over time" height={110} series={chartSeries([{ id: 'busy', label: 'Busy', data: busy }])} toMs={toMs} windowMs={windowMs} unit="%" yMin={0} yMax={100} stale={paused || busy.stale} /></>}
        </CardShell>

        <CardShell title="Battery" latest={lastOf(bc) !== undefined ? formatMetric(lastOf(bc)!, '%') : undefined} source={srcLabel(bc?.source, '/sys/class/power_supply/<battery>/capacity, power_now')} {...stateOf('battery.charge', batt ? [batt] : [], bc ? [bc] : [])}
          note={bp && lastOf(bp) !== undefined ? `${lastOf(bp)! >= 0 ? 'Charging at' : 'Discharging at'} ${formatMetric(Math.abs(lastOf(bp)!), 'W')}` : undefined}>
          {bc && <TimeChart ariaLabel="Battery charge over time" series={chartSeries([{ id: 'bc', label: 'Charge', data: bc }])} toMs={toMs} windowMs={windowMs} unit="%" yMin={0} yMax={100} stale={paused || bc.stale} />}
        </CardShell>

        <CardShell title="GPU" latest={lastOf(gpuF) !== undefined ? formatMetric(lastOf(gpuF)!, 'MHz') : undefined} source={srcLabel(gpuF?.source, '/sys/class/drm/<card>/gt_act_freq_mhz (driver-reported clock; utilisation only where the driver exposes it)')}
          {...(gpu ? stateOf('gpu.frequency', [gpu], gpuF ? [gpuF] : []) : { state: 'unavailable' as const, note: 'The GPU driver exposes no DRM counters on this machine (vendor tools are not used).' })}
          note={gpuU && lastOf(gpuU) !== undefined ? `Engine busy ${formatMetric(lastOf(gpuU)!, '%')}` : undefined}>
          {gpuF && <TimeChart ariaLabel="GPU frequency over time" series={chartSeries([{ id: 'gf', label: 'Clock', data: gpuF }])} toMs={toMs} windowMs={windowMs} unit="MHz" yMin={0} stale={paused || gpuF.stale} />}
        </CardShell>

        <CardShell title="Temperatures" source={srcLabel(temps[0]?.source, '/sys/class/hwmon/*/temp*_input (limits come from the sensor, see Diagnostics)')} {...stateOf('temperature:', temps, tempSeries.map((t) => d(t.metric, t.deviceId)).filter((x): x is MetricSeriesData => !!x))}>
          {temps.length > 0 && (
            <>
              <div className="chips" role="group" aria-label="Temperature sensors">
                {temps.map((t) => <button key={selKey(t)} className={`chip ${tempSel.has(selKey(t)) ? 'active' : ''}`} aria-pressed={tempSel.has(selKey(t))} onClick={() => toggleTemp(selKey(t))}>{t.deviceName} · {t.metric.slice('temperature:'.length)}{t.lastValue != null && <b> {formatMetric(t.lastValue, '°C')}</b>}</button>)}
              </div>
              <TimeChart ariaLabel="Temperatures over time" series={chartSeries(tempSeries.map((t, i) => ({ id: selKey(t), label: `${t.deviceName} ${t.metric.slice(12)}`, data: d(t.metric, t.deviceId), dashed: i % 2 === 1 })))} toMs={toMs} windowMs={windowMs} unit="°C" stale={paused || tempSeries.every((t) => d(t.metric, t.deviceId)?.stale ?? true)} />
            </>
          )}
        </CardShell>

        <CardShell title="Fans" source={srcLabel(fans[0]?.source, '/sys/class/hwmon/*/fan*_input')} {...(fans.length ? stateOf('fan:', fans, fans.map((f) => d(f.metric, f.deviceId)).filter((x): x is MetricSeriesData => !!x)) : { state: 'unavailable' as const, note: 'No fan sensors are exposed by this machine’s drivers.' })}>
          {fans.length > 0 && <TimeChart ariaLabel="Fan speed over time" series={chartSeries(fans.slice(0, 4).map((f, i) => ({ id: selKey(f), label: `${f.deviceName} ${f.metric.slice(4)}`, data: d(f.metric, f.deviceId), dashed: i % 2 === 1 })))} toMs={toMs} windowMs={windowMs} unit="RPM" yMin={0} stale={paused} />}
        </CardShell>
      </div>

      <section className="card providers-card" aria-label="Data sources">
        <h2>Data sources &amp; sampler health</h2>
        <table className="table compact">
          <thead><tr><th>Provider</th><th>Status</th><th>Last sample</th><th>Measures</th></tr></thead>
          <tbody>
            {st.providers.map((p) => (
              <tr key={p.id}>
                <td><b>{p.title}</b><div className="mono small muted">{p.id}</div></td>
                <td><Badge tone={PROVIDER_TONE[p.status]}>{p.status}</Badge>{p.message && <div className="small muted">{p.message}</div>}{(p.counterResets > 0 || p.invalidReadings > 0) && <div className="small muted">{p.counterResets} counter reset(s) skipped · {p.invalidReadings} invalid reading(s) dropped</div>}</td>
                <td className="muted small">{p.lastSampleAt ? timeAgo(p.lastSampleAt) : '—'}</td>
                <td className="small">{p.metrics.map((m) => <div key={m.metric}><span className="mono">{m.metric}</span> <span className="muted">({m.unit}) — {m.description}</span></div>)}</td>
              </tr>
            ))}
            {st.providers.length === 0 && <tr><td colSpan={4} className="muted">No metric providers for this platform.</td></tr>}
          </tbody>
        </table>
        <p className="muted small">Values are derived from OS counters and are never estimated. {nets.length > 0 || disks.length > 0 ? '' : ''}Device-specific charts also appear on each device’s detail page.</p>
        <button className="btn btn-sm" onClick={() => navigate({ page: 'diagnostics' })}>Open diagnostics</button>
      </section>
    </>
  )
}
