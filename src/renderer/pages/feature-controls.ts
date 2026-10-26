/** Pure helpers for the Settings "Features & controls" section (kept free of the api module for tests). */

/** Returns a new "disabled ids" list with `id` switched on or off; order is kept stable. */
export function setEnabled(disabled: readonly string[], id: string, enabled: boolean): string[] {
  const rest = disabled.filter((x) => x !== id)
  return enabled ? rest : [...rest, id]
}

/** Switches every id in `ids` on or off, leaving unrelated entries in `disabled` untouched. */
export function setAllEnabled(disabled: readonly string[], ids: readonly string[], enabled: boolean): string[] {
  const group = new Set(ids)
  const rest = disabled.filter((x) => !group.has(x))
  return enabled ? rest : [...rest, ...ids]
}

export function countEnabled(disabled: readonly string[], ids: readonly string[]): number {
  const off = new Set(disabled)
  return ids.filter((id) => !off.has(id)).length
}
