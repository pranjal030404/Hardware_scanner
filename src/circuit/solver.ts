/** Solve G·v = i by Gaussian elimination with partial pivoting. Matrices here are small (one row per net). */
export function solveLinear(g: number[][], i: number[]): number[] {
  const n = i.length
  const a = g.map((row, r) => [...row, i[r]!])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r
    if (Math.abs(a[p]![c]!) < 1e-18) continue
    ;[a[c], a[p]] = [a[p]!, a[c]!]
    const piv = a[c]![c]!
    for (let r = c + 1; r < n; r++) {
      const f = a[r]![c]! / piv
      if (f === 0) continue
      for (let k = c; k <= n; k++) a[r]![k]! -= f * a[c]![k]!
    }
  }
  const v = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = a[r]![n]!
    for (let k = r + 1; k < n; k++) s -= a[r]![k]! * v[k]!
    const d = a[r]![r]!
    v[r] = Math.abs(d) < 1e-18 ? 0 : s / d
  }
  return v
}
