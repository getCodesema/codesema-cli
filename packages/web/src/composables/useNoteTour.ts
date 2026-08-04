import type { NarrativeStep } from '../types'

/** One position of the guided reading: the step itself, or one of its notes. */
export type TourStop = {
  stepIndex: number
  /** Global finding index, or null for the stop that lands on the step itself. */
  findingId: number | null
}

export function buildNoteTour(
  steps: Pick<NarrativeStep, 'finding_refs'>[],
  findingCount: number,
): TourStop[] {
  const tour: TourStop[] = []
  steps.forEach((step, stepIndex) => {
    tour.push({ stepIndex, findingId: null })
    const seen = new Set<number>()
    for (const ref of step.finding_refs) {
      if (ref < 0 || ref >= findingCount || seen.has(ref)) {
        continue
      }
      seen.add(ref)
      tour.push({ stepIndex, findingId: ref })
    }
  })
  return tour
}
