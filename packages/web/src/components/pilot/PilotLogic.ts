// Pure state math of the pilot workspace: the column count, the lens
// overlay (which task/block a card's evidence lens shows), the card
// ordering (human-blocked first), and the mobile list/thread pane. Split
// out, same doctrine as ComposerLogic.ts / ForgeLogic.ts: PilotShell.vue
// only composes these functions.

import { compareByActivity } from '../../composables/useTaskBoard'
import type { TaskState } from '../../composables/useTasks'
import { EXECUTION_STATUS } from '../../execution-status'

export type PilotCols = 1 | 2 | 3 | 4

/**
 * Tolerant coercion of a persisted column count: a wrong TYPE falls back to
 * the default (2), same doctrine as `pickWidth` in useRailPrefs.ts: a
 * right-typed value is clamped into [1, 4] rather than rejected.
 */
export function clampCols(raw: unknown): PilotCols {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return 2
  }
  return Math.min(4, Math.max(1, Math.round(raw))) as PilotCols
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
