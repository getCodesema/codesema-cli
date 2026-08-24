// Pure sort/filter/count logic shared by the two Issue Radar lists (issues
// and merge requests). Split out so it is testable on its own, with no DOM
// and no fetch: IssueRadar.vue only composes these functions.

import type { ForgeMr } from '../../types'

/** The two sort criteria offered on both lists: both fields exist, unconditionally,
 * on ForgeIssue and ForgeMr alike, so neither can produce a "null" ordering gap. */
export type RadarSortKey = 'updated' | 'title'

/** Stable descending sort on `updatedAt`: ties (equal timestamps) keep their
 * original relative order, per `toSorted`'s stability guarantee. */
export function sortByUpdated<T extends { updatedAt: string }>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

/** Stable alphabetical sort on `title`, locale-aware; ties keep their original order. */
export function sortByTitle<T extends { title: string }>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => a.title.localeCompare(b.title))
}

export function radarSort<T extends { updatedAt: string; title: string }>(
  items: readonly T[],
  key: RadarSortKey,
): T[] {
  return key === 'title' ? sortByTitle(items) : sortByUpdated(items)
}

/**
 * One label's tally over the currently loaded (and, for MRs, state-filtered)
 * items: never a hardcoded catalog, always derived from what is on screen.
 * Sorted by descending count, ties broken alphabetically for a stable list.
 */
export type LabelCount = { label: string; count: number }

export function radarLabelCounts<T extends { labels: readonly string[] | null }>(
  items: readonly T[],
): LabelCount[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    for (const label of item.labels ?? []) {
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .toSorted((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

/**
 * Cumulable label selection: AND semantics, each additional label narrows the
 * result further (the usual reading of "cumulable" filters, mirroring
 * GitHub's own multi-label filter). `null` labels (the forge did not report
 * any) never match a non-empty selection: an unknown is not a match.
 */
export function matchesLabels(
  itemLabels: readonly string[] | null,
  selected: readonly string[],
): boolean {
  if (selected.length === 0) {
    return true
  }
  const labels = itemLabels ?? []
  return selected.every((label) => labels.includes(label))
}

export function radarFilterByLabels<T extends { labels: readonly string[] | null }>(
  items: readonly T[],
  selected: readonly string[],
): T[] {
  return items.filter((item) => matchesLabels(item.labels, selected))
}

/**
 * MR-only exclusive filter: the one field that actually discriminates inside
 * an OPEN-only corpus (issues carry no such field once narrowed to `open`).
 * `ready` mirrors MrCard's own badge reading of `isDraft`: `false` and `null`
 * (unknown) both show as "not a draft", so the filter agrees with what the
 * card itself displays rather than hiding an unknown-draft MR from both sides.
 */
export type MrStateFilter = 'all' | 'draft' | 'ready'

export function matchesMrStateFilter(mr: Pick<ForgeMr, 'isDraft'>, filter: MrStateFilter): boolean {
  if (filter === 'all') {
    return true
  }
  if (filter === 'draft') {
    return mr.isDraft === true
  }
  return mr.isDraft !== true
}

export function radarFilterMrsByState<T extends Pick<ForgeMr, 'isDraft'>>(
  items: readonly T[],
  filter: MrStateFilter,
): T[] {
  return items.filter((item) => matchesMrStateFilter(item, filter))
}
