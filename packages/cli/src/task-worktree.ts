// Git worktree lifecycle for agent tasks: one worktree + one branch per task,
// kept under <repo>/.codesema/worktrees/<task-id>/ (NOT a tmpdir like the MR
// review worktrees) so an interrupted task survives a reboot and can be
// resumed. The parent .codesema/ directory auto-gitignores itself.

import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ensureWorkDir } from './config.js'
import { git, refExists, tryGit } from './git.js'
import { t } from './i18n.js'
import { resolveRef, targetFromOriginHead } from './prep.js'

/** Same candidates and order as prep's target detection heuristic. */
const BASE_CANDIDATES = ['develop', 'main', 'master'] as const

export function taskWorktreePath(cwd: string, taskId: string): string {
  return join(cwd, '.codesema', 'worktrees', taskId)
}

/** Same slugging as review archive names (record.ts), with 'task' as last resort. */
function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'task'
  )
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
    return fromHead.target
  }
  for (const name of BASE_CANDIDATES) {
    const ref = resolveRef(name, cwd)
    if (ref) {
      return ref
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
 * Creates the task's branch from the detected base and checks it out in a
 * fresh worktree. -b always creates a NEW branch (collisions get a numeric
 * suffix), so this never steals a branch checked out elsewhere.
 */
export function createTaskWorktree(cwd: string, taskId: string, title: string): TaskWorktree {
  // .codesema/ must exist self-gitignored before git materializes anything in it.
  ensureWorkDir(cwd)
  mkdirSync(join(cwd, '.codesema', 'worktrees'), { recursive: true })
  const base = detectTaskBase(cwd)
  const branch = freeBranchName(cwd, taskId, title)
  const worktree = taskWorktreePath(cwd, taskId)
  if (existsSync(worktree)) {
    // A stale directory (crashed run, aborted creation) would fail the add.
    tryGit(['worktree', 'remove', '--force', worktree], cwd)
    tryGit(['worktree', 'prune'], cwd)
  }
  git(['worktree', 'add', '-b', branch, worktree, base], cwd)
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
