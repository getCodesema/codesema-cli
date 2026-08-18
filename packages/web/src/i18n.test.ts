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
