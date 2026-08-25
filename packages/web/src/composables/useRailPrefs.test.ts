import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_RAIL_PREFS,
  parseRailPrefs,
  RAIL_LIST_WIDTH_DEFAULT,
  RAIL_LIST_WIDTH_MAX,
  RAIL_LIST_WIDTH_MIN,
  RAIL_PREFS_STORAGE_KEY,
  readRailPrefs,
  serializeRailPrefs,
  writeRailPrefs,
  type RailPrefs,
} from './useRailPrefs'

describe('parseRailPrefs', () => {
  test('absent (null) falls back to the defaults', () => {
    expect(parseRailPrefs(null)).toEqual(DEFAULT_RAIL_PREFS)
  })

  test('an empty object falls back to the defaults for every field', () => {
    expect(parseRailPrefs('{}')).toEqual(DEFAULT_RAIL_PREFS)
  })

  test('a partial blob keeps its known fields and defaults the rest', () => {
    const partial = parseRailPrefs(
      JSON.stringify({ category: 'repositories', activeProjectId: 'p1' }),
    )
    expect(partial).toEqual({
      ...DEFAULT_RAIL_PREFS,
      category: 'repositories',
      activeProjectId: 'p1',
    })
  })

  test('a corrupted (non-JSON or empty) blob falls back to the defaults', () => {
    expect(parseRailPrefs('{not json')).toEqual(DEFAULT_RAIL_PREFS)
    expect(parseRailPrefs('{')).toEqual(DEFAULT_RAIL_PREFS)
    expect(parseRailPrefs('')).toEqual(DEFAULT_RAIL_PREFS)
  })

  test('a JSON value that is not a plain object falls back to the defaults', () => {
    expect(parseRailPrefs('42')).toEqual(DEFAULT_RAIL_PREFS)
    expect(parseRailPrefs('null')).toEqual(DEFAULT_RAIL_PREFS)
    expect(parseRailPrefs('"hello"')).toEqual(DEFAULT_RAIL_PREFS)
    // An array has none of RailPrefs' field names, so every field ends up
    // defaulted too, same net result as an object with no matching keys.
    expect(parseRailPrefs('[]')).toEqual(DEFAULT_RAIL_PREFS)
  })

  test('a mistyped field is ignored in favor of its default, others still honored', () => {
    const parsed = parseRailPrefs(
      JSON.stringify({ category: 'projects', navCollapsed: 'yes', activeProjectId: 'p1' }),
    )
    expect(parsed.category).toBe(DEFAULT_RAIL_PREFS.category)
    expect(parsed.navCollapsed).toBe(DEFAULT_RAIL_PREFS.navCollapsed)
    expect(parsed.activeProjectId).toBe('p1')
  })

  test('an unknown category or repo tab falls back to its default', () => {
    const parsed = parseRailPrefs(
      JSON.stringify({ category: 'projects', activeRepoTab: 'commits' }),
    )
    expect(parsed.category).toBe(DEFAULT_RAIL_PREFS.category)
    expect(parsed.activeRepoTab).toBe(DEFAULT_RAIL_PREFS.activeRepoTab)
  })

  test('round-trips through serializeRailPrefs', () => {
    const prefs: RailPrefs = {
      listWidth: 360,
      category: 'repositories',
      navCollapsed: true,
      activeProjectId: 'p1',
      activeRepoTab: 'mrs',
    }
    expect(parseRailPrefs(serializeRailPrefs(prefs))).toEqual(prefs)
  })

  describe('listWidth: clamped into bounds rather than rejected', () => {
    test('below the minimum is raised to it', () => {
      expect(parseRailPrefs(JSON.stringify({ listWidth: 10 })).listWidth).toBe(RAIL_LIST_WIDTH_MIN)
    })

    test('above the maximum is lowered to it', () => {
      expect(parseRailPrefs(JSON.stringify({ listWidth: 9999 })).listWidth).toBe(
        RAIL_LIST_WIDTH_MAX,
      )
    })

    test('exactly at the bounds passes through unchanged', () => {
      expect(parseRailPrefs(JSON.stringify({ listWidth: RAIL_LIST_WIDTH_MIN })).listWidth).toBe(
        RAIL_LIST_WIDTH_MIN,
      )
      expect(parseRailPrefs(JSON.stringify({ listWidth: RAIL_LIST_WIDTH_MAX })).listWidth).toBe(
        RAIL_LIST_WIDTH_MAX,
      )
    })

    test('the wrong type falls back to the default, not a clamp', () => {
      expect(parseRailPrefs(JSON.stringify({ listWidth: '360' })).listWidth).toBe(
        RAIL_LIST_WIDTH_DEFAULT,
      )
      expect(parseRailPrefs(JSON.stringify({ listWidth: null })).listWidth).toBe(
        RAIL_LIST_WIDTH_DEFAULT,
      )
    })

    test('a valid width in range is kept as-is, unrelated to the default', () => {
      expect(parseRailPrefs(JSON.stringify({ listWidth: 400 })).listWidth).toBe(400)
      expect(400).not.toBe(RAIL_LIST_WIDTH_DEFAULT)
    })
  })

  describe('activeProjectId', () => {
    test('a real project id string is kept', () => {
      expect(parseRailPrefs(JSON.stringify({ activeProjectId: 'p1' })).activeProjectId).toBe('p1')
    })

    test('null is a valid value: no project selected', () => {
      expect(parseRailPrefs(JSON.stringify({ activeProjectId: null })).activeProjectId).toBeNull()
    })

    test('a mistyped value falls back to the default (null)', () => {
      expect(parseRailPrefs(JSON.stringify({ activeProjectId: 42 })).activeProjectId).toBeNull()
    })
  })

  test('every known category round-trips', () => {
    for (const category of ['conversations', 'repositories'] as const) {
      expect(parseRailPrefs(JSON.stringify({ category })).category).toBe(category)
    }
  })

  test('every known repo tab round-trips', () => {
    for (const tab of ['branches', 'issues', 'mrs'] as const) {
      expect(parseRailPrefs(JSON.stringify({ activeRepoTab: tab })).activeRepoTab).toBe(tab)
    }
  })
})

describe('readRailPrefs / writeRailPrefs (localStorage wrappers)', () => {
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
      expect(readRailPrefs()).toEqual(DEFAULT_RAIL_PREFS)

      const prefs: RailPrefs = {
        ...DEFAULT_RAIL_PREFS,
        category: 'repositories',
        navCollapsed: true,
      }
      writeRailPrefs(prefs)
      expect(store.get(RAIL_PREFS_STORAGE_KEY)).toBe(JSON.stringify(prefs))
      expect(readRailPrefs()).toEqual(prefs)

      globals.localStorage = {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
      }
      expect(readRailPrefs()).toEqual(DEFAULT_RAIL_PREFS)
      expect(() => writeRailPrefs(prefs)).not.toThrow()
    } finally {
      globals.localStorage = previous
    }
  })
})
