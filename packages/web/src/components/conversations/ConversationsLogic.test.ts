import { describe, expect, test } from 'bun:test'
import { statusPhraseKey } from '../../composables/useTaskBoard'
import type { TaskState } from '../../composables/useTasks'
import { t } from '../../i18n'
import type { TaskEvent, TaskRecord } from '../../types'
import {
  formatConversationTimestamp,
  groupConversationsByProject,
  resolveActivityLine,
  resolveChecksPill,
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

function questionEvent(question: string, seq = 1): TaskEvent {
  return { seq, at: '2026-08-13T10:05:00.000Z', type: 'question', data: { question } }
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

// -- groupConversationsByProject: project first, then state precedence ------

describe('groupConversationsByProject', () => {
  test('groups are ordered alphabetically by project display name', () => {
    const states = [
      taskState({ id: 'a' }, { projectId: 'zebra' }),
      taskState({ id: 'b' }, { projectId: 'alpha' }),
    ]
    const names = new Map([
      ['zebra', 'Zebra Repo'],
      ['alpha', 'Alpha Repo'],
    ])
    const groups = groupConversationsByProject(states, names)
    expect(groups.map((g) => g.projectId)).toEqual(['alpha', 'zebra'])
  })

  test('an unknown project id falls back to itself as the display name', () => {
    const groups = groupConversationsByProject([taskState({}, { projectId: 'p9' })], new Map())
    expect(groups[0]?.projectName).toBe('p9')
  })

  test('within a project, rows are ordered attention > active > ready > done', () => {
    const states = [
      taskState({ id: 'done1', status: 'shipped', updated_at: '2026-08-20T00:00:00.000Z' }),
      taskState({ id: 'ready1', status: 'review_ok', updated_at: '2026-08-20T00:00:00.000Z' }),
      taskState({ id: 'active1', status: 'running', updated_at: '2026-08-20T00:00:00.000Z' }),
      taskState({ id: 'attn1', status: 'waiting_for_you', updated_at: '2026-08-20T00:00:00.000Z' }),
    ]
    const groups = groupConversationsByProject(states, new Map())
    expect(groups[0]?.states.map((s) => s.record.id)).toEqual([
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
    const groups = groupConversationsByProject(states, new Map())
    expect(groups[0]?.states.map((s) => s.record.id)).toEqual(['newer', 'older'])
  })

  test('an empty input yields no groups at all', () => {
    expect(groupConversationsByProject([], new Map())).toEqual([])
  })
})

// -- resolveActivityLine: one ordered resolver, static vs pulse vs spin -----

describe('resolveActivityLine: the motion rule (static waits on a human, pulse/spin works)', () => {
  test('interrupted: static, paused', () => {
    const state = taskState({ status: 'interrupted' })
    const line = resolveActivityLine(state)
    expect(line.motion).toBe('static')
    expect(line.glyph).toBe('pause')
    expect(line.text).toBe(t(statusPhraseKey(state.record, false)))
  })

  test('review_ko: static, a blocked review to read', () => {
    const state = taskState({ status: 'review_ko' })
    const line = resolveActivityLine(state)
    expect(line.motion).toBe('static')
    expect(line.glyph).toBe('shield-alert')
    expect(line.text).toBe(t(statusPhraseKey(state.record, false)))
  })

  test('waiting_for_you with an open question: static, the question itself as text', () => {
    const state = taskState(
      { status: 'waiting_for_you' },
      { events: [questionEvent('should this be async?')] },
    )
    const line = resolveActivityLine(state)
    expect(line.motion).toBe('static')
    expect(line.glyph).toBe('question')
    expect(line.text).toBe(t('conversations.questionExcerpt', { q: 'should this be async?' }))
  })

  test('waiting_for_you with no question (a merge-gate hold): static, the status phrase', () => {
    const state = taskState({
      status: 'waiting_for_you',
      reason: { code: 'merge_conflict', detail: 'the branch conflicts' },
    })
    const line = resolveActivityLine(state)
    expect(line.motion).toBe('static')
    expect(line.glyph).toBe('circle-alert')
    expect(line.text).toBe(t(statusPhraseKey(state.record, false)))
  })

  test('review_ok: static, ready to ship', () => {
    const state = taskState({ status: 'review_ok' })
    const line = resolveActivityLine(state)
    expect(line.motion).toBe('static')
    expect(line.glyph).toBe('check')
  })

  test('reviewing: SPIN, never static, never a plain pulse', () => {
    const state = taskState({ status: 'reviewing' })
    const line = resolveActivityLine(state)
    expect(line.motion).toBe('spin')
    expect(line.glyph).toBe('refresh')
  })

  test('running: PULSE, the agent is alive and working', () => {
    const state = taskState({ status: 'running' })
    const line = resolveActivityLine(state)
    expect(line.motion).toBe('pulse')
    expect(line.glyph).toBe('dot')
  })

  test('queued: static, idle, ordinary phrasing when no machine cap is in play', () => {
    const state = taskState({ status: 'queued' }, { liveLoadCap: null })
    const line = resolveActivityLine(state)
    expect(line.motion).toBe('static')
    expect(line.glyph).toBe('clock')
    expect(line.text).toBe(t(statusPhraseKey(state.record, false)))
  })

  test('queued while waiting for a machine-wide slot: the phrase changes to say so', () => {
    const waiting = taskState(
      { status: 'queued' },
      { liveLoadCap: { occupied: 4, max: 4, queued: 1, waitingForSlot: true } },
    )
    const idle = taskState({ status: 'queued' }, { liveLoadCap: null })
    expect(resolveActivityLine(waiting).text).not.toBe(resolveActivityLine(idle).text)
    expect(resolveActivityLine(waiting).text).toBe(t(statusPhraseKey(waiting.record, true)))
  })

  test('shipped (fallback): static, the terminal check glyph', () => {
    const state = taskState({ status: 'shipped' })
    const line = resolveActivityLine(state)
    expect(line.motion).toBe('static')
    expect(line.glyph).toBe('check')
  })

  test('failed (fallback): static, the terminal x glyph', () => {
    const state = taskState({ status: 'failed' })
    const line = resolveActivityLine(state)
    expect(line.motion).toBe('static')
    expect(line.glyph).toBe('x')
  })
})

// -- resolveChecksPill: sheet §7's precedence, adapted to checks + reason ---

describe('resolveChecksPill: rank 0 (shipped) short-circuits everything', () => {
  test('shipped with failed checks still shows no pill', () => {
    const state = taskState(
      { status: 'shipped' },
      {
        checks: {
          head_sha: 'x',
          started_at: '',
          finished_at: null,
          status: 'failed',
          checks: [],
          error: null,
        },
      },
    )
    expect(resolveChecksPill(state)).toBeNull()
  })
})

describe('resolveChecksPill: rank 1, failure outranks everything else', () => {
  test('failed checks alone: a red x pill', () => {
    const state = taskState(
      { status: 'running' },
      {
        checks: {
          head_sha: 'x',
          started_at: '',
          finished_at: null,
          status: 'failed',
          checks: [],
          error: null,
        },
      },
    )
    expect(resolveChecksPill(state)).toEqual({
      tone: 'red',
      glyph: 'x',
      text: t('conversations.checksFailed'),
    })
  })

  test('a checks run that could not even start (error) reads the same as a failure', () => {
    const state = taskState(
      { status: 'running' },
      {
        checks: {
          head_sha: 'x',
          started_at: '',
          finished_at: null,
          status: 'error',
          checks: [],
          error: 'boom',
        },
      },
    )
    expect(resolveChecksPill(state)?.tone).toBe('red')
  })

  test('failure beats a simultaneous merge conflict', () => {
    const state = taskState(
      { status: 'running', reason: { code: 'merge_conflict' } },
      {
        checks: {
          head_sha: 'x',
          started_at: '',
          finished_at: null,
          status: 'failed',
          checks: [],
          error: null,
        },
      },
    )
    expect(resolveChecksPill(state)?.glyph).toBe('x')
  })

  test('the persisted checks_status is read when no live checks mirror exists', () => {
    const state = taskState({ status: 'running', checks_status: 'failed' })
    expect(resolveChecksPill(state)?.tone).toBe('red')
  })
})

describe('resolveChecksPill: rank 2, a merge conflict beats running and passed, never failure', () => {
  test('conflict beats a passed run', () => {
    const state = taskState(
      { status: 'running', reason: { code: 'merge_conflict' } },
      {
        checks: {
          head_sha: 'x',
          started_at: '',
          finished_at: null,
          status: 'passed',
          checks: [],
          error: null,
        },
      },
    )
    expect(resolveChecksPill(state)).toEqual({
      tone: 'red',
      glyph: 'alert-triangle',
      text: t('conversations.checksConflict'),
    })
  })

  test('a reason code other than merge_conflict does not trigger the conflict pill', () => {
    const state = taskState({ status: 'running', reason: { code: 'agent_error' } })
    expect(resolveChecksPill(state)).toBeNull()
  })
})

describe('resolveChecksPill: rank 3, running is reported STATIC (never a motion field)', () => {
  test('a run in flight: an amber dot pill', () => {
    const state = taskState(
      { status: 'running' },
      {
        checks: {
          head_sha: 'x',
          started_at: '',
          finished_at: null,
          status: 'running',
          checks: [],
          error: null,
        },
      },
    )
    expect(resolveChecksPill(state)).toEqual({
      tone: 'amber',
      glyph: 'dot',
      text: t('conversations.checksRunning'),
    })
    // The type carries no `motion`: nothing in this pill can ever be told to
    // spin or pulse, movement stays reserved for the activity line (§7's own
    // point, enforced structurally rather than by a runtime flag).
    expect('motion' in (resolveChecksPill(state) as object)).toBe(false)
  })
})

describe('resolveChecksPill: rank 4, passed', () => {
  test('a clean run: a green check pill', () => {
    const state = taskState(
      { status: 'running' },
      {
        checks: {
          head_sha: 'x',
          started_at: '',
          finished_at: null,
          status: 'passed',
          checks: [],
          error: null,
        },
      },
    )
    expect(resolveChecksPill(state)).toEqual({
      tone: 'green',
      glyph: 'check',
      text: t('conversations.checksPassed'),
    })
  })
})

describe('resolveChecksPill: nothing to show', () => {
  test('unconfigured, no conflict, not shipped: no pill', () => {
    const state = taskState({ status: 'running', checks_status: 'unconfigured' })
    expect(resolveChecksPill(state)).toBeNull()
  })

  test('no checks have ever run and nothing else applies: no pill', () => {
    expect(resolveChecksPill(taskState({ status: 'running' }))).toBeNull()
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
