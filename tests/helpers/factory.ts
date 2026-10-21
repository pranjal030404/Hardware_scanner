import type { Collector } from '@collectors/core/types'
import type { CollectorResult, DeviceObservation } from '@shared/schemas'

export const AT = '2026-01-01T00:00:00.000Z'

export function obs(key: string, over: Partial<DeviceObservation> = {}): DeviceObservation {
  return {
    key, category: 'usb', name: key, status: 'ok', source: 'fake.a', identifiers: [], properties: [], relationships: [], fieldSources: {}, observedAt: AT, ...over
  }
}

export interface FakeState {
  result: CollectorResult | (() => CollectorResult | Promise<CollectorResult>) | Error
}

export function fakeCollector(id: string, state: FakeState, over: Partial<Collector> = {}): Collector {
  return {
    id, version: '1.0.0', platforms: ['linux', 'win32'], categories: ['usb'], permissions: [], method: 'fake', timeoutMs: 1000, retries: 0,
    isSupported: async () => true,
    async collect() {
      const r = state.result
      if (r instanceof Error) throw r
      return typeof r === 'function' ? r() : r
    },
    ...over
  }
}

export const complete = (observations: DeviceObservation[]): CollectorResult => ({ outcome: 'complete', observations, limitations: [] })
