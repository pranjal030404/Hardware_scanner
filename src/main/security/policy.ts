/** Pure security policy helpers, kept free of Electron imports so they are unit-testable. */

export const WINDOW_WEB_PREFERENCES = {
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  experimentalFeatures: false,
  spellcheck: false
} as const

export const PRODUCTION_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

/** The dev server needs websocket HMR and inline scripts injected by the React plugin. */
export const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self' ws://localhost:* http://localhost:*",
  "object-src 'none'",
  "base-uri 'none'"
].join('; ')

export interface Origins {
  /** `file://<abs path to out/renderer>/` in production, or the dev server URL. */
  appUrlPrefix: string
}

/** Only pages we ship may navigate within the window or call IPC. */
export function isTrustedUrl(url: string | undefined | null, o: Origins): boolean {
  if (!url) return false
  return url === o.appUrlPrefix || url.startsWith(o.appUrlPrefix.endsWith('/') ? o.appUrlPrefix : o.appUrlPrefix + '/') || url.startsWith(o.appUrlPrefix + '#')
}

/** External links are never opened inside the app and only http(s) may leave it. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * DevTools (menu item and Ctrl+Shift+I) exist only in unpackaged runs. A packaged build enables them
 * only with the same explicit opt-in as the debugging switches (HIP_ENABLE_DEBUGGING=1).
 */
export function devToolsAllowed(packaged: boolean, env: NodeJS.ProcessEnv): boolean {
  return !packaged || env['HIP_ENABLE_DEBUGGING'] === '1'
}
