// Shared tone -> token map for EventCard.vue, split out so the mapping is
// unit-testable on its own, with no SSR render involved.
//
// Each Record below is EXHAUSTIVE over EventCardTone, the same guarantee
// TASK_EVENT_COMPONENTS holds over TaskEventType (task-event-registry.ts): a
// tone missing an entry fails the build (TS2741) instead of silently
// resolving to nothing. That mechanical guard is the fix for the exact defect
// fiche 15 section 4 documents in the source: an alert-triangle color class
// that was never defined, so the icon quietly inherited the container's
// muted grey and the "anormal" and "routinier" cards became indistinguishable
// by color, leaving only the icon SHAPE to tell them apart.

export type EventCardTone = 'neutral' | 'attention' | 'error' | 'accent'

export const EVENT_CARD_TONES: readonly EventCardTone[] = [
  'neutral',
  'attention',
  'error',
  'accent',
]

/** The state icon's color, per tone (fiche 15 section 3, item 2). */
export const EVENT_CARD_ICON_COLOR: Record<EventCardTone, string> = {
  neutral: 'var(--cs-muted)',
  attention: 'var(--cs-amber-text)',
  error: 'var(--cs-red-text)',
  accent: 'var(--cs-green-text)',
}

/** The card's own border, per tone. */
export const EVENT_CARD_BORDER_COLOR: Record<EventCardTone, string> = {
  neutral: 'var(--cs-line-2)',
  attention: 'var(--cs-amber-line)',
  error: 'var(--cs-red-line)',
  accent: 'var(--cs-green-ring)',
}

/** The card's own background, per tone. */
export const EVENT_CARD_BACKGROUND_COLOR: Record<EventCardTone, string> = {
  neutral: 'var(--cs-surface)',
  attention: 'var(--cs-amber-soft)',
  error: 'var(--cs-red-soft)',
  accent: 'var(--cs-green-soft)',
}
