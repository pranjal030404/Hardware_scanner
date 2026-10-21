/**
 * Parser for the `pci.ids` / `usb.ids` databases (hwdata). Names from these databases are
 * `database_lookup` evidence: they map IDs to names, they are not read from the device.
 */
export interface IdDatabase {
  vendor(id: string): string | undefined
  device(vendorId: string, deviceId: string): string | undefined
  /** PCI class lookup: pass 2, 4 or 6 hex chars (class, subclass, prog-if) */
  className(code: string): string | undefined
}

export function parseIds(text: string): IdDatabase {
  const vendors = new Map<string, string>()
  const devices = new Map<string, string>()
  const classes = new Map<string, string>()
  let vendor: string | undefined
  let cls: string | undefined
  let sub: string | undefined
  let inClasses = false
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    if (/^C [0-9a-f]{2}\s/i.test(line)) {
      inClasses = true
      cls = line.slice(2, 4).toLowerCase()
      classes.set(cls, line.slice(6).trim())
      continue
    }
    if (inClasses) {
      if (!line.startsWith('\t')) {
        // next top-level block (e.g. other sections) ends class parsing
        if (!/^C /.test(line)) inClasses = false
        continue
      }
      const m = /^\t([0-9a-f]{2})\s+(.*)$/i.exec(line)
      if (m && !line.startsWith('\t\t')) {
        sub = m[1]!.toLowerCase()
        classes.set(`${cls}${sub}`, m[2]!.trim())
      } else {
        const m2 = /^\t\t([0-9a-f]{2})\s+(.*)$/i.exec(line)
        if (m2) classes.set(`${cls}${sub}${m2[1]!.toLowerCase()}`, m2[2]!.trim())
      }
      continue
    }
    if (!line.startsWith('\t')) {
      const m = /^([0-9a-f]{4})\s+(.*)$/i.exec(line)
      if (m) {
        vendor = m[1]!.toLowerCase()
        vendors.set(vendor, m[2]!.trim())
      } else vendor = undefined
    } else if (!line.startsWith('\t\t') && vendor) {
      const m = /^\t([0-9a-f]{4})\s+(.*)$/i.exec(line)
      if (m) devices.set(`${vendor}:${m[1]!.toLowerCase()}`, m[2]!.trim())
    }
  }
  return {
    vendor: (id) => vendors.get(id.toLowerCase()),
    device: (v, d) => devices.get(`${v.toLowerCase()}:${d.toLowerCase()}`),
    className: (c) => classes.get(c.toLowerCase())
  }
}

export const emptyIds: IdDatabase = { vendor: () => undefined, device: () => undefined, className: () => undefined }
