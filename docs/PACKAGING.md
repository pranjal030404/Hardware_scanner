# Packaging, installation and release verification

Everything here states what was **run** and what was **not**. Verified on: Fedora 44 (kernel 7.2, x64, HP
EliteBook 840 G8), Node 24.18, Electron 44.9.1, electron-builder 26.15.3.

## Targets

| OS / arch | Artifact | Built locally | Built in CI | Launched / tested |
|---|---|---|---|---|
| Linux x64 | `dist/hardware-intelligence-platform-<version>-linux-x86_64.AppImage` | **Yes** (117 MB, SHA-256 below) | workflow written, **never run** | **Yes** — see below |
| Windows 10/11 x64 | `dist/hardware-intelligence-platform-<version>-win-x64.exe` (NSIS, per-user, wizard) | **No** — blocked | workflow written, **never run** | **No** |
| macOS, Linux arm64, Windows arm64, deb/rpm/Flatpak | — | not configured | — | — |

Electron's `node:sqlite` is used for storage, so there is **no native module** to rebuild or match against the
Electron ABI on either platform (`@electron/rebuild` finds nothing to do). `zod` is the only runtime dependency.

## Build prerequisites

- Node.js ≥ 24 and npm (`npm ci` — installs exactly what `package-lock.json` pins, including `electron-builder`).
- Linux AppImage: nothing else. The first build downloads the Electron zip and electron-builder's AppImage
  tooling (~150 MB total) into `~/.cache`.
- Windows installer: build on **Windows** (CI `windows-latest`). Building NSIS on Linux additionally needs
  `wine` (to edit the .exe resources) and a 158 MB download from GitHub; see "Windows blocker" below.

## Commands

```bash
npm ci
npm run typecheck && npm test            # 255 unit tests
npm run package:linux                    # electron-vite build + electron-builder --linux AppImage --publish never
npm run package:win                      # run on Windows (CI does this)
node scripts/verify-artifacts.mjs linux  # (or `win`) inspect the build output, write dist/SHA256SUMS.txt
```

Outputs go to `dist/` (git-ignored): the installer/AppImage, `linux-unpacked/` or `win-unpacked/`, and
`builder-debug.yml`. CI uploads the installer plus `SHA256SUMS.txt` as run artifacts (`linux-appimage`,
`windows-installer`). **Nothing publishes a release**: no `--publish`, no tokens, `contents: read` only.
Cutting a public release is a manual step that has deliberately not been automated.

## Installation

- **Linux**: `chmod +x hardware-intelligence-platform-*.AppImage && ./hardware-intelligence-platform-*.AppImage`.
  Needs FUSE 2 (`libfuse.so.2`), or run with `APPIMAGE_EXTRACT_AND_RUN=1` / `--appimage-extract-and-run`.
  No root, no installation step; delete the file to remove the program.
- **Windows** (when built): run the `.exe`, choose the folder, finish the wizard. Per-user install (no admin).
  The installer is **unsigned**, so SmartScreen will warn.

## Data locations, upgrades and uninstall

| | Path |
|---|---|
| Linux database | `${XDG_CONFIG_HOME:-~/.config}/Hardware Intelligence Platform/inventory.sqlite` (+ `-wal`/`-shm` while running) |
| Windows database | `%APPDATA%\Hardware Intelligence Platform\inventory.sqlite` (Electron `userData`; **path not yet observed on Windows**) |
| Pre-migration backup | `inventory.sqlite.pre-v<N>.bak`, written next to the database before any upgrade migration |
| Install location | the AppImage file / the chosen Windows folder — never contains user data |

- Updating replaces the program only; the database is outside the install location. On first launch of a newer
  version, pending migrations run in transactions after a backup copy is taken. Verified (see below).
- A database written by a **newer** release is refused (exit code 1, message names the cause, file untouched).
- The NSIS config sets `deleteAppDataOnUninstall: false`: uninstalling keeps the database. (Configured; the CI
  smoke job asserts it, but it has **not been run**.) To remove all data, delete the data directory yourself.
- `HIP_DB_PATH` is honoured only by unpackaged (development/test) runs; a packaged app ignores it.

## Permissions

Never needs root. Optional, unprivileged limitations are reported on the Collectors page:
`udevadm` missing → polling instead of udev (monitor shows "polling" and why); `smartctl` missing or no raw
disk access → SMART `unavailable`/`permission_required`; SMBIOS memory modules need root. Granting extra
privileges (e.g. a `disk` group membership for SMART) is the user's choice and outside the package.

## Platform differences

| | Linux | Windows |
|---|---|---|
| Collectors | 16 (sysfs/procfs + optional tools) | 4 (PowerShell CIM/PnP) — fixtures only |
| Live events | udev `udevadm monitor`, polling fallback | polling only |
| Metrics | CPU, memory, network, disk, battery, temperatures, fans | CPU + memory via Node `os`; the Monitor page labels sources from the provider (not Linux paths) |
| Data dir | `~/.config` | `%APPDATA%` |

## Security of the package

Window: `nodeIntegration: false`, `contextIsolation: true`, renderer `sandbox`, `webSecurity`, no webview;
permission requests denied; external navigation and `window.open` denied (only `http(s)` links go to the OS
browser); sender-checked, schema-validated IPC over a fixed channel list; preload exposes only a fixed API.
All verified by unit tests **and** by the e2e suite against the packaged binary.

**Renderer loading.** Production serves the renderer from a privileged custom scheme, `hip-app://renderer/`
(`src/main/security/app-protocol.ts`), not `file://`. The handler serves only `GET/HEAD`, only inside
`out/renderer`, only known asset types, and attaches the strict production CSP header itself (the earlier
`file://` setup could never receive the header-based CSP; only the HTML `<meta>` CSP applied). This made it
possible to ship with **`GrantFileProtocolExtraPrivileges` disabled**: with the fuse off and `file://` loading
the packaged window was blank (`chrome-error://chromewebdata/`, observed), so a naive flip was not an option.

**Fuses read back from the built binary** (`scripts/verify-artifacts.mjs`, `@electron/fuses`): RunAsNode off,
NODE_OPTIONS off, `--inspect` off, cookie encryption on, only load app from asar, GrantFileProtocolExtraPrivileges
off. Embedded asar integrity validation is off (not supported on Linux by this Electron build).

**Debugging endpoints.** Chromium parses `--remote-debugging-port/-pipe` *before any of our JavaScript runs*, so the
app cannot remove the switch; it can only notice it and exit. Packaged builds therefore exit with code 2 and a
message when any of `--remote-debugging-port|pipe|address`, `--remote-allow-origins`, `--inspect*`, `--debug*` is
present (`src/main/security/debug-switches.ts`) unless `HIP_ENABLE_DEBUGGING=1` is set. Ordinary arguments
(`--no-sandbox`, `--ozone-platform`, `--lang`, file paths, …) are untouched. DevTools (menu item and
Ctrl+Shift+I) are disabled in packaged builds under the same opt-in (configuration; not exercised at runtime).
Limits, stated plainly:
- The refusal is a guard against accidental/injected arguments. Anyone who can set the process environment can
  set `HIP_ENABLE_DEBUGGING=1`; this is not a boundary against the local user. (The packaged e2e suite needs the opt-in.)
- Other Chromium switches that could affect networking or the sandbox (`--no-sandbox`, `--host-rules`, `--js-flags`,
  `--proxy-server`, …) are deliberately **not** filtered: a generic filter would break legitimate OS integration and
  cannot be made complete. Ignoring one family of switches does not prove that no other debugging path exists.
- Between process start and the refusal (~0.5 s including AppImage extraction) Chromium may have bound the port.
  The test polled every 50 ms and never saw it answer, which is a sample, not a proof.

Package content: `out/` + `package.json` + `zod` only (no maps/tests/sources; no developer paths or e-mail found by
grep). Chromium/Electron licenses ship (`LICENSE.electron.txt`, `LICENSES.chromium.html`).

Not done: code signing, auto-update (none exists; none added), asar integrity, **no project LICENSE file — the
license choice is pending the owner's decision** and nothing was added.

## Verification status

### Linux AppImage — run on the dev laptop (isolated `XDG_CONFIG_HOME`, never the real profile)

| Check | How | Result |
|---|---|---|
| AppImage builds, file exists, 117 MB, SHA-256 recorded | `npm run package:linux` | ✅ |
| Main, preload, renderer load; renderer is on `hip-app://renderer/`, not `file:` | `HIP_E2E_PACKAGED=… node tests/e2e/run.mjs` (automated, packaged binary) | ✅ 72/72 |
| Real OS inventory, diagnostics, snapshots + comparison, metric sampling, settings/DB persistence across restart, clean shutdown | same suite | ✅ |
| IPC security / CSP / navigation lockdown in the packaged build | same suite | ✅ |
| DB created in per-user dir, not install location; migrations applied; no backup on first run | `node tests/e2e/packaged.mjs` | ✅ |
| udev native monitoring active in the packaged app; periodic rescan fires | same (plug-in via udev was observed earlier from source; unplug still unobserved) | ✅ / ❓ unplug |
| Graceful shutdown: exit 0, WAL checkpointed; SIGTERM also exits and checkpoints | same + manual | ✅ |
| Upgrade: schema-v3 database with user data → migrated to v4, settings/events kept, `.pre-v4.bak` holds old data | same (seeded by `scripts/seed-db.ts`) | ✅ |
| Newer-schema database refused, file byte-identical | same | ✅ |
| Missing optional tools (PATH without udevadm/smartctl/lsusb/bluetoothctl/ip/lspci): starts, scans, SMART = unavailable with reason, monitor falls back to polling | same | ✅ |
| Runs unprivileged | same | ✅ |
| Normal launch opens no listening TCP port anywhere in the process tree (`/proc/<pid>/fd` vs `/proc/net/tcp`) | same | ✅ |
| `--remote-debugging-port`, `--remote-debugging-pipe`, `--inspect` refused (exit 2, message, no endpoint afterwards, no database created) | same | ✅ |
| Fuses, ELF arch, version in file name, asar content read from the built output | `node scripts/verify-artifacts.mjs linux` and `tests/packaging.test.ts` (runs it if `dist/` exists) | ✅ |
| Launch via FUSE (no extract-and-run) | manual, `libfuse2` present | ✅ launches |
| Export redaction | `tests/security.test.ts` (builder); save dialog not driven in the packaged app | ✅ unit / ❓ packaged dialog |
| Restricted permissions (e.g. SMBIOS as non-root) | real laptop reports `permission_required` | ✅ |
| Clean machine without Node/dev tools; other distros; Wayland vs X11 matrix; sandbox on distros that restrict user namespaces | — | ❓ not tested |

### Linux artifact record

| File | SHA-256 | Notes |
|---|---|---|
| `dist/hardware-intelligence-platform-0.1.0-linux-x86_64.AppImage` (117 MB) | `4b86d233b57271d9db7debe1d9578430be3182bdc1559db6c51cff20e6723c02` | built 2026-10-20 on Fedora 44; rebuilt after the hip-app:// change, so the earlier checksum (`5a2974a9…`) is obsolete. AppImages are not bit-reproducible: every rebuild changes the hash; `dist/SHA256SUMS.txt` is regenerated each time |

### Windows

| Check | Status |
|---|---|
| Installer built | ❌ **not built; no artifact exists**. Blocker below. CI job `package-windows` is written to build it on `windows-latest` (native NSIS, no Wine), verify it with `scripts/verify-artifacts.mjs win` (PE x64, fuses, asar, version) and upload it with `SHA256SUMS.txt`. **That job has never run.** |
| Config coherent (NSIS x64, per-user, keeps data, icon.ico, fuses, no native modules) | ✅ asserted by `tests/packaging.test.ts` (configuration only) |
| Install/launch/DB path/uninstall keeps data | ❓ scripted in CI job `smoke-windows` (silent install → launch → DB exists in `%APPDATA%` → close → uninstall → DB kept). Never run |
| Windows collectors, 4 PowerShell collectors, polling events, CPU/memory metrics on real hardware | ❌ **fixture-only**; needs a manual run on a physical Windows 10/11 machine |
| Upgrade over an existing install, SmartScreen/AV behaviour, signing | ❌ not tested |

**Windows blocker (diagnosed, not guessed).** `electron-builder --win` on this machine downloaded Electron then
stalled: the 158 MB `electron-v44.9.1-win32-x64.zip` from GitHub (and from the npmmirror mirrors) transfers at
roughly 5–70 KB/s here (5 MB in 9 minutes with `curl -C -`), and the npm registry/Linux assets were fine. Even
with the zip, a Linux host has no `wine` for resource editing. So: build on `windows-latest` via CI.

### Windows: what the CI will and will not prove

`package-windows` proves only that an installer was produced and passes the structural checks. `smoke-windows` (hosted VM, non-blocking) proves install → launch → database in `%APPDATA%` → close → uninstall keeps the database. Neither says anything about hardware collection.

### Running CI (the user must do this; no GitHub CLI/credentials were available here)

The project is not a git repository, so first put it in one and push (your choice of remote):
```bash
git init && git add -A && git commit -m "Initial import"
git remote add origin git@github.com:<you>/<repo>.git && git push -u origin HEAD
```
Then open the repository's **Actions** tab, or `gh workflow run CI` / `gh run watch`. When `package-windows` is green, download the `windows-installer` artifact and check `sha256sum -c SHA256SUMS.txt` (or `Get-FileHash`). `.gitignore` already excludes `dist/`, `out/`, `node_modules/`.

### Manual checklist for a physical Windows machine — **PENDING: not yet performed by anyone**

Nothing below has been run. Use a real Windows 10/11 x64 PC (not a VM) and a standard (non-Administrator) account.
Copy the table at the end into an issue/notes and fill it in. Mark each step PASS / FAIL / N/A with a note.

**Record first:** Windows edition + build (`winver`), CPU/RAM/model, application version, installer file name and
`Get-FileHash <installer> -Algorithm SHA256` (must equal the CI `SHA256SUMS.txt`), Defender/SmartScreen prompts seen.

1. **Install** the NSIS installer as a normal user (no UAC elevation expected; per-user). Confirm name, version and icon
   in Settings → Apps and in the Start menu entry; note the SmartScreen "unknown publisher" warning (unsigned build).
2. **Launch without Administrator.** In Task Manager → Details confirm the process is not elevated.
3. **Database:** `%APPDATA%\Hardware Intelligence Platform\inventory.sqlite` exists; About/Settings shows that path and schema v4.
4. **Hardware scan:** Overview populates; compare Hardware page with Device Manager and `msinfo32`. Open **Collectors**: record
   every Windows collector's status/limitations (PowerShell blocked? execution policy? CIM errors must be reported, not crash).
5. **Metrics:** Monitor shows CPU and memory moving plausibly against Task Manager (Performance); every other card says
   unavailable, and each card's *Source* line names `os.*` (not `/proc` or `/sys`). Provider table shows no errors.
6. **USB connect/disconnect while monitoring is on:** note the mode shown (expected: *polling*, no native events on Windows);
   plug a USB device, wait one poll interval, confirm a `device.connected` event; unplug, confirm disconnect is recorded.
7. **Topology / identifiers:** open a USB or PCI device: hardware IDs (VID/PID, PNP IDs) match Device Manager → Details;
   parent relationships are marked *reported* vs *inferred*; check the PowerShell `DEVPKEY_Device_Parent` path produced parents.
8. **Unavailable / restricted data:** run with a restricted execution policy or disable a service (e.g. WMI) if feasible;
   confirm a clear limitation, not a crash or an empty "everything removed" inventory. SMART/BitLocker-style data may legitimately be absent.
9. **Restart:** close from the window, reopen: inventory is shown immediately, settings kept, acknowledged findings kept.
   Then end the task from Task Manager while a scan runs; reopen: the database opens cleanly.
10. **Snapshots:** create one, change something (plug a device / rename nothing), create another, compare: the change appears with provenance and certainty.
11. **Diagnostics and sampling:** Diagnostics page lists rules with last-run times; the metrics rule reports healthy sampling; pause/resume sampling works.
12. **Upgrade:** keep the old installed version and its data, run a newer installer over it (same folder): the app starts,
    `inventory.sqlite` and its `.pre-v<N>.bak` (if a migration ran) exist, inventory/settings/snapshots unchanged.
13. **Uninstall** via Apps: program files and shortcuts gone; `%APPDATA%\Hardware Intelligence Platform` **still present**
    (documented policy); reinstalling picks the data up again. Deleting that folder is the only way to remove data.
14. **Export:** with default privacy settings export JSON and confirm serials, MAC addresses, hostname and IPs are `[redacted]`.

| # | Result (PASS/FAIL/N/A) | Notes / screenshots / errors |
|---|---|---|
| OS + app version + installer SHA-256 | | |
| 1 … 14 | | |

Until this table is filled in by a person on real hardware, Windows runtime support remains **unverified**.
