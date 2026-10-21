/** Minimal Chrome DevTools Protocol client (Node >= 22 global WebSocket); no dependencies. */
import { writeFileSync } from 'node:fs'

export async function connect(port = 9333) {
  // Attach only to the real application page. Right after launch the target list can briefly contain a
  // blank/transient page; a socket opened on it later errors out, which looked like a random hang.
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const page = targets.find((t) => t.type === 'page' && /^(hip-app:|file:|http:\/\/localhost)/.test(t.url))
  if (!page) throw new Error(`no application page target yet (targets: ${targets.map((t) => `${t.type}:${t.url.slice(0, 40)}`).join(', ') || 'none'})`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  const consoleLog = []
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result) }
    else if (msg.method === 'Runtime.consoleAPICalled') consoleLog.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`)
    else if (msg.method === 'Runtime.exceptionThrown') consoleLog.push(`EXCEPTION: ${msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text}`)
  }
  // Every command is time-bounded and every pending command is rejected when the socket closes, so a
  // navigation, renderer crash or app exit surfaces as a diagnostic error instead of a hung await
  // (the cause of the earlier "unsettled top-level await" abort in the navigation-block check).
  let closedReason = null
  const failAll = (why) => { closedReason ??= why; for (const [i, p] of pending) { pending.delete(i); p.rej(new Error(`CDP connection ${why} while waiting for a response`)) } }
  ws.onclose = (e) => failAll(`closed (code ${e.code})`)
  ws.onerror = () => failAll('errored')
  const send = (method, params = {}, timeoutMs = 15000) => new Promise((res, rej) => {
    if (closedReason) return rej(new Error(`CDP connection already ${closedReason}; cannot send ${method}`))
    const i = ++id
    const timer = setTimeout(() => { pending.delete(i); rej(new Error(`CDP ${method} timed out after ${timeoutMs}ms${params.expression ? `: ${String(params.expression).slice(0, 120)}` : ''}`)) }, timeoutMs)
    pending.set(i, { res: (v) => { clearTimeout(timer); res(v) }, rej: (e) => { clearTimeout(timer); rej(e) } })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  await send('Runtime.enable'); await send('Page.enable')
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  const waitFor = async (expression, timeout = 20000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) { try { const v = await evaluate(expression); if (v) return v } catch { /* retry */ } await new Promise((r) => setTimeout(r, 200)) }
    throw new Error(`timeout waiting for: ${expression}`)
  }
  const screenshot = async (path) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(path, Buffer.from(r.data, 'base64')) }
  const click = (selector, text) => evaluate(`(() => { const els = [...document.querySelectorAll(${JSON.stringify(selector)})]; const el = ${text ? `els.find(e => e.textContent.includes(${JSON.stringify(text)}))` : 'els[0]'}; if (!el) return false; el.click(); return true })()`)
  return { send, evaluate, waitFor, screenshot, click, consoleLog, isClosed: () => closedReason, close: () => ws.close() }
}

/** Ask the browser process to exit cleanly (triggers Electron's normal before-quit path). */
export async function closeBrowser(port) {
  const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  const ws = new WebSocket(v.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  ws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  await new Promise((r) => setTimeout(r, 300))
}
