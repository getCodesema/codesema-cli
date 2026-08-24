// One JSON blob of Issue Radar UI preferences (accordion open/closed, sort,
// filters, selected labels), persisted in localStorage. Same doctrine as
// useProjects.ts / useIsolation.ts: a pure parse function tested on its own,
// tolerant of an absent, empty, partial or corrupted blob, plus a thin
// try/catch wrapper around the real localStorage for the impure edges.

import type { MrStateFilter, RadarSortKey } from './RadarLogic'

export type RadarPrefs = {
  issuesOpen: boolean
  mrsOpen: boolean
  issuesSort: RadarSortKey
  mrsSort: RadarSortKey
  mrsFilter: MrStateFilter
  issuesLabels: string[]
  mrsLabels: string[]
}

export const DEFAULT_RADAR_PREFS: RadarPrefs = {
  issuesOpen: true,
  mrsOpen: true,
  issuesSort: 'updated',
  mrsSort: 'updated',
  mrsFilter: 'all',
  issuesLabels: [],
  mrsLabels: [],
}

export const RADAR_PREFS_STORAGE_KEY = 'codesema-ws-radar-prefs'

const SORT_KEYS: readonly RadarSortKey[] = ['updated', 'title']
const MR_FILTERS: readonly MrStateFilter[] = ['all', 'draft', 'ready']

function isSortKey(value: unknown): value is RadarSortKey {
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
export function parseRadarPrefs(raw: string | null): RadarPrefs {
  if (raw === null) {
    return DEFAULT_RADAR_PREFS
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_RADAR_PREFS
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return DEFAULT_RADAR_PREFS
  }
  const p = parsed as Partial<RadarPrefs>
  return {
    issuesOpen: pick(p.issuesOpen, isBoolean, DEFAULT_RADAR_PREFS.issuesOpen),
    mrsOpen: pick(p.mrsOpen, isBoolean, DEFAULT_RADAR_PREFS.mrsOpen),
    issuesSort: pick(p.issuesSort, isSortKey, DEFAULT_RADAR_PREFS.issuesSort),
    mrsSort: pick(p.mrsSort, isSortKey, DEFAULT_RADAR_PREFS.mrsSort),
    mrsFilter: pick(p.mrsFilter, isMrFilter, DEFAULT_RADAR_PREFS.mrsFilter),
    issuesLabels: pick(p.issuesLabels, isStringArray, DEFAULT_RADAR_PREFS.issuesLabels),
    mrsLabels: pick(p.mrsLabels, isStringArray, DEFAULT_RADAR_PREFS.mrsLabels),
  }
}

export function serializeRadarPrefs(prefs: RadarPrefs): string {
  return JSON.stringify(prefs)
}

// ── localStorage wrappers (best-effort: privacy modes / disabled storage can throw) ──

export function readRadarPrefs(): RadarPrefs {
  try {
    if (typeof localStorage === 'undefined') {
      return DEFAULT_RADAR_PREFS
    }
    return parseRadarPrefs(localStorage.getItem(RADAR_PREFS_STORAGE_KEY))
  } catch {
    return DEFAULT_RADAR_PREFS
  }
}

export function writeRadarPrefs(prefs: RadarPrefs): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(RADAR_PREFS_STORAGE_KEY, serializeRadarPrefs(prefs))
    }
  } catch {
    // Best-effort, like every other persisted UI preference in this app.
  }
}
