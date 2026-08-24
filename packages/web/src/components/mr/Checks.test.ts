import { describe, expect, test } from 'bun:test'
import { aggregateCheckStatus, CHECK_BUCKETS } from './Checks'

describe('CHECK_BUCKETS', () => {
  test('fixed order: passed, failed, pending, skipped', () => {
    expect(CHECK_BUCKETS).toEqual(['passed', 'failed', 'pending', 'skipped'])
  })
})

describe('aggregateCheckStatus', () => {
  test('a failure takes priority over everything else', () => {
    expect(
      aggregateCheckStatus({ passed: 5, failed: 1, pending: 2, skipped: 3, truncated: true }),
    ).toBe('failed')
  })

  test('pending is next, once nothing failed', () => {
    expect(
      aggregateCheckStatus({ passed: 5, failed: 0, pending: 2, skipped: 3, truncated: true }),
    ).toBe('pending')
  })

  test('passed is next, once nothing failed or is pending', () => {
    expect(
      aggregateCheckStatus({ passed: 5, failed: 0, pending: 0, skipped: 3, truncated: true }),
    ).toBe('passed')
  })

  test('skipped is the last resort', () => {
    expect(
      aggregateCheckStatus({ passed: 0, failed: 0, pending: 0, skipped: 3, truncated: true }),
    ).toBe('skipped')
  })

  test('every bucket at zero is unknown, not a false "passed"', () => {
    expect(
      aggregateCheckStatus({ passed: 0, failed: 0, pending: 0, skipped: 0, truncated: true }),
    ).toBe('unknown')
  })
})
