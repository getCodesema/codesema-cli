import { describe, expect, test } from 'bun:test'
import { catalogs, t } from './i18n'

describe('catalog parity', () => {
  test('every catalog defines exactly the keys of the English one', () => {
    const enKeys = Object.keys(catalogs.en ?? {}).toSorted()
    expect(enKeys.length).toBeGreaterThan(0)
    for (const catalog of Object.values(catalogs)) {
      expect(Object.keys(catalog).toSorted()).toEqual(enKeys)
    }
  })
})

// T1.3 round 4 (mineur): parity above only proves the KEYS exist in both
// catalogs — a French entry copy-pasted from the English one satisfies it
// perfectly. These five keys are the ticket's own, and three of them are the
// only French an operator ever reads about the machine-wide cap.
describe('the machine-cap keys are actually translated, not copied', () => {
  const keys = [
    'workspace.evQueue',
    'workspace.evQueueMachine',
    'workspace.evQueueProject',
    'workspace.queuePositionHintMachine',
    'workspace.phaseQueuedMachine',
  ] as const

  test('every one of them differs from its English source', () => {
    for (const key of keys) {
      expect(catalogs.fr?.[key]).toBeDefined()
      expect(catalogs.fr?.[key]).not.toBe(catalogs.en?.[key])
    }
  })
})

describe('t', () => {
  test('interpolates params and picks plural forms (no window: English)', () => {
    expect(t('header.copyPrompt', { n: 3 })).toBe('Copy for agent (3)')
    expect(t('live.commits', { n: 1 })).toBe('1 commit')
    expect(t('live.commits', { n: 2 })).toBe('2 commits')
  })
})

// T1.9 review round 3, MAJEUR 5: the parity test above only proves the FR
// catalog has a value for every EN key, not that the FR value is actually
// French. Round 3's audit mutated 'Ressource' to 'Resource' and found 0 red
// tests anywhere in the suite.
describe('workspace.evResource (T1.9 resource events)', () => {
  test('the French label is actually French', () => {
    expect(catalogs.fr?.['workspace.evResource']).toBe('Ressource')
    expect(catalogs.en?.['workspace.evResource']).toBe('Resource')
  })

  test('the per-name resource lines are translated in both catalogs', () => {
    expect(catalogs.fr?.['workspace.evResourceHomeReleased']).toBe('Volume HOME libéré')
    expect(catalogs.en?.['workspace.evResourceHomeReleased']).toBe('HOME volume released')
  })
})
