// Persisted layout/nav preferences of the workspace's permanent left rail:
// the list column's width, which top-level category is active, whether the
// rail is collapsed, and the last selected project/repo tab. One JSON blob
// in localStorage, same doctrine as ForgePrefs.ts: a pure parse function
// tested on its own, tolerant of an absent, empty, partial or corrupted
// blob (an out-of-range width is CLAMPED, never rejected), plus a thin
// try/catch wrapper around the real localStorage for the impure edges (the
// accessor itself throws in private browsing).

import type { NavCategory, RepoTab } from './useWorkspaceNav'

/**
 * Deliberately never the FocusView itself: reloading the page must land the
 * rail back where the reader left it WITHOUT resurrecting an in-progress
 * draft, reopening a conversation as though it were still live, or popping a
 * review back up. Only the rail's own chrome survives a reload.
 */
export type RailPrefs = {
  listWidth: number
  category: NavCategory
  navCollapsed: boolean
  activeProjectId: string | null
  activeRepoTab: RepoTab
}

export const RAIL_LIST_WIDTH_MIN = 240
export const RAIL_LIST_WIDTH_MAX = 480
export const RAIL_LIST_WIDTH_DEFAULT = 300

export const DEFAULT_RAIL_PREFS: RailPrefs = {
  listWidth: RAIL_LIST_WIDTH_DEFAULT,
  category: 'conversations',
  navCollapsed: false,
  activeProjectId: null,
  activeRepoTab: 'branches',
}

export const RAIL_PREFS_STORAGE_KEY = 'codesema-ws-rail-prefs'

const CATEGORIES: readonly NavCategory[] = ['conversations', 'repositories', 'codeReview']
const REPO_TABS: readonly RepoTab[] = ['branches', 'issues', 'mrs']

function isCategory(value: unknown): value is NavCategory {
  return typeof value === 'string' && (CATEGORIES as readonly string[]).includes(value)
}

function isRepoTab(value: unknown): value is RepoTab {
  return typeof value === 'string' && (REPO_TABS as readonly string[]).includes(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
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

function clampWidth(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Same tolerance as `pick`, but for the list width: a wrong TYPE falls back
 * to `fallback` like every other field, while a right-typed value outside
 * [min, max] is clamped into range rather than rejected outright. */
function pickWidth(value: unknown, min: number, max: number, fallback: number): number {
  return isFiniteNumber(value) ? clampWidth(value, min, max) : fallback
}

/**
 * Tolerant parse: any field missing, mistyped, or the whole blob unreadable
 * (not JSON, not an object) falls back to its own default rather than
 * rejecting the whole blob: a partial preference set is still worth honoring.
 */
export function parseRailPrefs(raw: string | null): RailPrefs {
  if (raw === null) {
    return DEFAULT_RAIL_PREFS
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_RAIL_PREFS
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return DEFAULT_RAIL_PREFS
  }
  const p = parsed as Partial<RailPrefs>
  return {
    listWidth: pickWidth(
      p.listWidth,
      RAIL_LIST_WIDTH_MIN,
      RAIL_LIST_WIDTH_MAX,
      DEFAULT_RAIL_PREFS.listWidth,
    ),
    category: pick(p.category, isCategory, DEFAULT_RAIL_PREFS.category),
    navCollapsed: pick(p.navCollapsed, isBoolean, DEFAULT_RAIL_PREFS.navCollapsed),
    activeProjectId: pick(p.activeProjectId, isNullableString, DEFAULT_RAIL_PREFS.activeProjectId),
    activeRepoTab: pick(p.activeRepoTab, isRepoTab, DEFAULT_RAIL_PREFS.activeRepoTab),
  }
}

export function serializeRailPrefs(prefs: RailPrefs): string {
  return JSON.stringify(prefs)
}

// ── localStorage wrappers (best-effort: privacy modes / disabled storage can throw) ──

export function readRailPrefs(): RailPrefs {
  try {
    if (typeof localStorage === 'undefined') {
      return DEFAULT_RAIL_PREFS
    }
    return parseRailPrefs(localStorage.getItem(RAIL_PREFS_STORAGE_KEY))
  } catch {
    return DEFAULT_RAIL_PREFS
  }
}

export function writeRailPrefs(prefs: RailPrefs): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(RAIL_PREFS_STORAGE_KEY, serializeRailPrefs(prefs))
    }
  } catch {
    // Best-effort, like every other persisted UI preference in this app.
  }
}
