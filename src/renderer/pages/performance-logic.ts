import type { ControlStatus, ItemVerification, PerfControl, PresetChange, TxStatus } from '../../performance/types'

/** Pure helpers for the Performance Tuning page (no api import, so they run in vitest). */

export const CONTROL_STATUS: Record<ControlStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'muted' }> = {
  supported: { label: 'Writable · verified', tone: 'ok' },
  not_verified: { label: 'Writable · unverified', tone: 'info' },
  permission_required: { label: 'Helper required', tone: 'warn' },
  unavailable: { label: 'Read-only', tone: 'muted' },
  unsupported: { label: 'Not supported', tone: 'muted' },
  error: { label: 'Error', tone: 'bad' }
}

export const TX_STATUS: Record<TxStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'muted' }> = {
  running: { label: 'In progress', tone: 'info' },
  verified: { label: 'Applied and verified', tone: 'ok' },
  partially_verified: { label: 'Partially verified', tone: 'warn' },
  mismatch: { label: 'Values differ from request', tone: 'bad' },
  failed: { label: 'Not applied', tone: 'bad' },
  rolled_back: { label: 'Failed; restored', tone: 'warn' },
  rollback_failed: { label: 'Failed; not fully restored', tone: 'bad' },
  unverifiable: { label: 'Applied; not verifiable', tone: 'warn' }
}

export const ITEM_STATUS: Record<ItemVerification, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'muted' }> = {
  pending: { label: 'Pending', tone: 'info' },
  verified: { label: 'Verified', tone: 'ok' },
  mismatch: { label: 'Mismatch', tone: 'bad' },
  unverifiable: { label: 'Not verifiable', tone: 'warn' },
  not_applied: { label: 'Not applied', tone: 'muted' },
  rolled_back: { label: 'Restored', tone: 'warn' },
  rollback_failed: { label: 'Not restored', tone: 'bad' }
}

/** Numeric controls show their value in display units (e.g. GHz, W); everything else is the raw token. */
export const isNumeric = (c: PerfControl): boolean => c.min !== undefined && c.max !== undefined && !c.options
export const isToggle = (c: PerfControl): boolean => !!c.options && c.options.length === 2 && c.options.includes('1') && c.options.includes('0')

export function toDisplay(c: PerfControl, raw: string | null): string {
  if (raw === null) return ''
  if (!isNumeric(c)) return raw
  const v = raw === 'max' ? c.max! : raw === 'min' ? c.min! : Number(raw)
  const d = v / (c.scale ?? 1)
  return String(Math.round(d * 100) / 100)
}

/** Display value → raw token, snapped to the control's step and clamped to its range. Null when it is not a number. */
export function toRaw(c: PerfControl, shown: string): string | null {
  if (!isNumeric(c)) return shown
  const n = Number(shown)
  if (!Number.isFinite(n) || shown.trim() === '') return null
  const step = c.step ?? 1
  const raw = Math.min(c.max!, Math.max(c.min!, Math.round((n * (c.scale ?? 1)) / step) * step))
  return String(raw)
}

/** Edits that differ from the current value, as a reviewable list. */
export function pendingChanges(controls: PerfControl[], edits: Record<string, string>): PresetChange[] {
  const out: PresetChange[] = []
  for (const c of controls) {
    const raw = edits[c.id]
    if (raw === undefined || !c.write) continue
    const same = raw === c.currentRaw || (isNumeric(c) && c.currentRaw !== null && toDisplay(c, raw) === toDisplay(c, c.currentRaw))
    if (same) continue
    const unit = isNumeric(c) ? ` ${c.unit ?? ''}` : ''
    const fmt = (v: string | null): string => (v === null ? 'unknown' : isToggle(c) ? (v === '1' ? 'on' : 'off') : `${toDisplay(c, v)}${unit}`)
    const raised = isNumeric(c) && c.currentRaw !== null && Number(raw) > Number(c.currentRaw === 'max' ? c.max : c.currentRaw === 'min' ? c.min : c.currentRaw)
    out.push({ id: c.id, label: c.label, from: fmt(c.currentRaw), to: fmt(raw), raw, risk: c.risk === 'medium' && raised ? 'high' : c.risk })
  }
  return out
}

/** A review step is required for high-risk changes, and for everything when the user asked to confirm every change. */
export const needsReview = (changes: PresetChange[], confirmAll: boolean): boolean => confirmAll || changes.some((c) => c.risk === 'high')
