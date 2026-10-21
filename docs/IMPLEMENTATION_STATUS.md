# Implementation status

Legend: ✅ implemented **and verified** (how is stated) · 🟡 partial · ⬜ not started · 🔒 blocked · ❓ implemented but unverified

Last verified: Linux (Fedora 44, kernel 7.2, HP EliteBook 840 G8) — typecheck, **323 unit tests**, **83 e2e checks from source**, production build; Linux AppImage (rebuilt 2026-10-21, SHA-256 `773f4918…`): **85 e2e checks** and **43 install/upgrade/limited-environment/debug-switch checks** against the packaged binary, plus `scripts/verify-artifacts.mjs linux`. Windows/macOS: fixtures only; **no Windows installer has been built and CI has never run** (see docs/PACKAGING.md).

## Phase 0 — repository & architecture
| Item | Status | Evidence |
|---|---|---|
| Repo scaffold, TS strict, electron-vite, vitest | ✅ | `npm run typecheck`, `npm test`, `npm run build` |
| Architecture documented | ✅ | `docs/ARCHITECTURE.md` |
| CI workflow (check on Linux+Windows, Linux e2e, package + smoke jobs for both OSes, artifacts, no auto-publish) | ❓ | `.github/workflows/ci.yml` rewritten in Phase D (YAML parses; policy asserted by `tests/packaging.test.ts`); **never run on GitHub** |
| Lint (ESLint) | ⬜ | `typecheck` only |

## Phase 1 — desktop foundation
| Item | Status | Evidence |
|---|---|---|
| Secure Electron shell (isolation, sandbox, CSP, navigation/permission lockdown) | ✅ | unit tests + e2e against the live window |
| Typed preload + validated IPC (whitelist, sender check, strict schemas) | ✅ | unit + e2e (rejects invalid payloads, no Node globals) |
| Design system, dark/light theme, nav, empty/error/loading states | 🟡 | verified visually in both themes; no accessibility audit |
| SQLite + versioned migrations, backup, retention for events | ✅ | `tests/database.test.ts`; backup button uses a native dialog (not automated) |
| Settings persisted and validated | ✅ | e2e: persists across restart |
| Collector health model and screen | ✅ | e2e + real machine |
| App icons / metadata | 🟡 | placeholder `build/icon.png/.ico` generated for packaging, author/desktop name set; no designed brand assets |

## Phase 2 — real hardware inventory
| Item | Status | Evidence |
|---|---|---|
| Collector framework (contracts, timeout/retry, schema validation, statuses) | ✅ | tests |
| Linux collectors (16, see COLLECTORS.md) | ✅ | fixtures + real machine: 81 devices in 16 categories |
| Windows collectors (4) | ❓ | fixture parser tests only; never run on Windows |
| Normalisation, stable identity, merge, property provenance | ✅ | tests |
| Inventory, details, search/filter/sort, provenance and permission display | ✅ | e2e |
| Memory module details | 🟡 | SMBIOS parser fixture-tested; needs root, which the dev machine lacks, so not verified on real data |
| SMART health | 🟡 | parser fixture-tested; real run reports `permission_required` (correct, but real output unverified) |
| Bluetooth paired devices | 🟡 | BlueZ via `bluetoothctl`; verified on real machine (1 paired headset) |
| Audio | 🟡 | ALSA cards only; PipeWire/PulseAudio not collected |
| Displays | 🟡 | EDID identity/size/preferred mode; active mode & refresh unavailable on Linux sysfs |
| Windows displays, audio, Bluetooth, volumes, SMART, COM ports | ⬜ | |

## Phase 3 — live events & topology
| Item | Status | Evidence |
|---|---|---|
| Event pipeline (validate, dedupe, persist, fan-out) | ✅ | tests |
| Linux native notifications (udev) with polling fallback, debounce, restart, degraded state | ✅/🟡 | logic unit-tested; the real `udevadm monitor` process runs under the app |
| **Plug-in detection on real hardware** | ✅ | A USB audio dongle plugged in while the app was running produced 3 `device.connected` events without restart |
| **Unplug detection on real hardware** | ❓ | unit-tested (disconnect/reconnect); not yet observed live |
| Windows device notifications | ⬜ | polling only |
| Persist inventory changes | ✅ | tests + real DB inspection |
| Topology graph from real records, reported vs inferred, filters, search, collapse | ✅ | unit (layout) + e2e |
| Windows hierarchy via SetupAPI/CfgMgr32 | ⬜ | uses `DEVPKEY_Device_Parent` via PowerShell (unverified) |

## Phase A (diagnostics) — complete
| Item | Status | Evidence |
|---|---|---|
| Migration 002: rebuilt `diagnostic_findings` (rule version, subject identity, last-seen, ack/resolve reason, statuses `active/acknowledged/resolved/dismissed`, severities `info…critical`) + `diagnostic_rule_runs`; legacy rows mapped | ✅ | `tests/diagnostics.test.ts` (v1→v2 upgrade with populated DB) |
| Rule contract + 10 rules (collector health, stale inventory, OS device error, disk space, SMART, temperature vs sensor limits, network link down (opt-in), missing device, monitoring state, property changed) | ✅ | unit tests per rule; real findings on the dev laptop |
| Engine: dedupe by (rule, subject), update-in-place, safe auto-resolve, reopen, escalation re-activates dismissed/acknowledged, per-rule failure isolation, run records, mandatory evidence above `info` | ✅ | unit/integration tests |
| Regression: failed or permission-limited collector never yields a device-removed finding | ✅ | test with the real InventoryService |
| IPC (6 channels) validated; UI page (summary, tabs, filters, detail+evidence, actions, rule health) | ✅ | unit + e2e (41 checks) |
| Rules use *stored properties* as of the last scan; metric-sample evidence arrives with Phase C | 🟡 | |
| `device.os_error` fires only where a collector reports `status: error` (Windows PnP/disk health). No Linux collector sets it, so it never fires on Linux | 🟡 | by design; Windows path fixture-tested only |

## Phase B (snapshots) — complete
| Item | Status | Evidence |
|---|---|---|
| Migration 003: coverage, versions, machine id, counts on `inventory_snapshots`; category/source on records | ✅ | v2→v3 upgrade test with a pre-existing snapshot |
| Snapshot = self-contained validated copy of present devices (properties+provenance, relationships, identifiers) + per-collector coverage; atomic insert; capture in one synchronous section after a fresh scan | ✅ | tests (mutating live inventory afterwards does not alter the snapshot; failed insert leaves nothing) |
| Comparison: added / removed / property / relationship / coverage / indeterminate; re-key matching (serial = probable, id+name heuristic = uncertain, ambiguous = not guessed); volatile excluded by default; sensitive values masked | ✅ | 33 tests |
| Removal confirmed only if the owning collector was `complete` in **both** snapshots; unreadable stored records → indeterminate | ✅ | regression tests for every non-complete coverage state + end-to-end failed-collector test |
| UI: create, history, coverage/limitations, compare with before/after + provenance + certainty, in-page delete confirmation (no auto-retention) | ✅ | e2e (53 checks) on the real app |
| Compare against the *current* live inventory without saving | ⬜ | create a snapshot instead |

## Phase C (metrics & monitoring) — complete on Linux
| Item | Status | Evidence |
|---|---|---|
| Migration 004: time and series indexes on `metric_samples` (existing table reused) | ✅ | |
| Provider contract + 6 Linux providers: CPU (`/proc/stat`), memory (`/proc/meminfo`), network rx/tx rates (`/sys/class/net/*/statistics`), disk read/write/busy (`/sys/block/*/stat`), battery charge/power (`power_supply`), temperatures + fans (hwmon) | ✅ | fixture tests per provider; real values on the dev laptop |
| Counter maths: deltas over monotonic time, counter resets skipped (never negative), first sample/new interface gets no rate, zero/negative `dt` and zero-tick intervals produce no value, invalid readings dropped and counted | ✅ | `tests/metrics-providers.test.ts` |
| Sampler service: own timer (no inventory rescans), per-provider isolation + timeout, re-baseline after failure/pause, bounded ring buffers, series cap, averaged batched writes (30 s), retention pruning, history survives restart | ✅ | `tests/metrics-service.test.ts` (19 tests, incl. fake timers and 150k-row scale test) |
| Pause/resume, interval and enable/disable via settings | ✅ | unit + e2e |
| Monitor page: CPU, memory, network, disk I/O (+busy), battery, temperatures, fans; time window; units; real timestamps; live/stale/waiting/unavailable states; paused banner; source line per card; provider health table | ✅ | chart tests (11) + e2e |
| Per-device "Live metrics" section on device pages (only series with a known device) | ✅ | e2e |
| Diagnostics rule `metrics.availability` (provider erroring/stalled, sampling paused) | ✅ | unit tests |
| Cross-check: charted memory utilisation agrees with `/proc/meminfo` read independently by the e2e test | ✅ | e2e |
| Windows/macOS: CPU + memory via Node `os` only; no network/disk/battery/temperature | ❓ | fixture-tested, never run on Windows. Monitor cards now name the provider's actual source instead of Linux `/proc` paths (Phase D fix; Linux e2e unchanged) |
| Per-core CPU, GPU, voltage/current sensors, per-process data, disk latency | ⬜ | |
| `sensor.temperature` rule still reads the stored property, not metric samples | 🟡 | |

## Micro-level inspection (master prompt 2) — in progress
Baseline re-run 2026-10-21: typecheck clean, 293 unit tests, build OK, 70/70 e2e. Findings: a CPU/memory slice already existed but was undocumented.
| Item | Status | Evidence |
|---|---|---|
| CPU topology (packages/cores/threads, caches, NUMA, freq policy), per-CPU/detail providers, PSI pressure, vmstat/paging, memory detail, CPU & Memory page | 🟡 | `tests/cpu-memory-deep.test.ts`, `tests/metrics-detail.test.ts`; values seen via unit tests, **no e2e for the CpuMemory page yet** |
| Rules `cpu/memory/io.pressure`, `memory.swap_thrash`, `cpu.thermal_throttle`, `memory.ecc_errors` | ✅ unit | `tests/diagnostics-hardware.test.ts` (ECC counters not exposed on the dev laptop → "insufficient data") |
| PCI: AER error totals, NUMA-local CPU list, runtime-PM state, upstream-port link capability (derived) | ✅ | fixture tests + real scan: NVMe `0000:55:00.0` x4 with upstream x4 and zero AER errors |
| PCI: sysfs sentinel link widths (0 / 255) dropped instead of stored as real values | ✅ | found on the real machine (integrated devices); unit-tested |
| Rules `pci.aer_errors` (fatal/non-fatal/large correctable counts) and `pci.link_width` (width below both device and upstream capability; **speed deliberately not judged** because idle speed reduction is normal) | ✅ unit | no real device on the dev machine triggers them |
| USB: bcdDevice revision, protocol, endpoint summary (type/direction/max packet, bounded to 32), hub-port connect type and over-current count | ✅ | fixture tests + real USB devices on the dev laptop (mouse dongle, Bluetooth, camera, audio) |
| Rule `usb.reconnect` (3+ disconnect events of one device in 30 min; replugging twice is normal) | ✅ unit | needs the event pipeline; not triggered live (no flaky device) |
| NVMe controller state/transport/firmware/queues from `/sys/class/nvme` + physical block size; rule `storage.nvme_state` | ✅ | real drive reports `live`; the rule has only synthetic coverage |
| NVMe SMART health log (percentage used, media errors, …) | 🟡 | parser fixture-tested; needs root, real output unverified |
| Driver module version/srcversion (`/sys/module/<driver>`) for PCI devices; absent for most in-tree drivers → shown as not exposed | ✅ | real scan (nvme, vmd report versions) |
| GPU: DRM card, connectors and connected outputs, max clock; metrics `gpu.frequency` (i915/xe), `gpu.utilization` and `gpu.memory_used` (amdgpu sysfs only); Monitor GPU card | ✅ Intel / ❓ AMD | real 450 MHz reading from `gt_act_freq_mhz`; AMD counters fixture-less (reader only, never run on AMD); no NVIDIA support (needs vendor tools, intentionally not used) |
| Sensor registry page (all hwmon channels, label state, driver limits, age/stale, source) | ✅ | e2e on the real app. Values are from the last inventory scan, not live |
| Capability matrix (category × collector coverage from collector health) on the Collectors page | ✅ | unit + e2e |
| e2e for CPU & Memory page | ✅ | 75/75 e2e |
| Topology edge-certainty UI | ✅ already present | reported/inferred badge and dashed inferred edges were already in Topology.tsx |
| Per-core frequency | ✅ already present | metric `cpu.frequency:cpuN` (cpufreq) charted on the CPU & Memory page; absent in VMs. Per-core *temperature* is not claimed: hwmon exposes per-core channels only on some CPUs and they are listed on the Sensors page as the driver reports them |
| Device comparison ("Device diff" page): same-category only, source per value, live readings not counted as differences, sensitive values masked | ✅ | unit (`compare-logic`) + e2e page load; not exercised with a real pair in e2e |
| I²C/SMBus: passive adapter + registered-client inventory (`linux.i2c`); never opens `/dev/i2c-*`, never probes addresses | ✅ | fixture tests + real scan (12 adapters incl. SMBus I801, clients) |
| Process monitoring: **opt-in, off by default**; names, state, threads, RSS and CPU share only (no cmdline/env/user); bounded, PID-reuse safe, Linux only; page polls only while open | ✅ | 13 unit tests + e2e (off by default → enable → real rows → disable) + packaged e2e |
| Windows depth (`windows.hardware`): CPU cache/virtualisation flag, memory ECC type/slots/max capacity, GPU driver/mode, battery, ACPI thermal zones | ❓ | fixture parser tests only; **never run on Windows**. GPU memory deliberately omitted (32-bit AdapterRAM saturates); ACPI zone is not CPU temperature |
| "Hardware Events" | ✅ existing | the Events page already lists persisted hardware events; no separate page was added |
| Not done: Windows I²C/process monitoring/NVMe health/PCIe AER (no Windows equivalent implemented), macOS, NVIDIA/AMD vendor telemetry, per-process disk/network | ⬜ | |

## Phase 4 — monitoring & diagnostics
| Item | Status |
|---|---|
| Metric collectors, charts, sampling controls | ✅ see Phase C |
| Diagnostics engine and findings UI | ✅ see Phase A |
| Snapshots and comparison | ✅ see Phase B |
| Live readings | ✅ sampled over time (Phase C); the detail-page "Live readings" table still shows values as of the last inventory scan |

## Phase 5 — integrations & support
| Item | Status |
|---|---|
| JSON export with per-category redaction | ✅ unit-tested (dialog not automated) |
| Database backup | ✅ unit-tested |
| Support bundle, rule packs, integrations (MQTT/HA/…), credential store, user-initiated data deletion | ⬜ |

## Phase 6/7
| Item | Status |
|---|---|
| 3D explorer | ⬜ |
| AI assistant | ⬜ (intentionally last) |
| Packaging: `electron-builder` installed (locked), config extended (icons, fuses, artifact names, asar contents) | ✅ | `tests/packaging.test.ts`; package built |
| Linux AppImage built | ✅ | `dist/hardware-intelligence-platform-0.1.0-linux-x86_64.AppImage`, 117 MB |
| Linux AppImage launched and exercised | ✅ | `HIP_E2E_PACKAGED=… node tests/e2e/run.mjs` 72/72; `node tests/e2e/packaged.mjs` 43/43 (first run, restart, v3→v4 upgrade with backup, newer-DB refusal, missing tools, udev active, periodic rescan, graceful shutdown, no listening port, debug switches refused). Dev machine only; other distros untested |
| Renderer served from `hip-app://` with `GrantFileProtocolExtraPrivileges` fuse disabled | ✅ | fuse read from the built binary; packaged e2e; path-confinement unit tests. (A plain flip with `file://` gave a blank window, hence the scheme) |
| Packaged builds refuse remote-debugging/inspect switches; DevTools off | ✅ / 🟡 | refusal exercised on the packaged AppImage (exit 2, no endpoint seen); DevTools-off is configuration + unit test only; Chromium binds the port before our code runs (see PACKAGING.md) |
| Artifact verifier (`scripts/verify-artifacts.mjs`: name/version/arch/fuses/asar/SHA-256) | ✅ Linux / ❓ Windows | ran on the AppImage; Windows path untested until CI runs |
| Windows NSIS installer | 🔒 **not built; no artifact exists**: local download of the 158 MB Electron win32 zip stalls (~5–70 KB/s); CI job `package-windows` (native, no Wine) is written but **never run** | never run |
| Windows install/launch/uninstall smoke | ❓ scripted in CI (`smoke-windows`), never run | |
| Windows runtime (collectors, events, metrics, data path) on real hardware | ⬜ manual checklist in docs/PACKAGING.md | |
| Code signing, auto-update | ⬜ |
| Project LICENSE file | ⬜ owner decision pending; none added | |
| Performance | 🟡 3,000-device scan/rescan and 5,000-node layout are unit-tested; renderer table is paged (200 rows) but not stress-tested at 3,000 rows in the real UI |

## Known limitations / bugs
- `HIP` single instance lock + `before-quit` cleanup is exercised by e2e (clean exit code 0), but a crash mid-scan is not tested.
- Relative timestamps ("9s ago") refresh on data events, not on a timer.
- Collectors run in the main process with async I/O; DB writes are synchronous (`node:sqlite`). Fine at current sizes; a worker would be needed for much larger workloads.
- Duplicate-looking HID entries are real (one physical device exposes several input nodes); they are linked to the same USB parent.
