# Architecture

Single-user desktop app. No local web server, no external database: renderer ↔ main communicate over
validated Electron IPC; state lives in SQLite (`node:sqlite`).

```
Renderer (React)  ──typed API (contextBridge)──▶  Preload ──ipcRenderer.invoke(whitelisted)──▶  Main
                                                                                                │
                      ┌──────────────── EventBus (validate · dedupe · persist · fan-out) ◀──────┤
                      │                                                                         │
              InventoryService ◀── MonitorService (udev / timer)         SettingsRepo / EventRepo
                │  scan: run collectors → merge → diff → persist → events
                ▼
        Collector layer  (linux.* | windows.*)  ── SysReader / CommandRunner ──▶ OS
```

## Layers and where they live

| Layer | Path | Notes |
|---|---|---|
| Renderer | `src/renderer/` | UI only. No Node, no fs, no shell; talks only to `window.hip`. |
| Preload | `src/preload/index.ts` | Fixed object of methods, each bound to one whitelisted channel. |
| Shared contracts | `src/shared/` | `schemas.ts` (zod; source of truth for types), `ipc.ts` (channel → request schema), `api.ts` (runtime-free types the sandboxed preload may import). |
| Main | `src/main/` | `lifecycle/app.ts` (wiring, window, session hardening), `ipc/dispatch.ts` (single validation choke point), `security/policy.ts`, `services/`, `database/`. |
| Collectors | `src/collectors/` | `core/` (contracts, reader, runner, merge/identity, EDID, ids parsers), `linux/`, `windows/`. |
| Topology | `src/topology/layout.ts` | Pure tree layout from relationship records. |
| Diagnostics | `src/diagnostics/` (rule contract + 11 rules), `src/main/services/diagnostics.ts` (engine) | Deterministic, evidence-based; see below. |
| Snapshots | `src/snapshots/compare.ts` (pure comparison), `src/main/services/snapshots.ts` | Self-contained copies + collector coverage; see below. |
| Metrics | `src/metrics/` (providers, counter maths), `src/main/services/metrics.ts` (sampler) | Own timer, bounded buffers, batched writes; see below. |
| Integrations / AI | `src/integrations` | **Not implemented** (placeholder). |

## Key design decisions

- **`node:sqlite` instead of `better-sqlite3`.** Built into Node 24 and Electron 44; avoids native
  rebuilds per Electron ABI. Trade-off: the API is synchronous and Node marks it as a release candidate.
  Writes happen in transactions in the main process; a scan of ~3,000 devices takes well under a second.
- **Collectors read through `SysReader`** (a root-relative, read-only reader that records
  permission-denied paths). Fixture tests are plain directory trees with symlinks; no mocking of `fs`.
- **Identity.** `key` strings are stable identity (`pci:<addr>`, `usb:<vid>:<pid>:sn:<serial>` or
  `…:port:<path>`, `storage:wwid:<wwid>`, …); the record id is a hash of the key. A device with a serial
  keeps its identity when moved between USB ports; without one the port path is the best identity available.
- **Disappearance rule.** A device is marked *missing* only when the collector that owns it completed
  with outcome `complete`. Errors, timeouts, `partial`, `permission_required` and `unavailable` never
  remove devices.
- **Change detection** uses a content hash that ignores `volatile` properties (counters, live readings),
  so the timeline shows real changes, not noise. Volatile values are still refreshed in the DB.
- **Baseline scan.** The first scan of an empty database stores devices without emitting per-device events.
- **Relationship types** are explicit (`bus_attachment`, `logical_parent`, `storage_attachment`,
  `display_connection`, …) with `reported`/`inferred` directness and a confidence. Kernel device-tree
  parentage is `reported`; anything the app guesses (e.g. PCI function → "system") is `inferred`.
- **Events**: `EventBus` validates against a schema, suppresses identical events inside a 2 s window and
  persists only history types (not transient UI signals such as `monitor.status_changed`).
- **Monitoring**: udev (`udevadm monitor`) → 1.5 s debounce → coalesced rescan; periodic rescan as
  safety net and for volatile readings; automatic watcher restart with backoff; visible *degraded* state.

## Database

Versioned, checksummed, transactional migrations (`src/main/database/migrations/`). A migration that
fails is rolled back and reported; a database newer than the app is refused untouched; an existing
database is copied to `*.pre-vN.bak` before migrating. All tables from the spec exist; the following are
**created but not yet written to**: `metric_samples`, `diagnostic_findings`, `inventory_snapshots`,
`snapshot_device_records`, `integrations`, `knowledge_items`.

## Diagnostics engine (Phase A)

`DiagnosticsService.evaluate()` builds one consistent `RuleContext` (devices incl. missing, collector health,
monitor state, metrics state, recent events, freshness windows), runs every enabled rule in isolation and
applies all results in one transaction.

- **Identity/dedupe:** finding id = hash(rule id, subject). Re-evaluation updates `last_seen_at` and the body;
  it never creates a second row. A `resolved` finding that reappears is reopened.
- **Safe resolution:** a finding is auto-resolved only when its rule *evaluated* and no longer reports the
  subject. A rule returning `insufficient_data` (stale/failed/permission-limited collector), throwing, or listing
  the subject in `retain` leaves existing findings untouched.
- **Status model:** `active → acknowledged / dismissed / resolved` (+ `reopen`). Dismissed/acknowledged findings
  that get *worse* are reactivated.
- **Evidence is mandatory** above `info` and validated per entry on read (one bad reference never hides a finding).
- Rules: `collector.health`, `inventory.stale`, `device.os_error`, `storage.space`, `storage.smart`,
  `sensor.temperature` (sensor-reported limits only), `network.link_down` (opt-in), `device.missing`,
  `monitoring.state`, `metrics.availability`, `device.property_changed`.
- Triggers: debounced after collector/device events, plus a 60 s timer (staleness is time-based).
- Schema: migration 002 rebuilt `diagnostic_findings` and added `diagnostic_rule_runs`.

## Snapshots (Phase B)

A snapshot stores validated JSON copies of every present device (properties with provenance, relationships,
identifiers) plus a `CollectorCoverage` entry per collector (`complete | partial | stale | permission_required |
unavailable | unsupported | error | not_scanned`), versions, a locally generated machine id (never transmitted)
and counts. Capture runs after a fresh scan in one synchronous section, and inserts atomically.

`compareSnapshots(base, target)` classifies differences as added / removed / property / relationship / coverage /
**indeterminate**. A removal is *confirmed* only if the owning collector was `complete` in **both** snapshots;
likewise for additions and for removed properties/relationships. Re-keyed devices (moved USB port) are matched by
serial (probable) or id+name (uncertain, only if 1:1). Unreadable stored records make their devices
indeterminate. Volatile properties are excluded unless requested; sensitive values are masked in results.
Migration 003 added coverage/versions/machine id/counts.

## Metrics (Phase C)

`MetricsService` runs providers on its own interval (1–60 s, default 5 s) — it never rescans the inventory.
Providers are pure functions of `(reader, previous state)` so they are fixture-testable. Readings reference a
device by identity key or identifier (e.g. `block_device=nvme0n1`), resolved to stored device ids; readings for
unknown devices are dropped. Safety properties: monotonic-time deltas, counter resets skipped and counted,
validation gate per unit, per-provider 3 s timeout and failure isolation, re-baseline after pause/failure,
ring buffer sized from the interval (≤3,600 points/series), 600-series cap, per-series averaged writes every
30 s in one transaction, retention pruning (default 24 h). Queries merge persisted history with the live buffer,
downsample by bucket mean, and report `intervalMs` so charts break lines across gaps. Migration 004 added indexes.

**Platform differences:** Linux has all six providers. Windows/macOS use Node's `os` module for CPU and memory
only (fixture-tested, unverified on Windows); network, disk, battery and temperature metrics are not available there.
