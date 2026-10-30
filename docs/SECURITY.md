# Security model

The app is privileged by nature (it reads hardware state), so the renderer is treated as untrusted.

## Electron

- `nodeIntegration:false`, `contextIsolation:true`, `sandbox:true`, `webSecurity:true`, `webviewTag:false`
  (single source: `WINDOW_WEB_PREFERENCES`, asserted by tests).
- Restrictive CSP (`default-src 'none'`, no inline script, no `eval`, `connect-src 'none'`, no framing) set
  via response headers in production, plus a meta tag. Development relaxes it only for the Vite dev server.
- `will-navigate` is blocked for anything outside the app origin; `window.open` is denied (only `http(s)`
  links open in the system browser); `will-attach-webview` is blocked; all permission requests are denied.
- Single-instance lock (two instances would contend for the database).

## IPC

- Channels are a closed whitelist (`IPC_REQUEST_SCHEMAS`). Unknown channels, untrusted sender frames and
  invalid payloads are rejected in one place (`ipc/dispatch.ts`). Schemas are `.strict()`.
- There is no channel to run commands, read/write arbitrary files or pass paths. Export/backup choose the
  destination with a native save dialog in the main process.
- The preload exposes a fixed object; `ipcRenderer` itself is never exposed. The preload bundle has no
  runtime dependencies (a sandboxed preload cannot `require` them).

## Operating system access

- Read-only by default; runs as the normal user. Root-only data is reported as a limitation, not escalated.
- Process execution uses `spawn(file, args, {shell:false})` with timeouts, output caps and kill-on-timeout.
  Only fixed tools are invoked (`udevadm`, `smartctl`, `bluetoothctl`, `powershell.exe`, `hyprctl`, `rfkill`,
  `journalctl`, `tuned-adm` (read-only queries), `nvidia-smi` (queries), `pkexec` with the two installed
  helpers); no collector output is ever executed or interpolated into a command.
- State-changing actions are limited to the per-device switches (Settings → Features & controls → Devices):
  `hyprctl keyword device[<name>]:enabled <bool>` for input devices (only names Hyprland itself lists) and
  `rfkill block|unblock <index>` for radios. No root; the last keyboard and last pointer cannot be switched
  off. Nothing writes to sysfs.
- **Privileged helpers (optional, Linux).** The app never runs as root, never uses `sudo` and never asks
  for a password itself. Two fixed programs can be installed by the user (`sudo sh resources/linux/install.sh`)
  to `/usr/local/libexec/hardware-intelligence/`, each with its own polkit action
  (`dev.hardware-intelligence.perf.apply`, `dev.hardware-intelligence.hid.probe`, `auth_admin_keep`). The
  app runs them only as `pkexec <fixed path> <validated tokens>` — no shell, no interpreter flags, no script
  text on the command line — and only after checking the installed file is a regular, root-owned, not
  group/world-writable executable in a root-only directory, byte-identical to the shipped copy, with its
  polkit policy present. Missing or modified helpers leave every control read-only.
  - `hip-perf-helper` accepts only whitelisted `id=value` settings (CPU governor/energy preference/turbo/
    frequency range/perf %, RAPL PL1/PL2, Intel GPU min/max/boost (i915 and xe), amdgpu level/OverDrive/power
    cap, nvidia-smi power limit, tuned profile). It re-reads every limit from the kernel itself (e.g. GPU ≤ RP0,
    AMD clocks within OD_RANGE, PL1 ≤ 2× and PL2 ≤ 3× the firmware rating), validates **all** arguments before
    writing any, and refuses anything else. Values are also validated by the IPC schema (plain tokens only)
    and against the discovered control in the main process.
  - Every change is a recorded transaction: previous values, requested values, kernel read-back, and an
    automatic, verified rollback of anything that changed if the helper fails part-way. Operations are
    serialised (one change or test at a time). Nothing is re-applied at start-up.
  - `hip-hid-probe` opens only the named `/dev/hidrawN`, which the app first checks belongs to the selected
    device, captures raw reports for 3–20 s and, for Logitech HID++ devices, sends read-only queries. It
    never sends a setting-changing request. Decoding happens unprivileged in the app.
  - Remove with `sudo sh resources/linux/install.sh --uninstall`. Details: docs/PERFORMANCE.md.
- Device test reads `journalctl -k` (kernel messages) and, only during an explicit hands-on session on the
  selected device, that device's `/dev/input/event*` nodes (non-blocking, never grabbed). Sessions stop after
  2 minutes or when the page closes; only counts and key names reach the page, nothing is stored.
- No USB writes, no serial commands, no firmware/driver actions.

## Data handling

- Sensitive values (serials and other unique ids, MAC, IP, hostname) are flagged at collection time.
  Exports redact them unless the matching setting is enabled; identity keys (which can embed serials/MACs)
  are never exported — devices are referenced by opaque hashed ids. Sensitive identifiers are not searchable.
- The UI masks sensitive identifiers until revealed.
- No telemetry exists. Nothing is sent off the machine (CSP forbids it from the renderer).

## Not yet implemented

Credential storage for integrations (OS keychain), log redaction beyond what the app logs today (it logs
little), support-bundle export, database deletion controls, and a signed/updating distribution.

## Packaged builds

Details, evidence and limits are in [PACKAGING.md](PACKAGING.md#security-of-the-package). Summary:

- **Renderer origin:** production serves the UI from `hip-app://renderer/` (confined to `out/renderer`, GET/HEAD, known
  asset types, strict CSP response header). `file://` is not used, so Electron's `GrantFileProtocolExtraPrivileges`
  fuse is **disabled** in the packaged binary (read back from the binary by `scripts/verify-artifacts.mjs`).
- **Other fuses:** RunAsNode, NODE_OPTIONS and `--inspect` handling off; cookie encryption on; app loads only from asar.
- **Debugging:** packaged builds exit (code 2) on `--remote-debugging-*`, `--remote-allow-origins`, `--inspect*`, `--debug*`
  and have DevTools disabled, unless `HIP_ENABLE_DEBUGGING=1`. Chromium reads these switches before our code runs, so this
  is "notice and exit", not "prevent"; it does not stop a local user who controls the environment, and other Chromium
  switches are intentionally not filtered. A normal packaged launch was observed to hold no listening TCP socket.
- `HIP_DB_PATH` is ignored by packaged builds; uninstalling never deletes user data.
- Remaining gaps: unsigned builds, no auto-update, asar integrity off on Linux, DevTools-disabled is configuration-only
  (not exercised at runtime), Windows behaviour entirely unverified, **no LICENSE file (owner decision pending)**.
