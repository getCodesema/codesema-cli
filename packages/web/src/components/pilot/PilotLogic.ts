// Pure state math of the pilot workspace: the column count, the lens
// overlay (which task/block a card's evidence lens shows), the card
// ordering (human-blocked first), and the mobile list/thread pane. Split
// out, same doctrine as ComposerLogic.ts / ForgeLogic.ts: PilotShell.vue
// only composes these functions.

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

// ── Evidence lens (which card's block is currently expanded) ──────────────

export type LensBlock = 'evidence' | 'recap' | 'checks' | 'criteria' | 'question'

export type LensState = { taskId: string; block: LensBlock } | null

/**
 * Opens a card's block in the lens. Clicking the block that is already open
 * for that same task toggles it closed instead of leaving it a no-op: the
 * lens trigger doubles as its own close button.
 */
export function openLens(state: LensState, taskId: string, block: LensBlock): LensState {
  if (state !== null && state.taskId === taskId && state.block === block) {
    return null
  }
  return { taskId, block }
}

export function closeLens(): LensState {
  return null
}

/** Escape closes an open lens; with none open there is nothing to unwind. */
export function onEscape(state: LensState): LensState {
  return state === null ? state : closeLens()
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

// ── Mobile shell (single-column: list or thread, never both) ──────────────

export function mobilePane(selectedId: string | null): 'list' | 'thread' {
  return selectedId === null ? 'list' : 'thread'
}

// ── Fixed lanes (max 4 in parallel, closable, one widened at a time) ──────

export const LANE_MAX = 4

export function visibleLanes(states: readonly TaskState[], closed: readonly string[]): TaskState[] {
  const closedIds = new Set(closed)
  return orderCards(states)
    .filter((state) => !closedIds.has(state.record.id))
    .slice(0, LANE_MAX)
}

export function hiddenStates(states: readonly TaskState[], closed: readonly string[]): TaskState[] {
  const visibleIds = new Set(visibleLanes(states, closed).map((state) => state.record.id))
  return orderCards(states).filter((state) => !visibleIds.has(state.record.id))
}

export function laneTemplate(visibleIds: readonly string[], expandedId: string | null): string {
  return visibleIds.map((id) => `minmax(0, ${id === expandedId ? '2fr' : '1fr'})`).join(' ')
}

export function toggleExpanded(current: string | null, id: string): string | null {
  return current === id ? null : id
}

export function pruneClosed(closed: readonly string[], existingIds: readonly string[]): string[] {
  const existing = new Set(existingIds)
  return closed.filter((id) => existing.has(id))
}
