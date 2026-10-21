import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { IPC_CHANNELS, IPC_REQUEST_SCHEMAS } from '@shared/ipc'
import { dispatch, IpcError, type Handlers } from '../src/main/ipc/dispatch'
import { DEV_CSP, isSafeExternalUrl, isTrustedUrl, PRODUCTION_CSP, WINDOW_WEB_PREFERENCES } from '../src/main/security/policy'
import { buildExport } from '../src/main/services/export'
import { SettingsSchema } from '@shared/schemas'

const origins = { appUrlPrefix: 'file:///opt/app/out/renderer' }
const okUrl = 'file:///opt/app/out/renderer/index.html'
const handlers = Object.fromEntries(IPC_CHANNELS.map((c) => [c, async (i: unknown) => ({ called: c, input: i })])) as unknown as Handlers

describe('Electron window hardening', () => {
  it('uses the required web preferences', () => {
    expect(WINDOW_WEB_PREFERENCES).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, webviewTag: false, allowRunningInsecureContent: false })
  })
  it('production CSP forbids remote content, inline scripts, eval and framing', () => {
    expect(PRODUCTION_CSP).toContain("default-src 'none'")
    expect(PRODUCTION_CSP).toContain("script-src 'self'")
    expect(PRODUCTION_CSP).not.toMatch(/unsafe-eval|https?:|\*/)
    expect(PRODUCTION_CSP).toContain("connect-src 'none'")
    expect(DEV_CSP).not.toMatch(/unsafe-eval/)
  })
  it('only trusts our own pages and only http(s) may be opened externally', () => {
    expect(isTrustedUrl(okUrl, origins)).toBe(true)
    for (const u of ['https://evil.example', 'file:///etc/passwd', 'file:///opt/app/out/renderer-evil/x.html', 'javascript:alert(1)', '', undefined]) expect(isTrustedUrl(u, origins)).toBe(false)
    expect(isSafeExternalUrl('https://example.com')).toBe(true)
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'smb://x', 'not a url']) expect(isSafeExternalUrl(u)).toBe(false)
  })
  it('the app source never enables nodeIntegration or disables isolation/sandbox/webSecurity', () => {
    const app = readFileSync('src/main/lifecycle/app.ts', 'utf8')
    expect(app).not.toMatch(/nodeIntegration:\s*true|contextIsolation:\s*false|sandbox:\s*false|webSecurity:\s*false/)
    expect(app).toContain('WINDOW_WEB_PREFERENCES')
    expect(app).toContain('will-navigate')
    expect(app).toContain("setWindowOpenHandler")
    expect(app).toContain('setPermissionRequestHandler')
  })
})

describe('IPC dispatch', () => {
  it('rejects unknown channels, including privileged-sounding ones', async () => {
    for (const ch of ['shell:exec', 'fs:read', 'exec', '__proto__', 'inventory:scan ', 'app:info\n'])
      await expect(dispatch(ch, {}, okUrl, handlers, origins)).rejects.toMatchObject({ code: 'UNKNOWN_CHANNEL' })
  })
  it('rejects calls from untrusted frames', async () => {
    for (const u of ['https://evil.example/', undefined, 'file:///tmp/x.html'])
      await expect(dispatch('app:info', undefined, u, handlers, origins)).rejects.toMatchObject({ code: 'UNTRUSTED_SENDER' })
  })
  it('rejects malformed payloads and strips nothing silently (strict objects)', async () => {
    const bad: [string, unknown][] = [
      ['inventory:list', { category: 'toaster' }], ['inventory:list', { search: 'x'.repeat(201) }], ['inventory:list', { extra: 1 }], ['inventory:list', 'str'],
      ['inventory:get', {}], ['inventory:get', { id: '' }], ['inventory:get', { id: 5 }], ['inventory:scan', { collectorIds: [1] }], ['inventory:scan', { cmd: 'rm -rf /' }],
      ['events:recent', { limit: 0 }], ['events:recent', { limit: 10_000 }], ['monitor:setPaused', { paused: 'yes' }],
      ['settings:set', { key: 'notASetting', value: 1 }], ['settings:set', { key: 'theme' , extra: 1 }], ['app:info', { x: 1 }]
    ]
    for (const [ch, payload] of bad) await expect(dispatch(ch, payload, okUrl, handlers, origins), `${ch} ${JSON.stringify(payload)}`).rejects.toBeInstanceOf(IpcError)
  })
  it('passes validated input (with defaults) to handlers', async () => {
    expect(await dispatch('events:recent', {}, okUrl, handlers, origins)).toEqual({ called: 'events:recent', input: { limit: 100 } })
    expect(await dispatch('inventory:list', { category: 'usb', search: 'x' }, okUrl, handlers, origins)).toMatchObject({ input: { category: 'usb', search: 'x' } })
  })
  it('exposes no channel that executes commands or touches arbitrary files', () => {
    expect(IPC_CHANNELS.filter((c) => /(^|:)(exec|shell|spawn|run|fs|file|read|write|eval|command|cmd|path)\w*$/i.test(c) && !/^diagnostics:evaluate$/.test(c))).toEqual([])
    // Export/backup take NO path from the renderer; the user picks the destination in a native dialog.
    expect(IPC_REQUEST_SCHEMAS['export:inventory'].safeParse({ path: '/etc/passwd' }).success).toBe(false)
    expect(IPC_REQUEST_SCHEMAS['database:backup'].safeParse({ path: '/etc/passwd' }).success).toBe(false)
  })
})

describe('preload surface', () => {
  const raw = readFileSync('src/preload/index.ts', 'utf8')
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  it('exposes a fixed object, not generic ipcRenderer access', () => {
    expect(src).toContain("exposeInMainWorld('hip', api)")
    expect(src).not.toMatch(/exposeInMainWorld\([^)]*ipcRenderer\b[^)]*\)/)
    expect(src).not.toMatch(/ipcRenderer\.invoke\(\s*[a-zA-Z_]+\s*[,)]/) // every channel is a string literal
    expect(src).not.toMatch(/require\(|child_process|\bfs\b|process\./)
  })
  it('only invokes channels that exist in the whitelist', () => {
    const used = [...src.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]!)
    expect(used.length).toBeGreaterThan(5)
    for (const u of used) expect(IPC_CHANNELS).toContain(u)
  })
  it('preload and its shared imports stay free of runtime dependencies (sandbox cannot require them)', () => {
    expect(readFileSync('src/shared/api.ts', 'utf8')).not.toMatch(/^import (?!type)/m)
  })
})

describe('renderer isolation', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p] })
  }
  it('renderer code never imports node/electron or runs shell/fs/eval', () => {
    const files = walk('src/renderer').filter((f) => /\.(tsx?|html)$/.test(f))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const s = readFileSync(f, 'utf8')
      expect(s, f).not.toMatch(/from ['"](node:|fs|child_process|electron|os|path)/)
      expect(s, f).not.toMatch(/\beval\(|new Function\(|dangerouslySetInnerHTML|require\(/)
    }
  })
  it('index.html carries a restrictive CSP', () => {
    const html = readFileSync('src/renderer/index.html', 'utf8')
    expect(html).toMatch(/Content-Security-Policy/)
    expect(html).toMatch(/default-src 'none'|default-src 'self'/)
    expect(html).not.toMatch(/unsafe-eval/)
  })
})

describe('export redaction', () => {
  const rows = {
    devices: [{ id: 'd1', key: 'usb:1:2:sn:SECRETSERIAL', category: 'usb', name: 'Dev', field_sources: '{}', status: 'ok', presence: 'present', first_seen: 'a', last_seen: 'b', source: 's' }, { id: 'd2', key: 'pci:0', category: 'pci', name: 'P', field_sources: '{}', status: 'ok', presence: 'present', first_seen: 'a', last_seen: 'b', source: 's' }],
    identifiers: [
      { device_id: 'd1', kind: 'serial', value: 'SECRETSERIAL', sensitive: 1 }, { device_id: 'd1', kind: 'mac_address', value: 'aa:bb:cc:dd:ee:ff', sensitive: 1 }, { device_id: 'd1', kind: 'usb_ids', value: '1:2', sensitive: 0 }
    ],
    properties: [
      { device_id: 'd1', key: 'hostname', value_text: 'my-laptop', value_type: 'string', source: 's', source_property: 'p', evidence: 'os_reported', observed_at: 'x', sensitive: 1 },
      { device_id: 'd1', key: 'ip_addresses', value_text: '10.0.0.5/24', value_type: 'string', source: 's', source_property: 'p', evidence: 'os_reported', observed_at: 'x', sensitive: 1 },
      { device_id: 'd1', key: 'speed', value_text: '480', value_type: 'number', unit: 'Mb/s', source: 's', source_property: 'p', evidence: 'os_reported', observed_at: 'x', sensitive: 0 }
    ],
    relationships: [{ device_id: 'd1', target_key: 'pci:0', type: 'bus_attachment', directness: 'reported', confidence: 1, source: 's' }, { device_id: 'd1', target_key: 'gone', type: 'bus_attachment', directness: 'reported', confidence: 1, source: 's' }]
  }
  const meta = { appVersion: '0', platform: 'linux', now: new Date('2026-01-01') }
  it('excludes sensitive fields by default and never leaks identity keys', () => {
    const json = JSON.stringify(buildExport(rows, SettingsSchema.parse({}), meta))
    for (const secret of ['SECRETSERIAL', 'aa:bb:cc:dd:ee:ff', 'my-laptop', '10.0.0.5']) expect(json).not.toContain(secret)
    expect(json).toContain('[redacted]')
    expect(json).toContain('"value":480')
    expect(json).not.toContain('usb:1:2:sn') // key embeds the serial
    const out = buildExport(rows, SettingsSchema.parse({}), meta)
    expect(out.privacy).toMatchObject({ serialsIncluded: false, redactedFields: 4 })
    expect(out.devices[0]!.relationships).toEqual([{ targetId: 'd2', type: 'bus_attachment', directness: 'reported', confidence: 1, source: 's' }]) // dangling target dropped
  })
  it('each privacy toggle releases only its own category', () => {
    const only = (k: string) => JSON.stringify(buildExport(rows, SettingsSchema.parse({ [k]: true }), meta))
    expect(only('exportIncludeSerials')).toContain('SECRETSERIAL'); expect(only('exportIncludeSerials')).not.toContain('aa:bb')
    expect(only('exportIncludeMacAddresses')).toContain('aa:bb:cc:dd:ee:ff'); expect(only('exportIncludeMacAddresses')).not.toContain('SECRETSERIAL')
    expect(only('exportIncludeHostname')).toContain('my-laptop'); expect(only('exportIncludeHostname')).not.toContain('10.0.0.5')
    expect(only('exportIncludeIpAddresses')).toContain('10.0.0.5')
  })
})
