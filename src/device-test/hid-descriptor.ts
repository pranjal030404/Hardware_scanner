/**
 * Minimal HID report-descriptor parser: enough to find where buttons, X/Y movement and the wheels
 * sit inside each input report, so raw reports captured from /dev/hidraw can be decoded.
 */

export interface HidField {
  reportId: number
  /** Bit offset within the report, excluding the report-ID byte. */
  bit: number
  size: number
  usagePage: number
  usage: number
  signed: boolean
}

export interface HidLayout {
  usesReportIds: boolean
  fields: HidField[]
}

export function parseDescriptor(d: Uint8Array): HidLayout {
  const fields: HidField[] = []
  const offsets = new Map<number, number>()
  let usesReportIds = false
  let g = { usagePage: 0, logicalMin: 0, reportSize: 0, reportCount: 0, reportId: 0 }
  const stack: (typeof g)[] = []
  let usages: number[] = []
  let usageMin: number | null = null
  let usageMax: number | null = null
  const resetLocal = (): void => { usages = []; usageMin = null; usageMax = null }

  for (let i = 0; i < d.length;) {
    const prefix = d[i]!
    if (prefix === 0xfe) { i += 3 + (d[i + 1] ?? 0); continue } // long item
    const sizeCode = prefix & 0x03
    const size = sizeCode === 3 ? 4 : sizeCode
    const type = (prefix >> 2) & 0x03
    const tag = prefix >> 4
    let u = 0
    for (let b = 0; b < size; b++) u |= (d[i + 1 + b] ?? 0) << (8 * b)
    u >>>= 0
    const s = size === 1 ? (u << 24) >> 24 : size === 2 ? (u << 16) >> 16 : u | 0
    i += 1 + size
    if (type === 1) { // global
      if (tag === 0) g.usagePage = u
      else if (tag === 1) g.logicalMin = s
      else if (tag === 7) g.reportSize = u
      else if (tag === 9) g.reportCount = u
      else if (tag === 8) { g.reportId = u; usesReportIds = true }
      else if (tag === 10) stack.push({ ...g })
      else if (tag === 11) g = stack.pop() ?? g
    } else if (type === 2) { // local; a 4-byte usage carries its own page in the high 16 bits
      if (tag === 0) usages.push(u)
      else if (tag === 1) usageMin = u
      else if (tag === 2) usageMax = u
    } else if (type === 0) { // main
      if (tag === 8) { // Input
        const constant = (u & 1) === 1
        const variable = (u & 2) === 2
        const start = offsets.get(g.reportId) ?? 0
        for (let f = 0; f < g.reportCount; f++) {
          let usage: number | undefined
          if (usages.length) usage = usages[Math.min(f, usages.length - 1)]
          else if (usageMin !== null) usage = Math.min(usageMin + f, usageMax ?? usageMin + f)
          if (!constant && variable && usage !== undefined) {
            const page = usage > 0xffff ? usage >>> 16 : g.usagePage
            fields.push({ reportId: g.reportId, bit: start + f * g.reportSize, size: g.reportSize, usagePage: page, usage: usage & 0xffff, signed: g.logicalMin < 0 })
          }
        }
        offsets.set(g.reportId, start + g.reportCount * g.reportSize)
      }
      resetLocal()
    }
  }
  return { usesReportIds, fields }
}

function readBits(data: Uint8Array, bit: number, size: number, signed: boolean): number {
  let v = 0
  for (let k = 0; k < size; k++) {
    const b = bit + k
    if ((data[b >> 3]! >> (b & 7)) & 1) v += 2 ** k
  }
  return signed && size < 32 && v >= 2 ** (size - 1) ? v - 2 ** size : v
}

export interface DecodedReport {
  buttons: number[]
  x: number
  y: number
  wheel: number
  hwheel: number
}

/** Decodes one raw report; null when it holds no pointer fields (e.g. a vendor/HID++ report). */
export function decodeReport(layout: HidLayout, raw: Uint8Array): DecodedReport | null {
  const id = layout.usesReportIds ? raw[0]! : 0
  const body = layout.usesReportIds ? raw.subarray(1) : raw
  const fields = layout.fields.filter((f) => f.reportId === id)
  if (!fields.some((f) => f.usagePage === 0x09 || (f.usagePage === 0x01 && (f.usage === 0x30 || f.usage === 0x31)))) return null
  const out: DecodedReport = { buttons: [], x: 0, y: 0, wheel: 0, hwheel: 0 }
  for (const f of fields) {
    if (f.bit + f.size > body.length * 8) continue
    const v = readBits(body, f.bit, f.size, f.signed)
    if (f.usagePage === 0x09 && v) out.buttons.push(f.usage)
    else if (f.usagePage === 0x01 && f.usage === 0x30) out.x = v
    else if (f.usagePage === 0x01 && f.usage === 0x31) out.y = v
    else if (f.usagePage === 0x01 && f.usage === 0x38) out.wheel = v
    else if (f.usagePage === 0x0c && f.usage === 0x238) out.hwheel = v
  }
  return out
}
