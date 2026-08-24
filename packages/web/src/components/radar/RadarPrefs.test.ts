import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_RADAR_PREFS,
  parseRadarPrefs,
  RADAR_PREFS_STORAGE_KEY,
  readRadarPrefs,
  serializeRadarPrefs,
  writeRadarPrefs,
  type RadarPrefs,
} from './RadarPrefs'

describe('parseRadarPrefs', () => {
  test('absent (null) falls back to the defaults', () => {
    expect(parseRadarPrefs(null)).toEqual(DEFAULT_RADAR_PREFS)
  })

  test('an empty object falls back to the defaults for every field', () => {
    expect(parseRadarPrefs('{}')).toEqual(DEFAULT_RADAR_PREFS)
  })

  test('a partial blob keeps its known fields and defaults the rest', () => {
    const partial = parseRadarPrefs(JSON.stringify({ issuesSort: 'title', mrsLabels: ['ui'] }))
    expect(partial).toEqual({
      ...DEFAULT_RADAR_PREFS,
      issuesSort: 'title',
      mrsLabels: ['ui'],
    })
  })

  test('a corrupted (non-JSON) blob falls back to the defaults', () => {
    expect(parseRadarPrefs('{not json')).toEqual(DEFAULT_RADAR_PREFS)
  })

  test('a JSON value that is not an object falls back to the defaults', () => {
    expect(parseRadarPrefs('42')).toEqual(DEFAULT_RADAR_PREFS)
    expect(parseRadarPrefs('null')).toEqual(DEFAULT_RADAR_PREFS)
    expect(parseRadarPrefs('"hello"')).toEqual(DEFAULT_RADAR_PREFS)
    expect(parseRadarPrefs('[1,2,3]')).toEqual(DEFAULT_RADAR_PREFS)
  })

  test('a mistyped field is ignored in favor of its default, others still honored', () => {
    const parsed = parseRadarPrefs(
      JSON.stringify({ issuesOpen: 'yes', mrsFilter: 'draft', issuesLabels: ['a', 2, 'b'] }),
    )
    expect(parsed.issuesOpen).toBe(DEFAULT_RADAR_PREFS.issuesOpen)
    expect(parsed.mrsFilter).toBe('draft')
    expect(parsed.issuesLabels).toEqual(DEFAULT_RADAR_PREFS.issuesLabels)
  })

  test('an unknown sort key or filter value falls back to its default', () => {
    const parsed = parseRadarPrefs(
      JSON.stringify({ issuesSort: 'popularity', mrsFilter: 'closed' }),
    )
    expect(parsed.issuesSort).toBe(DEFAULT_RADAR_PREFS.issuesSort)
    expect(parsed.mrsFilter).toBe(DEFAULT_RADAR_PREFS.mrsFilter)
  })

  test('round-trips through serializeRadarPrefs', () => {
    const prefs: RadarPrefs = {
      issuesOpen: false,
      mrsOpen: true,
      issuesSort: 'title',
      mrsSort: 'updated',
      mrsFilter: 'ready',
      issuesLabels: ['bug'],
      mrsLabels: [],
    }
    expect(parseRadarPrefs(serializeRadarPrefs(prefs))).toEqual(prefs)
  })
})

describe('readRadarPrefs / writeRadarPrefs (localStorage wrappers)', () => {
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
      expect(readRadarPrefs()).toEqual(DEFAULT_RADAR_PREFS)

      const prefs: RadarPrefs = { ...DEFAULT_RADAR_PREFS, issuesSort: 'title', mrsOpen: false }
      writeRadarPrefs(prefs)
      expect(store.get(RADAR_PREFS_STORAGE_KEY)).toBe(JSON.stringify(prefs))
      expect(readRadarPrefs()).toEqual(prefs)

      globals.localStorage = {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
      }
      expect(readRadarPrefs()).toEqual(DEFAULT_RADAR_PREFS)
      expect(() => writeRadarPrefs(prefs)).not.toThrow()
    } finally {
      globals.localStorage = previous
    }
  })
})
