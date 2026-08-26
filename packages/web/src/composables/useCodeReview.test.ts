import { describe, expect, test } from 'bun:test'
import type {
  ForgeMr,
  LocalBranch,
  MrReviewStatus,
  Project,
  ReviewArchiveSummary,
  ReviewSource,
} from '../types'
import {
  buildCodeReviewRows,
  codeReviewRowKey,
  filterCodeReviewRows,
  isCodeReviewRowRunning,
  type BuildCodeReviewRowsInput,
  type CodeReviewProjectInput,
  type CodeReviewRow,
} from './useCodeReview'

function project(partial: Partial<Project> & { id: string }): Project {
  return {
    path: `/repos/${partial.id}`,
    name: partial.id,
    kind: 'repo',
    added_at: '2026-08-14T08:00:00.000Z',
    ...partial,
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

function archive(
  partial: Partial<ReviewArchiveSummary> & { branch: string },
): ReviewArchiveSummary {
  return {
    ref: `ref-${partial.branch}`,
    target: 'main',
    created_at: '2026-08-14T09:00:00.000Z',
    verdict: 'approve',
    mode: 'simple',
    findings_total: 0,
    ...partial,
  }
}

function runningStatus(projectId: string | null, source: ReviewSource): MrReviewStatus {
  return {
    available: true,
    phase: 'running',
    project_id: projectId,
    source,
    mode: 'simple',
    started_at: '2026-08-14T09:00:00.000Z',
  }
}

function projectInput(
  partial: Partial<CodeReviewProjectInput> & { project: Project },
): CodeReviewProjectInput {
  return {
    mrs: [],
    branches: [],
    archives: [],
    ...partial,
  }
}

function input(partial: Partial<BuildCodeReviewRowsInput> = {}): BuildCodeReviewRowsInput {
  return {
    projects: [],
    ...partial,
  }
}

function rowLabel(row: CodeReviewRow): string {
  return row.kind === 'mr' ? `mr:${row.mr.number}` : `branch:${row.branch.name}`
}

function rowLabels(rows: readonly CodeReviewRow[]): string[] {
  return rows.map(rowLabel)
}

function firstRow(rows: readonly CodeReviewRow[]): CodeReviewRow {
  const row = rows[0]
  if (!row) {
    throw new Error('expected at least one row')
  }
  return row
}

function findRow(rows: readonly CodeReviewRow[], key: string): CodeReviewRow {
  const row = rows.find((r) => codeReviewRowKey(r) === key)
  if (!row) {
    throw new Error(`no row for key ${key}`)
  }
  return row
}

// ── buildCodeReviewRows: partition ──────────────────────────────────────────

describe('buildCodeReviewRows: partition (never both an MR row and its source branch row)', () => {
  test('an open MR claims its source branch: only the MR row is listed', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1' }),
            mrs: [mr({ number: 5, sourceBranch: 'feature-x' })],
            branches: [branch({ name: 'feature-x' })],
          }),
        ],
      }),
    )
    expect(rowLabels(rows)).toEqual(['mr:5'])
  })

  test('origin/x and x are the same branch for the partition', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1' }),
            mrs: [mr({ number: 5, sourceBranch: 'origin/feature-x' })],
            branches: [branch({ name: 'feature-x' })],
          }),
        ],
      }),
    )
    expect(rowLabels(rows)).toEqual(['mr:5'])
  })

  test('a closed or merged MR never claims its branch', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1' }),
            mrs: [
              mr({ number: 5, sourceBranch: 'feature-x', state: 'closed' }),
              mr({ number: 6, sourceBranch: 'feature-y', state: 'merged' }),
            ],
            branches: [branch({ name: 'feature-x' }), branch({ name: 'feature-y' })],
          }),
        ],
      }),
    )
    expect(rowLabels(rows)).toEqual(['branch:feature-x', 'branch:feature-y'])
  })

  test('a branch with no MR at all gets its own row', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({ project: project({ id: 'p1' }), branches: [branch({ name: 'solo' })] }),
        ],
      }),
    )
    expect(rowLabels(rows)).toEqual(['branch:solo'])
  })
})

// ── buildCodeReviewRows: codesema/task-* branches ───────────────────────────

describe('buildCodeReviewRows: codesema/task-* branches', () => {
  test('unclaimed, a task branch gets its own row: unlike the repo branch table, it is a legitimate review target here', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1' }),
            branches: [branch({ name: 'codesema/task-abc' })],
          }),
        ],
      }),
    )
    expect(rowLabels(rows)).toEqual(['branch:codesema/task-abc'])
  })

  test('claimed by an open MR, a task branch still yields only the MR row', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1' }),
            mrs: [mr({ number: 3, sourceBranch: 'codesema/task-abc' })],
            branches: [branch({ name: 'codesema/task-abc' })],
          }),
        ],
      }),
    )
    expect(rowLabels(rows)).toEqual(['mr:3'])
  })
})

// ── buildCodeReviewRows: lastReview ─────────────────────────────────────────

describe('buildCodeReviewRows: lastReview', () => {
  test('a target with no archive at all: lastReview is null', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1' }),
            branches: [branch({ name: 'feature-x' })],
          }),
        ],
      }),
    )
    expect(firstRow(rows).lastReview).toBeNull()
  })

  test('the most recent of several archives on the same branch is picked', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1' }),
            branches: [branch({ name: 'feature-x' })],
            archives: [
              archive({ branch: 'feature-x', ref: 'old', created_at: '2026-08-01T09:00:00.000Z' }),
              archive({ branch: 'feature-x', ref: 'new', created_at: '2026-08-14T09:00:00.000Z' }),
            ],
          }),
        ],
      }),
    )
    expect(firstRow(rows).lastReview?.ref).toBe('new')
  })

  test('origin/x and x are the same branch for the archive match', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1' }),
            branches: [branch({ name: 'feature-x' })],
            archives: [archive({ branch: 'origin/feature-x', ref: 'r1' })],
          }),
        ],
      }),
    )
    expect(firstRow(rows).lastReview?.ref).toBe('r1')
  })

  test('an MR row looks up its archive by its source branch, not by number', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1' }),
            mrs: [mr({ number: 9, sourceBranch: 'feature-x' })],
            archives: [archive({ branch: 'feature-x', ref: 'r1' })],
          }),
        ],
      }),
    )
    expect(firstRow(rows).lastReview?.ref).toBe('r1')
  })
})

// ── buildCodeReviewRows: cross-project ──────────────────────────────────────

describe('buildCodeReviewRows: cross-project', () => {
  test('rows from every project are included, each carrying its own project id and name', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1', name: 'alpha-repo' }),
            branches: [branch({ name: 'a' })],
          }),
          projectInput({
            project: project({ id: 'p2', name: 'beta-repo' }),
            branches: [branch({ name: 'b' })],
          }),
        ],
      }),
    )
    expect(rows.map((r) => [r.projectId, r.projectName])).toEqual([
      ['p1', 'alpha-repo'],
      ['p2', 'beta-repo'],
    ])
  })

  test('the same MR number in two different projects both get their own row', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({ project: project({ id: 'p1' }), mrs: [mr({ number: 7 })] }),
          projectInput({ project: project({ id: 'p2' }), mrs: [mr({ number: 7 })] }),
        ],
      }),
    )
    expect(rows.map((r) => r.projectId)).toEqual(['p1', 'p2'])
  })
})

// ── buildCodeReviewRows: order (three tiers) ────────────────────────────────

describe('buildCodeReviewRows: order (three tiers)', () => {
  test('tier 0: the running review leads, even over a more recently reviewed row', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1' }),
            branches: [branch({ name: 'running-now' }), branch({ name: 'reviewed-recently' })],
            archives: [
              archive({
                branch: 'running-now',
                created_at: '2026-08-01T09:00:00.000Z',
              }),
              archive({
                branch: 'reviewed-recently',
                created_at: '2026-08-14T09:00:00.000Z',
              }),
            ],
          }),
        ],
        running: runningStatus('p1', { kind: 'branch', name: 'running-now' }),
      }),
    )
    expect(rowLabels(rows)).toEqual(['branch:running-now', 'branch:reviewed-recently'])
  })

  test('tier 1: rows with a past review sort by that review recency, most recent first', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1' }),
            branches: [branch({ name: 'older' }), branch({ name: 'newer' })],
            archives: [
              archive({ branch: 'older', created_at: '2026-08-01T09:00:00.000Z' }),
              archive({ branch: 'newer', created_at: '2026-08-14T09:00:00.000Z' }),
            ],
          }),
        ],
      }),
    )
    expect(rowLabels(rows)).toEqual(['branch:newer', 'branch:older'])
  })

  test('tier 2: never-reviewed rows keep arrival order (stable sort, not alphabetical)', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1' }),
            branches: [branch({ name: 'zeta' }), branch({ name: 'alpha' })],
          }),
        ],
      }),
    )
    expect(rowLabels(rows)).toEqual(['branch:zeta', 'branch:alpha'])
  })

  test('tier 1 outranks tier 2: any past review beats never reviewed', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1' }),
            branches: [branch({ name: 'never' }), branch({ name: 'reviewed-once' })],
            archives: [archive({ branch: 'reviewed-once' })],
          }),
        ],
      }),
    )
    expect(rowLabels(rows)).toEqual(['branch:reviewed-once', 'branch:never'])
  })

  test('a running review in another project never promotes a same-numbered row here', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1' }),
            branches: [branch({ name: 'zeta' }), branch({ name: 'alpha' })],
          }),
        ],
        running: runningStatus('p2', { kind: 'branch', name: 'zeta' }),
      }),
    )
    expect(rowLabels(rows)).toEqual(['branch:zeta', 'branch:alpha'])
  })
})

// ── isCodeReviewRowRunning ───────────────────────────────────────────────────

describe('isCodeReviewRowRunning', () => {
  test('true for the exact project and source the status names', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [projectInput({ project: project({ id: 'p1' }), mrs: [mr({ number: 7 })] })],
      }),
    )
    const row = findRow(rows, 'mr/p1/7')
    expect(isCodeReviewRowRunning(row, runningStatus('p1', { kind: 'mr', number: 7 }))).toBe(true)
  })

  test('a different project with the same MR number does not match', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({ project: project({ id: 'p1' }), mrs: [mr({ number: 7 })] }),
          projectInput({ project: project({ id: 'p2' }), mrs: [mr({ number: 7 })] }),
        ],
      }),
    )
    const rowP1 = findRow(rows, 'mr/p1/7')
    const rowP2 = findRow(rows, 'mr/p2/7')
    const status = runningStatus('p1', { kind: 'mr', number: 7 })
    expect(isCodeReviewRowRunning(rowP1, status)).toBe(true)
    expect(isCodeReviewRowRunning(rowP2, status)).toBe(false)
  })

  test('a different MR number in the same project does not match', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1' }),
            mrs: [mr({ number: 7 }), mr({ number: 8 })],
          }),
        ],
      }),
    )
    const row7 = findRow(rows, 'mr/p1/7')
    expect(isCodeReviewRowRunning(row7, runningStatus('p1', { kind: 'mr', number: 8 }))).toBe(false)
  })

  test('nothing matches when no review is running, or the run is idle/done/error', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [projectInput({ project: project({ id: 'p1' }), mrs: [mr({ number: 7 })] })],
      }),
    )
    const row = findRow(rows, 'mr/p1/7')
    expect(isCodeReviewRowRunning(row, { available: false })).toBe(false)
    expect(isCodeReviewRowRunning(row, { available: true, phase: 'idle' })).toBe(false)
    expect(
      isCodeReviewRowRunning(row, {
        available: true,
        phase: 'done',
        project_id: 'p1',
        source: { kind: 'mr', number: 7 },
        mode: 'simple',
      }),
    ).toBe(false)
  })

  test('a branch source matches by value, not by object identity', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1' }),
            branches: [branch({ name: 'feature-x' })],
          }),
        ],
      }),
    )
    const row = findRow(rows, 'branch/p1/feature-x')
    expect(
      isCodeReviewRowRunning(row, runningStatus('p1', { kind: 'branch', name: 'feature-x' })),
    ).toBe(true)
  })
})

// ── filterCodeReviewRows ─────────────────────────────────────────────────────

describe('filterCodeReviewRows', () => {
  function sample(): CodeReviewRow[] {
    return buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1', name: 'checkout-service' }),
            mrs: [mr({ number: 42, title: 'Fix payment retry loop', sourceBranch: 'fix-payment' })],
            branches: [branch({ name: 'dark-mode', subject: 'add dark mode toggle' })],
          }),
        ],
      }),
    )
  }

  test('an empty query returns the exact same reference', () => {
    const rows = sample()
    expect(filterCodeReviewRows(rows, '')).toBe(rows)
  })

  test('a whitespace-only query returns the exact same reference', () => {
    const rows = sample()
    expect(filterCodeReviewRows(rows, '   ')).toBe(rows)
  })

  test('matches on the MR title', () => {
    expect(rowLabels(filterCodeReviewRows(sample(), 'payment'))).toEqual(['mr:42'])
  })

  test('matches on the branch name', () => {
    expect(rowLabels(filterCodeReviewRows(sample(), 'dark-mode'))).toEqual(['branch:dark-mode'])
  })

  test('matches on the branch last commit subject', () => {
    expect(rowLabels(filterCodeReviewRows(sample(), 'toggle'))).toEqual(['branch:dark-mode'])
  })

  test('matches on the owning project name, across both kinds of row', () => {
    expect(rowLabels(filterCodeReviewRows(sample(), 'checkout'))).toEqual([
      'mr:42',
      'branch:dark-mode',
    ])
  })

  test('the MR number is not searched', () => {
    expect(filterCodeReviewRows(sample(), '42')).toEqual([])
  })

  test('is case-insensitive', () => {
    expect(rowLabels(filterCodeReviewRows(sample(), 'PAYMENT'))).toEqual(['mr:42'])
  })

  test('a query matching nothing yields an empty array', () => {
    expect(filterCodeReviewRows(sample(), 'no-such-text')).toEqual([])
  })
})

// ── codeReviewRowKey ──────────────────────────────────────────────────────────

describe('codeReviewRowKey', () => {
  test('two projects sharing an MR number do not collide', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({ project: project({ id: 'p1' }), mrs: [mr({ number: 7 })] }),
          projectInput({ project: project({ id: 'p2' }), mrs: [mr({ number: 7 })] }),
        ],
      }),
    )
    expect(new Set(rows.map(codeReviewRowKey)).size).toBe(2)
  })

  test('an MR row and a branch row never collide even with overlapping raw values', () => {
    const rows = buildCodeReviewRows(
      input({
        projects: [
          projectInput({
            project: project({ id: 'p1' }),
            mrs: [mr({ number: 7, sourceBranch: 'a' })],
            branches: [branch({ name: 'b' })],
          }),
        ],
      }),
    )
    expect(new Set(rows.map(codeReviewRowKey)).size).toBe(2)
  })
})
