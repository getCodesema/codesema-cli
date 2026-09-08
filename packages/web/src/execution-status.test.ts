import { describe, expect, test } from 'bun:test'
import { EXECUTION_STATUS } from './execution-status'
import { G } from './glyphs'
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

  test('every header phrase key resolves to a real message', () => {
    for (const status of ALL_STATUSES) {
      const key = EXECUTION_STATUS[status].phraseKey
      expect(t(key)).not.toBe(key)
    }
  })

  test('tone: ok and err are final, info is the machine, warn is the human, idle is nothing', () => {
    expect(EXECUTION_STATUS.review_ok.tone).toBe('ok')
    expect(EXECUTION_STATUS.shipped.tone).toBe('ok')
    expect(EXECUTION_STATUS.review_ko.tone).toBe('err')
    expect(EXECUTION_STATUS.failed.tone).toBe('err')
    expect(EXECUTION_STATUS.running.tone).toBe('info')
    expect(EXECUTION_STATUS.reviewing.tone).toBe('info')
    expect(EXECUTION_STATUS.waiting_for_you.tone).toBe('warn')
    expect(EXECUTION_STATUS.interrupted.tone).toBe('warn')
    expect(EXECUTION_STATUS.queued.tone).toBe('idle')
  })

  test('pulse is reserved for statuses where the agent itself works', () => {
    const pulsing = ALL_STATUSES.filter((s) => EXECUTION_STATUS[s].pulse).toSorted()
    expect(pulsing).toEqual(['reviewing', 'running'])
  })

  test('attention is reserved for waiting_for_you', () => {
    const attention = ALL_STATUSES.filter((s) => EXECUTION_STATUS[s].attention)
    expect(attention).toEqual(['waiting_for_you'])
  })

  test('every icon comes from the shipped glyph set', () => {
    const glyphs = new Set<string>(Object.values(G))
    for (const status of ALL_STATUSES) {
      expect(glyphs.has(EXECUTION_STATUS[status].icon)).toBe(true)
    }
  })
})
