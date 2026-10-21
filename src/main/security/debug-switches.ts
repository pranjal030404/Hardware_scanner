/**
 * Debugging-endpoint policy, kept free of Electron imports so it is unit-testable.
 *
 * Chromium parses `--remote-debugging-port` natively, BEFORE any JavaScript of ours runs, so the
 * application cannot remove the switch; it can only notice it and refuse to continue. A packaged
 * build therefore exits immediately when such a switch is present (the endpoint may exist for the
 * fraction of a second until `app.exit`), unless the operator explicitly opts in with
 * HIP_ENABLE_DEBUGGING=1 (used by the packaged e2e suite). Unpackaged runs are never restricted.
 * This is a guard against accidental or injected arguments, not a security boundary against a local
 * user who controls the environment of the process.
 */

/** Switches that open a debugging/inspection endpoint or widen who may use one. */
const DEBUG_SWITCH = /^--(remote-debugging-(port|pipe|address)|remote-allow-origins|inspect(-brk|-port|-publish-uid)?|inspect-brk-node|debug(-brk|-port)?)(=|$)/i

export function findDebugSwitches(argv: readonly string[]): string[] {
  return argv.filter((a) => DEBUG_SWITCH.test(a))
}

export interface DebugDecision {
  refuse: boolean
  switches: string[]
  reason: string
}

export function debugDecision(opts: { packaged: boolean; argv: readonly string[]; env: NodeJS.ProcessEnv }): DebugDecision {
  const switches = findDebugSwitches(opts.argv)
  if (!opts.packaged || !switches.length) return { refuse: false, switches, reason: '' }
  if (opts.env['HIP_ENABLE_DEBUGGING'] === '1') return { refuse: false, switches, reason: 'allowed by HIP_ENABLE_DEBUGGING=1' }
  return {
    refuse: true,
    switches,
    reason: `Debugging switches are not accepted by packaged builds (${switches.join(' ')}). Set HIP_ENABLE_DEBUGGING=1 only for local diagnostics.`
  }
}
