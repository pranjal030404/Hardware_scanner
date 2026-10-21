import { linuxProviders } from './providers/linux'
import { linuxDetailProviders } from './providers/linux-detail'
import { osProviders } from './providers/os'
import type { MetricProvider } from './types'

export const allMetricProviders: MetricProvider[] = [...linuxProviders, ...linuxDetailProviders, ...osProviders]
export const providersForPlatform = (platform: NodeJS.Platform): MetricProvider[] => allMetricProviders.filter((p) => p.platforms.includes(platform))
