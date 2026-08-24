// One JSON blob of forge board UI preferences: which section is active
// (issues or pull requests, replacing the old two-open accordions), sort,
// filters, selected labels, and the three-panel shell's own layout
// (controls/list panel widths, controls collapsed state), persisted in
// localStorage. Same doctrine as useProjects.ts / useIsolation.ts: a pure
// parse function tested on its own, tolerant of an absent, empty, partial or
// corrupted blob, plus a thin try/catch wrapper around the real localStorage
// for the impure edges.

import { clampWidth, type ForgeSortKey, type MrStateFilter } from './ForgeLogic'

export type ForgeSection = 'issues' | 'mrs'

export type ForgePrefs = {
  activeSection: ForgeSection
  issuesSort: ForgeSortKey
  mrsSort: ForgeSortKey
  mrsFilter: MrStateFilter
  issuesLabels: string[]
  mrsLabels: string[]
  /** Controls panel width in px, or its collapsed-rail width when collapsed. */
  controlsWidth: number
  controlsCollapsed: boolean
  listWidth: number
}

export const FORGE_CONTROLS_WIDTH_DEFAULT = 288
export const FORGE_CONTROLS_WIDTH_MIN = 220
export const FORGE_CONTROLS_WIDTH_MAX = 460
/** The controls panel's own width while collapsed: not persisted as
 * `controlsWidth` (that field keeps the width to restore on expand). */
export const FORGE_CONTROLS_COLLAPSED_WIDTH = 48

export const FORGE_LIST_WIDTH_DEFAULT = 320
export const FORGE_LIST_WIDTH_MIN = 240
export const FORGE_LIST_WIDTH_MAX = 600

export const DEFAULT_FORGE_PREFS: ForgePrefs = {
  activeSection: 'issues',
  issuesSort: 'updated',
  mrsSort: 'updated',
  mrsFilter: 'all',
  issuesLabels: [],
  mrsLabels: [],
  controlsWidth: FORGE_CONTROLS_WIDTH_DEFAULT,
  controlsCollapsed: false,
  listWidth: FORGE_LIST_WIDTH_DEFAULT,
}

export const FORGE_PREFS_STORAGE_KEY = 'codesema-ws-forge-prefs'

const SECTIONS: readonly ForgeSection[] = ['issues', 'mrs']
const SORT_KEYS: readonly ForgeSortKey[] = ['updated', 'title']
const MR_FILTERS: readonly MrStateFilter[] = ['all', 'draft', 'ready']

function isSection(value: unknown): value is ForgeSection {
  return typeof value === 'string' && (SECTIONS as readonly string[]).includes(value)
}

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

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** Keeps `value` when `guard` accepts it, falls back to `fallback` otherwise:
 * the one branch every field of the blob shares, factored out so the parse
 * function itself is a flat list of fields rather than a chain of ternaries. */
function pick<T>(value: unknown, guard: (v: unknown) => v is T, fallback: T): T {
  return guard(value) ? value : fallback
}

/**
 * Same tolerance as `pick`, but for a panel width: a wrong TYPE falls back to
 * `fallback` like every other field, while a right-typed value outside
 * [min, max] is clamped into range rather than rejected outright: a window
 * resized between sessions should not silently forget the width the reader
 * chose, only bring it back inside what still fits.
 */
function pickWidth(value: unknown, min: number, max: number, fallback: number): number {
  return isFiniteNumber(value) ? clampWidth(value, min, max) : fallback
}

/**
 * Tolerant parse: any field missing, mistyped, or the whole blob unreadable
 * (not JSON, not an object) falls back to its own default rather than
 * rejecting the whole blob: a partial preference set is still worth honoring.
 * Also accepts (and silently ignores) fields from an older shape of this blob
 * (e.g. the earlier `issuesOpen`/`mrsOpen` accordion fold flags): an unknown
 * key never rejects the whole blob either.
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
    activeSection: pick(p.activeSection, isSection, DEFAULT_FORGE_PREFS.activeSection),
    issuesSort: pick(p.issuesSort, isSortKey, DEFAULT_FORGE_PREFS.issuesSort),
    mrsSort: pick(p.mrsSort, isSortKey, DEFAULT_FORGE_PREFS.mrsSort),
    mrsFilter: pick(p.mrsFilter, isMrFilter, DEFAULT_FORGE_PREFS.mrsFilter),
    issuesLabels: pick(p.issuesLabels, isStringArray, DEFAULT_FORGE_PREFS.issuesLabels),
    mrsLabels: pick(p.mrsLabels, isStringArray, DEFAULT_FORGE_PREFS.mrsLabels),
    controlsWidth: pickWidth(
      p.controlsWidth,
      FORGE_CONTROLS_WIDTH_MIN,
      FORGE_CONTROLS_WIDTH_MAX,
      DEFAULT_FORGE_PREFS.controlsWidth,
    ),
    controlsCollapsed: pick(p.controlsCollapsed, isBoolean, DEFAULT_FORGE_PREFS.controlsCollapsed),
    listWidth: pickWidth(
      p.listWidth,
      FORGE_LIST_WIDTH_MIN,
      FORGE_LIST_WIDTH_MAX,
      DEFAULT_FORGE_PREFS.listWidth,
    ),
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
