import {
  Activity, BatteryFull, Bluetooth, Boxes, Cable, Camera, CircuitBoard, Cpu, HardDrive, Keyboard, Laptop, MemoryStick, Monitor,
  Network, Plug, Server, Thermometer, Usb, Volume2, type LucideIcon
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { Category, CollectorStatus, DeviceStatus } from '@shared/schemas'

export const CATEGORY_META: Record<Category, { label: string; icon: LucideIcon }> = {
  system: { label: 'System', icon: Laptop },
  motherboard: { label: 'Motherboard', icon: CircuitBoard },
  cpu: { label: 'Processor', icon: Cpu },
  memory: { label: 'Memory', icon: MemoryStick },
  pci: { label: 'PCI', icon: Server },
  usb: { label: 'USB', icon: Usb },
  hid: { label: 'Input (HID)', icon: Keyboard },
  storage: { label: 'Storage', icon: HardDrive },
  network: { label: 'Network', icon: Network },
  bluetooth: { label: 'Bluetooth', icon: Bluetooth },
  display: { label: 'Displays', icon: Monitor },
  audio: { label: 'Audio', icon: Volume2 },
  camera: { label: 'Cameras', icon: Camera },
  sensor: { label: 'Sensors', icon: Thermometer },
  power: { label: 'Power', icon: BatteryFull },
  serial: { label: 'Serial', icon: Cable },
  other: { label: 'Other', icon: Boxes }
}

export function CategoryIcon({ category, size = 16 }: { category: Category; size?: number }): JSX.Element {
  const Icon = CATEGORY_META[category]?.icon ?? Plug
  return <Icon size={size} aria-hidden />
}

export function Badge({ tone = 'neutral', children, title }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'muted'; children: ReactNode; title?: string }): JSX.Element {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>
}

export function DeviceStatusBadge({ status }: { status: DeviceStatus }): JSX.Element {
  const tone = status === 'ok' ? 'ok' : status === 'error' ? 'bad' : status === 'disabled' ? 'muted' : 'neutral'
  return <Badge tone={tone}>{status === 'unknown' ? 'status unknown' : status}</Badge>
}

const COLLECTOR_TONE: Record<CollectorStatus, 'ok' | 'warn' | 'bad' | 'muted' | 'info'> = {
  available: 'ok', unavailable: 'warn', unsupported: 'muted', permission_required: 'warn', stale: 'warn', not_scanned: 'info', error: 'bad'
}
export function CollectorStatusBadge({ status, partial }: { status: CollectorStatus; partial?: boolean }): JSX.Element {
  return <Badge tone={COLLECTOR_TONE[status]}>{status.replace('_', ' ')}{partial ? ' · partial' : ''}</Badge>
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }): JSX.Element {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  )
}

export function Empty({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }): JSX.Element {
  return (
    <div className="empty" role="status">
      {icon ?? <Activity size={22} aria-hidden />}
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  )
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }): JSX.Element {
  return (
    <div className="banner banner-bad" role="alert">
      <span>{message}</span>
      {onRetry && <button className="btn btn-sm" onClick={onRetry}>Retry</button>}
    </div>
  )
}

export function Spinner({ label = 'Loading' }: { label?: string }): JSX.Element {
  return <div className="spinner" role="status" aria-label={label}><span /></div>
}

export function formatBytes(n: number | undefined | null): string {
  if (n === undefined || n === null || !Number.isFinite(n)) return '—'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export const fullTime = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : '—')

export function formatValue(v: string | number | boolean, unit?: string): string {
  if (unit === 'B' && typeof v === 'number') return formatBytes(v)
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'number') return `${Number.isInteger(v) ? v : Math.round(v * 100) / 100}${unit ? ` ${unit}` : ''}`
  return unit ? `${v} ${unit}` : v
}
