// Pure logic of the "Code review" category list: one row per open merge
// request and per local branch worth reviewing, across every registered
// project (not one repository's view). Components only compose these
// functions (testable with bun:test, no DOM, no fetch). Row construction
// mirrors useRepository.ts's branch table, scaled to many projects at once.

import type {
  ForgeMr,
  LocalBranch,
  MrReviewStatus,
  Project,
  ReviewArchiveSummary,
  ReviewSource,
} from '../types'
import { shortBranch } from './useProjects'
import { sameReviewSource } from './useWorkspaceNav'

/**
 * One row of the list: an open merge request, or a local branch none of the
 * listed MRs already claims as its source. A discriminated union rather than
 * an optional `mr`/`branch` pair on one shape, so an MR row cannot carry a
 * LocalBranch it structurally has none of: an MR's source branch may never
 * have been fetched locally at all.
 */
export type CodeReviewRow =
  | {
      kind: 'mr'
      projectId: string
      projectName: string
      source: Extract<ReviewSource, { kind: 'mr' }>
      mr: ForgeMr
      lastReview: ReviewArchiveSummary | null
    }
  | {
      kind: 'branch'
      projectId: string
      projectName: string
      source: Extract<ReviewSource, { kind: 'branch' }>
      branch: LocalBranch
      lastReview: ReviewArchiveSummary | null
    }

/** One project's raw material for the list. `archives` carries no project
 * identity of its own (ReviewArchiveSummary has no such field), so the
 * caller must already scope it per project, same as `mrs` and `branches`. */
export type CodeReviewProjectInput = {
  project: Project
  mrs: readonly ForgeMr[]
  branches: readonly LocalBranch[]
  archives: readonly ReviewArchiveSummary[]
}

export type BuildCodeReviewRowsInput = {
  projects: readonly CodeReviewProjectInput[]
  /** The globally running review, if any. Omitted when the caller has no
   * live status yet: the running tier is then simply empty, never an error. */
  running?: MrReviewStatus
}

/** The most recent archive naming this branch (origin/x and x the same
 * target), or null when it was never reviewed. ISO-8601 timestamps compare
 * correctly as plain strings, so no Date.parse is needed here. */
function latestArchive(
  archives: readonly ReviewArchiveSummary[],
  branchName: string,
): ReviewArchiveSummary | null {
  const short = shortBranch(branchName)
  let latest: ReviewArchiveSummary | null = null
  for (const archive of archives) {
    if (shortBranch(archive.branch) !== short) {
      continue
    }
    if (latest === null || archive.created_at > latest.created_at) {
      latest = archive
    }
  }
  return latest
}

type RowBuildContext = { project: Project; archives: readonly ReviewArchiveSummary[] }

function buildMrRow(mr: ForgeMr, ctx: RowBuildContext): CodeReviewRow {
  return {
    kind: 'mr',
    projectId: ctx.project.id,
    projectName: ctx.project.name,
    source: { kind: 'mr', number: mr.number },
    mr,
    lastReview: latestArchive(ctx.archives, mr.sourceBranch),
  }
}

function buildBranchRow(branch: LocalBranch, ctx: RowBuildContext): CodeReviewRow {
  return {
    kind: 'branch',
    projectId: ctx.project.id,
    projectName: ctx.project.name,
    source: { kind: 'branch', name: branch.name },
    branch,
    lastReview: latestArchive(ctx.archives, branch.name),
  }
}

/**
 * A project's rows, unsorted: every open MR, then every local branch not
 * already claimed as an open MR's source (strict partition, never both).
 * codesema/task-* branches are NOT excluded here, unlike useRepository.ts's
 * table: there they are redundant with the conversation that already shows
 * them, but this list is not a conversation view, and a task branch reviewed
 * before it ever had (or without ever getting) an MR would otherwise have no
 * row left to surface its archive.
 */
function projectRows(input: CodeReviewProjectInput): CodeReviewRow[] {
  const { project, mrs, branches, archives } = input
  const ctx: RowBuildContext = { project, archives }
  const openMrs = mrs.filter((mr) => mr.state === 'open')
  const claimedBranches = new Set(openMrs.map((mr) => shortBranch(mr.sourceBranch)))
  const mrRows = openMrs.map((mr) => buildMrRow(mr, ctx))
  const branchRows = branches
    .filter((branch) => !claimedBranches.has(shortBranch(branch.name)))
    .map((branch) => buildBranchRow(branch, ctx))
  return [...mrRows, ...branchRows]
}

/** True when `status` names the exact review this row would show as live:
 * same project, same source. Never stored on the row itself (see
 * BuildCodeReviewRowsInput.running): MrReviewStatus changes on every poll,
 * so a boolean field here would mean a new row identity every tick. */
export function isCodeReviewRowRunning(row: CodeReviewRow, status: MrReviewStatus): boolean {
  return (
    status.available &&
    status.phase === 'running' &&
    status.project_id === row.projectId &&
    sameReviewSource(status.source, row.source)
  )
}

function codeReviewTier(row: CodeReviewRow, running: MrReviewStatus): 0 | 1 | 2 {
  if (isCodeReviewRowRunning(row, running)) {
    return 0
  }
  return row.lastReview !== null ? 1 : 2
}

function lastReviewTime(row: CodeReviewRow): string {
  return row.lastReview?.created_at ?? ''
}

/** Tier 0 (the running review, at most one row across the whole list) always
 * leads; tier 1 (a past review exists) sorts by that review's own recency;
 * tier 2 (never reviewed) keeps arrival order, guaranteed by the stable sort. */
function compareCodeReviewRows(
  running: MrReviewStatus,
): (a: CodeReviewRow, b: CodeReviewRow) => number {
  return (a, b) => {
    const tierA = codeReviewTier(a, running)
    const tierB = codeReviewTier(b, running)
    if (tierA !== tierB) {
      return tierA - tierB
    }
    return tierA === 1 ? lastReviewTime(b).localeCompare(lastReviewTime(a)) : 0
  }
}

/** Builds the full cross-project list, already in its one fixed order: no
 * configurable sort or filter here (see filterCodeReviewRows for the free
 * text search applied on top). */
export function buildCodeReviewRows(input: BuildCodeReviewRowsInput): CodeReviewRow[] {
  const running = input.running ?? { available: false }
  const rows = input.projects.flatMap(projectRows)
  return rows.toSorted(compareCodeReviewRows(running))
}

function rowSearchText(row: CodeReviewRow): readonly string[] {
  return row.kind === 'mr'
    ? [row.mr.title, row.mr.sourceBranch, row.projectName]
    : [row.branch.name, row.branch.subject, row.projectName]
}

/** Case-insensitive substring match over the row's own text: title or branch
 * name, the branch's last commit subject, and the owning project's name. The
 * MR number is left out, same doctrine as filterBranchRows: it is a numeric
 * identifier, not descriptive text the row reads as prose. */
export function filterCodeReviewRows(
  rows: readonly CodeReviewRow[],
  query: string,
): readonly CodeReviewRow[] {
  const trimmed = query.trim().toLowerCase()
  if (trimmed === '') {
    return rows
  }
  return rows.filter((row) =>
    rowSearchText(row).some((text) => text.toLowerCase().includes(trimmed)),
  )
}

/** Stable identity of a row, for expansion state and :key. Prefixed per
 * variant like branchRowKey, extended with the project id: this list spans
 * every project, so two projects sharing an MR number or a branch name would
 * otherwise collide. */
export function codeReviewRowKey(row: CodeReviewRow): string {
  return row.kind === 'mr'
    ? `mr/${row.projectId}/${row.mr.number}`
    : `branch/${row.projectId}/${row.branch.name}`
}
