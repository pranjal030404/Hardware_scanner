# Hardware Intelligence Platform

A desktop application (Electron + TypeScript + React + SQLite) that inventories the hardware of the
computer it runs on, keeps the inventory current as devices come and go, and shows how devices are
connected. It works fully offline: no cloud account, no paid API, no telemetry.

**Status:** early. Linux is implemented and tested on a real machine; Windows collectors exist but have
only been tested against fixtures. See [docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md)
for exactly what works, what is partial and what is not built yet.

## What it does today

- **Inventory** of system, motherboard/BIOS, CPU, memory, PCI, USB (with hub hierarchy), input devices,
  storage (disks, partitions, mounts, usage), network, Bluetooth, displays (EDID), audio, cameras,
  sensors (hwmon), power/battery and serial ports.
- **Provenance on every fact**: which collector and which OS interface reported it, and whether the
  value was read from the OS, measured, derived, or looked up from an ID database.
- **Honest gaps**: a field the OS does not expose is shown as *unavailable*; a collector that could not
  inspect something reports `permission_required` / `unavailable` / `error` — never an empty inventory.
- **Live updates**: udev notifications (Linux) trigger debounced rescans; a periodic rescan is the
  safety net. Plug/unplug and changes appear in the Events view without restarting.
- **Topology**: interactive graph of device relationships. Kernel-reported relationships are solid,
  inferred ones are dashed and carry a confidence.
- **Diagnostics**: 11 deterministic rules (collector health, stale inventory, OS device errors, disk space, SMART,
  sensor temperature vs the sensor's own limits, missing devices, …). Every finding cites its evidence, rule and a
  recommended safe next step; acknowledge / dismiss / resolve. Missing data is never reported as a fault.
- **Snapshots & comparison**: save point-in-time inventories with per-collector coverage; compare them. A device is
  only reported *removed* if its collector completed in both snapshots — otherwise the difference is shown as
  *indeterminate* with the reason.
- **Live monitor**: CPU, memory, network, disk I/O, battery, temperatures and fans sampled from OS counters
  (Linux), with real units/timestamps, configurable window and interval, pause/resume, and explicit stale /
  unavailable states. Device pages show their own live metrics.
- **Export** to JSON with sensitive identifiers (serials, MACs, hostname, IPs) excluded unless enabled.

## Supported platforms

| Platform | Collectors | Live events | Tested |
|---|---|---|---|
| Linux (x64) | 16 | udev + polling fallback | Yes — fixtures **and** a real laptop (Fedora, kernel 7.x) |
| Windows 10/11 x64 | 4 (PowerShell CIM/PnP); metrics: CPU + memory only | polling only | Fixture parsing only — **not run on Windows** |
| macOS | none | none | No |

## Requirements

- Node.js 24+ (the app uses the built-in `node:sqlite`; Electron 44 ships a compatible Node, so no
  native module rebuilds are needed).
- Linux: `/sys` and `/proc` readable; optional tools improve results: `udevadm` (live events),
  `hwdata` (device names), `bluetoothctl` (paired devices), `smartctl` (drive health).

## Development

```bash
npm ci
npm run dev          # Electron + Vite with hot reload
npm run typecheck
npm test             # unit/integration tests (vitest, 255 tests)
npm run build        # production bundles in out/
npm run start        # run the built app
npm run test:e2e     # builds, then drives the real app (needs a display; see docs/TESTING.md)
npm run scan         # run all collectors against this machine and print a summary (--list, --json)
npm run watch        # run the live pipeline headless and print hardware events (plug a USB device!)
```

The database lives in the Electron `userData` directory (`inventory.sqlite`); set `HIP_DB_PATH` to use
another file (development/test runs only; a packaged app ignores it).

## Permissions

The app never needs to run as root, and it is read-only by default. Some details are root-only on Linux
and are reported as limitations, with a remedy, on the **Collectors** page:

| Detail | Why it is limited |
|---|---|
| Memory module slots/speed/vendor | SMBIOS entries under `/sys/firmware/dmi/entries` are root-readable only |
| SMART drive health | `smartctl` needs raw block-device access |
| DMI serial numbers / UUID | Not collected at all (privacy) |

Metrics, diagnostics and snapshots need no extra permissions; they read the same world-readable `/proc` and `/sys` files.
A Settings page section controls diagnostic thresholds, metric interval/retention and rule toggles live on the Diagnostics page.

## Packaging

```bash
npm ci
npm run package:linux   # -> dist/hardware-intelligence-platform-<version>-linux-x86_64.AppImage
npm run package:win     # run on Windows (CI: windows-latest) -> dist/...-win-x64.exe (NSIS)
```

| | Built | Launched/tested |
|---|---|---|
| Linux x64 AppImage | ✅ locally (117 MB, SHA-256 `4b86d233…c02`, see PACKAGING.md) | ✅ UI suite 72/72 + install/upgrade/debug-switch scenarios 43/43 on the packaged binary |
| Windows x64 NSIS | ❌ **no installer exists** (local download stalled; CI job written, **never run**) | ❌ no Windows runtime validation (checklist pending) |

User data is never inside the install: Linux `~/.config/Hardware Intelligence Platform/inventory.sqlite`,
Windows `%APPDATA%\Hardware Intelligence Platform\inventory.sqlite`. Upgrades migrate with a `.pre-vN.bak`
backup; a database from a newer release is refused untouched; uninstalling keeps the data. Builds are unsigned,
nothing publishes a release automatically, and there is **no LICENSE file yet** (owner decision pending). Packaged builds
refuse `--remote-debugging-*`/`--inspect*` switches and disable DevTools unless `HIP_ENABLE_DEBUGGING=1`. Full detail, commands, evidence and the Windows manual
checklist: [docs/PACKAGING.md](docs/PACKAGING.md).

## Troubleshooting

- **Blank window / `window.hip` undefined**: run `npm run build` (the preload script must exist in `out/`).
- **`Failed to ... Vulkan` / ozone messages on Wayland**: harmless Chromium GPU warnings.
- **Electron sandbox errors on some Linux setups**: the app keeps the renderer sandbox on. If your
  distribution restricts unprivileged user namespaces, see Electron's sandbox documentation rather than
  disabling it globally.
- **Device names show as `vendor:device` IDs**: install `hwdata` (provides `pci.ids`/`usb.ids`).
- **"Database schema vN is newer than this application"**: you are running an older build against a
  database written by a newer one. Nothing was modified; update the application.
- **Live monitoring says "degraded"**: `udevadm` could not be started; the app is polling instead.

## Documentation

[Architecture](docs/ARCHITECTURE.md) · [Collectors](docs/COLLECTORS.md) · [Security](docs/SECURITY.md) ·
[Testing](docs/TESTING.md) · [Packaging](docs/PACKAGING.md) · [Roadmap](docs/ROADMAP.md) · [Implementation status](docs/IMPLEMENTATION_STATUS.md)
# Hardware_scanner
