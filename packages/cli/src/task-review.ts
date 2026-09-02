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

import { randomUUID } from 'node:crypto'
import { ensureWorkDir, type ReviewMode } from './config.js'
import {
  sanitizeRecord,
  type EvidenceRecord,
  type Finding,
  type ReviewRecord,
  type RunbookConfig,
  type TaskCheckResult,
  type TaskChecks,
  type TaskReason,
  type TaskRecord,
  type TaskVerification,
} from './contract.js'
import { verifyFindingRepros } from './finding-repro.js'
import { buildAgentFixPrompt, isFixable } from './fix.js'
import { isAncestor, refExists, tryGit } from './git.js'
import { createLoadCap, DEFAULT_MAX_CONCURRENT_AGENTS, type LoadCap } from './load-cap.js'
import {
  sandboxName,
  type SandboxDriver,
  type SandboxNetworkPolicy,
  type SandboxSecret,
} from './microsandbox-driver.js'
import {
  AGENT_INSTALL_DOMAINS,
  ensureAgentCredentials,
  ensureAgentInstalled,
  ensureGuestUser,
} from './microvm-bootstrap.js'
import { prep } from './prep.js'
import { archiveRecord, findPreviousReview, readJson, resolveArchivePath } from './record.js'
import { readProofConfig } from './repo-config.js'
import {
  buildFullReviewPrompt,
  buildIncrementalPrompt,
  buildRepeatReviewPrompt,
  runDualFlow,
  runSimpleFlow,
  type DualOutcome,
  type SimpleOutcome,
} from './review.js'
import { createSession } from './serve.js'
import { autoPushReview } from './sync.js'
import { buildChecksChapter, microvmStepExecutor } from './task-checks.js'
import {
  buildCriteriaChapter,
  combineCriteriaOutcomes,
  criteriaGateWaivable,
  criteriaUnmetDetail,
  partitionCriteriaByProof,
  resolveCriteria,
  resolveMechanicalCriteria,
  unmetCriteriaFixChapter,
  type CriteriaOutcome,
} from './task-criteria-gate.js'
import { readTaskEvidence, writeTaskEvidence } from './task-evidence.js'
import { reportHubTransition, type ArmTransitionDraft } from './task-hub.js'
import {
  commandBin,
  containerTaskCommandFor,
  DEFAULT_BASE_IMAGE,
  DEFAULT_ISOLATION_ALLOWED_DOMAINS,
} from './task-isolation.js'
import { buildProofChapter } from './task-proof-chapter.js'
import {
  REVIEW_CUT_DETAIL,
  taskCriteria,
  type TaskTurnIo,
  type TaskTurnReviewFn,
} from './task-runner.js'
import { loadTask, readTaskChecks, taskReason } from './tasks-store.js'
import { classifyUiPaths } from './ui-surface.js'
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

/**
 * The archived review a task's `review_ref` points at, or null on every miss.
 * Exported for D26's fix-loop cap (task-server.ts), which needs the SAME
 * read `buildAutoFixTurnPrompt` already makes — off the in-memory record's own
 * `review_ref`, never a fresh `loadTask` — because it runs from inside the
 * very `applyGates` closure that mutates that record before its next persist
 * writes `review_ref` to disk.
 */
export function readReviewRef(task: TaskRecord): ReviewRecord | null {
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
 * The prompt of an AUTOMATIC fix turn (T3.3). It IS the manual path's prompt:
 * `buildAgentFixPrompt` on the same archive, through the same helper the click
 * uses, with the differences that automating it requires:
 *
 *  - the findings are not a human's selection but every ACTIONABLE one, which
 *    is exactly the set that made the review block. Asking for less would
 *    guarantee the next review blocks on the remainder and burns a round;
 *  - a criteria chapter is appended when the acceptance-criteria gate is what
 *    blocks, because a review that approved the code raises no finding at all;
 *  - a checks chapter (D16) is appended when `checks` still blocks "ready to
 *    merge" (`checksBlockReady`), the same reason a red run turns an OK into
 *    a `review_ko` in `applyChecksGate`, so a fix round asked for by a red
 *    check actually NAMES it, instead of leaving the agent to guess why the
 *    turn it just finished was not enough.
 *
 * Null when there is nothing concrete to ask for: no archive, an unreadable
 * one, or an archive carrying no actionable finding, no unsatisfied criterion
 * and no blocking check. That null is a REFUSAL to spend a round, never an
 * empty prompt.
 */
export function buildAutoFixTurnPrompt(task: TaskRecord, checks: TaskChecks | null): string | null {
  const review = readReviewRef(task)
  if (!review) {
    return null
  }
  const ids = actionableFindingIds(review)
  const criteriaChapter = unmetCriteriaFixChapter(taskCriteria(task), review.review.criteria)
  const checksChapter =
    checks && checksBlockReady(checks) ? buildChecksChapter(checks, { purpose: 'fix' }) : null
  if (ids.length === 0 && !criteriaChapter && !checksChapter) {
    return null
  }
  const base = buildAgentFixPrompt(review, ids)
  const chapter = [criteriaChapter, checksChapter]
    .filter((c): c is string => Boolean(c))
    .join('\n\n')
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

/** How much of a verification check's tail this chapter spends, same bound as `CHECKS_CHAPTER_TAIL_MAX`. */
const RUNBOOK_CHAPTER_TAIL_MAX = 600

const runbookCheckLine = (check: TaskCheckResult): string => {
  const line = `  - ${check.command}: ${check.status}`
  return check.status === 'passed' || check.status === 'skipped'
    ? line
    : `${line}\n    ${check.tail.slice(-RUNBOOK_CHAPTER_TAIL_MAX)}`
}

const runbookImageAndTestsLines = (runbook: RunbookConfig): string[] => [
  `- runbook image: ${runbook.image}`,
  `- runbook tests: ${runbook.tests.join(', ')}`,
]

const runbookVerificationLines = (verification: TaskVerification): string[] => [
  `- last verification: ${verification.status} (head ${verification.head_sha.slice(0, 12)}, runbook ${verification.runbook_sha})`,
  ...verification.checks.map(runbookCheckLine),
  `- runbook integrity: ${verification.integrity_ok ? 'intact' : 'DRIFTED'}`,
  ...(verification.changed_dependency_files.length > 0
    ? [
        `- changed dependency files since validation: ${verification.changed_dependency_files.join(', ')}`,
      ]
    : []),
  ...(verification.error ? [`- verification error: ${verification.error}`] : []),
]

/**
 * Runbook + last mechanical verification, folded into the reviewer's prompt
 * (lot C8) exactly like `buildChecksChapter`: what already ran, mechanically,
 * before the model ever saw the diff. Null when the task carries neither.
 */
export function buildRunbookVerificationChapter(
  runbook: RunbookConfig | null | undefined,
  verification: TaskVerification | null | undefined,
): string | null {
  if (!runbook && !verification) {
    return null
  }
  const lines = [
    'Runbook and mechanical verification, MANDATORY chapter:',
    ...(runbook ? runbookImageAndTestsLines(runbook) : []),
    ...(verification ? runbookVerificationLines(verification) : []),
    'These tests already ran once, mechanically, in an isolated VM restored from the project snapshot: a passed status is a fact, not a hypothesis to weigh against the code, and a failed, refused or errored one names exactly what still needs fixing before the runbook can be trusted again.',
  ]
  return lines.join('\n')
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
 * The arm/hub fact a settled turn reports, decided from what the turn
 * actually produced rather than from `status` alone. `status: 'review_ko'`
 * covers two different situations, and the hub must not read them as the
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
export function hubSettleTransition(opts: {
  status: 'review_ok' | 'review_ko'
  reviewOutcome?: ReviewRecord
  reason?: TaskReason
  costTicks?: number
}): ArmTransitionDraft {
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
    /** MAIN repo root: only used for the arm/hub report below, never for I/O on `record` itself. */
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
  // Arm/hub integration: reported AFTER the persist, never instead of it,
  // same discipline as every other fire-and-forget effect a settled turn
  // triggers (task-labels.ts's cycle label). Never awaited: a hub round
  // trip must not hold up the turn this settle ends.
  if (record.hub_ticket) {
    void reportHubTransition(
      opts.cwd,
      record,
      hubSettleTransition({
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
  if (record.hub_ticket) {
    void reportHubTransition(cwd, record, { type: 'failed', error_message: REVIEW_CUT_DETAIL })
  }
}

/**
 * The snapshot, runbook and mechanical verification of ONE task's review —
 * resolved per task-turn rather than frozen once per project, so a reviewer
 * actually sees the snapshot a turn just warmed and the verification that
 * turn just ran, instead of whatever the project's reviewer happened to be
 * built with.
 */
export type ReviewMicrovmContext = {
  /** Project snapshot the review VM restores; null boots the runbook image cold. */
  snapshotName: string | null
  /** The validated runbook, or null when the worktree carries none. */
  runbook: RunbookConfig | null
  /** The task's last mechanical verification, or null when none ran. */
  verification: TaskVerification | null
}

export type CreateTaskReviewerOptions = {
  /** Set for a 'microvm' task: the review runs in a fresh read-only VM instead of the host (lot C8). */
  driver?: SandboxDriver | undefined
  /**
   * Resolves `ReviewMicrovmContext` for the task about to be reviewed, called
   * ONCE at the start of the review (never re-read mid-review, see
   * `createTaskReviewer`'s own call site). Absent → `{ snapshotName: null,
   * runbook: null, verification: null }`, a cold boot with no runbook
   * chapter, same as before this ticket.
   */
  resolveReviewContext?: (record: TaskRecord) => Promise<ReviewMicrovmContext>
  /** Secrets declared on the review sandbox (CAGE_FORWARDED_ENV built by the caller); never passed as env. */
  secrets?: readonly SandboxSecret[] | undefined
  /** Project id, forwarded to `runMicrovmReview`. */
  projectId?: string | undefined
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

type FlowRunnerPrompt = {
  /** T3.2's judged-criteria chapter and D16's checks chapter, merged, or null when the task has neither. */
  chapter: string | null
  /**
   * D24: a pre-built simple-mode prompt (repeat or incremental, `chapter`
   * already folded in by whichever of `buildRepeatReviewPrompt` /
   * `buildIncrementalPrompt` built it), or null to build the ordinary full
   * prompt inline. Ignored in dual mode, which always starts from scratch
   * (review.ts's own comment on `dual` explains why: a judge has no
   * equivalent for reconciling two lanes against a remembered verdict).
   */
  prebuiltPrompt: string | null
}

/** `CreateTaskReviewerOptions` plus the VM-backed agent call built by `createTaskReviewer` when `opts.driver` is set: never part of the public options a caller builds by hand. */
type ReviewFlowOptions = CreateTaskReviewerOptions & {
  runAgentInVm?: ((prompt: string) => Promise<string>) | undefined
}

type FlowRunner = (
  opts: ReviewFlowOptions,
  input: Awaited<ReturnType<typeof prep>>,
  io: TaskTurnIo,
  /** Bundled rather than two more params: max-params caps a function at 4. */
  prompt: FlowRunnerPrompt,
) => Promise<SimpleOutcome | DualOutcome>

/**
 * Runs the actual review agent(s) on the prepped worktree input, behind a
 * dedicated session never exposed on /api/status (the single-review UI keeps
 * its own). Partials are forwarded as ephemeral progress lines on the
 * task_text SSE channel — the persisted journal only gets the bounded
 * review_started/review_done/error events.
 */
const runReviewFlow: FlowRunner = async (opts, input, io, { chapter, prebuiltPrompt }) => {
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
          ...(chapter ? { criteriaChapter: chapter } : {}),
          signal: io.signal,
          ...(opts.runAgentInVm ? { runAgentInVm: opts.runAgentInVm } : {}),
        })
      : await runSimple({
          agentCommand: opts.command,
          input,
          dir,
          timeoutMs: opts.timeoutMs,
          session,
          prompt: prebuiltPrompt ?? buildFullReviewPrompt(input, chapter ?? undefined),
          // D24: a repeat or incremental prompt legitimately revisits only
          // what changed (or, on a repeat, nothing at all) — same reasoning
          // runSimpleFlow's own comment gives for skipping the coverage-gap
          // check on a true incremental review.
          incremental: prebuiltPrompt !== null,
          signal: io.signal,
          ...(opts.runAgentInVm ? { runAgentInVm: opts.runAgentInVm } : {}),
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
      // D17: only the criteria the reviewer must actually JUDGE earn a prompt
      // chapter. A mechanical one (a `[proof:command|diff|read ...]` tag) is
      // decided by this file below, never asked of the model.
      const { mechanical, judged } = partitionCriteriaByProof(criteria)
      const criteriaChapter = judged.length > 0 ? buildCriteriaChapter(judged) : null
      // D16: the SAME checks snapshot feeds this review chapter and the
      // mechanical `command` criteria resolved below, read once from disk,
      // never re-read mid-turn.
      const checks = terminalChecksResult(readTaskChecks(opts.cwd, record.id))
      const checksChapter = checks ? buildChecksChapter(checks, { purpose: 'review' }) : null
      // Resolved ONCE, here, at the start of the review: the resolver reads
      // the task's OWN worktree and OWN last verification, never re-read for
      // the rest of this review even though it runs for minutes.
      const reviewCtx: ReviewMicrovmContext = opts.resolveReviewContext
        ? await opts.resolveReviewContext(record)
        : { snapshotName: null, runbook: null, verification: null }
      const runbookChapter = buildRunbookVerificationChapter(
        reviewCtx.runbook,
        reviewCtx.verification,
      )
      // D17: only a 'microvm' task whose project actually configured a proof
      // target earns this chapter: a task with no target has nothing to
      // replay a proof against, and a non-'microvm' task never captures one
      // at all (task-server.ts's verifyAfterCommit gates capture the same
      // way). `proofEvidence` is read once, here, and reused after the
      // review to decide whether this turn's verdict may be folded back into
      // evidence.json (see below): it is null whenever the file on disk does
      // not match THIS record's own head_sha, which is the honest "no proof
      // for this commit" rather than a stale one from an earlier turn.
      let proofEvidence: EvidenceRecord | null = null
      let proofChapter: string | null = null
      if (record.isolation === 'microvm') {
        const proofConfig = readProofConfig(opts.cwd)
        if (proofConfig) {
          const { ui, other } = classifyUiPaths(changed ? changed.split('\n').filter(Boolean) : [])
          const lastTurn = record.turns.at(-1)
          const intent = lastTurn?.proof_intent ?? null
          const onDisk = readTaskEvidence(opts.cwd, record.id)
          proofEvidence = onDisk && onDisk.head_sha === record.head_sha ? onDisk : null
          proofChapter = buildProofChapter({
            uiFiles: ui,
            otherCount: other.length,
            intent,
            evidence: proofEvidence,
            declared: intent !== null,
          })
        }
      }
      const chapter =
        [criteriaChapter, checksChapter, runbookChapter, proofChapter]
          .filter((c): c is string => Boolean(c))
          .join('\n\n') || null

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
      // D24: inter-turn memory, SIMPLE mode only (dual always starts from
      // scratch, see `runReviewFlow`'s own comment). When the last archived
      // review of this branch/target sits at the SAME head as this turn's
      // own HEAD, nothing was committed since it: hand that review back and
      // ask the model to confirm or say what changed, instead of re-judging
      // from a blank slate — the root cause D24 fixes (three different
      // verdicts on one unchanged head_sha, see the plan's diagnosis). When
      // the head moved and the previous archive is a verified ancestor of
      // it, `buildIncrementalPrompt` covers that exactly as the single-review
      // CLI flow already does. Any other shape (no previous archive, a
      // rebased/unrelated head) falls through to `null`, which `runReviewFlow`
      // reads as "build the ordinary full prompt", unchanged from before
      // this ticket.
      let prebuiltPrompt: string | null = null
      if (mode === 'simple') {
        const previousReview = findPreviousReview(opts.cwd, record.branch, record.base)
        if (previousReview && previousReview.meta.head_sha === input.head_sha) {
          prebuiltPrompt = buildRepeatReviewPrompt(input, previousReview, chapter ?? undefined)
        } else if (previousReview) {
          prebuiltPrompt =
            buildIncrementalPrompt(input, opts.cwd, chapter ?? undefined)?.prompt ?? null
        }
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
        const command = opts.resolveCommand?.(record) ?? opts.command
        const driver = opts.driver
        const runAgentInVm = driver
          ? (prompt: string): Promise<string> =>
              runMicrovmReview({
                driver,
                worktree: record.worktree,
                projectId: opts.projectId ?? '',
                snapshotName: reviewCtx.snapshotName,
                image: reviewCtx.runbook?.image ?? DEFAULT_BASE_IMAGE,
                command,
                prompt,
                timeoutMs: opts.timeoutMs,
                taskId: record.id,
                ...(opts.secrets ? { secrets: opts.secrets } : {}),
                signal: io.signal,
              })
          : undefined
        outcome = await runReviewFlow(
          {
            ...opts,
            command,
            ...(runAgentInVm ? { runAgentInVm } : {}),
          },
          input,
          io,
          { chapter, prebuiltPrompt },
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

      // D24: rebuts every 'major' finding that claims a concrete repro by
      // actually running it, BEFORE anything downstream reads severity — the
      // criteria gate below, `taskReviewVerdict` and `hasBlockingFindings`
      // (T3.3's guard-rail) all read the CORRECTED severities from here on,
      // never the model's raw, unverified claim.
      const reproOutcome = await verifyFindingRepros(outcome.record.review.findings, {
        worktree: record.worktree,
        ...(opts.driver
          ? {
              executor: microvmStepExecutor({
                driver: opts.driver,
                projectId: opts.projectId ?? '',
                snapshotName: reviewCtx.snapshotName,
                ...(reviewCtx.runbook ? { allowedDomains: reviewCtx.runbook.egress } : {}),
              }),
            }
          : {}),
      })
      outcome.record.review.findings = reproOutcome.findings

      // D17: the reviewer's proof_review verdict is folded back into
      // evidence.json right beside the finding-repro pass above, same file
      // task-server.ts's onTurnDone re-reads and re-emits once this hook
      // returns. Only when the evidence this review actually judged (the one
      // matching THIS record's own head_sha, resolved once above) is still
      // on disk: a review with nothing to judge (no proof chapter, an
      // unconfigured project) never writes one.
      if (outcome.record.review.proof_review) {
        if (proofEvidence) {
          writeTaskEvidence(opts.cwd, record.id, {
            ...proofEvidence,
            review: outcome.record.review.proof_review,
          })
        }
      } else if (proofChapter) {
        // Observed in the field: the chapter was mandatory, the model wrote a
        // valid review anyway, and "proof_review" simply never came back.
        // Never invented here: evidence.json's `review` stays absent, since
        // fabricating a verdict the model never gave would be worse than
        // saying nothing. Journaled instead, on the same 'proof' channel as
        // 'declared'/'undeclared'/'unparsed' (task-runner.ts), so a run
        // missing the verdict is as visible as one missing the declaration.
        const message =
          "the reviewer's JSON carried no proof_review despite the mandatory visual-proof chapter: the PROOF declaration above was never judged"
        io.emit({ type: 'proof', data: { name: 'review_missing', message } })
        console.warn(`${record.id}: ${message}`)
      }

      // T3.2, and BEFORE the archive on purpose: the normalized per-criterion
      // statuses are what T3.6 reads back, possibly at a later boot, so they
      // have to be part of the record that lands on disk, not a structure that
      // dies with this process. `resolveCriteria` grounds the JUDGED criteria
      // in the diff exactly as before D17; the MECHANICAL ones never go
      // through it (nor `groundCriterionVerdicts`): a `command`/`diff`/`read`
      // verdict has nothing to anchor in the diff and would be wrongly demoted
      // for lacking one. `combineCriteriaOutcomes` re-merges both halves into
      // the single ordered outcome the rest of this function (and T3.6) reads.
      let gate: CriteriaOutcome | null = null
      if (criteria.length > 0) {
        const mechanicalVerdicts = await resolveMechanicalCriteria(mechanical, {
          worktree: record.worktree,
          diff: outcome.record.diff,
          checks,
        })
        const judgedOutcome = resolveCriteria(
          judged,
          outcome.record.review.criteria,
          outcome.record.diff,
        )
        gate = combineCriteriaOutcomes(criteria, mechanicalVerdicts, judgedOutcome)
      }
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
          ...(reproOutcome.report.demoted > 0
            ? { repro_demoted: reproOutcome.report.demoted }
            : {}),
        },
      })
      const verdict = taskReviewVerdict(outcome.record)
      // D18/D26: an unclear-only gate is LIFTED whenever nothing else blocks —
      // no unresolved critical/major finding — REGARDLESS of the reviewer's
      // own raw verdict label. D26 dropped the `verdict === 'review_ok'`
      // conjunct D18 shipped with: an incident showed a criterion's own
      // sincere doubt leaking into the model's top-level `verdict`
      // ('request_changes' with no finding behind it), which kept a task
      // `review_ko` for the exact same fact the criteria gate had already
      // settled as a waivable "unclear" — twelve automatic fix rounds spent
      // rewording a judgment call nothing could ground in the diff. The
      // criteria chapter's prompt (task-criteria-gate.ts) now also tells the
      // reviewer never to let this leak the other way; this is the
      // deterministic backstop, on the same invariant n° 4 already applied to
      // every OTHER field the model cannot be trusted whole on. The waiver
      // never touches `satisfied` itself; it is journaled on the gate line
      // and in a message naming the criteria it lifted.
      const criteriaWaived =
        gate !== null &&
        !gate.satisfied &&
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
      // D26: the waiver OUTRANKS the reviewer's own verdict label. Once the
      // gate is lifted, nothing about the CODE still blocks (no unresolved
      // critical/major finding — checked above), so a raw 'request_changes'
      // or 'comment' the model wrote over its own doubt about a criterion
      // must not re-block a task the gate already cleared.
      settle(record, io, criteriaWaived ? 'review_ok' : verdict, {
        cwd: opts.cwd,
        reviewOutcome: outcome.record,
      })
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

export type RunMicrovmReviewOptions = {
  driver: SandboxDriver
  worktree: string
  projectId: string
  snapshotName: string | null
  image: string
  command: string
  prompt: string
  timeoutMs: number
  /** Folded into the sandbox name (`codesema-review-<taskId>-<random>`) alongside a fresh random suffix on every call, so concurrent invocations sharing the same taskId (dual mode's two lanes) never collide on one sandbox. */
  taskId?: string | undefined
  allowedDomains?: readonly string[]
  secrets?: readonly SandboxSecret[]
  onText?: (text: string) => void
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  /** Test seam: overrides ensureAgentCredentials' host credentials file. */
  credentialsPath?: string
}

const MICROVM_REVIEW_DEFAULTS = {
  cpus: 2,
  memoryMib: 2048,
  user: 'agent',
  workDir: '/work',
} as const

/** Headroom added on top of the agent's own timeout, for copyFromHost + chmod ahead of the timed command (matches microvmStepExecutor's checks sandbox). */
const MICROVM_REVIEW_DURATION_BUFFER_SECONDS = 60

/**
 * Runs the review agent inside a fresh VM (worktree mounted read-only, never
 * the dev VM), same raw-stdout contract as `runMicrovmTurn`. Routed through
 * `runReviewFlow` when `opts.driver` is set (see `createTaskReviewer`).
 */
export async function runMicrovmReview(opts: RunMicrovmReviewOptions): Promise<string> {
  const suffix = randomUUID().slice(0, 8)
  const name = sandboxName('review', opts.taskId ? `${opts.taskId}-${suffix}` : suffix)
  // A snapshot restore already has the agent installed (microvm-snapshot.ts
  // bakes it in); a cold boot does not, so this review installs it itself —
  // which needs registry.npmjs.org on top of whatever else it may reach.
  const cold = opts.snapshotName === null
  const agentId = commandBin(opts.command) || 'claude'
  const network: SandboxNetworkPolicy = {
    allowedDomains: Array.from(
      new Set([
        ...(opts.allowedDomains ?? DEFAULT_ISOLATION_ALLOWED_DOMAINS),
        ...(cold ? AGENT_INSTALL_DOMAINS : []),
      ]),
    ),
  }
  const maxDurationSeconds = Math.max(
    1,
    Math.ceil(opts.timeoutMs / 1000) + MICROVM_REVIEW_DURATION_BUFFER_SECONDS,
  )
  // No `workdir` here: the SDK refuses one that does not already exist in
  // the image, and `/work` is only created below by `copyFromHost` (same
  // reasoning as `runMicrovmTurn`'s own boot user) — `cwd` on the exec call
  // below does the `cd` instead.
  const handle = await opts.driver.create({
    name,
    ...(opts.snapshotName ? { fromSnapshot: opts.snapshotName } : { image: opts.image }),
    cpus: MICROVM_REVIEW_DEFAULTS.cpus,
    memoryMib: MICROVM_REVIEW_DEFAULTS.memoryMib,
    maxDurationSeconds,
    network,
    ...(opts.secrets ? { secrets: opts.secrets } : {}),
  })
  try {
    await ensureGuestUser(handle, MICROVM_REVIEW_DEFAULTS.user)
    await ensureAgentInstalled(handle, agentId, { install: cold })
    await ensureAgentCredentials(handle, MICROVM_REVIEW_DEFAULTS.user, agentId, {
      env: opts.env ?? process.env,
      ...(opts.credentialsPath ? { credentialsPath: opts.credentialsPath } : {}),
    })
    await handle.copyFromHost(opts.worktree, MICROVM_REVIEW_DEFAULTS.workDir)
    // A fresh copy, never the dev VM's own worktree: turned read-only right
    // after the copy so nothing the reviewer runs can write it back.
    const chmod = await handle.shell(`chmod -R a-w ${MICROVM_REVIEW_DEFAULTS.workDir}`, {
      timeoutMs: 30_000,
    })
    if (chmod.code !== 0) {
      throw new Error(
        `could not make the review worktree read-only: ${(chmod.stderr || chmod.stdout).trim()}`,
      )
    }
    const command = containerTaskCommandFor(opts.command, { session: null })
    const result = await handle.shell(command, {
      timeoutMs: opts.timeoutMs,
      cwd: MICROVM_REVIEW_DEFAULTS.workDir,
      user: MICROVM_REVIEW_DEFAULTS.user,
      input: opts.prompt,
      ...(opts.onText ? { onText: opts.onText } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    return result.stdout
  } finally {
    await opts.driver.destroy(name).catch(() => {})
  }
}
