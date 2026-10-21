/**
 * Inspect freshly built packages and write dist/SHA256SUMS.txt.
 *   node scripts/verify-artifacts.mjs linux|win [dist]
 * Checks (each is a real inspection of the build output, not of configuration files):
 *   - the installer exists, is non-trivial in size, and its file name carries the package.json version
 *   - the unpacked application binary has the expected CPU architecture (ELF / PE header)
 *   - the Electron fuses READ BACK from that binary match the policy
 *   - the packaged app.asar contains the entry points and no sources, tests or source maps of ours
 * Exits non-zero (with a reason) on any failure, so CI cannot report a missing/incorrect artifact as success.
 */
import { createHash } from 'node:crypto'
import { existsSync, openSync, readSync, closeSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses'
import asar from '@electron/asar'

const [platform, distArg] = [process.argv[2], process.argv[3] ?? 'dist']
if (!['linux', 'win'].includes(platform)) { console.error('usage: verify-artifacts.mjs linux|win [dist]'); process.exit(2) }
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const failures = []
const fail = (m) => { failures.push(m); console.error(`FAIL  ${m}`) }
const ok = (m) => console.log(`PASS  ${m}`)

const installerRe = platform === 'linux' ? /\.AppImage$/ : /^(?!.*[Uu]ninstall).*\.exe$/
const installers = existsSync(distArg) ? readdirSync(distArg).filter((f) => installerRe.test(f) && statSync(join(distArg, f)).isFile()) : []
if (installers.length !== 1) { fail(`expected exactly one ${platform === 'linux' ? 'AppImage' : 'installer .exe'} in ${distArg}, found ${installers.length}: ${installers.join(', ')}`); process.exit(1) }
const installer = join(distArg, installers[0])
const size = statSync(installer).size
size > 30 * 1024 * 1024 ? ok(`installer exists: ${installers[0]} (${(size / 1048576).toFixed(1)} MB)`) : fail(`installer is suspiciously small: ${size} bytes`)
installers[0].includes(`-${pkg.version}-`) ? ok(`file name carries version ${pkg.version}`) : fail(`file name does not contain version ${pkg.version}`)
installers[0].includes(platform === 'linux' ? 'x86_64' : 'x64') ? ok('file name carries the x64 architecture') : fail('file name does not state the x64 architecture')

const unpacked = join(distArg, platform === 'linux' ? 'linux-unpacked' : 'win-unpacked')
const exe = join(unpacked, platform === 'linux' ? pkg.name : `${pkg.productName}.exe`)
if (!existsSync(exe)) fail(`unpacked application binary missing: ${exe}`)
else {
  const head = Buffer.alloc(4096)
  const fd = openSync(exe, 'r'); readSync(fd, head, 0, 4096, 0); closeSync(fd)
  if (platform === 'linux') {
    const isElf = head.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    isElf && head.readUInt16LE(18) === 0x3e ? ok('application binary is ELF x86-64') : fail('application binary is not ELF x86-64')
  } else {
    const pe = head.readUInt32LE(0x3c)
    const sigOk = head.subarray(0, 2).toString() === 'MZ' && head.subarray(pe, pe + 4).equals(Buffer.from('PE\0\0'))
    sigOk && head.readUInt16LE(pe + 4) === 0x8664 ? ok('application binary is PE x86-64 (x64)') : fail('application binary is not a PE x64 executable')
  }
  const wire = await getCurrentFuseWire(exe)
  const want = { RunAsNode: false, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false, EnableCookieEncryption: true, OnlyLoadAppFromAsar: true, GrantFileProtocolExtraPrivileges: false }
  for (const [name, expected] of Object.entries(want)) {
    const actual = wire[FuseV1Options[name]] === 49 // '1' = enabled, '0' = disabled
    actual === expected ? ok(`fuse ${name} = ${expected}`) : fail(`fuse ${name} is ${actual}, expected ${expected}`)
  }
}

const asarPath = join(unpacked, 'resources', 'app.asar')
if (!existsSync(asarPath)) fail('resources/app.asar missing')
else {
  const files = asar.listPackage(asarPath).map((f) => f.replaceAll('\\', '/'))
  for (const need of ['/out/main/index.js', '/out/preload/index.js', '/out/renderer/index.html', '/package.json']) files.includes(need) ? ok(`app.asar contains ${need}`) : fail(`app.asar is missing ${need}`)
  const own = files.filter((f) => !f.startsWith('/node_modules/'))
  const bad = own.filter((f) => /\.map$|\/tests?\/|\/src\/|\.tsx?$/.test(f))
  bad.length ? fail(`unexpected first-party files in app.asar: ${bad.slice(0, 5).join(', ')}`) : ok('app.asar has no first-party sources, tests or source maps')
  const zodSrc = files.filter((f) => f.startsWith('/node_modules/zod/src/'))
  zodSrc.length ? fail(`zod sources/tests were packaged (${zodSrc.length} files)`) : ok('app.asar has no zod sources/tests')
}

const sum = createHash('sha256').update(readFileSync(installer)).digest('hex')
writeFileSync(join(distArg, 'SHA256SUMS.txt'), `${sum}  ${installers[0]}\n`)
console.log(`\nSHA-256  ${sum}  ${installers[0]}`)
if (failures.length) { console.error(`\n${failures.length} artifact check(s) failed`); process.exit(1) }
console.log('\nAll artifact checks passed')
