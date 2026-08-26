import { describe, expect, test } from 'bun:test'
import {
  ARM_BODY_MAX,
  ARM_BRANCH_MAX,
  ARM_ERROR_MESSAGE_MAX,
  ARM_EVENT_TYPE_MAX,
  ARM_ID_MAX,
  ARM_IDEMPOTENCY_KEY_MAX,
  ARM_ISSUE_IID_MAX,
  ARM_ISSUE_URL_MAX,
  ARM_LABEL_MAX,
  ARM_MR_IID_MAX,
  ARM_MR_URL_MAX,
  ARM_PROMPT_MAX,
  ARM_REPO_URL_MAX,
  ARM_RUN_ID_MAX,
  ARM_STATUS_MAX,
  ARM_TIMESTAMP_MAX,
  ARM_TITLE_MAX,
  armTicketSchema,
  armTransitionSchema,
  sanitizeArmClaimResult,
  sanitizeArmEvent,
  sanitizeArmTicket,
  sanitizeArmTicketRequest,
  sanitizeArmTransition,
  type ArmClaimResult,
  type ArmEvent,
  type ArmIssueRef,
  type ArmTicket,
  type ArmTicketRequest,
  type ArmTransition,
} from './brain.js'

// --- Fixtures ----------------------------------------------------------------

const validIssueRef: ArmIssueRef = {
  iid: '42',
  url: 'https://github.com/getCodesema/codesema-cli/issues/42',
}

const validTicketRequest: ArmTicketRequest = {
  id: 'req-1',
  repo_remote_url: 'https://github.com/getCodesema/codesema-cli.git',
  prompt: 'Add rate limiting to the public API',
  status: 'proposed',
  source_issue: validIssueRef,
  created_at: '2026-08-14T10:00:00.000Z',
}

const validTicket: ArmTicket = {
  id: 'tick-1',
  repo_remote_url: 'https://github.com/getCodesema/codesema-cli.git',
  title: 'Add rate limiting',
  body: 'Add a token bucket limiter to the public API.',
  status: 'in_progress',
  depends_on: null,
  executed_by: 'arm-worker-1',
  lease_expires_at: '2026-08-14T11:00:00.000Z',
  issue: validIssueRef,
  branch: 'codesema/task-add-rate-limiting',
  mr_iid: null,
  mr_url: null,
  created_at: '2026-08-14T10:00:00.000Z',
  updated_at: '2026-08-14T10:05:00.000Z',
}

const minimalTransition: ArmTransition = {
  type: 'mr_opened',
  idempotency_key: 'tick-1:mr_opened:1',
  at: '2026-08-14T10:10:00.000Z',
}

const fullTransition: ArmTransition = {
  type: 'review_result',
  idempotency_key: 'tick-1:review_result:1',
  at: '2026-08-14T10:20:00.000Z',
  mr_iid: '7',
  mr_url: 'https://github.com/getCodesema/codesema-cli/pull/7',
  branch: 'codesema/task-add-rate-limiting',
  verdict: 'approve',
  findings_total: 3,
  merge_sha: 'a1b2c3d4e5f6a7b8c9d0',
  error_message: 'none',
  cost_ticks: 42,
}

const validEvent: ArmEvent = {
  run_id: 'run-1',
  at: '2026-08-14T10:00:00.000Z',
  event_type: 'turn_started',
  label: 'Turn 1 started',
}

const validClaimResult: ArmClaimResult = {
  ticket: validTicket,
  lease_expires_at: '2026-08-14T11:00:00.000Z',
}

test('published bounds are locked to their literal values', () => {
  expect(ARM_ID_MAX).toBe(64)
  expect(ARM_REPO_URL_MAX).toBe(500)
  expect(ARM_TITLE_MAX).toBe(200)
  expect(ARM_BODY_MAX).toBe(20_000)
  expect(ARM_PROMPT_MAX).toBe(20_000)
  expect(ARM_STATUS_MAX).toBe(100)
  expect(ARM_BRANCH_MAX).toBe(200)
  expect(ARM_MR_IID_MAX).toBe(64)
  expect(ARM_MR_URL_MAX).toBe(2_000)
  expect(ARM_ISSUE_IID_MAX).toBe(64)
  expect(ARM_ISSUE_URL_MAX).toBe(500)
  expect(ARM_TIMESTAMP_MAX).toBe(40)
  expect(ARM_IDEMPOTENCY_KEY_MAX).toBe(200)
  expect(ARM_ERROR_MESSAGE_MAX).toBe(2_000)
  expect(ARM_RUN_ID_MAX).toBe(64)
  expect(ARM_EVENT_TYPE_MAX).toBe(100)
  expect(ARM_LABEL_MAX).toBe(500)
})

// `sanitizeArmIssueRef` is a private helper (same doctrine as tasks.ts's own
// `sanitizeIssueRef`, also unexported): it is covered here only through its
// two callers, `sanitizeArmTicketRequest.source_issue` and
// `sanitizeArmTicket.issue` below, never in isolation.

// --- sanitizeArmTicketRequest --------------------------------------------------

describe('sanitizeArmTicketRequest', () => {
  test('a valid request round-trips unchanged', () => {
    expect(sanitizeArmTicketRequest(structuredClone(validTicketRequest))).toEqual(
      validTicketRequest,
    )
  })

  test('source_issue: null round-trips unchanged', () => {
    const withoutIssue = { ...validTicketRequest, source_issue: null }
    expect(sanitizeArmTicketRequest(structuredClone(withoutIssue))).toEqual(withoutIssue)
  })

  test('non-object input: null', () => {
    expect(sanitizeArmTicketRequest(null)).toBeNull()
    expect(sanitizeArmTicketRequest(undefined)).toBeNull()
    expect(sanitizeArmTicketRequest('junk')).toBeNull()
    expect(sanitizeArmTicketRequest(42)).toBeNull()
    expect(sanitizeArmTicketRequest([])).toBeNull()
  })

  test('a missing or blank id: no usable identity, null', () => {
    for (const id of [undefined, '', '   ', 42, null]) {
      expect(sanitizeArmTicketRequest({ ...validTicketRequest, id })).toBeNull()
    }
  })

  test('status is a free-form string: an unrecognized value is kept, never rejected', () => {
    const r = sanitizeArmTicketRequest({ ...validTicketRequest, status: 'some-future-status' })
    expect(r?.status).toBe('some-future-status')
  })

  test('an unusable source_issue drops only that field, never the whole request', () => {
    const r = sanitizeArmTicketRequest({ ...validTicketRequest, source_issue: { iid: '1' } })
    expect(r).not.toBeNull()
    expect(r?.source_issue).toBeNull()
  })

  test('repo_remote_url, prompt and status are truncated, never rejected for length', () => {
    const r = sanitizeArmTicketRequest({
      ...validTicketRequest,
      repo_remote_url: 'r'.repeat(ARM_REPO_URL_MAX + 50),
      prompt: 'p'.repeat(ARM_PROMPT_MAX + 50),
      status: 's'.repeat(ARM_STATUS_MAX + 50),
    })
    expect(r?.repo_remote_url.length).toBe(ARM_REPO_URL_MAX)
    expect(r?.prompt.length).toBe(ARM_PROMPT_MAX)
    expect(r?.status.length).toBe(ARM_STATUS_MAX)
  })

  test('missing created_at falls back to a generated stamp', () => {
    const at = sanitizeArmTicketRequest({
      ...validTicketRequest,
      created_at: undefined,
    })?.created_at
    expect(typeof at).toBe('string')
    expect(at?.length).toBeGreaterThan(0)
  })
})

// --- sanitizeArmTicket ----------------------------------------------------------

describe('sanitizeArmTicket', () => {
  test('a valid ticket round-trips unchanged', () => {
    expect(sanitizeArmTicket(structuredClone(validTicket))).toEqual(validTicket)
  })

  test('every nullable field set to null round-trips unchanged', () => {
    const allNull: ArmTicket = {
      ...validTicket,
      depends_on: null,
      executed_by: null,
      lease_expires_at: null,
      issue: null,
      branch: null,
      mr_iid: null,
      mr_url: null,
    }
    expect(sanitizeArmTicket(structuredClone(allNull))).toEqual(allNull)
  })

  test('non-object input: null', () => {
    expect(sanitizeArmTicket(null)).toBeNull()
    expect(sanitizeArmTicket(undefined)).toBeNull()
    expect(sanitizeArmTicket('junk')).toBeNull()
    expect(sanitizeArmTicket(42)).toBeNull()
    expect(sanitizeArmTicket([])).toBeNull()
  })

  test('a missing or blank id: no usable identity, null', () => {
    for (const id of [undefined, '', '   ', 42, null]) {
      expect(sanitizeArmTicket({ ...validTicket, id })).toBeNull()
    }
  })

  test('an unrecognized status drops the WHOLE record: never fabricated', () => {
    for (const status of ['not-a-status', '', undefined, null, 42]) {
      expect(sanitizeArmTicket({ ...validTicket, status })).toBeNull()
    }
  })

  test('all valid statuses are kept', () => {
    const statuses = [
      'proposed',
      'rejected',
      'published',
      'in_progress',
      'mr_opened',
      'ready_to_merge',
      'done',
      'failed',
      'already_implemented',
    ] as const
    for (const status of statuses) {
      expect(sanitizeArmTicket({ ...validTicket, status })?.status).toBe(status)
    }
  })

  test('title, body and repo_remote_url are truncated, never rejected for length', () => {
    const r = sanitizeArmTicket({
      ...validTicket,
      title: 't'.repeat(ARM_TITLE_MAX + 50),
      body: 'b'.repeat(ARM_BODY_MAX + 50),
      repo_remote_url: 'r'.repeat(ARM_REPO_URL_MAX + 50),
    })
    expect(r?.title.length).toBe(ARM_TITLE_MAX)
    expect(r?.body.length).toBe(ARM_BODY_MAX)
    expect(r?.repo_remote_url.length).toBe(ARM_REPO_URL_MAX)
  })

  test('depends_on and executed_by: a non-string or blank value becomes null, not the empty string', () => {
    for (const junk of [42, {}, [], '', '   ']) {
      const r = sanitizeArmTicket({ ...validTicket, depends_on: junk, executed_by: junk })
      expect(r?.depends_on).toBeNull()
      expect(r?.executed_by).toBeNull()
    }
  })

  test('an unusable issue ref becomes null, never keeps a half-populated one', () => {
    for (const issue of [{ iid: '1' }, { url: validIssueRef.url }, { iid: '', url: '' }]) {
      expect(sanitizeArmTicket({ ...validTicket, issue })?.issue).toBeNull()
    }
  })

  test('a non-http(s) issue url becomes a null issue, not a half-populated one', () => {
    for (const url of ['not a url', 'ftp://example.com/1', 'javascript:alert(1)']) {
      const r = sanitizeArmTicket({ ...validTicket, issue: { ...validIssueRef, url } })
      expect(r?.issue).toBeNull()
    }
  })

  test('a valid issue ref has its iid and url truncated to their bounds, never rejected for length', () => {
    const r = sanitizeArmTicket({
      ...validTicket,
      issue: {
        iid: 'i'.repeat(ARM_ISSUE_IID_MAX + 50),
        url: `https://example.com/${'x'.repeat(ARM_ISSUE_URL_MAX)}`,
      },
    })
    expect(r?.issue?.iid.length).toBe(ARM_ISSUE_IID_MAX)
    expect(r?.issue?.url.length).toBe(ARM_ISSUE_URL_MAX)
  })

  test('mr_url must be an http(s) URL or it becomes null', () => {
    for (const url of ['not a url', 'ftp://example.com/1', 'javascript:alert(1)']) {
      expect(sanitizeArmTicket({ ...validTicket, mr_url: url })?.mr_url).toBeNull()
    }
    const r = sanitizeArmTicket({
      ...validTicket,
      mr_url: 'https://github.com/getCodesema/codesema-cli/pull/9',
    })
    expect(r?.mr_url).toBe('https://github.com/getCodesema/codesema-cli/pull/9')
  })

  test('missing created_at falls back to a generated stamp, updated_at falls back to created_at', () => {
    const r = sanitizeArmTicket({ ...validTicket, created_at: undefined, updated_at: undefined })
    expect(typeof r?.created_at).toBe('string')
    expect(r?.created_at.length).toBeGreaterThan(0)
    expect(r?.updated_at).toBe(r?.created_at)
  })

  test('created_at and updated_at are bounded, never left unbounded from hostile input', () => {
    const long = 'x'.repeat(ARM_TIMESTAMP_MAX + 500)
    const r = sanitizeArmTicket({ ...validTicket, created_at: long, updated_at: long })
    expect(r?.created_at.length).toBe(ARM_TIMESTAMP_MAX)
    expect(r?.updated_at.length).toBe(ARM_TIMESTAMP_MAX)
  })

  // A value with no LEADING or TRAILING whitespace of its own can still gain
  // one once truncated, when the cut lands right after an INTERNAL run of
  // whitespace: `'a'.repeat(ARM_ID_MAX - 1) + ' ' + 'b'.repeat(50)` trims to
  // itself unchanged, but slicing at ARM_ID_MAX keeps exactly the leading
  // run plus that one space. Every field below is NON_BLANK in
  // armTicketSchema, so a truncated trailing space is not merely untidy, it
  // is a value the sanitizer's own published schema would refuse.
  test('truncation never leaves a trailing space on a NON_BLANK field, even when the cut lands on an internal run of whitespace', () => {
    const idWithInternalSpace = `${'a'.repeat(ARM_ID_MAX - 1)} ${'b'.repeat(50)}`
    const timestampWithInternalSpace = `${'2'.repeat(ARM_TIMESTAMP_MAX - 1)} ${'x'.repeat(50)}`
    const r = sanitizeArmTicket({
      ...validTicket,
      id: idWithInternalSpace,
      depends_on: idWithInternalSpace,
      created_at: timestampWithInternalSpace,
      updated_at: timestampWithInternalSpace,
    })
    expect(r?.id).toBe(r?.id.trim())
    expect(r?.depends_on).toBe(r?.depends_on?.trim())
    expect(r?.created_at).toBe(r?.created_at.trim())
    expect(r?.updated_at).toBe(r?.updated_at.trim())
    expect(ticketSchemaErrors(r)).toEqual([])
  })
})

// --- sanitizeArmTransition -------------------------------------------------------

describe('sanitizeArmTransition', () => {
  test('a minimal transition (required fields only) round-trips unchanged', () => {
    expect(sanitizeArmTransition(structuredClone(minimalTransition))).toEqual(minimalTransition)
  })

  test('a full transition round-trips unchanged', () => {
    expect(sanitizeArmTransition(structuredClone(fullTransition))).toEqual(fullTransition)
  })

  test('non-object input: null', () => {
    expect(sanitizeArmTransition(null)).toBeNull()
    expect(sanitizeArmTransition(undefined)).toBeNull()
    expect(sanitizeArmTransition('junk')).toBeNull()
    expect(sanitizeArmTransition(42)).toBeNull()
    expect(sanitizeArmTransition([])).toBeNull()
  })

  test('an unrecognized type drops the WHOLE transition: never fabricated', () => {
    for (const type of ['not-a-type', '', undefined, null, 42]) {
      expect(sanitizeArmTransition({ ...minimalTransition, type })).toBeNull()
    }
  })

  test('all valid types are kept', () => {
    const types = ['mr_opened', 'review_result', 'merged', 'failed'] as const
    for (const type of types) {
      expect(sanitizeArmTransition({ ...minimalTransition, type })?.type).toBe(type)
    }
  })

  test('a missing or blank idempotency_key drops the WHOLE transition', () => {
    for (const idempotency_key of [undefined, '', '   ', 42, null]) {
      expect(sanitizeArmTransition({ ...minimalTransition, idempotency_key })).toBeNull()
    }
  })

  test('idempotency_key is truncated, never rejected for length', () => {
    const r = sanitizeArmTransition({
      ...minimalTransition,
      idempotency_key: 'k'.repeat(ARM_IDEMPOTENCY_KEY_MAX + 50),
    })
    expect(r?.idempotency_key.length).toBe(ARM_IDEMPOTENCY_KEY_MAX)
  })

  test('missing at falls back to a generated stamp', () => {
    const at = sanitizeArmTransition({ ...minimalTransition, at: undefined })?.at
    expect(typeof at).toBe('string')
    expect(at?.length).toBeGreaterThan(0)
  })

  test('an unrecognized verdict is omitted, not fabricated into a valid one', () => {
    const r = sanitizeArmTransition({ ...minimalTransition, verdict: 'not-a-verdict' })
    expect(r && 'verdict' in r).toBe(false)
  })

  test('all valid verdicts are kept', () => {
    const verdicts = ['approve', 'request_changes', 'comment'] as const
    for (const verdict of verdicts) {
      expect(sanitizeArmTransition({ ...minimalTransition, verdict })?.verdict).toBe(verdict)
    }
  })

  test('findings_total: a negative, float or non-numeric value is omitted, never coerced to 0', () => {
    for (const findings_total of [-1, 1.5, 'three', Number.NaN, -0]) {
      const r = sanitizeArmTransition({ ...minimalTransition, findings_total })
      expect(r && 'findings_total' in r).toBe(false)
    }
    expect(sanitizeArmTransition({ ...minimalTransition, findings_total: 0 })?.findings_total).toBe(
      0,
    )
  })

  test('cost_ticks: same predicate as findings_total, -0 refused explicitly', () => {
    for (const cost_ticks of [-1, 1.5, 'lots', Number.NaN, -0]) {
      const r = sanitizeArmTransition({ ...minimalTransition, cost_ticks })
      expect(r && 'cost_ticks' in r).toBe(false)
    }
    expect(sanitizeArmTransition({ ...minimalTransition, cost_ticks: 0 })?.cost_ticks).toBe(0)
  })

  test('merge_sha: whitelisted as hex, half a sha is omitted rather than kept truncated', () => {
    for (const merge_sha of ['not-hex', 'a1b2c3', 'g1b2c3d', '']) {
      const r = sanitizeArmTransition({ ...minimalTransition, merge_sha })
      expect(r && 'merge_sha' in r).toBe(false)
    }
    const r = sanitizeArmTransition({ ...minimalTransition, merge_sha: 'A1B2C3D' })
    expect(r?.merge_sha).toBe('a1b2c3d')
  })

  test('mr_url must be an http(s) URL or the field is omitted', () => {
    for (const mr_url of ['not a url', 'ftp://example.com/1']) {
      const r = sanitizeArmTransition({ ...minimalTransition, mr_url })
      expect(r && 'mr_url' in r).toBe(false)
    }
  })

  test('mr_iid, branch and error_message are truncated, never rejected for length', () => {
    const r = sanitizeArmTransition({
      ...minimalTransition,
      mr_iid: 'i'.repeat(ARM_MR_IID_MAX + 50),
      branch: 'b'.repeat(ARM_BRANCH_MAX + 50),
      error_message: 'e'.repeat(ARM_ERROR_MESSAGE_MAX + 50),
    })
    expect(r?.mr_iid?.length).toBe(ARM_MR_IID_MAX)
    expect(r?.branch?.length).toBe(ARM_BRANCH_MAX)
    expect(r?.error_message?.length).toBe(ARM_ERROR_MESSAGE_MAX)
  })

  // Same regression as sanitizeArmTicket's own: a cut landing right after an
  // INTERNAL run of whitespace must not leave a trailing space behind on a
  // NON_BLANK field.
  test('truncation never leaves a trailing space on a NON_BLANK field, even when the cut lands on an internal run of whitespace', () => {
    const keyWithInternalSpace = `${'k'.repeat(ARM_IDEMPOTENCY_KEY_MAX - 1)} ${'x'.repeat(50)}`
    const r = sanitizeArmTransition({
      ...minimalTransition,
      idempotency_key: keyWithInternalSpace,
      error_message: keyWithInternalSpace,
    })
    expect(r?.idempotency_key).toBe(r?.idempotency_key.trim())
    expect(r?.error_message).toBe(r?.error_message?.trim())
    expect(transitionSchemaErrors(r)).toEqual([])
  })
})

// --- sanitizeArmEvent -------------------------------------------------------------

describe('sanitizeArmEvent', () => {
  test('a valid event without a payload round-trips unchanged', () => {
    expect(sanitizeArmEvent(structuredClone(validEvent))).toEqual(validEvent)
  })

  test('a valid event with a payload round-trips unchanged', () => {
    const withPayload = { ...validEvent, payload: { turn: 1, ok: true, name: 'x' } }
    expect(sanitizeArmEvent(structuredClone(withPayload))).toEqual(withPayload)
  })

  test('non-object input: null', () => {
    expect(sanitizeArmEvent(null)).toBeNull()
    expect(sanitizeArmEvent(undefined)).toBeNull()
    expect(sanitizeArmEvent('junk')).toBeNull()
    expect(sanitizeArmEvent(42)).toBeNull()
    expect(sanitizeArmEvent([])).toBeNull()
  })

  test('a missing or blank run_id: no usable identity, null', () => {
    for (const run_id of [undefined, '', '   ', 42, null]) {
      expect(sanitizeArmEvent({ ...validEvent, run_id })).toBeNull()
    }
  })

  test('an empty or non-object payload is omitted rather than kept as {}', () => {
    for (const payload of [{}, null, 'nope', 42, []]) {
      const r = sanitizeArmEvent({ ...validEvent, payload })
      expect(r && 'payload' in r).toBe(false)
    }
  })

  test('payload: nested values dropped, strings truncated, keys capped', () => {
    const wide: Record<string, unknown> = {}
    for (let i = 0; i < 30; i++) {
      wide[`k${i}`] = i
    }
    const r = sanitizeArmEvent({
      ...validEvent,
      payload: {
        // `nested`/`list` are dropped WITHOUT counting against the cap (they
        // never reach `out`), so they must come before `wide` in insertion
        // order for this test to actually exercise that rule rather than
        // merely observing `wide` alone exhaust the cap first.
        nested: { a: 1 },
        list: [1, 2, 3],
        long: 'x'.repeat(3_000),
        ...wide,
      },
    })
    expect(r?.payload && 'nested' in r.payload).toBe(false)
    expect(r?.payload && 'list' in r.payload).toBe(false)
    const long = r?.payload?.long
    expect(typeof long).toBe('string')
    expect((long as string).length).toBeLessThanOrEqual(2_000)
    expect(Object.keys(r?.payload ?? {}).length).toBeLessThanOrEqual(16)
  })

  test('event_type and label are truncated, never rejected for length', () => {
    const r = sanitizeArmEvent({
      ...validEvent,
      event_type: 't'.repeat(ARM_EVENT_TYPE_MAX + 50),
      label: 'l'.repeat(ARM_LABEL_MAX + 50),
    })
    expect(r?.event_type.length).toBe(ARM_EVENT_TYPE_MAX)
    expect(r?.label.length).toBe(ARM_LABEL_MAX)
  })

  test('run_id is truncated, never rejected for length', () => {
    const r = sanitizeArmEvent({ ...validEvent, run_id: 'r'.repeat(ARM_RUN_ID_MAX + 50) })
    expect(r?.run_id.length).toBe(ARM_RUN_ID_MAX)
  })

  test('missing at falls back to a generated stamp', () => {
    const at = sanitizeArmEvent({ ...validEvent, at: undefined })?.at
    expect(typeof at).toBe('string')
    expect(at?.length).toBeGreaterThan(0)
  })
})

// --- sanitizeArmClaimResult -------------------------------------------------------

describe('sanitizeArmClaimResult', () => {
  test('a valid claim result round-trips unchanged', () => {
    expect(sanitizeArmClaimResult(structuredClone(validClaimResult))).toEqual(validClaimResult)
  })

  test('non-object input: null', () => {
    expect(sanitizeArmClaimResult(null)).toBeNull()
    expect(sanitizeArmClaimResult(undefined)).toBeNull()
    expect(sanitizeArmClaimResult('junk')).toBeNull()
    expect(sanitizeArmClaimResult(42)).toBeNull()
    expect(sanitizeArmClaimResult([])).toBeNull()
  })

  test('an unusable ticket drops the WHOLE claim result', () => {
    expect(sanitizeArmClaimResult({ ...validClaimResult, ticket: { id: 'x' } })).toBeNull()
    expect(sanitizeArmClaimResult({ ...validClaimResult, ticket: null })).toBeNull()
  })

  test('missing lease_expires_at falls back to the lease carried by the ticket', () => {
    const r = sanitizeArmClaimResult({ ...validClaimResult, lease_expires_at: undefined })
    expect(r?.lease_expires_at).toBe(validClaimResult.ticket.lease_expires_at ?? undefined)
  })

  test('a claim with no lease anywhere is refused rather than expiring at once', () => {
    const ticket = { ...validClaimResult.ticket, lease_expires_at: null }
    expect(sanitizeArmClaimResult({ ticket, lease_expires_at: undefined })).toBeNull()
    expect(sanitizeArmClaimResult({ ticket, lease_expires_at: 42 })).toBeNull()
  })
})

// --- The published schemas ----------------------------------------------------

describe('armTicketSchema / armTransitionSchema', () => {
  test('both declare a draft 2020-12 schema with their own id', () => {
    expect(armTicketSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(armTicketSchema.$id).toBe('https://codesema.com/schemas/arm-ticket.json')
    expect(armTransitionSchema.$schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect(armTransitionSchema.$id).toBe('https://codesema.com/schemas/arm-transition.json')
  })

  test('every $ref in armTicketSchema resolves to a defined $def', () => {
    const refs: string[] = []
    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') {
        return
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') {
          refs.push(value)
        } else {
          walk(value)
        }
      }
    }
    walk(armTicketSchema)
    const defs = new Set(Object.keys(armTicketSchema.$defs))
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      expect(defs.has(ref.replace('#/$defs/', ''))).toBe(true)
    }
  })

  test('every required key exists in properties, on both schemas', () => {
    for (const schema of [armTicketSchema, armTransitionSchema]) {
      const props = new Set(Object.keys(schema.properties))
      for (const key of schema.required) {
        expect(props.has(key)).toBe(true)
      }
    }
    for (const def of Object.values(armTicketSchema.$defs)) {
      const d = def as { required?: readonly string[]; properties?: Record<string, unknown> }
      const defProps = new Set(Object.keys(d.properties ?? {}))
      for (const key of d.required ?? []) {
        expect(defProps.has(key)).toBe(true)
      }
    }
  })
})

// --- Cross tests: sanitizer output validates against the published schema, and
// the schema is not looser than what the sanitizer actually accepts. Deliberately
// local and tiny, like recap.test.ts's and index.test.ts's own validators: this
// proves the SCHEMA against the SANITIZER, not a library's leniency, and is the
// one automatic lock against a field added to one but not the other.

type Schema = Record<string, unknown>

function deref(schema: Schema, root: Schema): Schema {
  const ref = schema.$ref
  if (typeof ref !== 'string') {
    return schema
  }
  const defs = (root.$defs ?? {}) as Record<string, Schema>
  const key = ref.replace('#/$defs/', '')
  const target = Object.hasOwn(defs, key) ? (defs[key] ?? {}) : {}
  const { $ref: _drop, ...siblings } = schema
  return { ...target, ...siblings }
}

function typeMatches(node: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return node === null
    case 'string':
      return typeof node === 'string'
    case 'boolean':
      return typeof node === 'boolean'
    case 'integer':
      return typeof node === 'number' && Number.isInteger(node)
    case 'array':
      return Array.isArray(node)
    case 'object':
      return !!node && typeof node === 'object' && !Array.isArray(node)
    default:
      return false
  }
}

function validateString(node: string, s: Schema, path: string): string[] {
  const errors: string[] = []
  const length = [...node].length
  if (typeof s.maxLength === 'number' && length > s.maxLength) {
    errors.push(`${path}: maxLength`)
  }
  if (typeof s.minLength === 'number' && length < s.minLength) {
    errors.push(`${path}: minLength`)
  }
  if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(node)) {
    errors.push(`${path}: pattern`)
  }
  return errors
}

function validateNumber(node: number, s: Schema, path: string): string[] {
  const errors: string[] = []
  if (typeof s.minimum === 'number' && node < s.minimum) {
    errors.push(`${path}: minimum`)
  }
  if (typeof s.maximum === 'number' && node > s.maximum) {
    errors.push(`${path}: maximum`)
  }
  return errors
}

function validateObject(node: object, s: Schema, root: Schema, path: string): string[] {
  const errors: string[] = []
  const record = node as Record<string, unknown>
  const properties = (s.properties ?? {}) as Record<string, Schema>
  for (const key of (s.required ?? []) as string[]) {
    if (!Object.hasOwn(record, key)) {
      errors.push(`${path}.${key}: required`)
    }
  }
  for (const [key, value] of Object.entries(record)) {
    const child = Object.hasOwn(properties, key) ? properties[key] : undefined
    if (!child) {
      if (s.additionalProperties === false) {
        errors.push(`${path}.${key}: additionalProperties`)
      }
      continue
    }
    errors.push(...validate(value, child, root, `${path}.${key}`))
  }
  return errors
}

function validate(node: unknown, schema: Schema, root: Schema, path = '$'): string[] {
  const s = deref(schema, root)
  const types =
    typeof s.type === 'string' ? [s.type] : Array.isArray(s.type) ? (s.type as string[]) : []
  const hasAssertion = 'const' in s || 'enum' in s || types.length > 0 || Array.isArray(s.anyOf)
  if (!hasAssertion) {
    // A schema node that asserts NOTHING accepts every value that reaches it.
    // Fail loudly here instead of quietly proving nothing.
    throw new Error(`arm schema validator: '${path}' asserts nothing`)
  }
  const errors: string[] = []
  if ('const' in s && node !== s.const) {
    errors.push(`${path}: const`)
  }
  if (Array.isArray(s.enum) && !s.enum.includes(node)) {
    errors.push(`${path}: enum`)
  }
  if (Array.isArray(s.anyOf)) {
    const branches = s.anyOf as Schema[]
    if (!branches.some((branch) => validate(node, branch, root, path).length === 0)) {
      errors.push(`${path}: anyOf`)
    }
  }
  if (types.length === 0) {
    return errors
  }
  if (!types.some((type) => typeMatches(node, type))) {
    errors.push(`${path}: type`)
    return errors
  }
  if (typeof node === 'string') {
    errors.push(...validateString(node, s, path))
  } else if (typeof node === 'number') {
    errors.push(...validateNumber(node, s, path))
  } else if (Array.isArray(node)) {
    const items = s.items as Schema | undefined
    if (items) {
      node.forEach((item, i) => errors.push(...validate(item, items, root, `${path}[${i}]`)))
    }
  } else if (node && typeof node === 'object') {
    errors.push(...validateObject(node, s, root, path))
  }
  return errors
}

const ticketSchemaErrors = (value: unknown): string[] =>
  validate(value, armTicketSchema as unknown as Schema, armTicketSchema as unknown as Schema)

const transitionSchemaErrors = (value: unknown): string[] =>
  validate(
    value,
    armTransitionSchema as unknown as Schema,
    armTransitionSchema as unknown as Schema,
  )

describe('cross test: sanitizeArmTicket output validates against armTicketSchema', () => {
  test('the full nominal ticket validates', () => {
    expect(ticketSchemaErrors(sanitizeArmTicket(structuredClone(validTicket)))).toEqual([])
  })

  test('a ticket with every nullable field null validates', () => {
    const allNull = {
      ...validTicket,
      depends_on: null,
      executed_by: null,
      lease_expires_at: null,
      issue: null,
      branch: null,
      mr_iid: null,
      mr_url: null,
    }
    expect(ticketSchemaErrors(sanitizeArmTicket(allNull))).toEqual([])
  })

  test('hostile input, once sanitized, still validates', () => {
    const hostile = sanitizeArmTicket({
      id: 'tick-1',
      repo_remote_url: { nested: true },
      title: 42,
      body: [],
      status: 'in_progress',
      depends_on: 42,
      executed_by: {},
      lease_expires_at: [],
      issue: 'not-a-ref',
      branch: 42,
      mr_iid: {},
      mr_url: 'javascript:alert(1)',
      created_at: 'x'.repeat(500),
      updated_at: 'y'.repeat(500),
    })
    expect(ticketSchemaErrors(hostile)).toEqual([])
  })

  test('every valid status produces a validating ticket', () => {
    const statuses = [
      'proposed',
      'rejected',
      'published',
      'in_progress',
      'mr_opened',
      'ready_to_merge',
      'done',
      'failed',
      'already_implemented',
    ] as const
    for (const status of statuses) {
      expect(ticketSchemaErrors(sanitizeArmTicket({ ...validTicket, status }))).toEqual([])
    }
  })
})

describe('reverse cross test: armTicketSchema is not looser than sanitizeArmTicket accepts', () => {
  const BASE = {
    id: 'tick-1',
    repo_remote_url: '',
    title: '',
    body: '',
    status: 'proposed',
    depends_on: null,
    executed_by: null,
    lease_expires_at: null,
    issue: null,
    branch: null,
    mr_iid: null,
    mr_url: null,
    created_at: '2026-08-14T10:00:00.000Z',
    updated_at: '2026-08-14T10:00:00.000Z',
  }

  test('an empty id is schema-invalid: sanitizeArmTicket refuses the WHOLE record for it', () => {
    expect(ticketSchemaErrors({ ...BASE, id: '' })).not.toEqual([])
  })

  test('an unknown status is schema-invalid: sanitizeArmTicket never emits one', () => {
    expect(ticketSchemaErrors({ ...BASE, status: 'not-a-status' })).not.toEqual([])
  })

  test('an empty-string depends_on is schema-invalid: sanitizeArmTicket only ever emits null or a non-blank string', () => {
    expect(ticketSchemaErrors({ ...BASE, depends_on: '' })).not.toEqual([])
  })

  test('a missing key is schema-invalid: every key of ArmTicket is always present', () => {
    const { branch: _drop, ...missingBranch } = BASE
    expect(ticketSchemaErrors(missingBranch)).not.toEqual([])
  })

  test('an extra unknown key is schema-invalid: additionalProperties is false', () => {
    expect(ticketSchemaErrors({ ...BASE, extra: 'nope' })).not.toEqual([])
  })
})

describe('cross test: sanitizeArmTransition output validates against armTransitionSchema', () => {
  test('the minimal transition validates', () => {
    expect(
      transitionSchemaErrors(sanitizeArmTransition(structuredClone(minimalTransition))),
    ).toEqual([])
  })

  test('the full transition validates', () => {
    expect(transitionSchemaErrors(sanitizeArmTransition(structuredClone(fullTransition)))).toEqual(
      [],
    )
  })

  test('hostile input, once sanitized, still validates', () => {
    const hostile = sanitizeArmTransition({
      type: 'merged',
      idempotency_key: 'k'.repeat(500),
      at: 'x'.repeat(500),
      mr_iid: 42,
      mr_url: 'javascript:alert(1)',
      branch: {},
      verdict: 'not-a-verdict',
      findings_total: -5,
      merge_sha: 'NOT-HEX',
      error_message: [],
      cost_ticks: 'lots',
    })
    expect(transitionSchemaErrors(hostile)).toEqual([])
  })

  test('every valid type produces a validating transition', () => {
    const types = ['mr_opened', 'review_result', 'merged', 'failed'] as const
    for (const type of types) {
      expect(transitionSchemaErrors(sanitizeArmTransition({ ...minimalTransition, type }))).toEqual(
        [],
      )
    }
  })
})

describe('reverse cross test: armTransitionSchema is not looser than sanitizeArmTransition accepts', () => {
  const BASE = {
    type: 'mr_opened',
    idempotency_key: 'k1',
    at: '2026-08-14T10:00:00.000Z',
  }

  test('an empty idempotency_key is schema-invalid: sanitizeArmTransition refuses the WHOLE record for it', () => {
    expect(transitionSchemaErrors({ ...BASE, idempotency_key: '' })).not.toEqual([])
  })

  test('an unknown type is schema-invalid: sanitizeArmTransition never emits one', () => {
    expect(transitionSchemaErrors({ ...BASE, type: 'not-a-type' })).not.toEqual([])
  })

  test('an empty optional string is schema-invalid: sanitizeArmTransition omits rather than blanks it', () => {
    expect(transitionSchemaErrors({ ...BASE, branch: '' })).not.toEqual([])
  })

  test('a non-hex merge_sha is schema-invalid: sanitizeArmTransition whitelists, never truncates it', () => {
    expect(transitionSchemaErrors({ ...BASE, merge_sha: 'not-hex' })).not.toEqual([])
  })

  test('an extra unknown key is schema-invalid: additionalProperties is false', () => {
    expect(transitionSchemaErrors({ ...BASE, extra: 'nope' })).not.toEqual([])
  })
})
