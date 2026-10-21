import { _electron as electron } from 'playwright-core'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'hip-e2e-'))
const app = await electron.launch({ args: ['.', ...(process.env.NO_SANDBOX ? ['--no-sandbox'] : [])], env: { ...process.env, HIP_DB_PATH: join(dir, 'db.sqlite') }, timeout: 30000 })
const win = await app.firstWindow()
win.on('console', (m) => console.log('[renderer]', m.type(), m.text()))
win.on('pageerror', (e) => console.log('[pageerror]', e.message))
await win.waitForSelector('.sidebar', { timeout: 15000 })
await win.waitForSelector('.stat', { timeout: 30000 })
await win.screenshot({ path: process.env.SHOT ?? '/tmp/overview.png' })
console.log('OK overview', await win.locator('.stat').count(), 'category tiles')
await app.close()
