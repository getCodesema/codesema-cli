import type { NarrativeStep } from '../types'
import type { Finding, FindingSeverity } from './useDiff'

/** Traffic-light tone of a rail step: red (high), orange (medium), green (low). */
export type StepTone = 'high' | 'medium' | 'low'

const TONE_BY_SEVERITY: Partial<Record<FindingSeverity, StepTone>> = {
  critical: 'high',
  major: 'high',
  minor: 'medium',
}

export function findingTone(finding: Finding): StepTone | null {
  if (finding.kind === 'praise' || finding.kind === 'why') {
    return null
  }
  return TONE_BY_SEVERITY[finding.severity] ?? null
}

/** Worst tone among the step's referenced findings; falls back to the step risk. */
export function stepTone(
  step: Pick<NarrativeStep, 'finding_refs'> & { risk?: string },
  findings: Finding[],
): StepTone {
  let worst: StepTone | null = null
  for (const ref of step.finding_refs) {
    const referenced = findings[ref]
    if (!referenced) {
      continue
    }
    const tone = findingTone(referenced)
    if (tone === 'high') {
      return 'high'
    }
    if (tone === 'medium') {
      worst = 'medium'
    }
  }
  if (worst) {
    return worst
  }
  if (step.risk === 'high' || step.risk === 'medium') {
    return step.risk
  }
  return 'low'
}
