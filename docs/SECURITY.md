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
  Only fixed tools are invoked (`udevadm`, `smartctl`, `bluetoothctl`, `powershell.exe`); no collector
  output is ever executed or interpolated into a command.
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
