import { describe, expect, test } from 'bun:test'
import type { TaskCheck } from '../types'
import {
  checksBadge,
  checksCounts,
  checksEventLine,
  checksTabLabel,
  checksTone,
  shortSha,
} from './useChecks'

const check = (status: TaskCheck['status']): Pick<TaskCheck, 'status'> => ({ status })

describe('checksTabLabel', () => {
  test('never ran or unconfigured stays a bare label', () => {
    expect(checksTabLabel(null)).toBe('Checks')
    expect(checksTabLabel({ status: 'unconfigured' })).toBe('Checks')
  })

  test('the label is the semaphore: … while running, ✓ green, ✗ red', () => {
    expect(checksTabLabel({ status: 'running' })).toBe('Checks …')
    expect(checksTabLabel({ status: 'passed' })).toBe('Checks ✓')
    expect(checksTabLabel({ status: 'failed' })).toBe('Checks ✗')
  })

  test('a broken runner is a warning, never a pass or a fail', () => {
    expect(checksTabLabel({ status: 'error' })).toBe('Checks ⚠')
    expect(checksTone({ status: 'error' })).toBe('warn')
  })
})

describe('checksBadge', () => {
  test('no badge when nothing ran or nothing is configured', () => {
    expect(checksBadge(null)).toBeNull()
    expect(checksBadge({ status: 'unconfigured' })).toBeNull()
  })

  test('one glyph per state', () => {
    expect(checksBadge({ status: 'running' })).toBe('…')
    expect(checksBadge({ status: 'passed' })).toBe('✓')
    expect(checksBadge({ status: 'failed' })).toBe('✗')
    expect(checksBadge({ status: 'error' })).toBe('⚠')
  })
})

describe('checksCounts', () => {
  test('timeouts count as failures, skipped counts as neither', () => {
    const counts = checksCounts([
      check('passed'),
      check('passed'),
      check('failed'),
      check('timeout'),
      check('skipped'),
    ])
    expect(counts).toEqual({ passed: 2, failed: 2 })
  })

  test('an empty run aggregates to zero on both sides', () => {
    expect(checksCounts([])).toEqual({ passed: 0, failed: 0 })
  })
})

describe('checksEventLine', () => {
  test('a green run reads its passed count (no window: English catalog)', () => {
    expect(checksEventLine({ status: 'passed', passed: 3, failed: 0 })).toEqual({
      tone: 'go',
      text: 'Checks — 3 passed',
    })
  })

  test('a red run reads its failed count', () => {
    expect(checksEventLine({ status: 'failed', passed: 2, failed: 1 })).toEqual({
      tone: 'stop',
      text: 'Checks — 1 failed',
    })
  })

  test('error stops, unconfigured stays idle', () => {
    expect(checksEventLine({ status: 'error' }).tone).toBe('stop')
    expect(checksEventLine({ status: 'unconfigured' }).tone).toBe('idle')
  })

  test('an unknown status or malformed counts degrade, never crash', () => {
    expect(checksEventLine({})).toEqual({ tone: 'idle', text: 'Checks' })
    expect(checksEventLine({ status: 'passed', passed: 'three' }).text).toBe('Checks — 0 passed')
  })
})

describe('shortSha', () => {
  test('displays the 7-char short form', () => {
    expect(shortSha('0123456789abcdef')).toBe('0123456')
    expect(shortSha('abc')).toBe('abc')
  })
})
