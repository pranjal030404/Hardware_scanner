import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
const dist = join(__dirname, '..', 'dist')
import { PRODUCTION_CSP, WINDOW_WEB_PREFERENCES } from '../src/main/security/policy'
import { MIGRATIONS } from '../src/main/database/migrations'

const root = join(__dirname, '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')
const builder = read('electron-builder.yml')
const pkg = JSON.parse(read('package.json')) as { main: string; scripts: Record<string, string>; devDependencies: Record<string, string>; dependencies: Record<string, string>; author?: string; name?: string }

/** Configuration invariants only. These do not prove an installer was built: see docs/PACKAGING.md. */
describe('packaging configuration', () => {
  it('targets AppImage and an x64 NSIS installer that never deletes user data', () => {
    expect(builder).toMatch(/AppImage/)
    expect(builder).toMatch(/target:\s*nsis/)
    expect(builder).toMatch(/arch:\s*\[x64\]/)
    expect(builder).toMatch(/deleteAppDataOnUninstall:\s*false/)
  })

  it('ships only the compiled app and its icons exist', () => {
    expect(builder).toMatch(/- out\/\*\*/)
    expect(builder).not.toMatch(/- (src|tests|scripts|docs)\//)
    expect(builder).toMatch(/!\*\*\/\*\.map/)
    for (const f of ['build/icon.png', 'build/icon.ico']) expect(existsSync(join(root, f)) && statSync(join(root, f)).size > 1000).toBe(true)
    expect(pkg.main).toBe('out/main/index.js')
  })

  it('flips the dangerous Electron fuses off at package time', () => {
    expect(builder).toMatch(/runAsNode:\s*false/)
    expect(builder).toMatch(/enableNodeOptionsEnvironmentVariable:\s*false/)
    expect(builder).toMatch(/enableNodeCliInspectArguments:\s*false/)
    expect(builder).toMatch(/onlyLoadAppFromAsar:\s*true/)
    expect(builder).toMatch(/grantFileProtocolExtraPrivileges:\s*false/)
  })

  it('packages with electron-builder from the lockfile, and the packaging scripts exist', () => {
    expect(pkg.devDependencies['electron-builder']).toBeTruthy()
    expect(pkg.scripts['package:linux']).toMatch(/electron-builder --linux AppImage --publish never/)
    expect(pkg.scripts['package:win']).toMatch(/electron-builder --win nsis --x64 --publish never/)
    expect(read('package-lock.json')).toMatch(/node_modules\/electron-builder"/)
    expect(pkg.author).toBeTruthy()
  })

  it('has no native runtime dependency (SQLite is node:sqlite), so no per-platform rebuild is needed', () => {
    expect(Object.keys(pkg.dependencies)).toEqual(['zod'])
  })

  it('keeps the security-relevant window settings and a strict production CSP', () => {
    expect(WINDOW_WEB_PREFERENCES).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true })
    expect(PRODUCTION_CSP).toMatch(/default-src 'none'/)
    expect(PRODUCTION_CSP).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/)
  })

  it('migrations are append-only with contiguous versions (upgrade path from any released schema)', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1))
  })
})

describe('release workflow', () => {
  const ci = read('.github/workflows/ci.yml')
  it('installs from the lockfile and builds both platforms', () => {
    expect(ci).toMatch(/npm ci/)
    expect(ci).toMatch(/package-linux:/)
    expect(ci).toMatch(/package-windows:/)
    expect(ci).toMatch(/runs-on: windows-latest/)
    expect(ci).toMatch(/upload-artifact@/)
  })
  it('never publishes a release or uses secrets', () => {
    expect(ci).not.toMatch(/--publish (always|onTagOrDraft|onTag)/)
    expect(ci).not.toMatch(/gh release|action-gh-release|secrets\./)
    expect(ci).toMatch(/permissions:\s*\n\s*contents: read/)
  })
  it('keeps VM smoke tests non-blocking so they cannot be mistaken for hardware validation', () => {
    expect(ci).toMatch(/smoke-linux:[\s\S]*?continue-on-error: true/)
    expect(ci).toMatch(/smoke-windows:[\s\S]*?continue-on-error: true/)
  })
})

describe('platform portability of shared code', () => {
  const files = (dir: string): string[] =>
    readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []))
  it('main, shared and preload code contain no hard-coded Linux filesystem paths', () => {
    const offenders = [...files('src/main'), ...files('src/shared'), ...files('src/preload')].filter((f) => /['"`]\/(proc|sys|dev|etc|run|var|usr|home)\b/.test(read(f)))
    expect(offenders).toEqual([])
  })
  it('udev monitoring is only started on Linux and the DB path override is ignored in packaged builds', () => {
    const app = read('src/main/lifecycle/app.ts')
    expect(app).toMatch(/platform === 'linux' \? udevWatcherFactory : null/)
    expect(app).toMatch(/!app\.isPackaged && process\.env\['HIP_DB_PATH'\]/)
    expect(app).toMatch(/app\.getPath\('userData'\)/)
  })
})

describe('artifact names and CI globs (configuration only)', () => {
  const ci = read('.github/workflows/ci.yml')
  it('upload globs match the artifactName template and exclude the NSIS inner uninstaller', () => {
    expect(builder).toMatch(/artifactName:\s*\$\{name\}-\$\{version\}-\$\{os\}-\$\{arch\}\.\$\{ext\}/)
    expect(ci).toMatch(/dist\/hardware-intelligence-platform-\*-linux-x86_64\.AppImage/)
    expect(ci).toMatch(/dist\/hardware-intelligence-platform-\*-win-x64\.exe/)
    expect(ci).not.toMatch(/path: \|\s*\n\s*dist\/\*\.exe/)
    expect(pkg.name).toBe('hardware-intelligence-platform')
  })
  it('both package jobs run the artifact verifier, which fails the job on any problem', () => {
    expect(ci).toMatch(/verify-artifacts\.mjs linux/)
    expect(ci).toMatch(/verify-artifacts\.mjs win/)
    expect(ci).toMatch(/if-no-files-found: error/)
  })
  it('the Windows job builds natively (no Wine) and the smoke job checks the checksum', () => {
    expect(ci.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')).not.toMatch(/\bwine\b/i)
    expect(ci).toMatch(/package-windows:[\s\S]*?runs-on: windows-latest/)
    expect(ci).toMatch(/Checksum mismatch/)
  })
})

/** Runtime evidence about the real build output. Skipped (not passed) when no Linux build is present. */
describe.skipIf(!existsSync(join(dist, 'linux-unpacked')))('built Linux package (inspects dist/, not configuration)', () => {
  it('passes the artifact verifier: version, ELF x86-64, fuses read from the binary, asar content', () => {
    const r = spawnSync(process.execPath, [join(root, 'scripts/verify-artifacts.mjs'), 'linux', dist], { cwd: root, encoding: 'utf8' })
    expect(r.stderr).toBe('')
    expect(r.stdout).toMatch(/fuse GrantFileProtocolExtraPrivileges = false/)
    expect(r.status).toBe(0)
  })
})
