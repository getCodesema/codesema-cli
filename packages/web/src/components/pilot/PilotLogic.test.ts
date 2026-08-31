import { describe, expect, test } from 'bun:test'
import type { TaskState } from '../../composables/useTasks'
import type { TaskRecord, TaskStatus } from '../../types'
import {
  clampCols,
  closeLens,
  mobilePane,
  onEscape,
  openLens,
  orderCards,
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

describe('clampCols', () => {
  test('a value already inside [1, 4] passes through unchanged', () => {
    expect(clampCols(1)).toBe(1)
    expect(clampCols(3)).toBe(3)
    expect(clampCols(4)).toBe(4)
  })

  test('below the minimum is raised to 1', () => {
    expect(clampCols(0)).toBe(1)
    expect(clampCols(-5)).toBe(1)
  })

  test('above the maximum is lowered to 4', () => {
    expect(clampCols(5)).toBe(4)
    expect(clampCols(99)).toBe(4)
  })

  test('a non-integer number is rounded before clamping', () => {
    expect(clampCols(2.4)).toBe(2)
    expect(clampCols(2.6)).toBe(3)
  })

  test('the wrong type falls back to the default (2), not a clamp', () => {
    expect(clampCols('3')).toBe(2)
    expect(clampCols(null)).toBe(2)
    expect(clampCols(undefined)).toBe(2)
    expect(clampCols({})).toBe(2)
    expect(clampCols(Number.NaN)).toBe(2)
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
