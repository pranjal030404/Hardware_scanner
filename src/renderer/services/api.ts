import type { HipApi } from '@shared/api'

declare global {
  interface Window {
    /** Injected by the preload script; the only bridge to the main process. */
    hip: HipApi
  }
}

export const api: HipApi = window.hip
