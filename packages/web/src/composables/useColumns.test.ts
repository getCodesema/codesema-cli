import { describe, expect, test } from 'bun:test'
import type { TaskStatus } from '../types'
import {
  closeColumn,
  closeDraftColumn,
  closeProjectColumns,
  columnKey,
  draftBranch,
  draftColumnKey,
  EMPTY_COLUMNS,
  forkDraft,
  groupRail,
  hasColumn,
  hasDraftColumn,
  MAX_COLUMNS,
  openColumn,
  openDraftColumn,
  promoteDraft,
  swapDraft,
  workonDraft,
  type ColumnsState,
} from './useColumns'

const keys = (state: ColumnsState): string[] => state.columns.map((c) => columnKey(c))

function deckOf(...refs: [string, string][]): ColumnsState {
  return refs.reduce((state, [p, t]) => openColumn(state, p, t), EMPTY_COLUMNS)
}

describe('openColumn', () => {
  test('appends on the right while the deck is not full', () => {
    const state = deckOf(['p1', 't1'], ['p1', 't2'])
    expect(keys(state)).toEqual(['p1/t1', 'p1/t2'])
  })

  test('an already open conversation is never duplicated (same reference back)', () => {
    const state = deckOf(['p1', 't1'], ['p1', 't2'])
    expect(openColumn(state, 'p1', 't1')).toBe(state)
  })

  test('the same task id in another project is a distinct column', () => {
    const state = deckOf(['p1', 't1'], ['p2', 't1'])
    expect(keys(state)).toEqual(['p1/t1', 'p2/t1'])
  })

  test('a 4th open evicts the OLDEST column, FIFO', () => {
    const full = deckOf(['p1', 't1'], ['p1', 't2'], ['p1', 't3'])
    const state = openColumn(full, 'p1', 't4')
    expect(state.columns).toHaveLength(MAX_COLUMNS)
    expect(keys(state)).not.toContain('p1/t1')
    expect(keys(state)).toContain('p1/t4')
  })

  test('the newcomer takes the evicted slot: other columns never move', () => {
    const full = deckOf(['p1', 't1'], ['p1', 't2'], ['p1', 't3'])
    const state = openColumn(full, 'p1', 't4')
    expect(keys(state)).toEqual(['p1/t4', 'p1/t2', 'p1/t3'])
  })

  test('successive evictions walk the deck in open order, wherever the slot is', () => {
    let state = deckOf(['p1', 't1'], ['p1', 't2'], ['p1', 't3'])
    state = openColumn(state, 'p1', 't4') // evicts t1 → slot 0
    state = openColumn(state, 'p1', 't5') // evicts t2 → slot 1
    expect(keys(state)).toEqual(['p1/t4', 'p1/t5', 'p1/t3'])
    state = openColumn(state, 'p1', 't6') // evicts t3 → slot 2
    expect(keys(state)).toEqual(['p1/t4', 'p1/t5', 'p1/t6'])
  })

  test('a column reopened after a close counts as newly opened for FIFO', () => {
    let state = deckOf(['p1', 't1'], ['p1', 't2'], ['p1', 't3'])
    state = closeColumn(state, 'p1', 't1')
    state = openColumn(state, 'p1', 't1') // back, but now the youngest
    state = openColumn(state, 'p1', 't4') // evicts t2, the oldest survivor
    expect(keys(state)).toEqual(['p1/t4', 'p1/t3', 'p1/t1'])
  })

  test('honors a custom max', () => {
    const state = openColumn(deckOf(['p1', 't1']), 'p1', 't2', 1)
    expect(keys(state)).toEqual(['p1/t2'])
  })
})

// ── Draft columns ──────────────────────────────────────────────────────────

describe('openDraftColumn', () => {
  test('appends a fork draft column keyed by its base branch', () => {
    const state = openDraftColumn(deckOf(['p1', 't1']), 'p1', forkDraft('main'))
    expect(keys(state)).toEqual(['p1/t1', draftColumnKey('p1', forkDraft('main'))])
  })

  test('one fork draft per (projectId, base): a twin returns the same reference', () => {
    const state = openDraftColumn(EMPTY_COLUMNS, 'p1', forkDraft('main'))
    expect(openDraftColumn(state, 'p1', forkDraft('main'))).toBe(state)
  })

  test('workon drafts dedupe by branch: a different target is still a twin', () => {
    const state = openDraftColumn(EMPTY_COLUMNS, 'p1', workonDraft('feature/x', null))
    expect(openDraftColumn(state, 'p1', workonDraft('feature/x', 'main'))).toBe(state)
  })

  test('the existing workon draft keeps its own target on a dedup hit', () => {
    const state = openDraftColumn(EMPTY_COLUMNS, 'p1', workonDraft('feature/x', 'develop'))
    const after = openDraftColumn(state, 'p1', workonDraft('feature/x', null))
    const ref = after.columns[0]?.ref
    expect(ref?.kind === 'draft' && ref.mode === 'workon' && ref.target).toBe('develop')
  })

  test('a fork and a workon draft on the same branch name are distinct', () => {
    let state = openDraftColumn(EMPTY_COLUMNS, 'p1', forkDraft('main'))
    state = openDraftColumn(state, 'p1', workonDraft('main', null))
    expect(keys(state)).toEqual([
      draftColumnKey('p1', forkDraft('main')),
      draftColumnKey('p1', workonDraft('main', null)),
    ])
  })

  test('the same base in another project is a distinct draft', () => {
    let state = openDraftColumn(EMPTY_COLUMNS, 'p1', forkDraft('main'))
    state = openDraftColumn(state, 'p2', forkDraft('main'))
    expect(keys(state)).toEqual([
      draftColumnKey('p1', forkDraft('main')),
      draftColumnKey('p2', forkDraft('main')),
    ])
  })

  test('drafts share the FIFO clock: a 4th open evicts the oldest, draft or task', () => {
    // Oldest is the draft: a new task takes its slot.
    let state = openDraftColumn(EMPTY_COLUMNS, 'p1', forkDraft('main'))
    state = openColumn(state, 'p1', 't1')
    state = openColumn(state, 'p1', 't2')
    state = openColumn(state, 'p1', 't3')
    expect(keys(state)).toEqual(['p1/t3', 'p1/t1', 'p1/t2'])
    // Oldest is a task: a new draft takes its slot.
    state = openDraftColumn(state, 'p1', workonDraft('feature/x', 'develop'))
    expect(keys(state)).toEqual([
      'p1/t3',
      draftColumnKey('p1', workonDraft('feature/x', 'develop')),
      'p1/t2',
    ])
  })
})

describe('promoteDraft', () => {
  test('the draft becomes the task column IN PLACE: same slot, no reorder', () => {
    let state = deckOf(['p1', 't1'])
    state = openDraftColumn(state, 'p1', forkDraft('main'))
    state = openColumn(state, 'p1', 't2')
    const promoted = promoteDraft(state, 'p1', forkDraft('main'), 't9')
    expect(keys(promoted)).toEqual(['p1/t1', 'p1/t9', 'p1/t2'])
  })

  test('a workon draft promotes in place too, matched by branch alone', () => {
    let state = deckOf(['p1', 't1'])
    state = openDraftColumn(state, 'p1', workonDraft('feature/x', 'main'))
    state = openColumn(state, 'p1', 't2')
    const promoted = promoteDraft(state, 'p1', workonDraft('feature/x', null), 't9')
    expect(keys(promoted)).toEqual(['p1/t1', 'p1/t9', 'p1/t2'])
  })

  test('the promoted column is the youngest: it is not the next eviction', () => {
    let state = openDraftColumn(EMPTY_COLUMNS, 'p1', forkDraft('main')) // openedAt 0
    state = openColumn(state, 'p1', 't2') // openedAt 1
    state = openColumn(state, 'p1', 't3') // openedAt 2
    state = promoteDraft(state, 'p1', forkDraft('main'), 't9') // fresh openedAt
    state = openColumn(state, 'p1', 't4') // evicts t2, not t9
    expect(keys(state)).toEqual(['p1/t9', 'p1/t4', 'p1/t3'])
  })

  test('promotion only touches the matching (projectId, mode, branch) draft', () => {
    let state = openDraftColumn(EMPTY_COLUMNS, 'p1', forkDraft('main'))
    state = openDraftColumn(state, 'p2', forkDraft('main'))
    state = openDraftColumn(state, 'p2', workonDraft('feature/x', null))
    const promoted = promoteDraft(state, 'p2', forkDraft('main'), 't9')
    expect(keys(promoted)).toEqual([
      draftColumnKey('p1', forkDraft('main')),
      'p2/t9',
      draftColumnKey('p2', workonDraft('feature/x', null)),
    ])
  })

  test('a workon promotion never adopts the fork draft of the same branch', () => {
    const state = openDraftColumn(EMPTY_COLUMNS, 'p1', forkDraft('main'))
    const promoted = promoteDraft(state, 'p1', workonDraft('main', null), 't9')
    // No matching workon draft: the task opens as a regular column instead.
    expect(keys(promoted)).toEqual([draftColumnKey('p1', forkDraft('main')), 'p1/t9'])
  })

  test('without a matching draft (evicted meanwhile) the task opens normally', () => {
    const state = deckOf(['p1', 't1'])
    const promoted = promoteDraft(state, 'p1', forkDraft('main'), 't9')
    expect(keys(promoted)).toEqual(['p1/t1', 'p1/t9'])
  })
})

describe('closeColumn', () => {
  test('removes only the targeted column', () => {
    const state = closeColumn(deckOf(['p1', 't1'], ['p1', 't2']), 'p1', 't1')
    expect(keys(state)).toEqual(['p1/t2'])
  })

  test('closing an absent column returns the same reference', () => {
    const state = deckOf(['p1', 't1'])
    expect(closeColumn(state, 'p1', 'nope')).toBe(state)
  })

  test('never closes a draft: task and draft namespaces stay disjoint', () => {
    const state = openDraftColumn(EMPTY_COLUMNS, 'p1', forkDraft('main'))
    expect(closeColumn(state, 'p1', 'main')).toBe(state)
  })
})

describe('closeDraftColumn', () => {
  test('removes only the targeted draft, tasks are untouched', () => {
    let state = deckOf(['p1', 't1'])
    state = openDraftColumn(state, 'p1', forkDraft('main'))
    const closed = closeDraftColumn(state, 'p1', forkDraft('main'))
    expect(keys(closed)).toEqual(['p1/t1'])
  })

  test('a workon draft closes by branch, whatever the target says', () => {
    let state = deckOf(['p1', 't1'])
    state = openDraftColumn(state, 'p1', workonDraft('feature/x', 'main'))
    const closed = closeDraftColumn(state, 'p1', workonDraft('feature/x', null))
    expect(keys(closed)).toEqual(['p1/t1'])
  })

  test('closing a fork draft never closes the workon twin of the branch', () => {
    const state = openDraftColumn(EMPTY_COLUMNS, 'p1', workonDraft('main', null))
    expect(closeDraftColumn(state, 'p1', forkDraft('main'))).toBe(state)
  })

  test('closing an absent draft returns the same reference', () => {
    const state = deckOf(['p1', 't1'])
    expect(closeDraftColumn(state, 'p1', forkDraft('main'))).toBe(state)
  })
})

describe('closeProjectColumns', () => {
  test('drops every column of the project, keeps the others in order', () => {
    const state = closeProjectColumns(deckOf(['p1', 't1'], ['p2', 't1'], ['p1', 't2']), 'p1')
    expect(keys(state)).toEqual(['p2/t1'])
  })

  test('drops the project drafts too', () => {
    let state = deckOf(['p1', 't1'], ['p2', 't1'])
    state = openDraftColumn(state, 'p1', forkDraft('main'))
    state = openDraftColumn(state, 'p1', workonDraft('feature/x', null))
    const closed = closeProjectColumns(state, 'p1')
    expect(keys(closed)).toEqual(['p2/t1'])
  })

  test('no column of the project → same reference back', () => {
    const state = deckOf(['p1', 't1'])
    expect(closeProjectColumns(state, 'p9')).toBe(state)
  })
})

describe('hasColumn / hasDraftColumn', () => {
  test('true only for an open (project, task) pair', () => {
    const state = deckOf(['p1', 't1'])
    expect(hasColumn(state, 'p1', 't1')).toBe(true)
    expect(hasColumn(state, 'p2', 't1')).toBe(false)
    expect(hasColumn(state, 'p1', 't2')).toBe(false)
  })

  test('drafts and tasks never answer for each other', () => {
    const state = openDraftColumn(deckOf(['p1', 't1']), 'p1', forkDraft('main'))
    expect(hasDraftColumn(state, 'p1', forkDraft('main'))).toBe(true)
    expect(hasDraftColumn(state, 'p1', forkDraft('t1'))).toBe(false)
    expect(hasColumn(state, 'p1', 'main')).toBe(false)
  })

  test('a draft only answers for its own mode', () => {
    const state = openDraftColumn(EMPTY_COLUMNS, 'p1', forkDraft('main'))
    expect(hasDraftColumn(state, 'p1', workonDraft('main', null))).toBe(false)
  })
})

describe('columnKey', () => {
  test('task keys match the store taskKey format; draft keys cannot collide', () => {
    expect(columnKey({ projectId: 'p1', ref: { kind: 'task', taskId: 't1' } })).toBe('p1/t1')
    expect(columnKey({ projectId: 'p1', ref: forkDraft('main') })).toBe(
      draftColumnKey('p1', forkDraft('main')),
    )
    expect(draftColumnKey('p1', forkDraft('main'))).not.toBe('p1/main')
  })

  test('fork and workon keys of one branch differ; the target never leaks in', () => {
    expect(draftColumnKey('p1', forkDraft('main'))).not.toBe(
      draftColumnKey('p1', workonDraft('main', null)),
    )
    expect(draftColumnKey('p1', workonDraft('feature/x', 'main'))).toBe(
      draftColumnKey('p1', workonDraft('feature/x', null)),
    )
  })
})

describe('draftBranch', () => {
  test('fork dedupes on its base, workon on its branch', () => {
    expect(draftBranch(forkDraft('main'))).toBe('main')
    expect(draftBranch(workonDraft('feature/x', 'main'))).toBe('feature/x')
  })
})

// ── groupRail ──────────────────────────────────────────────────────────────

function railState(id: string, status: TaskStatus, updatedAt: string) {
  return { record: { id, status, updated_at: updatedAt } }
}

describe('groupRail', () => {
  test('splits by section: waiting, active, done', () => {
    const groups = groupRail([
      railState('t1', 'shipped', '2026-08-14T10:00:00.000Z'),
      railState('t2', 'running', '2026-08-14T10:00:00.000Z'),
      railState('t3', 'waiting_for_you', '2026-08-14T10:00:00.000Z'),
      railState('t4', 'review_ko', '2026-08-14T10:00:00.000Z'),
    ])
    expect(groups.waiting.map((s) => s.record.id)).toEqual(['t3', 't4'])
    expect(groups.active.map((s) => s.record.id)).toEqual(['t2'])
    expect(groups.done.map((s) => s.record.id)).toEqual(['t1'])
  })

  test('most recently touched first within each group', () => {
    const groups = groupRail([
      railState('t1', 'running', '2026-08-14T09:00:00.000Z'),
      railState('t2', 'running', '2026-08-14T11:00:00.000Z'),
    ])
    expect(groups.active.map((s) => s.record.id)).toEqual(['t2', 't1'])
  })

  test('does not mutate its input', () => {
    const input = [
      railState('t1', 'running', '2026-08-14T09:00:00.000Z'),
      railState('t2', 'running', '2026-08-14T11:00:00.000Z'),
    ]
    groupRail(input)
    expect(input.map((s) => s.record.id)).toEqual(['t1', 't2'])
  })

  test('empty input yields three empty groups', () => {
    expect(groupRail([])).toEqual({ waiting: [], active: [], done: [] })
  })
})

describe('swapDraft', () => {
  test('switches mode in place: same slot, same openedAt', () => {
    let state = openColumn(EMPTY_COLUMNS, 'p1', 't1')
    state = openDraftColumn(state, 'p1', workonDraft('develop', null))
    const before = state.columns.map((c) => c.openedAt)
    state = swapDraft(state, 'p1', workonDraft('develop', null), forkDraft('develop'))
    expect(state.columns.map((c) => c.openedAt)).toEqual(before)
    expect(state.columns[1]?.ref).toEqual(forkDraft('develop'))
  })

  test('target already open elsewhere: the source draft closes, no twin', () => {
    let state = openDraftColumn(EMPTY_COLUMNS, 'p1', forkDraft('develop'))
    state = openDraftColumn(state, 'p1', workonDraft('develop', null))
    state = swapDraft(state, 'p1', workonDraft('develop', null), forkDraft('develop'))
    expect(state.columns).toHaveLength(1)
    expect(state.columns[0]?.ref).toEqual(forkDraft('develop'))
  })

  test('unknown source draft: state untouched', () => {
    const state = openColumn(EMPTY_COLUMNS, 'p1', 't1')
    expect(swapDraft(state, 'p1', workonDraft('x', null), forkDraft('x'))).toBe(state)
  })
})
