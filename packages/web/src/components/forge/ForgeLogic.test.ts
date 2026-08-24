import { describe, expect, test } from 'bun:test'
import {
  forgeFilterByLabels,
  forgeFilterMrsByState,
  forgeLabelCounts,
  forgeSort,
  matchesLabels,
  matchesMrStateFilter,
  sortByTitle,
  sortByUpdated,
  type LabelCount,
} from './ForgeLogic'

type Item = { title: string; updatedAt: string; labels: readonly string[] | null }

function item(title: string, updatedAt: string, labels: readonly string[] | null = []): Item {
  return { title, updatedAt, labels }
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
      { label: 'bug', count: 2 },
      { label: 'ui', count: 2 },
      { label: 'docs', count: 1 },
    ])
  })

  test('null labels contribute nothing, never a fabricated "unknown" bucket', () => {
    const items = [
      item('a', '2026-01-01T00:00:00Z', null),
      item('b', '2026-01-01T00:00:00Z', ['x']),
    ]
    expect(forgeLabelCounts(items)).toEqual([{ label: 'x', count: 1 }])
  })

  test('no items, no labels: an empty list, not an error', () => {
    expect(forgeLabelCounts([])).toEqual([])
  })
})

describe('matchesLabels / forgeFilterByLabels', () => {
  test('an empty selection matches everything, including null labels', () => {
    expect(matchesLabels(null, [])).toBe(true)
    expect(matchesLabels(['a'], [])).toBe(true)
  })

  test('a single selected label matches items carrying it', () => {
    expect(matchesLabels(['bug', 'ui'], ['bug'])).toBe(true)
    expect(matchesLabels(['ui'], ['bug'])).toBe(false)
  })

  test('cumulative selection is AND: every selected label must be present', () => {
    expect(matchesLabels(['bug', 'ui'], ['bug', 'ui'])).toBe(true)
    expect(matchesLabels(['bug'], ['bug', 'ui'])).toBe(false)
  })

  test('null labels never match a non-empty selection', () => {
    expect(matchesLabels(null, ['bug'])).toBe(false)
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

describe('matchesMrStateFilter / forgeFilterMrsByState', () => {
  test('"all" matches every draft state, including unknown', () => {
    expect(matchesMrStateFilter({ isDraft: true }, 'all')).toBe(true)
    expect(matchesMrStateFilter({ isDraft: false }, 'all')).toBe(true)
    expect(matchesMrStateFilter({ isDraft: null }, 'all')).toBe(true)
  })

  test('"draft" matches only an explicit true', () => {
    expect(matchesMrStateFilter({ isDraft: true }, 'draft')).toBe(true)
    expect(matchesMrStateFilter({ isDraft: false }, 'draft')).toBe(false)
    expect(matchesMrStateFilter({ isDraft: null }, 'draft')).toBe(false)
  })

  test('"ready" matches false and unknown, mirroring MrCard\'s own badge reading', () => {
    expect(matchesMrStateFilter({ isDraft: false }, 'ready')).toBe(true)
    expect(matchesMrStateFilter({ isDraft: null }, 'ready')).toBe(true)
    expect(matchesMrStateFilter({ isDraft: true }, 'ready')).toBe(false)
  })

  test('these two filters are exclusive: no MR ever matches both draft and ready', () => {
    for (const isDraft of [true, false, null] as const) {
      const draft = matchesMrStateFilter({ isDraft }, 'draft')
      const ready = matchesMrStateFilter({ isDraft }, 'ready')
      expect(draft && ready).toBe(false)
    }
  })

  test('forgeFilterMrsByState narrows the list accordingly', () => {
    const mrs = [{ isDraft: true }, { isDraft: false }, { isDraft: null }]
    expect(forgeFilterMrsByState(mrs, 'draft')).toEqual([{ isDraft: true }])
    expect(forgeFilterMrsByState(mrs, 'ready')).toEqual([{ isDraft: false }, { isDraft: null }])
    expect(forgeFilterMrsByState(mrs, 'all')).toEqual(mrs)
  })
})
