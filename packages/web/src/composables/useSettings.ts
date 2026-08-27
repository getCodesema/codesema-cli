// The three global brain-loop settings (packages/cli/src/config.ts:
// brainAutoMerge, mergeStrategy, maxTaskTurns), read and written through
// GET/PUT /api/settings. Pure parsing and validation live here so they stay
// testable without mounting RepoSettings.vue; the fetches themselves stay in
// the component, same split as useChecks.ts.

export type MergeStrategy = 'merge' | 'squash' | 'rebase'

export type BrainSettings = {
  brainAutoMerge: boolean
  /** Undefined is a real, honest state here: the forge applies its own
   * default merge strategy when none was ever configured (config.ts D13). */
  mergeStrategy: MergeStrategy | undefined
  maxTaskTurns: number
}

const MERGE_STRATEGIES: ReadonlySet<string> = new Set(['merge', 'squash', 'rebase'])

export function isMergeStrategyOption(value: string): value is MergeStrategy {
  return MERGE_STRATEGIES.has(value)
}

/**
 * Tolerant parse of GET/PUT /api/settings. Each field is a `{ value, raw }`
 * pair server-side; only `value` — the resolved, effective setting — is what
 * this panel edits. A missing or malformed field degrades to the same
 * default the server's own resolveXxx would apply, never a crash: the same
 * whitelist-and-fallback doctrine `config.ts` documents for itself.
 */
export function parseSettingsSnapshot(raw: unknown): BrainSettings {
  const body = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}

  const brainAutoMergeValue = (body.brainAutoMerge as { value?: unknown } | undefined)?.value
  const brainAutoMerge = typeof brainAutoMergeValue === 'boolean' ? brainAutoMergeValue : true

  const mergeStrategyValue = (body.mergeStrategy as { value?: unknown } | undefined)?.value
  const mergeStrategy =
    typeof mergeStrategyValue === 'string' && isMergeStrategyOption(mergeStrategyValue)
      ? mergeStrategyValue
      : undefined

  const maxTaskTurnsValue = (body.maxTaskTurns as { value?: unknown } | undefined)?.value
  const maxTaskTurns =
    typeof maxTaskTurnsValue === 'number' &&
    Number.isInteger(maxTaskTurnsValue) &&
    maxTaskTurnsValue >= 1
      ? maxTaskTurnsValue
      : 30

  return { brainAutoMerge, mergeStrategy, maxTaskTurns }
}
