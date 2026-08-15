import { describe, expect, test } from 'bun:test'
import {
  isActiveTaskStatus,
  isTaskId,
  sanitizeTaskChecks,
  sanitizeTaskEvent,
  sanitizeTaskRecord,
  TASK_CHECK_COMMAND_MAX,
  TASK_CHECK_TAIL_MAX,
  TASK_CHECKS_ERROR_MAX,
  TASK_CHECKS_LIST_MAX,
  TASK_EVENT_DATA_KEYS_MAX,
  TASK_EVENT_DATA_STRING_MAX,
  TASK_TITLE_MAX,
  TASK_TURN_TEXT_MAX,
  TASK_TURNS_MAX,
  type TaskChecks,
  type TaskEvent,
  type TaskRecord,
  type TaskStatus,
} from './index.js'

const validRecord: TaskRecord = {
  version: 1,
  id: 'a1b2c3d4e5f6',
  title: 'Add rate limiting',
  status: 'running',
  base: 'main',
  branch: 'codesema/task-add-rate-limiting',
  worktree: '/repo/.codesema/worktrees/a1b2c3d4e5f6',
  agent_session_id: 'sess-123',
  turns: [
    {
      prompt: 'Add rate limiting to the API',
      response: 'Done, added a token bucket.',
      question: null,
      started_at: '2026-08-14T10:00:00.000Z',
      ended_at: '2026-08-14T10:05:00.000Z',
    },
  ],
  review_ref: '.codesema/reviews/task-20260814-100500.json',
  work_ms: 300_000,
  wait_ms: 12_000,
  auto_ship: true,
  work_on: false,
  isolation: 'container',
  created_at: '2026-08-14T10:00:00.000Z',
  updated_at: '2026-08-14T10:05:00.000Z',
}

describe('isTaskId', () => {
  test('accepts exactly 12 lowercase hex chars', () => {
    expect(isTaskId('a1b2c3d4e5f6')).toBe(true)
    expect(isTaskId('A1B2C3D4E5F6')).toBe(false)
    expect(isTaskId('a1b2c3d4e5f')).toBe(false)
    expect(isTaskId('a1b2c3d4e5f67')).toBe(false)
    expect(isTaskId('../../../etc')).toBe(false)
    expect(isTaskId('')).toBe(false)
    expect(isTaskId(42)).toBe(false)
    expect(isTaskId(null)).toBe(false)
  })
})

describe('sanitizeTaskRecord', () => {
  test('a valid record round-trips unchanged', () => {
    expect(sanitizeTaskRecord(structuredClone(validRecord))).toEqual(validRecord)
  })

  test('non-object input: null', () => {
    expect(sanitizeTaskRecord(null)).toBeNull()
    expect(sanitizeTaskRecord(undefined)).toBeNull()
    expect(sanitizeTaskRecord('junk')).toBeNull()
    expect(sanitizeTaskRecord(42)).toBeNull()
    expect(sanitizeTaskRecord([])).toBeNull()
  })

  test('missing or malformed id: null (no usable identity)', () => {
    expect(sanitizeTaskRecord({ ...validRecord, id: undefined })).toBeNull()
    expect(sanitizeTaskRecord({ ...validRecord, id: '' })).toBeNull()
    expect(sanitizeTaskRecord({ ...validRecord, id: 'not-hex-chars' })).toBeNull()
    expect(sanitizeTaskRecord({ ...validRecord, id: '../traversal' })).toBeNull()
    expect(sanitizeTaskRecord({ ...validRecord, id: 42 })).toBeNull()
  })

  test('uppercase id is normalized to lowercase', () => {
    expect(sanitizeTaskRecord({ ...validRecord, id: ' A1B2C3D4E5F6 ' })?.id).toBe('a1b2c3d4e5f6')
  })

  test('a legacy record carrying a role field loses it (roles were removed)', () => {
    const r = sanitizeTaskRecord({ ...validRecord, role: 'security' })
    expect(r).toEqual(validRecord)
    expect(r && 'role' in r).toBe(false)
  })

  test('empty object with a valid id: safe defaults everywhere', () => {
    const r = sanitizeTaskRecord({ id: 'a1b2c3d4e5f6' })
    expect(r).not.toBeNull()
    expect(r?.version).toBe(1)
    expect(r?.title).toBe('')
    expect(r?.status).toBe('failed')
    expect(r?.base).toBe('')
    expect(r?.branch).toBe('')
    expect(r?.worktree).toBe('')
    expect(r?.agent_session_id).toBeNull()
    expect(r?.turns).toEqual([])
    expect(r?.review_ref).toBeNull()
    expect(r?.work_ms).toBe(0)
    expect(r?.wait_ms).toBe(0)
    expect(r?.auto_ship).toBe(false)
    expect(r?.work_on).toBe(false)
    expect(typeof r?.created_at).toBe('string')
    // With no created_at, updated_at falls back to the same generated stamp.
    expect(r?.updated_at).toBe(r?.created_at ?? '')
  })

  test('all valid statuses are kept', () => {
    const statuses = [
      'queued',
      'running',
      'waiting_for_you',
      'reviewing',
      'review_ok',
      'review_ko',
      'shipped',
      'failed',
      'interrupted',
    ] as const
    for (const status of statuses) {
      expect(sanitizeTaskRecord({ ...validRecord, status })?.status).toBe(status)
    }
  })

  test('unknown status degrades to failed, never to a runnable state', () => {
    expect(sanitizeTaskRecord({ ...validRecord, status: 'done' })?.status).toBe('failed')
    expect(sanitizeTaskRecord({ ...validRecord, status: 42 })?.status).toBe('failed')
  })

  test('title is trimmed and truncated', () => {
    expect(sanitizeTaskRecord({ ...validRecord, title: '  hi  ' })?.title).toBe('hi')
    expect(sanitizeTaskRecord({ ...validRecord, title: 'x'.repeat(999) })?.title.length).toBe(
      TASK_TITLE_MAX,
    )
  })

  test('counters: negative, fractional or non-numeric become 0', () => {
    expect(sanitizeTaskRecord({ ...validRecord, work_ms: -5 })?.work_ms).toBe(0)
    expect(sanitizeTaskRecord({ ...validRecord, work_ms: 1.5 })?.work_ms).toBe(0)
    expect(sanitizeTaskRecord({ ...validRecord, wait_ms: 'lots' })?.wait_ms).toBe(0)
  })

  test('auto_ship: strictly boolean true, everything else is false', () => {
    expect(sanitizeTaskRecord({ ...validRecord, auto_ship: 'yes' })?.auto_ship).toBe(false)
    expect(sanitizeTaskRecord({ ...validRecord, auto_ship: 1 })?.auto_ship).toBe(false)
  })

  test('work_on: strictly boolean true; a legacy record without it is a fork task', () => {
    expect(sanitizeTaskRecord({ ...validRecord, work_on: true })?.work_on).toBe(true)
    expect(sanitizeTaskRecord({ ...validRecord, work_on: 'yes' })?.work_on).toBe(false)
    const legacy: Record<string, unknown> = { ...validRecord }
    delete legacy.work_on
    expect(sanitizeTaskRecord(legacy)?.work_on).toBe(false)
  })

  test('isolation: both modes survive a round-trip', () => {
    expect(sanitizeTaskRecord({ ...validRecord, isolation: 'container' })?.isolation).toBe(
      'container',
    )
    expect(sanitizeTaskRecord({ ...validRecord, isolation: 'policy' })?.isolation).toBe('policy')
  })

  test('isolation: a record written before the cage existed is policy', () => {
    const legacy: Record<string, unknown> = { ...validRecord }
    delete legacy.isolation
    expect(sanitizeTaskRecord(legacy)?.isolation).toBe('policy')
  })

  test('isolation: an unknown value never claims the stronger containment', () => {
    expect(sanitizeTaskRecord({ ...validRecord, isolation: 'vm' })?.isolation).toBe('policy')
    expect(sanitizeTaskRecord({ ...validRecord, isolation: 42 })?.isolation).toBe('policy')
    expect(sanitizeTaskRecord({ ...validRecord, isolation: null })?.isolation).toBe('policy')
  })

  test('turns: invalid entries skipped, texts truncated, empty response null', () => {
    const r = sanitizeTaskRecord({
      ...validRecord,
      turns: [
        null,
        'junk',
        { response: 'no prompt' },
        { prompt: '   ' },
        { prompt: 'p'.repeat(TASK_TURN_TEXT_MAX + 100), response: '', question: 7 },
      ],
    })
    expect(r?.turns.length).toBe(1)
    expect(r?.turns[0]?.prompt.length).toBe(TASK_TURN_TEXT_MAX)
    expect(r?.turns[0]?.response).toBeNull()
    expect(r?.turns[0]?.question).toBeNull()
    expect(r?.turns[0]?.ended_at).toBeNull()
  })

  test('turns are capped', () => {
    const turns = Array.from({ length: TASK_TURNS_MAX + 10 }, () => ({ prompt: 'go' }))
    expect(sanitizeTaskRecord({ ...validRecord, turns })?.turns.length).toBe(TASK_TURNS_MAX)
  })

  test('non-array turns become an empty list', () => {
    expect(sanitizeTaskRecord({ ...validRecord, turns: 'nope' })?.turns).toEqual([])
  })
})

describe('isActiveTaskStatus', () => {
  test('only shipped and failed are terminal', () => {
    const active: TaskStatus[] = [
      'queued',
      'running',
      'waiting_for_you',
      'reviewing',
      'review_ok',
      'review_ko',
      'interrupted',
    ]
    for (const status of active) {
      expect(isActiveTaskStatus(status)).toBe(true)
    }
    expect(isActiveTaskStatus('shipped')).toBe(false)
    expect(isActiveTaskStatus('failed')).toBe(false)
  })
})

describe('sanitizeTaskEvent', () => {
  const validEvent: TaskEvent = {
    seq: 3,
    at: '2026-08-14T10:01:00.000Z',
    type: 'tool_use',
    data: { tool: 'Edit', file: 'src/app.ts', ok: true, exit: 0, note: null },
  }

  test('a valid event round-trips unchanged', () => {
    expect(sanitizeTaskEvent(structuredClone(validEvent))).toEqual(validEvent)
  })

  test('non-object input: null', () => {
    expect(sanitizeTaskEvent(null)).toBeNull()
    expect(sanitizeTaskEvent('junk')).toBeNull()
    expect(sanitizeTaskEvent(42)).toBeNull()
  })

  test('missing, negative or fractional seq: null (cannot be ordered)', () => {
    expect(sanitizeTaskEvent({ ...validEvent, seq: undefined })).toBeNull()
    expect(sanitizeTaskEvent({ ...validEvent, seq: -1 })).toBeNull()
    expect(sanitizeTaskEvent({ ...validEvent, seq: 1.5 })).toBeNull()
    expect(sanitizeTaskEvent({ ...validEvent, seq: '3' })).toBeNull()
  })

  test('unknown type: null (a newer schema line is skipped, not mangled)', () => {
    expect(sanitizeTaskEvent({ ...validEvent, type: 'text_delta' })).toBeNull()
    expect(sanitizeTaskEvent({ ...validEvent, type: undefined })).toBeNull()
  })

  test('all valid types are kept', () => {
    const types = [
      'turn_started',
      'tool_use',
      'tool_result',
      'message',
      'question',
      'commit',
      'review_started',
      'review_done',
      'checks',
      'shipped',
      'error',
      'interrupted',
      'isolation',
    ] as const
    for (const type of types) {
      expect(sanitizeTaskEvent({ ...validEvent, type })?.type).toBe(type)
    }
  })

  test('missing at falls back to a generated stamp', () => {
    const at = sanitizeTaskEvent({ ...validEvent, at: undefined })?.at
    expect(typeof at).toBe('string')
    expect(at?.length).toBeGreaterThan(0)
  })

  test('data: nested values dropped, strings truncated, keys capped', () => {
    const wide: Record<string, unknown> = {}
    for (let i = 0; i < TASK_EVENT_DATA_KEYS_MAX + 5; i++) {
      wide[`k${i}`] = i
    }
    const capped = sanitizeTaskEvent({ ...validEvent, data: wide })
    expect(Object.keys(capped?.data ?? {}).length).toBe(TASK_EVENT_DATA_KEYS_MAX)

    const r = sanitizeTaskEvent({
      ...validEvent,
      data: {
        long: 'x'.repeat(TASK_EVENT_DATA_STRING_MAX + 500),
        nested: { a: 1 },
        list: [1, 2],
        fn: () => 1,
        nan: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        keep: 'ok',
      },
    })
    expect(r?.data.long).toBe('x'.repeat(TASK_EVENT_DATA_STRING_MAX))
    expect(r?.data.nested).toBeUndefined()
    expect(r?.data.list).toBeUndefined()
    expect(r?.data.fn).toBeUndefined()
    expect(r?.data.nan).toBeUndefined()
    expect(r?.data.inf).toBeUndefined()
    expect(r?.data.keep).toBe('ok')
  })

  test('non-object data becomes an empty object', () => {
    expect(sanitizeTaskEvent({ ...validEvent, data: 'junk' })?.data).toEqual({})
    expect(sanitizeTaskEvent({ ...validEvent, data: [1, 2] })?.data).toEqual({})
    expect(sanitizeTaskEvent({ ...validEvent, data: undefined })?.data).toEqual({})
  })
})

describe('sanitizeTaskChecks', () => {
  const validChecks: TaskChecks = {
    head_sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    started_at: '2026-08-14T10:00:00.000Z',
    finished_at: '2026-08-14T10:02:00.000Z',
    status: 'failed',
    checks: [
      {
        command: 'bun run typecheck',
        status: 'passed',
        exit_code: 0,
        duration_ms: 12_000,
        tail: 'ok\n',
      },
      {
        command: 'bun test',
        status: 'failed',
        exit_code: 1,
        duration_ms: 30_000,
        tail: '1 test failed\n',
      },
    ],
    error: null,
  }

  test('a valid run round-trips unchanged', () => {
    expect(sanitizeTaskChecks(structuredClone(validChecks))).toEqual(validChecks)
  })

  test('non-object input: null', () => {
    expect(sanitizeTaskChecks(null)).toBeNull()
    expect(sanitizeTaskChecks('junk')).toBeNull()
    expect(sanitizeTaskChecks(42)).toBeNull()
    expect(sanitizeTaskChecks([])).toBeNull()
  })

  test('unknown or missing run status: null (a newer schema never fakes a verdict)', () => {
    expect(sanitizeTaskChecks({ ...validChecks, status: 'green' })).toBeNull()
    expect(sanitizeTaskChecks({ ...validChecks, status: undefined })).toBeNull()
  })

  test('all valid run statuses are kept', () => {
    const statuses = ['running', 'passed', 'failed', 'error', 'unconfigured'] as const
    for (const status of statuses) {
      expect(sanitizeTaskChecks({ ...validChecks, status })?.status).toBe(status)
    }
  })

  test('a running snapshot keeps finished_at null and tolerates an empty list', () => {
    const running = sanitizeTaskChecks({
      head_sha: 'abc',
      started_at: '2026-08-14T10:00:00.000Z',
      finished_at: null,
      status: 'running',
      checks: [],
      error: null,
    })
    expect(running?.finished_at).toBeNull()
    expect(running?.checks).toEqual([])
  })

  test('check entries: missing command or unknown status are skipped, not mangled', () => {
    const r = sanitizeTaskChecks({
      ...validChecks,
      checks: [
        validChecks.checks[0],
        { command: '', status: 'passed', exit_code: 0, duration_ms: 1, tail: '' },
        { command: 'x', status: 'green', exit_code: 0, duration_ms: 1, tail: '' },
        'junk',
        null,
      ],
    })
    expect(r?.checks).toEqual([validChecks.checks[0]!])
  })

  test('tail keeps the END on truncation (the verdict lives there)', () => {
    const tail = `${'x'.repeat(TASK_CHECK_TAIL_MAX)}THE END`
    const r = sanitizeTaskChecks({
      ...validChecks,
      checks: [{ ...validChecks.checks[0], tail }],
    })
    expect(r?.checks[0]?.tail.length).toBe(TASK_CHECK_TAIL_MAX)
    expect(r?.checks[0]?.tail.endsWith('THE END')).toBe(true)
  })

  test('command is truncated, exit_code non-integers become null, counters clamp to 0', () => {
    const r = sanitizeTaskChecks({
      ...validChecks,
      checks: [
        {
          command: 'c'.repeat(TASK_CHECK_COMMAND_MAX + 10),
          status: 'timeout',
          exit_code: 'boom',
          duration_ms: -5,
          tail: 42,
        },
      ],
    })
    expect(r?.checks[0]?.command.length).toBe(TASK_CHECK_COMMAND_MAX)
    expect(r?.checks[0]?.exit_code).toBeNull()
    expect(r?.checks[0]?.duration_ms).toBe(0)
    expect(r?.checks[0]?.tail).toBe('')
  })

  test('the check list is capped', () => {
    const many = Array.from({ length: TASK_CHECKS_LIST_MAX + 5 }, () => validChecks.checks[0])
    expect(sanitizeTaskChecks({ ...validChecks, checks: many })?.checks.length).toBe(
      TASK_CHECKS_LIST_MAX,
    )
  })

  test('error message is bounded and blank degrades to null', () => {
    const long = sanitizeTaskChecks({
      ...validChecks,
      status: 'error',
      error: 'e'.repeat(TASK_CHECKS_ERROR_MAX + 100),
    })
    expect(long?.error?.length).toBe(TASK_CHECKS_ERROR_MAX)
    expect(sanitizeTaskChecks({ ...validChecks, error: '   ' })?.error).toBeNull()
    expect(sanitizeTaskChecks({ ...validChecks, error: 42 })?.error).toBeNull()
  })

  test('source: known values pass through, anything else drops the key', () => {
    for (const source of ['config', 'lefthook', 'ci', 'scripts'] as const) {
      expect(sanitizeTaskChecks({ ...validChecks, source })?.source).toBe(source)
    }
    // A checks.json written before the field existed stays valid and silent.
    expect(sanitizeTaskChecks(structuredClone(validChecks))).not.toHaveProperty('source')
    for (const junk of ['gitlab', '', 42, null, {}]) {
      expect(sanitizeTaskChecks({ ...validChecks, source: junk })).not.toHaveProperty('source')
    }
  })
})
