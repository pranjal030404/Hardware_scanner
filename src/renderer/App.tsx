import { Gauge } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Category } from '@shared/schemas'
import { EventsProvider, useEvents } from './hooks/useEvents'
import { Badge } from './components/ui'
import { useLoad } from './hooks/useLoad'
import { api } from './services/api'
import { SETTINGS_CHANGED, visibleNav } from './nav'
import { MonitorPage } from './pages/Monitor'
import { CpuMemoryPage } from './pages/CpuMemory'
import { SensorsPage } from './pages/Sensors'
import { ProcessesPage } from './pages/Processes'
import { ComparePage } from './pages/Compare'
import { SnapshotsPage } from './pages/Snapshots'
import { DiagnosticsPage } from './pages/Diagnostics'
import { CollectorsPage } from './pages/Collectors'
import { DeviceDetailPage } from './pages/DeviceDetail'
import { EventsPage } from './pages/Events'
import { InventoryPage } from './pages/Inventory'
import { OverviewPage } from './pages/Overview'
import { SettingsPage } from './pages/Settings'
import { TopologyPage } from './pages/Topology'

export type Route =
  | { page: 'overview' }
  | { page: 'inventory'; category?: Category }
  | { page: 'device'; id: string; from: Route }
  | { page: 'topology'; focus?: string }
  | { page: 'diagnostics'; focus?: string }
  | { page: 'snapshots' }
  | { page: 'monitor' }
  | { page: 'cpu' }
  | { page: 'sensors' }
  | { page: 'processes' }
  | { page: 'compare' }
  | { page: 'events' }
  | { page: 'collectors' }
  | { page: 'settings' }

export type Navigate = (r: Route) => void


function MonitorPill(): JSX.Element {
  const { monitor } = useEvents()
  if (!monitor) return <Badge tone="muted">monitor…</Badge>
  const tone = monitor.mode === 'paused' ? 'muted' : monitor.degraded ? 'warn' : 'ok'
  const label = monitor.mode === 'udev' ? 'Live (udev)' : monitor.mode === 'polling' ? `Polling ${monitor.intervalSec}s` : monitor.mode === 'paused' ? 'Paused' : 'Stopped'
  return <Badge tone={tone} title={monitor.message ?? undefined}>{monitor.scanning ? 'Scanning…' : label}</Badge>
}

function Shell(): JSX.Element {
  const [route, setRoute] = useState<Route>({ page: 'overview' })
  const navigate: Navigate = useCallback((r) => setRoute(r), [])
  const [hidden, setHidden] = useState<readonly string[]>([])
  useEffect(() => {
    const load = (): void => void api.getSettings().then((s) => setHidden(s.hiddenPages), () => undefined)
    load()
    window.addEventListener(SETTINGS_CHANGED, load)
    return () => window.removeEventListener(SETTINGS_CHANGED, load)
  }, [])
  const nav = useMemo(() => visibleNav(hidden), [hidden])

  useEffect(() => {
    // Keyboard navigation: Alt+1..6 jumps between sections.
    const h = (e: KeyboardEvent): void => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return
      const i = Number(e.key) - 1
      const item = nav[i]
      if (item) { e.preventDefault(); navigate({ page: item.page } as Route) }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [navigate, nav])

  const diag = useLoad(() => api.diagnosticsStatus(), [])
  const activeFindings = diag.data?.counts.byStatus['active'] ?? 0
  const active = route.page === 'device' ? route.from.page : route.page
  return (
    <div className="app">
      <nav className="sidebar" aria-label="Primary">
        <div className="brand"><Gauge size={18} aria-hidden /><span>Hardware<br />Intelligence</span></div>
        <ul>
          {nav.map((n, i) => (
            <li key={n.page}>
              <button className={`nav-item ${active === n.page ? 'active' : ''}`} aria-current={active === n.page ? 'page' : undefined} onClick={() => navigate({ page: n.page } as Route)} title={`Alt+${i + 1}`}>
                <n.icon size={16} aria-hidden /><span>{n.label}</span>{n.page === 'diagnostics' && activeFindings > 0 && <span className="nav-count" aria-label={`${activeFindings} active findings`}>{activeFindings}</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="sidebar-foot"><MonitorPill /></div>
      </nav>
      <main className="content" id="main">
        {route.page === 'overview' && <OverviewPage navigate={navigate} />}
        {route.page === 'inventory' && <InventoryPage navigate={navigate} initialCategory={route.category} />}
        {route.page === 'device' && <DeviceDetailPage id={route.id} back={route.from} navigate={navigate} />}
        {route.page === 'topology' && <TopologyPage navigate={navigate} focus={route.focus} />}
        {route.page === 'diagnostics' && <DiagnosticsPage navigate={navigate} focus={route.focus} />}
        {route.page === 'snapshots' && <SnapshotsPage navigate={navigate} />}
        {route.page === 'monitor' && <MonitorPage navigate={navigate} />}
        {route.page === 'cpu' && <CpuMemoryPage navigate={navigate} />}
        {route.page === 'sensors' && <SensorsPage navigate={navigate} />}
        {route.page === 'processes' && <ProcessesPage />}
        {route.page === 'compare' && <ComparePage navigate={navigate} />}
        {route.page === 'events' && <EventsPage navigate={navigate} />}
        {route.page === 'collectors' && <CollectorsPage />}
        {route.page === 'settings' && <SettingsPage />}
      </main>
    </div>
  )
}

export function App(): JSX.Element {
  return (
    <EventsProvider>
      <Shell />
    </EventsProvider>
  )
}

