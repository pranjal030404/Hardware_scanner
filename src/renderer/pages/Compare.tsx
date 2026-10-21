import { useState } from 'react'
import type { DeviceDetail } from '@shared/schemas'
import type { Navigate } from '../App'
import { Badge, CATEGORY_META, Empty, ErrorBox, PageHeader, Spinner } from '../components/ui'
import { useLoad } from '../hooks/useLoad'
import { api } from '../services/api'
import { compareDevices, differenceCount } from './compare-logic'

const LABEL = { same: 'same', different: 'different', only_a: 'only in A', only_b: 'only in B' } as const

export function ComparePage({ navigate }: { navigate: Navigate }): JSX.Element {
  const [category, setCategory] = useState<string>('storage')
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [onlyDiff, setOnlyDiff] = useState(true)
  const list = useLoad(() => api.listDevices({ category: category as never }), [category])
  const pair = useLoad(async () => {
    if (!a || !b) return null
    const [x, y] = await Promise.all([api.getDevice(a), api.getDevice(b)])
    return x && y ? ([x, y] as [DeviceDetail, DeviceDetail]) : null
  }, [a, b])

  const devices = list.data ?? []
  const result = pair.data ? compareDevices(pair.data[0], pair.data[1]) : null
  const rows = result && !('error' in result) ? result : []
  const shown = rows.filter((r) => !onlyDiff || r.status !== 'same')
  const select = (label: string, value: string, set: (v: string) => void): JSX.Element => (
    <label className="field"><span>{label}</span>
      <select value={value} onChange={(e) => set(e.target.value)}>
        <option value="">Choose a device…</option>
        {devices.map((d) => <option key={d.id} value={d.id}>{d.name}{d.presence === 'missing' ? ' (not present)' : ''}</option>)}
      </select>
    </label>
  )
  return (
    <>
      <PageHeader title="Compare devices" subtitle="Side-by-side comparison of two devices of the same category, with the source of every value. Live readings are shown but not counted as differences." />
      <section className="card">
        <label className="field"><span>Category</span>
          <select value={category} onChange={(e) => { setCategory(e.target.value); setA(''); setB('') }}>
            {Object.entries(CATEGORY_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
          </select>
        </label>
        {list.error ? <ErrorBox message={list.error} onRetry={list.reload} /> : !list.data ? <Spinner /> : devices.length < 2 ? <p className="muted">Fewer than two devices of this category are in the inventory.</p> : <>{select('Device A', a, setA)}{select('Device B', b, setB)}</>}
      </section>
      {pair.error && <ErrorBox message={pair.error} onRetry={pair.reload} />}
      {result && 'error' in result && <Empty title="Cannot compare">{result.error}</Empty>}
      {pair.data && rows.length > 0 && (
        <section className="card" aria-label="Comparison">
          <div className="inline">
            <Badge tone={differenceCount(rows) ? 'warn' : 'ok'}>{differenceCount(rows)} difference{differenceCount(rows) === 1 ? '' : 's'}</Badge>
            <label className="inline small"><input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> Differences only</label>
            <button className="link" onClick={() => navigate({ page: 'device', id: pair.data![0].device.id, from: { page: 'compare' } })}>Open A</button>
            <button className="link" onClick={() => navigate({ page: 'device', id: pair.data![1].device.id, from: { page: 'compare' } })}>Open B</button>
          </div>
          <table className="table">
            <thead><tr><th>Field</th><th>{pair.data[0].device.name}</th><th>{pair.data[1].device.name}</th><th>Result</th></tr></thead>
            <tbody>{shown.map((r) => (
              <tr key={`${r.group}:${r.key}`}>
                <td>{r.key}{r.volatile && <span className="muted small"> (live)</span>}</td>
                <td className="mono small" title={r.aSource}>{r.a ?? <span className="muted">not exposed</span>}</td>
                <td className="mono small" title={r.bSource}>{r.b ?? <span className="muted">not exposed</span>}</td>
                <td><Badge tone={r.status === 'same' ? 'ok' : r.volatile ? 'muted' : 'warn'}>{LABEL[r.status]}</Badge></td>
              </tr>
            ))}</tbody>
          </table>
          {shown.length === 0 && <p className="muted">No differences in the collected fields.</p>}
        </section>
      )}
    </>
  )
}
