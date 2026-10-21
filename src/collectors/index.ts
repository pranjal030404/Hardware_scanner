import type { Collector } from './core/types'
import { linuxCollectors } from './linux'
import { windowsCollectors } from './windows'

export const allCollectors: Collector[] = [...linuxCollectors, ...windowsCollectors]
export { runCollector, healthFromOutcome } from './core/collector-runner'
export { mergeObservations, deviceIdFromKey, contentHash, diffObservations } from './core/normalize'
export { hostContext } from './core/context'
