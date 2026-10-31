# Hardware Intelligence Platform

A desktop application (Electron + TypeScript + React + SQLite) that inventories the hardware of the
computer it runs on, keeps the inventory current as devices come and go, and shows how devices are
connected. It works fully offline: no cloud account, no paid API, no telemetry.

**Status:** early. Linux is implemented and tested on a real machine. The Windows collectors have been
executed on Windows from source, but only the `windows.system` collector completed in the verification run
described below; the others hit their timeouts. A Windows installer has not been built. See
[docs/IMPLEMENTATION_STATUS.md](docs/IMPLEMENTATION_STATUS.md) for exactly what works, what is partial and
what is not built yet.

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
| Windows 10/11 x64 | 5 (PowerShell CIM/PnP); metrics: CPU + memory only | polling only | Launched from source on Windows 11 (Node 24.21, Electron 44.9.1). `windows.system` completed with 6 devices; the other collectors timed out in that run. Full runtime validation still pending. |
| macOS | none | none | No |

## Requirements

- Node.js 24+ (verified with Node 24.21.0). The app uses the built-in `node:sqlite`; Electron 44 ships a
  compatible Node, so no native module rebuilds are needed.
- npm (verified with npm 11.19.0).
- Windows 10/11 x64 with PowerShell 5.1+ (the Windows collectors run fixed `powershell.exe` commands), or
  Linux x64.
- A display for the desktop UI. The CLI scripts (`scan`, `watch`) run headless.
- Linux extras (optional): `/sys` and `/proc` readable; `udevadm` (live events), `hwdata` (device names),
  `bluetoothctl` (paired devices), `smartctl` (drive health).

## Running the app

These are the complete steps. Commands are shown for PowerShell on Windows; the same npm scripts work in a
Linux shell.

### 1. Install dependencies

```powershell
cd C:\vscode\Hardware_scanner
npm ci
```

`npm ci` installs exactly what `package-lock.json` pins, including Electron 44.9.1. If the Electron binary
was not downloaded (for example `node_modules\electron\dist\electron.exe` is missing), install it
explicitly — this downloads roughly 250 MB and may take a few minutes:

```powershell
node node_modules\electron\install.js
```

You can verify it worked:

```powershell
Test-Path node_modules\electron\dist\electron.exe   # must print True
```

### 2. Build the app

```powershell
npm run build
```

This writes the production bundles to `out/` (`out/main`, `out/preload`, `out/renderer`). The preload bundle
must exist or the window will open blank and `window.hip` will be undefined.

### 3. Start it

For development with hot reload:

```powershell
npm run dev
```

To run the production build you just made:

```powershell
npm run start
```

Both commands launch Electron and open the **Hardware Intelligence Platform** window. The app starts its
first inventory scan immediately; results appear on the Overview and Hardware pages. The same app can be
started directly with the Electron binary if needed:

```powershell
.\node_modules\electron\dist\electron.exe out\main\index.js
```

Close the window (or press Ctrl+C in the terminal) to stop it.

### 4. Optional headless commands

```powershell
npm run scan          # run all collectors for this machine and print a summary (--list, --json)
npm run watch         # run the live event pipeline headless and print hardware events
npm run typecheck     # TypeScript check (passes on Windows)
```

### 5. Where the data lives

The SQLite database is `inventory.sqlite` in Electron's `userData` directory:

| Run mode | Windows | Linux |
|---|---|---|
| From source (`npm run dev` / `npm run start`) | `%APPDATA%\Hardware Intelligence Platform\inventory.sqlite` | `~/.config/Hardware Intelligence Platform/inventory.sqlite` |
| Direct Electron binary (`electron out/main/index.js`) | `%APPDATA%\Electron\inventory.sqlite` | `~/.config/Electron/inventory.sqlite` |
| Packaged build | `%APPDATA%\Hardware Intelligence Platform\inventory.sqlite` | `~/.config/Hardware Intelligence Platform/inventory.sqlite` |

Set `HIP_DB_PATH` to use another file (development/test runs only; a packaged app ignores it). Upgrades
migrate with a `.pre-vN.bak` backup; a database from a newer release is refused untouched.

### 6. Tests

```powershell
npm run typecheck
npm test
```

The unit/integration suite is written for Linux fixtures. On Windows, `npm run typecheck` passes, but
`npm test` currently reports failures: many fixture tests create symlinks (`EPERM` without Developer Mode or
elevation), some assert POSIX paths, and a few performance limits are tuned for the Linux dev machine. Run
the full suite on Linux or WSL. `npm run test:e2e` also needs a display and is Linux-oriented.

### 7. Package an installer (optional)

```powershell
npm run package:linux   # Linux AppImage -> dist/
npm run package:win     # Windows NSIS installer -> dist/ (run on Windows)
```

Builds are unsigned and nothing publishes a release automatically. See [docs/PACKAGING.md](docs/PACKAGING.md)
for the full detail and evidence.

## Verification run (Windows 11 x64)

This checkout was verified on 2026-10-31 with Node 24.21.0, npm 11.19.0 and Electron 44.9.1:

- `npm run build` completed (main 578 kB, preload 5.6 kB, renderer 1.7 MB).
- `npm run typecheck` completed with no errors.
- The built app launched with `npm run start` and directly with the Electron binary; the window titled
  **Hardware Intelligence Platform** was responsive, and `npm run start` created the database under
  `%APPDATA%\Hardware Intelligence Platform`.
- The first scan stored 6 devices (`system` 1, `motherboard` 1, `cpu` 1, `memory` 3) from
  `windows.system`.
- `windows.pnp`, `windows.network`, `windows.storage` and `windows.hardware` reported `unavailable` with
  `PowerShell query timed out` at their configured limits (110 s, 15 s, 15 s, 25 s), and
  `windows.hardware` once reported invalid output. These are open Windows issues, not test failures.
- `npm test` collected 458 tests: 383 passed, 36 skipped and 39 failed, all from Windows/Linux fixture
  mismatches (symlink permissions, POSIX paths, performance thresholds).

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
- **`Downloading Electron binary...` then nothing / Electron will not start**: the Electron binary is
  missing. Run `node node_modules\electron\install.js` and confirm `node_modules\electron\dist\electron.exe`
  exists.
- **`Failed to ... Vulkan` / ozone messages on Wayland**: harmless Chromium GPU warnings.
- **Electron sandbox errors on some Linux setups**: the app keeps the renderer sandbox on. If your
  distribution restricts unprivileged user namespaces, see Electron's sandbox documentation rather than
  disabling it globally.
- **Device names show as `vendor:device` IDs**: install `hwdata` (provides `pci.ids`/`usb.ids`).
- **"Database schema vN is newer than this application"**: you are running an older build against a
  database written by a newer one. Nothing was modified; update the application.
- **Live monitoring says "degraded"**: `udevadm` could not be started; the app is polling instead.
- **Windows collectors report `PowerShell query timed out`**: the fixed PowerShell commands can be slow on a
  cold start. Re-run the scan after the first one finishes; the collectors report the timeout honestly
  instead of an empty inventory. This is a known Windows limitation, not a database failure.
- **`npm test` fails on Windows with `EPERM ... symlink`**: enable Windows Developer Mode (or run the suite
  in WSL/Linux). The fixture helpers create symlinks and POSIX paths.

## Documentation

[Architecture](docs/ARCHITECTURE.md) · [Collectors](docs/COLLECTORS.md) · [Security](docs/SECURITY.md) ·
[Testing](docs/TESTING.md) · [Packaging](docs/PACKAGING.md) · [Roadmap](docs/ROADMAP.md) · [Implementation status](docs/IMPLEMENTATION_STATUS.md)
