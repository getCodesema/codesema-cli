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

// A translation that silently drops (or invents) a placeholder renders an
// incomplete sentence at runtime and nothing else catches it: the `fr`
// annotation only enforces that the KEYS match, never that the two strings
// interpolate the same things. Duplicates are ignored on purpose — a plural
// form ("{n} commit | {n} commits") legitimately repeats its placeholder in
// one language and not the other.
describe('placeholder parity', () => {
  const placeholders = (value: string): string[] =>
    [...new Set([...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? ''))].toSorted()

  test('every catalog interpolates exactly what the English one does', () => {
    const en: Record<string, string> = catalogs.en ?? {}
    for (const [locale, catalog] of Object.entries(catalogs)) {
      for (const [key, value] of Object.entries(en)) {
        const translated = (catalog as Record<string, string>)[key] ?? ''
        expect({ locale, key, of: placeholders(translated) }).toEqual({
          locale,
          key,
          of: placeholders(value),
        })
      }
    }
  })
})

// Round-4 adversarial review, MAJEUR 1: the 'issue' journal lines (T2.4) are
// the ones a French workspace used to read in English, because the server's
// own `data.message` shadowed them (round 5 added `unreachable`, which was
// shadowed the same way while it travelled on `type: 'error'`). Their French values being real
// translations — not copies of the English, not empty — is the whole point of
// that fix, and nothing else in this repo asserts it.
describe('T2.4 issue journal labels', () => {
  const issueKeys = [
    'workspace.evIssueBound',
    'workspace.evIssueCoverageGap',
    'workspace.evIssueCosmetic',
    'workspace.evIssueEdited',
    'workspace.evIssueNotTicket',
    'workspace.evIssueSnapshotUnreadable',
    'workspace.evIssueUnreachable',
    'workspace.evIssueNone',
    'workspace.evIssueSectionsUnknown',
    'workspace.evIssueSectionContext',
    'workspace.evIssueSectionGoal',
    'workspace.evIssueSectionScope',
    'workspace.evIssueSectionOutOfScope',
  ] as const

  test('each one is actually translated in French, never left on its English text', () => {
    const en = (catalogs.en ?? {}) as Record<string, string>
    const fr = (catalogs.fr ?? {}) as Record<string, string>
    for (const key of issueKeys) {
      expect(en[key]?.trim()).toBeTruthy()
      expect(fr[key]?.trim()).toBeTruthy()
      expect(fr[key]).not.toBe(en[key])
    }
  })
})

describe('T2.5 criteria journal labels', () => {
  const criteriaKeys = [
    'workspace.evCriteria',
    'workspace.evCriteriaDraftUnparsed',
    'workspace.evCriteriaValidated',
  ] as const

  test('each one is actually translated in French, never left on its English text', () => {
    const en = (catalogs.en ?? {}) as Record<string, string>
    const fr = (catalogs.fr ?? {}) as Record<string, string>
    for (const key of criteriaKeys) {
      expect(en[key]?.trim()).toBeTruthy()
      expect(fr[key]?.trim()).toBeTruthy()
      expect(fr[key]).not.toBe(en[key])
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
