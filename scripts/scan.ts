/** Dev utility: run all collectors for this platform against the real host and print a summary. */
import { allCollectors, healthFromOutcome, hostContext, mergeObservations, runCollector } from '../src/collectors'

async function main(): Promise<void> {
const json = process.argv.includes('--json')
const outcomes = await Promise.all(allCollectors.map((c) => runCollector(c, hostContext())))
const merged = mergeObservations(outcomes.flatMap((o) => o.result?.observations ?? []))
if (json) {
  console.log(JSON.stringify({ health: outcomes.map((o) => healthFromOutcome(o, null)), devices: merged }, null, 2))
} else {
  for (const o of outcomes) {
    console.log(
      `${o.status.padEnd(20)} ${o.collector.id.padEnd(18)} ${String(o.result?.observations.length ?? '-').padStart(4)} devices  ${o.durationMs}ms  ${o.message ?? ''}`
    )
    for (const l of o.limitations) console.log(`    [${l.kind}] ${l.message}`)
  }
  const by = new Map<string, number>()
  for (const d of merged) by.set(d.category, (by.get(d.category) ?? 0) + 1)
  console.log('\nTotal merged devices:', merged.length, Object.fromEntries(by))
  if (process.argv.includes('--list')) for (const d of merged) console.log(`${d.category.padEnd(11)} ${d.key.padEnd(48)} ${d.name}`)
}
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
