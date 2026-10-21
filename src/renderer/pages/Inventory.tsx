import { ArrowDown, ArrowUp, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Category, DeviceStatus, DeviceSummary } from '@shared/schemas'
import type { Navigate } from '../App'
import { Badge, CATEGORY_META, CategoryIcon, DeviceStatusBadge, Empty, ErrorBox, PageHeader, Spinner, timeAgo } from '../components/ui'
import { useLoad } from '../hooks/useLoad'
import { api } from '../services/api'

type SortKey = 'name' | 'category' | 'manufacturer' | 'busType' | 'status' | 'lastSeen'
const PAGE = 200

export function InventoryPage({ navigate, initialCategory }: { navigate: Navigate; initialCategory?: Category }): JSX.Element {
  const [category, setCategory] = useState<Category | undefined>(initialCategory)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [status, setStatus] = useState<DeviceStatus | ''>('')
  const [includeMissing, setIncludeMissing] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'category', dir: 1 })
  const [limit, setLimit] = useState(PAGE)

  useEffect(() => { setCategory(initialCategory) }, [initialCategory])
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 150)
    return () => clearTimeout(t)
  }, [search])
  useEffect(() => setLimit(PAGE), [category, debounced, status, includeMissing])

  // Counts for chips ignore the category filter so they stay stable while filtering.
  const all = useLoad(() => api.listDevices({ search: debounced || undefined, status: status || undefined, includeMissing }), [debounced, status, includeMissing])
  const counts = useMemo(() => {
    const c: Partial<Record<Category, number>> = {}
    for (const d of all.data ?? []) c[d.category] = (c[d.category] ?? 0) + 1
    return c
  }, [all.data])

  const rows = useMemo(() => {
    const list = (all.data ?? []).filter((d) => !category || d.category === category)
    const val = (d: DeviceSummary): string => String(d[sort.key] ?? '').toLowerCase()
    return [...list].sort((a, b) => (val(a) < val(b) ? -sort.dir : val(a) > val(b) ? sort.dir : a.name.localeCompare(b.name)))
  }, [all.data, category, sort])

  const th = (key: SortKey, label: string): JSX.Element => (
    <th scope="col" aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button className="th-btn" onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}>
        {label}{sort.key === key && (sort.dir === 1 ? <ArrowUp size={12} aria-hidden /> : <ArrowDown size={12} aria-hidden />)}
      </button>
    </th>
  )

  return (
    <>
      <PageHeader title="Hardware" subtitle={all.data ? `${rows.length} of ${all.data.length} devices${includeMissing ? ' (including missing)' : ''}` : undefined} />
      <div className="toolbar">
        <label className="search">
          <Search size={14} aria-hidden />
          <input type="search" placeholder="Search name, vendor, model, ID, driver…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search devices" />
        </label>
        <select value={status} onChange={(e) => setStatus(e.target.value as DeviceStatus | '')} aria-label="Filter by status">
          <option value="">Any status</option><option value="ok">OK</option><option value="error">Error</option><option value="disabled">Disabled</option><option value="unknown">Unknown</option>
        </select>
        <label className="check"><input type="checkbox" checked={includeMissing} onChange={(e) => setIncludeMissing(e.target.checked)} /> Show missing</label>
      </div>
      <div className="chips" role="group" aria-label="Category filter">
        <button className={`chip ${!category ? 'active' : ''}`} onClick={() => setCategory(undefined)} aria-pressed={!category}>All <b>{all.data?.length ?? 0}</b></button>
        {(Object.keys(CATEGORY_META) as Category[]).filter((c) => counts[c]).map((c) => (
          <button key={c} className={`chip ${category === c ? 'active' : ''}`} aria-pressed={category === c} onClick={() => setCategory(category === c ? undefined : c)}>
            <CategoryIcon category={c} size={13} /> {CATEGORY_META[c].label} <b>{counts[c]}</b>
          </button>
        ))}
      </div>

      {all.error && <ErrorBox message={all.error} onRetry={all.reload} />}
      {!all.data && !all.error && <Spinner />}
      {all.data && rows.length === 0 && (
        <Empty title={all.data.length === 0 && !debounced && !status ? 'No devices recorded yet' : 'No devices match these filters'}>
          {all.data.length === 0 && !debounced && !status ? 'The first scan may still be running. If this persists, check the Collectors page.' : 'Try clearing the search or category filter.'}
        </Empty>
      )}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead><tr>{th('name', 'Device')}{th('category', 'Category')}{th('manufacturer', 'Manufacturer')}{th('busType', 'Bus')}<th scope="col">IDs</th>{th('status', 'Status')}{th('lastSeen', 'Last seen')}</tr></thead>
            <tbody>
              {rows.slice(0, limit).map((d) => (
                <tr key={d.id} tabIndex={0} className={d.presence === 'missing' ? 'row-missing' : ''}
                  onClick={() => navigate({ page: 'device', id: d.id, from: { page: 'inventory', category } })}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate({ page: 'device', id: d.id, from: { page: 'inventory', category } }) } }}>
                  <td><div className="cell-name"><CategoryIcon category={d.category} /><span>{d.name}</span></div>{d.model && d.model !== d.name && <div className="muted small">{d.model}</div>}</td>
                  <td>{CATEGORY_META[d.category].label}{d.subtype && <span className="muted small"> · {d.subtype.replace(/_/g, ' ')}</span>}</td>
                  <td>{d.manufacturer ?? <span className="muted">—</span>}</td>
                  <td>{d.busType ?? <span className="muted">—</span>}</td>
                  <td className="mono">{d.vendorId && d.productId ? `${d.vendorId}:${d.productId}` : <span className="muted">—</span>}</td>
                  <td>{d.presence === 'missing' ? <Badge tone="warn">missing</Badge> : <DeviceStatusBadge status={d.status} />}</td>
                  <td className="muted" title={new Date(d.lastSeen).toLocaleString()}>{timeAgo(d.lastSeen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > limit && <div className="more"><button className="btn" onClick={() => setLimit((l) => l + PAGE)}>Show {Math.min(PAGE, rows.length - limit)} more ({rows.length - limit} remaining)</button></div>}
        </div>
      )}
    </>
  )
}
