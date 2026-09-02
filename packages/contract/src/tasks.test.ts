import { describe, expect, test } from 'bun:test'
import verificationBodySchema from '../fixtures/hub-schemas/verification.schema.json'
import {
  acceptanceCriterionId,
  ARM_TICKET_STATUSES,
  isActiveTaskStatus,
  isTaskId,
  isTaskStatus,
  isTaskVerificationStatus,
  sanitizeTaskChecks,
  sanitizeTaskEvent,
  sanitizeTaskRecord,
  sanitizeTaskVerification,
  TASK_ACTIVITY_PHASES,
  TASK_AGENT_MAX,
  TASK_CHECK_COMMAND_MAX,
  TASK_CHECK_TAIL_MAX,
  TASK_CHECKS_ERROR_MAX,
  TASK_CHECKS_LIST_MAX,
  TASK_EVENT_DATA_KEYS_MAX,
  TASK_EVENT_DATA_STRING_MAX,
  TASK_HUB_TICKET_ID_MAX,
  TASK_ISSUE_PROJECT_MAX,
  TASK_ISSUE_URL_MAX,
  TASK_STATUS_VALUES,
  TASK_TIMESTAMP_MAX,
  TASK_TITLE_MAX,
  TASK_TURN_TEXT_MAX,
  TASK_TURNS_MAX,
  TICKET_BODY_HASH_TAG,
  TICKET_CRITERIA_MAX,
  type TaskChecks,
  type TaskEvent,
  type TaskIssueRef,
  type TaskIssueSnapshot,
  type TaskRecord,
  type TaskStatus,
  type TaskVerification,
} from './index.js'
import { validate, type Schema } from './schema-validator.test-helper.js'

/** A syntactically valid, correctly-tagged canonical body hash — no need for a real one in tests. */
const FAKE_BODY_HASH = `${TICKET_BODY_HASH_TAG}:${'a'.repeat(64)}`
/** Same shape, a different value: distinguishes section hashes from each other in tests. */
const fakeHash = (byte: string): string => `${TICKET_BODY_HASH_TAG}:${byte.repeat(64)}`
const FAKE_RAW_HASH = `sha256:raw:${'f'.repeat(64)}`

const validIssue: TaskIssueRef = {
  forge: 'github',
  project: 'getCodesema/codesema-cli',
  iid: 42,
  url: 'https://github.com/getCodesema/codesema-cli/issues/42',
}

const validHubTicket = {
  id: 'tick-1',
  title: 'Add rate limiting',
  url: 'https://hub.local/tickets/tick-1',
}

const CRITERION_TEXT = 'WHEN x THE SYSTEM SHALL y'
const validSnapshot: TaskIssueSnapshot = {
  body_hash: FAKE_BODY_HASH,
  section_hashes: {
    context: fakeHash('b'),
    goal: fakeHash('c'),
    scope: fakeHash('d'),
    out_of_scope: fakeHash('e'),
  },
  criteria: [{ id: acceptanceCriterionId(CRITERION_TEXT), text: CRITERION_TEXT }],
  raw_body_hash: FAKE_RAW_HASH,
  taken_at: '2026-08-14T09:00:00.000Z',
}

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

  test('install_lock_hash is kept when it is 16 lowercase hex, dropped otherwise', () => {
    expect(
      sanitizeTaskRecord({ ...validRecord, install_lock_hash: 'aaaaaaaaaaaaaaaa' })
        ?.install_lock_hash,
    ).toBe('aaaaaaaaaaaaaaaa')
    expect(
      sanitizeTaskRecord({ ...validRecord, install_lock_hash: 'not-a-hash' })?.install_lock_hash,
    ).toBeUndefined()
  })

  test('prep events survive sanitization', () => {
    const event = sanitizeTaskEvent({
      seq: 1,
      at: '2026-08-20T10:00:00.000Z',
      type: 'prep',
      data: { name: 'install_passed', command: 'npm ci' },
    })
    expect(event?.type).toBe('prep')
    expect(event?.data.name).toBe('install_passed')
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

  test('agent: a bounded command survives a round-trip', () => {
    expect(sanitizeTaskRecord({ ...validRecord, agent: 'opencode run' })?.agent).toBe(
      'opencode run',
    )
    expect(
      sanitizeTaskRecord({
        ...validRecord,
        agent: '  opencode run -m openrouter/foo  ',
      })?.agent,
    ).toBe('opencode run -m openrouter/foo')
  })

  test('agent: a record written before the field existed keeps none', () => {
    const legacy: Record<string, unknown> = { ...validRecord }
    delete legacy.agent
    expect(sanitizeTaskRecord(legacy)?.agent).toBeUndefined()
  })

  test('agent: a non-string, blank, or overlong value never invents a command', () => {
    expect(sanitizeTaskRecord({ ...validRecord, agent: 42 })?.agent).toBeUndefined()
    expect(sanitizeTaskRecord({ ...validRecord, agent: '' })?.agent).toBeUndefined()
    expect(sanitizeTaskRecord({ ...validRecord, agent: '   ' })?.agent).toBeUndefined()
    expect(sanitizeTaskRecord({ ...validRecord, agent: 'x'.repeat(600) })?.agent?.length).toBe(
      TASK_AGENT_MAX,
    )
  })

  test('reason: a 0.12 record has none, and gets none invented for it', () => {
    // FROZEN fixture of a record as codesema 0.12 wrote it: no `reason` key
    // anywhere, because reason codes did not exist yet.
    const record012 = {
      version: 1,
      id: 'b7c8d9e0f1a2',
      title: 'Cache the preview diff',
      status: 'waiting_for_you',
      base: 'main',
      branch: 'codesema/task-cache-the-preview-diff',
      worktree: '/repo/.codesema/worktrees/b7c8d9e0f1a2',
      agent_session_id: null,
      turns: [
        {
          prompt: 'Cache the preview diff',
          response: 'Done.',
          question: null,
          started_at: '2026-08-14T09:00:00.000Z',
          ended_at: '2026-08-14T09:04:00.000Z',
        },
      ],
      review_ref: null,
      work_ms: 240_000,
      wait_ms: 0,
      auto_ship: false,
      work_on: false,
      isolation: 'policy',
      created_at: '2026-08-14T09:00:00.000Z',
      updated_at: '2026-08-14T09:04:00.000Z',
    }
    const r = sanitizeTaskRecord(structuredClone(record012))
    expect(r).toEqual(record012 as TaskRecord)
    expect(r && 'reason' in r).toBe(false)
    expect(r?.version).toBe(1)
  })

  test('checks_status: optional, terminal only, running and junk dropped', () => {
    expect(
      sanitizeTaskRecord(validRecord) && 'checks_status' in sanitizeTaskRecord(validRecord)!,
    ).toBe(false)
    for (const status of ['passed', 'failed', 'error', 'unconfigured'] as const) {
      expect(sanitizeTaskRecord({ ...validRecord, checks_status: status })?.checks_status).toBe(
        status,
      )
    }
    expect(
      sanitizeTaskRecord({ ...validRecord, checks_status: 'running' }) &&
        'checks_status' in sanitizeTaskRecord({ ...validRecord, checks_status: 'running' })!,
    ).toBe(false)
    expect(
      sanitizeTaskRecord({ ...validRecord, checks_status: 'green' }) &&
        'checks_status' in sanitizeTaskRecord({ ...validRecord, checks_status: 'green' })!,
    ).toBe(false)
  })

  test('cycle_step: optional, whitelisted, unknown dropped', () => {
    expect(
      sanitizeTaskRecord(validRecord) && 'cycle_step' in sanitizeTaskRecord(validRecord)!,
    ).toBe(false)
    for (const step of ['ship', 'merge'] as const) {
      expect(sanitizeTaskRecord({ ...validRecord, cycle_step: step })?.cycle_step).toBe(step)
    }
    expect(
      sanitizeTaskRecord({ ...validRecord, cycle_step: 'review' }) &&
        'cycle_step' in sanitizeTaskRecord({ ...validRecord, cycle_step: 'review' })!,
    ).toBe(false)
    expect(
      sanitizeTaskRecord({ ...validRecord, cycle_step: 42 }) &&
        'cycle_step' in sanitizeTaskRecord({ ...validRecord, cycle_step: 42 })!,
    ).toBe(false)
  })

  test('activity: optional, whitelisted phase + bounded since, unusable dropped', () => {
    expect(sanitizeTaskRecord(validRecord) && 'activity' in sanitizeTaskRecord(validRecord)!).toBe(
      false,
    )
    for (const phase of TASK_ACTIVITY_PHASES) {
      const activity = { phase, since: '2026-08-14T09:00:00.000Z' }
      expect(sanitizeTaskRecord({ ...validRecord, activity })?.activity).toEqual(activity)
    }
    const unknownPhase = { activity: { phase: 'unknown', since: '2026-08-14T09:00:00.000Z' } }
    expect(
      sanitizeTaskRecord({ ...validRecord, ...unknownPhase }) &&
        'activity' in sanitizeTaskRecord({ ...validRecord, ...unknownPhase })!,
    ).toBe(false)
    const missingSince = { activity: { phase: 'checks' } }
    expect(
      sanitizeTaskRecord({ ...validRecord, ...missingSince }) &&
        'activity' in sanitizeTaskRecord({ ...validRecord, ...missingSince })!,
    ).toBe(false)
    const blankSince = { activity: { phase: 'checks', since: '' } }
    expect(
      sanitizeTaskRecord({ ...validRecord, ...blankSince }) &&
        'activity' in sanitizeTaskRecord({ ...validRecord, ...blankSince })!,
    ).toBe(false)
    const overlongSince = {
      activity: { phase: 'checks', since: '2'.repeat(TASK_TIMESTAMP_MAX + 1) },
    }
    expect(
      sanitizeTaskRecord({ ...validRecord, ...overlongSince }) &&
        'activity' in sanitizeTaskRecord({ ...validRecord, ...overlongSince })!,
    ).toBe(false)
  })

  test('cost_ticks: a 0.12 record has none, on the record and on its turns', () => {
    // FROZEN fixture of a record as codesema 0.12 wrote it: no `cost_ticks`
    // key anywhere, because the cost unit did not exist yet.
    const record012 = {
      version: 1,
      id: 'c3d4e5f6a7b8',
      title: 'Cache the preview diff',
      status: 'waiting_for_you',
      base: 'main',
      branch: 'codesema/task-cache-the-preview-diff',
      worktree: '/repo/.codesema/worktrees/c3d4e5f6a7b8',
      agent_session_id: null,
      turns: [
        {
          prompt: 'Cache the preview diff',
          response: 'Done.',
          question: null,
          started_at: '2026-08-14T09:00:00.000Z',
          ended_at: '2026-08-14T09:04:00.000Z',
          tokens: 4_200,
        },
      ],
      review_ref: null,
      work_ms: 240_000,
      wait_ms: 0,
      auto_ship: false,
      work_on: false,
      isolation: 'policy',
      created_at: '2026-08-14T09:00:00.000Z',
      updated_at: '2026-08-14T09:04:00.000Z',
    }
    const r = sanitizeTaskRecord(structuredClone(record012))
    // Read back with NO degradation: same record, same status, same isolation.
    expect(r).toEqual(record012 as TaskRecord)
    expect(r?.status).toBe('waiting_for_you')
    expect(r?.isolation).toBe('policy')
    expect(r?.version).toBe(1)
    // And no value invented for the cost, on the record or on the turn.
    expect(r && 'cost_ticks' in r).toBe(false)
    expect(r?.turns[0] && 'cost_ticks' in r.turns[0]).toBe(false)
    expect(r?.turns[0]?.cost_ticks).toBeUndefined()
  })

  test('cost_ticks: a non-negative integer round-trips, on the turn and the record', () => {
    const complete = { cost_ticks: 12_500_000, cost_basis: 'harness' as const }
    const r = sanitizeTaskRecord({
      ...validRecord,
      ...complete,
      cost_turns: 1,
      turns: [{ ...validRecord.turns[0], ...complete }],
    })
    expect(r?.cost_ticks).toBe(12_500_000)
    expect(r?.cost_basis).toBe('harness')
    expect(r?.cost_turns).toBe(1)
    expect(r?.turns[0]?.cost_ticks).toBe(12_500_000)
    expect(r?.turns[0]?.cost_basis).toBe('harness')
    // A truthful zero is a value, not an absence.
    const free = sanitizeTaskRecord({
      ...validRecord,
      cost_ticks: 0,
      cost_basis: 'harness',
      cost_turns: 1,
    })
    expect(free?.cost_ticks).toBe(0)
    expect(free && 'cost_ticks' in free).toBe(true)
  })

  test('cost_ticks: anything not a non-negative integer drops the key, never a 0', () => {
    for (const cost_ticks of [
      1.5,
      -1,
      -0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2,
      '12500',
      null,
      {},
      [12_500],
      true,
    ]) {
      const r = sanitizeTaskRecord({
        ...validRecord,
        cost_ticks,
        turns: [{ ...validRecord.turns[0], cost_ticks }],
      })
      expect(r).not.toBeNull()
      // Dropped, NOT degraded to 0: a 0 would read as "this task was free".
      expect(r && 'cost_ticks' in r).toBe(false)
      expect(r?.cost_ticks).toBeUndefined()
      expect(r?.turns[0] && 'cost_ticks' in r.turns[0]).toBe(false)
    }
  })

  test('cost_basis: the two known provenances round-trip, on the turn and the record', () => {
    for (const cost_basis of ['harness', 'lower_bound'] as const) {
      const r = sanitizeTaskRecord({
        ...validRecord,
        cost_ticks: 12_500_000,
        // One turn on the record, so the coverage is 1: see the bound below.
        cost_turns: 1,
        cost_basis,
        turns: [{ ...validRecord.turns[0], cost_ticks: 12_500_000, cost_basis }],
      })
      expect(r?.cost_basis).toBe(cost_basis)
      expect(r?.cost_turns).toBe(1)
      expect(r?.turns[0]?.cost_basis).toBe(cost_basis)
    }
  })

  test('cost_basis: a provenance nobody can name is never guessed — and takes the figure with it', () => {
    for (const cost_basis of ['invoice', 'HARNESS', '', 1, null, {}, true]) {
      const r = sanitizeTaskRecord({
        ...validRecord,
        cost_ticks: 12_500_000,
        cost_basis,
        cost_turns: 1,
        turns: [{ ...validRecord.turns[0], cost_ticks: 12_500_000, cost_basis }],
      })
      expect(r).not.toBeNull()
      // Never guessed, and never kept alone: an uninterpretable figure is
      // worse than none (see the coupling test below).
      expect(r && 'cost_basis' in r).toBe(false)
      expect(r && 'cost_ticks' in r).toBe(false)
      expect(r?.turns[0] && 'cost_basis' in r.turns[0]).toBe(false)
      expect(r?.turns[0] && 'cost_ticks' in r.turns[0]).toBe(false)
    }
  })

  test('cost_turns is bounded by the turns the record actually keeps', () => {
    // The producer only ever writes a coverage it computed from the turns it
    // holds; this layer has to hold the same claim against a hand-edited or
    // future-written file, because the coverage is what makes a partial total
    // honest in the first place.
    const priced = { cost_ticks: 9, cost_basis: 'harness' as const }
    const oneTurn = { ...validRecord, ...priced, turns: [validRecord.turns[0]] }
    // A coverage matching the turns held: kept.
    expect(sanitizeTaskRecord({ ...oneTurn, cost_turns: 1 })?.cost_turns).toBe(1)
    for (const cost_turns of [0, 2, 999, TASK_TURNS_MAX + 1, -1]) {
      const r = sanitizeTaskRecord({ ...oneTurn, cost_turns })
      expect(r).not.toBeNull()
      // A total covering nothing, or covering more turns than exist, is not a
      // total: the whole trio goes.
      expect(r && 'cost_turns' in r).toBe(false)
      expect(r && 'cost_ticks' in r).toBe(false)
      expect(r && 'cost_basis' in r).toBe(false)
    }
    // A record with no turns at all can carry no coverage, hence no total.
    const empty = sanitizeTaskRecord({ ...validRecord, ...priced, cost_turns: 1, turns: [] })
    expect(empty && 'cost_ticks' in empty).toBe(false)
  })

  test('a negative zero is not a figure, on the turn or the record', () => {
    // -0 satisfies both Number.isSafeInteger and >= 0, so nothing else catches
    // it; a negative zero on a money field is a value nobody meant to write.
    const r = sanitizeTaskRecord({
      ...validRecord,
      cost_ticks: -0,
      cost_basis: 'harness',
      cost_turns: 1,
      turns: [{ ...validRecord.turns[0], cost_ticks: -0, cost_basis: 'harness' }],
    })
    expect(r && 'cost_ticks' in r).toBe(false)
    expect(r?.turns[0] && 'cost_ticks' in r.turns[0]).toBe(false)
    expect(r?.turns[0] && 'cost_basis' in r.turns[0]).toBe(false)
  })

  test('cost_ticks and cost_basis fall TOGETHER, in both directions', () => {
    // Half the fact is no fact. A turn keeping a figure whose provenance was
    // dropped would make two readers disagree about whether it carries a cost
    // — and that disagreement silently REPLACES the figure, instead of adding
    // to it, when the turn is resumed after an interrupt.
    const halves = [
      { cost_ticks: 4_000, cost_basis: 'invoice' },
      { cost_ticks: 4_000, cost_basis: undefined },
      { cost_ticks: 1.5, cost_basis: 'harness' },
      { cost_ticks: undefined, cost_basis: 'harness' },
    ]
    for (const half of halves) {
      const r = sanitizeTaskRecord({
        ...validRecord,
        ...half,
        cost_turns: 1,
        turns: [{ ...validRecord.turns[0], ...half }],
      })
      expect(r).not.toBeNull()
      expect(r && 'cost_ticks' in r).toBe(false)
      expect(r && 'cost_basis' in r).toBe(false)
      // The record's total is a TRIO: its coverage goes with the rest.
      expect(r && 'cost_turns' in r).toBe(false)
      expect(r?.turns[0] && 'cost_ticks' in r.turns[0]).toBe(false)
      expect(r?.turns[0] && 'cost_basis' in r.turns[0]).toBe(false)
    }
  })

  test('the record total needs all THREE of figure, coverage and provenance', () => {
    const r = sanitizeTaskRecord({
      ...validRecord,
      cost_ticks: 4_000,
      cost_basis: 'harness',
      // Coverage missing: a total nobody can tell the completeness of.
      cost_turns: undefined,
    })
    expect(r && 'cost_ticks' in r).toBe(false)
    expect(r && 'cost_basis' in r).toBe(false)
    expect(r && 'cost_turns' in r).toBe(false)
  })

  test('cost_basis and cost_turns never outlive the figure they describe', () => {
    const r = sanitizeTaskRecord({
      ...validRecord,
      // No cost_ticks at all, but a provenance and a coverage claiming to
      // describe one: a basis for a number that is not there says nothing.
      cost_basis: 'harness',
      cost_turns: 3,
      turns: [{ ...validRecord.turns[0], cost_basis: 'harness' }],
    })
    expect(r && 'cost_ticks' in r).toBe(false)
    expect(r && 'cost_basis' in r).toBe(false)
    expect(r && 'cost_turns' in r).toBe(false)
    expect(r?.turns[0] && 'cost_basis' in r.turns[0]).toBe(false)
  })

  test('cost_turns: a coverage that is not a count drops the whole total, never a 0', () => {
    for (const cost_turns of [1.5, -1, Number.NaN, '2', null, {}]) {
      const r = sanitizeTaskRecord({
        ...validRecord,
        cost_ticks: 100,
        cost_basis: 'harness',
        cost_turns,
      })
      expect(r).not.toBeNull()
      expect(r && 'cost_turns' in r).toBe(false)
      // A total whose completeness nobody can tell says nothing useful.
      expect(r && 'cost_ticks' in r).toBe(false)
      expect(r && 'cost_basis' in r).toBe(false)
    }
  })

  test('reason: a known code round-trips with its detail', () => {
    const reason = { code: 'review_blocked' as const, detail: 'review failed: agent timed out' }
    expect(sanitizeTaskRecord({ ...validRecord, reason })?.reason).toEqual(reason)
  })

  test('reason: an unknown code is dropped, never surfaced as a reason', () => {
    for (const reason of [
      { code: 'flaky_vibes', detail: 'x' },
      { code: 42 },
      { detail: 'no code' },
      'review_blocked',
      null,
    ]) {
      const r = sanitizeTaskRecord({ ...validRecord, reason })
      expect(r).not.toBeNull()
      expect(r && 'reason' in r).toBe(false)
    }
  })

  test('heartbeat_at: absent claims nothing, a plain stamp round-trips', () => {
    // A record written before the semantic watchdog existed carries no beat,
    // and absence must read as "nothing known", never as "the agent is dead".
    const none = sanitizeTaskRecord(validRecord)
    expect(none && 'heartbeat_at' in none).toBe(false)
    const beating = sanitizeTaskRecord({ ...validRecord, heartbeat_at: '2026-08-19T10:00:00.000Z' })
    expect(beating?.heartbeat_at).toBe('2026-08-19T10:00:00.000Z')
  })

  test('heartbeat_at: anything that is not a plain bounded string is dropped', () => {
    for (const heartbeat_at of [42, null, {}, [], '', false]) {
      const r = sanitizeTaskRecord({ ...validRecord, heartbeat_at })
      expect(r).not.toBeNull()
      expect(r && 'heartbeat_at' in r).toBe(false)
    }
    const long = sanitizeTaskRecord({ ...validRecord, heartbeat_at: 'z'.repeat(5000) })
    expect(long?.heartbeat_at).toHaveLength(TASK_TIMESTAMP_MAX)
  })

  test('baseline_sha: a 0.12 record has none, and the reader falls back on base...HEAD', () => {
    // FROZEN fixture of a record as codesema 0.12 wrote it: no `baseline_sha`
    // and no `created_branch` key anywhere, because neither existed yet.
    const record012 = {
      version: 1,
      id: 'c3d4e5f6a7b8',
      title: 'Paginate the journal',
      status: 'review_ok',
      base: 'develop',
      branch: 'codesema/task-paginate-the-journal',
      worktree: '/repo/.codesema/worktrees/c3d4e5f6a7b8',
      agent_session_id: null,
      turns: [],
      review_ref: null,
      work_ms: 0,
      wait_ms: 0,
      auto_ship: false,
      work_on: false,
      isolation: 'policy',
      created_at: '2026-08-14T09:00:00.000Z',
      updated_at: '2026-08-14T09:04:00.000Z',
    }
    const r = sanitizeTaskRecord(structuredClone(record012))
    expect(r).toEqual(record012 as TaskRecord)
    expect(r && 'baseline_sha' in r).toBe(false)
    expect(r && 'created_branch' in r).toBe(false)
    expect(r && 'head_sha' in r).toBe(false)
    expect(r?.version).toBe(1)
  })

  test('baseline_sha: a git object name round-trips, normalized', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567'
    expect(sanitizeTaskRecord({ ...validRecord, baseline_sha: sha })?.baseline_sha).toBe(sha)
    expect(
      sanitizeTaskRecord({ ...validRecord, baseline_sha: `  ${sha.toUpperCase()}  ` })
        ?.baseline_sha,
    ).toBe(sha)
    // A sha256 repo's 64 chars are a valid object name too.
    const sha256 = 'a'.repeat(64)
    expect(sanitizeTaskRecord({ ...validRecord, baseline_sha: sha256 })?.baseline_sha).toBe(sha256)
  })

  test('baseline_sha: anything that is not an object name drops the key, never throws', () => {
    for (const baseline_sha of [
      '',
      '   ',
      'HEAD',
      'main',
      'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0', // 65 chars
      'abc123', // 6 chars: too short to name anything
      '0123456789abcdef; rm -rf /',
      42,
      null,
      { sha: '0123456789abcdef0123456789abcdef01234567' },
    ]) {
      const r = sanitizeTaskRecord({ ...validRecord, baseline_sha })
      expect(r).not.toBeNull()
      expect(r && 'baseline_sha' in r).toBe(false)
    }
  })

  test('head_sha: same whitelist as the baseline, and absent when it cannot be trusted', () => {
    const sha = '89abcdef0123456789abcdef0123456789abcdef'
    expect(
      sanitizeTaskRecord({ ...validRecord, head_sha: `  ${sha.toUpperCase()} ` })?.head_sha,
    ).toBe(sha)
    // A record that never knew where it left its branch says nothing — and a
    // rebuild then makes no claim about what it finds there, rather than
    // comparing against a value it made up.
    expect(sanitizeTaskRecord(validRecord)?.head_sha).toBeUndefined()
    for (const head_sha of ['', 'HEAD', 'main', 'abc123', 42, null, { sha }]) {
      const r = sanitizeTaskRecord({ ...validRecord, head_sha })
      expect(r).not.toBeNull()
      expect(r && 'head_sha' in r).toBe(false)
    }
  })

  test('created_branch: absent unless TRUE, because absent is what is safe to act on', () => {
    // A reader deciding whether a branch may be deleted must never infer "ours"
    // from a missing or unusable value.
    expect(sanitizeTaskRecord({ ...validRecord, created_branch: true })?.created_branch).toBe(true)
    for (const created_branch of [false, 'true', 1, null, undefined, {}]) {
      const r = sanitizeTaskRecord({ ...validRecord, created_branch })
      expect(r).not.toBeNull()
      expect(r && 'created_branch' in r).toBe(false)
    }
  })

  test('reason: an over-long detail is truncated, the record stays valid', () => {
    const r = sanitizeTaskRecord({
      ...validRecord,
      reason: { code: 'forge_unreachable', detail: 'y'.repeat(TASK_EVENT_DATA_STRING_MAX + 100) },
    })
    expect(r?.reason?.code).toBe('forge_unreachable')
    expect(r?.reason?.detail).toHaveLength(TASK_EVENT_DATA_STRING_MAX)
  })

  test('queue_position is derived, never persisted: a value found on disk is dropped', () => {
    // The field exists on the type (the server sets it when it SERVES a
    // listing) but the store never writes it, so anything sitting in a
    // task.json is stale by construction — or hand-written.
    const r = sanitizeTaskRecord({ ...validRecord, queue_position: 7 })
    expect(r).not.toBeNull()
    expect(r && 'queue_position' in r).toBe(false)
    // And its absence is the honest default of a record nobody decorated.
    expect(sanitizeTaskRecord(validRecord)?.queue_position).toBeUndefined()
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

describe('sanitizeTaskRecord — issue binding (T2.4)', () => {
  test('a record with issue + issue_snapshot round-trips unchanged', () => {
    const withIssue = { ...validRecord, issue: validIssue, issue_snapshot: validSnapshot }
    expect(sanitizeTaskRecord(structuredClone(withIssue))).toEqual(withIssue)
  })

  test('record 0.12 (or any task without a ticket) carries neither field', () => {
    // FROZEN fixture: no `issue`/`issue_snapshot` key anywhere, exactly what
    // every record written before this ticket (and every title+prompt task
    // created after it) looks like.
    const r = sanitizeTaskRecord(structuredClone(validRecord))
    expect(r).toEqual(validRecord)
    expect(r && 'issue' in r).toBe(false)
    expect(r && 'issue_snapshot' in r).toBe(false)
  })

  test('issue: a non-object drops the whole field rather than inventing one', () => {
    for (const junk of [null, 'github#42', 42, [], true]) {
      const r = sanitizeTaskRecord({ ...validRecord, issue: junk })
      expect(r && 'issue' in r).toBe(false)
    }
  })

  test('issue: an unknown forge drops the field', () => {
    const r = sanitizeTaskRecord({ ...validRecord, issue: { ...validIssue, forge: 'bitbucket' } })
    expect(r && 'issue' in r).toBe(false)
  })

  test('issue: iid must be a positive decimal integer, never a numeric string', () => {
    for (const iid of ['12', '12a', 1.5, '0x1f', 0, -1, Number.NaN, null, undefined]) {
      const r = sanitizeTaskRecord({ ...validRecord, issue: { ...validIssue, iid } })
      expect(r && 'issue' in r).toBe(false)
    }
    // A genuine positive integer passes, whatever its magnitude within safety.
    expect(
      sanitizeTaskRecord({ ...validRecord, issue: { ...validIssue, iid: 1 } })?.issue?.iid,
    ).toBe(1)
  })

  test('issue: url must be an http(s) URL', () => {
    for (const url of ['not a url', 'ftp://example.com/1', '', 'javascript:alert(1)']) {
      const r = sanitizeTaskRecord({ ...validRecord, issue: { ...validIssue, url } })
      expect(r && 'issue' in r).toBe(false)
    }
  })

  test('issue: project and url are truncated to their bounds, never rejected for length', () => {
    const longProject = 'p'.repeat(TASK_ISSUE_PROJECT_MAX + 50)
    const longUrl = `https://example.com/${'x'.repeat(TASK_ISSUE_URL_MAX)}`
    const r = sanitizeTaskRecord({
      ...validRecord,
      issue: { ...validIssue, project: longProject, url: longUrl },
    })
    expect(r?.issue?.project.length).toBe(TASK_ISSUE_PROJECT_MAX)
    expect(r?.issue?.url.length).toBe(TASK_ISSUE_URL_MAX)
  })

  test('issue_snapshot: a non-object drops the field, never throws', () => {
    for (const junk of [null, 'a hash', 42, [], true]) {
      const r = sanitizeTaskRecord({ ...validRecord, issue_snapshot: junk })
      expect(r && 'issue_snapshot' in r).toBe(false)
    }
  })

  test('issue_snapshot: body_hash must be a correctly-tagged sha256 digest, or the field is dropped', () => {
    const upper = `${TICKET_BODY_HASH_TAG}:${'A'.repeat(64)}`
    for (const body_hash of [
      '',
      'not-hex',
      'a'.repeat(64), // bare hash, no tag at all
      `${TICKET_BODY_HASH_TAG}:${'a'.repeat(63)}`,
      `${TICKET_BODY_HASH_TAG}:${'a'.repeat(65)}`,
      `sha256:t1:${'a'.repeat(64)}`, // a DIFFERENT (prior) scheme tag, not the one this build produces
      upper,
    ]) {
      const r = sanitizeTaskRecord({
        ...validRecord,
        issue_snapshot: { ...validSnapshot, body_hash },
      })
      // Uppercase hex is lower-cased and accepted; everything else drops the snapshot.
      if (body_hash === upper) {
        expect(r?.issue_snapshot?.body_hash).toBe(FAKE_BODY_HASH)
      } else {
        expect(r && 'issue_snapshot' in r).toBe(false)
      }
    }
  })

  // T2.4 adversarial review (mineur): `section_hashes` is a BREAKDOWN of
  // `body_hash`, not a second gate — its own field is optional and degrades
  // on its own (only that key drops), the surrounding snapshot must not.
  // `body_hash` alone must keep reconciliation working: dropping the whole
  // snapshot on this field's malformation would silently retire edit
  // detection forever for any producer that wrote a spec-conforming
  // snapshot without ever emitting section_hashes.
  test('issue_snapshot: section_hashes must be a full, correctly-tagged set, or ONLY that field drops', () => {
    for (const section_hashes of [
      null,
      'not-an-object',
      {},
      { context: FAKE_BODY_HASH, goal: FAKE_BODY_HASH, scope: FAKE_BODY_HASH }, // out_of_scope missing
      {
        context: FAKE_BODY_HASH,
        goal: FAKE_BODY_HASH,
        scope: FAKE_BODY_HASH,
        out_of_scope: 'not-a-hash',
      },
    ]) {
      const r = sanitizeTaskRecord({
        ...validRecord,
        issue_snapshot: { ...validSnapshot, section_hashes },
      })
      // The snapshot survives, with body_hash and criteria intact — only
      // section_hashes itself is gone.
      expect(r?.issue_snapshot?.body_hash).toBe(FAKE_BODY_HASH)
      expect(r?.issue_snapshot).not.toHaveProperty('section_hashes')
    }
  })

  test('issue_snapshot: a fully valid section_hashes IS kept', () => {
    const r = sanitizeTaskRecord({ ...validRecord, issue_snapshot: validSnapshot })
    expect(r?.issue_snapshot?.section_hashes).toEqual(validSnapshot.section_hashes)
  })

  test('issue_snapshot: raw_body_hash is optional and independently whitelisted', () => {
    const withoutRaw = { ...validSnapshot } as Record<string, unknown>
    delete withoutRaw.raw_body_hash
    const r1 = sanitizeTaskRecord({ ...validRecord, issue_snapshot: withoutRaw })
    expect(r1 && 'issue_snapshot' in r1).toBe(true)
    expect(r1?.issue_snapshot && 'raw_body_hash' in r1.issue_snapshot).toBe(false)

    // A malformed raw_body_hash drops ONLY that field — never the snapshot.
    const r2 = sanitizeTaskRecord({
      ...validRecord,
      issue_snapshot: { ...validSnapshot, raw_body_hash: 'not-a-hash' },
    })
    expect(r2 && 'issue_snapshot' in r2).toBe(true)
    expect(r2?.issue_snapshot && 'raw_body_hash' in r2.issue_snapshot).toBe(false)
    expect(r2?.issue_snapshot?.body_hash).toBe(FAKE_BODY_HASH)
  })

  test('issue_snapshot: oversized criteria are truncated to the ticket bound, not refused', () => {
    const many = Array.from({ length: TICKET_CRITERIA_MAX + 20 }, (_, i) => ({
      text: `WHEN input ${i} THE SYSTEM SHALL respond`,
    }))
    const r = sanitizeTaskRecord({
      ...validRecord,
      issue_snapshot: { ...validSnapshot, criteria: many },
    })
    expect(r?.issue_snapshot?.criteria.length).toBe(TICKET_CRITERIA_MAX)
  })

  test('issue_snapshot: an unreadable taken_at falls back to now rather than dropping the snapshot', () => {
    const r = sanitizeTaskRecord({
      ...validRecord,
      issue_snapshot: { ...validSnapshot, taken_at: 42 },
    })
    expect(r?.issue_snapshot?.body_hash).toBe(FAKE_BODY_HASH)
    expect(typeof r?.issue_snapshot?.taken_at).toBe('string')
  })
})

describe('sanitizeTaskRecord — hub ticket binding', () => {
  test('a record with hub_ticket round-trips unchanged', () => {
    const withTicket = { ...validRecord, hub_ticket: validHubTicket }
    expect(sanitizeTaskRecord(structuredClone(withTicket))).toEqual(withTicket)
  })

  test('hub_ticket without a url round-trips unchanged (url is optional)', () => {
    const { url: _drop, ...withoutUrl } = validHubTicket
    const withTicket = { ...validRecord, hub_ticket: withoutUrl }
    expect(sanitizeTaskRecord(structuredClone(withTicket))).toEqual(withTicket)
  })

  test('a record without hub_ticket carries no key, same as any record predating this field', () => {
    const r = sanitizeTaskRecord(structuredClone(validRecord))
    expect(r).toEqual(validRecord)
    expect(r && 'hub_ticket' in r).toBe(false)
  })

  test('hub_ticket: a non-object drops the whole field rather than inventing one', () => {
    for (const junk of [null, 'tick-1', 42, [], true]) {
      const r = sanitizeTaskRecord({ ...validRecord, hub_ticket: junk })
      expect(r && 'hub_ticket' in r).toBe(false)
    }
  })

  test('hub_ticket: a missing or blank id drops the whole field: no usable identity', () => {
    for (const id of [undefined, '', '   ', 42, null]) {
      const r = sanitizeTaskRecord({ ...validRecord, hub_ticket: { ...validHubTicket, id } })
      expect(r && 'hub_ticket' in r).toBe(false)
    }
  })

  test('hub_ticket: id and title are truncated to their bounds, never rejected for length', () => {
    const r = sanitizeTaskRecord({
      ...validRecord,
      hub_ticket: {
        ...validHubTicket,
        id: 'i'.repeat(TASK_HUB_TICKET_ID_MAX + 50),
        title: 't'.repeat(TASK_TITLE_MAX + 50),
      },
    })
    expect(r?.hub_ticket?.id.length).toBe(TASK_HUB_TICKET_ID_MAX)
    expect(r?.hub_ticket?.title.length).toBe(TASK_TITLE_MAX)
  })

  test('hub_ticket_status: a known status round-trips beside its hub_ticket', () => {
    const withStatus = {
      ...validRecord,
      hub_ticket: validHubTicket,
      hub_ticket_status: 'mr_opened',
    }
    expect(sanitizeTaskRecord(structuredClone(withStatus))).toEqual(withStatus as TaskRecord)
  })

  test('hub_ticket_status: every status arm.ts knows round-trips, so the local list cannot lag', () => {
    // The runtime set in tasks.ts is spelled locally (importing arm.ts's own
    // would cycle); this loop is the lock that keeps the two identical.
    for (const status of ARM_TICKET_STATUSES) {
      const r = sanitizeTaskRecord({
        ...validRecord,
        hub_ticket: validHubTicket,
        hub_ticket_status: status,
      })
      expect(r?.hub_ticket_status).toBe(status)
    }
  })

  test('hub_ticket_status: an unknown value is dropped alone, the ticket itself survives', () => {
    for (const junk of ['not-a-status', '', 42, null, {}]) {
      const r = sanitizeTaskRecord({
        ...validRecord,
        hub_ticket: validHubTicket,
        hub_ticket_status: junk,
      })
      expect(r?.hub_ticket).toEqual(validHubTicket)
      expect(r && 'hub_ticket_status' in r).toBe(false)
    }
  })

  test('hub_ticket_status: dropped without a hub_ticket to belong to', () => {
    const r = sanitizeTaskRecord({ ...validRecord, hub_ticket_status: 'mr_opened' })
    expect(r && 'hub_ticket_status' in r).toBe(false)
  })

  test('hub_ticket: title degrades to an empty string rather than dropping the field', () => {
    const r = sanitizeTaskRecord({
      ...validRecord,
      hub_ticket: { id: validHubTicket.id, title: 42 },
    })
    expect(r?.hub_ticket).toEqual({ id: validHubTicket.id, title: '' })
  })

  test('hub_ticket: url must be an http(s) URL, or the key is simply omitted', () => {
    for (const url of ['not a url', 'ftp://example.com/1', 'javascript:alert(1)']) {
      const r = sanitizeTaskRecord({ ...validRecord, hub_ticket: { ...validHubTicket, url } })
      expect(r && r.hub_ticket && 'url' in r.hub_ticket).toBe(false)
    }
  })

  test('hub_ticket: url is truncated to its bound, never rejected for length', () => {
    const longUrl = `https://hub.local/${'x'.repeat(TASK_ISSUE_URL_MAX)}`
    const r = sanitizeTaskRecord({
      ...validRecord,
      hub_ticket: { ...validHubTicket, url: longUrl },
    })
    expect(r?.hub_ticket?.url?.length).toBe(TASK_ISSUE_URL_MAX)
  })
})

describe('sanitizeTaskRecord — legacy brain_ticket compat', () => {
  test('a record with only legacy brain_ticket normalizes to hub_ticket in the output', () => {
    const legacy = { ...validRecord, brain_ticket: validHubTicket }
    const r = sanitizeTaskRecord(structuredClone(legacy))
    expect(r?.hub_ticket).toEqual(validHubTicket)
    expect(r && 'brain_ticket' in r).toBe(false)
  })

  test('legacy brain_ticket goes through the same validation as hub_ticket: ids are truncated, not rejected', () => {
    const r = sanitizeTaskRecord({
      ...validRecord,
      brain_ticket: { ...validHubTicket, id: 'i'.repeat(TASK_HUB_TICKET_ID_MAX + 50) },
    })
    expect(r?.hub_ticket?.id.length).toBe(TASK_HUB_TICKET_ID_MAX)
  })

  test('when both brain_ticket and hub_ticket are present, hub_ticket wins', () => {
    const legacyTicket = { id: 'legacy-1', title: 'Legacy title' }
    const both = { ...validRecord, brain_ticket: legacyTicket, hub_ticket: validHubTicket }
    const r = sanitizeTaskRecord(structuredClone(both))
    expect(r?.hub_ticket).toEqual(validHubTicket)
  })
})

describe('sanitizeTaskRecord — top-level criteria (T2.5)', () => {
  const validCriterion = {
    id: acceptanceCriterionId(CRITERION_TEXT),
    text: CRITERION_TEXT,
  }

  test('a record with validated criteria round-trips unchanged', () => {
    const withCriteria = { ...validRecord, criteria: [validCriterion] }
    expect(sanitizeTaskRecord(structuredClone(withCriteria))).toEqual(withCriteria)
  })

  test('absence is the honest default: a record without the key keeps none', () => {
    const r = sanitizeTaskRecord(structuredClone(validRecord))
    expect(r && 'criteria' in r).toBe(false)
  })

  test('an empty or unusable list is dropped rather than stored as []', () => {
    for (const junk of [null, 'WHEN x THE SYSTEM SHALL y', 42, {}, true, []]) {
      const r = sanitizeTaskRecord({ ...validRecord, criteria: junk })
      expect(r && 'criteria' in r).toBe(false)
    }
  })

  test('unreadable entries are dropped and the rest kept, never throws', () => {
    const r = sanitizeTaskRecord({
      ...validRecord,
      criteria: [validCriterion, null, { text: '' }, validCriterion],
    })
    expect(r?.criteria).toEqual([validCriterion])
  })

  test('the list is capped at TICKET_CRITERIA_MAX', () => {
    const many = Array.from({ length: TICKET_CRITERIA_MAX + 20 }, (_, i) => ({
      text: `WHEN input ${i} THE SYSTEM SHALL respond`,
    }))
    const r = sanitizeTaskRecord({ ...validRecord, criteria: many })
    expect(r?.criteria?.length).toBe(TICKET_CRITERIA_MAX)
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

describe('TASK_STATUS_VALUES / isTaskStatus', () => {
  test('TASK_STATUS_VALUES names exactly the nine TaskStatus values', () => {
    const allStatuses: TaskStatus[] = [
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
    expect([...TASK_STATUS_VALUES].toSorted()).toEqual(allStatuses.toSorted())
  })

  test('isTaskStatus accepts every value TASK_STATUS_VALUES names, and nothing else', () => {
    for (const status of TASK_STATUS_VALUES) {
      expect(isTaskStatus(status)).toBe(true)
    }
    for (const junk of ['done', 'blocked', '', 42, null, undefined, {}]) {
      expect(isTaskStatus(junk)).toBe(false)
    }
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

  test("'merge' (T3.6) is a KNOWN type: its four condition lines are never dropped", () => {
    // The half of the union nothing else can see: a member declared on
    // `TaskEventType` but missing from `TASK_EVENT_TYPES` compiles fine and
    // makes `appendTaskEvent` throw on every merge line — D12's whole
    // "journaled one by one" promise, gone, with the CLI suite reporting only
    // a timeout somewhere downstream.
    const line = { ...validEvent, type: 'merge' as const, data: { name: 'condition_unmet' } }
    expect(sanitizeTaskEvent(structuredClone(line))).toEqual(line)
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
      'cost',
      'branch',
      'resource',
      // T1.3 (D4): adversarial review round 3, MINEUR — this list is the
      // explicit guard-rail on the exhaustiveness of TASK_EVENT_TYPES that TS
      // itself cannot check (a Set, not a Record); 'queue' was missing, so
      // this test passed green while never covering the member this ticket
      // actually added.
      'queue',
      'issue',
      'criteria',
      'post_merge_checks',
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

  test('the review_done payload survives whole: ref, summary and severity spread', () => {
    const data = {
      verdict: 'request_changes',
      findings_count: 3,
      ref: '/repo/.codesema/reviews/codesema-task-x-20260814-100000.json',
      summary: 'The retry loop never gives up.',
      severity_critical: 1,
      severity_major: 2,
    }
    const event = sanitizeTaskEvent({
      seq: 7,
      at: '2026-08-14T10:05:00.000Z',
      type: 'review_done',
      data,
    })
    // Flat scalars only: nothing here needs a nested payload, so nothing is
    // dropped and the card can render the review without reloading it.
    expect(event?.data).toEqual(data)
  })

  test('non-object data becomes an empty object', () => {
    expect(sanitizeTaskEvent({ ...validEvent, data: 'junk' })?.data).toEqual({})
    expect(sanitizeTaskEvent({ ...validEvent, data: [1, 2] })?.data).toEqual({})
    expect(sanitizeTaskEvent({ ...validEvent, data: undefined })?.data).toEqual({})
  })

  test('reason_code: a known code rides in its own field, data untouched', () => {
    const raw = {
      seq: 7,
      at: '2026-08-14T10:09:00.000Z',
      type: 'interrupted',
      data: { reason: 'shutdown' },
      reason_code: 'interrupted_by_user',
    }
    const event = sanitizeTaskEvent(raw)
    expect(event?.reason_code).toBe('interrupted_by_user')
    // The payload the producer already wrote is preserved BYTE FOR BYTE: the
    // code is added next to the message, it never edits it.
    expect(event?.data).toEqual({ reason: 'shutdown' })
  })

  test('reason_code: a 0.12 journal line carries none and stays readable', () => {
    const event = sanitizeTaskEvent(structuredClone(validEvent))
    expect(event).toEqual(validEvent)
    expect(event && 'reason_code' in event).toBe(false)
  })

  test('reason_code: an unknown or malformed code drops the key, never throws', () => {
    for (const reason_code of ['not_a_code', '', 42, null, {}, ['review_blocked']]) {
      const event = sanitizeTaskEvent({ ...validEvent, reason_code })
      expect(event).not.toBeNull()
      expect(event && 'reason_code' in event).toBe(false)
      // The line itself survives intact: an unnamed degradation is still a
      // degradation, and its message is still in data.
      expect(event?.data).toEqual(validEvent.data)
    }
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

describe('TaskIsolation microvm (0.11)', () => {
  const base = {
    id: 'a1b2c3d4e5f6',
    title: 'x',
    status: 'idle',
    base: 'main',
    branch: 'codesema/task-x',
  }

  test("'microvm' is kept as a promised containment", () => {
    expect(sanitizeTaskRecord({ ...base, isolation: 'microvm' })?.isolation).toBe('microvm')
  })

  test('an unknown isolation still degrades to policy (never a stronger claim)', () => {
    expect(sanitizeTaskRecord({ ...base, isolation: 'firecracker' })?.isolation).toBe('policy')
    expect(sanitizeTaskRecord({ ...base })?.isolation).toBe('policy')
  })

  test('runbook_sha and runbook_integrity are optional, whitelisted, and absent on an older record', () => {
    const older = sanitizeTaskRecord({ ...base }) as Record<string, unknown>
    expect('runbook_sha' in older).toBe(false)
    expect('runbook_integrity' in older).toBe(false)
    const verified = sanitizeTaskRecord({
      ...base,
      runbook_sha: '0123456789abcdef',
      runbook_integrity: true,
    })
    expect(verified?.runbook_sha).toBe('0123456789abcdef')
    expect(verified?.runbook_integrity).toBe(true)
    const broken = sanitizeTaskRecord({
      ...base,
      runbook_sha: 'nope',
      runbook_integrity: 'yes',
    }) as Record<string, unknown>
    expect('runbook_sha' in broken).toBe(false)
    expect('runbook_integrity' in broken).toBe(false)
    expect(sanitizeTaskRecord({ ...base, runbook_integrity: false })?.runbook_integrity).toBe(false)
  })
})

describe('sanitizeTaskVerification', () => {
  const valid: TaskVerification = {
    head_sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    runbook_sha: '0123456789abcdef',
    started_at: '2026-08-28T10:00:00.000Z',
    finished_at: '2026-08-28T10:03:00.000Z',
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
    integrity_ok: true,
    changed_dependency_files: [],
    error: null,
  }

  test('a valid verification round-trips unchanged', () => {
    expect(sanitizeTaskVerification(structuredClone(valid))).toEqual(valid)
  })

  test('non-object input: null', () => {
    expect(sanitizeTaskVerification(null)).toBeNull()
    expect(sanitizeTaskVerification('junk')).toBeNull()
    expect(sanitizeTaskVerification([])).toBeNull()
  })

  test('unknown status or unusable runbook sha: null (a verdict is never tied to nothing)', () => {
    expect(sanitizeTaskVerification({ ...valid, status: 'green' })).toBeNull()
    expect(sanitizeTaskVerification({ ...valid, runbook_sha: 'x' })).toBeNull()
    expect(sanitizeTaskVerification({ ...valid, runbook_sha: undefined })).toBeNull()
    for (const status of ['passed', 'failed', 'refused', 'error'] as const) {
      expect(sanitizeTaskVerification({ ...valid, status })?.status).toBe(status)
      expect(isTaskVerificationStatus(status)).toBe(true)
    }
    expect(isTaskVerificationStatus('running')).toBe(false)
  })

  test('a refused verification lists what changed and can never claim integrity', () => {
    const refused = sanitizeTaskVerification({
      ...valid,
      status: 'refused',
      checks: [],
      integrity_ok: true,
      changed_dependency_files: ['bun.lock', 'bun.lock', '', 7, 'package.json'],
    })
    expect(refused?.integrity_ok).toBe(false)
    expect(refused?.changed_dependency_files).toEqual(['bun.lock', 'package.json'])
    expect(refused?.checks).toEqual([])
  })

  test('integrity is a measurement: a missing or non-boolean field reads as not intact', () => {
    expect(sanitizeTaskVerification({ ...valid, integrity_ok: undefined })?.integrity_ok).toBe(
      false,
    )
    expect(sanitizeTaskVerification({ ...valid, integrity_ok: 'true' })?.integrity_ok).toBe(false)
  })

  test('checks follow the TaskCheckResult rules (unknown status skipped, tail cut from the front, list bounded)', () => {
    const out = sanitizeTaskVerification({
      ...valid,
      checks: [
        { command: 'bun test', status: 'green', exit_code: 0, duration_ms: 1, tail: '' },
        {
          command: 'bun test',
          status: 'passed',
          exit_code: 0,
          duration_ms: 1,
          tail: 'x'.repeat(TASK_CHECK_TAIL_MAX + 10),
        },
      ],
    })
    expect(out?.checks).toHaveLength(1)
    expect(out?.checks[0]?.tail).toHaveLength(TASK_CHECK_TAIL_MAX)
    const many = Array.from({ length: TASK_CHECKS_LIST_MAX + 3 }, () => valid.checks[0])
    expect(sanitizeTaskVerification({ ...valid, checks: many })?.checks).toHaveLength(
      TASK_CHECKS_LIST_MAX,
    )
  })

  test('error is bounded and null when blank; runbook sha is lowercased', () => {
    const out = sanitizeTaskVerification({
      ...valid,
      status: 'error',
      runbook_sha: '0123456789ABCDEF',
      error: 'e'.repeat(TASK_CHECKS_ERROR_MAX + 5),
    })
    expect(out?.runbook_sha).toBe('0123456789abcdef')
    expect(out?.error).toHaveLength(TASK_CHECKS_ERROR_MAX)
    expect(sanitizeTaskVerification({ ...valid, error: '   ' })?.error).toBeNull()
  })
})

// --- Cross tests: sanitizeTaskVerification output validates against the hub's
// published verification.schema.json, the body of
// POST /api/cli/tickets/:id/verification (TaskVerification plus
// idempotency_key). Same local validator as arm.test.ts's own cross tests
// (schema-validator.test-helper.ts): proves the SCHEMA against the
// SANITIZER, not a library's leniency.

const verificationSchemaErrors = (value: unknown): string[] =>
  validate(value, verificationBodySchema as Schema, verificationBodySchema as Schema)

const validVerificationRaw = {
  head_sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  runbook_sha: '0123456789abcdef',
  started_at: '2026-08-14T10:00:00.000Z',
  finished_at: '2026-08-14T10:03:00.000Z',
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
  integrity_ok: true,
  changed_dependency_files: [],
  error: 'the runner timed out',
}

describe('cross test: sanitizeTaskVerification output validates against verification.schema.json', () => {
  test('the full verification (checks non-empty, error and finished_at set) validates', () => {
    const sanitized = sanitizeTaskVerification(
      structuredClone(validVerificationRaw),
    ) as TaskVerification
    expect(verificationSchemaErrors({ ...sanitized, idempotency_key: 'idem-key-1' })).toEqual([])
  })

  test('a refused verification with finished_at and error both null validates', () => {
    const sanitized = sanitizeTaskVerification({
      ...validVerificationRaw,
      status: 'refused',
      checks: [],
      integrity_ok: false,
      changed_dependency_files: ['bun.lock'],
      finished_at: null,
      error: null,
    }) as TaskVerification
    expect(sanitized.finished_at).toBeNull()
    expect(sanitized.error).toBeNull()
    expect(verificationSchemaErrors({ ...sanitized, idempotency_key: 'idem-key-1' })).toEqual([])
  })
})

describe('reverse cross test: verification.schema.json is not looser than sanitizeTaskVerification accepts', () => {
  const BASE = {
    idempotency_key: 'idem-key-1',
    head_sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    runbook_sha: '0123456789abcdef',
    started_at: '2026-08-14T10:00:00.000Z',
    finished_at: null,
    status: 'passed',
    checks: [] as unknown[],
    integrity_ok: true,
    changed_dependency_files: [] as string[],
    error: null,
  }

  test('an unknown status is schema-invalid: sanitizeTaskVerification never emits one', () => {
    expect(verificationSchemaErrors({ ...BASE, status: 'green' })).not.toEqual([])
  })

  test('an empty head_sha is schema-invalid', () => {
    expect(verificationSchemaErrors({ ...BASE, head_sha: '' })).not.toEqual([])
  })

  test('a non-array checks is schema-invalid', () => {
    expect(verificationSchemaErrors({ ...BASE, checks: 'not-an-array' })).not.toEqual([])
  })
})

describe('anti-drift lock: verification.schema.json properties match TaskVerification plus idempotency_key', () => {
  test('the schema property set is exactly the sanitizer output keys plus idempotency_key', () => {
    const sanitized = sanitizeTaskVerification(
      structuredClone(validVerificationRaw),
    ) as TaskVerification
    const schemaKeys = Object.keys(
      (verificationBodySchema as unknown as { properties: Record<string, unknown> }).properties,
    ).toSorted()
    const sanitizerKeys = [...Object.keys(sanitized), 'idempotency_key'].toSorted()
    expect(schemaKeys).toEqual(sanitizerKeys)
  })
})

// The hub schema bounds head_sha (minLength 1) and started_at/finished_at
// (maxLength 40), but sanitizeTaskVerification does not itself enforce
// either: unlike sanitizeArmTicket's `id` (arm.ts), it never gates on an
// empty head_sha, and unlike runbook.ts's own isoOrNow it never caps a
// timestamp's length. A record shaped exactly like this can leave the CLI
// and be refused by the hub as a 422 (same bug class as arm.test.ts's
// documented run_id incident). Not fixed here: tasks.ts is out of scope for
// this task.
describe('sanitizeTaskVerification guards the fields the hub schema bounds', () => {
  test('a missing or empty head_sha refuses the whole record, never an empty string the hub would 422', () => {
    expect(sanitizeTaskVerification({ ...validVerificationRaw, head_sha: undefined })).toBeNull()
    expect(sanitizeTaskVerification({ ...validVerificationRaw, head_sha: '' })).toBeNull()
  })

  test('an over-length started_at or finished_at is cut to the hub bound (maxLength 40)', () => {
    const overLong = 'x'.repeat(41)
    const sanitized = sanitizeTaskVerification({
      ...validVerificationRaw,
      started_at: overLong,
      finished_at: overLong,
    }) as TaskVerification
    expect(sanitized.started_at).toBe(overLong.slice(0, 40))
    expect(sanitized.finished_at).toBe(overLong.slice(0, 40))
    expect(verificationSchemaErrors({ ...sanitized, idempotency_key: 'idem-key-1' })).toEqual([])
  })
})
