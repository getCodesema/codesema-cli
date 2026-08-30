// T3.6 (D12): the merge step, and the four conditions that gate it.
//
// This is the one irreversible thing codesema does, so the whole module is
// built around a single idea: the decision to merge is a CONJUNCTION, not a
// judgement. Four conditions — the code review passed, the repository's checks
// are green, every acceptance criterion is satisfied, the branch is up to date
// with its target — each computed by code, from artifacts T3.1, T3.2 and T3.3
// already produced. No verdict, score, percentage or "confidence" the model
// emitted has a path into `mergeReadiness` (invariant n° 4, applied where a
// mistake costs the most).
//
// Three properties are worth stating up front, because they are what the
// design of this file is FOR:
//
//  1. THE FOUR CONDITIONS ARE JOURNALED ONE BY ONE, satisfied or not. Only
//     journaling the refusal would make "this condition was checked and it
//     passed" indistinguishable from "this condition was never checked" —
//     precisely the fog a /10 confidence score installs.
//  2. THE REFUSAL CARRIES THE FIRST MISSING CONDITION, in D12's order. Not an
//     optimization: it is what makes the message stable and reproducible for
//     the same task, instead of depending on which check happened to run last.
//  3. NOTHING IS EVER REPAIRED AUTOMATICALLY. A conflict comes back as
//     `merge_conflict` and hands over — no rebase, no reset, no deletion. Same
//     doctrine as T1.6 on uncommitted work: the machine does not destroy what
//     it cannot rebuild.
//
// `mergeReadiness` is deliberately PURE and its result is deliberately NOT
// persisted (DP11): the fourth condition is a fact about the WORLD — the
// target moves without the task moving — so a "ready to merge" written to
// task.json would go stale with no event to say so. Same reasoning the
// contract already applied to `queue_position`.

import { DEFAULT_MERGE_SETTINGS, type MergeSettings, type MergeStrategy } from './config.js'
import {
  isTerminalReason,
  sanitizeArmSha,
  type ChecksUnavailableDetail,
  type CriteriaMissingDetail,
  type ReasonCode,
  type ReviewRecord,
  type TaskChecks,
  type TaskReason,
  type TaskRecord,
} from './contract.js'
import { detectForgeHint, isAncestor, refExists, tryGit } from './git.js'
import { CRITERIA_REASON_IDS_MAX } from './task-criteria-gate.js'
import { reportHubTransition } from './task-hub.js'
import {
  blockingFindingsDetail,
  checksBlockReady,
  checksFailedDetail,
  hasBlockingFindings,
  readTaskReview,
  taskReviewVerdict,
} from './task-review.js'
import { taskCriteria } from './task-runner.js'
import { execCli, extractMrUrl, type ShipCliOutcome, type ShipForgeExecFn } from './task-ship.js'
import {
  readTaskChecks,
  readTaskEvents,
  taskReason,
  type AppendTaskEventInput,
} from './tasks-store.js'

/** `type` of every journal line this module produces. `data.name` names the incident (DP9). */
const MERGE_EVENT = 'merge' as const

/** Bound for a forge CLI message quoted in a journal payload or a reason. */
const MERGE_ERROR_MAX = 500

/**
 * TOTAL budget of the merge gate's local git reads (adversarial review, MAJEUR
 * 2). `git.ts` states the doctrine and names the caller this is: `tryGit` has
 * no default bound because the repository's own commits and pushes are
 * legitimately slow, and the callers that run UNATTENDED set one explicitly.
 * The gate is exactly that — `readMergeInputs` runs inside the workspace
 * process, on the DEFAULT `mergePolicy: 'human'` path, once per auto-shipped
 * turn — and `execFileSync` blocks the whole process, event loop included:
 * one repository on a suspended network mount would freeze SSE, HTTP and
 * every other project until the mount came back, which for a dead mount is
 * never.
 *
 * 5 s, and deliberately TIGHTER than `PROBE_TIMEOUT_MS` (8 s), which budgets
 * SPAWNING an external CLI that talks to a forge. These are local
 * object-database lookups — `rev-parse --verify` reads one ref file,
 * `merge-base --is-ancestor` walks commits already on disk — measured in
 * single-digit milliseconds even on a cold cache. Three orders of magnitude of
 * headroom, so the bound can only ever fire on a filesystem that has stopped
 * answering, never on a merely large or busy repository; and when it does
 * fire, the answer is `unresolved` — a cautious `branch_diverged` refusal,
 * which is the safe side of this particular decision.
 *
 * A TOTAL, not a per-call budget, and that distinction is the fix rather than
 * a refinement of it: `branchAncestry` makes up to four reads, so three
 * separate 5 s bounds would still freeze the process for fifteen seconds on
 * the one failure mode this exists for — a mount that answers nothing answers
 * nothing four times. The reads share one deadline, so the whole gate blocks
 * for at most this long whatever the repository does.
 *
 * Exported so a test asserts the value instead of inferring it from a magic
 * number.
 */
export const MERGE_GIT_TIMEOUT_MS = 5000

// --- the exits a refusal names --------------------------------------------
//
// "A refusal that does not say how to get out of it is a dead end" (DP1). The
// sentences below are the OUT, and they are assembled per case so that the
// consent valve is offered EXACTLY where it applies — never under a broken
// runtime, which nobody consents to in advance.

const MERGE_BY_HAND = "set mergePolicy to 'human' and merge this branch yourself"
const CONFIGURE_CHECKS = 'configure checks for this repository'
const OPEN_THE_VALVE =
  'or set allowMergeWithoutChecks to true if this repository legitimately has none'

// --- the four conditions ---------------------------------------------------

/** D12's four conditions, in D12's own order. The refusal takes the first missing one. */
export type MergeConditionId = 'review' | 'checks' | 'criteria' | 'branch'

/** The discriminant a code carries beside its readable sentence, when it has one. */
export type MergeDiscriminant = ChecksUnavailableDetail | CriteriaMissingDetail

export type MergeCondition = {
  id: MergeConditionId
  satisfied: boolean
  /**
   * True only when `satisfied` rests on a PRIOR CONSENT rather than on
   * evidence (`allowMergeWithoutChecks` on an unconfigured repo). Kept as its
   * own flag, never folded into `satisfied`: "verified green" and "waived
   * because you said so" are different facts, and a journal that showed them
   * the same way would be the /10 fog again.
   */
  consented?: boolean
  /** The readable half: why it is not satisfied, or how it was waived. Null when there is nothing to add. */
  detail: string | null
  /** The D2 code this condition hands the task when it is not satisfied. */
  code?: ReasonCode
  /** Machine discriminant of `code`, when the code defines one. */
  discriminant?: MergeDiscriminant
}

/**
 * DP11's derived "ready to merge", as a pure function and NOTHING else. It is
 * served beside a record, never written into one — see the module header.
 *
 * `blockers` is in D12's order, so `blockers[0]` is the refusal's reason.
 */
export type MergeReadiness = {
  ready: boolean
  /** Always four entries, always in D12's order: review, checks, criteria, branch. */
  conditions: MergeCondition[]
  blockers: TaskReason[]
}

/**
 * Where the task branch stands relative to its target, computed LOCALLY. The
 * three cases are kept apart on purpose: `unresolved` is not `behind`, and
 * saying "your branch is behind" when the truth is "I could not find the
 * target ref" is the right decision announced dishonestly.
 */
export type BranchAncestry =
  | { kind: 'up_to_date'; target: string }
  | { kind: 'behind'; target: string }
  | { kind: 'unresolved'; target: string; why: string }

/** The four facts the conditions read. Collected once, then judged purely. */
export type MergeInputs = {
  /** The task's archived review, or null when there is none to read. */
  review: ReviewRecord | null
  /** The task's last finished checks run, or null when none exists. */
  checks: TaskChecks | null
  /**
   * Whether a turn-1 criteria draft was ever PROPOSED for this task. Read from
   * the journal, because a draft never touches the record: T2.5 keeps it in
   * memory and `POST /api/tasks/:id/criteria` is the only path onto disk. It
   * is the one fact that separates `criteria_missing`/`absent` (nobody ever
   * wrote a criterion) from `pending_validation` (someone did, and no human
   * has validated it) — and it survives a reboot, which the draft itself does
   * not.
   */
  criteriaDraftProposed: boolean
  ancestry: BranchAncestry
}

// --- condition 1: the code review passed -----------------------------------

/**
 * The review condition, read from the ARCHIVE on disk — never from anything
 * this process happens to hold: the merge runs after the ship, possibly at a
 * later boot.
 *
 * T3.3's guard-rail is applied here, not re-derived: an `approve` that still
 * carries an unresolved `critical` or `major` finding is escalated to
 * `request_changes` and opens nothing. `hasBlockingFindings` is THE bar —
 * a second severity scale of our own would drift from the reviewer's in
 * silence.
 */
function reviewCondition(review: ReviewRecord | null): MergeCondition {
  if (!review) {
    return {
      id: 'review',
      satisfied: false,
      detail: `no end-of-turn review is archived for this task, so the code-review condition could not be checked — ${MERGE_BY_HAND}`,
      code: 'review_blocked',
    }
  }
  if (hasBlockingFindings(review)) {
    // The escalation itself (T3.3): whatever the model concluded, this review
    // reads as `request_changes` here.
    return {
      id: 'review',
      satisfied: false,
      detail: `${blockingFindingsDetail(review)} — fix the findings, or ${MERGE_BY_HAND}`,
      code: 'review_blocked',
    }
  }
  if (taskReviewVerdict(review) === 'review_ko') {
    return {
      id: 'review',
      satisfied: false,
      detail: `the end-of-turn review blocked this branch (verdict '${review.review.verdict}', ${review.review.findings.length} finding(s)) — fix the findings, or ${MERGE_BY_HAND}`,
      code: 'review_blocked',
    }
  }
  return { id: 'review', satisfied: true, detail: null }
}

// --- condition 2: the repository's checks are green ------------------------

/** The sentence a `checks_unavailable` is ADDED to, per discriminant. Each names its own way out. */
function checksUnavailableDetail(kind: ChecksUnavailableDetail, checks: TaskChecks | null): string {
  if (kind === 'unconfigured') {
    return `this repository configures no checks, so the merge condition could not be evaluated — ${CONFIGURE_CHECKS}, ${MERGE_BY_HAND}, ${OPEN_THE_VALVE}`
  }
  if (kind === 'runtime_error') {
    // Deliberately does NOT name the valve, not even to rule it out: a
    // refusal message is read for what to DO next, and printing the one key
    // that would look like a fix is how a user reaches for it.
    const why = checks?.error ? `: ${checks.error.slice(0, MERGE_ERROR_MAX)}` : ''
    return `the checks run itself could not happen${why}, so the merge condition could not be evaluated — repair the container runtime the checks need, or ${MERGE_BY_HAND}. A runtime failure is never consented to in advance.`
  }
  return `no finished checks run exists for this branch, so the merge condition could not be evaluated — ${CONFIGURE_CHECKS} and let a turn commit so they run, or ${MERGE_BY_HAND}`
}

/**
 * DP1, as code. The automatic merge requires `passed` STRICT.
 *
 *  - `failed` — and, defensively, any run carrying an individual `timeout`
 *    (`runChecks` already folds those into `failed`; `checksBlockReady` is the
 *    defensive read of an older or hand-edited snapshot) — is
 *    `checks_failed`: the condition was evaluated and it lost;
 *  - `unconfigured`, `error`, and no run at all are `checks_unavailable`: the
 *    condition could not be evaluated, which is a different fact and takes a
 *    different code. Borrowing `checks_failed` would tell a user their checks
 *    are red when they never ran (invariant n° 2).
 *
 * The valve lifts the refusal for `unconfigured` ONLY, and when it does the
 * condition is marked `consented` rather than quietly "satisfied".
 *
 * None of this touches T3.1: `checksBlockReady` — the "ready to merge" bar an
 * end-of-turn decision reads — is imported unchanged, and `unconfigured` /
 * `error` stay non-blocking there. The asymmetry (ready ✓ / auto-merge ✗) is
 * assumed and documented in the README.
 */
function checksCondition(checks: TaskChecks | null, settings: MergeSettings): MergeCondition {
  const unavailable = (kind: ChecksUnavailableDetail): MergeCondition => ({
    id: 'checks',
    satisfied: false,
    detail: checksUnavailableDetail(kind, checks),
    code: 'checks_unavailable',
    discriminant: kind,
  })
  if (!checks || checks.status === 'running') {
    return unavailable('no_run')
  }
  if (checks.status === 'error') {
    return unavailable('runtime_error')
  }
  if (checks.status === 'unconfigured') {
    if (!settings.allowMergeWithoutChecks) {
      return unavailable('unconfigured')
    }
    return {
      id: 'checks',
      satisfied: true,
      consented: true,
      detail:
        'this repository configures no checks and allowMergeWithoutChecks is on: the condition is satisfied by your explicit prior consent, not by a green run',
      discriminant: 'unconfigured',
    }
  }
  if (checks.status === 'passed' && !checksBlockReady(checks)) {
    return { id: 'checks', satisfied: true, detail: null }
  }
  return {
    id: 'checks',
    satisfied: false,
    detail: `${checksFailedDetail(checks)} — fix them and let the review run again, or ${MERGE_BY_HAND}`,
    code: 'checks_failed',
  }
}

// --- condition 3: every acceptance criterion is satisfied ------------------

/**
 * The sentence a `criteria_unmet` is ADDED to, built from the verdicts the
 * T3.2 gate ARCHIVED — never from the model's raw report.
 *
 * Close to `criteriaUnmetDetail` (task-criteria-gate) and deliberately not it:
 * that one takes a live `CriteriaOutcome` and states whether the diff could be
 * indexed. An archive carries no grounding report, so calling it from here
 * would mean passing `diff_unreadable: false` — asserting the diff WAS indexed
 * on no evidence at all. The shared bound `CRITERIA_REASON_IDS_MAX` is
 * imported so the two sentences at least truncate identically.
 */
function criteriaUnmetSentence(
  blocking: readonly { id: string; status: string }[],
  total: number,
): string {
  const named = blocking
    .slice(0, CRITERIA_REASON_IDS_MAX)
    .map((entry) => `${entry.id}: ${entry.status}`)
    .join(', ')
  const more = blocking.length > CRITERIA_REASON_IDS_MAX ? ', …' : ''
  return `${blocking.length} of ${total} acceptance criteria are not satisfied by this branch (${named}${more}) — make the diff show them, or ${MERGE_BY_HAND}`
}

/**
 * DP2, as code. "Every criterion is met" is vacuously TRUE of an empty list,
 * and that is exactly the reasoning a merge must not make: a task nobody wrote
 * criteria for is a task a human still owes a word on (D6).
 *
 *  - no criteria at all → `criteria_missing`, discriminated by whether a
 *    turn-1 draft was ever proposed (`pending_validation`) or not (`absent`);
 *  - criteria that exist but are not all `met` → `criteria_unmet`, which stays
 *    RESERVED for verdicts the gate actually returned. A criterion the archive
 *    says nothing about counts as `unclear`, exactly as `resolveCriteria`
 *    reads it — never as satisfied.
 *
 * The criteria list is `taskCriteria(record)`, the SAME function the T3.2 gate
 * judges against: the human-validated list when there is one, else the ticket
 * snapshot frozen at admission. Reading `record.criteria` alone would refuse
 * to merge a ticket-bound task whose every criterion the gate marked `met`.
 */
/**
 * The sentence a `criteria_judgment_open` is ADDED to (D26). Plain language,
 * on purpose — this refusal is read by whoever configured automatic merging,
 * not only by whoever wrote the ticket, so it never says "unclear",
 * "verdict" or "gate": a human decides here, and the sentence says that in
 * those words.
 */
function criteriaJudgmentOpenSentence(open: readonly { id: string }[], total: number): string {
  const named = open
    .slice(0, CRITERIA_REASON_IDS_MAX)
    .map((entry) => entry.id)
    .join(', ')
  const more = open.length > CRITERIA_REASON_IDS_MAX ? ', …' : ''
  return `${open.length} of ${total} acceptance criteria still need a human decision (${named}${more}): the reviewer could not settle them from the diff alone, and the merge request's "To decide" section names the open question(s) — read them, then ${MERGE_BY_HAND}`
}

function criteriaCondition(
  record: TaskRecord,
  review: ReviewRecord | null,
  draftProposed: boolean,
): MergeCondition {
  const criteria = taskCriteria(record)
  if (criteria.length === 0) {
    const kind: CriteriaMissingDetail = draftProposed ? 'pending_validation' : 'absent'
    const detail =
      kind === 'pending_validation'
        ? `acceptance criteria were proposed for this task and never validated, so nothing here has been agreed on — validate the list, or ${MERGE_BY_HAND}`
        : `no acceptance criterion was ever written for this task, so an automatic merge has nothing to verify — write and validate a list, or ${MERGE_BY_HAND}`
    return {
      id: 'criteria',
      satisfied: false,
      detail,
      code: 'criteria_missing',
      discriminant: kind,
    }
  }
  const archived = new Map(
    (review?.review.criteria ?? []).map((verdict) => [verdict.criterion_id, verdict.status]),
  )
  const statuses = criteria.map((criterion) => ({
    id: criterion.id,
    status: archived.get(criterion.id) ?? 'unjudged',
  }))
  // Real work is what clears this one: an 'unmet', or a criterion the
  // archive never judged at all (silence is never a pass).
  const blocking = statuses
    .filter((entry) => entry.status === 'unmet' || entry.status === 'unjudged')
    .map((entry) => ({
      id: entry.id,
      status: entry.status === 'unjudged' ? ('unclear' as const) : entry.status,
    }))
  if (blocking.length > 0) {
    return {
      id: 'criteria',
      satisfied: false,
      detail: criteriaUnmetSentence(blocking, criteria.length),
      code: 'criteria_unmet',
    }
  }
  // D26 (reversing part of D18 for THIS gate only): a settled 'unclear' still
  // ships the task (D18's waiver, task-review.ts) — but it never authored
  // itself, and the AUTOMATIC merge is not the human who was supposed to. The
  // condition refuses until a person reads the merge request's own "To
  // decide" section and merges the branch by hand — which IS the decision,
  // same doctrine as every other `MERGE_BY_HAND` exit this module names.
  const open = statuses.filter((entry) => entry.status === 'unclear')
  if (open.length > 0) {
    return {
      id: 'criteria',
      satisfied: false,
      detail: criteriaJudgmentOpenSentence(open, criteria.length),
      code: 'criteria_judgment_open',
    }
  }
  return { id: 'criteria', satisfied: true, detail: null }
}

// --- condition 4: the branch is up to date with its target -----------------

/**
 * Local git, never the forge (design decision 2). Two reasons: the result stays
 * deterministic and testable without a network, and it does not depend on how
 * fresh the forge's own index is. The assumed consequence: the check speaks
 * about what THIS repository knows of the target, so a stale `fetch` yields a
 * cautious `branch_diverged` rather than an optimistic merge.
 */
function branchCondition(ancestry: BranchAncestry): MergeCondition {
  if (ancestry.kind === 'up_to_date') {
    return { id: 'branch', satisfied: true, detail: null }
  }
  if (ancestry.kind === 'behind') {
    return {
      id: 'branch',
      satisfied: false,
      detail: `this branch is behind its target '${ancestry.target}': merge or rebase the target into it and let the review run again, or ${MERGE_BY_HAND}`,
      code: 'branch_diverged',
    }
  }
  return {
    id: 'branch',
    satisfied: false,
    // The right decision, announced honestly: we refuse because we could NOT
    // establish the branch is current, which is not the same statement as
    // "it is behind" — and the sentence has to say which one it is.
    detail: `this branch could not be compared with its target '${ancestry.target}' locally (${ancestry.why}), so it could not be proven up to date — fetch the target, or ${MERGE_BY_HAND}`,
    code: 'branch_diverged',
  }
}

/**
 * DP11's derived readiness: a pure function of the record and the four facts
 * collected beside it. Nothing here reads a clock, a disk or a network, and
 * nothing here is written anywhere.
 */
export function mergeReadiness(
  record: TaskRecord,
  inputs: MergeInputs,
  settings: MergeSettings = DEFAULT_MERGE_SETTINGS,
): MergeReadiness {
  const conditions: MergeCondition[] = [
    reviewCondition(inputs.review),
    checksCondition(inputs.checks, settings),
    criteriaCondition(record, inputs.review, inputs.criteriaDraftProposed),
    branchCondition(inputs.ancestry),
  ]
  const blockers = conditions.flatMap((condition) =>
    condition.satisfied || !condition.code
      ? []
      : [taskReason(condition.code, condition.detail ?? undefined)],
  )
  return { ready: blockers.length === 0, conditions, blockers }
}

// --- collecting the four facts from disk -----------------------------------

/**
 * Whether this task's journal ever carried a turn-1 criteria draft (T3.2's
 * `criteria` / `draft_proposed` line). Tolerant by construction: an unreadable
 * journal answers `false`, which routes the refusal to `absent` — the weaker
 * of the two statements, and the one that does not credit a task with a draft
 * nothing can show.
 */
export function criteriaDraftProposed(cwd: string, id: string): boolean {
  try {
    return readTaskEvents(cwd, id).some(
      (event) => event.type === 'criteria' && event.data.name === 'draft_proposed',
    )
  } catch {
    return false
  }
}

/**
 * Where the branch stands relative to its target, from the MAIN repository —
 * branch refs are shared with the worktree, so this works even after the
 * worktree is gone.
 *
 * The target is `record.base` as written, falling back to `origin/<base>`: a
 * fork records `origin/main` while a work-on conversation records the MR's
 * target branch, and both spellings have to resolve. When neither does, the
 * answer is `unresolved` — never `behind`.
 */
export function branchAncestry(
  cwd: string,
  record: TaskRecord,
  /**
   * Test seam for the deadline below, and ONLY that: production always takes
   * the default. A test that means to prove these reads cannot hang has to
   * make git hang, and most of those tests have no reason to sit out the
   * whole real budget to say so.
   */
  timeoutMs: number = MERGE_GIT_TIMEOUT_MS,
): BranchAncestry {
  // Every read below is BOUNDED, and they all share ONE deadline: see
  // MERGE_GIT_TIMEOUT_MS for why this caller — and not `tryGit` in general —
  // is the one that sets a bound, and why the budget is total. `max(1, …)`
  // rather than 0: `timeout: 0` means "no timeout" to child_process, so a
  // spent budget must round up to the smallest real bound, never down to none.
  const deadline = Date.now() + timeoutMs
  const bounded = (): { timeoutMs: number } => ({
    timeoutMs: Math.max(1, deadline - Date.now()),
  })
  const bare = record.base.replace(/^origin\//, '')
  const target = [record.base, `origin/${bare}`, bare].find((ref) => refExists(ref, cwd, bounded()))
  if (!target) {
    return {
      kind: 'unresolved',
      target: record.base,
      why: 'the target ref is not in this repository',
    }
  }
  if (!refExists(record.branch, cwd, bounded())) {
    return {
      kind: 'unresolved',
      target,
      why: `the branch ref '${record.branch}' is not in this repository`,
    }
  }
  // "Up to date" is exactly "the target is already an ancestor of the branch
  // tip": everything on the target is in the branch, so merging adds no
  // surprise the review never saw.
  return isAncestor(target, record.branch, cwd, bounded())
    ? { kind: 'up_to_date', target }
    : { kind: 'behind', target }
}

/** The four facts, collected from disk. Tolerant everywhere: no read here throws. */
export function readMergeInputs(cwd: string, record: TaskRecord): MergeInputs {
  return {
    review: readTaskReview(cwd, record.id),
    checks: readTaskChecks(cwd, record.id),
    criteriaDraftProposed: criteriaDraftProposed(cwd, record.id),
    ancestry: branchAncestry(cwd, record),
  }
}

// --- the merge call --------------------------------------------------------

/**
 * Strategy flag per forge CLI, verified against gh 2.46.0 and glab 1.53.0 —
 * the same versions `task-ship.ts` pins its own flags to.
 *
 * `null` is a documented ASYMMETRY, not an omission (D8's spirit: name them
 * rather than paper over them). `gh pr merge` can force a merge commit with
 * `--merge`; `glab mr merge` has no equivalent flag, so `mergeStrategy:
 * 'merge'` sends glab no option and the project's own configured merge method
 * applies. Squash and rebase are available on both.
 */
const STRATEGY_FLAG: Record<'gh' | 'glab', Record<MergeStrategy, string | null>> = {
  gh: { merge: '--merge', squash: '--squash', rebase: '--rebase' },
  glab: { merge: null, squash: '--squash', rebase: '--rebase' },
}

type MergeCandidate = { cli: 'gh' | 'glab'; args: string[] }

/**
 * Merge commands, in probe order — same origin-hint selection rule as the
 * ship's `forgeCandidates` and the MR list, so an unrecognized (self-hosted)
 * remote tries both.
 *
 * Two deliberate absences and one deliberate presence:
 *
 *  - NO strategy option when `mergeStrategy` is unset (D13). The convention
 *    belongs to the repository, and passing one on its behalf is a choice
 *    nobody made. The gh-side consequence is real and documented: a GitHub
 *    repo with several merge methods enabled refuses a non-interactive merge
 *    without one, and gh's own message says so;
 *  - NO branch deletion unless it was asked for (D13, coherent with T1.6:
 *    a branch is a deliverable);
 *  - `--auto-merge=false` on glab, whose flag DEFAULTS to true. Left alone,
 *    glab would happily register the MR for a later automatic merge and exit
 *    0, and we would journal "merged" for a merge that has not happened. The
 *    honest shape is to merge now or fail now.
 */
function mergeCandidates(
  cwd: string,
  record: TaskRecord,
  settings: MergeSettings,
): MergeCandidate[] {
  // Bounded too, and an ASSUMED WIDENING: this call is not new (the ship has
  // always made an unbounded one on its own path), but it runs in the same
  // workspace process and on the same repository as the three reads above, so
  // leaving it alone would have left the freeze reachable one step later.
  const hint = detectForgeHint(cwd, { timeoutMs: MERGE_GIT_TIMEOUT_MS })
  const candidates: MergeCandidate[] = []
  if (hint !== 'gitlab') {
    const args = ['pr', 'merge', record.branch]
    const flag = settings.strategy ? STRATEGY_FLAG.gh[settings.strategy] : null
    if (flag) {
      args.push(flag)
    }
    if (settings.deleteBranch) {
      args.push('--delete-branch')
    }
    candidates.push({ cli: 'gh', args })
  }
  if (hint !== 'github') {
    const args = ['mr', 'merge', record.branch]
    const flag = settings.strategy ? STRATEGY_FLAG.glab[settings.strategy] : null
    if (flag) {
      args.push(flag)
    }
    if (settings.deleteBranch) {
      args.push('--remove-source-branch')
    }
    args.push('--auto-merge=false', '--yes')
    candidates.push({ cli: 'glab', args })
  }
  return candidates
}

/**
 * Best-effort recognition of "this branch does not merge cleanly" in a forge
 * CLI's own words. Deliberately loose on the two phrasings both CLIs use —
 * gh says the PR "is not mergeable", glab talks about conflicts — and
 * deliberately harmless when it misses: an unrecognized failure keeps the
 * generic forge-refusal path, it never turns a real failure into a success.
 */
export function isMergeConflictError(message: string): boolean {
  return /conflict|not mergeable|cannot be merged/i.test(message)
}

/**
 * D20 idempotence guard, read-only: has the FORGE already recorded this
 * exact branch as merged? Checked ONLY after a forge merge call has already
 * failed (see its call site) — never before a fresh attempt, so an open,
 * unmerged branch pays nothing extra for the ordinary case.
 *
 * Never a local git ancestry check: a squash or rebase merge lands a NEW
 * commit on the target, one `record.branch`'s own tip is never an ancestor
 * of, so only the forge's own open/closed/merged bookkeeping can answer this
 * honestly (`branchAncestry` above answers a different question — whether
 * the TARGET is already in the branch, not the reverse).
 *
 * The unambiguous LIST form, same as prep.ts's `forgeProbes`: a NAMED branch
 * is never passed as a positional (`gh pr view 1234` / `glab mr view 1234`
 * read a purely numeric argument as a PR/MR NUMBER). `--head=`/
 * `--source-branch=` and the merged-state filters are the same flags already
 * verified against gh 2.46.0 / glab 1.53.0 elsewhere in this file
 * (`mergeCandidates`) and in prep.ts.
 *
 * Unreadable, or any shape this cannot parse, answers `false`: not proof
 * either way, so the ordinary forge failure this guards falls through and
 * surfaces exactly as it always has.
 */
async function fetchMergedProof(
  cli: 'gh' | 'glab',
  cwd: string,
  branch: string,
  execForge: ShipForgeExecFn,
): Promise<{ merged: boolean; sha: string | null }> {
  // gh's `mergeCommit` is `{oid}`; GitLab answers `merge_commit_sha`, or
  // `squash_commit_sha` when the MR landed as a squash (the other is null
  // then). One list call answers both "is it merged" and "as what commit".
  const args =
    cli === 'gh'
      ? [
          'pr',
          'list',
          `--head=${branch}`,
          '--state',
          'merged',
          '--limit',
          '1',
          '--json',
          'number,mergeCommit',
        ]
      : [
          'mr',
          'list',
          `--source-branch=${branch}`,
          '--merged',
          '--per-page',
          '1',
          '--output',
          'json',
        ]
  const outcome = await execForge(cli, args, cwd)
  if (outcome.kind !== 'ok') {
    return { merged: false, sha: null }
  }
  try {
    const data: unknown = JSON.parse(outcome.stdout)
    if (!Array.isArray(data) || data.length === 0) {
      return { merged: false, sha: null }
    }
    const entry = data[0] as {
      mergeCommit?: { oid?: unknown } | null
      merge_commit_sha?: unknown
      squash_commit_sha?: unknown
    }
    const candidate =
      cli === 'gh' ? entry.mergeCommit?.oid : (entry.merge_commit_sha ?? entry.squash_commit_sha)
    return { merged: true, sha: sanitizeArmSha(candidate) ?? null }
  } catch {
    return { merged: false, sha: null }
  }
}

/**
 * Files the merge touched, best-effort: a plain two-tree diff between
 * `target` (the branch's base, resolved BEFORE the forge call by
 * `branchAncestry` and untouched locally since, no fetch runs in between) and
 * the landed `mergeSha`. A tree diff rather than a range on ancestry on
 * purpose: it reads the same regardless of merge strategy (merge commit,
 * squash, rebase), where `target...mergeSha` would not for a squash. `null`
 * on any git failure (an `unresolved` target that named no real ref,
 * `mergeSha` from a remote this clone never fetched, a timeout): the hub
 * report this feeds is never blocked on it, see `reportMergedWithProof`.
 */
function mergedChangedFiles(cwd: string, target: string, mergeSha: string): string[] | null {
  const out = tryGit(['diff', '--name-only', target, mergeSha], cwd, {
    timeoutMs: MERGE_GIT_TIMEOUT_MS,
  })
  if (out === null) {
    return null
  }
  const files = out.split('\n').filter((line) => line.trim().length > 0)
  return files.length > 0 ? files : null
}

/**
 * Reports `merged` to the hub WITH its proof, or says out loud why it will
 * not: a landed merge whose commit the forge did not answer with is journaled
 * as `merged_sha_unknown` and never posted: `merged` without `merge_sha` is
 * exactly the phantom-state shape the contract refuses, and the hub's own
 * forge webhook (which carries the sha) reconciles the ticket instead.
 *
 * `changed_files` rides along best-effort (D-contrat: the hub uses it to mark
 * a repo's runbook stale when a `depends_on_files` path changed). Computed
 * from `target`, the merge's own base as `branchAncestry` resolved it — never
 * required, and a git failure here never withholds the `merged` report
 * itself, only the one field that depended on it.
 */
function reportMergedWithProof(params: {
  opts: MergeTaskOptions
  cli: 'gh' | 'glab'
  sha: string | null
  /** The merge's own base, as `branchAncestry` resolved it — see `mergedChangedFiles`. */
  target: string
  events: AppendTaskEventInput[]
}): void {
  const { opts, cli, sha, target, events } = params
  if (!opts.task.hub_ticket) {
    return
  }
  if (!sha) {
    events.push({
      type: MERGE_EVENT,
      data: {
        name: 'merged_sha_unknown',
        cli,
        branch: opts.task.branch,
        message:
          'merge landed but the forge did not answer with the merge commit; hub report skipped, the forge webhook reconciles the ticket',
      },
    })
    return
  }
  const changedFiles = mergedChangedFiles(opts.cwd, target, sha)
  const reportHub = opts.reportHub ?? reportHubTransition
  void reportHub(opts.cwd, opts.task, {
    type: 'merged',
    branch: opts.task.branch,
    merge_sha: sha,
    ...(changedFiles ? { changed_files: changedFiles } : {}),
  })
}

// --- outcome ---------------------------------------------------------------

export type MergeOutcome = {
  readiness: MergeReadiness
  /** Journal lines the caller appends and broadcasts, in the order they happened. */
  events: AppendTaskEventInput[]
} & (
  | {
      /** The branch is in its target. THIS is the fact T3.5's issue closing and T3.7's `merged` label hang off. */
      kind: 'merged'
      cli: 'gh' | 'glab'
      url: string | null
    }
  /** `mergePolicy: 'human'`: the four conditions were evaluated and nothing was called. */
  | { kind: 'held' }
  /** A condition is missing: the reason is the FIRST one, in D12's order. */
  | { kind: 'refused'; reason: TaskReason }
  /** The four conditions held and the forge did not merge: a conflict, no CLI, a refusal of its own. */
  | { kind: 'failed'; reason: TaskReason }
)

export type MergeTaskOptions = {
  /** MAIN repo root: the forge CLI runs here, never in the (possibly gone) worktree. */
  cwd: string
  task: TaskRecord
  settings: MergeSettings
  /**
   * Arm/runner integration: `runnerAutoMerge` (config.ts), resolved by the
   * CALLER from the global config alone and handed in as a plain value.
   * GLOBAL-ONLY, same doctrine as every field of `settings` above; this
   * module never reads config itself, so the boundary between "the workspace
   * resolved a setting" and "a repo could sneak one past this gate" cannot
   * blur here. `true` (a hub-ticket task's own consent OVERRIDES
   * `mergePolicy` to `'auto'` for that task only) is the caller's honest
   * default when nothing configures it either way.
   */
  runnerAutoMerge: boolean
  /** Test seam: the four facts. Omitted, they are collected from disk by `readMergeInputs`. */
  inputs?: MergeInputs
  /** Test seam: the default runs a real gh / glab. */
  execForge?: ShipForgeExecFn
  /**
   * Test seam for the `merged` report only (`reportMergedWithProof`): the
   * default is the real `reportHubTransition`, which needs sync credentials
   * and a network call this module has no other way to observe from a test.
   */
  reportHub?: typeof reportHubTransition
  /** Merge keys present in the config but unusable — journaled, never absorbed. */
  degradedKeys?: readonly string[]
}

/** One journal line per condition, satisfied or not. See the module header. */
function conditionEvents(readiness: MergeReadiness): AppendTaskEventInput[] {
  return readiness.conditions.map((condition) => ({
    type: MERGE_EVENT,
    data: {
      name: condition.consented
        ? 'condition_consented'
        : condition.satisfied
          ? 'condition_met'
          : 'condition_unmet',
      condition: condition.id,
      satisfied: condition.satisfied,
      // Only when there is one: an empty key on every line is noise, and its
      // absence already reads as "nothing to add".
      ...(condition.discriminant ? { detail: condition.discriminant } : {}),
      // The readable half of the story travels with the line, beside the code
      // — never instead of it (invariant n° 2). The web renders the line from
      // `data.name` through its own translated key, so this is the payload a
      // human reads when they open the raw journal, not the UI's label.
      ...(condition.detail ? { message: condition.detail } : {}),
    },
    ...(condition.code && !condition.satisfied ? { reason_code: condition.code } : {}),
  }))
}

const forgeOutcomeMessage = (outcome: Extract<ShipCliOutcome, { kind: 'error' }>): string =>
  outcome.message.slice(0, MERGE_ERROR_MAX)

/**
 * Whether the policy this call actually merges under — `opts.settings.policy`
 * after the SAME runner override `mergeTask` applies below — is `'auto'`.
 *
 * Arm/runner integration: a hub-ticket task's own consent (`runnerAutoMerge`,
 * GLOBAL-ONLY, default true, resolved by the caller and handed in as a plain
 * value) OVERRIDES `mergePolicy` to `'auto'` for THIS task only: the
 * workspace-wide setting, and every task that carries no `hub_ticket`, are
 * untouched. Never the other direction: a repo that explicitly wants
 * `mergePolicy: 'auto'` for every task keeps that regardless of
 * `runnerAutoMerge`.
 *
 * Exported (D20) so a caller can ask the SAME question `mergeTask` is about
 * to answer BEFORE calling it — `task-server.ts`'s `ship()` reads it to
 * decide whether the merge about to run is worth a `cycle_step: 'merge'`
 * marker — without a second, drifting copy of this exact calculation.
 */
export function effectiveMergePolicyIsAuto(
  task: TaskRecord,
  settings: MergeSettings,
  runnerAutoMerge: boolean,
): boolean {
  return settings.policy === 'auto' || Boolean(task.hub_ticket && runnerAutoMerge)
}

/**
 * Evaluate, then — only under `mergePolicy: 'auto'`, and only on four
 * satisfied conditions — merge.
 *
 * `human` is NOT a degraded mode: it runs the very same evaluation and writes
 * the very same four journal lines, and stops before the call. That is what
 * lets someone watch the gate decide for a while before authorizing it.
 *
 * Never throws: a forge that refuses, a CLI that is not installed, a conflict
 * — all come back as an outcome the caller states.
 */
export async function mergeTask(opts: MergeTaskOptions): Promise<MergeOutcome> {
  const settings: MergeSettings = effectiveMergePolicyIsAuto(
    opts.task,
    opts.settings,
    opts.runnerAutoMerge,
  )
    ? { ...opts.settings, policy: 'auto' }
    : opts.settings
  const inputs = opts.inputs ?? readMergeInputs(opts.cwd, opts.task)
  const readiness = mergeReadiness(opts.task, inputs, settings)
  const events: AppendTaskEventInput[] = []
  if (opts.degradedKeys && opts.degradedKeys.length > 0) {
    // A config value that was present and unusable never merely disappears
    // into its default (invariant n° 2): it is named on the task's own
    // journal as well as on the boot line.
    events.push({
      type: MERGE_EVENT,
      data: {
        name: 'config_degraded',
        keys: opts.degradedKeys.join(', '),
        message: `unusable merge setting(s) ignored, defaults applied: ${opts.degradedKeys.join(', ')}`,
      },
    })
  }
  events.push(...conditionEvents(readiness))

  // The POLICY is read before the verdict, and that order is deliberate.
  // Under 'human' — the default — the gate has evaluated and said everything
  // it has to say, and it REFUSES nothing: nobody asked it to merge, so
  // turning a shipped task into "needs you" would be a refusal invented on
  // the user's behalf. The caller leaves the record exactly as it found it.
  if (settings.policy !== 'auto') {
    events.push({
      type: MERGE_EVENT,
      data: {
        name: 'policy_human',
        ready: readiness.ready,
        message: readiness.ready
          ? "every merge condition is satisfied; mergePolicy is 'human', so the merge is yours to make"
          : `${readiness.blockers.length} merge condition(s) are not satisfied; mergePolicy is 'human', so nothing was attempted either way`,
      },
    })
    return { kind: 'held', readiness, events }
  }
  if (!readiness.ready) {
    // The FIRST missing condition, in D12's order — stable and reproducible
    // for the same task, which a "whichever finished last" rule would not be.
    const reason = readiness.blockers[0] as TaskReason
    events.push({
      type: MERGE_EVENT,
      data: {
        name: 'refused',
        policy: settings.policy,
        terminal: isTerminalReason(reason.code),
        ...(reason.detail ? { message: reason.detail } : {}),
      },
      reason_code: reason.code,
    })
    return { kind: 'refused', reason, readiness, events }
  }
  if (!settings.strategy) {
    // Refused BEFORE any forge CLI runs (recovery doctrine, rung 0/3): a
    // strategy nobody configured is never defaulted on their behalf (D13),
    // and a blind non-interactive `gh pr merge` on a multi-method repo fails
    // with gh's own flag demand anyway. One named refusal that carries the
    // way out beats a raw forge error read as `forge_unreachable`.
    const reason = taskReason(
      'merge_strategy_unconfigured',
      'auto-merge refused: no mergeStrategy configured. Set one (codesema config, or the runner settings API), then retry the merge',
    )
    events.push({
      type: MERGE_EVENT,
      data: {
        name: 'refused',
        policy: settings.policy,
        terminal: isTerminalReason(reason.code),
        ...(reason.detail ? { message: reason.detail } : {}),
      },
      reason_code: reason.code,
    })
    if (opts.task.hub_ticket) {
      void reportHubTransition(opts.cwd, opts.task, {
        type: 'failed',
        error_message: reason.detail ?? 'auto-merge refused: no mergeStrategy configured',
      })
    }
    return { kind: 'refused', reason, readiness, events }
  }

  const execForge = opts.execForge ?? ((cli, args, cwd) => execCli(cli, args, cwd))
  let note: string | null = null
  for (const candidate of mergeCandidates(opts.cwd, opts.task, settings)) {
    const outcome = await execForge(candidate.cli, candidate.args, opts.cwd)
    if (outcome.kind === 'missing') {
      continue
    }
    if (outcome.kind === 'error') {
      const message = forgeOutcomeMessage(outcome)
      if (isMergeConflictError(message)) {
        // A conflict is a fact about the branch, not about the CLI: there is
        // nothing for the other candidate to answer differently. Nothing is
        // rebased, reset or deleted — branch and worktree are left exactly as
        // they are, and a human resolves the overlap.
        const reason = taskReason(
          'merge_conflict',
          `${candidate.cli}: ${message} — resolve the overlap on the branch; nothing was rebased, reset or deleted`,
        )
        events.push({
          type: MERGE_EVENT,
          data: { name: 'failed', cli: candidate.cli, message: reason.detail ?? message },
          reason_code: 'merge_conflict',
        })
        if (opts.task.hub_ticket) {
          void reportHubTransition(opts.cwd, opts.task, {
            type: 'failed',
            error_message: reason.detail ?? message,
          })
        }
        return { kind: 'failed', reason, readiness, events }
      }
      // D20 idempotence: a crash between an EARLIER attempt's forge merge
      // landing and this process recording it resumes here on the SAME
      // branch, and the forge's own refusal (already merged, the PR/MR no
      // longer open) reads exactly like any other error — never a conflict,
      // so it never took the branch above. Asked here, not before the call:
      // see fetchMergedProof's own header for why the cost is paid only
      // once a fresh attempt has already failed.
      const priorProof = await fetchMergedProof(
        candidate.cli,
        opts.cwd,
        opts.task.branch,
        execForge,
      )
      if (priorProof.merged) {
        events.push({
          type: MERGE_EVENT,
          data: {
            name: 'merged',
            cli: candidate.cli,
            branch: opts.task.branch,
            already_merged: true,
            ...(priorProof.sha ? { sha: priorProof.sha } : {}),
          },
        })
        reportMergedWithProof({
          opts,
          cli: candidate.cli,
          sha: priorProof.sha,
          target: inputs.ancestry.target,
          events,
        })
        return { kind: 'merged', cli: candidate.cli, url: null, readiness, events }
      }
      // Keep trying (a dual-remote setup may have the other CLI working) but
      // remember the failure: it is the honest note if nothing else succeeds.
      note = `${candidate.cli} failed: ${message}`
      continue
    }
    const url = extractMrUrl(outcome.stdout)
    // Neither `gh pr merge` nor `glab mr merge` hands the merge commit back
    // on its own output, and `merged` without its sha is a claim the
    // contract refuses, so the proof is read back from the forge in one
    // bounded follow-up call (the same list read the idempotence guard uses).
    const proof =
      opts.task.hub_ticket === undefined
        ? { merged: true, sha: null }
        : await fetchMergedProof(candidate.cli, opts.cwd, opts.task.branch, execForge)
    events.push({
      type: MERGE_EVENT,
      data: {
        name: 'merged',
        cli: candidate.cli,
        branch: opts.task.branch,
        strategy: settings.strategy ?? 'forge default',
        deleted_branch: settings.deleteBranch,
        ...(url ? { url } : {}),
        ...(proof.sha ? { sha: proof.sha } : {}),
      },
    })
    reportMergedWithProof({
      opts,
      cli: candidate.cli,
      sha: proof.sha,
      target: inputs.ancestry.target,
      events,
    })
    return { kind: 'merged', cli: candidate.cli, url, readiness, events }
  }

  // Either a forge CLI ran and refused for its own reason, or none is
  // installed. Both are `forge_unreachable`, which the D2 table defines as
  // "no gh/glab available, no network, an API that refused" — retryable, and
  // rightly so: the branch and the open MR are untouched, and the same call
  // succeeds once the CLI is there or the forge stops refusing. It differs
  // from the SHIP's choice to leave a per-CLI failure uncoded because the
  // ship had already succeeded by then; here, nothing happened.
  const reason = taskReason(
    'forge_unreachable',
    note ??
      'no forge CLI (gh or glab) available — the merge request is open, merge it from the forge',
  )
  events.push({
    type: MERGE_EVENT,
    data: { name: 'failed', message: reason.detail ?? 'the merge could not be performed' },
    reason_code: 'forge_unreachable',
  })
  if (opts.task.hub_ticket) {
    void reportHubTransition(opts.cwd, opts.task, {
      type: 'failed',
      error_message: reason.detail ?? 'the merge could not be performed',
    })
  }
  return { kind: 'failed', reason, readiness, events }
}
