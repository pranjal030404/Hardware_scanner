import type { CommandRunner } from '@collectors/core/runner'
import type { ConnectionAttempt } from './types'

export interface KernelLine {
  at: string
  text: string
}

export interface KernelLog {
  lines: KernelLine[]
  limitation: string | null
}

/** Reads recent kernel messages via journalctl (dmesg is usually restricted to root). */
export async function readKernelLog(run: CommandRunner, sinceMinutes = 180): Promise<KernelLog> {
  const r = await run('journalctl', ['-k', '-q', '--no-pager', '-o', 'short-iso', `--since=-${sinceMinutes}min`, '-n', '5000'], { timeoutMs: 8000, maxOutputBytes: 4_000_000 })
  if (!r.ok) {
    const why = r.notFound ? 'journalctl was not found' : /permission|not seeing messages/i.test(r.stderr) ? 'This user cannot read the kernel log (add the user to the "systemd-journal" or "wheel" group)' : `journalctl failed: ${r.stderr.trim().slice(0, 200) || r.code}`
    return { lines: [], limitation: why }
  }
  return { lines: parseKernelLog(r.stdout), limitation: null }
}

export function parseKernelLog(text: string): KernelLine[] {
  const out: KernelLine[] = []
  for (const line of text.split('\n')) {
    // 2026-10-27T05:17:10+0530 fedora kernel: usb 3-1: new full-speed USB device …
    const m = /^(\S+)\s+\S+\s+kernel:\s?(.*)$/.exec(line)
    if (m) out.push({ at: m[1]!, text: m[2]! })
  }
  return out
}

export interface KnownProblem {
  pattern: RegExp
  severity: 'fail' | 'warn' | 'info'
  explanation: string
}

/** Kernel messages that explain why a USB device is not working, in plain words. */
export const USB_PROBLEMS: KnownProblem[] = [
  { pattern: /over-current/i, severity: 'fail', explanation: 'The port detected the device drawing more current than allowed and cut its power. Usually a short or a fault in the device or its cable. Unplug it; do not keep re-plugging a device that triggers this.' },
  { pattern: /unable to enumerate USB device/i, severity: 'fail', explanation: 'The laptop saw something plugged in but could not talk to it at all after several retries, so no driver was ever loaded. Most often a broken cable or connector, a dirty port, or dead device electronics.' },
  { pattern: /Cannot enable\. Maybe the USB cable is bad/i, severity: 'fail', explanation: 'The port could not bring up a link with the device. Typically a bad cable or connector.' },
  { pattern: /device not accepting address/i, severity: 'fail', explanation: 'The device did not respond to the first setup command. Usually a cable, connector or power problem, or failing device electronics.' },
  { pattern: /descriptor read.*error -71|error -71/i, severity: 'fail', explanation: 'Error -71 (protocol error): the electrical signal between the laptop and the device is corrupted. Usual causes: a damaged or poor-quality cable, a loose or dirty port, too long a cable or unpowered hub, or a failing device.' },
  { pattern: /error -110/i, severity: 'fail', explanation: 'Error -110 (timeout): the device stopped answering. Its firmware may have hung, or it is not getting enough power.' },
  { pattern: /error -62/i, severity: 'warn', explanation: 'Error -62 (timer expired): the device answered too slowly.' },
  { pattern: /error -32/i, severity: 'warn', explanation: 'Error -32 (stall): the device refused a request. Usually a firmware compatibility issue rather than a hardware fault.' },
  { pattern: /can't set config|failed to set configuration/i, severity: 'fail', explanation: 'The device was recognised but would not switch into a working configuration, often because it needs more power than the port offers.' },
  { pattern: /can't add hid device|hid.*probe.*failed|usbhid.*failed/i, severity: 'fail', explanation: 'The HID driver (used for mice and keyboards) could not attach to the device.' },
  { pattern: /reset (low|full|high|super|super\+)-speed USB device/i, severity: 'warn', explanation: 'The kernel had to reset the device. An occasional reset is harmless; many resets mean an unstable connection.' },
  { pattern: /USB disconnect/i, severity: 'info', explanation: 'The device was disconnected (unplugged, lost power or dropped off the bus).' }
]

export const STORAGE_PROBLEMS: KnownProblem[] = [
  { pattern: /I\/O error|blk_update_request|Buffer I\/O error|critical medium error/i, severity: 'fail', explanation: 'Reads or writes failed. The drive, its cable or its enclosure is faulty, or the medium is damaged. Back up anything important now.' },
  // Case-sensitive whole-word UNC: "pci function" must not match.
  { pattern: /\bUNC\b|[Uu]ncorrectable|Medium Error/, severity: 'fail', explanation: 'The drive reported data it cannot read back (bad sectors).' },
  { pattern: /\breset(ting)? controller|\btimeout\b|timed out/i, severity: 'warn', explanation: 'The drive stopped responding and had to be reset. A failing drive, a bad cable or an under-powered enclosure.' }
]

export const NETWORK_PROBLEMS: KnownProblem[] = [
  { pattern: /firmware.*(fail|error)|failed to load firmware|Direct firmware load.*failed/i, severity: 'fail', explanation: 'The adapter\'s firmware did not load, so it cannot work. Install the linux-firmware package for this adapter.' },
  { pattern: /Link is Down/i, severity: 'info', explanation: 'The cable or wireless link went down.' },
  { pattern: /(tx|transmit).*timed out|hang|watchdog/i, severity: 'fail', explanation: 'The adapter stopped transmitting and had to be reset (driver or hardware fault).' }
]

/** Kernel lines that mention a USB device ("usb 3-1:", "usb 3-1.2:") or its port ("usb3-port1:"). */
export function usbLines(lines: readonly KernelLine[], port: string): KernelLine[] {
  const [bus, path] = port.split('-') as [string, string]
  const portRe = path && !path.includes('.') ? `|usb${bus}-port${path}:` : ''
  const re = new RegExp(`\\busb ${port.replace(/\./g, '\\.')}:${portRe.replace(/\./g, '\\.')}`)
  return lines.filter((l) => re.test(l.text))
}

export function classify(lines: readonly KernelLine[], problems: readonly KnownProblem[]): { line: KernelLine; problem: KnownProblem }[] {
  return lines.flatMap((line) => {
    const problem = problems.find((p) => p.pattern.test(line.text))
    return problem ? [{ line, problem }] : []
  })
}

/**
 * Connection attempts that failed: a USB port where the kernel reported an enumeration or power
 * error. These devices never reach the inventory, so this is often the only trace of them.
 */
export function failedAttempts(lines: readonly KernelLine[], present: (port: string) => boolean): ConnectionAttempt[] {
  const failing = USB_PROBLEMS.filter((p) => p.severity === 'fail')
  const out = new Map<string, ConnectionAttempt>()
  for (const l of lines) {
    const m = /\busb (\d+-[\d.]+):|\busb(\d+)-port(\d+):/.exec(l.text)
    if (!m) continue
    const port = m[1] ?? `${m[2]}-${m[3]}`
    // A failed first try is often followed by a successful retry: a device that was then found (or
    // later disconnected, which only happens after it connected) did connect, so its earlier error is not a failed attempt.
    if (/New USB device found|USB disconnect/i.test(l.text)) { out.delete(port); continue }
    const p = failing.find((x) => x.pattern.test(l.text))
    if (!p) continue
    out.set(port, { port, at: l.at, message: l.text, explanation: p.explanation, nowPresent: present(port) })
  }
  return [...out.values()].sort((a, b) => b.at.localeCompare(a.at))
}
