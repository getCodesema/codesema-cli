import { listOpenMrs, type ForgeMrsResult } from './forge-mrs.js'
import { currentBranch, git, refExists, repoRoot, tryGit } from './git.js'
import { computeDiffSummary, detectTarget, excludePathspecs, resolveRef } from './prep.js'

export type PreviewSource = { kind: 'branch'; name: string } | { kind: 'mr'; number: number }

export type PreviewFileStatus = 'added' | 'deleted' | 'modified' | 'renamed'

export type PreviewFile = {
  path: string
  /** Source path of a rename or copy; the diff pathspec needs it for git to re-detect the pair. */
  previousPath?: string
  additions: number
  deletions: number
  status: PreviewFileStatus
}

export type PreviewDiffStats = { files: number; additions: number; deletions: number }

export type PreviewResult = {
  branch: string
  target: string
  commits: string[]
  files: PreviewFile[]
  diffStats: PreviewDiffStats
}

export const PREVIEW_DIFF_MAX_CHARS = 200_000

/** Rejects anything unsafe as a git ref name at the HTTP boundary: empty, a null byte, or a leading dash
 *  (which git could otherwise parse as an option even after validation elsewhere). */
function isSafeRefName(name: string): boolean {
  return name.length > 0 && !name.includes('\0') && !name.startsWith('-')
}

export function parsePreviewSource(params: URLSearchParams): PreviewSource | null {
  const source = params.get('source')
  if (source === 'branch') {
    const name = params.get('name')
    if (!name || !isSafeRefName(name)) {
      return null
    }
    return { kind: 'branch', name }
  }
  if (source === 'mr') {
    const raw = params.get('number')
    if (!raw) {
      return null
    }
    const number = Number(raw)
    if (!Number.isInteger(number) || number <= 0) {
      return null
    }
    return { kind: 'mr', number }
  }
  return null
}

export function parsePreviewPath(params: URLSearchParams): string | null {
  const path = params.get('path')
  if (!path || !isSafeRefName(path)) {
    return null
  }
  return path
}

/**
 * Explicit refspec, same reasoning as mr-review-runner.ts's fetchMrBranch: the
 * default fetch refspec can silently no-op on a shallow clone or a remote
 * without the usual `+refs/heads/*:refs/remotes/origin/*`.
 */
function fetchBranch(cwd: string, branch: string): void {
  git(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], cwd)
}

export type ResolvedPreviewRefs = {
  sourceRef: string
  targetRef: string
  branch: string
  target: string
}

/**
 * Resolves the two refs to diff, without ever checking out a worktree:
 * - branch: the local branch itself vs. the same target-detection logic as
 *   prep/review (forge CLI when it is the checked-out branch, else the nearest
 *   merge-base heuristic).
 * - mr: fetches the source branch into a remote-tracking ref and diffs it
 *   against the MR's target branch, both resolved as refs (local or remote).
 */
export async function resolvePreviewRefs(
  cwd: string,
  source: PreviewSource,
  listMrs: (cwd: string) => Promise<ForgeMrsResult> = listOpenMrs,
): Promise<ResolvedPreviewRefs> {
  const root = repoRoot(cwd)

  if (source.kind === 'branch') {
    if (!refExists(`refs/heads/${source.name}`, root)) {
      throw new Error(`branch not found: ${source.name}`)
    }
    const checkedOut = currentBranch(root)
    const headRef = source.name === checkedOut ? 'HEAD' : source.name
    const { target } = await detectTarget(source.name, undefined, root, headRef)
    if (target.replace(/^origin\//, '') === source.name) {
      throw new Error(`branch ${source.name} cannot be its own target`)
    }
    return { sourceRef: headRef, targetRef: target, branch: source.name, target }
  }

  const mrsResult = await listMrs(root)
  if (!mrsResult.available) {
    throw new Error('forge merge requests unavailable')
  }
  const mr = mrsResult.mrs.find((m) => m.number === source.number)
  if (!mr) {
    throw new Error(`no open MR #${source.number}`)
  }

  fetchBranch(root, mr.sourceBranch)
  const targetRef = resolveRef(mr.targetBranch, root)
  if (!targetRef) {
    throw new Error(`target branch not found: ${mr.targetBranch}`)
  }
  return {
    sourceRef: `refs/remotes/origin/${mr.sourceBranch}`,
    targetRef,
    branch: mr.sourceBranch,
    target: mr.targetBranch,
  }
}

/**
 * Keeps only the section(s) of a multi-file diff whose header targets `path`.
 * The two-path pathspec used for renames can drag in unrelated sections: the
 * source path may match a whole directory in the target ref, or still exist
 * with its own changes when the record is a copy. Falls back to the full diff
 * if no header matches (defensive: never hide everything).
 */
export function pickDiffSection(raw: string, path: string): string {
  let keep = false
  let matched = false
  const kept: string[] = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      keep = line.endsWith(` b/${path}`)
      matched ||= keep
    }
    if (keep) {
      kept.push(line)
    }
  }
  return matched ? kept.join('\n') : raw
}

/** File status per path, from `git diff --name-status` (additions/deletions come from computeDiffSummary). */
function fileStatuses(range: string, cwd: string): Map<string, PreviewFileStatus> {
  const excludes = excludePathspecs(cwd)
  const raw =
    tryGit(
      ['-c', 'core.quotePath=false', 'diff', '--name-status', range, '--', '.', ...excludes],
      cwd,
    ) ?? ''
  const statuses = new Map<string, PreviewFileStatus>()
  for (const line of raw.split('\n').filter(Boolean)) {
    const [code = '', ...rest] = line.split('\t')
    const path = rest[rest.length - 1] ?? ''
    if (!path) {
      continue
    }
    const status: PreviewFileStatus = code.startsWith('A')
      ? 'added'
      : code.startsWith('D')
        ? 'deleted'
        : code.startsWith('R')
          ? 'renamed'
          : 'modified'
    statuses.set(path, status)
  }
  return statuses
}

export async function buildPreview(
  cwd: string,
  source: PreviewSource,
  listMrs?: (cwd: string) => Promise<ForgeMrsResult>,
): Promise<PreviewResult> {
  const root = repoRoot(cwd)
  const refs = await resolvePreviewRefs(root, source, listMrs)
  const summary = computeDiffSummary(refs.sourceRef, refs.targetRef, root)
  const statuses = fileStatuses(`${refs.targetRef}...${refs.sourceRef}`, root)
  const files: PreviewFile[] = summary.files.map((f) => ({
    ...f,
    status: statuses.get(f.path) ?? 'modified',
  }))
  const diffStats: PreviewDiffStats = {
    files: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  }
  return { branch: refs.branch, target: refs.target, commits: summary.commits, files, diffStats }
}

export async function buildFileDiff(
  cwd: string,
  source: PreviewSource,
  path: string,
  listMrs?: (cwd: string) => Promise<ForgeMrsResult>,
): Promise<{ diff: string; truncated: boolean }> {
  const root = repoRoot(cwd)
  const refs = await resolvePreviewRefs(root, source, listMrs)
  const summary = computeDiffSummary(refs.sourceRef, refs.targetRef, root)
  const file = summary.files.find((f) => f.path === path)
  if (!file) {
    throw new Error(`path is not part of this diff: ${path}`)
  }
  const range = `${refs.targetRef}...${refs.sourceRef}`
  const paths = file.previousPath ? [path, file.previousPath] : [path]
  let raw = git(
    ['-c', 'core.quotePath=false', 'diff', '--no-color', '-U10', range, '--', ...paths],
    root,
  )
  if (file.previousPath) {
    raw = pickDiffSection(raw, path)
  }
  if (raw.length > PREVIEW_DIFF_MAX_CHARS) {
    return { diff: raw.slice(0, PREVIEW_DIFF_MAX_CHARS), truncated: true }
  }
  return { diff: raw, truncated: false }
}
