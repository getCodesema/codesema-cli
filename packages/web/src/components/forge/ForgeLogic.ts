// Pure sort/filter/count logic shared by the two forge board lists (issues
// and merge requests), plus the panel-resizing and selection math for the
// three-panel shell. Split out so it is testable on its own, with no DOM and
// no fetch: ForgeBoard.vue only composes these functions.

import type { ForgeIssue, ForgeLabel, ForgeMr } from '../../types'

/** The two sort criteria offered on both lists: both fields exist, unconditionally,
 * on ForgeIssue and ForgeMr alike, so neither can produce a "null" ordering gap. */
export type ForgeSortKey = 'updated' | 'title'

/** Stable descending sort on `updatedAt`: ties (equal timestamps) keep their
 * original relative order, per `toSorted`'s stability guarantee. */
export function sortByUpdated<T extends { updatedAt: string }>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

/** Stable alphabetical sort on `title`, locale-aware; ties keep their original order. */
export function sortByTitle<T extends { title: string }>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => a.title.localeCompare(b.title))
}

export function forgeSort<T extends { updatedAt: string; title: string }>(
  items: readonly T[],
  key: ForgeSortKey,
): T[] {
  return key === 'title' ? sortByTitle(items) : sortByUpdated(items)
}

/**
 * One label's tally over the currently loaded (and, for MRs, state-filtered)
 * items: never a hardcoded catalog, always derived from what is on screen.
 * Sorted by descending count, ties broken alphabetically for a stable list.
 * `color` is carried along purely for display (the first color seen under
 * that name): counting and filtering both still key on `label` alone, per
 * `matchesLabels` below.
 */
export type LabelCount = { label: string; color: string | null; count: number }

export function forgeLabelCounts<T extends { labels: readonly ForgeLabel[] | null }>(
  items: readonly T[],
): LabelCount[] {
  const counts = new Map<string, { color: string | null; count: number }>()
  for (const item of items) {
    for (const label of item.labels ?? []) {
      const existing = counts.get(label.name)
      counts.set(label.name, {
        color: existing?.color ?? label.color,
        count: (existing?.count ?? 0) + 1,
      })
    }
  }
  return [...counts.entries()]
    .map(([label, { color, count }]) => ({ label, color, count }))
    .toSorted((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/**
 * Cumulable label selection: AND semantics, each additional label narrows the
 * result further (the usual reading of "cumulable" filters, mirroring
 * GitHub's own multi-label filter). `null` labels (the forge did not report
 * any) never match a non-empty selection: an unknown is not a match. Matching
 * is always by name: a label's color is a display attribute, never part of
 * its identity.
 */
export function matchesLabels(
  itemLabels: readonly ForgeLabel[] | null,
  selected: readonly string[],
): boolean {
  if (selected.length === 0) {
    return true
  }
  const names = new Set((itemLabels ?? []).map((label) => label.name))
  return selected.every((label) => names.has(label))
}

export function forgeFilterByLabels<T extends { labels: readonly ForgeLabel[] | null }>(
  items: readonly T[],
  selected: readonly string[],
): T[] {
  return items.filter((item) => matchesLabels(item.labels, selected))
}

/**
 * Case-insensitive substring match of a label search query against each
 * count's own name (never against `color`, an implementation detail no
 * reader searches by). An empty or whitespace-only query is the search box's
 * own rest state and matches everything, so opening the search never hides
 * a chip that was visible a moment before.
 */
export function filterLabelCounts(counts: readonly LabelCount[], query: string): LabelCount[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') {
    return [...counts]
  }
  return counts.filter((entry) => entry.label.toLowerCase().includes(needle))
}

/**
 * Draft is a CUMULATIVE toggle applied to the list already fetched, and it
 * is not a state. The state -- open, merged, closed -- is a different thing
 * entirely: it is exclusive, it changes the QUERY sent to the forge, and it
 * lives in `ForgeMrStateFilter` (types.ts). The two used to share one name
 * here, which is what let the panel offer `draft`/`ready` as if they were
 * states while the real state filter went unoffered.
 *
 * On `null`: a merge request whose draft flag the forge never reported is
 * NOT shown when the toggle is on. `null` means "unknown", and a filter
 * asking for drafts only cannot honestly include one it cannot vouch for.
 * With the toggle off it shows like any other, which matches the card, whose
 * badge treats `false` and `null` alike as "not marked a draft".
 */
export function matchesDraftOnly(mr: Pick<ForgeMr, 'isDraft'>, draftOnly: boolean): boolean {
  return !draftOnly || mr.isDraft === true
}

export function forgeFilterMrsByDraft<T extends Pick<ForgeMr, 'isDraft'>>(
  items: readonly T[],
  draftOnly: boolean,
): T[] {
  return draftOnly ? items.filter((item) => matchesDraftOnly(item, true)) : [...items]
}

// ── Panel resizing (three-panel forge board shell) ──────────────────────────

/** One keyboard/drag notch, in pixels, shared by every resizable divider. */
export const FORGE_SPLITTER_STEP = 16

/** Keeps a width inside [min, max]: the one rule every resize path (drag,
 * keyboard, and a persisted value read back from storage) shares. */
export function clampWidth(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export type ForgeSplitterBounds = { min: number; max: number; defaultWidth: number }

/**
 * The width after one keyboard interaction on a splitter (ARIA "window
 * splitter" pattern): ArrowLeft/ArrowRight move by one notch, Enter recalls
 * the panel's default width. Any other key is not this splitter's concern:
 * `null` tells the caller to leave the event alone (no preventDefault, no
 * emit).
 */
export function widthAfterKey(
  key: string,
  current: number,
  bounds: ForgeSplitterBounds,
): number | null {
  const { min, max, defaultWidth } = bounds
  if (key === 'ArrowLeft') {
    return clampWidth(current - FORGE_SPLITTER_STEP, min, max)
  }
  if (key === 'ArrowRight') {
    return clampWidth(current + FORGE_SPLITTER_STEP, min, max)
  }
  if (key === 'Enter') {
    return clampWidth(defaultWidth, min, max)
  }
  return null
}

/** The width after a pointer drag: the panel's width when the drag STARTED,
 * plus how far the pointer has moved since, clamped to bounds. */
export function widthAfterDrag(
  startWidth: number,
  deltaX: number,
  min: number,
  max: number,
): number {
  return clampWidth(startWidth + deltaX, min, max)
}

// ── Selection (the detail panel shows the item picked in the list) ──────────

export type ForgeSelection = { kind: 'issue'; number: number } | { kind: 'mr'; number: number }

export type ForgeDetailItem = { kind: 'issue'; issue: ForgeIssue } | { kind: 'mr'; mr: ForgeMr }

/**
 * Resolves a selection against the currently loaded lists: `null` both when
 * nothing is selected and when the selected item fell out of its list (a
 * refresh dropped it, the forge closed it); the detail panel then hides
 * itself rather than showing a stale card.
 */
export function resolveForgeSelection(
  selection: ForgeSelection | null,
  issues: readonly ForgeIssue[] | null,
  mrs: readonly ForgeMr[],
): ForgeDetailItem | null {
  if (selection === null) {
    return null
  }
  if (selection.kind === 'issue') {
    const issue = (issues ?? []).find((candidate) => candidate.number === selection.number)
    return issue ? { kind: 'issue', issue } : null
  }
  const mr = mrs.find((candidate) => candidate.number === selection.number)
  return mr ? { kind: 'mr', mr } : null
}
