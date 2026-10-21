import type { Category, CollectorHealth } from '@shared/schemas'

export interface MatrixRow { category: Category; collectors: string[]; coverage: string; tone: 'ok' | 'warn' | 'bad' | 'muted'; devices: number | null; privileged: boolean }

/** One row per category any collector (on any OS) declares. Coverage is derived only from collector health, never assumed. */
export function matrix(health: CollectorHealth[]): MatrixRow[] {
  const cats = [...new Set(health.flatMap((c) => c.categories))].sort()
  return cats.map((category) => {
    const all = health.filter((c) => c.categories.includes(category))
    const here = all.filter((c) => c.status !== 'unsupported')
    const devices = here.some((c) => c.deviceCount !== null) ? here.reduce((n, c) => n + (c.deviceCount ?? 0), 0) : null
    const privileged = here.some((c) => c.status === 'permission_required' || c.limitations.some((l) => l.kind === 'permission'))
    let coverage = 'not collected'
    let tone: MatrixRow['tone'] = 'muted'
    if (here.length) {
      if (here.every((c) => c.status === 'error' || c.status === 'permission_required')) { coverage = here.some((c) => c.status === 'error') ? 'failed' : 'permission needed'; tone = coverage === 'failed' ? 'bad' : 'warn' }
      else if (here.some((c) => c.partial || c.limitations.some((l) => l.kind !== 'info'))) { coverage = 'limited'; tone = 'warn' }
      else if (here.some((c) => c.status === 'available')) { coverage = 'full'; tone = 'ok' }
      else { coverage = 'pending'; tone = 'muted' }
    }
    return { category, collectors: here.map((c) => c.id), coverage, tone, devices, privileged }
  })
}

