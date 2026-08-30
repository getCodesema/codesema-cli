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

/**
 * What T3.6 ADDED to D2's ten (DP1 / DP2), kept as its own literal rather than
 * appended to `D2_CODES`: D2's roster is a historical fact that no later
 * ticket rewrites, and the by-NAME lock below has to keep asserting exactly
 * those ten. An extension shows up here, next to the ticket that made it.
 */
const T3_6_CODES = ['checks_unavailable', 'criteria_missing'] as const

/** What D26 added: an open judgment call blocks the automatic merge alone. */
const D26_CODES = ['criteria_judgment_open'] as const

/**
 * The whole table as it stands today, in DECLARATION order — which is not
 * `[...D2_CODES, ...T3_6_CODES, ...D26_CODES]`: the table groups the terminal
 * codes first, so T3.6's two and D26's one land in the middle, after
 * `branch_diverged`. Spelled out so the snapshot below really is a snapshot.
 */
const EXPECTED_CODES = [
  'checks_failed',
  'review_blocked',
  'criteria_unmet',
  'merge_conflict',
  'branch_diverged',
  'checks_unavailable',
  'criteria_missing',
  'criteria_judgment_open',
  'merge_strategy_unconfigured',
  'agent_error',
  'inactivity_timeout',
  'interrupted_by_user',
  'resource_busy',
  'forge_unreachable',
] as const

/** The arbitration each ticket committed to, code by code. */
const EXPECTED_TERMINAL: Record<(typeof EXPECTED_CODES)[number], boolean> = {
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
  // DP1 / DP2: waiting configures no checks and writes no criteria — what
  // both ask for is a person, so both are terminal.
  checks_unavailable: true,
  criteria_missing: true,
  // Waiting configures no merge strategy either: the way out is one setting,
  // then a retried merge.
  merge_strategy_unconfigured: true,
  // D26: waiting settles no judgment call — only a human, merging by hand,
  // does.
  criteria_judgment_open: true,
}

describe('REASON_CODES', () => {
  test('locks every D2 code by NAME: adding a code passes, renaming one breaks', () => {
    // Membership, not equality: T3.6's eleventh and twelfth codes left this
    // assertion green (the contract is extensible) while dropping or renaming
    // any of the ten makes it red (the contract is never renamed). That is not
    // a claim about the future any more — it is what actually happened when
    // `checks_unavailable` and `criteria_missing` were added.
    const names = REASON_CODES.map((entry) => entry.code)
    for (const code of D2_CODES) {
      expect(names).toContain(code)
    }
  })

  test('locks the codes T3.6 added by NAME too, on the same terms', () => {
    // Same doctrine applied to the extension itself: once minted, a code is
    // never renamed either — records and journals quote it verbatim.
    const names = REASON_CODES.map((entry) => entry.code)
    for (const code of T3_6_CODES) {
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

  test('today the table is D2 plus T3.6 plus the merge-strategy gate plus D26: fourteen codes', () => {
    // The snapshot of the CURRENT roster. Only a deliberate extension touches
    // this line — never a rename, which the two lock tests above catch first.
    expect(REASON_CODES.map((entry) => entry.code)).toEqual([...EXPECTED_CODES])
    expect(REASON_CODES).toHaveLength(14)
  })

  test('locks the code D26 added by NAME too, on the same terms', () => {
    const names = REASON_CODES.map((entry) => entry.code)
    for (const code of D26_CODES) {
      expect(names).toContain(code)
    }
  })

  test('each code is classified the way this contract documents it', () => {
    for (const entry of REASON_CODES) {
      expect(entry.terminal).toBe(EXPECTED_TERMINAL[entry.code])
    }
    // Nine terminal (D2's five plus `checks_unavailable`, `criteria_missing`,
    // `merge_strategy_unconfigured` and D26's `criteria_judgment_open`); the
    // retryable half is untouched at five.
    expect(REASON_CODES.filter((entry) => entry.terminal)).toHaveLength(9)
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

  test("T3.6's two codes are terminal: waiting configures no checks and writes no criteria", () => {
    // DP1 / DP2 spelled out as an assertion rather than left to the
    // table-wide loop above: these two are the ONLY codes of the vocabulary
    // whose classification a reader would plausibly guess wrong — nothing is
    // broken on the branch, so "retryable" looks tempting until you ask the
    // table's own question, "does waiting change anything?".
    expect(isTerminalReason('checks_unavailable')).toBe(true)
    expect(isTerminalReason('criteria_missing')).toBe(true)
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

  test("T3.6's codes survive sanitisation and keep the merge gate's own sentence", () => {
    // The whole point of DP1's "the code is ADDED to the message": the
    // discriminant ('unconfigured') rides the journal line, while the reason
    // a human reads keeps naming the way out.
    expect(
      sanitizeTaskReason({
        code: 'checks_unavailable',
        detail:
          "this repository configures no checks — configure them, set mergePolicy to 'human', or allow merging without checks",
      }),
    ).toEqual({
      code: 'checks_unavailable',
      detail:
        "this repository configures no checks — configure them, set mergePolicy to 'human', or allow merging without checks",
    })
    const bounded = sanitizeTaskReason({
      code: 'criteria_missing',
      detail: 'y'.repeat(TASK_REASON_DETAIL_MAX + 1),
    })
    expect(bounded?.code).toBe('criteria_missing')
    expect(bounded?.detail).toHaveLength(TASK_REASON_DETAIL_MAX)
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
