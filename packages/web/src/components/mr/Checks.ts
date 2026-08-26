// Shared vocabulary for ForgeCheckRollup, consumed by both MrCard (dense
// tally) and MrMetaRail (auto-review section) so the bucket order and the
// truncated-rollup fallback are defined once.

import type { ForgeCheckRollup } from '../../types'

/** Fixed rendering order for the four buckets, mirrors ForgeCheckRollup's own field order. */
export const CHECK_BUCKETS = ['passed', 'failed', 'pending', 'skipped'] as const

export type CheckBucket = (typeof CHECK_BUCKETS)[number]

export type CheckAggregateStatus = CheckBucket | 'unknown'

/**
 * Collapses a TRUNCATED rollup into one status, in order of urgency. The four
 * counts are a floor, not a total, so nothing here reports a number, only
 * "at least one X exists" survives, and only the most urgent X.
 */
export function aggregateCheckStatus(checks: ForgeCheckRollup): CheckAggregateStatus {
  if (checks.failed > 0) {
    return 'failed'
  }
  if (checks.pending > 0) {
    return 'pending'
  }
  if (checks.passed > 0) {
    return 'passed'
  }
  if (checks.skipped > 0) {
    return 'skipped'
  }
  return 'unknown'
}
