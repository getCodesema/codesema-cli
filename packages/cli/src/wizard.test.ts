import { afterEach, describe, expect, test } from 'bun:test'
import { setLanguage, t } from './i18n.js'
import { describeConfigEntries } from './wizard.js'

afterEach(() => setLanguage(null))

describe('describeConfigEntries', () => {
  test('lists agent, language, auto-sync then back, with current values as hints', () => {
    const entries = describeConfigEntries({ agent: 'claude -p --model opus', language: 'fr', syncAutoPush: true })
    expect(entries.map((entry) => entry.id)).toEqual(['agent', 'language', 'autoSync', 'back'])
    expect(entries[0]?.hint).toBe('claude -p --model opus')
    expect(entries[1]?.hint).toBe('Français')
    expect(entries[2]?.hint).toBe(t('config.autoSyncOn'))
  })

  test('falls back to explicit placeholders when nothing is configured', () => {
    const entries = describeConfigEntries({})
    expect(entries[0]?.hint).toBe(t('config.agentEntryUnset'))
    expect(entries[1]?.hint).toBe(t('config.languageAuto'))
    expect(entries[2]?.hint).toBe(t('config.autoSyncUnset'))
  })

  test('a declined auto-sync opt-in shows as off', () => {
    const entries = describeConfigEntries({ syncAutoPush: false })
    expect(entries[2]?.hint).toBe(t('config.autoSyncOff'))
  })

  test('labels follow the active i18n catalog', () => {
    setLanguage('fr')
    const entries = describeConfigEntries({ language: 'en' })
    expect(entries[0]?.label).toBe(t('config.agentEntry'))
    expect(entries[1]?.hint).toBe('English')
  })
})
