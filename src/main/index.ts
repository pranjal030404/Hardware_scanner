import { app } from 'electron'
import { startApp } from './lifecycle/app'
import { debugDecision } from './security/debug-switches'

// Packaged builds refuse debugging switches (see security/debug-switches.ts for the limits of this).
const debug = debugDecision({ packaged: app.isPackaged, argv: process.argv.slice(1), env: process.env })
if (debug.refuse) {
  console.error(debug.reason)
  app.exit(2)
} else if (!app.requestSingleInstanceLock()) {
  // Single instance: two processes would fight over the SQLite database.
  app.quit()
} else {
  void startApp().catch((e) => {
    console.error('Fatal startup error', e)
    app.exit(1)
  })
}
