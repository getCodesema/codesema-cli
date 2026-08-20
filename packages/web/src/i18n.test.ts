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
