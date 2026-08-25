import { describe, expect, test } from 'bun:test'
import type { ForgeMr, GitWorktree, LocalBranch, TaskRecord, TaskStatus } from '../types'
import { buildBranchRows, buildRepositoryTiles, type BuildBranchRowsInput } from './useRepository'
import type { TaskState } from './useTasks'

const REPO = 'repo-aaaa'
const OTHER_REPO = 'repo-bbbb'

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

function state(projectId: string, partial: Partial<TaskRecord> & { id: string }): TaskState {
  return {
    projectId,
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
    state: 'open',
    isDraft: null,
    labels: null,
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
    ...partial,
  }
}

function branch(partial: Partial<LocalBranch> & { name: string }): LocalBranch {
  return {
    lastCommitRelative: '2 hours ago',
    subject: `work on ${partial.name}`,
    isCurrent: false,
    worktreePath: null,
    ...partial,
  }
}

function worktree(partial: Partial<GitWorktree> & { path: string }): GitWorktree {
  return {
    branch: null,
    ...partial,
  }
}

function input(partial: Partial<BuildBranchRowsInput>): BuildBranchRowsInput {
  return {
    repoProjectId: REPO,
    branches: [],
    worktrees: [],
    mrs: [],
    states: [],
    ...partial,
  }
}

function branchNames(rows: ReturnType<typeof buildBranchRows>): (string | null)[] {
  return rows.map((row) => (row.kind === 'branch' ? row.name : null))
}

// ── buildBranchRows: row construction ───────────────────────────────────────

describe('buildBranchRows: row construction', () => {
  test('codesema/task-* branches never get their own row', () => {
    const rows = buildBranchRows(
      input({ branches: [branch({ name: 'codesema/task-abc' }), branch({ name: 'main' })] }),
    )
    expect(branchNames(rows)).toEqual(['main'])
  })

  test('a branch without a checked-out worktree has a null worktreePath', () => {
    const rows = buildBranchRows(input({ branches: [branch({ name: 'feature-x' })] }))
    const row = rows[0]
    expect(row?.kind === 'branch' && row.worktreePath).toBeNull()
  })

  test('a branch with no attached conversation has an empty conversations list', () => {
    const rows = buildBranchRows(input({ branches: [branch({ name: 'feature-x' })] }))
    const row = rows[0]
    expect(row?.kind === 'branch' && row.conversations).toEqual([])
  })

  test('a worktree checked out on a branch does not create a separate row', () => {
    const rows = buildBranchRows(
      input({
        branches: [branch({ name: 'feature-x', worktreePath: '/wt/feature-x' })],
        worktrees: [worktree({ path: '/wt/feature-x', branch: 'feature-x' })],
      }),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('branch')
  })

  test('a detached worktree gets a row with no branch, no conversations and no action', () => {
    const rows = buildBranchRows(input({ worktrees: [worktree({ path: '/wt/detached-1' })] }))
    expect(rows).toEqual([{ kind: 'detached-worktree', worktreePath: '/wt/detached-1' }])
  })

  test('does not mutate its inputs', () => {
    const branches = [branch({ name: 'zeta' }), branch({ name: 'alpha' })]
    const states = [state(REPO, { id: 't1', branch: 'alpha', status: 'running' })]
    buildBranchRows(input({ branches, states }))
    expect(branches.map((b) => b.name)).toEqual(['zeta', 'alpha'])
    expect(states.map((s) => s.record.id)).toEqual(['t1'])
  })
})

// ── buildBranchRows: the open MR field ──────────────────────────────────────

describe('buildBranchRows: open MR', () => {
  test('the row carries the open MR whose source branch matches', () => {
    const openMr = mr({ number: 5, sourceBranch: 'feature-x' })
    const rows = buildBranchRows(
      input({ branches: [branch({ name: 'feature-x' })], mrs: [openMr] }),
    )
    const row = rows[0]
    expect(row?.kind === 'branch' && row.openMr).toEqual(openMr)
  })

  test('origin/x and x are the same branch for the open MR match', () => {
    const rows = buildBranchRows(
      input({
        branches: [branch({ name: 'feature-x' })],
        mrs: [mr({ number: 1, sourceBranch: 'origin/feature-x' })],
      }),
    )
    const row = rows[0]
    expect(row?.kind === 'branch' && row.openMr?.number).toBe(1)
  })

  test('a closed or merged MR never counts as the row open MR', () => {
    const rows = buildBranchRows(
      input({
        branches: [branch({ name: 'feature-x' })],
        mrs: [
          mr({ number: 5, sourceBranch: 'feature-x', state: 'closed' }),
          mr({ number: 6, sourceBranch: 'feature-x', state: 'merged' }),
        ],
      }),
    )
    const row = rows[0]
    expect(row?.kind === 'branch' && row.openMr).toBeNull()
  })
})

// ── buildBranchRows: the row action ─────────────────────────────────────────

describe('buildBranchRows: action', () => {
  test('opens an active conversation on the exact branch', () => {
    const active = state(REPO, { id: 't1', branch: 'feature-x', status: 'running' })
    const rows = buildBranchRows(
      input({ branches: [branch({ name: 'feature-x' })], states: [active] }),
    )
    const row = rows[0]
    expect(row?.kind === 'branch' && row.action).toEqual({ kind: 'open', taskId: 't1' })
  })

  test('drafts a work-on when nothing active claims the branch', () => {
    const rows = buildBranchRows(input({ branches: [branch({ name: 'feature-x' })] }))
    const row = rows[0]
    expect(row?.kind === 'branch' && row.action).toEqual({
      kind: 'draft-workon',
      branch: 'feature-x',
      target: null,
    })
  })
})

// ── buildBranchRows: conversation attachment ────────────────────────────────

describe('buildBranchRows: conversation attachment', () => {
  test('a conversation attaches by its own branch, not its base', () => {
    const s = state(REPO, { id: 't1', branch: 'feature-x', base: 'develop', status: 'running' })
    const rows = buildBranchRows(
      input({
        branches: [branch({ name: 'feature-x' }), branch({ name: 'develop' })],
        states: [s],
      }),
    )
    const feature = rows.find((r) => r.kind === 'branch' && r.name === 'feature-x')
    const develop = rows.find((r) => r.kind === 'branch' && r.name === 'develop')
    expect(feature?.kind === 'branch' && feature.conversations.map((c) => c.record.id)).toEqual([
      't1',
    ])
    expect(develop?.kind === 'branch' && develop.conversations).toEqual([])
  })

  test('a fork-mode conversation (technical branch, no row) falls back to its base', () => {
    const s = state(REPO, {
      id: 't1',
      branch: 'codesema/task-t1',
      base: 'develop',
      status: 'running',
    })
    const rows = buildBranchRows(input({ branches: [branch({ name: 'develop' })], states: [s] }))
    const row = rows[0]
    expect(row?.kind === 'branch' && row.conversations.map((c) => c.record.id)).toEqual(['t1'])
  })

  test('an open MR on the conversation branch excludes it from its base row', () => {
    const s = state(REPO, {
      id: 't1',
      branch: 'codesema/task-t1',
      base: 'develop',
      status: 'running',
    })
    const rows = buildBranchRows(
      input({
        branches: [branch({ name: 'develop' })],
        mrs: [mr({ number: 1, sourceBranch: 'codesema/task-t1' })],
        states: [s],
      }),
    )
    const row = rows[0]
    expect(row?.kind === 'branch' && row.conversations).toEqual([])
  })

  test('a merged/closed MR does not block the base fallback', () => {
    const s = state(REPO, {
      id: 't1',
      branch: 'codesema/task-t1',
      base: 'develop',
      status: 'running',
    })
    const rows = buildBranchRows(
      input({
        branches: [branch({ name: 'develop' })],
        mrs: [mr({ number: 1, sourceBranch: 'codesema/task-t1', state: 'merged' })],
        states: [s],
      }),
    )
    const row = rows[0]
    expect(row?.kind === 'branch' && row.conversations.map((c) => c.record.id)).toEqual(['t1'])
  })

  test('origin/x and x are the same branch for conversation attachment', () => {
    const s = state(REPO, {
      id: 't1',
      branch: 'origin/feature-x',
      base: 'develop',
      status: 'running',
    })
    const rows = buildBranchRows(input({ branches: [branch({ name: 'feature-x' })], states: [s] }))
    const row = rows[0]
    expect(row?.kind === 'branch' && row.conversations.map((c) => c.record.id)).toEqual(['t1'])
  })

  test('branch names attach with exact case', () => {
    const s = state(REPO, { id: 't1', branch: 'Feature-X', status: 'running' })
    const rows = buildBranchRows(input({ branches: [branch({ name: 'feature-x' })], states: [s] }))
    const row = rows[0]
    expect(row?.kind === 'branch' && row.conversations).toEqual([])
  })

  test('a conversation from another project attaches through its recorded attachment', () => {
    const s = state(OTHER_REPO, {
      id: 't1',
      branch: 'own-branch',
      base: 'own-base',
      status: 'running',
      attachments: [
        {
          project_id: REPO,
          repo: '/repos/aaaa',
          name: 'aaaa',
          worktree: '/wt/t1/aaaa',
          branch: 'feature-x',
          base: 'develop',
        },
      ],
    })
    const rows = buildBranchRows(input({ branches: [branch({ name: 'feature-x' })], states: [s] }))
    const row = rows[0]
    expect(row?.kind === 'branch' && row.conversations.map((c) => c.record.id)).toEqual(['t1'])
  })

  test('a foreign conversation never attaches by its own branch/base fields', () => {
    const s = state(OTHER_REPO, { id: 't1', branch: 'develop', base: 'develop', status: 'running' })
    const rows = buildBranchRows(input({ branches: [branch({ name: 'develop' })], states: [s] }))
    const row = rows[0]
    expect(row?.kind === 'branch' && row.conversations).toEqual([])
  })

  test('only the attachment matching this repo counts, among several', () => {
    const s = state(OTHER_REPO, {
      id: 't1',
      branch: 'own',
      base: 'own-base',
      status: 'running',
      attachments: [
        {
          project_id: 'repo-cccc',
          repo: '/r',
          name: 'r',
          worktree: '/wt',
          branch: 'feature-x',
          base: 'develop',
        },
        {
          project_id: REPO,
          repo: '/r2',
          name: 'r2',
          worktree: '/wt2',
          branch: 'other-branch',
          base: 'develop',
        },
      ],
    })
    const rows = buildBranchRows(
      input({
        branches: [branch({ name: 'feature-x' }), branch({ name: 'other-branch' })],
        states: [s],
      }),
    )
    const feature = rows.find((r) => r.kind === 'branch' && r.name === 'feature-x')
    const other = rows.find((r) => r.kind === 'branch' && r.name === 'other-branch')
    expect(feature?.kind === 'branch' && feature.conversations).toEqual([])
    expect(other?.kind === 'branch' && other.conversations.map((c) => c.record.id)).toEqual(['t1'])
  })
})

// ── buildBranchRows: sort tiers ──────────────────────────────────────────────

describe('buildBranchRows: sort tiers', () => {
  test('tier 1: a non-terminal conversation holds the branch, sorted by most recent activity', () => {
    const older = state(REPO, {
      id: 't1',
      branch: 'feature-old',
      status: 'running',
      updated_at: '2026-08-14T09:00:00.000Z',
    })
    const newer = state(REPO, {
      id: 't2',
      branch: 'feature-new',
      status: 'waiting_for_you',
      updated_at: '2026-08-14T12:00:00.000Z',
    })
    const rows = buildBranchRows(
      input({
        branches: [
          branch({ name: 'feature-old' }),
          branch({ name: 'feature-new' }),
          branch({ name: 'main' }),
        ],
        states: [older, newer],
      }),
    )
    expect(branchNames(rows)).toEqual(['feature-new', 'feature-old', 'main'])
  })

  test('review_ok still holds the branch (tier 1), unlike the rail grammar', () => {
    const reviewOk = state(REPO, { id: 't1', branch: 'feature-x', status: 'review_ok' })
    const rows = buildBranchRows(
      input({
        branches: [branch({ name: 'other' }), branch({ name: 'feature-x' })],
        states: [reviewOk],
      }),
    )
    expect(branchNames(rows)).toEqual(['feature-x', 'other'])
  })

  test('shipped and failed never hold the branch', () => {
    for (const status of ['shipped', 'failed'] as TaskStatus[]) {
      const done = state(REPO, { id: 't1', branch: 'feature-x', status })
      const rows = buildBranchRows(
        input({
          branches: [branch({ name: 'other' }), branch({ name: 'feature-x' })],
          states: [done],
        }),
      )
      expect(branchNames(rows)).toEqual(['other', 'feature-x'])
    }
  })

  test('tier 2: an open MR or the current checkout, without an active conversation', () => {
    const rows = buildBranchRows(
      input({
        branches: [
          branch({ name: 'idle' }),
          branch({ name: 'shipped-mr' }),
          branch({ name: 'current', isCurrent: true }),
        ],
        mrs: [mr({ number: 1, sourceBranch: 'shipped-mr' })],
      }),
    )
    expect(branchNames(rows)).toEqual(['shipped-mr', 'current', 'idle'])
  })

  test('tier 1 outranks tier 2', () => {
    const active = state(REPO, {
      id: 't1',
      branch: 'has-both',
      status: 'running',
      updated_at: '2026-08-14T09:00:00.000Z',
    })
    const rows = buildBranchRows(
      input({
        branches: [branch({ name: 'mr-only' }), branch({ name: 'has-both' })],
        mrs: [
          mr({ number: 1, sourceBranch: 'has-both' }),
          mr({ number: 2, sourceBranch: 'mr-only' }),
        ],
        states: [active],
      }),
    )
    expect(branchNames(rows)).toEqual(['has-both', 'mr-only'])
  })

  test('tier 3: the rest keeps the server order untouched (stability)', () => {
    const rows = buildBranchRows(
      input({
        branches: [branch({ name: 'zeta' }), branch({ name: 'alpha' }), branch({ name: 'mu' })],
      }),
    )
    expect(branchNames(rows)).toEqual(['zeta', 'alpha', 'mu'])
  })

  test('tier 4: detached worktrees always sort last, after every branch tier', () => {
    const active = state(REPO, { id: 't1', branch: 'feature-x', status: 'running' })
    const rows = buildBranchRows(
      input({
        branches: [branch({ name: 'idle' }), branch({ name: 'feature-x' })],
        worktrees: [worktree({ path: '/wt/detached' })],
        states: [active],
      }),
    )
    expect(rows.map((r) => r.kind)).toEqual(['branch', 'branch', 'detached-worktree'])
  })
})

// ── buildRepositoryTiles ─────────────────────────────────────────────────────

describe('buildRepositoryTiles', () => {
  test('empty input yields all-zero counters', () => {
    expect(buildRepositoryTiles([], [], REPO)).toEqual({
      branchCount: 0,
      worktreeCount: 0,
      activeConversationCount: 0,
      waitingOnYouCount: 0,
    })
  })

  test('counts branches, worktrees, active and waiting-on-you conversations', () => {
    const rows = buildBranchRows(
      input({
        branches: [
          branch({ name: 'main' }),
          branch({ name: 'feature-x', worktreePath: '/wt/feature-x' }),
        ],
        worktrees: [
          worktree({ path: '/wt/feature-x', branch: 'feature-x' }),
          worktree({ path: '/wt/detached' }),
        ],
      }),
    )
    const states = [
      state(REPO, { id: 't1', status: 'running' }),
      state(REPO, { id: 't2', status: 'waiting_for_you' }),
      state(REPO, { id: 't3', status: 'review_ko' }),
      state(REPO, { id: 't4', status: 'interrupted' }),
      state(REPO, { id: 't5', status: 'shipped' }),
      state(OTHER_REPO, {
        id: 't6',
        status: 'running',
        attachments: [
          {
            project_id: REPO,
            repo: '/r',
            name: 'r',
            worktree: '/wt/t6',
            branch: 'feature-x',
            base: 'main',
          },
        ],
      }),
      state(OTHER_REPO, { id: 't7', status: 'running' }),
    ]
    expect(buildRepositoryTiles(rows, states, REPO)).toEqual({
      branchCount: 2,
      worktreeCount: 2,
      activeConversationCount: 5,
      waitingOnYouCount: 3,
    })
  })
})
