import { useState } from 'react'
import type { Settings } from '@shared/schemas'
import { useLoad } from '../hooks/useLoad'
import { ALWAYS_VISIBLE, NAV } from '../nav'
import { countEnabled, setAllEnabled, setEnabled } from '../pages/feature-controls'
import { api } from '../services/api'
import { ErrorBox, Spinner } from './ui'

type ListKey = 'disabledCollectors' | 'diagDisabledRules' | 'metricsDisabledProviders' | 'hiddenPages'
type Item = { id: string; label: string; hint?: string }

const FEATURES: { key: 'liveMonitoring' | 'metricsEnabled' | 'processMonitoring' | 'diagNetworkDownEnabled'; label: string; hint: string }[] = [
  { key: 'liveMonitoring', label: 'Live hardware monitoring', hint: '— react to plug/unplug events and rescan periodically' },
  { key: 'metricsEnabled', label: 'Sample live metrics', hint: '— CPU, memory, network, disk I/O, battery, temperatures, fans' },
  { key: 'processMonitoring', label: 'Process monitoring', hint: '— top processes by CPU and memory (names only; off by default because process lists are personal data)' },
  { key: 'diagNetworkDownEnabled', label: 'Report disconnected network interfaces', hint: '— off by default; a disconnected interface is often normal' }
]

function Group({ title, note, items, disabled, onChange }: { title: string; note?: string; items: Item[]; disabled: readonly string[]; onChange: (next: string[], changed: string[], enabled: boolean) => Promise<void> }): JSX.Element {
  const ids = items.map((i) => i.id)
  const on = countEnabled(disabled, ids)
  const off = new Set(disabled)
  return (
    <fieldset className="feature-group">
      <legend>{title} <small className="muted">{on} of {ids.length} on</small></legend>
      <div className="row">
        <button className="btn btn-sm" disabled={on === ids.length} onClick={() => void onChange(setAllEnabled(disabled, ids, true), ids, true)}>Enable all</button>
        <button className="btn btn-sm" disabled={on === 0} onClick={() => void onChange(setAllEnabled(disabled, ids, false), ids, false)}>Disable all</button>
      </div>
      {note && <p className="muted small">{note}</p>}
      <div className="toggle-grid">
        {items.map((i) => (
          <label className="toggle" key={i.id}>
            <input type="checkbox" checked={!off.has(i.id)} onChange={(e) => void onChange(setEnabled(disabled, i.id, e.target.checked), [i.id], e.target.checked)} />
            <span>{i.label}{i.hint && <small className="muted"> {i.hint}</small>}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/** One place to switch every optional part of the app on or off. */
export function FeatureControls({ settings, set }: { settings: Settings; set: <K extends keyof Settings>(k: K, v: Settings[K]) => Promise<void> }): JSX.Element {
  const q = useLoad(() => Promise.all([api.collectorHealth(), api.diagnosticsStatus(), api.metricsStatus(), api.pointingStickStatus()]), [], false)
  const [busy, setBusy] = useState(false)

  if (q.error) return <ErrorBox message={q.error} onRetry={q.reload} />
  if (!q.data) return <Spinner />
  const [collectors, diag, metrics, stick] = q.data

  const update = (key: ListKey, after?: (changed: string[], enabled: boolean) => Promise<unknown>) =>
    async (next: string[], changed: string[], enabled: boolean): Promise<void> => {
      setBusy(true)
      try {
        await set(key, next)
        await after?.(changed, enabled)
        q.reload()
      } finally {
        setBusy(false)
      }
    }

  const collectorItems: Item[] = collectors.filter((c) => c.status !== 'unsupported').map((c) => ({ id: c.id, label: c.id, hint: `— ${c.categories.join(', ')}` }))
  const ruleItems: Item[] = diag.rules.map((r) => ({ id: r.id, label: r.title, hint: `(${r.id})` }))
  const providerItems: Item[] = metrics.providers.filter((p) => p.status !== 'unsupported').map((p) => ({ id: p.id, label: p.title, hint: `(${p.id})` }))
  const pageItems: Item[] = NAV.filter((n) => !ALWAYS_VISIBLE.includes(n.page)).map((n) => ({ id: n.page, label: n.label }))

  return (
    <div className="stack" aria-busy={busy}>
      <fieldset className="feature-group">
        <legend>Features</legend>
        {FEATURES.map((f) => (
          <label className="toggle" key={f.key}>
            <input type="checkbox" checked={settings[f.key]} onChange={(e) => void set(f.key, e.target.checked)} />
            <span>{f.label}<small className="muted"> {f.hint}</small></span>
          </label>
        ))}
        <label className="toggle">
          <input type="checkbox" checked={settings.pointingStickEnabled} disabled={!stick.supported} onChange={(e) => void set('pointingStickEnabled', e.target.checked)} />
          <span>
            Pointing stick
            <small className="muted"> {stick.supported
              ? `— the nub in the keyboard and its buttons (${stick.devices.map((d) => d.node).join(', ')}); applies to this desktop session and is re-applied when the app starts`
              : `— unavailable: ${stick.reason}`}</small>
          </span>
        </label>
      </fieldset>
      <Group
        title="Hardware collectors" items={collectorItems} disabled={settings.disabledCollectors}
        note="A disabled collector is skipped by every scan. Its devices are kept as last known and are never reported as removed."
        // Re-enabled collectors are scanned straight away so their data is current.
        onChange={update('disabledCollectors', (ids, enabled) => (enabled ? api.scan(ids) : Promise.resolve()))}
      />
      <Group title="Diagnostic rules" items={ruleItems} disabled={settings.diagDisabledRules} onChange={update('diagDisabledRules')} />
      <Group
        title="Metric providers" items={providerItems} disabled={settings.metricsDisabledProviders}
        note={settings.metricsEnabled ? undefined : 'Metric sampling is switched off above, so no provider runs.'}
        onChange={update('metricsDisabledProviders')}
      />
      <Group title="Sidebar pages" items={pageItems} disabled={settings.hiddenPages} note="Overview and Settings are always shown." onChange={update('hiddenPages')} />
    </div>
  )
}
