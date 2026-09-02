import { describe, expect, test } from 'bun:test'
import { nextTick } from 'vue'
import {
  DEFAULT_PILOT_PREFS,
  parsePilotPrefs,
  PILOT_PREFS_STORAGE_KEY,
  readPilotPrefs,
  serializePilotPrefs,
  usePilotPrefs,
  writePilotPrefs,
  type PilotPrefs,
} from './usePilotPrefs'

describe('parsePilotPrefs', () => {
  test('null falls back to the defaults', () => {
    expect(parsePilotPrefs(null)).toEqual(DEFAULT_PILOT_PREFS)
  })

  test('a non-object value falls back to the defaults', () => {
    expect(parsePilotPrefs(undefined)).toEqual(DEFAULT_PILOT_PREFS)
    expect(parsePilotPrefs(42)).toEqual(DEFAULT_PILOT_PREFS)
    expect(parsePilotPrefs('pilot')).toEqual(DEFAULT_PILOT_PREFS)
  })

  test('an empty object falls back to the defaults for every field', () => {
    expect(parsePilotPrefs({})).toEqual(DEFAULT_PILOT_PREFS)
  })

  test('a partial blob keeps its known fields and defaults the rest', () => {
    expect(parsePilotPrefs({ shell: 'classic' })).toEqual({
      ...DEFAULT_PILOT_PREFS,
      shell: 'classic',
    })
    expect(parsePilotPrefs({ closed: ['t1', 't2'] })).toEqual({
      ...DEFAULT_PILOT_PREFS,
      closed: ['t1', 't2'],
    })
  })

  test('a non-array closed falls back to its default instead of a coercion', () => {
    expect(parsePilotPrefs({ closed: 't1' }).closed).toEqual(DEFAULT_PILOT_PREFS.closed)
    expect(parsePilotPrefs({ closed: 42 }).closed).toEqual(DEFAULT_PILOT_PREFS.closed)
  })

  test('an array with a non-string or empty-string entry falls back to its default whole', () => {
    expect(parsePilotPrefs({ closed: ['t1', 2] }).closed).toEqual(DEFAULT_PILOT_PREFS.closed)
    expect(parsePilotPrefs({ closed: ['t1', ''] }).closed).toEqual(DEFAULT_PILOT_PREFS.closed)
  })

  test('an unknown shell falls back to its default', () => {
    expect(parsePilotPrefs({ shell: 'legacy' }).shell).toBe(DEFAULT_PILOT_PREFS.shell)
    expect(parsePilotPrefs({ shell: 42 }).shell).toBe(DEFAULT_PILOT_PREFS.shell)
  })

  test('every known shell round-trips', () => {
    for (const shell of ['pilot', 'classic'] as const) {
      expect(parsePilotPrefs({ shell }).shell).toBe(shell)
    }
  })

  test('round-trips through serializePilotPrefs + JSON.parse', () => {
    const prefs: PilotPrefs = { closed: ['t1'], shell: 'classic' }
    expect(parsePilotPrefs(JSON.parse(serializePilotPrefs(prefs)))).toEqual(prefs)
  })
})

describe('readPilotPrefs / writePilotPrefs (localStorage wrappers)', () => {
  test('reads and writes through a working localStorage, and survives a hostile or corrupted one', () => {
    const store = new Map<string, string>()
    const stub = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }
    const globals = globalThis as { localStorage?: unknown }
    const previous = globals.localStorage
    try {
      globals.localStorage = stub
      expect(readPilotPrefs()).toEqual(DEFAULT_PILOT_PREFS)

      const prefs: PilotPrefs = { closed: ['t1', 't2'], shell: 'classic' }
      writePilotPrefs(prefs)
      expect(store.get(PILOT_PREFS_STORAGE_KEY)).toBe(JSON.stringify(prefs))
      expect(readPilotPrefs()).toEqual(prefs)

      store.set(PILOT_PREFS_STORAGE_KEY, '{not json')
      expect(readPilotPrefs()).toEqual(DEFAULT_PILOT_PREFS)

      globals.localStorage = {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
      }
      expect(readPilotPrefs()).toEqual(DEFAULT_PILOT_PREFS)
      expect(() => writePilotPrefs(prefs)).not.toThrow()
    } finally {
      globals.localStorage = previous
    }
  })
})

describe('usePilotPrefs', () => {
  test('mutating a field ref updates the whole blob and persists it', async () => {
    const store = new Map<string, string>()
    const stub = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }
    const globals = globalThis as { localStorage?: unknown }
    const previous = globals.localStorage
    try {
      globals.localStorage = stub
      const { prefs, closed, shell } = usePilotPrefs()

      expect(prefs.value).toEqual(DEFAULT_PILOT_PREFS)

      closed.value = ['t1']
      expect(prefs.value.closed).toEqual(['t1'])
      expect(closed.value).toEqual(['t1'])

      shell.value = 'classic'
      expect(prefs.value).toEqual({ closed: ['t1'], shell: 'classic' })
      expect(shell.value).toBe('classic')

      // The persisting watcher is batched (Vue's default flush), so it only
      // runs once the microtask queue drains.
      await nextTick()
      expect(store.get(PILOT_PREFS_STORAGE_KEY)).toBe(
        JSON.stringify({ closed: ['t1'], shell: 'classic' }),
      )
    } finally {
      globals.localStorage = previous
    }
  })

  test('two calls each get their own independent store', async () => {
    const store = new Map<string, string>()
    const stub = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    }
    const globals = globalThis as { localStorage?: unknown }
    const previous = globals.localStorage
    try {
      globals.localStorage = stub
      const first = usePilotPrefs()
      first.closed.value = ['t1']
      await nextTick()
      const second = usePilotPrefs()
      expect(second.closed.value).toEqual(['t1'])
      second.closed.value = []
      expect(first.closed.value).toEqual(['t1'])
    } finally {
      globals.localStorage = previous
    }
  })
})
