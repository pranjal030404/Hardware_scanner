import type { CommandRunner } from '@collectors/core/runner'
import type { Measurement, PerfControl, PerfDevice, PerfState } from './types'

/** Fixed locations of NVIDIA's documented management tool on Windows (never a PATH lookup). */
export const NVIDIA_SMI_WINDOWS = ['C:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe']

const unavailable = (deviceId: string, id: string, label: string, reason: string): PerfControl => ({
  id, deviceId, label, status: 'unavailable', read: false, write: false, current: null, currentRaw: null, source: '—', persistence: 'runtime', rebootRequired: false, restorable: false, risk: 'high', reason
})

/**
 * Windows: monitoring only. Generic CIM/WMI exposes no documented way to change CPU multipliers,
 * voltages, GPU clocks or power limits, and nothing here has been validated on real Windows hardware.
 */
export async function windowsState(d: { run: CommandRunner; cpus: () => { model: string; speed: number }[]; now: () => Date; exists: (p: string) => Promise<boolean> }): Promise<PerfState> {
  const at = d.now().toISOString()
  const cpus = d.cpus()
  const telemetry: Measurement[] = []
  const devices: PerfDevice[] = []
  if (cpus.length) {
    telemetry.push({ label: 'CPU clock (reported by Windows)', value: `${cpus[0]!.speed} MHz`, source: 'os.cpus()', at, state: 'live', reason: 'Windows reports the nominal clock here, not the momentary one.' })
    devices.push({
      id: 'cpu', kind: 'cpu', label: cpus[0]!.model, summary: `${cpus.length} logical processors · monitoring only`, monitoringOnly: true, settings: [],
      controls: [
        unavailable('cpu', 'cpu.power_plan', 'Power plan / processor policy', 'Not implemented for Windows yet; use Windows power settings.'),
        unavailable('cpu', 'cpu.multiplier', 'Clock multiplier (overclocking)', 'Windows has no documented generic interface for this; it is set in the BIOS/UEFI or with the CPU vendor’s own tool.')
      ],
      overclock: { supported: false, knobs: [], reason: 'Monitoring only on Windows.' }
    })
  }
  let smi: string | null = null
  for (const p of NVIDIA_SMI_WINDOWS) if (await d.exists(p)) { smi = p; break }
  if (smi) {
    const q = await d.run(smi, ['--query-gpu=name,temperature.gpu,power.draw,utilization.gpu,clocks.sm,clocks.mem,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeoutMs: 5000 })
    const f = q.ok ? q.stdout.split(/\r?\n/)[0]?.split(',').map((x) => x.trim()) : undefined
    if (f && f.length === 8) {
      const name = f[0]!
      const labels: [string, string][] = [['temperature', '°C'], ['power', 'W'], ['utilisation', '%'], ['core clock', 'MHz'], ['memory clock', 'MHz'], ['VRAM used', 'MiB'], ['VRAM total', 'MiB']]
      labels.forEach(([l, u], i) => telemetry.push(/^[\d.]+$/.test(f[i + 1]!) ? { label: `${name} ${l}`, value: `${f[i + 1]} ${u}`, source: 'nvidia-smi --query-gpu', at, state: 'live' } : { label: `${name} ${l}`, value: null, source: 'nvidia-smi', at: null, state: 'unavailable', reason: `Not reported (${f[i + 1]}).` }))
      devices.push({ id: 'nvidia', kind: 'nvidia', label: name, summary: 'nvidia-smi · monitoring only', monitoringOnly: true, settings: [], controls: [unavailable('nvidia', 'nvidia.power_w', 'Power limit', 'Changing it on Windows is not implemented or validated in this application.')], overclock: { supported: false, knobs: [], reason: 'Monitoring only on Windows.' } })
    }
  }
  return {
    supported: true, monitoringOnly: true, platform: 'win32', fingerprint: '', tuningEnabled: false,
    reason: 'Windows: monitoring only. No tuning control is implemented or validated on Windows yet.',
    helper: { usable: false, path: '', reason: 'Privileged helpers exist only for Linux.' },
    devices, telemetry, profiles: [], tuned: null, matches: null, lastTransaction: null, canUndo: false, canRestoreOriginal: false, busy: null
  }
}
