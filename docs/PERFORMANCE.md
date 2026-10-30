# Performance tuning

The **Performance tuning** page shows what the CPU and GPU can do, measures what they are doing, and —
where the hardware, its drivers and an installed helper allow it — changes run-time performance settings
as verified, reversible transactions. Nothing here overclocks hardware that does not support it, and
nothing is claimed that was not read from the device.

Status legend: ✅ implemented and verified on real hardware · ❓ implemented, verified only with fixtures /
mocks · 👁 read-only monitoring · ⬜ not implemented.

## What it does

| Area | Status | Notes |
|---|---|---|
| Capability discovery (Linux) | ✅ read-only, verified on an HP EliteBook 840 G8 (i5-1145G7, Iris Xe) | per control: status, read/write separately, range + its source, unit/step, persistence, restorability, risk, reason |
| Live telemetry with source + time | ✅ | CPU clock (observed), utilisation, temperature with the sensor's own limit, throttle counters, GPU clock; AMD/NVIDIA telemetry ❓ |
| Profiles: Stock, Quiet, Balanced, Performance, **Maximum (hardware limits)**, Custom (saved) | ❓ planned from real hardware, **applied only in fixture tests** | built from device-reported values; saved profiles are bound to a hardware fingerprint |
| Transactions: validate → record previous → apply → read back → verify → roll back on partial failure | ❓ exercised end to end with the real helper script against fixture trees | never on the host in automated tests |
| Undo last change / Restore original / Restore stock | ❓ fixture tests | |
| Test sessions: built-in SHA-256 benchmark or monitoring-only | ✅ workload verified on real hardware (worker threads); session flow ❓ mocked | explicitly not a stability proof |
| Diagnostics rules (5) | ✅ unit-tested | see below |
| Windows | 👁 monitoring only, ❓ mocked | no tuning control is implemented or validated on Windows |
| macOS | ⬜ | adapter boundary only |

### Maximum (hardware limits)

Sets every writable control to the upper limit **the hardware itself reports**, and invents none:

| Component | Upper limit used | Notes |
|---|---|---|
| CPU clock | `cpuinfo_max_freq` (max turbo) for both the highest **and lowest** allowed clock; turbo on; performance cap and floor 100 %; governor/EPP `performance`; dynamic boost on | the CPU no longer slows down when idle (high risk: continuous heat) |
| CPU power (PL1/PL2) | raised to the firmware rating if below it | above the rating the hardware reports **no** upper limit, so nothing is assumed; the app's safety ceiling is available manually only |
| Intel GPU | RP0 for max, boost and min | GPU pinned at its top clock |
| AMD GPU | top of `OD_RANGE` for core and memory clock (manual level), `power1_cap_max` | ❓ fixture-tested |
| NVIDIA | `power.max_limit` | clock offsets: no supported interface |
| Memory | — | speed/timings are fixed by firmware (XMP/EXPO); reported only |

Pinned clocks and raised limits are marked **high risk**; the review step requires an explicit
acknowledgement.

### Memory

Reported, never adjusted: installed size and usage (`/proc/meminfo`), rated/configured speed from SMBIOS
type 17 (`/sys/firmware/dmi/entries/17-*/raw`, root-only on most systems, so shown as *requires administrator
access* when unreadable). Linux offers no runtime interface to RAM clocks or timings.

### Controls (Linux)

| Control | Interface | Range / choices from | Persistence | Risk |
|---|---|---|---|---|
| CPU governor | `cpufreq/policy*/scaling_governor` | `scaling_available_governors` | runtime | low |
| Energy preference (EPP) | `energy_performance_preference` | `energy_performance_available_preferences` | runtime | low |
| Turbo | `intel_pstate/no_turbo` or `cpufreq/boost` | on/off | runtime | low |
| Highest / lowest allowed clock (**OS policy limits**) | `scaling_max_freq` / `scaling_min_freq` | `cpuinfo_min_freq`–`cpuinfo_max_freq` per policy | runtime | low |
| Performance cap / floor | `intel_pstate/max_perf_pct`, `min_perf_pct` | 1–100 % (kernel raises the floor to the CPU minimum) | runtime | low |
| Dynamic boost | `intel_pstate/hwp_dynamic_boost` | on/off | runtime | low |
| Sustained / short power (PL1 / PL2) | `powercap/intel-rapl:0/constraint_{0,1}_power_limit_uw` | 5 W – **safety ceiling** 2× / 3× the firmware rating (app-defined, not a hardware limit) | runtime | medium (high above current) |
| Intel GPU min / max / boost clock | i915 `gt_{min,max,boost}_freq_mhz`; xe `tile0/gt0/freq0/{min,max}_freq` | RPn–RP0 reported by the GPU | runtime | low |
| AMD GPU level, OverDrive core/memory clock, power cap | `power_dpm_force_performance_level`, `pp_od_clk_voltage`, `hwmon/power1_cap` | `OD_RANGE`, `power1_cap_min/max` | runtime | high / medium ❓ |
| NVIDIA power limit | `nvidia-smi -pl` | `power.min_limit`–`power.max_limit` | runtime | medium ❓ |
| tuned profile | `tuned-adm profile` | `tuned-adm list` | **persistent** (tuned remembers it) | low |

Shown as **not available, with the reason** (never as a working control): CPU multiplier (locked parts;
unlocked parts are set in BIOS — no documented runtime interface), core voltage / undervolting (needs
undocumented MSR writes, which the app does not do), GPU clocks above RP0 (fixed in the chip), AMD OverDrive
when disabled (`amdgpu.ppfeaturemask`), NVIDIA clock offsets (need nvidia-settings + Coolbits on X11).

Write support is never inferred from a readable file: a control is writable only when the kernel exposes a
write handler (sysfs mode has the owner-write bit) **and** the verified helper is installed. It is marked
"verified here" only after a change to it was read back successfully on this hardware.

## Installing the optional helper (Linux)

Everything except changing settings works without it. To enable writable controls:

```bash
sudo sh resources/linux/install.sh            # from the source tree
sudo sh <AppImage-resources>/linux/install.sh # from a packaged build (extract with --appimage-extract)
```

This installs, owned by root:

- `/usr/local/libexec/hardware-intelligence/hip-perf-helper` — applies whitelisted settings
- `/usr/local/libexec/hardware-intelligence/hip-hid-probe` — Device test's read-only raw HID probe
- `/usr/share/polkit-1/actions/dev.hardware-intelligence.policy` — one polkit action per helper
  (`auth_admin_keep`: the system asks for an administrator password; it is cached briefly so a rollback
  right after a failure does not ask again)

Then switch on **Settings → Features & controls → Performance tuning controls**.

Remove with `sudo sh resources/linux/install.sh --uninstall`. Settings already changed stay until reboot (a
tuned profile stays until changed).

The app never runs the installer, never uses `sudo`, never asks for a password itself and never runs as
root. Before invoking a helper it checks that the installed file is a regular, root-owned, not
group/world-writable executable in a root-only directory, **byte-identical** to the copy this version ships,
and that the polkit policy exists. A missing, older or modified helper leaves every control read-only.

## Recovery

- **Undo last change** — puts back the values recorded before the most recent change.
- **Restore original settings** — puts back each setting as it was before this app first changed it on this
  hardware.
- **Restore stock** — documented defaults only: firmware power rating, the driver's documented default
  governor (`powersave` for intel_pstate/amd-pstate active mode, `schedutil` otherwise), the firmware's own
  energy preference (`default`), the GPU's full RPn–RP0 range, tuned's recommendation. Anything without a
  documented default (e.g. a PL2 with no firmware rating) is left unchanged and listed.
- A restart resets sysfs values to their boot defaults, **but not a tuned profile**. Do not rely on a restart
  alone. Without the app: `tuned-adm recommend`, `sudo tuned-adm profile <that>`, then reboot.
- If the app stops during a change, the change is recorded as *unverifiable* on next start.
- Settings are **never** re-applied at start-up; persistent profiles are not implemented.

## Diagnostics

`performance.permission_required` (info), `performance.control_verification_failed`,
`performance.configuration_not_restored`, `performance.test_failed`, `performance.thermal_limit_approaching`
(against the sensor's own critical limit; no universal threshold). Ongoing throttling is reported by the
existing `cpu.thermal_throttle` rule.

## Testing

- `npx vitest run tests/performance.test.ts` — helper script (run unprivileged against fixture trees),
  helper verification, discovery, telemetry, profiles, transactions (apply/read-back/mismatch/partial
  failure/rollback/rollback failure/serialisation/undo/restore), test sessions, diagnostics, Windows,
  IPC validation, storage. The fake `pkexec` runs the real helper script against a fixture tree; nothing
  touches the host.
- `HIP_HW_TESTS=1 npx vitest run tests/hw-performance.test.ts` — **opt-in, read-only** checks against the
  real machine (discovery, telemetry). Never run in CI; never changes settings.
- e2e: page renders real measurements and capabilities; applying is refused while tuning is off.

### Still requires real-hardware validation

- Applying any setting through the installed helper (no automated test may change the host; the helper was
  not installed on the development machine).
- AMD OverDrive and NVIDIA power-limit paths (no such GPU on the development machine).
- Intel xe driver paths (development machine uses i915).
- All Windows behaviour.
