// Shared tone -> semantic tone map for EventCard.vue, split out so the
// mapping is unit-testable on its own, with no SSR render involved.
//
// The Record below is EXHAUSTIVE over EventCardTone, the same guarantee
// TASK_EVENT_COMPONENTS holds over TaskEventType (task-event-registry.ts): a
// tone missing an entry fails the build (TS2741) instead of silently
// resolving to nothing. That mechanical guard is the fix for the exact defect
// fiche 15 section 4 documents in the source: an alert-triangle color class
// that was never defined, so the icon quietly inherited the container's
// muted grey and the "anormal" and "routinier" cards became indistinguishable
// by color, leaving only the icon SHAPE to tell them apart.

import type { StatusTone } from '../../execution-status'

export type EventCardTone = 'neutral' | 'attention' | 'error' | 'accent'

export const EVENT_CARD_TONES: readonly EventCardTone[] = [
  'neutral',
  'attention',
  'error',
  'accent',
]

/** The `data-tone` the card renders, read by kit.css through `--tone`. */
export const EVENT_CARD_DATA_TONE: Record<EventCardTone, StatusTone> = {
  neutral: 'idle',
  attention: 'warn',
  error: 'err',
  accent: 'ok',
}
