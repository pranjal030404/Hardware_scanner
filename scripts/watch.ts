/**
 * Dev utility: run the real live-monitoring pipeline (udev watcher -> rescan -> diff -> events)
 * headless against this machine and print events as they happen. Use it to verify hotplug:
 *   npm run watch      # then plug / unplug a USB device
 */
import { allCollectors } from '../src/collectors'
import { hostContext } from '../src/collectors/core/context'
import { openDatabase } from '../src/main/database/db'
import { EventRepo } from '../src/main/database/repositories'
import { EventBus } from '../src/main/services/event-bus'
import { InventoryService } from '../src/main/services/inventory'
import { MonitorService, udevWatcherFactory } from '../src/main/services/monitor'

const db = openDatabase(':memory:')
const bus = new EventBus(new EventRepo(db))
const inv = new InventoryService({ db, collectors: allCollectors, makeContext: () => hostContext(), bus, platform: process.platform })
const monitor = new MonitorService(inv, bus, { intervalSec: Number(process.env['HIP_POLL'] ?? 60), debounceMs: 1500 }, process.platform === 'linux' ? udevWatcherFactory : null)

bus.subscribe((e) => {
  if (e.type === 'monitor.status_changed') console.log(`[${e.at}] monitor: ${e.data['mode']}${e.data['degraded'] ? ' (degraded)' : ''} ${e.data['message'] ?? ''}`)
  else if (e.type.startsWith('device.') || e.type === 'collector.failed') console.log(`[${e.at}] ${e.type.padEnd(22)} ${e.summary}${e.data['changes'] ? '  ' + JSON.stringify(e.data['changes']) : ''}`)
})

monitor.start()
console.log('Watching hardware changes (Ctrl+C to stop). Plug or unplug a USB device…')
process.on('SIGINT', () => { monitor.stop(); db.close(); process.exit(0) })
