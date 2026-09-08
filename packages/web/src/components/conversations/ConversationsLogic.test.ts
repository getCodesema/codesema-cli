import { describe, expect, test } from 'bun:test'
import type { TaskState } from '../../composables/useTasks'
import { t } from '../../i18n'
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

const WEEKDAY = [
  t('time.weekdaySun'),
  t('time.weekdayMon'),
  t('time.weekdayTue'),
  t('time.weekdayWed'),
  t('time.weekdayThu'),
  t('time.weekdayFri'),
  t('time.weekdaySat'),
]
const MONTH = [
  t('time.monthJan'),
  t('time.monthFeb'),
  t('time.monthMar'),
  t('time.monthApr'),
  t('time.monthMay'),
  t('time.monthJun'),
  t('time.monthJul'),
  t('time.monthAug'),
  t('time.monthSep'),
  t('time.monthOct'),
  t('time.monthNov'),
  t('time.monthDec'),
]

// -- formatConversationTimestamp: five regimes, local calendar days ---------

describe('formatConversationTimestamp: five regimes', () => {
  const now = localEpoch(2026, 8, 24, { hour: 15, minute: 30 })

  test('regime 1, today: the time alone', () => {
    const iso = new Date(localEpoch(2026, 8, 24, { hour: 9, minute: 15 })).toISOString()
    const expected = new Date(iso)
    const hh = String(expected.getHours()).padStart(2, '0')
    const mm = String(expected.getMinutes()).padStart(2, '0')
    expect(formatConversationTimestamp(iso, now)).toBe(`${hh}:${mm}`)
  })

  test('regime 1 also covers a future timestamp (clock skew clamps to "today")', () => {
    const iso = new Date(localEpoch(2026, 8, 25, { hour: 9, minute: 0 })).toISOString()
    expect(formatConversationTimestamp(iso, now)).toMatch(/^\d{2}:\d{2}$/)
  })

  test('regime 2, yesterday: "yesterday" plus the time', () => {
    const iso = new Date(localEpoch(2026, 8, 23, { hour: 9, minute: 15 })).toISOString()
    expect(formatConversationTimestamp(iso, now)).toBe(t('time.yesterdayAt', { t: '09:15' }))
  })

  test('regime 3, 2 to 6 days: abbreviated weekday plus the time', () => {
    const at = localEpoch(2026, 8, 20, { hour: 9, minute: 15 }) // 4 calendar days before `now`
    const iso = new Date(at).toISOString()
    const day = WEEKDAY[new Date(at).getDay()]
    expect(formatConversationTimestamp(iso, now)).toBe(t('time.weekdayAt', { day, t: '09:15' }))
  })

  test('regime 3 boundary: exactly 6 days still reads as a weekday', () => {
    const at = localEpoch(2026, 8, 18, { hour: 9, minute: 15 }) // 6 calendar days before `now`
    const iso = new Date(at).toISOString()
    const day = WEEKDAY[new Date(at).getDay()]
    expect(formatConversationTimestamp(iso, now)).toBe(t('time.weekdayAt', { day, t: '09:15' }))
  })

  test('regime 4, same year, more than 6 days: abbreviated month plus day', () => {
    const iso = new Date(localEpoch(2026, 1, 3, { hour: 9, minute: 15 })).toISOString()
    expect(formatConversationTimestamp(iso, now)).toBe(
      t('time.monthDay', { month: MONTH[0], day: '3' }),
    )
  })

  test('regime 4 boundary: exactly 7 days already reads as month/day, not a weekday', () => {
    const iso = new Date(localEpoch(2026, 8, 17, { hour: 9, minute: 15 })).toISOString()
    expect(formatConversationTimestamp(iso, now)).toBe(
      t('time.monthDay', { month: MONTH[7], day: '17' }),
    )
  })

  test('regime 5, year elapsed: abbreviated month, day, and the year', () => {
    const iso = new Date(localEpoch(2025, 12, 20, { hour: 9, minute: 15 })).toISOString()
    expect(formatConversationTimestamp(iso, now)).toBe(
      t('time.monthDayYear', { month: MONTH[11], day: '20', year: '2025' }),
    )
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
