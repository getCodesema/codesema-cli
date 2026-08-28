// The shared ticket state machine (recovery doctrine, rule 3): the legal
// transitions live HERE, and both sides refuse one that is not in the table —
// the hub before writing `tickets.status`, the runner before reporting a
// transition. A refused transition is an explicit error, never a silently
// accepted phantom state.

import { ARM_TICKET_STATUSES, type ArmTicketStatus, type ArmTransitionType } from './arm.js'

export type TicketTransition = { from: ArmTicketStatus; to: ArmTicketStatus }

/**
 * Every legal `tickets.status` transition, transcribed from the hub's real
 * write sites (each row names its writers). Creation (∅ → `proposed`) is an
 * insert, not a transition, so it is not listed. `proposed → rejected` has no
 * writer yet: it is product law (a human rejecting a proposal), declared so
 * the day the dashboard ships it the table does not refuse it.
 *
 * The `mr_opened → mr_opened` self-loop is a real fact, not a replay: the
 * arm re-ships after a `request_changes` verdict and re-reports `mr_opened`
 * under a new idempotency key. No other self-loop is legal — a
 * `review_result` that does not approve changes NO status and therefore is
 * not a transition at all (see `targetTicketStatus`).
 */
export const TICKET_TRANSITIONS: readonly TicketTransition[] = [
  { from: 'proposed', to: 'published' },
  { from: 'proposed', to: 'rejected' },
  { from: 'published', to: 'in_progress' },
  { from: 'in_progress', to: 'published' },
  { from: 'in_progress', to: 'mr_opened' },
  { from: 'in_progress', to: 'already_implemented' },
  { from: 'in_progress', to: 'failed' },
  { from: 'in_progress', to: 'done' },
  { from: 'mr_opened', to: 'mr_opened' },
  { from: 'mr_opened', to: 'ready_to_merge' },
  { from: 'mr_opened', to: 'failed' },
  { from: 'mr_opened', to: 'done' },
  { from: 'ready_to_merge', to: 'mr_opened' },
  { from: 'ready_to_merge', to: 'done' },
  { from: 'ready_to_merge', to: 'failed' },
  { from: 'failed', to: 'in_progress' },
  { from: 'failed', to: 'published' },
  { from: 'done', to: 'mr_opened' },
]

const TRANSITIONS_BY_FROM: ReadonlyMap<ArmTicketStatus, ReadonlySet<ArmTicketStatus>> = (() => {
  const byFrom = new Map<ArmTicketStatus, Set<ArmTicketStatus>>()
  for (const { from, to } of TICKET_TRANSITIONS) {
    const set = byFrom.get(from) ?? new Set<ArmTicketStatus>()
    set.add(to)
    byFrom.set(from, set)
  }
  return byFrom
})()

export function isLegalTicketTransition(from: ArmTicketStatus, to: ArmTicketStatus): boolean {
  return TRANSITIONS_BY_FROM.get(from)?.has(to) ?? false
}

/**
 * Derived, never hand-written: a status is terminal exactly when the table
 * gives it no way out. Hand-listing them beside the table would be a second
 * spelling of the same fact, free to drift.
 */
export const TICKET_TERMINAL_STATUSES: ReadonlySet<ArmTicketStatus> = new Set(
  [...ARM_TICKET_STATUSES].filter((status) => !TRANSITIONS_BY_FROM.has(status)),
)

/**
 * The status an `ArmTransition` type claims to move the ticket to, or `null`
 * when the report is not a status transition at all: a `review_result` whose
 * verdict is not `approve` is journaled by the hub without touching
 * `tickets.status`, so there is nothing to validate against the table.
 */
export function targetTicketStatus(
  type: ArmTransitionType,
  verdict?: 'approve' | 'request_changes' | 'comment',
): ArmTicketStatus | null {
  if (type === 'mr_opened') {
    return 'mr_opened'
  }
  if (type === 'merged') {
    return 'done'
  }
  if (type === 'failed') {
    return 'failed'
  }
  return verdict === 'approve' ? 'ready_to_merge' : null
}
