import { describe, expect, test } from 'bun:test'
import type { ForgeMr, Project, TaskRecord } from '../types'
import {
  buildProjectTree,
  deriveComposerProject,
  deriveSelection,
  filterBySelection,
  nodeHasActiveConversation,
  parsePersistedSelection,
} from './useProjects'
import type { TaskState } from './useTasks'

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

describe('parsePersistedSelection', () => {
  test('a valid JSON string array wins', () => {
    expect(parsePersistedSelection('["aaaa1111","bbbb2222"]', 'cccc3333')).toEqual([
      'aaaa1111',
      'bbbb2222',
    ])
  })

  test('an empty persisted array is kept as-is (deriveSelection handles the fallback)', () => {
    expect(parsePersistedSelection('[]', 'cccc3333')).toEqual([])
  })

  test('the legacy single-project key migrates as a one-element selection', () => {
    expect(parsePersistedSelection(null, 'aaaa1111')).toEqual(['aaaa1111'])
  })

  test('a corrupt multi value falls back to the legacy key', () => {
    expect(parsePersistedSelection('{oops', 'aaaa1111')).toEqual(['aaaa1111'])
    expect(parsePersistedSelection('"not-an-array"', 'aaaa1111')).toEqual(['aaaa1111'])
    expect(parsePersistedSelection('[1,2]', 'aaaa1111')).toEqual(['aaaa1111'])
  })

  test('null when nothing usable was persisted', () => {
    expect(parsePersistedSelection(null, null)).toBeNull()
    expect(parsePersistedSelection('{oops', null)).toBeNull()
    expect(parsePersistedSelection(null, '')).toBeNull()
  })
})

describe('deriveSelection', () => {
  test('the persisted ids intersected with the registry win', () => {
    expect(deriveSelection(['bbbb2222', 'cccc3333'], 'aaaa1111', registry)).toEqual([
      'bbbb2222',
      'cccc3333',
    ])
  })

  test('ids gone from the registry are dropped, not resurrected', () => {
    expect(deriveSelection(['gone0000', 'bbbb2222'], null, registry)).toEqual(['bbbb2222'])
  })

  test('null persisted falls back to the API current', () => {
    expect(deriveSelection(null, 'cccc3333', registry)).toEqual(['cccc3333'])
  })

  test('an empty intersection falls back to the API current', () => {
    expect(deriveSelection(['gone0000'], 'bbbb2222', registry)).toEqual(['bbbb2222'])
  })

  test('an empty persisted array falls back to the API current', () => {
    expect(deriveSelection([], 'bbbb2222', registry)).toEqual(['bbbb2222'])
  })

  test('without a usable current, every registered project is selected', () => {
    expect(deriveSelection(null, null, registry)).toEqual(['aaaa1111', 'bbbb2222', 'cccc3333'])
    expect(deriveSelection([], 'gone0000', registry)).toEqual(['aaaa1111', 'bbbb2222', 'cccc3333'])
  })

  test('empty on an empty registry', () => {
    expect(deriveSelection(['aaaa1111'], 'aaaa1111', [])).toEqual([])
  })
})

describe('deriveComposerProject', () => {
  test('the last used project wins while it is still selected', () => {
    expect(deriveComposerProject('bbbb2222', ['aaaa1111', 'bbbb2222'])).toBe('bbbb2222')
  })

  test('a deselected last-used project falls back to the first selected', () => {
    expect(deriveComposerProject('cccc3333', ['aaaa1111', 'bbbb2222'])).toBe('aaaa1111')
    expect(deriveComposerProject(null, ['bbbb2222'])).toBe('bbbb2222')
  })

  test('null on an empty selection', () => {
    expect(deriveComposerProject('aaaa1111', [])).toBeNull()
  })
})

describe('filterBySelection', () => {
  const items = [
    { projectId: 'aaaa1111', id: 't1' },
    { projectId: 'bbbb2222', id: 't2' },
    { projectId: 'aaaa1111', id: 't3' },
  ]

  test('keeps only the selected projects, order preserved', () => {
    expect(filterBySelection(items, new Set(['aaaa1111'])).map((i) => i.id)).toEqual(['t1', 't3'])
    expect(filterBySelection(items, new Set(['aaaa1111', 'bbbb2222'])).map((i) => i.id)).toEqual([
      't1',
      't2',
      't3',
    ])
  })

  test('an empty selection shows nothing, never a cross-repo mix', () => {
    expect(filterBySelection(items, new Set())).toEqual([])
  })
})

// ── buildProjectTree ───────────────────────────────────────────────────────

function record(partial: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    version: 1,
    title: partial.id,
    status: 'running',
    base: 'main',
    branch: `codesema/task-${partial.id}`,
    worktree: `/wt/${partial.id}`,
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: false,
    created_at: '2026-08-14T09:00:00.000Z',
    updated_at: '2026-08-14T09:00:00.000Z',
    ...partial,
  }
}

function state(partial: Partial<TaskRecord> & { id: string }): TaskState {
  return { projectId: 'aaaa1111', record: record(partial), events: [], liveText: '' }
}

function mr(partial: Partial<ForgeMr> & { number: number }): ForgeMr {
  return {
    title: `MR ${partial.number}`,
    author: 'dev',
    sourceBranch: `feature/${partial.number}`,
    targetBranch: 'main',
    updatedAt: '2026-08-14T08:00:00.000Z',
    url: `https://forge.example/mr/${partial.number}`,
    ...partial,
  }
}

describe('buildProjectTree', () => {
  test('a shipped task attaches under the open MR of its branch, not its base', () => {
    const shipped = state({
      id: 't1',
      status: 'shipped',
      branch: 'codesema/task-t1',
      base: 'main',
    })
    const nodes = buildProjectTree([shipped], [mr({ number: 7, sourceBranch: 'codesema/task-t1' })])
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.kind).toBe('mr')
    expect(nodes[0]?.states.map((s) => s.record.id)).toEqual(['t1'])
  })

  test('technical codesema/task-* branches never appear as nodes', () => {
    const shipped = state({ id: 't1', branch: 'codesema/task-t1', base: 'main' })
    const pending = state({ id: 't2', branch: 'codesema/task-t2', base: 'main' })
    const nodes = buildProjectTree(
      [shipped, pending],
      [mr({ number: 7, sourceBranch: 'codesema/task-t1' })],
    )
    const branchNames = nodes.filter((n) => n.kind === 'branch').map((n) => n.name)
    expect(branchNames).toEqual(['main'])
  })

  test('several tasks on the same base share one branch node, sorted by activity', () => {
    const older = state({ id: 't1', base: 'develop', updated_at: '2026-08-14T09:00:00.000Z' })
    const newer = state({ id: 't2', base: 'develop', updated_at: '2026-08-14T11:00:00.000Z' })
    const nodes = buildProjectTree([older, newer], [])
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.kind).toBe('branch')
    expect(nodes[0]?.states.map((s) => s.record.id)).toEqual(['t2', 't1'])
  })

  test('a base unknown to the MR list still gets its own branch node', () => {
    const s = state({ id: 't1', base: 'feature/spike' })
    const nodes = buildProjectTree([s], [mr({ number: 3, sourceBranch: 'feature/other' })])
    const branch = nodes.find((n) => n.kind === 'branch')
    expect(branch?.kind === 'branch' && branch.name).toBe('feature/spike')
    expect(branch?.states.map((st) => st.record.id)).toEqual(['t1'])
  })

  test('unavailable MRs (empty list) degrade to branch nodes only', () => {
    const a = state({ id: 't1', base: 'main', updated_at: '2026-08-14T11:00:00.000Z' })
    const b = state({ id: 't2', base: 'develop', updated_at: '2026-08-14T09:00:00.000Z' })
    const nodes = buildProjectTree([a, b], [])
    expect(nodes.every((n) => n.kind === 'branch')).toBe(true)
    expect(nodes.map((n) => (n.kind === 'branch' ? n.name : ''))).toEqual(['main', 'develop'])
  })

  test('equal-activity nodes keep a deterministic label order', () => {
    const a = state({ id: 't1', base: 'main' })
    const b = state({ id: 't2', base: 'develop' })
    const nodes = buildProjectTree([a, b], [])
    expect(nodes.map((n) => (n.kind === 'branch' ? n.name : ''))).toEqual(['develop', 'main'])
  })

  test('open MRs without conversations still appear as nodes', () => {
    const nodes = buildProjectTree([], [mr({ number: 4 })])
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.kind).toBe('mr')
    expect(nodes[0]?.states).toEqual([])
  })

  test('nodes sort by their most recent conversation activity', () => {
    const onMain = state({ id: 't1', base: 'main', updated_at: '2026-08-14T09:00:00.000Z' })
    const shipped = state({
      id: 't2',
      branch: 'codesema/task-t2',
      base: 'main',
      updated_at: '2026-08-14T12:00:00.000Z',
    })
    const onDev = state({ id: 't3', base: 'develop', updated_at: '2026-08-14T10:00:00.000Z' })
    const nodes = buildProjectTree(
      [onMain, shipped, onDev],
      [mr({ number: 9, sourceBranch: 'codesema/task-t2', updatedAt: '2026-08-13T00:00:00.000Z' })],
    )
    expect(nodes.map((n) => (n.kind === 'mr' ? `!${n.mr.number}` : n.name))).toEqual([
      '!9',
      'develop',
      'main',
    ])
  })

  test('an MR without conversations sorts by its own update time', () => {
    const recent = state({ id: 't1', base: 'main', updated_at: '2026-08-14T10:00:00.000Z' })
    const nodes = buildProjectTree(
      [recent],
      [
        mr({ number: 1, sourceBranch: 'feature/idle', updatedAt: '2026-08-14T11:00:00.000Z' }),
        mr({ number: 2, sourceBranch: 'feature/old', updatedAt: '2026-08-01T00:00:00.000Z' }),
      ],
    )
    expect(nodes.map((n) => (n.kind === 'mr' ? `!${n.mr.number}` : n.name))).toEqual([
      '!1',
      'main',
      '!2',
    ])
  })

  test('does not mutate its inputs', () => {
    const states = [
      state({ id: 't2', base: 'main', updated_at: '2026-08-14T11:00:00.000Z' }),
      state({ id: 't1', base: 'main', updated_at: '2026-08-14T09:00:00.000Z' }),
    ]
    const mrs = [mr({ number: 1 })]
    buildProjectTree(states, mrs)
    expect(states.map((s) => s.record.id)).toEqual(['t2', 't1'])
    expect(mrs).toHaveLength(1)
  })
})

describe('nodeHasActiveConversation', () => {
  test('true when a conversation is running or waiting', () => {
    const node = buildProjectTree([state({ id: 't1', status: 'waiting_for_you' })], [])[0]!
    expect(nodeHasActiveConversation(node)).toBe(true)
  })

  test('false when every conversation is done, or the node is empty', () => {
    const done = buildProjectTree([state({ id: 't1', status: 'shipped' })], [])[0]!
    expect(nodeHasActiveConversation(done)).toBe(false)
    const empty = buildProjectTree([], [mr({ number: 1 })])[0]!
    expect(nodeHasActiveConversation(empty)).toBe(false)
  })
})
