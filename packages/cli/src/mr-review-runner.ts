import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureWorkDir } from './config.js'
import { listOpenMrs, type ForgeMr, type ForgeMrsResult } from './forge-mrs.js'
import { git, tryGit } from './git.js'
import { prep } from './prep.js'
import { archiveRecord } from './record.js'
import { buildFullReviewPrompt, runDualFlow, runSimpleFlow } from './review.js'
import type { LiveSession } from './serve.js'

export type MrReviewMode = 'simple' | 'dual'
export type MrReviewPhase = 'idle' | 'running' | 'done' | 'error'

export type MrReviewStatus =
  | { available: true; phase: 'idle' }
  | { available: true; phase: 'running'; number: number; mode: MrReviewMode; started_at: string }
  | { available: true; phase: 'done'; number: number; mode: MrReviewMode }
  | { available: true; phase: 'error'; number: number; mode: MrReviewMode; error: string }

export type MrReviewStartResult = { ok: true } | { ok: false; code: number; error: string }

export type MrReviewRunner = {
  status: () => MrReviewStatus
  start: (number: number, mode: MrReviewMode) => Promise<MrReviewStartResult>
}

/**
 * Explicit refspec: relying on the default fetch refspec would silently no-op
 * on a shallow clone or a remote configured without the usual
 * `+refs/heads/*:refs/remotes/origin/*`.
 */
function fetchMrBranch(cwd: string, sourceBranch: string): void {
  git(['fetch', 'origin', `+refs/heads/${sourceBranch}:refs/remotes/origin/${sourceBranch}`], cwd)
}

/**
 * -B (re)creates the local branch from the freshly fetched remote tip: a stale
 * local branch of the same name, if any, is reset rather than reused. Fails
 * loudly (surfaced as the run error) if that branch name is already checked
 * out in another worktree, which is an acceptable rare edge case.
 */
function addMrWorktree(cwd: string, worktreeDir: string, sourceBranch: string): void {
  git(['worktree', 'add', '-B', sourceBranch, worktreeDir, `refs/remotes/origin/${sourceBranch}`], cwd)
}

/** Best-effort: a failed cleanup must not turn a completed run into an error. */
function removeMrWorktree(cwd: string, worktreeDir: string): void {
  tryGit(['worktree', 'remove', '--force', worktreeDir], cwd)
  tryGit(['worktree', 'prune'], cwd)
}

export function createMrReviewRunner(opts: {
  cwd: string
  session: LiveSession
  agentCommand: string
  timeoutMs: number
  listMrs?: () => Promise<ForgeMrsResult>
}): MrReviewRunner {
  const listMrs = opts.listMrs ?? (() => listOpenMrs(opts.cwd))

  let phase: MrReviewPhase = 'idle'
  let current: { number: number; mode: MrReviewMode } | undefined
  let startedAt: string | undefined
  let error: string | undefined

  async function run(mr: ForgeMr, mode: MrReviewMode): Promise<void> {
    opts.session.reset()
    opts.session.setAgent(opts.agentCommand)
    opts.session.setMode(mode)

    fetchMrBranch(opts.cwd, mr.sourceBranch)
    const worktreeDir = join(tmpdir(), `codesema-mr-${mr.number}-${randomBytes(4).toString('hex')}`)
    addMrWorktree(opts.cwd, worktreeDir, mr.sourceBranch)
    try {
      const input = prep({ branch: mr.sourceBranch, target: mr.targetBranch, cwd: worktreeDir, quiet: true })
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

      if (!outcome.ok) throw new Error(outcome.message)

      // Archived in the MAIN repo (opts.cwd), never in the disposable worktree:
      // `codesema show` reads .codesema/reviews from the repo the server was started in.
      archiveRecord(outcome.record, opts.cwd)
      opts.session.setDone(outcome.record)
    } finally {
      removeMrWorktree(opts.cwd, worktreeDir)
    }
  }

  return {
    status() {
      if (phase === 'idle') return { available: true, phase: 'idle' }
      if (phase === 'running') {
        return { available: true, phase: 'running', number: current!.number, mode: current!.mode, started_at: startedAt! }
      }
      if (phase === 'done') return { available: true, phase: 'done', number: current!.number, mode: current!.mode }
      return { available: true, phase: 'error', number: current!.number, mode: current!.mode, error: error! }
    },
    async start(number, mode) {
      if (phase === 'running') return { ok: false, code: 409, error: 'a review is already running' }
      if (mode !== 'simple' && mode !== 'dual') return { ok: false, code: 400, error: 'invalid mode' }
      if (!Number.isInteger(number)) return { ok: false, code: 400, error: 'invalid MR number' }

      // Reserve the runner before the async MR lookup: a second concurrent
      // start() must hit the 409 above, not slip past it during the await.
      const previousPhase = phase
      phase = 'running'
      current = { number, mode }
      startedAt = new Date().toISOString()
      error = undefined

      let mr: ForgeMr | undefined
      try {
        const mrsResult = await listMrs()
        mr = mrsResult.available ? mrsResult.mrs.find((m) => m.number === number) : undefined
      } finally {
        if (!mr) phase = previousPhase
      }
      if (!mr) return { ok: false, code: 404, error: `no open MR #${number}` }

      void run(mr, mode)
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
