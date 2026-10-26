import { Activity, Cpu, Gauge, GitCompare, History, LayoutDashboard, ListTree, Settings as SettingsIcon, Share2, ShieldAlert, ShieldCheck, Thermometer } from 'lucide-react'
import type { Route } from './App'

export const NAV: { page: Route['page']; label: string; icon: typeof Cpu }[] = [
  { page: 'overview', label: 'Overview', icon: LayoutDashboard },
  { page: 'inventory', label: 'Hardware', icon: Cpu },
  { page: 'topology', label: 'Topology', icon: Share2 },
  { page: 'diagnostics', label: 'Diagnostics', icon: ShieldAlert },
  { page: 'snapshots', label: 'Snapshots', icon: History },
  { page: 'monitor', label: 'Monitor', icon: Gauge },
  { page: 'cpu', label: 'CPU & Memory', icon: Cpu },
  { page: 'sensors', label: 'Sensors', icon: Thermometer },
  { page: 'processes', label: 'Processes', icon: ListTree },
  { page: 'compare', label: 'Device diff', icon: GitCompare },
  { page: 'events', label: 'Events', icon: Activity },
  { page: 'collectors', label: 'Collectors', icon: ShieldCheck },
  { page: 'settings', label: 'Settings', icon: SettingsIcon }
]

/** Pages that can never be hidden: there must always be a way back to Settings. */
export const ALWAYS_VISIBLE: readonly Route['page'][] = ['overview', 'settings']

/** Dispatched on window after a setting changes, so the shell can re-read what it depends on. */
export const SETTINGS_CHANGED = 'hip:settings-changed'

export function visibleNav(hidden: readonly string[]): typeof NAV {
  const off = new Set(hidden)
  return NAV.filter((n) => ALWAYS_VISIBLE.includes(n.page) || !off.has(n.page))
}
