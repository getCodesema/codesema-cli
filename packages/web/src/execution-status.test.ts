import { describe, expect, test } from 'bun:test'
import { EXECUTION_STATUS } from './execution-status'
import { t } from './i18n'
import type { TaskStatus } from './types'

const ALL_STATUSES: TaskStatus[] = [
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

describe('EXECUTION_STATUS', () => {
  test('covers every task status exactly once', () => {
    expect(Object.keys(EXECUTION_STATUS).toSorted()).toEqual(ALL_STATUSES.toSorted())
  })

  test('every label key resolves to a real message', () => {
    for (const status of ALL_STATUSES) {
      const key = EXECUTION_STATUS[status].labelKey
      // t() falls back to the key itself when the catalog misses it.
      expect(t(key)).not.toBe(key)
    }
  })

  test('semaphore grammar: green means done and passed', () => {
    for (const status of ['review_ok', 'shipped'] as const) {
      expect(EXECUTION_STATUS[status].color).toBe('var(--sema-green)')
    }
  })

  test('semaphore grammar: red means blocked', () => {
    for (const status of ['review_ko', 'failed'] as const) {
      expect(EXECUTION_STATUS[status].color).toBe('var(--sema-red)')
    }
  })

  test('semaphore grammar: amber for machine work and human waits', () => {
    for (const status of ['running', 'reviewing', 'waiting_for_you'] as const) {
      expect(EXECUTION_STATUS[status].color).toBe('var(--sema-amber)')
    }
  })

  test('neutral for queued and interrupted: nothing is happening', () => {
    for (const status of ['queued', 'interrupted'] as const) {
      expect(EXECUTION_STATUS[status].color).toBe('var(--sema-dot-idle)')
    }
  })

  test('pulse is reserved for statuses where the agent itself works', () => {
    const pulsing = ALL_STATUSES.filter((s) => EXECUTION_STATUS[s].pulse).toSorted()
    expect(pulsing).toEqual(['reviewing', 'running'])
  })

  test('attention is reserved for waiting_for_you', () => {
    const attention = ALL_STATUSES.filter((s) => EXECUTION_STATUS[s].attention)
    expect(attention).toEqual(['waiting_for_you'])
  })

  test('every visual only ever points at theme tokens, never raw hex', () => {
    for (const status of ALL_STATUSES) {
      const { color, soft, text } = EXECUTION_STATUS[status]
      for (const value of [color, soft, text]) {
        expect(value.startsWith('var(--sema-')).toBe(true)
      }
    }
  })
})
