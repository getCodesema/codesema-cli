// Pure logic of the repository branches/worktrees table: the KPI tile
// counters and the dense table rows built from local branches, worktrees,
// open MRs and the conversations attached to each. Components only compose
// these functions (testable with bun:test, no DOM, no fetch).

import type { ForgeMr, GitWorktree, LocalBranch } from '../types'
import {
  ACTIVE_TASK_STATUSES,
  resolveBranchClick,
  shortBranch,
  type BranchClickResolution,
} from './useProjects'
import { sectionOf } from './useTaskBoard'
import type { TaskState } from './useTasks'

/**
 * One row of the branches table: a local branch, or a worktree checked out
 * on a detached HEAD. A discriminated union rather than nullable branch
 * fields on one shape, so a detached row cannot carry a name, a subject, an
 * open MR or conversations it structurally has none of.
 */
export type BranchRow =
  | {
      kind: 'branch'
      name: string
      worktreePath: string | null
      subject: string
      lastCommitRelative: string
      isCurrent: boolean
      openMr: ForgeMr | null
      conversations: readonly TaskState[]
      action: BranchClickResolution
    }
  | {
      kind: 'detached-worktree'
      worktreePath: string
    }

export type BuildBranchRowsInput = {
  repoProjectId: string
  branches: readonly LocalBranch[]
  worktrees: readonly GitWorktree[]
  mrs: readonly ForgeMr[]
  states: readonly TaskState[]
}

function openMrBySourceBranch(mrs: readonly ForgeMr[], branchName: string): ForgeMr | null {
  const short = shortBranch(branchName)
  return (
    mrs.find(
      (candidate) => candidate.state === 'open' && shortBranch(candidate.sourceBranch) === short,
    ) ?? null
  )
}

/** Per-repository context threaded through row construction: kept as one
 * object so attachesToRow/buildBranchRow stay under the project's max-params
 * lint budget. */
type RowBuildContext = {
  repoProjectId: string
  rowNames: ReadonlySet<string>
  mrs: readonly ForgeMr[]
}

/**
 * Attachment rule (mirrors buildProjectTree's shipped/base split): a native
 * conversation attaches by its own branch first, falling back to its base
 * only when its own branch has no row of its own AND no open MR already
 * claims it there. The row check matters as much as the MR one: once some
 * OTHER row matches the conversation's own branch, this row must not also
 * claim it through base, or the same conversation shows twice. A conversation
 * whose home project is elsewhere never attaches by branch/base at all: those
 * fields describe its relationship to ITS OWN repo, not this one, so only the
 * attachment it recorded for this repository counts.
 */
function attachesToRow(state: TaskState, branchName: string, ctx: RowBuildContext): boolean {
  const short = shortBranch(branchName)
  if (state.projectId === ctx.repoProjectId) {
    const ownBranch = shortBranch(state.record.branch)
    if (ctx.rowNames.has(ownBranch)) {
      return ownBranch === short
    }
    return (
      shortBranch(state.record.base) === short &&
      openMrBySourceBranch(ctx.mrs, state.record.branch) === null
    )
  }
  return (
    state.record.attachments?.some(
      (attachment) =>
        attachment.project_id === ctx.repoProjectId && attachment.branch === branchName,
    ) ?? false
  )
}

function buildBranchRow(
  branch: LocalBranch,
  ctx: RowBuildContext,
  states: readonly TaskState[],
): BranchRow {
  const openMr = openMrBySourceBranch(ctx.mrs, branch.name)
  const nativeStates = states.filter((state) => state.projectId === ctx.repoProjectId)
  return {
    kind: 'branch',
    name: branch.name,
    worktreePath: branch.worktreePath,
    subject: branch.subject,
    lastCommitRelative: branch.lastCommitRelative,
    isCurrent: branch.isCurrent,
    openMr,
    conversations: states.filter((state) => attachesToRow(state, branch.name, ctx)),
    action: resolveBranchClick(branch.name, openMr, nativeStates),
  }
}

function latestActivity(row: BranchRow): number {
  if (row.kind !== 'branch') {
    return Number.NEGATIVE_INFINITY
  }
  return row.conversations.reduce((max, state) => {
    const at = Date.parse(state.record.updated_at)
    return Number.isNaN(at) ? max : Math.max(max, at)
  }, Number.NEGATIVE_INFINITY)
}

/** Sort tiers, lowest first: 0 a non-terminal conversation holds the branch,
 * 1 an open MR or the current checkout, 2 everything else, 3 detached
 * worktrees, always last. */
function rowTier(row: BranchRow): 0 | 1 | 2 | 3 {
  if (row.kind === 'detached-worktree') {
    return 3
  }
  if (row.conversations.some((state) => ACTIVE_TASK_STATUSES.has(state.record.status))) {
    return 0
  }
  if (row.openMr !== null || row.isCurrent) {
    return 1
  }
  return 2
}

/**
 * Tier 0 sorts by most recent activity; every other tier keeps the order it
 * arrived in, which the stable sort guarantees on a tie (0 returned). For
 * branch rows that order is the server's `--sort=-committerdate` — re-sorting
 * it here would be redundant and could disagree with the server on ties.
 */
function compareBranchRows(a: BranchRow, b: BranchRow): number {
  const tierA = rowTier(a)
  const tierB = rowTier(b)
  if (tierA !== tierB) {
    return tierA - tierB
  }
  return tierA === 0 ? latestActivity(b) - latestActivity(a) : 0
}

/**
 * One row per local branch plus one per detached-HEAD worktree. The
 * technical codesema/task-* branches never get a row: a conversation on one
 * of them is already shown nested under its base (or its shipped MR).
 */
export function buildBranchRows(input: BuildBranchRowsInput): BranchRow[] {
  const { repoProjectId, branches, worktrees, mrs, states } = input
  const includedBranches = branches.filter((branch) => !branch.name.startsWith('codesema/task-'))
  const rowNames = new Set(includedBranches.map((branch) => shortBranch(branch.name)))
  const ctx: RowBuildContext = { repoProjectId, rowNames, mrs }
  const branchRows = includedBranches.map((branch) => buildBranchRow(branch, ctx, states))
  const detachedRows: BranchRow[] = worktrees
    .filter((worktree) => worktree.branch === null)
    .map((worktree) => ({ kind: 'detached-worktree' as const, worktreePath: worktree.path }))
  return [...branchRows, ...detachedRows].toSorted(compareBranchRows)
}

/** KPI tile counters for the band above the table. */
export type RepositoryTiles = {
  branchCount: number
  worktreeCount: number
  activeConversationCount: number
  waitingOnYouCount: number
}

function touchesRepository(state: TaskState, repoProjectId: string): boolean {
  if (state.projectId === repoProjectId) {
    return true
  }
  return (
    state.record.attachments?.some((attachment) => attachment.project_id === repoProjectId) ?? false
  )
}

export function buildRepositoryTiles(
  rows: readonly BranchRow[],
  states: readonly TaskState[],
  repoProjectId: string,
): RepositoryTiles {
  const relatedStatuses = states
    .filter((state) => touchesRepository(state, repoProjectId))
    .map((state) => state.record.status)
  return {
    branchCount: rows.filter((row) => row.kind === 'branch').length,
    worktreeCount: rows.filter(
      (row) => row.kind === 'detached-worktree' || row.worktreePath !== null,
    ).length,
    activeConversationCount: relatedStatuses.filter((status) => ACTIVE_TASK_STATUSES.has(status))
      .length,
    waitingOnYouCount: relatedStatuses.filter((status) => sectionOf(status) === 'waiting').length,
  }
}
