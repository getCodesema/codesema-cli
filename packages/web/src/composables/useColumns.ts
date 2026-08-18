// Pure state logic of the center column deck and the conversation rail: up to
// MAX_COLUMNS columns side by side, opened from the rail or a project tree.
// A column shows either an existing conversation (task) or a draft — an empty
// composer targeting a base branch, promoted in place into a task column once
// the conversation is actually created. Opening an already visible column
// never duplicates it; a full deck evicts its OLDEST column (FIFO, tasks and
// drafts share the same clock) and the newcomer takes that exact slot, so the
// surviving columns never reorder. Components only compose these functions
// (testable with bun:test, no DOM, no fetch).

import type { TaskRecord } from '../types'
import { compareByActivity, sectionOf, type HomeSection } from './useTaskBoard'

/** Hard cap of side-by-side columns; a 4th open evicts the oldest. */
export const MAX_COLUMNS = 3

/**
 * A draft column carries its creation mode (amendment 4):
 * - 'fork': the conversation will FORK a codesema/task-* branch from `base`
 *   (clicks on a trunk); drafts dedupe by base.
 * - 'workon': the conversation will work DIRECTLY ON `branch` (clicks on a
 *   non-trunk branch or an MR node), `target` is the MR's target branch when
 *   the click came from an MR; drafts dedupe by branch, target rides along.
 */
export type DraftTarget =
  | { kind: 'draft'; mode: 'fork'; base: string }
  | { kind: 'draft'; mode: 'workon'; branch: string; target: string | null }

export const forkDraft = (base: string): DraftTarget => ({ kind: 'draft', mode: 'fork', base })

export const workonDraft = (branch: string, target: string | null): DraftTarget => ({
  kind: 'draft',
  mode: 'workon',
  branch,
  target,
})

/** The branch a draft dedupes on: fork by its base, workon by its branch. */
export const draftBranch = (draft: DraftTarget): string =>
  draft.mode === 'fork' ? draft.base : draft.branch

/** What a column points at: a real conversation, or a draft composer. */
export type ColumnTarget = { kind: 'task'; taskId: string } | DraftTarget

export type ColumnRef = {
  projectId: string
  ref: ColumnTarget
  /** Monotonic open order: the smallest openedAt is the eviction candidate. */
  openedAt: number
}

/** The deck is a value: every mutation returns a fresh state (or the same
 * reference when nothing changed, so watchers stay quiet). */
export type ColumnsState = { columns: ColumnRef[]; nextSeq: number }

export const EMPTY_COLUMNS: ColumnsState = { columns: [], nextSeq: 0 }

/** Stable identity of a draft column; `#draft/` can never prefix a task id.
 * The mode is part of the key: a fork and a workon draft never collide. */
export const draftColumnKey = (projectId: string, draft: DraftTarget): string =>
  `${projectId}/#draft/${draft.mode}/${draftBranch(draft)}`

/** Stable identity of a column: task columns match taskKey(projectId, taskId). */
export function columnKey(column: Pick<ColumnRef, 'projectId' | 'ref'>): string {
  return column.ref.kind === 'task'
    ? `${column.projectId}/${column.ref.taskId}`
    : draftColumnKey(column.projectId, column.ref)
}

export function hasColumn(state: ColumnsState, projectId: string, taskId: string): boolean {
  return state.columns.some(
    (c) => c.projectId === projectId && c.ref.kind === 'task' && c.ref.taskId === taskId,
  )
}

/** Draft dedup identity: same project, same mode, same branch (a workon
 * draft's target never splits the identity). */
const matchesDraft = (column: ColumnRef, projectId: string, draft: DraftTarget): boolean =>
  column.projectId === projectId &&
  column.ref.kind === 'draft' &&
  column.ref.mode === draft.mode &&
  draftBranch(column.ref) === draftBranch(draft)

export function hasDraftColumn(
  state: ColumnsState,
  projectId: string,
  draft: DraftTarget,
): boolean {
  return state.columns.some((c) => matchesDraft(c, projectId, draft))
}

/** Shared FIFO insertion: append while the deck has room, otherwise replace
 * the oldest column IN PLACE — its slot is the only one that changes. */
function insertColumn(state: ColumnsState, projectId: string, ref: ColumnTarget, max: number) {
  const opened: ColumnRef = { projectId, ref, openedAt: state.nextSeq }
  if (state.columns.length < max) {
    return { columns: [...state.columns, opened], nextSeq: state.nextSeq + 1 }
  }
  const oldest = state.columns.reduce((min, c) => (c.openedAt < min.openedAt ? c : min))
  return {
    columns: state.columns.map((c) => (c === oldest ? opened : c)),
    nextSeq: state.nextSeq + 1,
  }
}

/**
 * Opens a conversation as a column. Already open → the state is returned
 * untouched (the caller highlights the existing column instead of adding a
 * twin). Deck not full → appended on the right. Deck full → FIFO eviction,
 * in place (see insertColumn).
 */
export function openColumn(
  state: ColumnsState,
  projectId: string,
  taskId: string,
  max: number = MAX_COLUMNS,
): ColumnsState {
  if (hasColumn(state, projectId, taskId)) {
    return state
  }
  return insertColumn(state, projectId, { kind: 'task', taskId }, max)
}

/**
 * Opens a draft column: an empty composer for `draft` in `projectId`.
 * One draft per (projectId, mode, branch) — already open returns the state
 * untouched (an existing workon draft keeps its own target). Drafts share
 * the FIFO clock with task columns.
 */
export function openDraftColumn(
  state: ColumnsState,
  projectId: string,
  draft: DraftTarget,
  max: number = MAX_COLUMNS,
): ColumnsState {
  if (hasDraftColumn(state, projectId, draft)) {
    return state
  }
  return insertColumn(state, projectId, draft, max)
}

/**
 * The draft's conversation was created (or already existed, 409): its column
 * becomes the task's column IN PLACE — same slot, the other columns never
 * move. The promoted column takes a fresh openedAt: the conversation just
 * started, it must not be the next eviction candidate. Without a matching
 * draft (edge: it was evicted while the POST ran) the task opens as a
 * regular column instead.
 */
/**
 * Switches an open draft's mode in place (work-on <-> fork-from): same slot,
 * same FIFO age. If a draft equal to `to` is already open elsewhere, `from`
 * simply closes — never a twin.
 */
export function swapDraft(
  state: ColumnsState,
  projectId: string,
  from: DraftTarget,
  to: DraftTarget,
): ColumnsState {
  if (!hasDraftColumn(state, projectId, from)) {
    return state
  }
  if (hasDraftColumn(state, projectId, to)) {
    return closeDraftColumn(state, projectId, from)
  }
  return {
    ...state,
    columns: state.columns.map((column) =>
      matchesDraft(column, projectId, from) ? { ...column, ref: to } : column,
    ),
  }
}

export function promoteDraft(
  state: ColumnsState,
  projectId: string,
  draft: DraftTarget,
  taskId: string,
): ColumnsState {
  if (!hasDraftColumn(state, projectId, draft)) {
    return openColumn(state, projectId, taskId)
  }
  const promoted: ColumnRef = {
    projectId,
    ref: { kind: 'task', taskId },
    openedAt: state.nextSeq,
  }
  return {
    columns: state.columns.map((c) => (matchesDraft(c, projectId, draft) ? promoted : c)),
    nextSeq: state.nextSeq + 1,
  }
}

export function closeColumn(state: ColumnsState, projectId: string, taskId: string): ColumnsState {
  const columns = state.columns.filter(
    (c) => !(c.projectId === projectId && c.ref.kind === 'task' && c.ref.taskId === taskId),
  )
  return columns.length === state.columns.length ? state : { columns, nextSeq: state.nextSeq }
}

export function closeDraftColumn(
  state: ColumnsState,
  projectId: string,
  draft: DraftTarget,
): ColumnsState {
  const columns = state.columns.filter((c) => !matchesDraft(c, projectId, draft))
  return columns.length === state.columns.length ? state : { columns, nextSeq: state.nextSeq }
}

/** Drops every column of one project (the project was unregistered). */
export function closeProjectColumns(state: ColumnsState, projectId: string): ColumnsState {
  const columns = state.columns.filter((c) => c.projectId !== projectId)
  return columns.length === state.columns.length ? state : { columns, nextSeq: state.nextSeq }
}

// ── Rail grouping ──────────────────────────────────────────────────────────

/** The three rail groups, reusing the home-section grammar: waiting for the
 * human first (prominent), then in progress, then the folded done pile. */
export type RailGroups<T> = Record<HomeSection, T[]>

/**
 * Groups every conversation of every project for the rail, most recently
 * touched first within each group. The rail never filters by project: it is
 * the global "what needs me / what is moving" ledger.
 */
export function groupRail<T extends { record: Pick<TaskRecord, 'status' | 'updated_at' | 'id'> }>(
  states: readonly T[],
): RailGroups<T> {
  const groups: RailGroups<T> = { waiting: [], active: [], done: [] }
  for (const state of states.toSorted((a, b) => compareByActivity(a.record, b.record))) {
    groups[sectionOf(state.record.status)].push(state)
  }
  return groups
}
