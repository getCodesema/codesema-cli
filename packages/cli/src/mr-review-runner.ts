import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listWorktrees } from './branches.js'
import { ensureWorkDir } from './config.js'
import { listOpenMrs, type ForgeMr, type ForgeMrsResult } from './forge-mrs.js'
import { git, refExists, tryGit } from './git.js'
import { prep } from './prep.js'
import { resolvePreviewRefs } from './preview.js'
import { archiveRecord } from './record.js'
import { buildFullReviewPrompt, runDualFlow, runSimpleFlow } from './review.js'
import type { LiveSession } from './serve.js'

export type MrReviewMode = 'simple' | 'dual'
export type MrReviewPhase = 'idle' | 'running' | 'done' | 'error'

export type ReviewSource = { kind: 'mr'; number: number } | { kind: 'branch'; name: string }

export type MrReviewStatus =
  | { available: true; phase: 'idle' }
  | {
      available: true
      phase: 'running'
      source: ReviewSource
      mode: MrReviewMode
      started_at: string
    }
  | { available: true; phase: 'done'; source: ReviewSource; mode: MrReviewMode }
  | { available: true; phase: 'error'; source: ReviewSource; mode: MrReviewMode; error: string }

export type MrReviewStartResult = { ok: true } | { ok: false; code: number; error: string }

export type MrReviewRunner = {
  status: () => MrReviewStatus
  start: (source: ReviewSource, mode: MrReviewMode) => Promise<MrReviewStartResult>
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

/**
 * -B (re)creates the local branch from the freshly fetched remote tip: a stale
 * local branch of the same name, if any, is reset rather than reused. Fails
 * loudly (surfaced as the run error) if that branch name is already checked
 * out in another worktree, which is an acceptable rare edge case.
 */
function addMrWorktree(cwd: string, worktreeDir: string, sourceBranch: string): void {
  git(
    ['worktree', 'add', '-B', sourceBranch, worktreeDir, `refs/remotes/origin/${sourceBranch}`],
    cwd,
  )
}

function addLocalBranchWorktree(cwd: string, worktreeDir: string, branch: string): void {
  git(['worktree', 'add', worktreeDir, branch], cwd)
}

/** A branch already checked out somewhere (the main worktree counts) can't be checked out again in a
 *  second worktree: detach on the same commit instead. */
function addDetachedWorktree(cwd: string, worktreeDir: string, sha: string): void {
  git(['worktree', 'add', '--detach', worktreeDir, sha], cwd)
}

/** Best-effort: a failed cleanup must not turn a completed run into an error. */
function removeMrWorktree(cwd: string, worktreeDir: string): void {
  tryGit(['worktree', 'remove', '--force', worktreeDir], cwd)
  tryGit(['worktree', 'prune'], cwd)
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
}): MrReviewRunner {
  const listMrs = opts.listMrs ?? listOpenMrs

  let phase: MrReviewPhase = 'idle'
  let current: { source: ReviewSource; mode: MrReviewMode; started_at: string } | undefined
  let error: string | undefined

  async function run(resolved: ResolvedSource, mode: MrReviewMode): Promise<void> {
    opts.session.reset()
    opts.session.setAgent(opts.agentCommand)
    opts.session.setMode(mode)

    const label =
      resolved.kind === 'mr' ? `mr-${resolved.mr.number}` : `branch-${slug(resolved.name)}`
    const worktreeDir = join(tmpdir(), `codesema-review-${label}-${randomBytes(4).toString('hex')}`)

    let branchForPrep: string
    let targetForPrep: string

    if (resolved.kind === 'mr') {
      fetchMrBranch(opts.cwd, resolved.mr.sourceBranch)
      addMrWorktree(opts.cwd, worktreeDir, resolved.mr.sourceBranch)
      branchForPrep = resolved.mr.sourceBranch
      targetForPrep = resolved.mr.targetBranch
    } else {
      const refs = await resolvePreviewRefs(opts.cwd, { kind: 'branch', name: resolved.name })
      const alreadyCheckedOut = listWorktrees(opts.cwd).some((wt) => wt.branch === resolved.name)
      if (alreadyCheckedOut) {
        const sha = git(['rev-parse', `refs/heads/${resolved.name}`], opts.cwd)
        addDetachedWorktree(opts.cwd, worktreeDir, sha)
      } else {
        addLocalBranchWorktree(opts.cwd, worktreeDir, resolved.name)
      }
      branchForPrep = resolved.name
      targetForPrep = refs.target
    }

    try {
      const input = prep({
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
      if (phase === 'idle' || current === undefined) {
        return { available: true, phase: 'idle' }
      }
      const { source, mode, started_at } = current
      if (phase === 'running') {
        return { available: true, phase: 'running', source, mode, started_at }
      }
      if (phase === 'done') {
        return { available: true, phase: 'done', source, mode }
      }
      return { available: true, phase: 'error', source, mode, error: error ?? 'unknown error' }
    },
    async start(source, mode) {
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

      // Reserve the runner before the async lookup: a second concurrent
      // start() must hit the 409 above, not slip past it during the await.
      const previousPhase = phase
      phase = 'running'
      current = { source, mode, started_at: new Date().toISOString() }
      error = undefined

      let resolved: ResolvedSource | undefined
      try {
        if (source.kind === 'mr') {
          const mrsResult = await listMrs(opts.cwd)
          const mr = mrsResult.available
            ? mrsResult.mrs.find((m) => m.number === source.number)
            : undefined
          if (mr) {
            resolved = { kind: 'mr', mr }
          }
        } else if (refExists(`refs/heads/${source.name}`, opts.cwd)) {
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

      void run(resolved, mode)
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
