import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_INDEX_URL, resolveAppAsset } from '../src/main/security/app-protocol'
import { debugDecision, findDebugSwitches } from '../src/main/security/debug-switches'
import { devToolsAllowed, isTrustedUrl } from '../src/main/security/policy'

const root = join('/opt', 'app', 'out', 'renderer')

describe('hip-app:// asset resolution (path confinement)', () => {
  it('serves the index and known asset types inside the renderer directory', () => {
    expect(resolveAppAsset(root, APP_INDEX_URL)).toMatchObject({ ok: true, path: join(root, 'index.html'), contentType: expect.stringContaining('text/html') })
    expect(resolveAppAsset(root, 'hip-app://renderer/')).toMatchObject({ ok: true, path: join(root, 'index.html') })
    expect(resolveAppAsset(root, 'hip-app://renderer/assets/index-abc.js')).toMatchObject({ ok: true, contentType: expect.stringContaining('javascript') })
    expect(resolveAppAsset(root, 'hip-app://renderer/assets/a.css?x=1')).toMatchObject({ ok: true })
  })
  it('refuses traversal, encodings, other hosts, credentials, other schemes and unknown types', () => {
    for (const u of ['hip-app://renderer/../../etc/passwd', 'hip-app://renderer/%2e%2e/%2e%2e/etc/passwd.js', 'hip-app://renderer/..%2f..%2fsecret.js', 'hip-app://renderer/a%5c..%5cb.js', 'hip-app://renderer/%00.js']) {
      const r = resolveAppAsset(root, u)
      // Either refused, or (when the URL parser already normalised it) confined to the renderer directory.
      if (r.ok) expect(r.path.startsWith(root + '/'), u).toBe(true)
    }
    for (const u of ['hip-app://renderer/..%2f..%2fsecret.js', 'hip-app://renderer/a%5c..%5cb.js', 'hip-app://renderer/%00.js']) expect(resolveAppAsset(root, u).ok, u).toBe(false)
    expect(resolveAppAsset(root, 'hip-app://evil/index.html')).toEqual({ ok: false, status: 403 })
    expect(resolveAppAsset(root, 'hip-app://user:pw@renderer/index.html')).toEqual({ ok: false, status: 403 })
    expect(resolveAppAsset(root, 'file:///opt/app/out/renderer/index.html')).toEqual({ ok: false, status: 403 })
    expect(resolveAppAsset(root, 'hip-app://renderer/assets/secret.sqlite')).toEqual({ ok: false, status: 404 })
    expect(resolveAppAsset(root, 'hip-app://renderer/index.html', 'POST')).toEqual({ ok: false, status: 405 })
    expect(resolveAppAsset(root, 'not a url')).toEqual({ ok: false, status: 400 })
  })
  it('is the only trusted origin for IPC/navigation in production', () => {
    const o = { appUrlPrefix: 'hip-app://renderer' }
    expect(isTrustedUrl(APP_INDEX_URL, o)).toBe(true)
    for (const u of ['hip-app://renderer-evil/index.html', 'hip-app://other/index.html', 'file:///opt/app/out/renderer/index.html', 'https://example.com']) expect(isTrustedUrl(u, o), u).toBe(false)
  })
})

describe('debug switch policy', () => {
  const argv = ['--remote-debugging-port=9222']
  it('packaged builds refuse debugging switches unless explicitly opted in', () => {
    expect(debugDecision({ packaged: true, argv, env: {} }).refuse).toBe(true)
    for (const sw of ['--remote-debugging-port=0', '--remote-debugging-pipe', '--remote-debugging-address=0.0.0.0', '--remote-allow-origins=*', '--inspect', '--inspect=9229', '--inspect-brk=9229', '--debug-port=5858'])
      expect(debugDecision({ packaged: true, argv: [sw], env: {} }).refuse, sw).toBe(true)
    expect(debugDecision({ packaged: true, argv, env: { HIP_ENABLE_DEBUGGING: '1' } }).refuse).toBe(false)
    expect(debugDecision({ packaged: true, argv, env: { HIP_ENABLE_DEBUGGING: 'true' } }).refuse).toBe(true)
  })
  it('development runs and ordinary arguments are never restricted', () => {
    expect(debugDecision({ packaged: false, argv, env: {} }).refuse).toBe(false)
    const normal = ['--no-sandbox', '--disable-gpu', '--ozone-platform=x11', '--enable-features=UseOzonePlatform', '--lang=de', 'file.json', '--remote-debugging-portal-note']
    expect(findDebugSwitches(normal)).toEqual([])
    expect(debugDecision({ packaged: true, argv: normal, env: {} }).refuse).toBe(false)
  })
})

describe('DevTools policy', () => {
  it('is on for development, off for packaged builds unless explicitly opted in', () => {
    expect(devToolsAllowed(false, {})).toBe(true)
    expect(devToolsAllowed(true, {})).toBe(false)
    expect(devToolsAllowed(true, { HIP_ENABLE_DEBUGGING: '0' })).toBe(false)
    expect(devToolsAllowed(true, { HIP_ENABLE_DEBUGGING: '1' })).toBe(true)
  })
})
