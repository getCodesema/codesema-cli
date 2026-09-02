// Persisted layout preferences of the pilot workspace: which lane cards the
// reader closed and which shell (pilot vs. classic) they last picked.
// One JSON blob in localStorage, same doctrine as useRailPrefs.ts: a pure
// parse function tested on its own, tolerant of an absent, empty, partial or
// corrupted blob, plus a thin try/catch wrapper around the real localStorage
// for the impure edges. The `use*()` factory itself (reactive refs, one per
// field, persisted on every mutation) follows useForgePrefs.ts.

import { computed, ref, watch, type Ref } from 'vue'

export type PilotShell = 'pilot' | 'classic'

export type PilotPrefs = {
  closed: string[]
  shell: PilotShell
}

export const DEFAULT_PILOT_PREFS: PilotPrefs = {
  closed: [],
  shell: 'pilot',
}

export const PILOT_PREFS_STORAGE_KEY = 'codesema.pilot.prefs'

const SHELLS: readonly PilotShell[] = ['pilot', 'classic']

function isShell(value: unknown): value is PilotShell {
  return typeof value === 'string' && (SHELLS as readonly string[]).includes(value)
}

function isClosedList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)
}

/**
 * Tolerant parse of an already-JSON.parse'd value (the localStorage string
 * itself is decoded by `readPilotPrefs`, below, same split as
 * `parseChecksSetup`/`parseSettingsSnapshot`): any field missing, mistyped,
 * or the whole value unreadable falls back to its own default rather than
 * rejecting the whole blob.
 */
export function parsePilotPrefs(raw: unknown): PilotPrefs {
  if (typeof raw !== 'object' || raw === null) {
    return DEFAULT_PILOT_PREFS
  }
  const p = raw as Partial<PilotPrefs>
  return {
    closed: isClosedList(p.closed) ? p.closed : DEFAULT_PILOT_PREFS.closed,
    shell: isShell(p.shell) ? p.shell : DEFAULT_PILOT_PREFS.shell,
  }
}

export function serializePilotPrefs(prefs: PilotPrefs): string {
  return JSON.stringify(prefs)
}

// ── localStorage wrappers (best-effort: privacy modes / disabled storage can throw) ──

export function readPilotPrefs(): PilotPrefs {
  try {
    if (typeof localStorage === 'undefined') {
      return DEFAULT_PILOT_PREFS
    }
    const raw = localStorage.getItem(PILOT_PREFS_STORAGE_KEY)
    if (raw === null) {
      return DEFAULT_PILOT_PREFS
    }
    return parsePilotPrefs(JSON.parse(raw))
  } catch {
    return DEFAULT_PILOT_PREFS
  }
}

export function writePilotPrefs(prefs: PilotPrefs): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(PILOT_PREFS_STORAGE_KEY, serializePilotPrefs(prefs))
    }
  } catch {
    // Best-effort, like every other persisted UI preference in this app.
  }
}

// ── Reactive store (one ref per field, whole blob persisted on mutation) ──

export type PilotPrefsStore = {
  /** The whole blob, for callers that want it as one value. */
  prefs: Ref<PilotPrefs>
  closed: Ref<string[]>
  shell: Ref<PilotShell>
}

export function usePilotPrefs(): PilotPrefsStore {
  const prefs = ref(readPilotPrefs())

  watch(prefs, (next) => writePilotPrefs(next), { deep: true })

  /** One field of the blob as a read/write ref: every write replaces the
   * whole blob, which is what the deep watcher above persists. */
  function field<K extends keyof PilotPrefs>(key: K): Ref<PilotPrefs[K]> {
    return computed({
      get: () => prefs.value[key],
      set: (value: PilotPrefs[K]) => (prefs.value = { ...prefs.value, [key]: value }),
    })
  }

  return {
    prefs,
    closed: field('closed'),
    shell: field('shell'),
  }
}
