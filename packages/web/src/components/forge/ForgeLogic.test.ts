import { describe, expect, test } from 'bun:test'
import type { ForgeIssue, ForgeLabel, ForgeMr } from '../../types'
import {
  clampWidth,
  filterLabelCounts,
  FORGE_SPLITTER_STEP,
  forgeFilterByLabels,
  forgeFilterMrsByDraft,
  forgeLabelCounts,
  forgeSort,
  matchesDraftOnly,
  matchesLabels,
  resolveForgeSelection,
  sortByTitle,
  sortByUpdated,
  widthAfterDrag,
  widthAfterKey,
  type LabelCount,
} from './ForgeLogic'

type Item = { title: string; updatedAt: string; labels: readonly ForgeLabel[] | null }

/** Builds ForgeLabel entries from bare names, color defaulting to null: most
 * tests below only care about names (counting, filtering), so this keeps
 * them readable. Tests that care about color pass ForgeLabel objects directly. */
function names(labels: readonly string[]): ForgeLabel[] {
  return labels.map((name) => ({ name, color: null }))
}

function item(title: string, updatedAt: string, labels: readonly string[] | null = []): Item {
  return { title, updatedAt, labels: labels === null ? null : names(labels) }
}

describe('sortByUpdated', () => {
  test('most recently updated first', () => {
    const items = [item('a', '2026-01-01T00:00:00Z'), item('b', '2026-03-01T00:00:00Z')]
    expect(sortByUpdated(items).map((i) => i.title)).toEqual(['b', 'a'])
  })

  test('equal timestamps keep their original relative order', () => {
    const items = [item('a', '2026-01-01T00:00:00Z'), item('b', '2026-01-01T00:00:00Z')]
    expect(sortByUpdated(items).map((i) => i.title)).toEqual(['a', 'b'])
  })
})

describe('sortByTitle', () => {
  test('alphabetical order', () => {
    const items = [item('Zebra', '2026-01-01T00:00:00Z'), item('Apple', '2026-01-01T00:00:00Z')]
    expect(sortByTitle(items).map((i) => i.title)).toEqual(['Apple', 'Zebra'])
  })

  test('equal titles keep their original relative order', () => {
    const items = [item('same', '2026-01-01T00:00:00Z'), item('same', '2026-02-01T00:00:00Z')]
    expect(sortByTitle(items).map((i) => i.updatedAt)).toEqual([
      '2026-01-01T00:00:00Z',
      '2026-02-01T00:00:00Z',
    ])
  })
})

describe('forgeSort', () => {
  test('dispatches to sortByUpdated for "updated"', () => {
    const items = [item('a', '2026-01-01T00:00:00Z'), item('b', '2026-03-01T00:00:00Z')]
    expect(forgeSort(items, 'updated').map((i) => i.title)).toEqual(['b', 'a'])
  })

  test('dispatches to sortByTitle for "title"', () => {
    const items = [item('Zebra', '2026-01-01T00:00:00Z'), item('Apple', '2026-01-01T00:00:00Z')]
    expect(forgeSort(items, 'title').map((i) => i.title)).toEqual(['Apple', 'Zebra'])
  })
})

describe('forgeLabelCounts', () => {
  test('tallies labels across items, descending by count then alphabetically', () => {
    const items = [
      item('a', '2026-01-01T00:00:00Z', ['bug', 'ui']),
      item('b', '2026-01-01T00:00:00Z', ['bug']),
      item('c', '2026-01-01T00:00:00Z', ['ui']),
      item('d', '2026-01-01T00:00:00Z', ['docs']),
    ]
    const counts = forgeLabelCounts(items)
    expect(counts).toEqual<LabelCount[]>([
      { label: 'bug', color: null, count: 2 },
      { label: 'ui', color: null, count: 2 },
      { label: 'docs', color: null, count: 1 },
    ])
  })

  test('null labels contribute nothing, never a fabricated "unknown" bucket', () => {
    const items = [
      item('a', '2026-01-01T00:00:00Z', null),
      item('b', '2026-01-01T00:00:00Z', ['x']),
    ]
    expect(forgeLabelCounts(items)).toEqual([{ label: 'x', color: null, count: 1 }])
  })

  test('no items, no labels: an empty list, not an error', () => {
    expect(forgeLabelCounts([])).toEqual([])
  })

  test('carries the color along for display, keyed by name (first color seen wins)', () => {
    const items: Item[] = [
      { title: 'a', updatedAt: '2026-01-01T00:00:00Z', labels: [{ name: 'bug', color: 'd73a4a' }] },
      { title: 'b', updatedAt: '2026-01-01T00:00:00Z', labels: [{ name: 'bug', color: 'ff0000' }] },
    ]
    expect(forgeLabelCounts(items)).toEqual([{ label: 'bug', color: 'd73a4a', count: 2 }])
  })

  test('a null color on the label is a real color-less fact, not a gap to fill in', () => {
    const items: Item[] = [
      { title: 'a', updatedAt: '2026-01-01T00:00:00Z', labels: [{ name: 'ui', color: null }] },
    ]
    expect(forgeLabelCounts(items)).toEqual([{ label: 'ui', color: null, count: 1 }])
  })
})

describe('filterLabelCounts', () => {
  const counts: LabelCount[] = [
    { label: 'bug', color: null, count: 3 },
    { label: 'ui-polish', color: null, count: 2 },
    { label: 'documentation', color: null, count: 1 },
  ]

  test('an empty query matches everything, in the original order', () => {
    expect(filterLabelCounts(counts, '')).toEqual(counts)
  })

  test('a whitespace-only query is the same as an empty one', () => {
    expect(filterLabelCounts(counts, '   ')).toEqual(counts)
  })

  test('matches a substring of the label name', () => {
    expect(filterLabelCounts(counts, 'ui')).toEqual([{ label: 'ui-polish', color: null, count: 2 }])
  })

  test('is case-insensitive', () => {
    expect(filterLabelCounts(counts, 'BUG')).toEqual([{ label: 'bug', color: null, count: 3 }])
  })

  test('a query matching nothing returns an empty list, not an error', () => {
    expect(filterLabelCounts(counts, 'zzz')).toEqual([])
  })

  test('leading/trailing whitespace in the query is trimmed before matching', () => {
    expect(filterLabelCounts(counts, '  doc  ')).toEqual([
      { label: 'documentation', color: null, count: 1 },
    ])
  })
})

describe('matchesLabels / forgeFilterByLabels', () => {
  test('an empty selection matches everything, including null labels', () => {
    expect(matchesLabels(null, [])).toBe(true)
    expect(matchesLabels(names(['a']), [])).toBe(true)
  })

  test('a single selected label matches items carrying it', () => {
    expect(matchesLabels(names(['bug', 'ui']), ['bug'])).toBe(true)
    expect(matchesLabels(names(['ui']), ['bug'])).toBe(false)
  })

  test('cumulative selection is AND: every selected label must be present', () => {
    expect(matchesLabels(names(['bug', 'ui']), ['bug', 'ui'])).toBe(true)
    expect(matchesLabels(names(['bug']), ['bug', 'ui'])).toBe(false)
  })

  test('null labels never match a non-empty selection', () => {
    expect(matchesLabels(null, ['bug'])).toBe(false)
  })

  test('matching is by name only: color never affects the result either way', () => {
    expect(matchesLabels([{ name: 'bug', color: 'd73a4a' }], ['bug'])).toBe(true)
    expect(matchesLabels([{ name: 'bug', color: null }], ['bug'])).toBe(true)
  })

  test('forgeFilterByLabels narrows the list accordingly', () => {
    const items = [
      item('a', '2026-01-01T00:00:00Z', ['bug', 'ui']),
      item('b', '2026-01-01T00:00:00Z', ['bug']),
      item('c', '2026-01-01T00:00:00Z', null),
    ]
    expect(forgeFilterByLabels(items, ['bug', 'ui']).map((i) => i.title)).toEqual(['a'])
    expect(forgeFilterByLabels(items, []).map((i) => i.title)).toEqual(['a', 'b', 'c'])
  })
})

describe('matchesDraftOnly / forgeFilterMrsByDraft', () => {
  test('the toggle off matches every draft state, including unknown', () => {
    expect(matchesDraftOnly({ isDraft: true }, false)).toBe(true)
    expect(matchesDraftOnly({ isDraft: false }, false)).toBe(true)
    expect(matchesDraftOnly({ isDraft: null }, false)).toBe(true)
  })

  test('the toggle on matches only an explicit true: unknown is not a draft it can vouch for', () => {
    expect(matchesDraftOnly({ isDraft: true }, true)).toBe(true)
    expect(matchesDraftOnly({ isDraft: false }, true)).toBe(false)
    expect(matchesDraftOnly({ isDraft: null }, true)).toBe(false)
  })

  test('forgeFilterMrsByDraft narrows the list accordingly', () => {
    const mrs = [{ isDraft: true }, { isDraft: false }, { isDraft: null }]
    expect(forgeFilterMrsByDraft(mrs, true)).toEqual([{ isDraft: true }])
    expect(forgeFilterMrsByDraft(mrs, false)).toEqual(mrs)
  })

  test("the off case returns a copy, never the caller's own array", () => {
    const mrs = [{ isDraft: true }]
    const out = forgeFilterMrsByDraft(mrs, false)
    expect(out).toEqual(mrs)
    expect(out).not.toBe(mrs)
  })
})

describe('clampWidth', () => {
  test('a value inside the bounds is unchanged', () => {
    expect(clampWidth(300, 220, 460)).toBe(300)
  })

  test('a value below the minimum is raised to it', () => {
    expect(clampWidth(100, 220, 460)).toBe(220)
  })

  test('a value above the maximum is lowered to it', () => {
    expect(clampWidth(900, 220, 460)).toBe(460)
  })

  test('the bounds themselves pass through unchanged', () => {
    expect(clampWidth(220, 220, 460)).toBe(220)
    expect(clampWidth(460, 220, 460)).toBe(460)
  })
})

describe('widthAfterKey', () => {
  const min = 220
  const max = 460
  const defaultWidth = 288
  const bounds = { min, max, defaultWidth }

  test('ArrowRight grows by one notch', () => {
    expect(widthAfterKey('ArrowRight', 300, bounds)).toBe(300 + FORGE_SPLITTER_STEP)
  })

  test('ArrowLeft shrinks by one notch', () => {
    expect(widthAfterKey('ArrowLeft', 300, bounds)).toBe(300 - FORGE_SPLITTER_STEP)
  })

  test('ArrowRight never grows past the maximum', () => {
    expect(widthAfterKey('ArrowRight', max, bounds)).toBe(max)
  })

  test('ArrowLeft never shrinks past the minimum', () => {
    expect(widthAfterKey('ArrowLeft', min, bounds)).toBe(min)
  })

  test('Enter recalls the default width, clamped to the current bounds', () => {
    expect(widthAfterKey('Enter', 220, bounds)).toBe(defaultWidth)
    expect(widthAfterKey('Enter', 220, { min: 300, max, defaultWidth })).toBe(300)
  })

  test("any other key is not this splitter's concern: null, not a width", () => {
    expect(widthAfterKey('Tab', 300, bounds)).toBeNull()
    expect(widthAfterKey('a', 300, bounds)).toBeNull()
  })
})

describe('widthAfterDrag', () => {
  test('a positive delta grows the width, clamped to the maximum', () => {
    expect(widthAfterDrag(300, 40, 220, 460)).toBe(340)
    expect(widthAfterDrag(440, 100, 220, 460)).toBe(460)
  })

  test('a negative delta shrinks the width, clamped to the minimum', () => {
    expect(widthAfterDrag(300, -40, 220, 460)).toBe(260)
    expect(widthAfterDrag(240, -100, 220, 460)).toBe(220)
  })

  test('a zero delta leaves the start width unchanged', () => {
    expect(widthAfterDrag(300, 0, 220, 460)).toBe(300)
  })
})

function selectionTestIssue(overrides: Partial<ForgeIssue> = {}): ForgeIssue {
  return {
    number: 1,
    title: 'an issue',
    body: '',
    state: 'open',
    labels: [],
    author: 'octocat',
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z',
    url: 'https://example.test/issues/1',
    ...overrides,
  }
}

function selectionTestMr(overrides: Partial<ForgeMr> = {}): ForgeMr {
  return {
    number: 1,
    title: 'an mr',
    author: 'octocat',
    sourceBranch: 'feat/x',
    targetBranch: 'main',
    updatedAt: '2026-08-14T00:00:00.000Z',
    url: 'https://example.test/mr/1',
    state: 'open',
    isDraft: false,
    labels: [],
    additions: null,
    deletions: null,
    changedFiles: null,
    checks: null,
    reviewers: null,
    assignees: null,
    milestone: null,
    mergeable: null,
    commits: null,
    body: null,
    ...overrides,
  }
}

describe('resolveForgeSelection', () => {
  const issue = selectionTestIssue
  const mr = selectionTestMr

  test('no selection: null', () => {
    expect(resolveForgeSelection(null, [issue()], [mr()])).toBeNull()
  })

  test('an issue selection resolves to the matching issue', () => {
    const target = issue({ number: 2, title: 'the one' })
    const result = resolveForgeSelection(
      { kind: 'issue', number: 2 },
      [issue({ number: 1 }), target],
      [],
    )
    expect(result).toEqual({ kind: 'issue', issue: target })
  })

  test('an mr selection resolves to the matching MR', () => {
    const target = mr({ number: 5, title: 'the one' })
    const result = resolveForgeSelection({ kind: 'mr', number: 5 }, [], [mr({ number: 1 }), target])
    expect(result).toEqual({ kind: 'mr', mr: target })
  })

  test('an issue selection against a null (not yet loaded) issue list: null', () => {
    expect(resolveForgeSelection({ kind: 'issue', number: 1 }, null, [])).toBeNull()
  })

  test('a selection whose item fell out of its list resolves to null, not a stale item', () => {
    expect(
      resolveForgeSelection({ kind: 'issue', number: 99 }, [issue({ number: 1 })], []),
    ).toBeNull()
    expect(resolveForgeSelection({ kind: 'mr', number: 99 }, [], [mr({ number: 1 })])).toBeNull()
  })

  test('an issue number never resolves against the MR list, and vice versa', () => {
    const sameNumberIssue = issue({ number: 7 })
    const sameNumberMr = mr({ number: 7 })
    expect(
      resolveForgeSelection({ kind: 'issue', number: 7 }, [sameNumberIssue], [sameNumberMr]),
    ).toEqual({ kind: 'issue', issue: sameNumberIssue })
    expect(
      resolveForgeSelection({ kind: 'mr', number: 7 }, [sameNumberIssue], [sameNumberMr]),
    ).toEqual({
      kind: 'mr',
      mr: sameNumberMr,
    })
  })
})
