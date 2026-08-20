import { describe, expect, test } from 'bun:test'
import type { ForgeMr, LocalBranch, Project, TaskRecord, TaskStatus } from '../types'
import {
  buildProjectTree,
  countProjectActivity,
  deriveActiveProject,
  isolationForProject,
  isTrunkBranch,
  migrateActiveProject,
  nameColor,
  nodeHasActiveConversation,
  otherBranches,
  resolveBranchClick,
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

describe('migrateActiveProject', () => {
  test('the persisted card wins over the retired composer key', () => {
    expect(migrateActiveProject('aaaa1111', 'bbbb2222')).toBe('aaaa1111')
  })

  test('the retired composer target seeds the first active card', () => {
    expect(migrateActiveProject(null, 'bbbb2222')).toBe('bbbb2222')
  })

  test('null when nothing usable was persisted', () => {
    expect(migrateActiveProject(null, null)).toBeNull()
  })
})

describe('isolationForProject', () => {
  test('prefers the project overlay, falls back to the process-wide blob', () => {
    const overlay = {
      isolation_available: true,
      isolation_default: 'container' as const,
      isolation_reason: 'podman is available',
      isolation_configured: 'auto' as const,
    }
    const fallback = {
      isolation_available: false,
      isolation_default: 'policy' as const,
      isolation_reason: 'isolation is set to policy',
      isolation_configured: 'policy' as const,
    }
    const withOverlay = project({ id: 'aaaa1111', isolation: overlay })
    expect(isolationForProject('aaaa1111', [withOverlay], fallback)).toEqual(overlay)
    expect(isolationForProject('bbbb2222', [withOverlay], fallback)).toEqual(fallback)
    expect(isolationForProject(null, [withOverlay], fallback)).toEqual(fallback)
  })
})

describe('deriveActiveProject', () => {
  test('the persisted id wins while the registry knows it', () => {
    expect(deriveActiveProject('bbbb2222', 'aaaa1111', registry)).toBe('bbbb2222')
  })

  test('an id gone from the registry falls back to the API current', () => {
    expect(deriveActiveProject('gone0000', 'cccc3333', registry)).toBe('cccc3333')
  })

  test('null persisted falls back to the API current', () => {
    expect(deriveActiveProject(null, 'cccc3333', registry)).toBe('cccc3333')
  })

  test('without a usable current, the first registered project is active', () => {
    expect(deriveActiveProject(null, null, registry)).toBe('aaaa1111')
    expect(deriveActiveProject('gone0000', 'gone1111', registry)).toBe('aaaa1111')
  })

  test('null on an empty registry', () => {
    expect(deriveActiveProject('aaaa1111', 'aaaa1111', [])).toBeNull()
  })
})

const at = (projectId: string, status: TaskStatus) => ({ projectId, record: { status } })

describe('countProjectActivity', () => {
  test('counts waiting and active conversations per project', () => {
    const counts = countProjectActivity([
      at('aaaa1111', 'waiting_for_you'),
      at('aaaa1111', 'review_ko'),
      at('aaaa1111', 'running'),
      at('bbbb2222', 'queued'),
      at('bbbb2222', 'reviewing'),
    ])
    expect(counts.get('aaaa1111')).toEqual({ waiting: 2, active: 1 })
    expect(counts.get('bbbb2222')).toEqual({ waiting: 0, active: 2 })
  })

  test('done conversations count for nothing', () => {
    const counts = countProjectActivity([
      at('aaaa1111', 'shipped'),
      at('aaaa1111', 'failed'),
      at('aaaa1111', 'review_ok'),
    ])
    expect(counts.get('aaaa1111')).toBeUndefined()
  })

  // T8: a conversation stopped mid-turn is work left to do, not history —
  // the project card must say the repo still wants the human.
  test('an interrupted conversation counts as waiting', () => {
    const counts = countProjectActivity([at('aaaa1111', 'interrupted')])
    expect(counts.get('aaaa1111')).toEqual({ waiting: 1, active: 0 })
  })

  test('empty input yields an empty map', () => {
    expect(countProjectActivity([]).size).toBe(0)
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
  return {
    projectId: 'aaaa1111',
    record: record(partial),
    events: [],
    liveText: '',
    liveMessages: [],
    liveTokens: 0,
    liveLoadCap: null,
    checks: null,
  }
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

// ── otherBranches ──────────────────────────────────────────────────────────

function localBranch(name: string): LocalBranch {
  return {
    name,
    lastCommitRelative: '2 hours ago',
    subject: `work on ${name}`,
    isCurrent: false,
    worktreePath: null,
  }
}

describe('otherBranches', () => {
  test('keeps the API order and returns names only', () => {
    expect(otherBranches([localBranch('develop'), localBranch('main')], [], [])).toEqual([
      'develop',
      'main',
    ])
  })

  test('excludes branches that are already tree nodes', () => {
    const tree = buildProjectTree([state({ id: 't1', base: 'main' })], [])
    expect(otherBranches([localBranch('main'), localBranch('develop')], tree, [])).toEqual([
      'develop',
    ])
  })

  test('excludes the source branches of the displayed MRs', () => {
    const mrs = [mr({ number: 1, sourceBranch: 'feature/x' })]
    const tree = buildProjectTree([], mrs)
    expect(otherBranches([localBranch('feature/x'), localBranch('develop')], tree, mrs)).toEqual([
      'develop',
    ])
  })

  test('excludes MR sources even when the MR list and the tree disagree', () => {
    // An MR fetched after the tree was built: its source must not be offered.
    const mrs = [mr({ number: 2, sourceBranch: 'feature/late' })]
    expect(otherBranches([localBranch('feature/late'), localBranch('main')], [], mrs)).toEqual([
      'main',
    ])
  })

  test('excludes the technical codesema/task-* branches', () => {
    expect(otherBranches([localBranch('codesema/task-t1'), localBranch('main')], [], [])).toEqual([
      'main',
    ])
  })

  test('empty input yields an empty list', () => {
    expect(otherBranches([], [], [])).toEqual([])
  })
})

// ── resolveBranchClick (amendment 4: the conversation IS its branch) ───────

describe('resolveBranchClick', () => {
  const workon = (id: string, branch: string, status: TaskStatus) =>
    state({ id, branch, base: 'main', status })

  test('an ACTIVE conversation on the exact branch opens it', () => {
    const states = [workon('t1', 'feature/x', 'running')]
    expect(resolveBranchClick('feature/x', null, states)).toEqual({ kind: 'open', taskId: 't1' })
  })

  test('every non-terminal status owns its branch', () => {
    const active: TaskStatus[] = [
      'queued',
      'running',
      'waiting_for_you',
      'reviewing',
      'review_ok',
      'review_ko',
      'interrupted',
    ]
    for (const status of active) {
      expect(resolveBranchClick('feature/x', null, [workon('t1', 'feature/x', status)])).toEqual({
        kind: 'open',
        taskId: 't1',
      })
    }
  })

  test('terminal conversations (shipped/failed) never block: draft instead', () => {
    for (const status of ['shipped', 'failed'] as TaskStatus[]) {
      expect(resolveBranchClick('feature/x', null, [workon('t1', 'feature/x', status)])).toEqual({
        kind: 'draft-workon',
        branch: 'feature/x',
        target: null,
      })
    }
  })

  test('an active conversation wins even over a trunk name', () => {
    // Defensive: rule 1 of the frozen contract comes before the trunk rule.
    const states = [workon('t1', 'main', 'running')]
    expect(resolveBranchClick('main', null, states)).toEqual({ kind: 'open', taskId: 't1' })
  })

  test('a trunk without an active conversation drafts a work-on too: the MODE is the human choice', () => {
    // Amendment: no branch-name routing. A plain click always means "work on
    // it"; the draft column carries the switch to fork-from plus a trunk
    // warning (see WorkspaceView).
    for (const trunk of ['main', 'master', 'develop']) {
      expect(resolveBranchClick(trunk, null, [])).toEqual({
        kind: 'draft-workon',
        branch: trunk,
        target: null,
      })
    }
  })

  test('terminal conversations never capture the click (trunk or not)', () => {
    const states = [workon('t1', 'main', 'shipped')]
    expect(resolveBranchClick('main', mr({ number: 1, targetBranch: 'prod' }), states)).toEqual({
      kind: 'draft-workon',
      branch: 'main',
      target: 'prod',
    })
  })

  test('a non-trunk branch without conversation drafts a work-on', () => {
    expect(resolveBranchClick('feature/x', null, [])).toEqual({
      kind: 'draft-workon',
      branch: 'feature/x',
      target: null,
    })
  })

  test('an MR click carries its target branch into the work-on draft', () => {
    const clicked = mr({ number: 8, sourceBranch: 'feature/x', targetBranch: 'develop' })
    expect(resolveBranchClick('feature/x', clicked, [])).toEqual({
      kind: 'draft-workon',
      branch: 'feature/x',
      target: 'develop',
    })
  })

  test('an MR whose source branch has an ACTIVE conversation opens it', () => {
    const clicked = mr({ number: 8, sourceBranch: 'feature/x', targetBranch: 'develop' })
    const states = [workon('t1', 'feature/x', 'waiting_for_you')]
    expect(resolveBranchClick('feature/x', clicked, states)).toEqual({
      kind: 'open',
      taskId: 't1',
    })
  })

  test('branch names match with their exact case, trunks included', () => {
    // 'Main' is not a trunk, and a conversation on 'Feature/X' never answers
    // for 'feature/x'.
    expect(resolveBranchClick('Main', null, [])).toEqual({
      kind: 'draft-workon',
      branch: 'Main',
      target: null,
    })
    const states = [workon('t1', 'Feature/X', 'running')]
    expect(resolveBranchClick('feature/x', null, states)).toEqual({
      kind: 'draft-workon',
      branch: 'feature/x',
      target: null,
    })
  })

  test('conversations on other branches never interfere', () => {
    const states = [workon('t1', 'feature/other', 'running'), workon('t2', 'feature/x', 'failed')]
    expect(resolveBranchClick('feature/x', null, states)).toEqual({
      kind: 'draft-workon',
      branch: 'feature/x',
      target: null,
    })
  })
})

describe('isTrunkBranch', () => {
  test('exactly main, master and develop, case-sensitive', () => {
    expect(isTrunkBranch('main')).toBe(true)
    expect(isTrunkBranch('master')).toBe(true)
    expect(isTrunkBranch('develop')).toBe(true)
    expect(isTrunkBranch('Main')).toBe(false)
    expect(isTrunkBranch('feature/main')).toBe(false)
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

describe('nameColor', () => {
  test('deterministic: the same name always yields the same hue', () => {
    expect(nameColor('nolyra')).toBe(nameColor('nolyra'))
    expect(nameColor('codesema-cli')).toBe(nameColor('codesema-cli'))
  })

  test('hue stays in [0, 360)', () => {
    for (const name of ['nolyra', 'codesema-cli', 'solstice-rush', 'a', '', 'émoji-ç']) {
      const hue = nameColor(name)
      expect(hue).toBeGreaterThanOrEqual(0)
      expect(hue).toBeLessThan(360)
      expect(Number.isInteger(hue)).toBe(true)
    }
  })

  test('close names spread apart on the wheel', () => {
    expect(nameColor('project-a')).not.toBe(nameColor('project-b'))
  })
})
