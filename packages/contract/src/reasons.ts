// Reason codes: the closed vocabulary behind every degradation codesema
// reports. Same doctrine as the rest of the contract (index.ts, tasks.ts):
// whitelist and truncate, never throw. A code is DATA that travels next to the
// human-readable message — it never replaces it: every degradation keeps its
// readable reason, its journal event and its API surfacing, and merely gains a
// machine-readable name for them.
//
// The table below is FROZEN in one direction only: a code may be ADDED, never
// renamed nor repurposed. Records, journals and HTTP bodies written months ago
// keep quoting these exact strings, and a rename would silently turn every one
// of them into an unknown code.

/**
 * Terminal or retryable, decided by one question: **does waiting change
 * anything?**
 *
 * - `terminal: true` — the WORK must change. The branch's content (or a human
 *   decision about it) is what stands in the way, so replaying the very same
 *   operation on the very same commit hits the very same wall. Consumers stop
 *   and hand back to a human.
 * - `terminal: false` — the RUN or its ENVIRONMENT must change. The work
 *   itself is intact and the same operation, attempted later or once the
 *   surroundings recover, can genuinely succeed. Consumers may offer (or take)
 *   another go.
 *
 * The classification is deliberately about *waiting*, not about *effort*: a
 * conflict is terminal even though a rebase fixes it in a minute, because no
 * amount of waiting resolves it.
 */
export type ReasonCodeEntry = {
  code: string
  terminal: boolean
}

/**
 * The ten codes of decision D2, plus the two the automatic merge gate needed
 * and could not honestly borrow (T3.6, decisions DP1 and DP2), plus the
 * merge-strategy gate's own refusal code (recovery doctrine, lot 1). Order is
 * documentation, not semantics: the terminal ones first, then the retryable
 * ones.
 *
 * The extension path this table always declared is exercised HERE for the
 * first time — two codes ADDED, none renamed, none repurposed — so every
 * record, journal line and HTTP body written before this build still names a
 * code this build knows.
 */
export const REASON_CODES = [
  // --- Terminal: the work on the branch has to change ------------------------
  {
    // The repo's own checks (typecheck, tests, lint) came back red on the task
    // branch. Terminal: a failing test does not turn green on its own — the
    // commit under it must change.
    code: 'checks_failed',
    terminal: true,
  },
  {
    // The review stands in the way: a request_changes verdict, or a review that
    // could not conclude on this diff. Terminal: re-reviewing an unchanged
    // commit reaches the same verdict, so a human either fixes the findings or
    // explicitly assumes the KO.
    code: 'review_blocked',
    terminal: true,
  },
  {
    // At least one acceptance criterion of the ticket is not satisfied (D11's
    // per-criterion gate). Terminal by construction: the criteria are about
    // what the branch does, and only new work can satisfy them.
    code: 'criteria_unmet',
    terminal: true,
  },
  {
    // The branch cannot be merged into its target without resolving conflicts.
    // Terminal: waiting only lets the target drift further; someone has to
    // resolve the overlap.
    code: 'merge_conflict',
    terminal: true,
  },
  {
    // The branch is no longer up to date with its target (D12's fourth merge
    // condition). Terminal for the same reason as a conflict: a branch never
    // catches up by itself, it is rebased or merged — an action on the work,
    // not a delay.
    code: 'branch_diverged',
    terminal: true,
  },
  {
    // T3.6 / DP1: the checks condition of the automatic merge could not be
    // EVALUATED — the repository configures none ('unconfigured'), the
    // container runtime is absent or the engine failed ('runtime_error'), or
    // no finished run exists for this branch at all ('no_run'). Deliberately
    // NOT `checks_failed`: a condition that was never evaluated is not a
    // condition that failed, and telling a user their checks are red when
    // they never ran is the exact silent-lie invariant n° 2 forbids. The
    // `TaskReason.detail` keeps the producer's own sentence; the discriminant
    // above travels beside it, on the journal line.
    //
    // Terminal: waiting configures no checks and repairs no container
    // runtime. What the code asks for is a human — configure the repo's
    // checks, decide the merge by hand (`mergePolicy: 'human'`), or consent
    // in advance for a repo that legitimately has none
    // (`allowMergeWithoutChecks`, which covers 'unconfigured' only).
    code: 'checks_unavailable',
    terminal: true,
  },
  {
    // T3.6 / DP2: the automatic merge was refused because the task has no
    // acceptance criteria to be judged against — none was ever written
    // ('absent'), or a draft was proposed and never validated
    // ('pending_validation'). "All criteria are met" is vacuously true of an
    // empty list, and that is precisely the reasoning a merge must not make:
    // a task nobody wrote criteria for is a task a human still owes a word
    // on (D6). `criteria_unmet` stays RESERVED for negative verdicts the
    // T3.2 gate actually returned on criteria that exist.
    //
    // Terminal: waiting writes no criteria either. The expected action is
    // human — validate a list, or merge by hand.
    code: 'criteria_missing',
    terminal: true,
  },
  {
    // D26: at least one acceptance criterion is a judgment call the reviewer
    // could settle only as 'unclear' with a genuine question attached — never
    // `criteria_unmet`, which stays reserved for a criterion the diff itself
    // falsifies or the reviewer never judged at all. A ship carrying only
    // this kind of open criterion still SHIPS (T3.2/D18's waiver): what this
    // code blocks is the AUTOMATIC merge alone, because a human never signed
    // off on the call. Terminal: waiting settles nothing here — a human
    // reading the merge request's "To decide" section and merging the branch
    // themselves is the decision, and there is no other way to reach it.
    code: 'criteria_judgment_open',
    terminal: true,
  },
  {
    // The automatic merge was refused BEFORE any forge CLI ran because no
    // mergeStrategy is configured (recovery doctrine: a consent nobody gave
    // is not defaulted, and a blind non-interactive `gh pr merge` on a
    // multi-method repo fails with gh's own flag demand). Terminal: waiting
    // configures no strategy. The way out is one setting (mergeStrategy via
    // `codesema config` or the runner settings API), then a retried merge.
    code: 'merge_strategy_unconfigured',
    terminal: true,
  },
  // --- Retryable: the run or its environment has to change -------------------
  {
    // The agent CLI itself failed: crashed, hit its provider's rate limit,
    // returned unusable output. Retryable: the work already committed is
    // intact and running the turn again is the documented recovery.
    code: 'agent_error',
    terminal: false,
  },
  {
    // The watchdog (D3) cut a turn that went silent past its inactivity
    // budget. Retryable: the turn is resumable, and a hung run is a property
    // of that run, not of the branch.
    code: 'inactivity_timeout',
    terminal: false,
  },
  {
    // A human stopped it: Ctrl-C on the workspace, or the interrupt button.
    // Retryable, and emphatically so — the worktree and the branch survive
    // precisely so the conversation can be picked back up.
    code: 'interrupted_by_user',
    terminal: false,
  },
  {
    // Something needed was taken: the machine's parallelism cap (D4), a
    // container engine that does not answer, a branch checked out elsewhere,
    // an operation already in flight. Retryable by definition — being busy is
    // a state that ends.
    code: 'resource_busy',
    terminal: false,
  },
  {
    // The forge could not be reached: no gh/glab available, no network, an API
    // that refused. Retryable: whatever was pushed stayed pushed, and the same
    // call succeeds once the CLI is installed or the forge answers again.
    code: 'forge_unreachable',
    terminal: false,
  },
] as const satisfies readonly ReasonCodeEntry[]

/** The vocabulary itself, derived from the table so the two can never drift. */
export type ReasonCode = (typeof REASON_CODES)[number]['code']

/**
 * Bound of a reason's `detail`. Deliberately the same 2 000 as
 * `TASK_EVENT_DATA_STRING_MAX` (tasks.ts) — a reason must stay representable
 * inside a FLAT `TaskEventData` payload and inside an HTTP body — but declared
 * here as its own constant so this module depends on nothing: `tasks.ts`
 * imports this one, and a cycle between the two would be a contract that
 * cannot be loaded. `reasons.test.ts` locks the two values together.
 */
export const TASK_REASON_DETAIL_MAX = 2_000

/**
 * A degradation, fully stated: the machine-readable code, plus the ORIGINAL
 * human-readable message it came with. `detail` is optional because the code
 * alone is already honest — a reason that has no message to add simply carries
 * none, rather than inventing one.
 */
export type TaskReason = {
  code: ReasonCode
  /** The producer's own message, verbatim, truncated to TASK_REASON_DETAIL_MAX. */
  detail?: string
}

/**
 * Which of the three unevaluable cases a `checks_unavailable` names (DP1).
 * A DISCRIMINANT, not a label: it travels as a scalar on the journal line
 * beside the readable sentence, and it is never rendered to a human as-is.
 *
 * `no_run` is the one DP1 did not enumerate and this contract adds anyway: a
 * branch whose checks simply never ran is neither "this repo has no checks"
 * nor "the engine broke", and folding it into either would either let the
 * consent valve merge a branch nothing ever checked, or blame a runtime that
 * is perfectly healthy.
 */
export type ChecksUnavailableDetail = 'unconfigured' | 'runtime_error' | 'no_run'

/**
 * Which of the two absences a `criteria_missing` names (DP2): no criterion was
 * ever written for this task, or a turn-1 draft was proposed and no human ever
 * validated it. Same doctrine as `ChecksUnavailableDetail` — a discriminant on
 * the journal line, never a label.
 */
export type CriteriaMissingDetail = 'absent' | 'pending_validation'

const TERMINAL_BY_CODE: ReadonlyMap<string, boolean> = new Map(
  REASON_CODES.map((entry) => [entry.code, entry.terminal]),
)

/**
 * Whitelist for a reason code read back from disk, from the wire, or from an
 * agent. Returns null on anything absent from the table — including a code
 * from a NEWER schema: an unnamed code is dropped rather than surfaced as a
 * token no reader can label. Never throws.
 */
export function sanitizeReasonCode(raw: unknown): ReasonCode | null {
  return typeof raw === 'string' && TERMINAL_BY_CODE.has(raw) ? (raw as ReasonCode) : null
}

/**
 * The reason code carried by a thrown value (or by any object that names one),
 * whatever spelling it used. Producers write `reasonCode`; the wire, the
 * journal and anything read back from disk write `reason_code`. A consumer that
 * knew only one of the two would silently drop half the degradations it is
 * meant to surface, so the READER tolerates both while producers keep to one.
 *
 * Never throws, and returns null for anything that names no known code —
 * including a null/undefined value, or a code from a newer schema.
 */
export function reasonCodeOf(source: unknown): ReasonCode | null {
  if (typeof source !== 'object' || source === null) {
    return null
  }
  const bag = source as { reasonCode?: unknown; reason_code?: unknown }
  return sanitizeReasonCode(bag.reasonCode) ?? sanitizeReasonCode(bag.reason_code)
}

/**
 * Does waiting change anything? False when it might. An unknown code (only
 * reachable from untyped callers) answers false too: refusing to close a door
 * we cannot see is the honest default — claiming a degradation terminal is the
 * stronger, less recoverable statement of the two.
 */
export function isTerminalReason(code: ReasonCode): boolean {
  return TERMINAL_BY_CODE.get(code) ?? false
}

/**
 * Revalidates a whole reason. Null when the code is missing or unknown: a
 * reason that cannot name itself carries nothing, and the consumer falls back
 * on the readable message it always had. `detail` is dropped when empty, so an
 * absent detail and a blank one look the same downstream. Never throws.
 */
export function sanitizeTaskReason(raw: unknown): TaskReason | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  const code = sanitizeReasonCode(r.code)
  if (!code) {
    return null
  }
  const detail =
    typeof r.detail === 'string' ? r.detail.trim().slice(0, TASK_REASON_DETAIL_MAX) : ''
  return { code, ...(detail ? { detail } : {}) }
}
