import { afterEach, describe, expect, test } from 'bun:test'
import { CATALOGS, isSupportedLanguage, reviewLanguage, setLanguage, t, uiLocale } from './i18n.js'

afterEach(() => setLanguage(null))

describe('catalog parity', () => {
  test('every catalog defines exactly the keys of the English one', () => {
    const enKeys = Object.keys(CATALOGS.en).toSorted()
    for (const catalog of Object.values(CATALOGS)) {
      expect(Object.keys(catalog).toSorted()).toEqual(enKeys)
    }
  })
})

// T1.3 round 4 (mineur): the two boot notices this ticket adds are the only
// thing a user ever reads about the machine-wide cap on the terminal. Key
// parity above cannot tell a translation from a copy of the English line.
describe('the machine-cap boot notices are actually translated', () => {
  for (const key of ['workspace.maxParallelDeprecated', 'workspace.invalidLoadCapKey'] as const) {
    test(`${key} has its own French wording`, () => {
      expect(CATALOGS.fr[key]).not.toBe(CATALOGS.en[key])
    })
  }
})

describe('t', () => {
  test('interpolates params', () => {
    expect(t('cli.unknownCommand', { command: 'foo' })).toBe('unknown command: foo')
  })

  test('picks singular and plural forms', () => {
    expect(t('review.files', { n: 1 })).toBe('1 file')
    expect(t('review.files', { n: 3 })).toBe('3 files')
  })

  test('renders the active catalog', () => {
    setLanguage('fr')
    expect(t('review.ready')).toBe('revue prête')
    expect(t('review.files', { n: 2 })).toBe('2 fichiers')
  })
})

describe('setLanguage', () => {
  test('defaults to English', () => {
    expect(uiLocale()).toBe('en')
    expect(reviewLanguage()).toBeNull()
  })

  test('catalog codes drive the UI locale and the prompt language name', () => {
    setLanguage('fr')
    expect(uiLocale()).toBe('fr')
    expect(reviewLanguage()).toBe('French')
  })

  test('null resets to the default', () => {
    setLanguage('fr')
    setLanguage(null)
    expect(uiLocale()).toBe('en')
    expect(reviewLanguage()).toBeNull()
  })
})

describe('isSupportedLanguage', () => {
  test('accepts only ISO codes with a catalog', () => {
    expect(isSupportedLanguage('en')).toBe(true)
    expect(isSupportedLanguage('fr')).toBe(true)
    expect(isSupportedLanguage('de')).toBe(false)
    expect(isSupportedLanguage('German')).toBe(false)
    expect(isSupportedLanguage(42)).toBe(false)
  })
})
