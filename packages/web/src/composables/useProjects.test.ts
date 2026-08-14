import { describe, expect, test } from 'bun:test'
import type { Project } from '../types'
import { deriveCurrentProject, filterByProject, sortRecents } from './useProjects'

function project(partial: Partial<Project> & { id: string }): Project {
  return {
    path: `/repos/${partial.id}`,
    name: partial.id,
    added_at: '2026-08-14T10:00:00.000Z',
    ...partial,
  }
}

const registry = [
  project({ id: 'aaaa1111' }),
  project({ id: 'bbbb2222' }),
  project({ id: 'cccc3333' }),
]

describe('deriveCurrentProject', () => {
  test('the persisted choice wins over the API current', () => {
    expect(deriveCurrentProject('bbbb2222', 'aaaa1111', registry)).toBe('bbbb2222')
  })

  test('falls back to the API current when nothing is persisted', () => {
    expect(deriveCurrentProject(null, 'cccc3333', registry)).toBe('cccc3333')
  })

  test('falls back to the first project when neither is usable', () => {
    expect(deriveCurrentProject(null, null, registry)).toBe('aaaa1111')
  })

  test('a persisted id gone from the registry is ignored, not resurrected', () => {
    expect(deriveCurrentProject('gone0000', 'bbbb2222', registry)).toBe('bbbb2222')
    expect(deriveCurrentProject('gone0000', null, registry)).toBe('aaaa1111')
  })

  test('an unknown API current falls through to the first project', () => {
    expect(deriveCurrentProject(null, 'gone0000', registry)).toBe('aaaa1111')
  })

  test('null on an empty registry', () => {
    expect(deriveCurrentProject('aaaa1111', 'aaaa1111', [])).toBeNull()
  })
})

describe('filterByProject', () => {
  const items = [
    { projectId: 'aaaa1111', id: 't1' },
    { projectId: 'bbbb2222', id: 't2' },
    { projectId: 'aaaa1111', id: 't3' },
  ]

  test('keeps only the current project, order preserved', () => {
    expect(filterByProject(items, 'aaaa1111').map((i) => i.id)).toEqual(['t1', 't3'])
  })

  test('unknown project matches nothing', () => {
    expect(filterByProject(items, 'gone0000')).toEqual([])
  })

  test('null project (empty registry) shows nothing, never a cross-repo mix', () => {
    expect(filterByProject(items, null)).toEqual([])
  })
})

const item = (id: string, updated_at: string) => ({ record: { id, updated_at } })

describe('sortRecents', () => {
  test('most recently touched first', () => {
    const sorted = sortRecents([
      item('aaaa', '2026-08-14T09:00:00.000Z'),
      item('bbbb', '2026-08-14T11:00:00.000Z'),
      item('cccc', '2026-08-14T10:00:00.000Z'),
    ])
    expect(sorted.map((i) => i.record.id)).toEqual(['bbbb', 'cccc', 'aaaa'])
  })

  test('caps the list at the limit', () => {
    const items = [
      item('aaaa', '2026-08-14T09:00:00.000Z'),
      item('bbbb', '2026-08-14T11:00:00.000Z'),
      item('cccc', '2026-08-14T10:00:00.000Z'),
    ]
    expect(sortRecents(items, 2).map((i) => i.record.id)).toEqual(['bbbb', 'cccc'])
    expect(sortRecents(items, 0)).toEqual([])
  })

  test('id breaks timestamp ties so the order is stable', () => {
    const sorted = sortRecents([
      item('bbbb', '2026-08-14T10:00:00.000Z'),
      item('aaaa', '2026-08-14T10:00:00.000Z'),
    ])
    expect(sorted.map((i) => i.record.id)).toEqual(['aaaa', 'bbbb'])
  })

  test('does not mutate its input', () => {
    const items = [
      item('bbbb', '2026-08-14T11:00:00.000Z'),
      item('aaaa', '2026-08-14T09:00:00.000Z'),
    ]
    sortRecents(items)
    expect(items.map((i) => i.record.id)).toEqual(['bbbb', 'aaaa'])
  })
})
