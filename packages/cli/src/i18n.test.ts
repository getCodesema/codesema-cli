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

/**
 * The rule the two named tests above were a sample of, posed on the whole
 * catalogue instead of on the sites somebody remembered (T3.5 round 2, m7d:
 * `ship.mrNoRecap` and `ship.mrRecapBlocked` — two brand-new sentences a
 * French user reads in the description of every merge request the ship opens
 * — sailed straight past a check that covered two keys by name).
 *
 * Key parity cannot catch this: a French entry copied verbatim from the
 * English one has the key. Nor can a spot check catch the NEXT key nobody
 * thinks of. Every key must differ, and the handful that legitimately do not
 * are enumerated here — a list that has to be argued for, one entry at a
 * time, rather than a silence.
 */
describe('every key is actually translated, not copied from the English', () => {
  /**
   * Identical on purpose, and each for a reason that is not "nobody got to
   * it": a proper noun (`menu.cloud*`), a field name that is the same word in
   * both languages (`field.mode`, `field.prompt`, `field.web`,
   * `field.verdict`, `prep.label.custom`, `brain.fieldId`, `brain.fieldUrl`),
   * a technical token quoted verbatim (`wizard.stdinStdout`), or a label
   * whose French spelling IS the English one (`prep.title`,
   * `prep.label.commits`, `review.commits`, `review.dualLaneA`,
   * `export.verdictLabel`, `export.commitsLabel`, `export.prologue`).
   */
  const IDENTICAL_ON_PURPOSE = new Set<string>([
    'prep.title',
    'prep.label.commits',
    'prep.label.custom',
    'review.commits',
    'review.dualLaneA',
    'field.mode',
    'field.prompt',
    'field.web',
    'field.verdict',
    'wizard.stdinStdout',
    'export.verdictLabel',
    'export.commitsLabel',
    'export.prologue',
    'menu.cloud',
    'menu.cloudTitle',
    'brain.fieldId',
    'brain.fieldUrl',
    'brain.fieldPid',
    'brain.fieldPort',
    'brain.fieldUptime',
    'brain.fieldLog',
  ])

  test('no French entry is a copy of its English one, outside the argued list', () => {
    const en = CATALOGS.en as Record<string, string>
    const fr = CATALOGS.fr as Record<string, string>
    const copies = Object.keys(en).filter((key) => fr[key] === en[key])
    expect(copies.toSorted()).toEqual([...IDENTICAL_ON_PURPOSE].toSorted())
  })

  test('the argued list names only keys that exist', () => {
    for (const key of IDENTICAL_ON_PURPOSE) {
      expect(Object.hasOwn(CATALOGS.en, key)).toBe(true)
    }
  })

  test('every entry is non-blank in both catalogues', () => {
    const en = CATALOGS.en as Record<string, string>
    const fr = CATALOGS.fr as Record<string, string>
    for (const key of Object.keys(en)) {
      expect(en[key]?.trim()).toBeTruthy()
      expect(fr[key]?.trim()).toBeTruthy()
    }
  })
})

// The three sentences T3.5 puts in the merge-request description itself —
// the only place a user reads this ticket's prose at all — named so a
// regression on them fails with their own name rather than inside a sweep.
describe("the ship's merge-request sentences are translated", () => {
  for (const key of [
    'ship.mrNoRecap',
    'ship.mrRecapBlocked',
    'ship.mrRecapUnscanned',
    'ship.mrGeneratedNote',
  ] as const) {
    test(`${key} has its own French wording`, () => {
      expect(CATALOGS.fr[key]).not.toBe(CATALOGS.en[key])
      expect(CATALOGS.fr[key].trim()).toBeTruthy()
    })
  }

  test('"a secret was found" and "nobody could look" are not the same sentence', () => {
    for (const catalog of Object.values(CATALOGS)) {
      expect(catalog['ship.mrRecapBlocked']).not.toBe(catalog['ship.mrRecapUnscanned'])
      expect(catalog['ship.mrRecapUnscanned']).not.toBe(catalog['ship.mrNoRecap'])
    }
  })
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
