import { describe, expect, test } from 'bun:test'
import {
  isTerminalReason,
  REASON_CODES,
  reasonCodeOf,
  sanitizeReasonCode,
  sanitizeTaskReason,
  TASK_EVENT_DATA_STRING_MAX,
  TASK_REASON_DETAIL_MAX,
  type ReasonCode,
} from './index.js'

/**
 * Decision D2's roster, spelled out here by hand ON PURPOSE: this literal is
 * the second copy the lock tests below compare the table against, so a rename
 * on either side is a failing test rather than a silent vocabulary change.
 */
const D2_CODES = [
  'checks_failed',
  'review_blocked',
  'criteria_unmet',
  'merge_conflict',
  'branch_diverged',
  'agent_error',
  'inactivity_timeout',
  'interrupted_by_user',
  'resource_busy',
  'forge_unreachable',
] as const

/** The arbitration this ticket committed to, code by code. */
const D2_TERMINAL: Record<(typeof D2_CODES)[number], boolean> = {
  checks_failed: true,
  review_blocked: true,
  criteria_unmet: true,
  merge_conflict: true,
  branch_diverged: true,
  agent_error: false,
  inactivity_timeout: false,
  interrupted_by_user: false,
  resource_busy: false,
  forge_unreachable: false,
}

describe('REASON_CODES', () => {
  test('locks every D2 code by NAME: adding a code passes, renaming one breaks', () => {
    // Membership, not equality: an eleventh code leaves this assertion green
    // (the contract is extensible) while dropping or renaming any of the ten
    // makes it red (the contract is never renamed).
    const names = REASON_CODES.map((entry) => entry.code)
    for (const code of D2_CODES) {
      expect(names).toContain(code)
    }
  })

  test('every entry carries an explicit terminal boolean and appears exactly once', () => {
    // Shape checks, deliberately size-agnostic: they keep holding for an
    // eleventh code, and they are what makes the table usable as a table.
    const names = REASON_CODES.map((entry) => entry.code)
    expect(new Set(names).size).toBe(names.length)
    for (const entry of REASON_CODES) {
      expect(typeof entry.terminal).toBe('boolean')
      expect(entry.code).not.toBe('')
    }
  })

  test('today the table is exactly D2: the ten codes, no more, no less', () => {
    // The snapshot of the CURRENT roster. Only a deliberate extension of D2
    // touches this line — never a rename, which the lock test above catches
    // first.
    expect(REASON_CODES.map((entry) => entry.code)).toEqual([...D2_CODES])
    expect(REASON_CODES).toHaveLength(10)
  })

  test('each code is classified the way this contract documents it', () => {
    for (const entry of REASON_CODES) {
      expect(entry.terminal).toBe(D2_TERMINAL[entry.code])
    }
    // Five of each: the work-must-change half and the run-must-change half.
    expect(REASON_CODES.filter((entry) => entry.terminal)).toHaveLength(5)
    expect(REASON_CODES.filter((entry) => !entry.terminal)).toHaveLength(5)
  })
})

describe('isTerminalReason', () => {
  test('answers the terminal declared in the table, for every code', () => {
    for (const entry of REASON_CODES) {
      expect(isTerminalReason(entry.code)).toBe(entry.terminal)
    }
  })

  test('a blocked review is terminal, an interrupted task is not', () => {
    expect(isTerminalReason('review_blocked')).toBe(true)
    expect(isTerminalReason('interrupted_by_user')).toBe(false)
  })

  test('an unknown code never claims to be terminal', () => {
    // Only reachable from an untyped caller; the honest default is the weaker
    // statement — we do not close a door we cannot see.
    expect(isTerminalReason('not_a_code' as ReasonCode)).toBe(false)
  })
})

describe('sanitizeReasonCode', () => {
  test('every code of the table survives verbatim', () => {
    for (const entry of REASON_CODES) {
      expect(sanitizeReasonCode(entry.code)).toBe(entry.code)
    }
  })

  test('an unknown or oddly typed value is null, never a throw', () => {
    for (const raw of [
      'checks_passed',
      'CHECKS_FAILED',
      ' checks_failed ',
      '',
      undefined,
      null,
      42,
      true,
      {},
      [],
      { code: 'checks_failed' },
      () => 'checks_failed',
    ]) {
      expect(() => sanitizeReasonCode(raw)).not.toThrow()
      expect(sanitizeReasonCode(raw)).toBeNull()
    }
  })
})

describe('reasonCodeOf', () => {
  test('reads both spellings, because both really exist in the wild', () => {
    // Producers write `reasonCode` (ShipOutcome, WorktreeLockBusyError); the
    // wire, the journal and anything read back from disk write `reason_code`.
    // A reader that knew one spelling would silently drop half the
    // degradations it exists to surface.
    expect(reasonCodeOf({ reasonCode: 'resource_busy' })).toBe('resource_busy')
    expect(reasonCodeOf({ reason_code: 'resource_busy' })).toBe('resource_busy')
    expect(
      reasonCodeOf(Object.assign(new Error('busy'), { reasonCode: 'forge_unreachable' })),
    ).toBe('forge_unreachable')
  })

  test('the producer spelling wins when a value carries both', () => {
    expect(reasonCodeOf({ reasonCode: 'agent_error', reason_code: 'checks_failed' })).toBe(
      'agent_error',
    )
  })

  test('anything that names no known code is null, never a throw', () => {
    for (const raw of [
      undefined,
      null,
      'resource_busy',
      42,
      {},
      new Error('plain'),
      { reasonCode: 'not_a_code' },
      { reason_code: 99 },
    ]) {
      expect(() => reasonCodeOf(raw)).not.toThrow()
      expect(reasonCodeOf(raw)).toBeNull()
    }
  })
})

describe('sanitizeTaskReason', () => {
  test('a code alone is a valid reason, with no detail key invented', () => {
    const reason = sanitizeTaskReason({ code: 'agent_error' })
    expect(reason).toEqual({ code: 'agent_error' })
    expect(reason && 'detail' in reason).toBe(false)
  })

  test('the producer message travels verbatim in detail', () => {
    expect(
      sanitizeTaskReason({ code: 'review_blocked', detail: 'review failed: agent timed out' }),
    ).toEqual({ code: 'review_blocked', detail: 'review failed: agent timed out' })
  })

  test('a detail longer than the bound is truncated, and the reason stays valid', () => {
    const reason = sanitizeTaskReason({
      code: 'forge_unreachable',
      detail: 'x'.repeat(TASK_REASON_DETAIL_MAX + 500),
    })
    expect(reason?.code).toBe('forge_unreachable')
    expect(reason?.detail).toHaveLength(TASK_REASON_DETAIL_MAX)
  })

  test('the detail bound is the flat-payload bound: a reason always fits an event', () => {
    // TASK_REASON_DETAIL_MAX is declared in reasons.ts to keep that module
    // dependency-free; this locks it to the value it mirrors.
    expect(TASK_REASON_DETAIL_MAX).toBe(TASK_EVENT_DATA_STRING_MAX)
  })

  test('an empty or blank detail is dropped rather than carried as noise', () => {
    expect(sanitizeTaskReason({ code: 'resource_busy', detail: '   ' })).toEqual({
      code: 'resource_busy',
    })
    expect(sanitizeTaskReason({ code: 'resource_busy', detail: 42 })).toEqual({
      code: 'resource_busy',
    })
  })

  test('an unknown, missing or malformed code is null, never a throw', () => {
    for (const raw of [
      null,
      undefined,
      'checks_failed',
      42,
      {},
      { detail: 'no code at all' },
      { code: 'not_a_code', detail: 'x' },
      { code: 42 },
    ]) {
      expect(() => sanitizeTaskReason(raw)).not.toThrow()
      expect(sanitizeTaskReason(raw)).toBeNull()
    }
  })
})
