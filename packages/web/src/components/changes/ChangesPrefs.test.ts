import { describe, expect, test } from 'bun:test'
import { CHANGES_PANEL_WIDTH_MIN } from './ChangesLogic'
import {
  CHANGES_PREFS_STORAGE_KEY,
  DEFAULT_CHANGES_PREFS,
  parseChangesPrefs,
  readChangesPrefs,
  serializeChangesPrefs,
  writeChangesPrefs,
  type ChangesPrefs,
} from './ChangesPrefs'

describe('parseChangesPrefs', () => {
  test('absent (null) falls back to the default', () => {
    expect(parseChangesPrefs(null)).toEqual(DEFAULT_CHANGES_PREFS)
  })

  test('an empty object falls back to the default width', () => {
    expect(parseChangesPrefs('{}')).toEqual(DEFAULT_CHANGES_PREFS)
  })

  test('a corrupted (non-JSON) blob falls back to the default', () => {
    expect(parseChangesPrefs('not json')).toEqual(DEFAULT_CHANGES_PREFS)
  })

  test('a JSON value that is not an object falls back to the default', () => {
    expect(parseChangesPrefs('42')).toEqual(DEFAULT_CHANGES_PREFS)
    expect(parseChangesPrefs('null')).toEqual(DEFAULT_CHANGES_PREFS)
    expect(parseChangesPrefs('[1,2,3]')).toEqual(DEFAULT_CHANGES_PREFS)
  })

  test('a mistyped width falls back to the default, not a clamp', () => {
    expect(parseChangesPrefs('{"width":"460"}')).toEqual(DEFAULT_CHANGES_PREFS)
    expect(parseChangesPrefs('{"width":null}')).toEqual(DEFAULT_CHANGES_PREFS)
    expect(parseChangesPrefs('{"width":NaN}')).toEqual(DEFAULT_CHANGES_PREFS)
  })

  test('a valid width in range is kept as-is', () => {
    expect(parseChangesPrefs('{"width":540}')).toEqual({ width: 540 })
  })

  test('a width below the minimum is raised to it', () => {
    expect(parseChangesPrefs('{"width":10}')).toEqual({ width: CHANGES_PANEL_WIDTH_MIN })
  })

  test('a width exactly at the minimum passes through unchanged', () => {
    expect(parseChangesPrefs(`{"width":${CHANGES_PANEL_WIDTH_MIN}}`)).toEqual({
      width: CHANGES_PANEL_WIDTH_MIN,
    })
  })

  test('an unrelated extra field in the blob is ignored, not rejected', () => {
    expect(parseChangesPrefs('{"width":500,"height":300}')).toEqual({ width: 500 })
  })

  test('round-trips through serializeChangesPrefs', () => {
    const prefs: ChangesPrefs = { width: 512 }
    expect(parseChangesPrefs(serializeChangesPrefs(prefs))).toEqual(prefs)
  })
})

describe('readChangesPrefs / writeChangesPrefs (localStorage wrappers)', () => {
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
      expect(readChangesPrefs()).toEqual(DEFAULT_CHANGES_PREFS)

      const prefs: ChangesPrefs = { width: 600 }
      writeChangesPrefs(prefs)
      expect(store.get(CHANGES_PREFS_STORAGE_KEY)).toBe(JSON.stringify(prefs))
      expect(readChangesPrefs()).toEqual(prefs)

      globals.localStorage = {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
      }
      expect(readChangesPrefs()).toEqual(DEFAULT_CHANGES_PREFS)
      expect(() => writeChangesPrefs(prefs)).not.toThrow()
    } finally {
      globals.localStorage = previous
    }
  })

  test('readChangesPrefs falls back to the default when localStorage is undefined', () => {
    const globals = globalThis as { localStorage?: unknown }
    const previous = globals.localStorage
    try {
      // Simulates an environment with no storage at all (typeof localStorage
      // === 'undefined'), distinct from the "throws on access" case above.
      globals.localStorage = undefined
      expect(readChangesPrefs()).toEqual(DEFAULT_CHANGES_PREFS)
    } finally {
      globals.localStorage = previous
    }
  })
})
