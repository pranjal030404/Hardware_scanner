# Collectors

Each collector declares `id`, `version`, `platforms`, `categories`, `permissions`, `method`,
`timeoutMs`, `retries` and implements `isSupported(ctx)` / `collect(ctx)`. The runner adds the timeout,
retry, schema validation and status mapping; health (`getHealth` equivalent) is computed from the last
run and persisted in `collector_runs`.

## Statuses

`available` · `unavailable` · `unsupported` · `permission_required` · `stale` · `not_scanned` · `error`

- `unsupported`: wrong platform, or the required kernel interface does not exist here.
- `unavailable`: interface exists but nothing could be inspected (e.g. tool missing).
- `permission_required`: nothing useful could be read because of permissions.
- `available` + *partial*: some data was readable, the rest is listed as limitations.
- `error`: threw, timed out, or returned schema-invalid output. **No result is produced** — never an empty inventory.
- `stale`: computed at read time when the last success is older than 5× the safety-rescan interval.

## Linux collectors

| ID | Source | Notes / limits |
|---|---|---|
| `linux.system` | `/sys/class/dmi/id`, `/proc`, `/etc/os-release` | OEM placeholder strings ("To Be Filled By O.E.M.") are dropped. Serials/UUID intentionally not read. |
| `linux.cpu` | `/proc/cpuinfo`, cpufreq | One record per physical package; no temperatures here (see sensors). |
| `linux.memory` | `/proc/meminfo`, SMBIOS type 17 | Module details need root → reported as a permission limitation. |
| `linux.pci` | `/sys/bus/pci/devices`, `pci.ids` | Names via ID database (evidence `database_lookup`); bridge hierarchy from the sysfs path. |
| `linux.usb` | `/sys/bus/usb/devices`, `usb.ids` | Hub hierarchy from the sysfs path; subtype from device/interface class. |
| `linux.input` | `/proc/bus/input/devices` | Classification from kernel handlers + capability bits; bus type reported, never assumed USB. |
| `linux.video` | `/sys/class/video4linux` | Nodes collapsed per physical camera. |
| `linux.network` | `/sys/class/net`, `os.networkInterfaces()` | MAC and IPs flagged sensitive; counters volatile. |
| `linux.bluetooth` | `/sys/class/bluetooth`, `bluetoothctl` | Paired devices need BlueZ; attachment to the adapter is *inferred*. |
| `linux.storage` | `/sys/block`, `/proc/self/mounts`, `statfs` | Disks and partitions; identity prefers WWID. |
| `linux.smart` | `smartctl --json -a` | Needs root; otherwise `permission_required`. *Supplementary*: enriches disks found by `linux.storage` in the same scan and can never create/replace a device. |
| `linux.display` | `/sys/class/drm` + EDID | Connected connectors only; active mode/refresh are compositor state and not available. |
| `linux.audio` | `/proc/asound/cards` | ALSA cards only; PipeWire/PulseAudio endpoints not collected yet. |
| `linux.power` | `/sys/class/power_supply` | Battery health derived from full/design capacity (evidence `derived`). |
| `linux.sensors` | `/sys/class/hwmon` | Thresholds are those reported by the sensor driver; the app sets none. |
| `linux.serial` | `/sys/class/tty` | Passive; never writes to a port. |

## Windows collectors — fixture-tested only

`windows.system` (CIM), `windows.pnp` (Get-PnpDevice + DEVPKEY_Device_Parent), `windows.network`
(Get-NetAdapter), `windows.storage` (Get-PhysicalDisk). Scripts are constant strings executed with an
argument vector (no shell interpolation). **None has been executed on Windows.** SetupAPI/CfgMgr32
hierarchy, volumes/SMART, displays/EDID, audio endpoints, Bluetooth and `WM_DEVICECHANGE` notifications
are planned (see ROADMAP).

## Writing a collector

1. Read only through `ctx.reader` (files) or `ctx.run` (argument-vector commands).
2. Build observations with `ObservationBuilder` so every field/property carries source + evidence.
3. Mark counters/readings `volatile`, serials/MACs/IPs `sensitive`.
4. Return through `finish()` so denied paths become limitations.
5. Add a fixture test covering: normal, missing interface, denied permission, malformed input.

## Micro-level inspection: platform support (added 2026-10-21)

| Field / capability | Linux | Windows |
|---|---|---|
| PCIe AER error counts, upstream-port link capability | `/sys/bus/pci/devices/*/aer_dev_*`, parent `max_link_*` ✅ | not implemented |
| USB endpoints, bcdDevice, port over-current | sysfs ✅ | not implemented (PnP only) |
| NVMe controller state | `/sys/class/nvme/*/state` ✅ | not implemented |
| GPU clock / busy / VRAM | DRM sysfs (i915/xe clock; amdgpu busy+VRAM) ✅ Intel, ❓ AMD | driver + mode only (`windows.hardware`, ❓ unrun); no live clock |
| Memory ECC | EDAC counters (if driver present) | `MemoryErrorCorrection` type only (❓) |
| Thermal | hwmon (labelled/unlabelled) ✅ | ACPI zones, admin, not CPU die temp (❓) |
| I²C/SMBus | passive sysfs listing ✅ | not implemented |
| Process list | opt-in `/proc` ✅ | not implemented |
