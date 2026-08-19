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
 * The ten codes of decision D2, and nothing else. Order is documentation, not
 * semantics: the five terminal ones first, then the five retryable ones.
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
