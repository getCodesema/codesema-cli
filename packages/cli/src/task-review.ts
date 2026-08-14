// Automatic end-of-turn review (T4): after a successful 'done' turn the task
// parks on 'reviewing' and its cumulative diff vs the base gets the exact same
// review pipeline as an MR (prep on the worktree + runSimpleFlow), through a
// dedicated LiveSession that is never wired to the single-review UI — its
// partials are relayed to the task's SSE text channel instead. The verdict
// decides 'review_ok'/'review_ko'; the archived record lands in the MAIN repo
// and "fix the findings" is just a pre-built reply for the next turn.

import { ensureWorkDir } from './config.js'
import { sanitizeRecord, type ReviewRecord, type TaskRecord } from './contract.js'
import { buildAgentFixPrompt } from './fix.js'
import { tryGit } from './git.js'
import { prep } from './prep.js'
import { archiveRecord, readJson } from './record.js'
import {
  buildFullReviewPrompt,
  runDualFlow,
  runSimpleFlow,
  type DualOutcome,
  type SimpleOutcome,
} from './review.js'
import { createSession } from './serve.js'
import type { TaskTurnIo, TaskTurnReviewFn } from './task-runner.js'
import { progressLabel } from './ui.js'

export type TaskReviewMode = 'simple' | 'dual'

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Verdict → task status. 'comment' is a KO only when at least one finding is
 * actionable (same bar as the fix runner's fixable filter): praise/why notes
 * and info-severity remarks alone must not block the ship button.
 */
export function taskReviewVerdict(record: ReviewRecord): 'review_ok' | 'review_ko' {
  const { verdict, findings } = record.review
  if (verdict === 'approve') {
    return 'review_ok'
  }
  if (verdict === 'request_changes') {
    return 'review_ko'
  }
  const actionable = findings.some(
    (f) => f.kind !== 'praise' && f.kind !== 'why' && f.severity !== 'info',
  )
  return actionable ? 'review_ko' : 'review_ok'
}

/**
 * "Fix the findings" as a reply: the returned prompt is meant to be POSTed to
 * /api/tasks/:id/reply as the message of the next turn, reusing the exact
 * prompt the review fix runner sends (buildAgentFixPrompt). Null when the
 * task has no archived review or the archive is gone/corrupt — the caller
 * turns that into a 4xx, never a crash.
 */
export function buildFixTurnPrompt(task: TaskRecord, findingIds: number[]): string | null {
  if (!task.review_ref) {
    return null
  }
  try {
    const review = sanitizeRecord(readJson(task.review_ref))
    return review ? buildAgentFixPrompt(review, findingIds) : null
  } catch {
    return null
  }
}

const settle = (record: TaskRecord, io: TaskTurnIo, status: 'review_ok' | 'review_ko'): void => {
  record.status = status
  io.persist()
}

export type CreateTaskReviewerOptions = {
  /** MAIN repo root: review archives land here, never in the disposable worktree. */
  cwd: string
  /** Raw configured agent command (the review flow applies its own hardening). */
  command: string
  timeoutMs: number
  /** 'simple' (default) or 'dual'; per-task selection is deferred (see plan T4 notes). */
  mode?: TaskReviewMode
  /** Test seams — the defaults run real git/agents. */
  prepFn?: typeof prep
  runSimpleFlowFn?: typeof runSimpleFlow
  runDualFlowFn?: typeof runDualFlow
  archiveRecordFn?: typeof archiveRecord
}

type FlowRunner = (
  opts: CreateTaskReviewerOptions,
  input: ReturnType<typeof prep>,
  io: TaskTurnIo,
) => Promise<SimpleOutcome | DualOutcome>

/**
 * Runs the actual review agent(s) on the prepped worktree input, behind a
 * dedicated session never exposed on /api/status (the single-review UI keeps
 * its own). Partials are forwarded as ephemeral progress lines on the
 * task_text SSE channel — the persisted journal only gets the bounded
 * review_started/review_done/error events.
 */
const runReviewFlow: FlowRunner = async (opts, input, io) => {
  const mode: TaskReviewMode = opts.mode ?? 'simple'
  const runSimple = opts.runSimpleFlowFn ?? runSimpleFlow
  const runDual = opts.runDualFlowFn ?? runDualFlow
  // Review scratch files (input.json, review.json) live in the WORKTREE's
  // .codesema — runSimpleFlow resolves them from input.repo_root.
  const dir = ensureWorkDir(input.repo_root)
  const session = createSession()
  session.setAgent(opts.command)
  session.setMode(mode)
  const unsubscribe = session.subscribe((event) => {
    if (event.name === 'partial' || event.name === 'partial_b') {
      const label = progressLabel(event.data)
      if (label) {
        io.text(label)
      }
    }
  })
  try {
    return mode === 'dual'
      ? await runDual({
          agentCommand: opts.command,
          input,
          dir,
          timeoutMs: opts.timeoutMs,
          session,
          spinner: { update: (status) => io.text(status) },
        })
      : await runSimple({
          agentCommand: opts.command,
          input,
          dir,
          timeoutMs: opts.timeoutMs,
          session,
          prompt: buildFullReviewPrompt(input),
          incremental: false,
        })
  } finally {
    unsubscribe()
  }
}

/**
 * Builds the TaskRunnerOptions.onTurnDone hook. The returned function never
 * rejects: a review failure (agent crash, timeout, unparsable output, prep
 * error) is a 'review_ko' with an explicit error event — the TASK never fails
 * because its review did, the work is committed and reviewable by a human.
 */
export function createTaskReviewer(opts: CreateTaskReviewerOptions): TaskTurnReviewFn {
  const mode: TaskReviewMode = opts.mode ?? 'simple'
  const prepFn = opts.prepFn ?? prep
  const archive = opts.archiveRecordFn ?? archiveRecord

  return async (record, io) => {
    // The runner already persisted 'reviewing' before calling.
    try {
      // Cumulative diff vs the base, not just this turn: earlier turns may
      // have committed work this turn didn't touch. Three dots = merge-base,
      // same range prep reviews. A git failure (null) falls through to prep,
      // whose own error lands on the review_ko path below.
      const changed = tryGit(['diff', '--name-only', `${record.base}...HEAD`], record.worktree)
      if (changed !== null && !changed.trim()) {
        io.emit({ type: 'message', data: { text: 'no changes' } })
        settle(record, io, 'review_ok')
        return
      }

      io.emit({ type: 'review_started', data: { turn: record.turns.length, mode } })
      const input = prepFn({
        branch: record.branch,
        target: record.base,
        cwd: record.worktree,
        quiet: true,
      })
      const outcome = await runReviewFlow(opts, input, io)

      if (!outcome.ok) {
        io.emit({ type: 'error', data: { message: `review failed: ${outcome.message}` } })
        settle(record, io, 'review_ko')
        return
      }

      // Archived in the MAIN repo, never the worktree (same rule as the MR
      // review runner): `codesema show` and buildFixTurnPrompt read archives
      // from the repo the server was started in, and the worktree is
      // disposable.
      record.review_ref = archive(outcome.record, opts.cwd)
      io.emit({
        type: 'review_done',
        data: {
          verdict: outcome.record.review.verdict,
          findings_count: outcome.record.review.findings.length,
        },
      })
      settle(record, io, taskReviewVerdict(outcome.record))
    } catch (err) {
      io.emit({ type: 'error', data: { message: `review failed: ${errorMessage(err)}` } })
      settle(record, io, 'review_ko')
    }
  }
}
