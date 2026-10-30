import { promises as fs } from 'node:fs'
import PERF_HELPER from '../../resources/linux/hip-perf-helper?raw'
import HID_PROBE from '../../resources/linux/hip-hid-probe?raw'

/**
 * The optional privileged helpers. They are installed by the user (resources/linux/install.sh run
 * with sudo), never by the application, and each runs only through its own polkit action. Before
 * using one, the app checks that the installed file is exactly the reviewed program it ships with.
 */
export const HELPER_DIR = '/usr/local/libexec/hardware-intelligence'
export const POLICY_PATH = '/usr/share/polkit-1/actions/dev.hardware-intelligence.policy'

export type HelperName = 'hip-perf-helper' | 'hip-hid-probe'

export const HELPER_SOURCES: Record<HelperName, string> = { 'hip-perf-helper': PERF_HELPER, 'hip-hid-probe': HID_PROBE }

export interface HelperStatus {
  name: HelperName
  path: string
  /** Installed, root-owned, not writable by others, identical to the bundled copy, with its polkit policy. */
  usable: boolean
  /** Why it cannot be used (null when usable). */
  reason: string | null
}

export interface HelperFs {
  lstat(p: string): Promise<{ uid: number; mode: number; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }>
  readFile(p: string): Promise<string>
}

const realFs: HelperFs = { lstat: (p) => fs.lstat(p), readFile: (p) => fs.readFile(p, 'utf8') }

export const INSTALL_HINT = 'Install the optional helpers yourself with: sudo sh resources/linux/install.sh (see docs/PERFORMANCE.md). Without them every control stays read-only.'

export async function helperStatus(name: HelperName, platform: string, f: HelperFs = realFs): Promise<HelperStatus> {
  const path = `${HELPER_DIR}/${name}`
  const no = (reason: string): HelperStatus => ({ name, path, usable: false, reason })
  if (platform !== 'linux') return no('Privileged helpers exist only for Linux.')
  try {
    const dir = await f.lstat(HELPER_DIR)
    if (!dir.isDirectory() || dir.uid !== 0 || (dir.mode & 0o022) !== 0) return no(`${HELPER_DIR} must be a root-owned directory that only root can write to. Reinstall the helpers.`)
  } catch {
    return no(`The privileged helper is not installed. ${INSTALL_HINT}`)
  }
  let st
  try {
    st = await f.lstat(path)
  } catch {
    return no(`${name} is not installed. ${INSTALL_HINT}`)
  }
  // A symlink or a file others can modify could be swapped for another program after the user authenticates.
  if (st.isSymbolicLink() || !st.isFile()) return no(`${path} is not a regular file. Reinstall the helpers.`)
  if (st.uid !== 0) return no(`${path} is not owned by root. Reinstall the helpers.`)
  if ((st.mode & 0o022) !== 0) return no(`${path} can be modified by non-root users. Reinstall the helpers.`)
  if ((st.mode & 0o100) === 0) return no(`${path} is not executable. Reinstall the helpers.`)
  try {
    if ((await f.readFile(path)) !== HELPER_SOURCES[name]) return no(`${path} differs from the version this application ships (an older or modified copy). Reinstall the helpers from this version.`)
  } catch {
    return no(`${path} cannot be read to verify it. Reinstall the helpers.`)
  }
  try {
    await f.lstat(POLICY_PATH)
  } catch {
    return no(`The polkit policy ${POLICY_PATH} is missing. Reinstall the helpers.`)
  }
  return { name, path, usable: true, reason: null }
}
