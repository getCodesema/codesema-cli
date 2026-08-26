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

import { ensureWorkDir, type ReviewMode } from './config.js'
import {
  sanitizeRecord,
  type ArmTransition,
  type Finding,
  type ReviewRecord,
  type TaskChecks,
  type TaskReason,
  type TaskRecord,
} from './contract.js'
import { buildAgentFixPrompt, isFixable } from './fix.js'
import { isAncestor, refExists, tryGit } from './git.js'
import { createLoadCap, DEFAULT_MAX_CONCURRENT_AGENTS, type LoadCap } from './load-cap.js'
import { prep } from './prep.js'
import { archiveRecord, readJson, resolveArchivePath } from './record.js'
import {
  buildFullReviewPrompt,
  runDualFlow,
  runSimpleFlow,
  type DualOutcome,
  type SimpleOutcome,
} from './review.js'
import { createSession } from './serve.js'
import { autoPushReview } from './sync.js'
import { reportBrainTransition } from './task-brain.js'
import {
  buildCriteriaChapter,
  criteriaGateWaivable,
  criteriaUnmetDetail,
  resolveCriteria,
  unmetCriteriaFixChapter,
  type CriteriaOutcome,
} from './task-criteria-gate.js'
import {
  REVIEW_CUT_DETAIL,
  taskCriteria,
  type TaskTurnIo,
  type TaskTurnReviewFn,
} from './task-runner.js'
import { loadTask, taskReason } from './tasks-store.js'
import { progressLabel } from './ui.js'

/**
 * Alias, not a second declaration: the enum lives in config.ts, which is where
 * the value is resolved from (T3.2). Kept exported under this name because it
 * is what `CreateTaskReviewerOptions` and serve.ts's session speak.
 */
export type TaskReviewMode = ReviewMode

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
  // D25: the bar that BLOCKS a 'comment' is critical/major only, while the
  // bar that PROPOSES a fix stays `isFixable` (fix.ts) untouched. A lone
  // minor used to flip 'comment' to review_ko, which made the D18 waiver
  // (gated on review_ok) structurally unreachable and looped a task for
  // turns; a minor now ships as an MR finding instead of blocking.
  return findings.some((finding) => isFixable(finding) && isBlockingSeverity(finding.severity))
    ? 'review_ko'
    : 'review_ok'
}

/**
 * Severities that make a finding BLOCKING whatever the model concluded — the
 * deterministic half of T3.3's guard-rail (invariant n° 4). `critical` is
 * already escalated by the contract's `groundReview`, but only when the diff
 * could be indexed; `major` never was.
 */
const BLOCKING_SEVERITIES = ['critical', 'major'] as const

const isBlockingSeverity = (severity: Finding['severity']): boolean =>
  (BLOCKING_SEVERITIES as readonly string[]).includes(severity)

/**
 * Whether a review still carries a finding no `approve` may override: a
 * `critical` or `major` one that asks for a code change (T3.3). "Unresolved"
 * needs no bookkeeping — a finding a later review no longer raises is
 * resolved, so the LAST archive is the whole state.
 *
 * Composed, deliberately, from the two bricks that already exist — `isFixable`
 * for "does this ask for a change" and `findingSeverityCounts` for the tally —
 * rather than a second severity scale of its own: two definitions of
 * "blocking" drift in silence, and the merge gate downstream (T3.6) reads
 * THIS one.
 */
export function hasBlockingFindings(record: ReviewRecord): boolean {
  const counts = findingSeverityCounts(record.review.findings.filter(isFixable))
  return BLOCKING_SEVERITIES.some((severity) => (counts[`severity_${severity}`] ?? 0) > 0)
}

/**
 * Why an `approve` was not enough, with the exact tally beside it. ADDED to
 * what the reviewer itself said, never a replacement for it (invariant n° 2).
 */
export function blockingFindingsDetail(record: ReviewRecord): string {
  const counts = findingSeverityCounts(record.review.findings.filter(isFixable))
  const named = BLOCKING_SEVERITIES.filter(
    (severity) => (counts[`severity_${severity}`] ?? 0) > 0,
  ).map((severity) => `${counts[`severity_${severity}`] as number} ${severity}`)
  return `the review verdict was '${record.review.verdict}' but the review still carries blocking findings (${named.join(', ')}): a model verdict never releases an unresolved critical or major finding`
}

/**
 * Indices of the findings a fix turn is asked to apply, in the archive's own
 * order — the same bar `taskReviewVerdict` blocks on, so an automatic round
 * never asks for less than what blocked it.
 */
export function actionableFindingIds(record: ReviewRecord): number[] {
  return record.review.findings.flatMap((finding, index) => (isFixable(finding) ? [index] : []))
}

/** The archived review a task's `review_ref` points at, or null on every miss. */
function readReviewRef(task: TaskRecord): ReviewRecord | null {
  if (!task.review_ref) {
    return null
  }
  try {
    return sanitizeRecord(readJson(task.review_ref))
  } catch {
    return null
  }
}

/**
 * "Fix the findings" as a reply: the returned prompt is meant to be POSTed to
 * /api/tasks/:id/reply as the message of the next turn, reusing the exact
 * prompt the review fix runner sends (buildAgentFixPrompt). Null when the
 * task has no archived review or the archive is gone/corrupt — the caller
 * turns that into a 4xx, never a crash.
 */
export function buildFixTurnPrompt(task: TaskRecord, findingIds: number[]): string | null {
  const review = readReviewRef(task)
  return review ? buildAgentFixPrompt(review, findingIds) : null
}

/**
 * The prompt of an AUTOMATIC fix turn (T3.3). It IS the manual path's prompt —
 * `buildAgentFixPrompt` on the same archive, through the same helper the click
 * uses — with the two differences that automating it requires:
 *
 *  - the findings are not a human's selection but every ACTIONABLE one, which
 *    is exactly the set that made the review block. Asking for less would
 *    guarantee the next review blocks on the remainder and burns a round;
 *  - a criteria chapter is appended when the acceptance-criteria gate is what
 *    blocks, because a review that approved the code raises no finding at all.
 *
 * Null when there is nothing concrete to ask for — no archive, an unreadable
 * one, or an archive carrying neither an actionable finding nor an unsatisfied
 * criterion. That null is a REFUSAL to spend a round, never an empty prompt.
 */
export function buildAutoFixTurnPrompt(task: TaskRecord): string | null {
  const review = readReviewRef(task)
  if (!review) {
    return null
  }
  const ids = actionableFindingIds(review)
  const chapter = unmetCriteriaFixChapter(taskCriteria(task), review.review.criteria)
  if (ids.length === 0 && !chapter) {
    return null
  }
  const base = buildAgentFixPrompt(review, ids)
  return chapter ? `${base}\n\n${chapter}` : base
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
  const path = ref ? resolveArchivePath(cwd, ref) : task.review_ref
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
 * The same sentence the runner journals on a machine-cap wait (task-runner.ts
 * `MACHINE_LOAD_DETAIL`). Copied rather than imported: T3.1 must not touch
 * that file. The web tells the two `resource_busy` motifs apart on this
 * exact string, so a wording drift here would lie in the queue pill.
 */
const LOAD_CAP_WAIT_DETAIL =
  'the machine-wide load cap (maxConcurrentAgents) has no free slot for a turn, a review or a checks run'

/**
 * A checks snapshot the gate may read: `running` is never a result, so it
 * is treated as "no result yet" rather than as a pass or a fail.
 */
export function terminalChecksResult(checks: TaskChecks | null | undefined): TaskChecks | null {
  return checks && checks.status !== 'running' ? checks : null
}

/**
 * Whether a finished checks run blocks the "ready to merge" state. `running`
 * is never a result — the caller waits — and `error`/`unconfigured` are named
 * degradations that must not be mistaken for a red run.
 */
export function checksBlockReady(checks: TaskChecks | null | undefined): boolean {
  if (!checks || checks.status === 'running' || checks.status === 'error') {
    return false
  }
  if (checks.status === 'unconfigured') {
    return false
  }
  if (checks.status === 'failed') {
    return true
  }
  // Spec: an individual `timeout` blocks even when the run was not labelled
  // `failed` (runChecks itself folds timeout into `failed`; this is the
  // defensive reading of a hand-edited or older snapshot).
  return checks.checks.some((check) => check.status === 'timeout')
}

/** Readable message the `checks_failed` code is ADDED to, never a replacement. */
export function checksFailedDetail(checks: TaskChecks): string {
  const timedOut = checks.checks.filter((check) => check.status === 'timeout').map((c) => c.command)
  const failed = checks.checks.filter((check) => check.status === 'failed').map((c) => c.command)
  if (failed.length > 0 && timedOut.length > 0) {
    return `repository checks failed (${failed.join(', ')}; timed out: ${timedOut.join(', ')})`
  }
  if (timedOut.length > 0) {
    return `repository checks timed out (${timedOut.join(', ')})`
  }
  if (failed.length > 0) {
    return `repository checks failed (${failed.join(', ')})`
  }
  return 'repository checks failed'
}

/**
 * Folds a finished checks run into the reviewer's persist. The reviewer stays
 * the unique writer of `review_ok`/`review_ko`: this mutates the in-memory
 * record *before* `io.persist()`, so a settle OK never lands on disk only to
 * be overwritten. `running` is ignored. `error`/`unconfigured` are stamped
 * on the record (so they are said) and never block.
 */
export function applyChecksGate(record: TaskRecord, checks: TaskChecks | null | undefined): void {
  if (checks && checks.status !== 'running') {
    record.checks_status = checks.status
  }
  if (record.status !== 'review_ok' || !checks || !checksBlockReady(checks)) {
    return
  }
  record.status = 'review_ko'
  record.reason = taskReason('checks_failed', checksFailedDetail(checks))
}

/**
 * The arm/brain fact a settled turn reports, decided from what the turn
 * actually produced rather than from `status` alone. `status: 'review_ko'`
 * covers two different situations, and the brain must not read them as the
 * same fact:
 *
 *  - a `reviewOutcome` is present: a reviewer ran and returned a verdict,
 *    later possibly overridden to KO by a deterministic guard-rail (a
 *    blocking finding, an unmet criterion). A real verdict was produced, so
 *    this is `review_result`.
 *  - no `reviewOutcome`: the review FLOW itself failed (a bad agent
 *    response, an exception) or never ran to a verdict at all. Reporting
 *    `review_result / request_changes` here would be indistinguishable from
 *    a reviewer that actually looked at the work and rejected it. This is
 *    `failed`, the same fact `settleInterrupted` already reports for a
 *    shutdown mid-review.
 *
 * Pure and exported so this distinction is tested directly, with no fetch or
 * outbox to mock.
 */
export function brainSettleTransition(opts: {
  status: 'review_ok' | 'review_ko'
  reviewOutcome?: ReviewRecord
  reason?: TaskReason
  costTicks?: number
}): Omit<ArmTransition, 'idempotency_key' | 'at'> {
  if (opts.status === 'review_ko' && !opts.reviewOutcome) {
    return {
      type: 'failed',
      ...(opts.reason?.detail ? { error_message: opts.reason.detail } : {}),
    }
  }
  return {
    type: 'review_result',
    verdict: opts.status === 'review_ok' ? 'approve' : 'request_changes',
    ...(opts.reviewOutcome ? { findings_total: opts.reviewOutcome.review.findings.length } : {}),
    ...(opts.costTicks !== undefined ? { cost_ticks: opts.costTicks } : {}),
  }
}

/**
 * Final transition of the automatic review, and its ONLY owner. A KO states
 * WHY in the record — the code plus the producer's own message in `detail` —
 * while an OK clears any reason a previous turn left behind: a record that
 * passed its review must not keep claiming the one that blocked it.
 *
 * `code` is what the KO is called. `review_blocked` is the reviewer's own
 * verdict or its own failure; `criteria_unmet` (T3.2) is the acceptance-criteria
 * gate, which blocks a review the reviewer itself approved — routing it
 * through this same function is what keeps a single writer of the final
 * transition, rather than a second one that would have to re-decide the
 * persist.
 *
 * The persist the caller wraps (task-server's onTurnDone) folds the checks
 * gate into THIS write, so a red run never becomes `review_ok` even for a
 * millisecond on the wire.
 */
const settle = (
  record: TaskRecord,
  io: TaskTurnIo,
  status: 'review_ok' | 'review_ko',
  opts: {
    /** MAIN repo root: only used for the arm/brain report below, never for I/O on `record` itself. */
    cwd: string
    /** Why a KO blocks; defaults to a bare `review_blocked`. Ignored on an OK. */
    blocked?: TaskReason
    /** The review that just settled, when one ran (absent on a flow failure). Read for `findings_total` only. */
    reviewOutcome?: ReviewRecord
  },
): void => {
  record.status = status
  if (status === 'review_ko') {
    record.reason = opts.blocked ?? taskReason('review_blocked')
  } else {
    delete record.reason
  }
  io.persist()
  // Arm/brain integration: reported AFTER the persist, never instead of it,
  // same discipline as every other fire-and-forget effect a settled turn
  // triggers (task-labels.ts's cycle label). Never awaited: a brain round
  // trip must not hold up the turn this settle ends.
  if (record.brain_ticket) {
    void reportBrainTransition(
      opts.cwd,
      record,
      brainSettleTransition({
        status,
        ...(opts.reviewOutcome ? { reviewOutcome: opts.reviewOutcome } : {}),
        ...(record.reason ? { reason: record.reason } : {}),
        ...(record.cost_ticks !== undefined ? { costTicks: record.cost_ticks } : {}),
      }),
    )
    if (opts.reviewOutcome) {
      void autoPushReview(opts.reviewOutcome, opts.cwd)
    }
  }
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

/**
 * The journal line of the acceptance-criteria gate (T3.2), on the DP9 pattern
 * the `criteria` type already follows: the TYPE names the domain, `data.name`
 * names the incident. Two of them, and both are said out loud — a gate that
 * only spoke when it blocked would leave a human unable to tell "every
 * criterion was met" from "no gate ever ran".
 *
 * `criteria_unmet` rides on the BLOCKING one only, in its own `reason_code`
 * field, beside the counts rather than instead of them (invariant n° 2: the
 * code is ADDED to the readable payload, and the record's `reason.detail`
 * repeats the same sentence the human reads).
 *
 * No message string is put in `data`: this event's summary is rendered from
 * `data.name` through the web's own translated key, so a sentence built here
 * would either be ignored or served to a French UI in English.
 */
const emitCriteriaGate = (io: TaskTurnIo, gate: CriteriaOutcome, waived: boolean): void => {
  io.emit({
    type: 'criteria',
    data: {
      name: gate.satisfied ? 'gate_passed' : waived ? 'gate_waived' : 'gate_blocked',
      met: gate.counts.met,
      unmet: gate.counts.unmet,
      unclear: gate.counts.unclear,
      // Only when it is TRUE: an extra key on every ordinary line would be
      // noise, and its absence already reads as "the diff was indexed".
      ...(gate.report.diff_unreadable ? { diff_unreadable: true } : {}),
      // Same rule: only when it happened. A reviewer that judged criteria this
      // ticket does not carry is a drift between the prompt and the record,
      // and those entries were discarded — said, never absorbed.
      ...(gate.unknown_ids > 0 ? { unknown_ids: gate.unknown_ids } : {}),
      // Round 2, majeur 1(b): the four facts that make one `unclear` tally
      // mean four different things. The gate measured them from the start and
      // journaled none of them, so a human reading "3 unclear" could not tell
      // a reviewer that weighed the work and doubted from a reviewer whose
      // whole answer was unreadable. Same rule again — a key per fact, and
      // only when the fact happened, so an ordinary passing line stays four
      // keys wide.
      ...(gate.unjudged > 0 ? { unjudged: gate.unjudged } : {}),
      ...(gate.dropped_evidence > 0 ? { dropped_evidence: gate.dropped_evidence } : {}),
      ...(gate.demoted > 0 ? { demoted: gate.demoted } : {}),
      ...(gate.overflowed ? { overflowed: true } : {}),
    },
    ...(gate.satisfied || waived ? {} : { reason_code: 'criteria_unmet' as const }),
  })
}

/**
 * The workspace is going down mid-review. That is NOT a blocked review — the
 * reviewer never got to say anything — so it must not settle on 'review_ko',
 * which claims a verdict and carries the terminal-ish `review_blocked` code.
 * The task lands exactly where every other turn a Ctrl-C cut short lands:
 * 'interrupted', with the human-interruption code, its work committed and its
 * worktree kept. A reply (or a later turn) picks it back up.
 */
const settleInterrupted = (record: TaskRecord, io: TaskTurnIo, cwd: string): void => {
  io.emit({
    type: 'interrupted',
    data: { reason: 'shutdown' },
    reason_code: 'interrupted_by_user',
  })
  record.status = 'interrupted'
  record.reason = taskReason('interrupted_by_user', REVIEW_CUT_DETAIL)
  io.persist()
  if (record.brain_ticket) {
    void reportBrainTransition(cwd, record, { type: 'failed', error_message: REVIEW_CUT_DETAIL })
  }
}

export type CreateTaskReviewerOptions = {
  /** MAIN repo root: review archives land here, never in the disposable worktree. */
  cwd: string
  /** Raw configured agent command (the review flow applies its own hardening). */
  command: string
  /**
   * Per-task override of `command`. When set, the end-of-turn review runs
   * the CLI that task stored (`record.agent`), not the project's frozen one.
   */
  resolveCommand?: (record: TaskRecord) => string
  timeoutMs: number
  /**
   * Which review flow runs (T3.2). The workspace ALWAYS passes it explicitly,
   * resolved per project by `resolveReviewMode(resolveProjectConfig(...))` —
   * this is not a default it falls through. It stays optional so a direct
   * caller (a test, a one-off script) is not forced to name a mode it has no
   * opinion about, and `'simple'` is the honest fallback for that case: it is
   * what every task ran before the key existed.
   */
  mode?: TaskReviewMode
  /** Test seams — the defaults run real git/agents. */
  prepFn?: typeof prep
  runSimpleFlowFn?: typeof runSimpleFlow
  runDualFlowFn?: typeof runDualFlow
  archiveRecordFn?: typeof archiveRecord
  /**
   * Machine-wide load cap (T1.3, D4): the review agent is a heavy consumer
   * like a turn or a checks run, and must acquire its OWN 'review' slot
   * before actually running — never while holding another one (the runner
   * already released the turn's slot before calling this hook; see
   * task-runner.ts's finishTurn/runTurn). Injectable (§ 0.4); defaults to a
   * fresh, private cap so every existing test that does not care about
   * cross-consumer concurrency keeps working unmodified.
   *
   * The acquire is made INTERRUPTIBLE with `io.signal` (adversarial review
   * fix): without it, a review parked on a saturated cap sat there until the
   * shutdown's own DRAIN_TIMEOUT_MS gave up — up to 30s of a Ctrl-C looking
   * hung, on a status ('reviewing') the record itself calls "uninterruptible,
   * a status with no way out inside this session". `io.signal` is exactly
   * the signal `runner.shutdown()` aborts; on abort while queued, `acquire`
   * hands back immediately and the `io.signal.aborted` check right below
   * settles the task as 'interrupted', slot never taken.
   */
  loadCap?: Pick<LoadCap, 'acquire' | 'snapshot'>
}

type FlowRunner = (
  opts: CreateTaskReviewerOptions,
  input: Awaited<ReturnType<typeof prep>>,
  io: TaskTurnIo,
  /** T3.2's acceptance-criteria chapter, or null when the task carries none. */
  criteriaChapter: string | null,
) => Promise<SimpleOutcome | DualOutcome>

/**
 * Runs the actual review agent(s) on the prepped worktree input, behind a
 * dedicated session never exposed on /api/status (the single-review UI keeps
 * its own). Partials are forwarded as ephemeral progress lines on the
 * task_text SSE channel — the persisted journal only gets the bounded
 * review_started/review_done/error events.
 */
const runReviewFlow: FlowRunner = async (opts, input, io, criteriaChapter) => {
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
    // `signal` reaches the agent subprocess itself (runAgent SIGTERMs its
    // process group): that is what makes a Ctrl-C during a review immediate
    // instead of a wait on the reviewer's own timeout.
    return mode === 'dual'
      ? await runDual({
          agentCommand: opts.command,
          input,
          dir,
          timeoutMs: opts.timeoutMs,
          session,
          spinner: { update: (status) => io.text(status) },
          ...(criteriaChapter ? { criteriaChapter } : {}),
          signal: io.signal,
        })
      : await runSimple({
          agentCommand: opts.command,
          input,
          dir,
          timeoutMs: opts.timeoutMs,
          session,
          prompt: buildFullReviewPrompt(input, criteriaChapter ?? undefined),
          incremental: false,
          signal: io.signal,
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
  const loadCap = opts.loadCap ?? createLoadCap(DEFAULT_MAX_CONCURRENT_AGENTS)

  return async (record, io) => {
    // The runner already persisted 'reviewing' before calling.
    //
    // `record` is held across the whole flow (prep + agent, minutes) before
    // io.persist() writes it back — one of the four snapshot-across-an-await
    // sites listed in task-runner.ts. Valid by EXCLUSION: the task sits on
    // 'reviewing' throughout, and every action refuses that status (start,
    // reply, resume and interrupt through `active`, abandon and ship on the
    // status itself). Nothing else writes this record meanwhile.
    if (io.signal.aborted) {
      // The shutdown beat us to the start line: never spawn an agent this
      // process is about to abandon.
      settleInterrupted(record, io, opts.cwd)
      return
    }
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
        settle(record, io, 'review_ok', { cwd: opts.cwd })
        return
      }

      // T3.2: built AFTER the empty-diff short-circuit above, on purpose —
      // a task whose turn changed nothing gets no chapter and no model call,
      // exactly as before this ticket.
      const criteria = taskCriteria(record)
      const criteriaChapter = criteria.length > 0 ? buildCriteriaChapter(criteria) : null

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
      if (io.signal.aborted) {
        // The shutdown landed during the prep. Starting the flow now would
        // spawn a review agent (two, in dual mode) only to kill it on the next
        // tick: "no review is ever launched for nothing" is the promise, and
        // this is the gap where it was not kept.
        settleInterrupted(record, io, opts.cwd)
        return
      }
      // T1.3 (D4): the review agent is a heavy consumer of the machine load
      // cap, gated tightly around the actual agent call — never around prep
      // (local git work) nor around the archive/settle that follows (no
      // process, nothing worth budgeting). Acquired here, not earlier: the
      // runner already released the turn's OWN slot before this hook was
      // even called, so there is nothing held to self-deadlock against.
      // T3.1: a saturated cap is SAID (journal + API), never a silent hang
      // and never an `error` — an ordinary wait is not a failed review.
      const capSnap = loadCap.snapshot()
      if (capSnap.occupied >= capSnap.max) {
        io.emit({
          type: 'queue',
          data: { name: 'machine_busy', message: LOAD_CAP_WAIT_DETAIL },
          reason_code: 'resource_busy',
        })
      }
      const release = await loadCap.acquire('review', io.signal)
      let outcome: SimpleOutcome | DualOutcome
      try {
        if (io.signal.aborted) {
          // The shutdown landed while this review was queued for a slot — or
          // fired WHILE it was queued, in which case `acquire` already handed
          // this back immediately instead of leaving it parked (see the
          // `loadCap` option doc above). Either way nothing was ever spawned.
          settleInterrupted(record, io, opts.cwd)
          return
        }
        outcome = await runReviewFlow(
          {
            ...opts,
            command: opts.resolveCommand?.(record) ?? opts.command,
          },
          input,
          io,
          criteriaChapter,
        )
      } finally {
        release()
      }

      if (io.signal.aborted) {
        // The agent was killed by the shutdown: whatever came back is a
        // half-run, not a verdict.
        settleInterrupted(record, io, opts.cwd)
        return
      }
      if (!outcome.ok) {
        // The event keeps its message untouched and gains the code beside it;
        // the record repeats that same message in reason.detail.
        const message = `review failed: ${outcome.message}`
        io.emit({ type: 'error', data: { message }, reason_code: 'review_blocked' })
        settle(record, io, 'review_ko', {
          cwd: opts.cwd,
          blocked: taskReason('review_blocked', message),
        })
        return
      }

      // T3.2, and BEFORE the archive on purpose: the normalized per-criterion
      // statuses are what T3.6 reads back — possibly at a later boot — so they
      // have to be part of the record that lands on disk, not a structure that
      // dies with this process. `resolveCriteria` is the whole gate: it joins
      // on the ticket's stable ids, discards what the model invented, grounds
      // each evidence in the diff and forces one status per criterion.
      const gate =
        criteria.length > 0
          ? resolveCriteria(criteria, outcome.record.review.criteria, outcome.record.diff)
          : null
      if (gate) {
        outcome.record.review.criteria = gate.verdicts
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
      const verdict = taskReviewVerdict(outcome.record)
      // D18: an unclear-only gate is LIFTED by a review the reviewer settled
      // as OK. The waiver never applies over a blocking finding (the branch
      // below still turns those into a KO) and never touches `satisfied`
      // itself; it is journaled on the gate line and in a message naming the
      // criteria it lifted.
      const criteriaWaived =
        gate !== null &&
        !gate.satisfied &&
        verdict === 'review_ok' &&
        !hasBlockingFindings(outcome.record) &&
        criteriaGateWaivable(gate)
      if (gate) {
        emitCriteriaGate(io, gate, criteriaWaived)
      }
      // T3.3, and BEFORE the criteria gate: the deterministic guard-rail.
      // `groundReview` already escalates an `approve` that carries a
      // `critical` — but only when it could index the diff — and it has never
      // covered `major` at all. Here the CLI decides, on the findings that
      // survived grounding: an unresolved critical or major keeps the task
      // blocked whatever the model concluded (invariant n° 4). It only turns
      // an OK into a KO, same discipline as the criteria gate below, and it
      // runs FIRST because "there are still blocking findings" is the more
      // actionable of the two reasons.
      if (verdict === 'review_ok' && hasBlockingFindings(outcome.record)) {
        const detail = blockingFindingsDetail(outcome.record)
        // Said out loud (invariant n° 2): the `review_done` line above states
        // the model's own verdict, so without this the journal would show an
        // `approve` beside a blocked task and nothing explaining the gap.
        io.emit({
          type: 'message',
          data: { text: detail, name: 'review_verdict_overridden' },
          reason_code: 'review_blocked',
        })
        settle(record, io, 'review_ko', {
          cwd: opts.cwd,
          blocked: taskReason('review_blocked', detail),
          reviewOutcome: outcome.record,
        })
        return
      }
      // The HARD gate (D11, softened by D18): an `unmet` or unjudged
      // criterion, or an unreadable diff, blocks "ready to merge" with no
      // weighting and no exception. It only ever turns an OK into a KO — a
      // review that already blocks keeps its own, more actionable reason
      // rather than being relabelled.
      if (criteriaWaived && gate) {
        io.emit({
          type: 'message',
          data: {
            text: `the settled review lifts ${gate.counts.unclear} 'unclear' criterion/criteria (evidence outside the diff or requiring execution); nothing is unmet`,
            name: 'criteria_unclear_waived',
          },
        })
      }
      if (gate && !gate.satisfied && !criteriaWaived && verdict === 'review_ok') {
        settle(record, io, 'review_ko', {
          cwd: opts.cwd,
          blocked: taskReason('criteria_unmet', criteriaUnmetDetail(gate)),
          reviewOutcome: outcome.record,
        })
        return
      }
      settle(record, io, verdict, { cwd: opts.cwd, reviewOutcome: outcome.record })
    } catch (err) {
      if (io.signal.aborted) {
        // The rejection IS the abort (a killed agent, an interrupted prep):
        // reporting it as a blocked review would blame the reviewer for the
        // shutdown.
        settleInterrupted(record, io, opts.cwd)
        return
      }
      const message = `review failed: ${errorMessage(err)}`
      io.emit({ type: 'error', data: { message }, reason_code: 'review_blocked' })
      settle(record, io, 'review_ko', {
        cwd: opts.cwd,
        blocked: taskReason('review_blocked', message),
      })
    }
  }
}
