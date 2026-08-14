// Pure state of the focus zone: the column deck (useColumns) plus PINS.
// Doctrine ("maquette + deck en option"): the zone shows ONE conversation by
// default; the 📌 button pins it, pinned conversations sit side by side (max
// MAX_COLUMNS, the deck's own cap), and opening a conversation from the queue
// replaces the UNPINNED one(s) — or shows alone when nothing is pinned.
// Drafts (fork/work-on composers) keep their column: they are never the
// replacement target, only pins-full FIFO eviction can push one out. All
// functions are value-in/value-out (bun:test, no DOM).

import {
  closeColumn,
  closeDraftColumn,
  closeProjectColumns,
  columnKey,
  EMPTY_COLUMNS,
  hasColumn,
  hasDraftColumn,
  MAX_COLUMNS,
  openColumn,
  openDraftColumn,
  promoteDraft,
  swapDraft,
  type ColumnRef,
  type ColumnsState,
  type ColumnTarget,
  type DraftTarget,
} from './useColumns'

export type FocusDeck = {
  cols: ColumnsState
  /** columnKey()s of the pinned columns; always a subset of the open keys. */
  pinned: readonly string[]
}

export const EMPTY_DECK: FocusDeck = { cols: EMPTY_COLUMNS, pinned: [] }

/** Open column identities, in display order (stable slots, never reordered). */
export function deckKeys(deck: FocusDeck): string[] {
  return deck.cols.columns.map(columnKey)
}

export function isPinned(deck: FocusDeck, key: string): boolean {
  return deck.pinned.includes(key)
}

/** Pins pruned to the still-open columns (eviction/close drops the pin too). */
function prunePins(cols: ColumnsState, pinned: readonly string[]): readonly string[] {
  const open = new Set(cols.columns.map(columnKey))
  const kept = pinned.filter((key) => open.has(key))
  return kept.length === pinned.length ? pinned : kept
}

/** The columns an open replaces: unpinned TASK columns (drafts are kept). */
function looseColumns(deck: FocusDeck): ColumnRef[] {
  return deck.cols.columns.filter(
    (column) => column.ref.kind === 'task' && !deck.pinned.includes(columnKey(column)),
  )
}

/**
 * Shared insertion: replace the first loose column in place (and drop any
 * other loose ones, so the newcomer truly "shows alone" among the unpinned),
 * else append while the deck has room, else FIFO-evict the oldest column —
 * pinned or draft, its pin goes with it (the deck cap is a hard cap).
 */
function insertReplacing(deck: FocusDeck, projectId: string, ref: ColumnTarget): FocusDeck {
  const loose = looseColumns(deck)
  const slot = loose[0]
  if (slot !== undefined) {
    const opened: ColumnRef = { projectId, ref, openedAt: deck.cols.nextSeq }
    const columns = deck.cols.columns
      .filter((column) => column === slot || !loose.includes(column))
      .map((column) => (column === slot ? opened : column))
    const cols = { columns, nextSeq: deck.cols.nextSeq + 1 }
    return { cols, pinned: prunePins(cols, deck.pinned) }
  }
  const cols =
    ref.kind === 'task'
      ? openColumn(deck.cols, projectId, ref.taskId, MAX_COLUMNS)
      : openDraftColumn(deck.cols, projectId, ref, MAX_COLUMNS)
  return { cols, pinned: prunePins(cols, deck.pinned) }
}

/** Opens a conversation; already open → the deck is returned untouched. */
export function deckOpenTask(deck: FocusDeck, projectId: string, taskId: string): FocusDeck {
  if (hasColumn(deck.cols, projectId, taskId)) {
    return deck
  }
  return insertReplacing(deck, projectId, { kind: 'task', taskId })
}

/** Opens a draft composer; an equal draft already open → untouched. */
export function deckOpenDraft(deck: FocusDeck, projectId: string, draft: DraftTarget): FocusDeck {
  if (hasDraftColumn(deck.cols, projectId, draft)) {
    return deck
  }
  return insertReplacing(deck, projectId, draft)
}

/** Pin toggle; only open TASK columns are pinnable (drafts have no 📌). */
export function deckTogglePin(deck: FocusDeck, key: string): FocusDeck {
  if (deck.pinned.includes(key)) {
    return { ...deck, pinned: deck.pinned.filter((k) => k !== key) }
  }
  const column = deck.cols.columns.find((c) => columnKey(c) === key)
  if (column === undefined || column.ref.kind !== 'task') {
    return deck
  }
  return { ...deck, pinned: [...deck.pinned, key] }
}

export function deckCloseTask(deck: FocusDeck, projectId: string, taskId: string): FocusDeck {
  const cols = closeColumn(deck.cols, projectId, taskId)
  return cols === deck.cols ? deck : { cols, pinned: prunePins(cols, deck.pinned) }
}

export function deckCloseDraft(deck: FocusDeck, projectId: string, draft: DraftTarget): FocusDeck {
  const cols = closeDraftColumn(deck.cols, projectId, draft)
  return cols === deck.cols ? deck : { cols, pinned: prunePins(cols, deck.pinned) }
}

/** Drops every column of one project (the project was unregistered). */
export function deckCloseProject(deck: FocusDeck, projectId: string): FocusDeck {
  const cols = closeProjectColumns(deck.cols, projectId)
  return cols === deck.cols ? deck : { cols, pinned: prunePins(cols, deck.pinned) }
}

/** Draft mode switch in place (work-on <-> fork); pins are unaffected. */
export function deckSwapDraft(
  deck: FocusDeck,
  projectId: string,
  from: DraftTarget,
  to: DraftTarget,
): FocusDeck {
  const cols = swapDraft(deck.cols, projectId, from, to)
  return cols === deck.cols ? deck : { cols, pinned: prunePins(cols, deck.pinned) }
}

/** The draft's conversation was created (or already existed, 409): its column
 * becomes the task's column IN PLACE, unpinned (a fresh conversation is the
 * natural replacement target of the next open). */
export function deckPromoteDraft(
  deck: FocusDeck,
  projectId: string,
  draft: DraftTarget,
  taskId: string,
): FocusDeck {
  const cols = promoteDraft(deck.cols, projectId, draft, taskId)
  return { cols, pinned: prunePins(cols, deck.pinned) }
}
