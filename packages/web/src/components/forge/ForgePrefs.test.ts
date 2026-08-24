import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_FORGE_PREFS,
  FORGE_CONTROLS_WIDTH_DEFAULT,
  FORGE_CONTROLS_WIDTH_MAX,
  FORGE_CONTROLS_WIDTH_MIN,
  FORGE_LIST_WIDTH_DEFAULT,
  FORGE_LIST_WIDTH_MAX,
  FORGE_LIST_WIDTH_MIN,
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
    const partial = parseForgePrefs(
      JSON.stringify({ issuesSort: 'title', mrsLabels: ['ui'], controlsWidth: 340 }),
    )
    expect(partial).toEqual({
      ...DEFAULT_FORGE_PREFS,
      issuesSort: 'title',
      mrsLabels: ['ui'],
      controlsWidth: 340,
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
      JSON.stringify({ activeSection: 'both', mrsFilter: 'draft', issuesLabels: ['a', 2, 'b'] }),
    )
    expect(parsed.activeSection).toBe(DEFAULT_FORGE_PREFS.activeSection)
    expect(parsed.mrsFilter).toBe('draft')
    expect(parsed.issuesLabels).toEqual(DEFAULT_FORGE_PREFS.issuesLabels)
  })

  test('an unknown sort key, filter value or section falls back to its default', () => {
    const parsed = parseForgePrefs(
      JSON.stringify({ issuesSort: 'popularity', mrsFilter: 'closed', activeSection: 'wiki' }),
    )
    expect(parsed.issuesSort).toBe(DEFAULT_FORGE_PREFS.issuesSort)
    expect(parsed.mrsFilter).toBe(DEFAULT_FORGE_PREFS.mrsFilter)
    expect(parsed.activeSection).toBe(DEFAULT_FORGE_PREFS.activeSection)
  })

  test('an older blob (no widths, no activeSection, obsolete fold flags) is still accepted', () => {
    const parsed = parseForgePrefs(
      JSON.stringify({ issuesOpen: false, mrsOpen: true, issuesSort: 'title' }),
    )
    expect(parsed).toEqual({ ...DEFAULT_FORGE_PREFS, issuesSort: 'title' })
  })

  test('round-trips through serializeForgePrefs', () => {
    const prefs: ForgePrefs = {
      activeSection: 'mrs',
      issuesSort: 'title',
      mrsSort: 'updated',
      mrsFilter: 'ready',
      issuesLabels: ['bug'],
      mrsLabels: [],
      controlsWidth: 340,
      controlsCollapsed: true,
      listWidth: 420,
    }
    expect(parseForgePrefs(serializeForgePrefs(prefs))).toEqual(prefs)
  })

  describe('panel widths: clamped into bounds rather than rejected', () => {
    test('a controlsWidth below the minimum is raised to it', () => {
      expect(parseForgePrefs(JSON.stringify({ controlsWidth: 10 })).controlsWidth).toBe(
        FORGE_CONTROLS_WIDTH_MIN,
      )
    })

    test('a controlsWidth above the maximum is lowered to it', () => {
      expect(parseForgePrefs(JSON.stringify({ controlsWidth: 9999 })).controlsWidth).toBe(
        FORGE_CONTROLS_WIDTH_MAX,
      )
    })

    test('a controlsWidth of the wrong type falls back to the default, not a clamp', () => {
      expect(parseForgePrefs(JSON.stringify({ controlsWidth: '340' })).controlsWidth).toBe(
        FORGE_CONTROLS_WIDTH_DEFAULT,
      )
      expect(parseForgePrefs(JSON.stringify({ controlsWidth: null })).controlsWidth).toBe(
        FORGE_CONTROLS_WIDTH_DEFAULT,
      )
    })

    test('a listWidth below the minimum is raised to it', () => {
      expect(parseForgePrefs(JSON.stringify({ listWidth: 10 })).listWidth).toBe(
        FORGE_LIST_WIDTH_MIN,
      )
    })

    test('a listWidth above the maximum is lowered to it', () => {
      expect(parseForgePrefs(JSON.stringify({ listWidth: 9999 })).listWidth).toBe(
        FORGE_LIST_WIDTH_MAX,
      )
    })

    test('widths exactly at the bounds pass through unchanged', () => {
      const parsed = parseForgePrefs(
        JSON.stringify({
          controlsWidth: FORGE_CONTROLS_WIDTH_MIN,
          listWidth: FORGE_LIST_WIDTH_MAX,
        }),
      )
      expect(parsed.controlsWidth).toBe(FORGE_CONTROLS_WIDTH_MIN)
      expect(parsed.listWidth).toBe(FORGE_LIST_WIDTH_MAX)
    })

    test('a valid listWidth in range is kept as-is, unrelated to the default', () => {
      expect(parseForgePrefs(JSON.stringify({ listWidth: 450 })).listWidth).toBe(450)
      expect(450).not.toBe(FORGE_LIST_WIDTH_DEFAULT)
    })
  })

  describe('controlsCollapsed', () => {
    test('a mistyped controlsCollapsed falls back to the default (false)', () => {
      expect(parseForgePrefs(JSON.stringify({ controlsCollapsed: 'yes' })).controlsCollapsed).toBe(
        DEFAULT_FORGE_PREFS.controlsCollapsed,
      )
    })

    test('a real boolean is honored either way', () => {
      expect(parseForgePrefs(JSON.stringify({ controlsCollapsed: true })).controlsCollapsed).toBe(
        true,
      )
      expect(parseForgePrefs(JSON.stringify({ controlsCollapsed: false })).controlsCollapsed).toBe(
        false,
      )
    })
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

      const prefs: ForgePrefs = {
        ...DEFAULT_FORGE_PREFS,
        issuesSort: 'title',
        controlsCollapsed: true,
      }
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
