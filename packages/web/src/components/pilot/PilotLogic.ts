// Pure state math of the pilot workspace: where the machine-produced blocks
// anchor in the chat thread, and the conversation ordering (human-blocked
// first). Split out, same doctrine as ComposerLogic.ts / ForgeLogic.ts:
// PilotView.vue only composes these functions.

import { compareByActivity } from '../../composables/useTaskBoard'
import type { TaskState } from '../../composables/useTasks'
import { EXECUTION_STATUS } from '../../execution-status'
import type { TaskEvent, TaskEventType } from '../../types'

// ── Thread blocks (the four machine-produced blocks, anchored in the chat) ─

export type ThreadBlockKind = 'criteria' | 'checks' | 'evidence' | 'recap'

export const THREAD_BLOCK_ORDER: readonly ThreadBlockKind[] = [
  'criteria',
  'checks',
  'evidence',
  'recap',
]

export type ThreadBlockAnchors = {
  /** Blocks to render right after the event carrying this seq, in order. */
  after: ReadonlyMap<number, readonly ThreadBlockKind[]>
  /** Blocks with no event to hang on: rendered after the last event, in order. */
  trailing: readonly ThreadBlockKind[]
}

type AnchorRule = { last: readonly TaskEventType[]; first: readonly TaskEventType[] }

const ANCHOR_RULES: Record<ThreadBlockKind, AnchorRule> = {
  criteria: { last: ['criteria'], first: ['turn_started'] },
  checks: { last: ['checks', 'commit'], first: [] },
  evidence: { last: ['proof', 'checks', 'commit'], first: [] },
  recap: { last: ['message'], first: [] },
}

function lastSeqOf(events: readonly TaskEvent[], type: TaskEventType): number | null {
  return events.findLast((event) => event.type === type)?.seq ?? null
}

function firstSeqOf(events: readonly TaskEvent[], type: TaskEventType): number | null {
  return events.find((event) => event.type === type)?.seq ?? null
}

function anchorSeq(events: readonly TaskEvent[], rule: AnchorRule): number | null {
  for (const type of rule.last) {
    const seq = lastSeqOf(events, type)
    if (seq !== null) {
      return seq
    }
  }
  for (const type of rule.first) {
    const seq = firstSeqOf(events, type)
    if (seq !== null) {
      return seq
    }
  }
  return null
}

/**
 * Where each of the four blocks sits in the chat: criteria right after the
 * event that fixed them (else the first prompt), checks and evidence after
 * the run that produced them, the recap after the agent's last reply. A
 * block whose anchor event is not in the journal trails the thread; the
 * blocks never disappear, only their position moves with the journal.
 */
export function anchorThreadBlocks(events: readonly TaskEvent[]): ThreadBlockAnchors {
  const after = new Map<number, ThreadBlockKind[]>()
  const trailing: ThreadBlockKind[] = []
  for (const kind of THREAD_BLOCK_ORDER) {
    const seq = anchorSeq(events, ANCHOR_RULES[kind])
    if (seq === null) {
      trailing.push(kind)
    } else {
      after.set(seq, [...(after.get(seq) ?? []), kind])
    }
  }
  return { after, trailing }
}

// ── Card ordering (human-blocked first, then most recently active) ────────

function byActivity(a: TaskState, b: TaskState): number {
  return compareByActivity(a.record, b.record)
}

/**
 * Cards that need the human first (per `EXECUTION_STATUS[status].attention`,
 * never a hardcoded status list), then the rest, each group internally
 * ordered by `compareByActivity` (most recently touched first).
 */
export function orderCards(states: readonly TaskState[]): TaskState[] {
  const attention = states.filter((state) => EXECUTION_STATUS[state.record.status].attention)
  const rest = states.filter((state) => !EXECUTION_STATUS[state.record.status].attention)
  return [...attention.toSorted(byActivity), ...rest.toSorted(byActivity)]
}
