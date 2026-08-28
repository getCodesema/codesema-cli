import { describe, expect, test } from 'bun:test'
import { ARM_TICKET_STATUSES, type ArmTicketStatus } from './arm.js'
import {
  isLegalTicketTransition,
  targetTicketStatus,
  TICKET_TERMINAL_STATUSES,
  TICKET_TRANSITIONS,
} from './ticket-state.js'

// The same table, spelled a second time BY HAND: a typo in ticket-state.ts
// has to disagree with this list to be caught, which a test derived from the
// table itself could never do.
const EXPECTED_TRANSITIONS: ReadonlyArray<[ArmTicketStatus, ArmTicketStatus]> = [
  ['proposed', 'published'],
  ['proposed', 'rejected'],
  ['published', 'in_progress'],
  ['in_progress', 'published'],
  ['in_progress', 'mr_opened'],
  ['in_progress', 'already_implemented'],
  ['in_progress', 'failed'],
  ['in_progress', 'done'],
  ['mr_opened', 'mr_opened'],
  ['mr_opened', 'ready_to_merge'],
  ['mr_opened', 'failed'],
  ['mr_opened', 'done'],
  ['ready_to_merge', 'mr_opened'],
  ['ready_to_merge', 'done'],
  ['ready_to_merge', 'failed'],
  ['failed', 'in_progress'],
  ['failed', 'published'],
  ['done', 'mr_opened'],
]

const key = (from: string, to: string) => `${from}→${to}`

describe('TICKET_TRANSITIONS', () => {
  test('matches the hand-spelled table exactly, no extra and no missing pair', () => {
    const actual = new Set(TICKET_TRANSITIONS.map((t) => key(t.from, t.to)))
    const expected = new Set(EXPECTED_TRANSITIONS.map(([from, to]) => key(from, to)))
    expect(actual).toEqual(expected)
    expect(TICKET_TRANSITIONS).toHaveLength(EXPECTED_TRANSITIONS.length)
  })

  for (const [from, to] of EXPECTED_TRANSITIONS) {
    test(`${from} → ${to} is legal`, () => {
      expect(isLegalTicketTransition(from, to)).toBe(true)
    })
  }

  test('every status in the table is a known ticket status', () => {
    for (const { from, to } of TICKET_TRANSITIONS) {
      expect(ARM_TICKET_STATUSES.has(from)).toBe(true)
      expect(ARM_TICKET_STATUSES.has(to)).toBe(true)
    }
  })

  test('every non-terminal status has at least one way out', () => {
    for (const status of ARM_TICKET_STATUSES) {
      if (TICKET_TERMINAL_STATUSES.has(status)) {
        continue
      }
      expect(TICKET_TRANSITIONS.some((t) => t.from === status)).toBe(true)
    }
  })

  test('every status is reachable: it appears as a to, or is the creation status', () => {
    for (const status of ARM_TICKET_STATUSES) {
      if (status === 'proposed') {
        continue
      }
      expect(TICKET_TRANSITIONS.some((t) => t.to === status)).toBe(true)
    }
  })
})

describe('isLegalTicketTransition', () => {
  test.each([
    ['published', 'done'],
    ['published', 'mr_opened'],
    ['proposed', 'in_progress'],
    ['done', 'published'],
    ['done', 'done'],
    ['failed', 'mr_opened'],
    ['in_progress', 'ready_to_merge'],
    ['ready_to_merge', 'ready_to_merge'],
  ] as Array<[ArmTicketStatus, ArmTicketStatus]>)('%s → %s is refused', (from, to) => {
    expect(isLegalTicketTransition(from, to)).toBe(false)
  })

  test('a terminal status has no way out at all', () => {
    for (const from of TICKET_TERMINAL_STATUSES) {
      for (const to of ARM_TICKET_STATUSES) {
        expect(isLegalTicketTransition(from, to)).toBe(false)
      }
    }
  })
})

describe('TICKET_TERMINAL_STATUSES', () => {
  test('derives to exactly rejected and already_implemented', () => {
    expect([...TICKET_TERMINAL_STATUSES].toSorted()).toEqual(['already_implemented', 'rejected'])
  })
})

describe('targetTicketStatus', () => {
  test('mr_opened claims mr_opened', () => {
    expect(targetTicketStatus('mr_opened')).toBe('mr_opened')
  })

  test('merged claims done', () => {
    expect(targetTicketStatus('merged')).toBe('done')
  })

  test('failed claims failed', () => {
    expect(targetTicketStatus('failed')).toBe('failed')
  })

  test('an approving review claims ready_to_merge', () => {
    expect(targetTicketStatus('review_result', 'approve')).toBe('ready_to_merge')
  })

  test('a non-approving review is not a status transition', () => {
    expect(targetTicketStatus('review_result', 'request_changes')).toBeNull()
    expect(targetTicketStatus('review_result', 'comment')).toBeNull()
    expect(targetTicketStatus('review_result')).toBeNull()
  })
})
