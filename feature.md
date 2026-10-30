# Features — Hardware Intelligence Platform

An offline desktop app (Electron + TypeScript + React + SQLite) that inventories the computer it runs on,
keeps that inventory current, shows how devices are connected, monitors live metrics and diagnoses problems.
No cloud account, no paid API, no telemetry.

Status markers: ✅ implemented and verified · 🟡 partial · ❓ implemented but not verified on real hardware.
The authoritative status is [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md).

---

## 1. Hardware inventory

### Linux collectors (16) ✅ — verified on a real laptop

| Collector | What it detects | Source |
|---|---|---|
| `linux.system` | System, motherboard, BIOS, OS | `/sys/class/dmi/id`, `/proc`, `/etc/os-release` |
| `linux.cpu` | CPU packages, model, frequency policy | `/proc/cpuinfo`, cpufreq |
| `linux.memory` | Total/used memory; module slots/speed/vendor (needs root) | `/proc/meminfo`, SMBIOS type 17 |
| `linux.pci` | PCI devices, bridge hierarchy, drivers, link width/speed, AER error counts, NUMA node, runtime PM | `/sys/bus/pci`, `pci.ids` |
| `linux.usb` | USB devices with hub hierarchy, class, revision, protocol, endpoints, port over-current | `/sys/bus/usb`, `usb.ids` |
| `linux.input` | Keyboards, mice, touchpads, etc. (classified from kernel capabilities) | `/proc/bus/input/devices` |
| `linux.video` | Cameras (nodes collapsed per physical camera) | `/sys/class/video4linux` |
| `linux.network` | Network interfaces, MAC, IPs, link state | `/sys/class/net` |
| `linux.bluetooth` | Bluetooth adapters and paired devices | `/sys/class/bluetooth`, `bluetoothctl` |
| `linux.storage` | Disks, partitions, mounts, usage; NVMe controller state/firmware/queues | `/sys/block`, `/proc/self/mounts`, `/sys/class/nvme` |
| `linux.smart` | SMART / NVMe health (needs root) 🟡 | `smartctl --json` |
| `linux.display` | Monitors via EDID (identity, size, preferred mode); GPU DRM cards, connectors, max clock | `/sys/class/drm` |
| `linux.audio` | ALSA sound cards 🟡 | `/proc/asound/cards` |
| `linux.power` | Battery, AC, battery health (full vs design capacity) | `/sys/class/power_supply` |
| `linux.sensors` | Temperature, fan, voltage sensors with driver limits | `/sys/class/hwmon` |
| `linux.serial` | Serial ports (passive, never writes) | `/sys/class/tty` |
| `linux.i2c` | I²C/SMBus adapters and registered clients (passive, never probes) | sysfs |

Plus a CPU topology module: packages / cores / threads, caches, NUMA nodes, frequency policies.

### Windows collectors ❓ — fixture-tested only, never run on Windows
`windows.system` (CIM), `windows.pnp` (PnP devices + parent hierarchy), `windows.network`, `windows.storage`,
`windows.hardware` (CPU cache/virtualisation, memory ECC/slots, GPU driver/mode, battery, ACPI thermal zones).

### Inventory engine ✅
- Collector framework with timeout, retry, schema validation and explicit statuses:
  `available` · `unavailable` · `unsupported` · `permission_required` · `stale` · `not_scanned` · `error`.
- Normalisation, stable device identity and merging across collectors.
- **Provenance on every fact** — which collector and OS interface reported it, and whether it was read,
  measured, derived or looked up from an ID database.
- **Honest gaps** — unexposed fields are shown as *unavailable*; permission-limited data is listed with a remedy.
  A failed collector never produces an empty inventory.
- Sensitive values (serials, MACs, IPs, hostname) are flagged at collection time and masked in the UI until revealed.

## 2. Live events ✅
- Linux: `udevadm monitor` notifications trigger debounced rescans; periodic rescan as safety net (polling fallback).
- Windows: polling only.
- Events pipeline validates, de-duplicates, persists and fans out `device.connected` / disconnected / changed events.
- Plug-in detection verified on real hardware; unplug detection unit-tested (❓ live).
- Event retention by age and count.

## 3. Topology ✅
- Interactive graph of device relationships (PCI bridges, USB hubs, attached devices…).
- Kernel-reported links drawn solid; inferred links dashed with a confidence value.
- Filters, search, collapse; layout tested up to 5,000 nodes.

## 4. Diagnostics ✅
Deterministic rule engine — every finding cites evidence, the rule, and a safe recommended next step.
Missing data is never reported as a fault.

| Rule | Detects |
|---|---|
| `collector.health` | Collector errors / permission limits |
| `inventory.stale` | Inventory not refreshed recently |
| `device.os_error` | OS reports a device error (Windows path) |
| `device.missing` | Previously seen device gone (only if its collector fully completed) |
| `device.property_changed` | Notable property changes |
| `storage.space` | Filesystem usage over warn/critical thresholds |
| `storage.smart` | SMART health failures |
| `storage.nvme_state` | NVMe controller not in `live` state |
| `sensor.temperature` | Temperature near the sensor's own critical limit |
| `network.link_down` | Interface down (opt-in) |
| `monitoring.state` | Live monitoring stopped/degraded |
| `metrics.availability` | Metric provider erroring/stalled, or sampling paused |
| `cpu.pressure` / `memory.pressure` / `io.pressure` | Sustained kernel PSI stall pressure |
| `memory.swap_thrash` | Sustained high swap-in rate |
| `memory.ecc_errors` | EDAC ECC error counts |
| `cpu.thermal_throttle` | Thermal-throttle counter increases |
| `pci.aer_errors` | PCIe AER fatal / non-fatal / large correctable counts |
| `pci.link_width` | PCIe link running narrower than device and upstream capability |
| `usb.reconnect` | Device disconnecting repeatedly (3+ in 30 min) |

Engine features: dedupe by rule + subject, update in place, safe auto-resolve, reopen and escalation,
per-rule failure isolation, rule run history. Findings can be **acknowledged, dismissed or resolved**;
individual rules can be enabled/disabled; thresholds are configurable in Settings.

## 5. Snapshots & comparison ✅
- Save point-in-time, self-contained inventory snapshots with per-collector coverage.
- Compare two snapshots: added / removed / property / relationship / coverage changes.
- A device is only reported *removed* if its collector completed in **both** snapshots; otherwise *indeterminate* with the reason.
- Re-key matching (serial = probable, id+name heuristic = uncertain, ambiguous = not guessed).
- Volatile values excluded by default; sensitive values masked. In-page delete confirmation.

## 6. Live metrics & monitoring ✅ (Linux)
- Providers: CPU (overall and per-core frequency), memory, network rx/tx, disk read/write/busy, battery
  charge/power, temperatures, fans, PSI pressure, vmstat/paging, GPU frequency (Intel ✅) and
  utilisation/VRAM (AMD ❓).
- Correct counter maths: monotonic deltas, counter resets skipped, never negative rates.
- Sampler independent from inventory scans; bounded ring buffers; batched writes; retention pruning;
  history survives restart.
- **Monitor page** with charts, real units and timestamps, time window, pause/resume, explicit
  live / stale / waiting / unavailable states, source line per card and provider health table.
- Per-device "Live metrics" on device pages.
- Windows/macOS: CPU + memory via Node `os` only (❓).

## 7. Process monitor ✅ (opt-in, Linux)
- Off by default (process lists are personal data).
- Shows name, state, thread count, RSS and CPU share only — no command lines, environment or users.
- Bounded, PID-reuse safe; polls only while the page is open.

## 8. Application pages

| Page | Contents |
|---|---|
| **Overview** | System summary, monitoring state, device counts by category, storage, network, recent events, active findings, collector health |
| **Hardware** | Searchable/filterable/sortable device table (paged), category filters |
| **Device detail** | Identity, record, identifiers (masked), parent/child devices, properties with provenance, live readings, live metrics, history |
| **Topology** | Device relationship graph |
| **Diagnostics** | Summary, tabs, filters, finding detail + evidence, actions, rule health and toggles |
| **Snapshots** | Create, history, coverage/limitations, compare, delete |
| **Monitor** | Live metric charts |
| **CPU & Memory** | CPU topology, caches, NUMA, per-core frequency, pressure, paging, memory detail |
| **Sensors** | Registry of all hwmon channels with labels, driver limits, age/stale state and source |
| **Processes** | Opt-in top-process list |
| **Device diff** | Side-by-side comparison of two devices of the same category with per-value source |
| **Events** | Persisted hardware event log |
| **Collectors** | Collector health, limitations with remedies, category × collector capability matrix |
| **Settings** | Appearance, monitoring, processes, metrics, retention, diagnostics thresholds, privacy & export, about |

UI: dark / light / system theme, sidebar navigation with active-findings badge, live-status badge
(udev / polling / paused / scanning), empty / error / loading states.

## 9. Settings
**Features & controls** — one section to switch everything on or off, with *Enable all / Disable all* per group:
features (live monitoring, metric sampling, process monitoring, network-down reports) · each hardware collector
(skipped by scans; its devices are kept as last known, never reported removed; re-enabling rescans it) ·
each diagnostic rule · each metric provider · each sidebar page (Overview and Settings always shown) ·
**individual devices** — keyboards, mice, touchpad, pointing stick (Hyprland, via `hyprctl`) and Wi-Fi/Bluetooth
radios (`rfkill`); no root; re-applied at app start and on re-plug; the last keyboard/pointer cannot be switched off.

## 9b. Device test ✅ (Linux)
Plug a device in (it is selected automatically) or pick any USB device, built-in keyboard/pointer, camera,
network adapter, Bluetooth adapter, drive or battery, and get a verdict with plain-language causes and fixes:
- **Automatic checks** — detected on the bus, configured, USB authorization, driver per interface, link speed vs
  capability, power budget / over-current, connection path (hub), input devices created, switched off in Settings,
  radio blocked, link/carrier, packet errors, drive I/O errors, battery wear — each with evidence.
- **Kernel log interpretation** — enumeration errors (-71/-110/-32), "not accepting address", over-current,
  reset and disconnect loops, HID probe failures, firmware load failures, disk I/O errors. Errors from earlier
  attempts are separated from the current connection.
- **Failed connections** — devices that never enumerated (and so never reached the inventory) are shown from
  the kernel log with the reason.
- **Hands-on test** for mice, keyboards, touchpads and pointing sticks, read from the raw input events: every
  direction, button, wheel and multi-finger touch is ticked off; detects a button that double-clicks by itself
  (switch bounce), stuck keys/buttons, pointer drift (hold-still test), dropped events, movement stutter and the
  report rate; for keyboards, lists the keys not pressed yet; explains "detected but sends nothing" and
  "buttons work but it does not move" (sensor/surface/battery).
- **Deep hardware test** (administrator password): reads the raw reports the device itself transmits
  (/dev/hidraw), decodes them with the device's own HID report descriptor, and proves whether movement and
  clicks leave the device — separating a device fault (e.g. "sending zero movement" = sensor) from a
  PC/driver/desktop fault. Logitech HID++ devices are also asked for battery voltage, firmware and DPI.
- **Wireless battery** reported by the device through its receiver (e.g. Logitech HID++), incl. "asleep / out of range".
- **Connection map** — the selected device only: its chain from the PCI root (controller → root hub → port)
  down to every interface, HID device, input node and battery it contains, with details for each step.

Theme · safety-rescan interval · live monitoring on/off · event retention (days, max count) ·
metric sampling on/off, interval, retention · process monitoring opt-in ·
diagnostics thresholds (disk warn/critical %, temperature margin and fallback, PSI pressure % and window,
swap-in rate, throttle window, missing-device window, network-down opt-in, disabled rules) ·
export privacy toggles (serials, MACs, hostname, IPs). All settings are validated and persisted.

## 9c. Performance tuning ✅ read-only on Linux · ❓ changes (fixture-tested) · 👁 Windows monitoring only
See docs/PERFORMANCE.md. Overview (live measurements with source and time, capabilities per control, current
profile, last change) · CPU and GPU tabs (device-reported limits; controls with range, source, status and
persistence; OS policy limits clearly distinguished from hardware limits and observed clocks; unsupported
controls explained) · Profiles (Stock from documented defaults, Quiet, Balanced, Performance, saved profiles
bound to a hardware fingerprint; review before applying) · Transactions with kernel read-back verification
and automatic rollback on partial failure · Undo / restore original / restore stock · Testing (built-in
SHA-256 benchmark or monitoring-only sessions, history, before/after; not a stability proof) · History ·
5 diagnostics rules. Changes need the optional, separately installed privileged helper; off by default.

## 9d. Circuit lab ✅ (DC model; no firmware execution)
Virtual breadboard for ESP32 projects: drag parts, wire pins, test before building. Live OLED, encoder, power switch,
battery slider and SD card; rail voltages, battery draw/runtime and ADC reading from a nodal-analysis DC model; checks for
shorts, missing power/ground, over-voltage, 5 V on GPIOs, input-only/strapping pins, and wiring that does not match the
(editable) firmware pin map. Designs save to the database and import/export as JSON.

## 10. Data, export & backup ✅
- Local SQLite database (`node:sqlite`) with versioned migrations (schema v4) and automatic
  `.pre-vN.bak` backup on upgrade; databases from a newer release are refused untouched.
- **JSON export** with per-category redaction of sensitive identifiers (opaque hashed device ids).
- **Database backup** via native save dialog.

## 11. Security
- Hardened Electron: context isolation, sandbox, no Node in renderer, strict CSP, navigation/permission
  lockdown, single-instance lock.
- Closed whitelist of typed, schema-validated IPC channels with sender checks; no arbitrary file or command access.
- Read-only, runs as a normal user; fixed external tools only (`udevadm`, `smartctl`, `bluetoothctl`,
  `powershell.exe`) via argument vectors, no shell.
- Packaged builds serve the UI from a custom `hip-app://` protocol, harden Electron fuses, and refuse
  remote-debugging / inspect switches unless `HIP_ENABLE_DEBUGGING=1`.
- No telemetry; nothing leaves the machine.

## 12. Packaging & tooling
- Linux x64 **AppImage** ✅ built and tested (UI e2e + install/upgrade/debug-switch scenarios).
- Windows x64 NSIS installer — CI job written, **not built or run** yet.
- Artifact verifier (`scripts/verify-artifacts.mjs`): name, version, arch, fuses, asar, SHA-256.
- CLI scripts: `npm run scan` (run collectors and print a summary, `--list`, `--json`),
  `npm run watch` (headless live event pipeline), `scripts/seed-db.ts`.
- Tests: unit/integration (vitest), end-to-end against the real app via a dependency-free CDP client,
  packaged-binary scenarios. GitHub Actions CI workflow (not yet run).

---

## Not built yet
Windows runtime validation and deeper Windows collectors · macOS support · support bundle · integrations
(MQTT, Home Assistant…) · 3D explorer · AI assistant · code signing and auto-update · LICENSE file.
