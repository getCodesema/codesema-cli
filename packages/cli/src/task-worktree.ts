// Git worktree lifecycle for agent tasks: one worktree + one branch per task,
// kept under <repo>/.codesema/worktrees/<task-id>/ (NOT a tmpdir like the MR
// review worktrees) so an interrupted task survives a reboot and can be
// resumed. The parent .codesema/ directory auto-gitignores itself.

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { listWorktrees } from './branches.js'
import { ensureWorkDir } from './config.js'
import { git, refExists, tryGit } from './git.js'
import { t } from './i18n.js'
import { resolveRef, targetFromOriginHead } from './prep.js'

/** Same candidates and order as prep's target detection heuristic. */
const BASE_CANDIDATES = ['develop', 'main', 'master'] as const

/**
 * ONE identity per branch: 'origin/develop' and 'develop' are the same branch
 * (the remote-tracking ref is transport, not identity). Every branch name a
 * task records or a caller sends is normalized to the SHORT name; resolution
 * back to a concrete ref prefers the local head, then origin.
 */
export function shortBranchName(name: string): string {
  return name.startsWith('origin/') ? name.slice('origin/'.length) : name
}

/** Concrete start ref for a short branch name: local head first, then origin. Null when neither exists. */
export function resolveBranchRef(cwd: string, name: string): string | null {
  if (refExists(`refs/heads/${name}`, cwd)) {
    return `refs/heads/${name}`
  }
  if (refExists(`refs/remotes/origin/${name}`, cwd)) {
    return `refs/remotes/origin/${name}`
  }
  return null
}

export function taskWorktreePath(cwd: string, taskId: string): string {
  return join(cwd, '.codesema', 'worktrees', taskId)
}

const SLUG_MAX = 40

/** Same slugging as review archive names (record.ts), with 'task' as last resort. */
function slug(s: string): string {
  const full = s
    // NFKD + strip combining marks: "Réponds" → "reponds", not "r-ponds".
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (full.length <= SLUG_MAX) {
    return full || 'task'
  }
  // Titles are free-form prose: cap the branch name, cutting on a word when one
  // fits, mid-word for a single overlong token.
  const cut = full.slice(0, SLUG_MAX + 1)
  const atDash = cut.lastIndexOf('-')
  return (atDash > 0 ? cut.slice(0, atDash) : full.slice(0, SLUG_MAX)).replace(/-+$/g, '')
}

/**
 * Base ref a new task branches from. A task has no current branch to compare
 * against, so the forge probe and merge-base heuristic of prep's detectTarget
 * don't apply: origin/HEAD names the repo default branch, then the usual
 * candidates (local first, origin/ fallback via resolveRef).
 */
export function detectTaskBase(cwd: string): string {
  const fromHead = targetFromOriginHead(cwd)
  if (fromHead) {
    // origin/HEAD names 'origin/<default>': the record keeps the SHORT identity.
    return shortBranchName(fromHead.target)
  }
  for (const name of BASE_CANDIDATES) {
    const ref = resolveRef(name, cwd)
    if (ref) {
      return shortBranchName(ref)
    }
  }
  throw new Error(t('task.noBase'))
}

/**
 * codesema/task-<slug>, suffixed -2, -3… when an earlier task already took the
 * name (the branch outlives its task until shipped or abandoned). The task id
 * is the unconditionally-unique last resort.
 */
function freeBranchName(cwd: string, taskId: string, title: string): string {
  const wanted = `codesema/task-${slug(title)}`
  if (!refExists(`refs/heads/${wanted}`, cwd)) {
    return wanted
  }
  for (let n = 2; n <= 99; n++) {
    const candidate = `${wanted}-${n}`
    if (!refExists(`refs/heads/${candidate}`, cwd)) {
      return candidate
    }
  }
  return `${wanted}-${taskId}`
}

export type TaskWorktree = { branch: string; worktree: string; base: string }

/**
 * Thrown when a work-on branch is already checked out in another worktree
 * (the MAIN worktree counts): git refuses the second checkout, and the HTTP
 * layer must render this as a 409, not a 500.
 */
export class BranchInUseError extends Error {
  readonly branch: string
  /** Worktree currently holding the branch. */
  readonly worktreePath: string

  constructor(message: string, branch: string, worktreePath: string) {
    super(message)
    this.name = 'BranchInUseError'
    this.branch = branch
    this.worktreePath = worktreePath
  }
}

/** Path of the worktree `branch` is checked out in (the MAIN worktree counts), null when free. */
export function branchCheckoutPath(cwd: string, branch: string): string | null {
  return listWorktrees(cwd).find((wt) => wt.branch === branch)?.path ?? null
}

/**
 * Work-on mode: checks the EXISTING branch itself out in the task's worktree —
 * no derived branch, the agent's commits land directly on refs/heads/<branch>.
 * Validation order matters: the unknown-branch check has no side effects, then
 * only the task's OWN stale directory (a crashed earlier run of this task id)
 * is cleaned before the in-use check — pruning it may be exactly what frees
 * the branch — and nothing else is created before both checks pass.
 */
function createWorkOnWorktree(cwd: string, taskId: string, branch: string): TaskWorktree {
  // The refs/heads/ qualification neutralizes option-lookalike names ('-evil').
  if (!refExists(`refs/heads/${branch}`, cwd)) {
    // Same branch, remote-only so far (a teammate's MR never pulled): create
    // the local tracking head — that IS the branch, origin/ was transport.
    if (refExists(`refs/remotes/origin/${branch}`, cwd)) {
      // --track wants a configured remote; an exotic setup (or a bare
      // remote-tracking ref) still deserves the branch — minus the upstream.
      if (tryGit(['branch', '--track', branch, `origin/${branch}`], cwd) === null) {
        git(['branch', branch, `refs/remotes/origin/${branch}`], cwd)
      }
    } else {
      throw new Error(t('task.unknownBranch', { branch }))
    }
  }
  const worktree = taskWorktreePath(cwd, taskId)
  // Unconditional: a crashed run may have left the directory (remove drops
  // it) OR only a dangling git registration of a deleted directory (prune
  // drops that) — either would keep the branch looking checked out.
  tryGit(['worktree', 'remove', '--force', worktree], cwd)
  tryGit(['worktree', 'prune'], cwd)
  const takenBy = branchCheckoutPath(cwd, branch)
  if (takenBy) {
    throw new BranchInUseError(t('task.branchInUse', { branch, path: takenBy }), branch, takenBy)
  }
  // .codesema/ must exist self-gitignored before git materializes anything in it.
  ensureWorkDir(cwd)
  mkdirSync(join(cwd, '.codesema', 'worktrees'), { recursive: true })
  git(['worktree', 'add', worktree, branch], cwd)
  // base is the caller's concern in work-on mode (the MR target, kept on the
  // record by the server): this layer only knows the branch.
  return { branch, worktree, base: '' }
}

/**
 * Creates the task's branch from the base and checks it out in a fresh
 * worktree. The base is either the caller's explicit LOCAL branch (opts.base,
 * validated to exist before anything is created on disk) or the detected
 * default (detectTaskBase). -b always creates a NEW branch (collisions get a
 * numeric suffix), so this never steals a branch checked out elsewhere.
 *
 * opts.branch instead (exclusive with opts.base) is work-on mode: the
 * conversation works DIRECTLY on that existing branch — see
 * createWorkOnWorktree. A branch checked out anywhere else throws
 * BranchInUseError before anything is created.
 */
export function createTaskWorktree(
  cwd: string,
  taskId: string,
  title: string,
  opts: { base?: string; branch?: string } = {},
): TaskWorktree {
  if (opts.branch !== undefined) {
    return createWorkOnWorktree(cwd, taskId, shortBranchName(opts.branch))
  }
  // An explicit base must name an existing branch (local OR origin — same
  // identity) BEFORE any directory or ref is created: a typo must leave the
  // repo untouched. The full-ref qualification also neutralizes
  // option-lookalike names ('-evil').
  const explicitBase = opts.base !== undefined ? shortBranchName(opts.base) : undefined
  if (explicitBase !== undefined && resolveBranchRef(cwd, explicitBase) === null) {
    throw new Error(t('task.unknownBase', { base: explicitBase }))
  }
  // .codesema/ must exist self-gitignored before git materializes anything in it.
  ensureWorkDir(cwd)
  mkdirSync(join(cwd, '.codesema', 'worktrees'), { recursive: true })
  const base = explicitBase ?? detectTaskBase(cwd)
  const startPoint = resolveBranchRef(cwd, base)
  if (startPoint === null) {
    throw new Error(t('task.unknownBase', { base }))
  }
  const branch = freeBranchName(cwd, taskId, title)
  const worktree = taskWorktreePath(cwd, taskId)
  if (existsSync(worktree)) {
    // A stale directory (crashed run, aborted creation) would fail the add.
    tryGit(['worktree', 'remove', '--force', worktree], cwd)
    tryGit(['worktree', 'prune'], cwd)
  }
  git(['worktree', 'add', '-b', branch, worktree, startPoint], cwd)
  return { branch, worktree, base }
}

/**
 * Best-effort cleanup (pattern of the MR review runner): a failed removal must
 * never turn the caller's outcome into an error. The branch is only deleted on
 * explicit abandon — a shipped task keeps its branch.
 */
export function removeTaskWorktree(
  cwd: string,
  taskId: string,
  branch: string,
  opts: { deleteBranch: boolean },
): void {
  tryGit(['worktree', 'remove', '--force', taskWorktreePath(cwd, taskId)], cwd)
  tryGit(['worktree', 'prune'], cwd)
  if (opts.deleteBranch && branch) {
    tryGit(['branch', '-D', branch], cwd)
  }
}
