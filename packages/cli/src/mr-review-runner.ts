import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listWorktrees } from './branches.js'
import { ensureWorkDir } from './config.js'
import {
  addDetachedWorktree,
  addLocalBranchWorktree,
  addMrWorktree,
  CLEANUP_LOCK_TIMEOUT_MS,
  removeMrWorktree,
  underRepoLock,
} from './ephemeral-worktree.js'
import { listOpenMrs, type ForgeMr, type ForgeMrsResult } from './forge-mrs.js'
import { git, refExists, type ProbeExecFn } from './git.js'
import { prep } from './prep.js'
import { resolvePreviewRefs } from './preview.js'
import { archiveRecord } from './record.js'
import { buildFullReviewPrompt, runDualFlow, runSimpleFlow } from './review.js'
import type { LiveSession } from './serve.js'
import { acquireWorktreeLock, type WorktreeLockHandle } from './worktree-lock.js'

export type MrReviewMode = 'simple' | 'dual'
export type MrReviewPhase = 'idle' | 'running' | 'done' | 'error'

export type ReviewSource = { kind: 'mr'; number: number } | { kind: 'branch'; name: string }

/**
 * A multi-project workspace shares ONE runner across every registered repo:
 * scope is what points a single start() at one of them instead of the
 * runner's own construction cwd.
 */
export type MrReviewScope = { projectId: string | null; cwd: string }

/**
 * `project_id` rides every non-idle phase: two projects can each have their
 * own MR #7, and a status with no project attached would make them
 * indistinguishable to a client polling this single, shared runner.
 */
export type MrReviewStatus =
  | { available: true; phase: 'idle' }
  | {
      available: true
      phase: 'running'
      project_id: string | null
      source: ReviewSource
      mode: MrReviewMode
      started_at: string
    }
  | {
      available: true
      phase: 'done'
      project_id: string | null
      source: ReviewSource
      mode: MrReviewMode
    }
  | {
      available: true
      phase: 'error'
      project_id: string | null
      source: ReviewSource
      mode: MrReviewMode
      error: string
    }

export type MrReviewStartResult = { ok: true } | { ok: false; code: number; error: string }

export type MrReviewRunner = {
  status: () => MrReviewStatus
  /** No `scope`: today's behavior, the runner's own construction cwd and a null project_id. */
  start: (
    source: ReviewSource,
    mode: MrReviewMode,
    scope?: MrReviewScope,
  ) => Promise<MrReviewStartResult>
}

type ResolvedSource = { kind: 'mr'; mr: ForgeMr } | { kind: 'branch'; name: string }

/**
 * Explicit refspec: relying on the default fetch refspec would silently no-op
 * on a shallow clone or a remote configured without the usual
 * `+refs/heads/*:refs/remotes/origin/*`.
 */
function fetchMrBranch(cwd: string, sourceBranch: string): void {
  git(['fetch', 'origin', `+refs/heads/${sourceBranch}:refs/remotes/origin/${sourceBranch}`], cwd)
}

function slug(name: string): string {
  return name.replace(/[^a-zA-Z0-9-]+/g, '-')
}

export function createMrReviewRunner(opts: {
  cwd: string
  session: LiveSession
  agentCommand: string
  timeoutMs: number
  listMrs?: (cwd: string) => Promise<ForgeMrsResult>
  /**
   * Forge probe behind the branch target detection (see preview.ts). The same
   * seam as everywhere else in the repo: no test runs a real gh/glab, and a
   * caller that omits it gets the real probe.
   */
  execFn?: ProbeExecFn
  /**
   * Aborted when the process is draining. Only the CLEANUP acquisition honors
   * it: a review already under way keeps its worktree until it settles, but
   * nothing on the exit path should queue behind a repo lock.
   */
  shutdownSignal?: AbortSignal
}): MrReviewRunner {
  const listMrs = opts.listMrs ?? listOpenMrs

  let phase: MrReviewPhase = 'idle'
  let current:
    | { source: ReviewSource; mode: MrReviewMode; started_at: string; projectId: string | null }
    | undefined
  let error: string | undefined

  async function run(resolved: ResolvedSource, mode: MrReviewMode, cwd: string): Promise<void> {
    opts.session.reset()
    opts.session.setAgent(opts.agentCommand)
    opts.session.setMode(mode)

    const label =
      resolved.kind === 'mr' ? `mr-${resolved.mr.number}` : `branch-${slug(resolved.name)}`
    const worktreeDir = join(tmpdir(), `codesema-review-${label}-${randomBytes(4).toString('hex')}`)

    let branchForPrep: string
    let targetForPrep: string

    if (resolved.kind === 'mr') {
      fetchMrBranch(cwd, resolved.mr.sourceBranch)
      await underRepoLock(cwd, () => addMrWorktree(cwd, worktreeDir, resolved.mr.sourceBranch))
      branchForPrep = resolved.mr.sourceBranch
      targetForPrep = resolved.mr.targetBranch
    } else {
      const refs = await resolvePreviewRefs(
        cwd,
        { kind: 'branch', name: resolved.name },
        { execFn: opts.execFn },
      )
      await underRepoLock(cwd, () => {
        // Both the "is it checked out" probe and the add write/read the same
        // registry: they belong INSIDE the lock, or the answer can go stale
        // between them.
        const alreadyCheckedOut = listWorktrees(cwd).some((wt) => wt.branch === resolved.name)
        if (alreadyCheckedOut) {
          const sha = git(['rev-parse', `refs/heads/${resolved.name}`], cwd)
          addDetachedWorktree(cwd, worktreeDir, sha)
        } else {
          addLocalBranchWorktree(cwd, worktreeDir, resolved.name)
        }
      })
      branchForPrep = resolved.name
      targetForPrep = refs.target
    }

    try {
      const input = await prep({
        branch: branchForPrep,
        target: targetForPrep,
        cwd: worktreeDir,
        quiet: true,
      })
      const additions = input.files.reduce((n, f) => n + f.additions, 0)
      const deletions = input.files.reduce((n, f) => n + f.deletions, 0)
      opts.session.setInput({
        branch: input.branch,
        target: input.target,
        commits: input.commits,
        files: input.files,
        additions,
        deletions,
        incremental: false,
      })
      const dir = ensureWorkDir(input.repo_root)

      const outcome =
        mode === 'dual'
          ? await runDualFlow({
              agentCommand: opts.agentCommand,
              input,
              dir,
              timeoutMs: opts.timeoutMs,
              session: opts.session,
              spinner: { update: () => {} },
            })
          : await runSimpleFlow({
              agentCommand: opts.agentCommand,
              input,
              dir,
              timeoutMs: opts.timeoutMs,
              session: opts.session,
              prompt: buildFullReviewPrompt(input),
              incremental: false,
            })

      if (!outcome.ok) {
        throw new Error(outcome.message)
      }

      // Archived in the TARGET repo (`cwd`), never in the disposable worktree:
      // `codesema show` reads .codesema/reviews from the repo the server was started in.
      archiveRecord(outcome.record, cwd)
      opts.session.setDone(outcome.record)
    } finally {
      // A cleanup path must never mask the outcome it is cleaning up after, so
      // this acquisition is total: if the lock cannot be had, the removal
      // still happens (git's own index lock remains the net) rather than throw
      // out of a `finally` and replace the run's real error with a lock story.
      // Bounded, and abandoned at once when the process is shutting down: this
      // wait sits between the user and the exit.
      let lock: WorktreeLockHandle | null = null
      try {
        lock = await acquireWorktreeLock(cwd, {
          timeoutMs: CLEANUP_LOCK_TIMEOUT_MS,
          ...(opts.shutdownSignal ? { signal: opts.shutdownSignal } : {}),
        })
      } catch {
        lock = null
      }
      try {
        removeMrWorktree(cwd, worktreeDir)
      } finally {
        lock?.release()
      }
    }
  }

  return {
    status() {
      if (phase === 'idle' || current === undefined) {
        return { available: true, phase: 'idle' }
      }
      const { source, mode, started_at, projectId } = current
      if (phase === 'running') {
        return {
          available: true,
          phase: 'running',
          project_id: projectId,
          source,
          mode,
          started_at,
        }
      }
      if (phase === 'done') {
        return { available: true, phase: 'done', project_id: projectId, source, mode }
      }
      return {
        available: true,
        phase: 'error',
        project_id: projectId,
        source,
        mode,
        error: error ?? 'unknown error',
      }
    },
    async start(source, mode, scope) {
      if (phase === 'running') {
        return { ok: false, code: 409, error: 'a review is already running' }
      }
      if (mode !== 'simple' && mode !== 'dual') {
        return { ok: false, code: 400, error: 'invalid mode' }
      }
      if (source.kind === 'mr' && !Number.isInteger(source.number)) {
        return { ok: false, code: 400, error: 'invalid MR number' }
      }
      if (source.kind === 'branch' && (!source.name || source.name.startsWith('-'))) {
        return { ok: false, code: 400, error: 'invalid branch name' }
      }

      const cwd = scope?.cwd ?? opts.cwd

      // Reserve the runner before the async lookup: a second concurrent
      // start() must hit the 409 above, not slip past it during the await.
      const previousPhase = phase
      phase = 'running'
      current = {
        source,
        mode,
        started_at: new Date().toISOString(),
        projectId: scope?.projectId ?? null,
      }
      error = undefined

      let resolved: ResolvedSource | undefined
      try {
        if (source.kind === 'mr') {
          const mrsResult = await listMrs(cwd)
          const mr = mrsResult.available
            ? mrsResult.mrs.find((m) => m.number === source.number)
            : undefined
          if (mr) {
            resolved = { kind: 'mr', mr }
          }
        } else if (refExists(`refs/heads/${source.name}`, cwd)) {
          resolved = { kind: 'branch', name: source.name }
        }
      } finally {
        if (!resolved) {
          phase = previousPhase
        }
      }
      if (!resolved) {
        const notFound =
          source.kind === 'mr' ? `no open MR #${source.number}` : `branch not found: ${source.name}`
        return { ok: false, code: 404, error: notFound }
      }

      void run(resolved, mode, cwd)
        .then(() => {
          phase = 'done'
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          error = message
          phase = 'error'
          opts.session.setError(message)
        })

      return { ok: true }
    },
  }
}
