import { afterEach, describe, expect, test } from 'bun:test'
import { isSupportedLanguage, reviewLanguage, setLanguage, t, uiLocale } from './i18n.js'

afterEach(() => setLanguage(null))

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
