/**
 * Pure helpers for the `hip-app://renderer/` scheme that serves the bundled renderer in production.
 * Serving through a custom scheme (instead of `file://`) lets the packaged binary run with the
 * GrantFileProtocolExtraPrivileges fuse OFF, so web content never gets special file: privileges.
 * Electron-free so the path-confinement logic is unit-testable.
 */
import { extname, resolve, sep } from 'node:path'

export const APP_SCHEME = 'hip-app'
export const APP_HOST = 'renderer'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_INDEX_URL = `${APP_ORIGIN}/index.html`

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff'
}

export type AssetResolution = { ok: true; path: string; contentType: string } | { ok: false; status: 400 | 403 | 404 | 405 }

/** Map a request for the app scheme to a file strictly inside `rootDir`; everything else is refused. */
export function resolveAppAsset(rootDir: string, requestUrl: string, method = 'GET'): AssetResolution {
  if (method !== 'GET' && method !== 'HEAD') return { ok: false, status: 405 }
  let u: URL
  try {
    u = new URL(requestUrl)
  } catch {
    return { ok: false, status: 400 }
  }
  if (u.protocol !== `${APP_SCHEME}:` || u.host !== APP_HOST || u.username || u.password || u.port) return { ok: false, status: 403 }
  let rel: string
  try {
    rel = decodeURIComponent(u.pathname)
  } catch {
    return { ok: false, status: 400 }
  }
  if (rel.includes('\0') || rel.includes('\\')) return { ok: false, status: 400 }
  if (rel === '/' || rel === '') rel = '/index.html'
  const root = resolve(rootDir)
  const target = resolve(root, '.' + rel)
  if (target !== root && !target.startsWith(root + sep)) return { ok: false, status: 403 }
  const contentType = MIME[extname(target).toLowerCase()]
  if (!contentType) return { ok: false, status: 404 } // only known asset types are ever served
  return { ok: true, path: target, contentType }
}
