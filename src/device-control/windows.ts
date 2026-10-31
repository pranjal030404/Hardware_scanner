import type { CommandRunner, RunResult } from '@collectors/core/runner'
import type { DeviceControlItem, InputRole } from '../device-test/types'
import { psQuote, runElevatedPowerShell, runPowerShell } from '../platform/windows'

/**
 * Windows device switching. There is no compositor equivalent of Hyprland here: input devices and
 * Bluetooth radios are PnP device nodes, and Wi-Fi is a network adapter. Reading their state needs no
 * privileges; changing it is reserved by Windows for administrators, so the user is asked through the
 * normal UAC prompt (the same idea as polkit on Linux).
 */

export interface WindowsDevice extends DeviceControlItem {
  /** PnP instance id, or the adapter name for Wi-Fi. */
  target: string
}

interface PnpRow {
  Class?: string
  Name?: string
  Id?: string
  Status?: string
  Problem?: string
  Present?: boolean
}

const json = (r: RunResult): unknown | null => {
  if (!r.ok) return null
  const text = r.stdout.trim()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

const array = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : v === null || v === undefined || v === '' ? [] : [v as T])

const disabledBy = (status: string | undefined, problem: string | undefined): boolean =>
  /CM_PROB_DISABLED/i.test(problem ?? '') || /^disabled$/i.test((status ?? '').trim())

/** Device classes and names that are a user-facing keyboard, pointing device or touchpad. */
export function windowsInputRole(row: PnpRow): InputRole | null {
  const cls = (row.Class ?? '').toLowerCase()
  const name = (row.Name ?? '').toLowerCase()
  if (cls === 'keyboard') return 'keyboard'
  if (/touchpad|touch pad|trackpad|track pad|precision touch/i.test(name)) return 'touchpad'
  if (/pointing stick|pointstick|pointsty|trackpoint/i.test(name)) return 'pointing stick'
  if (cls === 'mouse') return 'mouse'
  return null
}

const LIST_INPUT = `
$out = @()
Get-PnpDevice -Class Keyboard,Mouse,HIDClass | Where-Object { $_.Present -or ([string]$_.Problem -eq 'CM_PROB_DISABLED') } | ForEach-Object {
  $out += [pscustomobject]@{ Class=[string]$_.Class; Name=[string]$_.FriendlyName; Id=[string]$_.InstanceId; Status=[string]$_.Status; Problem=[string]$_.Problem; Present=[bool]$_.Present }
}
$out | ConvertTo-Json -Depth 3 -Compress`

const LIST_RADIO = `
$net = @()
Get-NetAdapter -Physical | ForEach-Object { $net += [pscustomobject]@{ Name=[string]$_.Name; Description=[string]$_.InterfaceDescription; Status=[string]$_.Status } }
$bt = @()
Get-PnpDevice -Class Bluetooth | Where-Object { $_.Present -or ([string]$_.Problem -eq 'CM_PROB_DISABLED') } | ForEach-Object {
  $bt += [pscustomobject]@{ Name=[string]$_.FriendlyName; Id=[string]$_.InstanceId; Status=[string]$_.Status; Problem=[string]$_.Problem; Present=[bool]$_.Present }
}
[pscustomobject]@{ net=$net; bt=$bt } | ConvertTo-Json -Depth 4 -Compress`

const isWireless = (name: string, description: string): boolean =>
  /wi-?fi|wireless|wlan|802\.11/i.test(description) || /^wi-?fi$/i.test(name)

const isBluetoothRadio = (row: PnpRow): boolean => {
  const name = row.Name ?? ''
  const id = row.Id ?? ''
  if (!id || !/bluetooth/i.test(name)) return false
  if (/enumerator|protocol|rfcomm|service/i.test(name)) return false
  return /^usb\\/i.test(id)
}

/** Input devices and radios this machine exposes, with their current on/off state. */
export async function windowsDevices(run: CommandRunner): Promise<{ items: WindowsDevice[]; notes: string[] }> {
  const notes: string[] = []
  const items: WindowsDevice[] = []

  const inputRes = await runPowerShell(run, LIST_INPUT)
  const inputRows = array<PnpRow>(json(inputRes))
  if (!inputRes.ok) notes.push(inputRes.notFound ? 'powershell.exe was not found, so device switches cannot be listed.' : `Windows device list failed: ${inputRes.stderr.trim() || inputRes.code}`)
  else if (!json(inputRes) && inputRes.stdout.trim()) notes.push('Windows returned a device list that could not be read.')

  for (const row of inputRows) {
    const role = windowsInputRole(row)
    if (!role || !row.Id) continue
    items.push({
      id: `win.input:${row.Id}`, kind: 'input', label: row.Name?.trim() || row.Id, role,
      enabled: !disabledBy(row.Status, row.Problem), controllable: true, reason: null,
      method: `Windows PnP (${row.Id})`, target: row.Id
    })
  }

  const radioRes = await runPowerShell(run, LIST_RADIO)
  const parsed = json(radioRes) as { net?: unknown; bt?: unknown } | null
  if (!radioRes.ok) notes.push(radioRes.notFound ? 'powershell.exe was not found, so radios cannot be listed.' : `Windows radio list failed: ${radioRes.stderr.trim() || radioRes.code}`)
  else if (!parsed) notes.push('Windows returned a radio list that could not be read.')

  for (const n of array<{ Name?: string; Description?: string; Status?: string }>(parsed?.net)) {
    const name = (n.Name ?? '').trim()
    if (!name || !isWireless(name, n.Description ?? '')) continue
    items.push({
      id: `win.radio:wifi:${name}`, kind: 'radio', label: 'Wi-Fi', role: `Wi-Fi radio (${n.Description || name})`,
      enabled: !/^disabled$/i.test((n.Status ?? '').trim()), controllable: true, reason: null,
      method: `Windows network adapter (${name})`, target: name
    })
  }
  for (const b of array<PnpRow>(parsed?.bt)) {
    if (!isBluetoothRadio(b) || !b.Id) continue
    items.push({
      id: `win.radio:bluetooth:${b.Id}`, kind: 'radio', label: 'Bluetooth', role: `Bluetooth radio (${b.Name})`,
      enabled: !disabledBy(b.Status, b.Problem), controllable: true, reason: null,
      method: `Windows PnP (${b.Id})`, target: b.Id
    })
  }

  if (!items.length && !notes.length) notes.push('No switchable input devices or radios were found on this machine.')
  return { items, notes }
}

const POINTERS: readonly InputRole[] = ['mouse', 'touchpad', 'pointing stick', 'touchscreen', 'tablet']

/** Refuses to switch off the last keyboard or the last pointing device, so the user cannot lock themselves out. */
export function guardWindowsSwitch(items: readonly WindowsDevice[], id: string): WindowsDevice {
  const item = items.find((x) => x.id === id)
  if (!item) throw new Error('That device is not connected any more. Reload the list.')
  if (item.kind !== 'input') return item
  const role = item.role as InputRole
  const otherOn = items.filter((x) => x.kind === 'input' && x.id !== id && x.enabled)
  if (role === 'keyboard' && !otherOn.some((x) => x.role === 'keyboard')) throw new Error('This is the only keyboard still switched on; switching it off would leave no way to type')
  if (POINTERS.includes(role) && !otherOn.some((x) => POINTERS.includes(x.role as InputRole))) throw new Error('This is the only pointing device still switched on; switching it off would leave no way to move the cursor')
  return item
}

/** The command that switches one device, without any elevation wrapper. */
export function windowsSwitchCommand(item: WindowsDevice, enabled: boolean): string {
  if (item.id.startsWith('win.radio:wifi:')) return `${enabled ? 'Enable' : 'Disable'}-NetAdapter -Name ${psQuote(item.target)} -Confirm:$false`
  const cmd = `${enabled ? 'Enable' : 'Disable'}-PnpDevice -InstanceId ${psQuote(item.target)} -Confirm:$false`
  return cmd
}

/**
 * Applies one switch. When the app is not elevated this starts an elevated PowerShell through UAC
 * (the Windows equivalent of the polkit prompt on Linux). A declined prompt is reported separately
 * from a device that refused the request.
 */
export async function applyWindowsSwitch(run: CommandRunner, item: WindowsDevice, enabled: boolean): Promise<void> {
  const action = windowsSwitchCommand(item, enabled)
  const r = await runElevatedPowerShell(run, action, 120_000)
  if (r.ok) return
  if (r.cancelled) throw new Error(r.error ?? 'Cancelled: the administrator permission prompt was closed, so nothing was changed.')
  throw new Error(`Windows could not switch ${item.label}. Administrator permission is required (${r.error}).`)
}
