// Mirrors the CLI contract types by hand (packages/cli/src/contract.ts).

import type { Finding } from './composables/useDiff'

export type NarrativeStep = {
  title: string
  rationale: string
  files: string[]
  finding_refs: number[]
  risk?: 'high' | 'medium' | 'low'
  take?: string
  check?: string | null
}

/** Step normalized for display (check: null becomes undefined; see ReviewShell). */
export type StepView = Omit<NarrativeStep, 'check'> & { check?: string | undefined }

export type ReviewFirstItem = {
  point: string
  risk: 'high' | 'medium' | 'low'
  step_ref: number | null
  file: string | null
}

export type ReviewNarrative = {
  intent: string
  confidence: 'high' | 'medium' | 'low'
  prologue?: {
    why: string
    what: string
    key_changes: { title: string; detail: string }[]
  }
  steps: NarrativeStep[]
  review_first: ReviewFirstItem[]
}

export type DualStats = {
  merged: number
  rejected: number
  added_by_b: number
}

export type ReviewRecord = {
  version: 1
  meta: {
    title: string
    branch: string
    target: string
    merge_base: string
    /** HEAD at review time (absent on older archives). */
    head_sha?: string
    repo_root: string
    created_at: string
    /** Present when the review was produced by a dual (two reviewers + judge) run. */
    dual?: DualStats
  }
  commits: string[]
  diff: string
  review: {
    verdict: 'approve' | 'request_changes' | 'comment'
    summary: string
    findings: Finding[]
    narrative: ReviewNarrative | null
  }
}

// Mirrors packages/cli/src/serve.ts and partial.ts.

export type LiveInput = {
  branch: string
  target: string
  commits: string[]
  files: { path: string; previousPath?: string; additions: number; deletions: number }[]
  additions: number
  deletions: number
  incremental: boolean
}

export type LiveMode = 'simple' | 'dual'

export type LiveStatus = {
  phase: 'reviewing' | 'judging' | 'done' | 'error'
  started_at: string
  mode?: LiveMode
  agent?: string
  input?: LiveInput
  error?: string
}

// Mirrors packages/cli/src/dual.ts (JudgeDecision) and serve.ts (JudgeLive).

export type JudgeDecision = {
  id: string
  action: 'keep' | 'reject'
  duplicate_of?: string
  reason?: string
  severity?: 'critical' | 'major' | 'minor' | 'info'
}

/** Cumulative: each event carries every decision made so far. */
export type JudgeLive = {
  total: number
  decisions: JudgeDecision[]
}

// Mirrors packages/cli/src/fix.ts (FixStatus) and the /api/fix endpoints.

export type FixStatus =
  | { available: false }
  | {
      available: true
      phase: 'idle' | 'running' | 'done' | 'error'
      selected: number[]
      started_at?: string
      summary?: string
      error?: string
      head_moved: boolean
    }

export type PartialFinding = {
  file: string
  message: string
  title?: string
  severity?: string
  kind?: string
  line?: number
}

export type PartialReview = {
  verdict?: 'approve' | 'request_changes' | 'comment'
  summary?: string
  intent?: string
  findings: PartialFinding[]
  stepTitles: string[]
}

// Mirrors packages/cli/src/forge-mrs.ts and the /api/mrs endpoint.

export type ForgeMr = {
  number: number
  title: string
  author: string
  sourceBranch: string
  targetBranch: string
  updatedAt: string
  url: string
}

export type ForgeMrsResult =
  | { available: true; mrs: ForgeMr[] }
  | { available: false; reason: 'no-remote' | 'no-cli' | 'cli-error' }

// Mirrors packages/cli/src/mr-review-runner.ts and the /api/mrs/review endpoints.

export type MrReviewMode = 'simple' | 'dual'

export type ReviewSource = { kind: 'mr'; number: number } | { kind: 'branch'; name: string }

export type MrReviewStatus =
  | { available: false }
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

// Mirrors packages/cli/src/branches.ts and the /api/branches endpoint.

export type LocalBranch = {
  name: string
  lastCommitRelative: string
  subject: string
  isCurrent: boolean
  worktreePath: string | null
}

// Mirrors packages/cli/src/preview.ts and the /api/preview* endpoints.

export type PreviewFileStatus = 'added' | 'deleted' | 'modified' | 'renamed'

export type PreviewFile = {
  path: string
  /** Source path of a rename or copy. */
  previousPath?: string
  additions: number
  deletions: number
  status: PreviewFileStatus
}

export type PreviewResult = {
  branch: string
  target: string
  commits: string[]
  files: PreviewFile[]
  diffStats: { files: number; additions: number; deletions: number }
}

export type PreviewFileDiff = { diff: string; truncated: boolean }

// Mirrors packages/contract/src/tasks.ts (task workspace contract) and
// packages/cli/src/task-server.ts (SSE envelope). Kept by hand like the rest
// of this file.

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_you'
  | 'reviewing'
  | 'review_ok'
  | 'review_ko'
  | 'shipped'
  | 'failed'
  | 'interrupted'

/**
 * Ticks in one US dollar: `cost_ticks` is counted in ticks, 1 tick = 1e-10 USD
 * (mirrors packages/contract/src/tasks.ts). Money travels as a non-negative
 * integer, never as a float.
 */
export const TICKS_PER_USD = 10_000_000_000

/**
 * WHERE a cost figure comes from (mirrors packages/contract/src/tasks.ts).
 *
 * - 'harness': the agent harness's own estimate of the run, covering output,
 *   cache and subagents — an ESTIMATE from its bundled price table, not an
 *   invoice.
 * - 'lower_bound': computed by the CLI over input and cache tokens only, at
 *   published first-party rates. Everything omitted is positive, so the real
 *   bill is this figure OR MORE.
 *
 * Anything the UI ever shows must be able to say which of the two it is.
 */
export type CostBasis = 'harness' | 'lower_bound'

export type TaskTurn = {
  prompt: string
  response: string | null
  question: string | null
  started_at: string
  ended_at: string | null
  /** Total LLM tokens of the turn, when the agent stream reported usage. */
  tokens?: number
  /**
   * What the turn cost, as a non-negative INTEGER of ticks (see
   * TICKS_PER_USD), counted by the CLI from the stream's token counters.
   * ABSENT means UNKNOWN — never `0`, and never rendered as "0 $": a turn
   * without this field shows no cost at all.
   */
  cost_ticks?: number
  /**
   * Provenance of `cost_ticks` (see CostBasis). Absent whenever the figure is
   * — a provenance with no number behind it describes nothing.
   */
  cost_basis?: CostBasis
}

export type TaskEventType =
  | 'turn_started'
  | 'tool_use'
  | 'tool_result'
  | 'message'
  | 'question'
  | 'commit'
  | 'review_started'
  | 'review_done'
  | 'checks'
  | 'shipped'
  | 'error'
  | 'interrupted'
  /** Isolation decided for the task at creation, with the reason behind it. */
  | 'isolation'
  /**
   * Something worth stating about what a turn COST, or why no figure could be
   * established. A NEUTRAL line, never an error: a gap in the accounting is
   * not a failure of the work. The distinct cause is named in `data.name`.
   */
  | 'cost'
  /**
   * A fact about a task's BRANCH that stops nothing and qualifies no D2 code
   * (T1.6, DP14): a declined rename, a branch kept because it carries a
   * commit of its own, or the anchor fallen back to. NEUTRAL, never
   * 'message' (routed as a chat bubble, backed by the turn's full text) nor
   * 'error'. The cause is named in `data.name`, same doctrine as `cost`.
   */
  | 'branch'

/**
 * The closed vocabulary of degradations (mirrors packages/contract/src/reasons.ts,
 * decision D2). Widened with `string` on purpose: a code minted by a NEWER
 * server must arrive as an unknown token the UI ignores, never as a type error
 * nor as a label it invents. Extensible, never renamed.
 */
export type ReasonCode =
  | 'checks_failed'
  | 'review_blocked'
  | 'criteria_unmet'
  | 'merge_conflict'
  | 'branch_diverged'
  | 'agent_error'
  | 'inactivity_timeout'
  | 'interrupted_by_user'
  | 'resource_busy'
  | 'forge_unreachable'

/** A degradation, fully stated: the code plus the producer's own message. */
export type TaskReason = {
  code: ReasonCode | string
  /** The readable message the code names; never replaced by it. */
  detail?: string
}

/** How a task's agent turns are contained (mirrors the contract). */
export type TaskIsolation = 'container' | 'policy'

/** What the workspace config ASKED for (mirrors the CLI's IsolationMode). */
export type IsolationMode = 'auto' | 'container' | 'policy'

/** Flat, bounded payload: summaries only, never a full file body. */
export type TaskEventData = Record<string, string | number | boolean | null>

export type TaskEvent = {
  seq: number
  at: string
  type: TaskEventType
  data: TaskEventData
  /** Names the degradation this event reports; absent on events that report
   * none and on journal lines written before the field existed. Its own field,
   * never a key of `data` — the payload keeps carrying the readable message. */
  reason_code?: ReasonCode | string
}

export type TaskRecord = {
  version: 1
  id: string
  title: string
  status: TaskStatus
  base: string
  branch: string
  worktree: string
  /** Commit the agent's work is measured FROM (`baseline_sha..HEAD`): the start
   * point of the conversation, write-once. Absent on records written before it
   * existed — consumers fall back on `base...HEAD` and say so. */
  baseline_sha?: string
  /** True when this conversation created its branch head. Absent = it was already
   * there (or unknown), which is the only safe reading before deleting a branch. */
  created_branch?: boolean
  /** Tip this conversation last left on its branch, so a rebuild can tell its own
   * work from commits a third party pushed while the worktree was gone. Absent on
   * records that never knew it. */
  head_sha?: string
  agent_session_id: string | null
  turns: TaskTurn[]
  review_ref: string | null
  /** Time spent working; waiting_for_you time never counts as work. */
  work_ms: number
  wait_ms: number
  auto_ship: boolean
  /** True when the conversation works directly ON its branch (no forked codesema/task-*). */
  work_on?: boolean
  /** Containment of the task's turns, fixed at creation. Absent on older records = 'policy'. */
  isolation?: TaskIsolation
  /** Why the task is where it is, when that is a degradation. Absent on
   * records written before reason codes existed, and on tasks nothing went
   * wrong with — absence claims nothing. */
  reason?: TaskReason
  /** Last liveness beat of the task's agent (ISO-8601), written by the semantic
   * watchdog. Tells a LONG task from a DEAD one: `updated_at` only moves when
   * something happens. Only meaningful while `running` (a starting turn clears
   * it); absent = nothing known, never "dead". */
  heartbeat_at?: string
  /**
   * Running total of the task's cost: the sum of the `cost_ticks` its turns
   * carry, same unit. ABSENT means UNKNOWN (records written before the field
   * existed, tasks not one of whose turns could be priced) — the UI renders
   * nothing then, and above all not "0 $".
   */
  cost_ticks?: number
  /**
   * How many turns that total covers. A partial total is only honest if its
   * coverage is legible next to it. Absent whenever `cost_ticks` is.
   */
  cost_turns?: number
  /**
   * Provenance of the total (see CostBasis), derived from the turns it sums:
   * 'harness' only when every covered turn is. Absent whenever `cost_ticks`
   * is.
   */
  cost_basis?: CostBasis
  /** 1-based place in its project's queue while the task waits its turn (one
   * active task per project). Derived server-side at read time and never
   * persisted, so it rides the listings (GET /api/tasks, the SSE replay) and
   * not every 'task' frame — absent means "not waiting", or "this frame does
   * not restate it". */
  queue_position?: number
  created_at: string
  updated_at: string
}

// Mirrors the checks contract (packages/contract) and the
// /api/tasks/:id/checks endpoints: sandboxed typecheck/tests/lint runs
// executed by codesema in an ephemeral container mounted on the worktree.

/** Whole-run status; 'unconfigured' = nothing to run for this repo. */
export type TaskChecksStatus = 'running' | 'passed' | 'failed' | 'error' | 'unconfigured'

/** One command's outcome; 'skipped' = never ran (an earlier step failed). */
export type TaskCheckStatus = 'passed' | 'failed' | 'timeout' | 'skipped'

export type TaskCheck = {
  command: string
  status: TaskCheckStatus
  exit_code: number | null
  duration_ms: number
  /** Last ~4000 chars of interleaved stdout+stderr. */
  tail: string
}

/** Where the executed plan came from: the repo's explicit .codesema config,
 * its own lefthook/CI declarations, else the lockfile/scripts heuristic.
 * OPTIONAL on the wire — a checks.json written before the field existed (or a
 * run that resolved no plan) carries none, and consumers then show nothing. */
export type TaskChecksSource = 'config' | 'lefthook' | 'ci' | 'scripts'

/** The persisted checks.json of a task (.codesema/tasks/<id>/checks.json). */
export type TaskChecks = {
  /** Commit the checks ran against. */
  head_sha: string
  started_at: string
  finished_at: string | null
  status: TaskChecksStatus
  checks: TaskCheck[]
  /** Human-readable failure of the runner itself (e.g. no container engine). */
  error: string | null
  /** Provenance of the plan; absent on older servers and on runs that
   * resolved no plan. Widened to string on purpose: a future level would
   * arrive as an unknown token, which readers must ignore, not render. */
  source?: TaskChecksSource | string
}

// Mirrors the ticket contract (packages/contract/src/ticket.ts, decision D6):
// a ticket is a title — the task's — plus a body of five sections whose
// acceptance criteria are a structured list.

/**
 * One acceptance criterion. `id` is derived from `text` and never from the
 * position in the list: reordering or inserting a criterion renames nothing, so
 * a verdict already emitted keeps pointing at what it actually judged.
 */
export type AcceptanceCriterion = {
  /** `ac-` plus 12 lowercase hex chars, derived from `text`. */
  id: string
  text: string
}

/** The closed outcome of judging one acceptance criterion (DP12). */
export type CriterionStatus = 'met' | 'unmet' | 'unclear'

/**
 * One criterion's verdict (DP12): a single shape shared by ReviewRecord (T3.2)
 * and RecapRecord's `criteria[]` below, so a verdict written by one is
 * readable by the other. `criterion_id` NAMES the criterion
 * (AcceptanceCriterion.id); it does not carry the criterion's own wording — a
 * verdict travels beside the ticket that names it, except in a recap, which
 * denormalizes `text` on top of this shape (see RecapCriterionVerdict).
 */
export type CriterionVerdict = {
  criterion_id: string
  status: CriterionStatus
  /** The reviewer's own quoted grounding for the status. */
  evidence?: string
}

/** The five sections of a ticket body (mirrors the contract). */
export type TicketBody = {
  version: 1
  context: string
  goal: string
  scope: string
  acceptance_criteria: AcceptanceCriterion[]
  out_of_scope: string
}

/**
 * What the deterministic lint found wrong with a body it refused. Widened with
 * `string` on purpose, like ReasonCode: a code minted by a NEWER server must
 * arrive as an unknown token the UI ignores, never as a label it invents.
 */
export type TicketProblemCode =
  | 'body_not_text'
  | 'section_missing'
  | 'section_duplicated'
  | 'section_empty'
  | 'section_too_long'
  | 'criteria_not_a_list'
  | 'criteria_too_few'
  | 'criteria_too_many'
  | 'criteria_duplicated'
  | 'criterion_not_ears'
  | 'criterion_too_long'

/** One reason a launch was refused: the readable message, plus the code that names it. */
export type TicketProblem = {
  code: TicketProblemCode | string
  /** The readable message; the code is added to it, never a stand-in for it. */
  message: string
  /**
   * The section at fault, when the problem is about one. Plain `string` rather
   * than the five headings, for the same reason `code` is widened: a section a
   * NEWER server names must arrive as a token the UI shows verbatim, never as a
   * type error nor as a heading it invents.
   */
  section?: string
  /** The offending criterion's text, when the problem is about one. */
  criterion?: string
}

/**
 * One frame of the global /api/tasks/events SSE stream. Every frame is
 * project-enveloped: the workspace drives N repos over one stream.
 */
export type TaskEnvelope =
  | { project_id: string; task_id: string; event: { name: 'task'; data: TaskRecord } }
  | { project_id: string; task_id: string; event: { name: 'task_event'; data: TaskEvent } }
  // 'task_text' with a `seq` is the agent's message of that index in the
  // running turn (cumulative within the message: a new seq is a new bubble,
  // the same seq rewrites the one in flight). Without `seq` it is a bare
  // progress line — the end-of-turn review — replacing the previous one.
  | {
      project_id: string
      task_id: string
      event: { name: 'task_text'; data: { text: string; seq?: number } }
    }
  | { project_id: string; task_id: string; event: { name: 'task_meta'; data: { tokens: number } } }
  | { project_id: string; task_id: string; event: { name: 'task_checks'; data: TaskChecks } }
  // Agent-assisted checks setup: PROJECT-scoped, no task_id — the proposal
  // belongs to the repo, not to a conversation.
  | { project_id: string; event: { name: 'checks_proposal'; data: unknown } }

// Mirrors packages/cli/src/projects.ts (global project registry) and the
// /api/projects endpoints.

export type Project = {
  /** Stable 8-hex identifier of the registered repo. */
  id: string
  /** Absolute git toplevel path. */
  path: string
  /** Display name (basename of the path). */
  name: string
  added_at: string
}

/**
 * Process-wide isolation facts of the workspace, answered by GET /api/projects
 * alongside the registry: whether the container cage is usable on this machine
 * and which isolation a task created now would get. The UI must never claim a
 * containment the server did not report — a missing `workspace` (older CLI)
 * means "unknown", not "policy".
 */
export type WorkspaceInfo = {
  isolation_available: boolean
  isolation_default: TaskIsolation
  /** Why — always set by the server, so a policy fallback is never silent. */
  isolation_reason: string
  /**
   * What the config asked for. OPTIONAL: the CLI does not expose it today, so
   * consumers treat it as "may be absent" and only use it to STAY QUIET (an
   * explicit 'policy' choice is not something to nag about).
   */
  isolation_configured?: IsolationMode
}

export type ProjectsResponse = {
  projects: Project[]
  current: string | null
  /** Absent on servers predating the container cage. */
  workspace?: WorkspaceInfo
}

/** Git repo detected around the launch directory (GET /api/projects/discover). */
export type ProjectCandidate = {
  path: string
  name: string
  /** Already registered: shown as added instead of offered. */
  registered: boolean
}

export type DiscoverResponse = { candidates: ProjectCandidate[] }

// Mirrors packages/contract/src/recap.ts (T3.4, decision D10): the normalized
// task recap. Same doctrine as ReviewRecord/TaskChecks above — sanitized on
// the server, so what reaches this type is always bounded.

/**
 * `TaskCheckStatus` widened with the two whole-run states a recap must be
 * able to name honestly: 'unconfigured' (nothing detected/configured — an
 * EMPTY list here would read as "everything passed") and 'error' (the check
 * run itself could not happen). Both arrive as one synthetic entry.
 */
export type RecapTestStatus = TaskCheckStatus | 'unconfigured' | 'error'

export type RecapTestEntry = {
  command: string
  status: RecapTestStatus
  /** True ONLY on the synthetic entry for an 'unconfigured'/'error' whole run, where `command` is a readable phrase, not an actual command. Absent (never `false`) on every real check entry. */
  synthetic?: true
}

/**
 * One criterion's verdict, denormalized for a document that reads on its own
 * (DP12): `text` is the ticket's own wording, resolved by the CLI generator.
 * OPTIONAL — a verdict whose criterion could not be resolved still names a
 * real `criterion_id` and `status`, simply without a caption.
 */
export type RecapCriterionVerdict = CriterionVerdict & {
  text?: string
}

/** The normalized recap of one task (.codesema/tasks/<id>/recap.json). */
export type RecapRecord = {
  version: 1
  /** Model-authored. One of exactly three fields the model may fill — never a number, a percentage or a status (invariant 4). */
  summary: string
  /** Model-authored bullets of what changed, in words. */
  changes: string[]
  /** Model-authored bullets of the decisions taken along the way. */
  decisions: string[]
  /** Every file touched, read from the baseline..branch diff. Never from the model. */
  files: string[]
  /** One entry per check command that ran, or a synthetic entry naming an 'unconfigured'/'error' whole run. Never from the model. */
  tests: RecapTestEntry[]
  /** Per-criterion verdicts, denormalized with their text. Absent means "this task judged no criteria" — normal for a task with no linked ticket, or whose review predates per-criterion verdicts. */
  criteria?: RecapCriterionVerdict[]
  /** Total LLM tokens across the task's turns, summed by the CLI. Absent when no turn reported a count — never a free task. */
  tokens?: number
  /** The task's running cost, copied from TaskRecord.cost_ticks — never recomputed. Absent means UNKNOWN, not 0. */
  cost_ticks?: number
  cost_basis?: CostBasis
  /** The task's branch. */
  branch: string
  /** The merge/pull request URL opened at ship time. Absent before the task has shipped — never a placeholder. */
  mr_url?: string
}
