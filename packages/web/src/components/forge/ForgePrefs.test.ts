import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_FORGE_PREFS,
  FORGE_PREFS_STORAGE_KEY,
  parseForgePrefs,
  readForgePrefs,
  serializeForgePrefs,
  writeForgePrefs,
  type ForgePrefs,
} from './ForgePrefs'

describe('parseForgePrefs', () => {
  test('absent (null) falls back to the defaults', () => {
    expect(parseForgePrefs(null)).toEqual(DEFAULT_FORGE_PREFS)
  })

  test('an empty object falls back to the defaults for every field', () => {
    expect(parseForgePrefs('{}')).toEqual(DEFAULT_FORGE_PREFS)
  })

  test('a partial blob keeps its known fields and defaults the rest', () => {
    const partial = parseForgePrefs(JSON.stringify({ issuesSort: 'title', mrsLabels: ['ui'] }))
    expect(partial).toEqual({
      ...DEFAULT_FORGE_PREFS,
      issuesSort: 'title',
      mrsLabels: ['ui'],
    })
  })

  test('a corrupted (non-JSON) blob falls back to the defaults', () => {
    expect(parseForgePrefs('{not json')).toEqual(DEFAULT_FORGE_PREFS)
  })

  test('a JSON value that is not an object falls back to the defaults', () => {
    expect(parseForgePrefs('42')).toEqual(DEFAULT_FORGE_PREFS)
    expect(parseForgePrefs('null')).toEqual(DEFAULT_FORGE_PREFS)
    expect(parseForgePrefs('"hello"')).toEqual(DEFAULT_FORGE_PREFS)
    expect(parseForgePrefs('[1,2,3]')).toEqual(DEFAULT_FORGE_PREFS)
  })

  test('a mistyped field is ignored in favor of its default, others still honored', () => {
    const parsed = parseForgePrefs(
      JSON.stringify({ issuesOpen: 'yes', mrsFilter: 'draft', issuesLabels: ['a', 2, 'b'] }),
    )
    expect(parsed.issuesOpen).toBe(DEFAULT_FORGE_PREFS.issuesOpen)
    expect(parsed.mrsFilter).toBe('draft')
    expect(parsed.issuesLabels).toEqual(DEFAULT_FORGE_PREFS.issuesLabels)
  })

  test('an unknown sort key or filter value falls back to its default', () => {
    const parsed = parseForgePrefs(
      JSON.stringify({ issuesSort: 'popularity', mrsFilter: 'closed' }),
    )
    expect(parsed.issuesSort).toBe(DEFAULT_FORGE_PREFS.issuesSort)
    expect(parsed.mrsFilter).toBe(DEFAULT_FORGE_PREFS.mrsFilter)
  })

  test('round-trips through serializeForgePrefs', () => {
    const prefs: ForgePrefs = {
      issuesOpen: false,
      mrsOpen: true,
      issuesSort: 'title',
      mrsSort: 'updated',
      mrsFilter: 'ready',
      issuesLabels: ['bug'],
      mrsLabels: [],
    }
    expect(parseForgePrefs(serializeForgePrefs(prefs))).toEqual(prefs)
  })
})

describe('readForgePrefs / writeForgePrefs (localStorage wrappers)', () => {
  test('reads and writes through a working localStorage, and survives a hostile one', () => {
    const store = new Map<string, string>()
    const stub = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }
    const globals = globalThis as { localStorage?: unknown }
    const previous = globals.localStorage
    try {
      globals.localStorage = stub
      expect(readForgePrefs()).toEqual(DEFAULT_FORGE_PREFS)

      const prefs: ForgePrefs = { ...DEFAULT_FORGE_PREFS, issuesSort: 'title', mrsOpen: false }
      writeForgePrefs(prefs)
      expect(store.get(FORGE_PREFS_STORAGE_KEY)).toBe(JSON.stringify(prefs))
      expect(readForgePrefs()).toEqual(prefs)

      globals.localStorage = {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
      }
      expect(readForgePrefs()).toEqual(DEFAULT_FORGE_PREFS)
      expect(() => writeForgePrefs(prefs)).not.toThrow()
    } finally {
      globals.localStorage = previous
    }
  })
})
