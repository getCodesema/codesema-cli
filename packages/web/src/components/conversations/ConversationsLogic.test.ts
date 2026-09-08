import { describe, expect, test } from 'bun:test'
import type { TaskState } from '../../composables/useTasks'
import type { TaskRecord } from '../../types'
import {
  formatConversationTimestamp,
  orderConversations,
  searchRightPadding,
} from './ConversationsLogic'

// -- Fixtures -----------------------------------------------------------------

function record(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    version: 1,
    id: 'a1b2c3d4e5f6',
    title: 'a conversation',
    status: 'running',
    base: 'main',
    branch: 'codesema/task-x',
    worktree: '/tmp/w',
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: false,
    created_at: '2026-08-13T10:00:00.000Z',
    updated_at: '2026-08-13T10:00:00.000Z',
    ...overrides,
  }
}

function taskState(
  recordOverrides: Partial<TaskRecord> = {},
  stateOverrides: Partial<TaskState> = {},
): TaskState {
  return {
    projectId: 'p1',
    record: record(recordOverrides),
    events: [],
    liveText: '',
    liveMessages: [],
    liveTokens: 0,
    liveLoadCap: null,
    checks: null,
    ...stateOverrides,
  }
}

/** A Date built from LOCAL wall-clock components, converted to epoch ms: used
 * throughout instead of a raw UTC ISO string so a test's intended calendar
 * day never depends on the machine's timezone (clockTime, and therefore
 * formatConversationTimestamp, reads LOCAL components: the same reason
 * useTaskBoard.test.ts's own clockTime test only asserts a shape, never an
 * exact "HH:mm"). */
type LocalTime = { hour: number; minute: number }
const NOON: LocalTime = { hour: 12, minute: 0 }

function localEpoch(year: number, month: number, day: number, at: LocalTime = NOON): number {
  return new Date(year, month - 1, day, at.hour, at.minute).getTime()
}

// -- formatConversationTimestamp: two regimes, local calendar days ----------

describe('formatConversationTimestamp: the hour today, the day before that', () => {
  const now = localEpoch(2026, 8, 24, { hour: 15, minute: 30 })

  test('same calendar day: the time alone', () => {
    const iso = new Date(localEpoch(2026, 8, 24, { hour: 9, minute: 15 })).toISOString()
    expect(formatConversationTimestamp(iso, now)).toBe('09:15')
  })

  test('a future timestamp (clock skew) still reads as a time', () => {
    const iso = new Date(localEpoch(2026, 8, 25, { hour: 9, minute: 0 })).toISOString()
    expect(formatConversationTimestamp(iso, now)).toMatch(/^\d{2}:\d{2}$/)
  })

  test('yesterday is already a date, zero-padded, day first', () => {
    const iso = new Date(localEpoch(2026, 8, 23, { hour: 9, minute: 15 })).toISOString()
    expect(formatConversationTimestamp(iso, now)).toBe('23/08')
  })

  test('an older day of the same year: the same day/month form', () => {
    const iso = new Date(localEpoch(2026, 1, 3, { hour: 9, minute: 15 })).toISOString()
    expect(formatConversationTimestamp(iso, now)).toBe('03/01')
  })

  test('a previous year reads the same: no year, no weekday, no month name', () => {
    const iso = new Date(localEpoch(2025, 12, 20, { hour: 9, minute: 15 })).toISOString()
    expect(formatConversationTimestamp(iso, now)).toBe('20/12')
  })

  test('the format carries no translated word at all', () => {
    const iso = new Date(localEpoch(2026, 8, 20, { hour: 9, minute: 15 })).toISOString()
    expect(formatConversationTimestamp(iso, now)).toMatch(/^\d{2}\/\d{2}$/)
  })

  test('an unparsable timestamp renders nothing', () => {
    expect(formatConversationTimestamp('not-a-date', now)).toBe('')
  })
})

// -- orderConversations: one flat order, no project grouping ----------------

describe('orderConversations', () => {
  test('lines are ordered attention > active > ready > done', () => {
    const states = [
      taskState({ id: 'done1', status: 'shipped', updated_at: '2026-08-20T00:00:00.000Z' }),
      taskState({ id: 'ready1', status: 'review_ok', updated_at: '2026-08-20T00:00:00.000Z' }),
      taskState({ id: 'active1', status: 'running', updated_at: '2026-08-20T00:00:00.000Z' }),
      taskState({ id: 'attn1', status: 'waiting_for_you', updated_at: '2026-08-20T00:00:00.000Z' }),
    ]
    expect(orderConversations(states).map((s) => s.record.id)).toEqual([
      'attn1',
      'active1',
      'ready1',
      'done1',
    ])
  })

  test('within the same section, the most recently active conversation sorts first', () => {
    const states = [
      taskState({ id: 'older', status: 'running', updated_at: '2026-08-01T00:00:00.000Z' }),
      taskState({ id: 'newer', status: 'running', updated_at: '2026-08-20T00:00:00.000Z' }),
    ]
    expect(orderConversations(states).map((s) => s.record.id)).toEqual(['newer', 'older'])
  })

  test('the project plays no part: conversations of several projects interleave by state', () => {
    const states = [
      taskState(
        { id: 'zdone', status: 'shipped', updated_at: '2026-08-20T00:00:00.000Z' },
        { projectId: 'alpha' },
      ),
      taskState(
        { id: 'zattn', status: 'waiting_for_you', updated_at: '2026-08-20T00:00:00.000Z' },
        { projectId: 'zebra' },
      ),
    ]
    expect(orderConversations(states).map((s) => s.record.id)).toEqual(['zattn', 'zdone'])
  })

  test('an empty input yields an empty list', () => {
    expect(orderConversations([])).toEqual([])
  })

  test('the input array is never mutated', () => {
    const states = [
      taskState({ id: 'done1', status: 'shipped' }),
      taskState({ id: 'attn1', status: 'waiting_for_you' }),
    ]
    orderConversations(states)
    expect(states.map((s) => s.record.id)).toEqual(['done1', 'attn1'])
  })
})

// -- searchRightPadding: base clearance plus one step per trailing icon -----

describe('searchRightPadding', () => {
  test('the 36 / 56 / 76 progression for 0, 1, and 2 icons', () => {
    expect(searchRightPadding(0)).toBe(36)
    expect(searchRightPadding(1)).toBe(56)
    expect(searchRightPadding(2)).toBe(76)
  })

  test('a negative count never produces less than the base clearance', () => {
    expect(searchRightPadding(-3)).toBe(36)
  })
})
