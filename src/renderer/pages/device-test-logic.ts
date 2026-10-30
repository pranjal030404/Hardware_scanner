import type { CheckStatus, InteractiveInfo, LiveState } from '../../device-test/types'

/** Pure logic for the Device test page (no api import, so it runs in vitest). */

export interface LiveFinding {
  status: CheckStatus
  title: string
  detail: string
}

/** Motion counts needed before a direction is ticked off (mouse counts or touchpad units). */
export const MOTION_OK = 40
/** A "hold still" window with more movement than this means the sensor is drifting. */
export const DRIFT_LIMIT = 15

export interface Tile {
  key: string
  label: string
  done: boolean
  bad?: string
  value?: string
}

export function tiles(info: InteractiveInfo, s: LiveState | null): Tile[] {
  const out: Tile[] = []
  if (info.hasMotion) {
    const m = s?.motion
    const travel = s?.touch.travel ?? 0
    if (info.hasTouch && !(m && m.events)) out.push({ key: 'move', label: 'Slide a finger across the pad', done: travel > MOTION_OK * 10, value: s ? `${s.touch.touches} touches` : undefined })
    else {
      out.push({ key: 'left', label: 'Move left', done: (m?.left ?? 0) > MOTION_OK }, { key: 'right', label: 'Move right', done: (m?.right ?? 0) > MOTION_OK })
      out.push({ key: 'up', label: 'Move up', done: (m?.up ?? 0) > MOTION_OK }, { key: 'down', label: 'Move down', done: (m?.down ?? 0) > MOTION_OK })
    }
  }
  for (const name of info.buttons) {
    const b = s?.buttons.find((x) => x.name === name)
    out.push({ key: name, label: `Press ${name.toLowerCase()}`, done: (b?.presses ?? 0) > 0, value: b ? `${b.presses}×` : undefined, bad: b && b.chatter > 0 ? `double-fired ${b.chatter}×` : undefined })
  }
  if (info.hasWheel) out.push({ key: 'wup', label: 'Scroll up', done: (s?.wheel.up ?? 0) > 0, value: s ? `${s.wheel.up}` : undefined }, { key: 'wdown', label: 'Scroll down', done: (s?.wheel.down ?? 0) > 0, value: s ? `${s.wheel.down}` : undefined })
  if (info.hasHWheel) out.push({ key: 'wleft', label: 'Tilt wheel left', done: (s?.wheel.left ?? 0) > 0 }, { key: 'wright', label: 'Tilt wheel right', done: (s?.wheel.right ?? 0) > 0 })
  if (info.hasTouch) out.push({ key: 'two', label: 'Touch with two fingers', done: (s?.touch.maxFingers ?? 0) >= 2 })
  return out
}

/** Turns a hands-on session into findings, worst first. */
export function liveFindings(info: InteractiveInfo, s: LiveState): LiveFinding[] {
  const out: LiveFinding[] = []
  const used = s.events > 0
  if (!used && s.elapsedMs > 8000) {
    out.push({
      status: 'fail', title: 'No signal from the device',
      detail: 'The system sees the device but it sent nothing while you used it. For a wireless mouse or keyboard: the receiver works but the device itself is not reaching it (flat or reversed battery, power switch off, or it needs re-pairing with the receiver). For a wired one: the sensor, switches or internal board have failed.'
    })
  }
  const pressed = s.buttons.some((b) => b.presses > 0) || s.wheel.up + s.wheel.down > 0
  if (info.hasMotion && !info.hasTouch && pressed && s.motion.events === 0 && s.elapsedMs > 5000) {
    out.push({
      status: 'fail', title: 'Buttons work, but no movement is reported',
      detail: 'Clicks reach the computer, so the cable or wireless link, the receiver and the driver all work. The movement sensor underneath is not reporting anything. Check, in this order: (1) the surface: glass, mirrors, glossy or very plain white surfaces defeat optical sensors; try paper or a mouse pad. (2) Dust or hair over the sensor window underneath: clean it with a dry cotton bud. (3) The battery: the sensor needs more power than the buttons, so a weak battery can stop movement first even when the battery reads "Normal"; try a fresh one. (4) Look under the mouse: if it normally shows a red light and now shows none, the sensor or its LED has failed and the mouse needs replacing.'
    })
  }
  for (const b of s.buttons) {
    if (b.chatter >= 3) out.push({ status: 'fail', title: `${b.name} double-clicks by itself`, detail: `It fired twice from a single press ${b.chatter} times. The switch inside is worn out (very common on older mice); it needs a new switch or a new mouse.` })
    else if (b.chatter > 0) out.push({ status: 'warn', title: `${b.name} double-fired`, detail: `Seen ${b.chatter} time(s): a single press registered as two. An early sign of a worn switch; watch whether it gets worse.` })
  }
  for (const k of s.stuck) out.push({ status: 'fail', title: `${k} is stuck down`, detail: 'It reports being held although you are not pressing it. Something is jammed under it, or its switch/membrane is shorted (e.g. after a spill).' })
  if (s.still.phase === 'done') {
    if (s.still.motion > DRIFT_LIMIT) out.push({ status: 'fail', title: 'Pointer drifts on its own', detail: `It reported ${s.still.motion} units of movement while untouched. For a mouse: dirt on the sensor, or a glossy/glass/uneven surface (use a mouse pad). For a pointing stick: the stick is out of calibration (it usually recalibrates if you leave it alone for a few seconds) or worn. For a touchpad: moisture, or a palm resting on it.` })
    else out.push({ status: 'pass', title: 'Holds still', detail: 'No movement was reported while it was untouched.' })
  }
  if (s.dropped > 0) out.push({ status: 'warn', title: 'Events were dropped', detail: `The system's event buffer overflowed ${s.dropped} time(s). Usually the computer was briefly too busy; if it is frequent, the device floods events (a fault or an extreme polling rate).` })
  if (s.maxMotionGapMs !== null && s.maxMotionGapMs > 120) out.push({ status: 'warn', title: 'Movement stutters', detail: `There was a ${s.maxMotionGapMs} ms gap in movement reports while it was moving. For wireless devices: interference or distance from the receiver (move the receiver to a front port or an extension cable, away from USB 3 devices). For wired: a loose cable.` })
  if (s.reportRateHz) out.push({ status: 'info', title: 'Report rate', detail: `About ${s.reportRateHz} reports per second while moving.` })
  const pending = tiles(info, s).filter((t) => !t.done).map((t) => t.label.toLowerCase())
  if (used && pending.length) out.push({ status: 'info', title: 'Not tried yet', detail: `Not seen yet: ${pending.join(', ')}. If you tried and it did not register, that part is not working.` })
  if (info.isKeyboard && used && s.untried.length) out.push({ status: 'info', title: `${s.untried.length} keys not pressed yet`, detail: `${s.untried.slice(0, 40).join(' ')}${s.untried.length > 40 ? ' …' : ''}. Any key you pressed that does not appear here is the faulty one.` })
  const rank: Record<CheckStatus, number> = { fail: 0, warn: 1, pass: 2, info: 3, skip: 4 }
  return out.sort((a, b) => rank[a.status] - rank[b.status])
}
