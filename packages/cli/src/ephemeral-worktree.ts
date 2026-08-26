// Disposable git worktree primitives shared by every codesema flow that needs
// to inspect a ref OUTSIDE the process's own working tree without disturbing
// it: an MR/branch review (mr-review-runner.ts) and a post-merge checks
// replay (task-post-merge-checks.ts) both check out a throwaway worktree in a
// tmpdir, do their work, and tear it down — never the main repository's own
// checkout.

import { git, tryGit } from './git.js'
import { acquireWorktreeLock } from './worktree-lock.js'

/**
 * -B (re)creates the local branch from the freshly fetched remote tip: a stale
 * local branch of the same name, if any, is reset rather than reused. Fails
 * loudly (surfaced as the run error) if that branch name is already checked
 * out in another worktree, which is an acceptable rare edge case.
 */
export function addMrWorktree(cwd: string, worktreeDir: string, sourceBranch: string): void {
  git(
    ['worktree', 'add', '-B', sourceBranch, worktreeDir, `refs/remotes/origin/${sourceBranch}`],
    cwd,
  )
}

export function addLocalBranchWorktree(cwd: string, worktreeDir: string, branch: string): void {
  git(['worktree', 'add', worktreeDir, branch], cwd)
}

/** A branch already checked out somewhere (the main worktree counts) can't be checked out again in a
 *  second worktree: detach on the same commit instead. */
export function addDetachedWorktree(cwd: string, worktreeDir: string, sha: string): void {
  git(['worktree', 'add', '--detach', worktreeDir, sha], cwd)
}

/** Best-effort: a failed cleanup must not turn a completed run into an error. */
export function removeMrWorktree(cwd: string, worktreeDir: string): void {
  tryGit(['worktree', 'remove', '--force', worktreeDir], cwd)
  tryGit(['worktree', 'prune'], cwd)
}

/**
 * What the CLEANUP acquisition is willing to wait, as opposed to the full
 * budget the work itself gets. A cleanup runs on the way out — often on the way
 * out of the process — and the removal is safe without the lock anyway (git's
 * own index lock remains the net). Waiting the full minute-plus here would hold
 * a Ctrl-C hostage to a lock that changes nothing about the outcome.
 */
export const CLEANUP_LOCK_TIMEOUT_MS = 2_000

/**
 * A disposable worktree lives in a tmpdir, but `git worktree add/remove`
 * still writes the REPOSITORY's index and its .git/worktrees registry — the
 * very thing the repo lock serializes. So every caller here takes it too,
 * exactly like task worktrees do.
 *
 * Only the add and the remove are held, never the work in between: a review
 * or a checks run takes minutes, and holding a repo-wide lock for that long
 * would block every task in the workspace. The lock protects the git
 * operations, not the work.
 */
export async function underRepoLock<T>(cwd: string, fn: () => T): Promise<T> {
  const lock = await acquireWorktreeLock(cwd)
  try {
    return fn()
  } finally {
    lock.release()
  }
}
