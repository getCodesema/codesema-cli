import { describe, expect, test } from 'bun:test'
import { t } from '../i18n'
import type { TaskIsolation, TaskRecord, WorkspaceInfo } from '../types'
import {
  ISOLATION_BANNER_STORAGE_KEY,
  ISOLATION_DOC_URL,
  isolationBadge,
  persistIsolationBannerDismissed,
  readIsolationBannerDismissed,
  shouldOfferIsolationUpgrade,
  showIsolationDot,
  taskIsolation,
} from './useIsolation'

function record(isolation?: TaskIsolation): Pick<TaskRecord, 'isolation'> {
  return isolation === undefined ? {} : { isolation }
}

function workspace(partial: Partial<WorkspaceInfo> = {}): WorkspaceInfo {
  return {
    isolation_available: false,
    isolation_default: 'policy',
    isolation_reason: 'no container runtime found',
    ...partial,
  }
}

describe('taskIsolation', () => {
  test('a record without isolation is policy — never the stronger claim', () => {
    expect(taskIsolation(record())).toBe('policy')
    expect(taskIsolation(record('policy'))).toBe('policy')
    expect(taskIsolation(record('container'))).toBe('container')
    expect(taskIsolation(record('microvm'))).toBe('microvm')
  })

  test('an unknown value from an unknown server still reads as policy', () => {
    expect(taskIsolation({ isolation: 'sandbox' as TaskIsolation })).toBe('policy')
  })
})

describe('isolationBadge', () => {
  test('caged tasks get the shield, the green word and the guarantee tooltip', () => {
    const badge = isolationBadge(record('container'))
    expect(badge).toEqual({
      isolation: 'container',
      glyph: '🛡',
      labelKey: 'workspace.isolationContainer',
      hintKey: 'workspace.isolationContainerHint',
    })
    expect(t(badge.labelKey)).toBe('container')
    expect(t(badge.hintKey)).toContain('its own container')
  })

  test('policy tasks say so plainly, older records included', () => {
    expect(isolationBadge(record())).toEqual(isolationBadge(record('policy')))
    expect(t(isolationBadge(record()).labelKey)).toBe('policy')
  })

  test('microVM tasks get their own glyph, word and guarantee tooltip', () => {
    const badge = isolationBadge(record('microvm'))
    expect(badge).toEqual({
      isolation: 'microvm',
      glyph: '▣',
      labelKey: 'workspace.isolationMicrovm',
      hintKey: 'workspace.isolationMicrovmHint',
    })
    expect(t(badge.labelKey)).toBe('microVM')
    expect(t(badge.hintKey)).toContain('microVM')
  })
})

describe('showIsolationDot', () => {
  test('a caged task always shows its dot, even with no workspace info', () => {
    expect(showIsolationDot(record('container'), null)).toBe(true)
    expect(showIsolationDot(record('container'), workspace())).toBe(true)
  })

  test('a microVM task always shows its dot too, even with no workspace info', () => {
    expect(showIsolationDot(record('microvm'), null)).toBe(true)
    expect(showIsolationDot(record('microvm'), workspace())).toBe(true)
  })

  test('a policy task shows its dot only where the cage exists (it tells cards apart)', () => {
    expect(showIsolationDot(record('policy'), workspace({ isolation_available: true }))).toBe(true)
    expect(showIsolationDot(record('policy'), workspace())).toBe(false)
    expect(showIsolationDot(record(), null)).toBe(false)
  })
})

describe('shouldOfferIsolationUpgrade', () => {
  test('offers the upgrade when new tasks fall back to policy', () => {
    expect(shouldOfferIsolationUpgrade(workspace(), false)).toBe(true)
  })

  test('stays quiet when the cage is already the default', () => {
    const caged = workspace({ isolation_available: true, isolation_default: 'container' })
    expect(shouldOfferIsolationUpgrade(caged, false)).toBe(false)
  })

  test('stays quiet when the default is already the microVM cage', () => {
    const caged = workspace({ isolation_default: 'microvm' })
    expect(shouldOfferIsolationUpgrade(caged, false)).toBe(false)
  })

  test('stays quiet when the server said nothing: unknown is not degraded', () => {
    expect(shouldOfferIsolationUpgrade(null, false)).toBe(false)
  })

  test('stays quiet once dismissed, and when policy was the explicit choice', () => {
    expect(shouldOfferIsolationUpgrade(workspace(), true)).toBe(false)
    expect(shouldOfferIsolationUpgrade(workspace({ isolation_configured: 'policy' }), false)).toBe(
      false,
    )
    expect(shouldOfferIsolationUpgrade(workspace({ isolation_configured: 'auto' }), false)).toBe(
      true,
    )
  })

  test('the banner carries the server reason and a real doc link', () => {
    const info = workspace()
    expect(t('workspace.isolationUpgradeBody', { reason: info.isolation_reason })).toContain(
      'no container runtime found',
    )
    expect(ISOLATION_DOC_URL.startsWith('https://')).toBe(true)
  })
})

describe('banner dismissal storage', () => {
  test('reads and writes the persisted flag, and survives a hostile localStorage', () => {
    const store = new Map<string, string>()
    const stub = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }
    const globals = globalThis as { localStorage?: unknown }
    const previous = globals.localStorage
    try {
      globals.localStorage = stub
      expect(readIsolationBannerDismissed()).toBe(false)
      persistIsolationBannerDismissed()
      expect(store.get(ISOLATION_BANNER_STORAGE_KEY)).toBe('1')
      expect(readIsolationBannerDismissed()).toBe(true)

      globals.localStorage = {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
      }
      expect(readIsolationBannerDismissed()).toBe(false)
      expect(() => persistIsolationBannerDismissed()).not.toThrow()
    } finally {
      globals.localStorage = previous
    }
  })
})
