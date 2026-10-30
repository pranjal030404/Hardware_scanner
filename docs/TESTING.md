# Testing

```bash
npm run typecheck
npm test              # vitest: unit + integration, no display needed (255 tests)
npm run test:e2e      # builds, launches the real Electron app, drives it over CDP (needs a display)
```

## What the suites cover

| File | Covers |
|---|---|
| `tests/collectors-linux.test.ts` | Every Linux collector against a generated sysfs/procfs tree: parsing, provenance, relationships, sensitive flags, permission-denied, missing interface, timeout, invalid output, wrong platform, SMART & BlueZ via an injected command runner |
| `tests/collectors-windows.test.ts` | Windows parsers against captured-shape JSON, PowerShell runner failure semantics. **Fixture tests only.** |
| `tests/core.test.ts` | Identity, merge/provenance, change detection, placeholder filtering, pci.ids parser, SMBIOS type 17 parser |
| `tests/database.test.ts` | Migrations (apply, repeat, rollback, newer-DB refusal, tamper detection, pre-migration backup), backup, repositories, search escaping, retention pruning, settings validation |
| `tests/inventory-service.test.ts` | Scan semantics: baseline, plug/unplug/reconnect, failure never deletes, partial/permission never deletes, per-collector ownership, field diffs, status change, volatile refresh, scan coalescing, cross-collector merge, 3,000-device performance |
| `tests/events-monitor.test.ts` | Event validation/dedupe/persistence rules, udev line parsing, debounce, polling, pause/resume, degradation, watcher restart |
| `tests/security.test.ts` | Window hardening, CSP, URL trust, IPC whitelist/sender/payload validation, preload surface, renderer isolation (static), export redaction |
| `tests/diagnostics.test.ts` | Every rule (thresholds, freshness, permission/collector failure → insufficient data, no universal temperature thresholds), engine (dedupe, update, auto-resolve vs retain, reopen, escalation, rule isolation, mandatory evidence, manual transitions, disable/enable, filtering, evidence round-trip and corruption tolerance), end-to-end regression with the real `InventoryService`, IPC validation, v1→v2 migration with legacy rows |
| `tests/snapshots.test.ts` | Comparison (identical, added/removed, property/field/relationship changes, volatile and sensitive handling, re-keying, **every non-complete coverage state cannot confirm a removal**, unreadable records, reported vs inferred), service/persistence (self-contained copy, versions, machine id, atomic insert, deletion, v2→v3 migration), IPC validation, 5,000-device compare |
| `tests/metrics-providers.test.ts` | Counter maths and every provider against fixture trees: first sample, resets, new/vanished interfaces, zero/negative dt, partial sensors, battery sign, OS fallbacks |
| `tests/metrics-service.test.ts` | Sampler: recording, invalid readings, unknown devices, failure isolation/recovery, hung provider timeout, interval/pause/resume/disable with fake timers, staleness, batching, retention, bounded memory, history across restart, downsampling, 150k-row scale, IPC validation |
| `tests/chart.test.tsx` | Chart geometry (gaps, clamping, ticks, units, timestamps, 50k points) and server-rendered `TimeChart` (accessibility, empty/stale states, legend, dashes) |
| `tests/topology.test.ts` | Layout, confirmed-only filter, collapse, cycles, 5,000-node performance |
| `tests/e2e/run.mjs` | Real app (69 checks): diagnostics page (real findings, ack/reopen, filters, empty state, rule health, invalid IPC), snapshots (create/compare/confirm-delete/persist), monitor (live CPU/memory/network/disk/battery/thermal cards, **memory agrees with /proc/meminfo read independently**, pause/resume freezes sampling, per-device metrics), plus the earlier checks: startup, first scan with real hardware, renderer isolation, rejected IPC, CSP/network & navigation blocking, search/filter/details, topology, collectors, pause/resume, settings persistence across restart, clean shutdown, DB available immediately after restart |

## Performance tuning and device tests

- `tests/performance.test.ts` — the privileged helper script is executed **unprivileged** with `HIP_ROOT`
  pointing at a generated sysfs tree; the fake `pkexec` runs the same script, so apply → read-back →
  mismatch → partial failure → rollback are exercised end to end without touching the host.
- `tests/hid-deep.test.ts`, `tests/device-test.test.ts` — HID descriptor decoding, deep-test sessions, device
  switches, kernel-log interpretation (all mocked).
- **Opt-in hardware tests:** `HIP_HW_TESTS=1 npx vitest run tests/hw-performance.test.ts` — read-only discovery
  and telemetry on the real machine. Skipped by default and never run in CI. No test changes clocks, voltage,
  power limits, fans or firmware.

## Circuit lab
`tests/circuit.test.ts`: the example player has zero issues and every part works; rail voltages, divider/ADC and runtime; each fault class (swapped wires, short, 5 V on a 3.3 V part, missing GND/SCK, boot straps, input-only pins) is reported; the firmware pin map can fix a mismatch; editing rules; repo and IPC schema. e2e drives the page (encoder → OLED volume, switch → no signal) and the save/load/reject/delete channels.

## Packaged-build tests (Phase D)

```bash
npm run package:linux
export HIP_E2E_PACKAGED="$PWD/dist/hardware-intelligence-platform-0.1.0-linux-x86_64.AppImage"
node tests/e2e/run.mjs        # the full UI suite against the packaged binary (+2 packaged-only checks)
node tests/e2e/packaged.mjs   # first launch, restart, v3→v4 upgrade, newer-DB refusal, missing tools, udev, shutdown, no listening port, debug switches refused
node scripts/verify-artifacts.mjs linux   # fuses/arch/version/asar read from dist/, writes dist/SHA256SUMS.txt
```
Packaged runs set `HIP_ENABLE_DEBUGGING=1` themselves (the app otherwise refuses `--remote-debugging-port`); `tests/e2e/cdp.mjs` now times out every command, fails pending calls when the socket closes, and attaches only to the real app page (the likely cause of the earlier intermittent abort: attaching to a transient target; 8/8 repeated navigation checks pass after the fix, the original abort was not reproduced before it). Both isolate user data with a temporary `XDG_CONFIG_HOME`. `packaged.mjs` seeds old databases with `scripts/seed-db.ts`
(needs `tsx`). On virtual machines relax the hardware expectations with `HIP_E2E_MIN_DEVICES=3 HIP_E2E_UDEV=optional`.
`tests/packaging.test.ts` asserts the packaging/CI configuration and that shared code has no hard-coded Linux paths.
Windows has **no** equivalent run yet: the CI `smoke-windows` job is the only scripted check and the rest is a manual
checklist (docs/PACKAGING.md).

## What is *not* tested

- Windows collectors and Windows metric fallbacks on real Windows; the Windows installer (never built); macOS.
- The packaged app on other Linux distributions / a clean machine; the packaged export/backup save dialogs.
- Unplug/removal on real hardware end to end (unit-tested; plug-in was observed live).
- Real diagnostics firing for disk-full, SMART or over-temperature conditions (this machine had none; rules are tested with constructed data).
- Disk/network counter *resets* on real hardware (unit-tested only).
- Fan metrics (this laptop exposes no fan sensors).
- Real **unplug** detection end to end (plug-in was observed on a real laptop; see IMPLEMENTATION_STATUS).
- Native save dialogs (export/backup) — the export content builder is unit-tested.
- Accessibility audit (keyboard navigation and ARIA roles are implemented but not audited).
- SMART parsing against real drive output (no permission on the dev machine); only fixture JSON.

## E2E notes

- It spawns Electron with `--remote-debugging-port` and a temp `HIP_DB_PATH`; no test dependency beyond Node ≥ 22
  (`WebSocket` global). On CI use `xvfb-run -a node tests/e2e/run.mjs`.
- Assertions on hardware are deliberately generic (counts > N) because the machine under test varies.
- `innerText` honours CSS `text-transform`, so headings are matched case-insensitively.
