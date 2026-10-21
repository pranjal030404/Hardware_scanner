import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { HipEvent, MonitorStatus } from '@shared/schemas'
import { api } from '../services/api'

interface Ctx {
  /** Increments whenever inventory-relevant events arrive; pages use it to refetch. */
  tick: number
  live: HipEvent[]
  monitor: MonitorStatus | null
  setMonitor: (m: MonitorStatus) => void
}

const EventsContext = createContext<Ctx>({ tick: 0, live: [], monitor: null, setMonitor: () => {} })

const REFRESH_TYPES = new Set(['device.discovered', 'device.updated', 'device.connected', 'device.disconnected', 'device.status_changed', 'collector.completed', 'collector.failed', 'diagnostic.created', 'diagnostic.resolved'])

export function EventsProvider({ children }: { children: ReactNode }): JSX.Element {
  const [tick, setTick] = useState(0)
  const [live, setLive] = useState<HipEvent[]>([])
  const [monitor, setMonitor] = useState<MonitorStatus | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    void api.monitorStatus().then(setMonitor)
    return api.onEvent((e) => {
      if (e.type === 'monitor.status_changed') {
        void api.monitorStatus().then(setMonitor)
        return
      }
      if (e.type.startsWith('device.') || e.type === 'collector.failed') setLive((l) => [e, ...l].slice(0, 200))
      if (REFRESH_TYPES.has(e.type)) {
        // Coalesce bursts (a scan emits one completion per collector).
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => {
          setTick((t) => t + 1)
          void api.monitorStatus().then(setMonitor)
        }, 250)
      }
    })
  }, [])

  const value = useMemo(() => ({ tick, live, monitor, setMonitor }), [tick, live, monitor])
  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>
}

export const useEvents = (): Ctx => useContext(EventsContext)
