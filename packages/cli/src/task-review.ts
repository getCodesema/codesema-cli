// Automatic end-of-turn review (T4): after a successful 'done' turn the task
// parks on 'reviewing' and its cumulative diff vs the base gets the exact same
// review pipeline as an MR (prep on the worktree + runSimpleFlow), through a
// dedicated LiveSession that is never wired to the single-review UI — its
// partials are relayed to the task's SSE text channel instead. The verdict
// decides 'review_ok'/'review_ko'; the archived record lands in the MAIN repo
// and "fix the findings" is just a pre-built reply for the next turn. The
// archive of each turn travels on its review_done event ('ref') and is served
// back by GET /api/tasks/:id/review (readTaskReview), so a conversation can
// open the review of ANY of its turns, not just the last one.

import { join, resolve, sep } from 'node:path'
import { ensureWorkDir } from './config.js'
import { sanitizeRecord, type Finding, type ReviewRecord, type TaskRecord } from './contract.js'
import { buildAgentFixPrompt } from './fix.js'
import { isAncestor, refExists, tryGit } from './git.js'
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
import { loadTask, taskReason } from './tasks-store.js'
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

/**
 * An archive path is servable only when it lands INSIDE the project's
 * .codesema/reviews: a `ref` comes from the client (the review_done event it
 * read), so it is resolved against that directory and rejected the moment it
 * escapes it — a relative "../../" or an absolute path elsewhere never reads.
 */
function archiveInProject(cwd: string, ref: string): string | null {
  const dir = resolve(join(cwd, '.codesema', 'reviews'))
  const path = resolve(dir, ref)
  return path.startsWith(`${dir}${sep}`) ? path : null
}

/**
 * The archived review of ONE task, for GET /api/tasks/:id/review. `ref` (the
 * archive path a review_done event carries) opens the review of THAT turn;
 * without one — or when it points outside the project's reviews directory —
 * the task's current review_ref is served. Null on every miss (no review yet,
 * pruned archive, corrupt file): the route turns that into a 404, never a
 * crash. Same tolerance as buildFixTurnPrompt.
 */
export function readTaskReview(
  cwd: string,
  id: string,
  ref?: string | null | undefined,
): ReviewRecord | null {
  const task = loadTask(cwd, id)
  if (!task) {
    return null
  }
  const path = ref ? archiveInProject(cwd, ref) : task.review_ref
  if (!path) {
    return null
  }
  try {
    return sanitizeRecord(readJson(path))
  } catch {
    return null
  }
}

/**
 * Per-severity tally of a review's findings, as FLAT scalar event keys
 * ('severity_major': 2) — the journal payload stays a bounded record of
 * scalars. Empty severities are omitted: the card renders what the review
 * actually raised, and the payload keeps room under the key cap.
 */
export function findingSeverityCounts(findings: readonly Finding[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const finding of findings) {
    const key = `severity_${finding.severity}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/**
 * Final transition of the automatic review. A KO states WHY in the record —
 * the code plus the producer's own message in `detail` — while an OK clears
 * any reason a previous turn left behind: a record that passed its review must
 * not keep claiming the one that blocked it.
 */
const settle = (
  record: TaskRecord,
  io: TaskTurnIo,
  status: 'review_ok' | 'review_ko',
  reason?: string,
): void => {
  record.status = status
  if (status === 'review_ko') {
    record.reason = taskReason('review_blocked', reason)
  } else {
    delete record.reason
  }
  io.persist()
}

/**
 * Why this review cannot measure from the task's baseline, or null when it
 * can. Three distinct failures, three distinct sentences — "no anchor was ever
 * recorded" and "the anchor was rebased away" call for different reactions
 * from whoever reads the journal.
 *
 * The ancestor check is what makes the range trustworthy: `baseline..HEAD`
 * whose left side is no longer behind HEAD measures nothing useful (a rebase
 * turns it into a diff against a commit that is not in this history at all).
 */
export function baselineFallbackReason(record: TaskRecord): string | null {
  const sha = record.baseline_sha
  if (!sha) {
    return 'no baseline commit was recorded for this task'
  }
  // '^{commit}' is what makes this a real existence check: `rev-parse --verify`
  // alone accepts any well-formed 40-hex string, object or not.
  if (!refExists(`${sha}^{commit}`, record.worktree)) {
    return `baseline ${sha.slice(0, 12)} is not reachable from this worktree`
  }
  if (!isAncestor(sha, 'HEAD', record.worktree)) {
    return `baseline ${sha.slice(0, 12)} is no longer an ancestor of HEAD (rebased?)`
  }
  return null
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
  input: Awaited<ReturnType<typeof prep>>,
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
    //
    // `record` is held across the whole flow (prep + agent, minutes) before
    // io.persist() writes it back — one of the four snapshot-across-an-await
    // sites listed in task-runner.ts. Valid by EXCLUSION: the task sits on
    // 'reviewing' throughout, and every action refuses that status (start,
    // reply, resume and interrupt through `active`, abandon and ship on the
    // status itself). Nothing else writes this record meanwhile.
    try {
      // Everything the agent did in this conversation and nothing else: the
      // baseline commit holds whatever the repo was carrying when the worktree
      // was created, so `baseline..HEAD` is exactly the work. Cumulative, not
      // per-turn: earlier turns may have committed work this one didn't touch.
      //
      // Without a usable baseline the range falls back to `base...HEAD`:
      // three dots, merge-base, exactly what it always was — which on a
      // work-on conversation also re-reviews the commits that predated it.
      // That degradation is SAID, not swallowed.
      const fallback = baselineFallbackReason(record)
      if (fallback) {
        io.emit({
          type: 'message',
          data: {
            text: `${fallback}: reviewing ${record.base}...HEAD, which also covers work that predates this conversation`,
          },
        })
      }
      const baseline = fallback ? null : (record.baseline_sha ?? null)
      const range = baseline ? `${baseline}..HEAD` : `${record.base}...HEAD`
      // A git failure (null) falls through to prep, whose own error lands on
      // the review_ko path below.
      const changed = tryGit(['diff', '--name-only', range], record.worktree)
      if (changed !== null && !changed.trim()) {
        io.emit({ type: 'message', data: { text: 'no changes' } })
        settle(record, io, 'review_ok')
        return
      }

      io.emit({ type: 'review_started', data: { turn: record.turns.length, mode } })
      const input = await prepFn({
        branch: record.branch,
        // IDENTITY stays the branch this work is headed for: it is what the
        // review is titled and archived under, and what findPreviousReview
        // matches on to keep re-reviews incremental. Only the SCOPE moves.
        target: record.base,
        ...(baseline ? { baseline } : {}),
        cwd: record.worktree,
        quiet: true,
      })
      const outcome = await runReviewFlow(opts, input, io)

      if (!outcome.ok) {
        // The event keeps its message untouched and gains the code beside it;
        // the record repeats that same message in reason.detail.
        const message = `review failed: ${outcome.message}`
        io.emit({ type: 'error', data: { message }, reason_code: 'review_blocked' })
        settle(record, io, 'review_ko', message)
        return
      }

      // Archived in the MAIN repo, never the worktree (same rule as the MR
      // review runner): `codesema show` and buildFixTurnPrompt read archives
      // from the repo the server was started in, and the worktree is
      // disposable.
      record.review_ref = archive(outcome.record, opts.cwd)
      // The payload is what the conversation card renders WITHOUT re-reading
      // the archive: verdict, count, the summary line, the severity spread —
      // plus 'ref', the archive of THIS turn, so an old card still opens its
      // own review once later turns moved record.review_ref on.
      const summary = outcome.record.review.summary.trim()
      io.emit({
        type: 'review_done',
        data: {
          verdict: outcome.record.review.verdict,
          findings_count: outcome.record.review.findings.length,
          ref: record.review_ref,
          ...(summary ? { summary } : {}),
          ...findingSeverityCounts(outcome.record.review.findings),
        },
      })
      settle(record, io, taskReviewVerdict(outcome.record))
    } catch (err) {
      const message = `review failed: ${errorMessage(err)}`
      io.emit({ type: 'error', data: { message }, reason_code: 'review_blocked' })
      settle(record, io, 'review_ko', message)
    }
  }
}
