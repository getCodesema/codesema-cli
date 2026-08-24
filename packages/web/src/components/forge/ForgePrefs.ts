// One JSON blob of forge board UI preferences (accordion open/closed, sort,
// filters, selected labels), persisted in localStorage. Same doctrine as
// useProjects.ts / useIsolation.ts: a pure parse function tested on its own,
// tolerant of an absent, empty, partial or corrupted blob, plus a thin
// try/catch wrapper around the real localStorage for the impure edges.

import type { ForgeSortKey, MrStateFilter } from './ForgeLogic'

export type ForgePrefs = {
  issuesOpen: boolean
  mrsOpen: boolean
  issuesSort: ForgeSortKey
  mrsSort: ForgeSortKey
  mrsFilter: MrStateFilter
  issuesLabels: string[]
  mrsLabels: string[]
}

export const DEFAULT_FORGE_PREFS: ForgePrefs = {
  issuesOpen: true,
  mrsOpen: true,
  issuesSort: 'updated',
  mrsSort: 'updated',
  mrsFilter: 'all',
  issuesLabels: [],
  mrsLabels: [],
}

export const FORGE_PREFS_STORAGE_KEY = 'codesema-ws-forge-prefs'

const SORT_KEYS: readonly ForgeSortKey[] = ['updated', 'title']
const MR_FILTERS: readonly MrStateFilter[] = ['all', 'draft', 'ready']

function isSortKey(value: unknown): value is ForgeSortKey {
  return typeof value === 'string' && (SORT_KEYS as readonly string[]).includes(value)
}

function isMrFilter(value: unknown): value is MrStateFilter {
  return typeof value === 'string' && (MR_FILTERS as readonly string[]).includes(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean'
}

/** Keeps `value` when `guard` accepts it, falls back to `fallback` otherwise:
 * the one branch every field of the blob shares, factored out so the parse
 * function itself is a flat list of fields rather than a chain of ternaries. */
function pick<T>(value: unknown, guard: (v: unknown) => v is T, fallback: T): T {
  return guard(value) ? value : fallback
}

/**
 * Tolerant parse: any field missing, mistyped, or the whole blob unreadable
 * (not JSON, not an object) falls back to its own default rather than
 * rejecting the whole blob: a partial preference set is still worth honoring.
 */
export function parseForgePrefs(raw: string | null): ForgePrefs {
  if (raw === null) {
    return DEFAULT_FORGE_PREFS
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_FORGE_PREFS
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return DEFAULT_FORGE_PREFS
  }
  const p = parsed as Partial<ForgePrefs>
  return {
    issuesOpen: pick(p.issuesOpen, isBoolean, DEFAULT_FORGE_PREFS.issuesOpen),
    mrsOpen: pick(p.mrsOpen, isBoolean, DEFAULT_FORGE_PREFS.mrsOpen),
    issuesSort: pick(p.issuesSort, isSortKey, DEFAULT_FORGE_PREFS.issuesSort),
    mrsSort: pick(p.mrsSort, isSortKey, DEFAULT_FORGE_PREFS.mrsSort),
    mrsFilter: pick(p.mrsFilter, isMrFilter, DEFAULT_FORGE_PREFS.mrsFilter),
    issuesLabels: pick(p.issuesLabels, isStringArray, DEFAULT_FORGE_PREFS.issuesLabels),
    mrsLabels: pick(p.mrsLabels, isStringArray, DEFAULT_FORGE_PREFS.mrsLabels),
  }
}

export function serializeForgePrefs(prefs: ForgePrefs): string {
  return JSON.stringify(prefs)
}

// ── localStorage wrappers (best-effort: privacy modes / disabled storage can throw) ──

export function readForgePrefs(): ForgePrefs {
  try {
    if (typeof localStorage === 'undefined') {
      return DEFAULT_FORGE_PREFS
    }
    return parseForgePrefs(localStorage.getItem(FORGE_PREFS_STORAGE_KEY))
  } catch {
    return DEFAULT_FORGE_PREFS
  }
}

export function writeForgePrefs(prefs: ForgePrefs): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(FORGE_PREFS_STORAGE_KEY, serializeForgePrefs(prefs))
    }
  } catch {
    // Best-effort, like every other persisted UI preference in this app.
  }
}
