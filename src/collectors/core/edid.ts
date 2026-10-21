export interface EdidInfo {
  manufacturerId: string
  productCode: number
  serialNumber?: number
  week?: number
  year?: number
  widthCm?: number
  heightCm?: number
  name?: string
  serialText?: string
  version: string
  preferredMode?: { width: number; height: number; refreshHz: number }
}

const HEADER = Buffer.from([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00])

/** Parse the base EDID block. Returns undefined for anything that is not a valid EDID. */
export function parseEdid(buf: Buffer | undefined): EdidInfo | undefined {
  if (!buf || buf.length < 128 || !buf.subarray(0, 8).equals(HEADER)) return undefined
  let sum = 0
  for (let i = 0; i < 128; i++) sum = (sum + buf[i]!) & 0xff
  if (sum !== 0) return undefined
  const m = (buf[8]! << 8) | buf[9]!
  const manufacturerId = [(m >> 10) & 0x1f, (m >> 5) & 0x1f, m & 0x1f].map((c) => String.fromCharCode(64 + c)).join('')
  const info: EdidInfo = {
    manufacturerId,
    productCode: buf.readUInt16LE(10),
    version: `${buf[18]}.${buf[19]}`
  }
  const sn = buf.readUInt32LE(12)
  if (sn) info.serialNumber = sn
  if (buf[16]! > 0 && buf[16]! < 55) info.week = buf[16]
  if (buf[17]! > 0) info.year = 1990 + buf[17]!
  if (buf[21]! && buf[22]!) {
    info.widthCm = buf[21]
    info.heightCm = buf[22]
  }
  for (let off = 54; off < 126; off += 18) {
    const d = buf.subarray(off, off + 18)
    if (d[0] === 0 && d[1] === 0 && d[2] === 0) {
      const text = d.subarray(5, 18).toString('latin1').split('\n')[0]!.trim()
      if (d[3] === 0xfc && text) info.name = text
      if (d[3] === 0xff && text) info.serialText = text
    } else if (off === 54) {
      // First detailed timing descriptor is the preferred mode.
      const pixClockKHz = (d[0]! | (d[1]! << 8)) * 10
      const hActive = d[2]! | ((d[4]! & 0xf0) << 4)
      const hBlank = d[3]! | ((d[4]! & 0x0f) << 8)
      const vActive = d[5]! | ((d[7]! & 0xf0) << 4)
      const vBlank = d[6]! | ((d[7]! & 0x0f) << 8)
      const total = (hActive + hBlank) * (vActive + vBlank)
      if (total > 0 && pixClockKHz > 0) {
        info.preferredMode = { width: hActive, height: vActive, refreshHz: Math.round((pixClockKHz * 1000) / total * 100) / 100 }
      }
    }
  }
  return info
}
