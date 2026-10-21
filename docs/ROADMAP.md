# Roadmap

Order follows the product priority: accurate detection → normalized inventory → live events → verified
topology → monitoring/diagnostics → integrations → advanced visualisation → optional AI.

## Next (highest priority)
1. **Diagnostics engine**: deterministic rules with evidence/severity/resolution (device vanished + corroboration,
   permission gaps, storage nearly full, SMART warning, interface down, OS device error, stale inventory),
   findings UI with dismiss/resolve.
2. **Snapshots and comparison**: save/diff inventories, flagging differences that could be caused by
   incomplete collection (a collector that was partial/denied in either snapshot).
3. **Live monitor**: metric collectors (CPU, memory, disk, network, battery, hwmon temps/fans) with bounded
   `metric_samples` retention and charts with real units/timestamps.

## Then
- Windows: validate on real machines; native helper (SetupAPI/CfgMgr32) for hierarchy and arrival/removal;
  volumes/SMART, displays/EDID, audio endpoints, Bluetooth.
- Linux: PipeWire/PulseAudio endpoints, NVMe/SATA SMART without root (documented udev/smartd path), ACPI/thermal zones.
- Packaging: build and test AppImage + NSIS, icons, version metadata, upgrade path.
- Support bundle export; DB deletion controls; OS keychain for integration secrets.
- Integrations (opt-in): MQTT/Home Assistant/ESPHome/Tasmota with connection tests; scoped, rate-limited discovery.
- Rule packs; collector plugin API.
- Educational 3D explorer (clearly labelled illustrative where geometry is not sourced).
- Optional AI assistant over the real inventory with source references (provider-independent, off by default).
