// D22 (minimal): best-effort replay of a task's checks on the default branch,
// right after its merge landed. `checks` only ever proved the task branch
// green in ISOLATION; this is the one confirmation that what merged still
// passes once combined with everything else already on the target. Every
// failure mode here — a fetch that cannot reach the remote, a worktree that
// could not be materialized, an engine that vanished mid-run — resolves to
// `null`, NEVER a throw: per TaskEventType's own `post_merge_checks` doc
// (contract/tasks.ts), this replay is news about the default branch, not a
// verdict on the task, and nothing here may strand a caller waiting on it.

import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TaskChecks, TaskRecord } from './contract.js'
import { addDetachedWorktree, removeMrWorktree, underRepoLock } from './ephemeral-worktree.js'
import { git } from './git.js'
import type { ChecksConfig } from './repo-config.js'
import { runChecks, type ExecFn } from './task-checks.js'

/**
 * Same shape as `git()` (git.ts): argv in, stdout out, throws on failure.
 * Injectable so a caller can simulate a fetch that cannot reach the remote —
 * the one operation here that fails for reasons outside this repository —
 * without standing up a broken remote for real.
 */
export type GitExecFn = (args: string[], cwd: string) => string

export type ReplayChecksOptions = {
  /** MAIN repo root: the fetch and the disposable worktree both happen here — the task's own worktree may already be gone by the time its merge lands. */
  cwd: string
  /** Carried for its id (the disposable worktree's name) only; a red replay converting to a ticket is D22's step G, out of this scope. */
  task: TaskRecord
  /** The branch the task merged into (`record.base`). */
  target: string
  config?: ChecksConfig | null
  projectId?: string
  /** Test seam for `runChecks`'s own container exec; the default drives a real docker/podman. */
  execFn?: ExecFn
  /** Test seam for the git calls below; the default runs a real `git`. */
  gitExecFn?: GitExecFn
}

/**
 * Fetches the target, checks it out detached in a throwaway worktree, runs
 * the same checks engine `runChecks` already uses on a task's own branch, and
 * always tears the worktree down. `null` on ANY failure along the way — a
 * repository this replay could not fetch, lock or check out tells nothing
 * about whether the merged code is green, so it is reported as "not
 * evaluated", exactly like `resolveChecksPlan` returning no plan does.
 */
export async function replayChecksOnDefaultBranch(
  opts: ReplayChecksOptions,
): Promise<TaskChecks | null> {
  const gitFn = opts.gitExecFn ?? git
  const worktreeDir = join(
    tmpdir(),
    `codesema-postmerge-${opts.task.id}-${randomBytes(4).toString('hex')}`,
  )

  try {
    gitFn(
      ['fetch', 'origin', `+refs/heads/${opts.target}:refs/remotes/origin/${opts.target}`],
      opts.cwd,
    )
  } catch {
    return null
  }

  try {
    await underRepoLock(opts.cwd, () =>
      addDetachedWorktree(opts.cwd, worktreeDir, `refs/remotes/origin/${opts.target}`),
    )
  } catch {
    return null
  }

  try {
    const resolvedSha = gitFn(['rev-parse', 'HEAD'], worktreeDir)
    return await runChecks({
      worktree: worktreeDir,
      ...(opts.config !== undefined ? { config: opts.config } : {}),
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      headSha: resolvedSha,
      ...(opts.execFn ? { execFn: opts.execFn } : {}),
    })
  } catch {
    return null
  } finally {
    try {
      await underRepoLock(opts.cwd, () => removeMrWorktree(opts.cwd, worktreeDir))
    } catch {
      // Best-effort cleanup: a lock that could not be acquired, or a removal
      // that failed, must not turn a completed (or aborted) replay into a
      // thrown error — `git worktree prune` sweeps orphaned entries later.
    }
  }
}
