// Persisted width of the changes panel, in its own localStorage slot: same
// doctrine as forge/ForgePrefs.ts (a pure, tolerant parse function tested on
// its own, plus a thin try/catch wrapper around the real localStorage for
// the impure edges), kept in its own module rather than added to
// ForgePrefs.ts because the two panels are unrelated surfaces (the forge
// board's three-panel shell vs. this MR side panel on a conversation) that
// happen to both persist a width, not a reason to share one blob.
//
// Only width is persisted. The fiche this panel was measured against notes
// its source persists a height too, but that panel can also dock at the
// bottom of its screen; ours only ever docks to the right edge at full
// height (fiche 14 §2), so a persisted height would have no reader. Left out
// on purpose (YAGNI), not overlooked.

import { clampWidth } from '../forge/ForgeLogic'
import { CHANGES_PANEL_WIDTH_DEFAULT, CHANGES_PANEL_WIDTH_MIN } from './ChangesLogic'

export type ChangesPrefs = {
  width: number
}

export const DEFAULT_CHANGES_PREFS: ChangesPrefs = {
  width: CHANGES_PANEL_WIDTH_DEFAULT,
}

export const CHANGES_PREFS_STORAGE_KEY = 'codesema-ws-changes-prefs'

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Tolerant parse: a missing, mistyped, or unreadable width falls back to the
 * default. A right-typed width is clamped between the panel's fixed minimum
 * and its OWN maximum for the viewport it is read back into, that maximum
 * is not known here (it depends on the reader's current window width, see
 * maxChangesPanelWidth in ChangesLogic.ts), so this function only enforces
 * the floor; the caller clamps the ceiling once it knows its viewport.
 */
export function parseChangesPrefs(raw: string | null): ChangesPrefs {
  if (raw === null) {
    return DEFAULT_CHANGES_PREFS
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return DEFAULT_CHANGES_PREFS
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return DEFAULT_CHANGES_PREFS
  }
  const p = parsed as Partial<ChangesPrefs>
  return {
    width: isFiniteNumber(p.width)
      ? clampWidth(p.width, CHANGES_PANEL_WIDTH_MIN, Number.POSITIVE_INFINITY)
      : DEFAULT_CHANGES_PREFS.width,
  }
}

export function serializeChangesPrefs(prefs: ChangesPrefs): string {
  return JSON.stringify(prefs)
}

// ── localStorage wrappers (best-effort: privacy modes / disabled storage can throw) ──

export function readChangesPrefs(): ChangesPrefs {
  try {
    if (typeof localStorage === 'undefined') {
      return DEFAULT_CHANGES_PREFS
    }
    return parseChangesPrefs(localStorage.getItem(CHANGES_PREFS_STORAGE_KEY))
  } catch {
    return DEFAULT_CHANGES_PREFS
  }
}

export function writeChangesPrefs(prefs: ChangesPrefs): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(CHANGES_PREFS_STORAGE_KEY, serializeChangesPrefs(prefs))
    }
  } catch {
    // Best-effort, like every other persisted UI preference in this app.
  }
}
