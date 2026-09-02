import { describe, expect, test } from 'bun:test'
import type { TaskState } from '../../composables/useTasks'
import type { TaskEvent, TaskRecord, TaskStatus } from '../../types'
import {
  anchorThreadBlocks,
  closeLens,
  hiddenStates,
  LANE_MAX,
  laneTemplate,
  mobilePane,
  onEscape,
  openLens,
  orderCards,
  pruneClosed,
  toggleExpanded,
  visibleLanes,
  type LensState,
} from './PilotLogic'

function record(partial: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    version: 1,
    title: partial.id,
    status: 'running',
    base: 'main',
    branch: `codesema/task-${partial.id}`,
    worktree: `/wt/${partial.id}`,
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: false,
    created_at: '2026-08-14T09:00:00.000Z',
    updated_at: '2026-08-14T09:00:00.000Z',
    ...partial,
  }
}

function state(partial: Partial<TaskRecord> & { id: string }): TaskState {
  return {
    projectId: 'aaaa1111',
    record: record(partial),
    events: [],
    liveText: '',
    liveMessages: [],
    liveTokens: 0,
    liveLoadCap: null,
    checks: null,
  }
}

describe('visibleLanes', () => {
  test('truncates to LANE_MAX (4), keeping orderCards order', () => {
    const states = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
      state({
        id,
        status: 'shipped',
        updated_at: `2026-08-20T${10 + 'abcdef'.indexOf(id)}:00:00.000Z`,
      }),
    )
    const visible = visibleLanes(states, [])
    expect(visible).toHaveLength(LANE_MAX)
    expect(visible.map((s) => s.record.id)).toEqual(
      orderCards(states)
        .slice(0, LANE_MAX)
        .map((s) => s.record.id),
    )
  })

  test('a closed id is excluded even when it would otherwise be in the top 4', () => {
    const states = ['a', 'b', 'c'].map((id) => state({ id, status: 'running' }))
    expect(visibleLanes(states, ['a']).map((s) => s.record.id)).toEqual(['b', 'c'])
  })

  test('closing a card from the top 4 frees a slot for the one just beyond it', () => {
    const states = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      state({
        id,
        status: 'shipped',
        updated_at: `2026-08-20T${10 + 'abcde'.indexOf(id)}:00:00.000Z`,
      }),
    )
    expect(visibleLanes(states, ['e']).map((s) => s.record.id)).toEqual(['d', 'c', 'b', 'a'])
  })

  test('fewer than 4 cards all stay visible', () => {
    const states = ['a', 'b'].map((id) => state({ id, status: 'running' }))
    expect(visibleLanes(states, []).map((s) => s.record.id)).toHaveLength(2)
  })

  test('an empty list stays empty', () => {
    expect(visibleLanes([], [])).toEqual([])
  })
})

describe('hiddenStates', () => {
  test('empty when everything fits within the visible lanes', () => {
    const states = ['a', 'b', 'c'].map((id) => state({ id, status: 'running' }))
    expect(hiddenStates(states, [])).toEqual([])
  })

  test('a card beyond the top 4 is hidden even though it is not closed', () => {
    const states = ['a', 'b', 'c', 'd', 'e'].map((id) =>
      state({
        id,
        status: 'shipped',
        updated_at: `2026-08-20T${10 + 'abcde'.indexOf(id)}:00:00.000Z`,
      }),
    )
    expect(hiddenStates(states, []).map((s) => s.record.id)).toEqual(['a'])
  })

  test('a closed card among the first 4 is hidden too', () => {
    const states = ['a', 'b', 'c'].map((id) => state({ id, status: 'running' }))
    expect(hiddenStates(states, ['b']).map((s) => s.record.id)).toEqual(['b'])
  })

  test('closed and beyond-4 cards are both reported, in orderCards order', () => {
    const states = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
      state({
        id,
        status: 'shipped',
        updated_at: `2026-08-20T${10 + 'abcdef'.indexOf(id)}:00:00.000Z`,
      }),
    )
    expect(hiddenStates(states, ['b']).map((s) => s.record.id)).toEqual(['b', 'a'])
  })
})

describe('laneTemplate', () => {
  test('every visible lane gets an equal 1fr track when none is expanded', () => {
    expect(laneTemplate(['a', 'b', 'c', 'd'], null)).toBe(
      'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)',
    )
  })

  test('the expanded lane gets a 2fr track, the rest stay at 1fr', () => {
    expect(laneTemplate(['a', 'b', 'c'], 'b')).toBe('minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1fr)')
  })

  test('an expanded id that is not among the visible lanes has no effect', () => {
    expect(laneTemplate(['a', 'b'], 'z')).toBe('minmax(0, 1fr) minmax(0, 1fr)')
  })

  test('no visible lanes produces an empty template', () => {
    expect(laneTemplate([], 'a')).toBe('')
  })
})

describe('toggleExpanded', () => {
  test('expanding a lane from none sets it', () => {
    expect(toggleExpanded(null, 'a')).toBe('a')
  })

  test('clicking the already-expanded lane collapses it back to none', () => {
    expect(toggleExpanded('a', 'a')).toBeNull()
  })

  test('clicking a different lane replaces the expanded one', () => {
    expect(toggleExpanded('a', 'b')).toBe('b')
  })
})

describe('pruneClosed', () => {
  test('an id that no longer exists is dropped', () => {
    expect(pruneClosed(['a', 'b'], ['a'])).toEqual(['a'])
  })

  test('ids that still exist are kept, in their original order', () => {
    expect(pruneClosed(['a', 'b'], ['b', 'a'])).toEqual(['a', 'b'])
  })

  test('an empty closed list stays empty', () => {
    expect(pruneClosed([], ['a'])).toEqual([])
  })

  test('nothing existing anymore empties the list', () => {
    expect(pruneClosed(['a', 'b'], [])).toEqual([])
  })
})

describe('lens (openLens / closeLens / onEscape)', () => {
  test('opening from a closed lens sets the target', () => {
    expect(openLens(null, 't1', 'evidence')).toEqual({ taskId: 't1', block: 'evidence' })
  })

  test('opening a different target while one is open replaces it', () => {
    const current: LensState = { taskId: 't1', block: 'evidence' }
    expect(openLens(current, 't1', 'checks')).toEqual({ taskId: 't1', block: 'checks' })
    expect(openLens(current, 't2', 'evidence')).toEqual({ taskId: 't2', block: 'evidence' })
  })

  test('opening the exact same target again toggles it closed', () => {
    const current: LensState = { taskId: 't1', block: 'evidence' }
    expect(openLens(current, 't1', 'evidence')).toBeNull()
  })

  test('closeLens always returns null, regardless of the current state', () => {
    expect(closeLens()).toBeNull()
  })

  test('onEscape closes an open lens', () => {
    const current: LensState = { taskId: 't1', block: 'recap' }
    expect(onEscape(current)).toBeNull()
  })

  test('onEscape on an already-closed lens stays null', () => {
    expect(onEscape(null)).toBeNull()
  })
})

describe('orderCards', () => {
  test('statuses that require the human come before the rest', () => {
    const running = state({ id: 't1', status: 'running', updated_at: '2026-08-20T10:00:00.000Z' })
    const waiting = state({
      id: 't2',
      status: 'waiting_for_you',
      updated_at: '2026-08-20T08:00:00.000Z',
    })
    const shipped = state({ id: 't3', status: 'shipped', updated_at: '2026-08-20T12:00:00.000Z' })

    const ordered = orderCards([running, shipped, waiting])

    expect(ordered.map((s) => s.record.id)).toEqual(['t2', 't3', 't1'])
  })

  test('waiting_for_you is the only attention status; it sorts ahead of every other status', () => {
    const reviewKo = state({
      id: 'a',
      status: 'review_ko',
      updated_at: '2026-08-20T09:00:00.000Z',
    })
    const interrupted = state({
      id: 'b',
      status: 'interrupted',
      updated_at: '2026-08-20T07:00:00.000Z',
    })
    const waiting = state({
      id: 'c',
      status: 'waiting_for_you',
      updated_at: '2026-08-20T11:00:00.000Z',
    })
    const running = state({ id: 'd', status: 'running', updated_at: '2026-08-20T13:00:00.000Z' })
    const reviewOk = state({
      id: 'e',
      status: 'review_ok',
      updated_at: '2026-08-20T14:00:00.000Z',
    })

    const ordered = orderCards([running, reviewKo, reviewOk, interrupted, waiting])

    expect(ordered.map((s) => s.record.id)).toEqual(['c', 'e', 'd', 'a', 'b'])
  })

  test('within each group, the most recently active card comes first', () => {
    const older = state({ id: 't1', status: 'shipped', updated_at: '2026-08-20T08:00:00.000Z' })
    const newer = state({ id: 't2', status: 'shipped', updated_at: '2026-08-20T10:00:00.000Z' })

    expect(orderCards([older, newer]).map((s) => s.record.id)).toEqual(['t2', 't1'])
  })

  test('an empty list stays empty', () => {
    expect(orderCards([])).toEqual([])
  })

  test('a mix of every status covers each TaskStatus without a hardcoded exception', () => {
    const statuses: TaskStatus[] = [
      'queued',
      'running',
      'waiting_for_you',
      'reviewing',
      'review_ok',
      'review_ko',
      'shipped',
      'failed',
      'interrupted',
    ]
    const states = statuses.map((status, i) => state({ id: `s${i}`, status }))
    const ordered = orderCards(states)
    expect(ordered).toHaveLength(states.length)
    expect(new Set(ordered.map((s) => s.record.id))).toEqual(
      new Set(states.map((s) => s.record.id)),
    )
  })
})

describe('mobilePane', () => {
  test('no selection shows the list', () => {
    expect(mobilePane(null)).toBe('list')
  })

  test('a selected task shows the thread', () => {
    expect(mobilePane('t1')).toBe('thread')
  })
})

function event(seq: number, type: TaskEvent['type']): TaskEvent {
  return { seq, at: '2026-08-30T08:00:00.000Z', type, data: {} }
}

describe('anchorThreadBlocks', () => {
  test('an empty journal trails the four blocks in fixed order', () => {
    const anchors = anchorThreadBlocks([])
    expect(anchors.after.size).toBe(0)
    expect(anchors.trailing).toEqual(['criteria', 'checks', 'evidence', 'recap'])
  })

  test('criteria hang on the first turn_started when no criteria event exists', () => {
    const anchors = anchorThreadBlocks([event(1, 'turn_started'), event(5, 'turn_started')])
    expect(anchors.after.get(1)).toEqual(['criteria'])
    expect(anchors.trailing).toEqual(['checks', 'evidence', 'recap'])
  })

  test('a criteria event wins over the first prompt', () => {
    const anchors = anchorThreadBlocks([event(1, 'turn_started'), event(3, 'criteria')])
    expect(anchors.after.get(3)).toEqual(['criteria'])
    expect(anchors.after.has(1)).toBe(false)
  })

  test('checks and evidence follow the last checks event, in that order', () => {
    const anchors = anchorThreadBlocks([event(1, 'checks'), event(2, 'commit'), event(3, 'checks')])
    expect(anchors.after.get(3)).toEqual(['checks', 'evidence'])
    expect(anchors.after.has(1)).toBe(false)
  })

  test('a proof event pulls evidence away from the checks block', () => {
    const anchors = anchorThreadBlocks([event(1, 'checks'), event(2, 'proof')])
    expect(anchors.after.get(1)).toEqual(['checks'])
    expect(anchors.after.get(2)).toEqual(['evidence'])
  })

  test('without checks, both hang on the last commit', () => {
    const anchors = anchorThreadBlocks([event(1, 'commit'), event(2, 'commit')])
    expect(anchors.after.get(2)).toEqual(['checks', 'evidence'])
  })

  test('the recap follows the last message', () => {
    const anchors = anchorThreadBlocks([
      event(1, 'message'),
      event(2, 'review_done'),
      event(3, 'message'),
    ])
    expect(anchors.after.get(3)).toEqual(['recap'])
    expect(anchors.trailing).toEqual(['criteria', 'checks', 'evidence'])
  })

  test('every block is placed exactly once, anchored or trailing', () => {
    const anchors = anchorThreadBlocks([event(1, 'turn_started'), event(2, 'message')])
    const placed = [...anchors.after.values()].flat().concat(anchors.trailing)
    expect(placed.toSorted()).toEqual(['checks', 'criteria', 'evidence', 'recap'])
  })
})
