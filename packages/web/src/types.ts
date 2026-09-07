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
    /**
     * DP12 / T3.2: the per-criterion verdicts this review reached. Absent on
     * every archive written before the field existed, and on every task with
     * no ticket — absence means "this review judged no criteria", never
     * "every criterion failed". Never `[]`.
     */
    criteria?: CriterionVerdict[]
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

export type ForgeMrState = 'open' | 'merged' | 'closed'

/**
 * State filter GET /api/mrs accepts (mirrors packages/cli/src/forge-mrs.ts's
 * `ForgeMrStateFilter`). Unlike issues, GitHub and GitLab agree on this
 * vocabulary: `merged` and `closed` are mutually exclusive states on both
 * forges, so no reconciliation table is needed the way `ForgeIssueStateFilter`
 * needs one below.
 */
export type ForgeMrStateFilter = ForgeMrState | 'all'

export type ForgeMrMergeable = 'mergeable' | 'conflicting' | 'unknown'

/**
 * A label as either forge attributes it: a name plus its display colour.
 * `color` is six lowercase hex digits with no leading `#`, whichever way the
 * source forge spelled it (GitHub bare, GitLab `#`-prefixed): normalised
 * once server-side rather than carried in two different shapes here. `null`
 * when the forge did not say, or said something unreadable as a colour:
 * never an empty string, never an invented default.
 */
export type ForgeLabel = {
  name: string
  color: string | null
}

/**
 * Check counts per outcome. `truncated` says the forge paginated the check
 * list and we stopped before the end: the four counts are then a floor, not a
 * total, and the UI owes the reader an aggregate signal instead of numbers it
 * cannot stand behind.
 */
export type ForgeCheckRollup = {
  passed: number
  failed: number
  pending: number
  skipped: number
  truncated: boolean
}

/**
 * Every field below `url` is enriched: `null` means "the forge did not tell
 * us", never "zero". A renderer omits the whole element rather than showing a
 * 0 that reads as a measured value. The forge probe fills what its CLI can
 * report and leaves the rest at `null`, so a field that GitLab cannot serve
 * degrades to an absent line, never to a wrong one.
 */
export type ForgeMr = {
  number: number
  title: string
  author: string
  sourceBranch: string
  targetBranch: string
  updatedAt: string
  url: string
  state: ForgeMrState | null
  isDraft: boolean | null
  labels: ForgeLabel[] | null
  additions: number | null
  deletions: number | null
  changedFiles: number | null
  checks: ForgeCheckRollup | null
  reviewers: string[] | null
  assignees: string[] | null
  milestone: string | null
  mergeable: ForgeMrMergeable | null
  commits: number | null
  body: string | null
}

/**
 * The three motifs of "the forge could not be reached" — mirrors
 * `FORGE_DEGRADATIONS` (packages/cli/src/degraded-mode.ts, D9). Named once
 * here because two payloads carry it: the MR list's own result, and the
 * workspace's `forge_reason` (see `WorkspaceInfo`). `no-cli` and `cli-error`
 * are kept apart all the way to the UI on purpose — one says "install a forge
 * CLI", the other says "the one you have failed".
 */
export type ForgeUnavailableReason = 'no-remote' | 'no-cli' | 'cli-error'

/**
 * `truncated` is never optional on the success branch, for the same reason as
 * on the issue list: both forge porcelains stop at their own page size, and a
 * caller that cannot tell a whole list from a capped one will present the cap
 * as the total.
 */
export type ForgeMrsResult =
  | { available: true; mrs: ForgeMr[]; truncated: boolean }
  | { available: false; reason: ForgeUnavailableReason }

// Mirrors packages/cli/src/forge-issues-parse.ts and the /api/issues endpoint.

export type ForgeIssueState = 'open' | 'closed'

/**
 * State filter GET /api/issues accepts (mirrors
 * packages/cli/src/forge-issues.ts's `ForgeIssueStateFilter`).
 */
export type ForgeIssueStateFilter = ForgeIssueState | 'all'

export type ForgeIssue = {
  number: number
  title: string
  /** '' is a real body, not a degradation: both forges accept a description-less issue. */
  body: string
  state: ForgeIssueState
  labels: ForgeLabel[]
  author: string
  createdAt: string
  updatedAt: string
  url: string
}

/**
 * The issue client answers with two motifs the MR probe never raises, so its
 * unavailability is a superset rather than the same union: `invalid-input`
 * (our own refusal, before any call) and `unsupported` (the forge has no such
 * operation). `detail` carries the failing CLI's own words when it has any; it
 * is added to the code, never a replacement for it.
 */
export type ForgeIssueUnavailableReason = ForgeUnavailableReason | 'invalid-input' | 'unsupported'

/**
 * `truncated` is never optional on the success branch: the forge caps a list
 * at ISSUE_LIST_MAX and a caller must never hold a capped list believing it is
 * whole. A renderer that receives it owes the reader a signal, not silence.
 */
export type ForgeIssuesResult =
  | { available: true; issues: ForgeIssue[]; truncated: boolean }
  | { available: false; reason: ForgeIssueUnavailableReason; detail?: string }

// Mirrors packages/cli/src/mr-review-runner.ts and the /api/mrs/review endpoints.

export type MrReviewMode = 'simple' | 'dual'

export type ReviewSource = { kind: 'mr'; number: number } | { kind: 'branch'; name: string }

/** `project_id` is null for a run started without `?project=` (the launch
 * directory), and names the registered project otherwise. Without it two
 * projects each holding an MR #7 would be indistinguishable here. */
export type MrReviewStatus =
  | { available: false }
  | { available: true; phase: 'idle' }
  | {
      available: true
      phase: 'running'
      project_id: string | null
      source: ReviewSource
      mode: MrReviewMode
      started_at: string
    }
  | {
      available: true
      phase: 'done'
      project_id: string | null
      source: ReviewSource
      mode: MrReviewMode
    }
  | {
      available: true
      phase: 'error'
      project_id: string | null
      source: ReviewSource
      mode: MrReviewMode
      error: string
    }

// Mirrors packages/cli/src/record.ts and the /api/reviews* endpoints.

/** One archived review, without its diff: a ReviewRecord carries the whole
 * diff, so a list of twenty would be megabytes. `ref` addresses the archive
 * on GET /api/reviews/record. */
export type ReviewArchiveSummary = {
  ref: string
  branch: string
  target: string
  created_at: string
  verdict: 'approve' | 'request_changes' | 'comment'
  mode: MrReviewMode
  findings_total: number
}

// Mirrors packages/cli/src/branches.ts and the /api/branches endpoint.

export type LocalBranch = {
  name: string
  lastCommitRelative: string
  subject: string
  isCurrent: boolean
  worktreePath: string | null
}

/** A checkout `git worktree list` reports. `branch` is null on a detached
 * HEAD, which is why this cannot be derived from LocalBranch: that one walks
 * refs/heads, where a detached worktree has no entry at all. */
export type GitWorktree = {
  path: string
  branch: string | null
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

// Mirrors packages/contract/src/proof-intent.ts
export type ProofIntentKind = 'none' | 'screenshot' | 'journey'

export type ProofIntent = {
  kind: ProofIntentKind
  reason: string
  pages?: string[]
  journey?: string
}

export type ProofReview = {
  expected: ProofIntentKind
  coherent: boolean
  reason: string
}

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
  proof_intent?: ProofIntent
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
   * A local resource of the task (its HOME volume) was released, or could
   * not be. A NEUTRAL domain line, never an error — see `cost` above for the
   * same doctrine. The precise incident lives in `data.name`, never in the
   * type itself (mirrors packages/contract/src/tasks.ts).
   */
  | 'resource'
  /**
   * A task just started waiting on a resource it does not hold yet (T1.3):
   * `data.name` is 'machine_busy' or 'project_busy'. A NEUTRAL line like
   * 'cost', never 'error' — an ordinary wait is not a degradation.
   *
   * Kept on its own single line (concurrent tickets each append their own
   * member here — a rebase conflict that resolves itself).
   */
  | 'queue'
  /**
   * D7/DP9: the DOMAIN, not an incident — a fact about the forge issue a task
   * is bound to, named like `checks`/`isolation`/`cost` name theirs. The
   * specific cause travels in `data.name` (`bound`, `coverage_gap`, `edited`,
   * `cosmetic`, `not_ticket`, `snapshot_unreadable`, `unreachable`). `edited`
   * and `not_ticket` move the task to `waiting_for_you` in the SAME
   * transition — never mid-turn, never a silent restart; `cosmetic` changes
   * nothing. A forge that cannot be reached is `unreachable` on THIS type,
   * carrying `reason_code: 'forge_unreachable'` (a field of its own): the
   * task carries on unmodified on its frozen snapshot, so `error` would paint
   * a non-event red — and would serve its English `data.message` verbatim
   * into a French journal (DP9/DP15).
   */
  | 'issue'
  /** Pre-turn dependency install. data.name: install_started/skipped/passed/failed. */
  | 'prep'
  /**
   * T2.5/D6: the DOMAIN, not an incident — a fact about this task's acceptance
   * criteria. `data.name` names the incident (`draft_unparsed`, `validated`).
   * NEUTRAL like `cost`/`issue`. Kept on its own last line so concurrent
   * tickets append without a rebase fight (mirrors packages/contract/src/tasks.ts).
   */
  | 'criteria'
  /**
   * T3.6/D12: the DOMAIN of the merge gate — D12's four conditions, one line
   * each, then what the gate did. `data.name` names the incident
   * (`condition_met`, `condition_unmet`, `condition_consented`, `refused`,
   * `policy_human`, `merged`, `failed`, `config_degraded`). Kept on its own
   * last line, same rebase courtesy as `criteria`.
   */
  | 'merge'
  | 'proof'

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
  /**
   * T3.6 / DP1: the automatic merge could not EVALUATE the checks condition —
   * the repo configures none, the container runtime is absent, or no finished
   * run exists for the branch. Never `checks_failed`, which would claim red
   * checks that never ran.
   */
  | 'checks_unavailable'
  /**
   * T3.6 / DP2: the automatic merge was refused because the task carries no
   * acceptance criteria to be judged against. `criteria_unmet` stays reserved
   * for negative verdicts the gate actually returned.
   */
  | 'criteria_missing'

/**
 * Which unevaluable case a `checks_unavailable` names, and which absence a
 * `criteria_missing` names (mirrors packages/contract/src/reasons.ts).
 * DISCRIMINANTS carried as a scalar on the journal line, never labels: the
 * sentence a human reads is the reason's own `detail`, and the journal wording
 * comes from the i18n catalog.
 */
export type ChecksUnavailableDetail = 'unconfigured' | 'runtime_error' | 'no_run'
export type CriteriaMissingDetail = 'absent' | 'pending_validation'

/** A degradation, fully stated: the code plus the producer's own message. */
export type TaskReason = {
  code: ReasonCode | string
  /** The readable message the code names; never replaced by it. */
  detail?: string
}

/** How a task's agent turns are contained (mirrors the contract). */
export type TaskIsolation = 'container' | 'policy' | 'microvm'

/** One known agent CLI, as GET /api/config `agents` lists them. */
export type AgentOption = {
  id: string
  label: string
  bin: string
  command: string
  detected: boolean
  /** Model ids the CLI itself listed (or the built-in suggestions). */
  models?: readonly string[]
  /** Reasoning-effort values the CLI accepts; empty when it has no such flag. */
  efforts?: readonly string[]
}

/** The two forges the CLI's client speaks (mirrors the contract). */
export type IssueForge = 'github' | 'gitlab'

/** Where a task's ticket lives, when it was created from a forge issue (D7). */
export type TaskIssueRef = {
  forge: IssueForge
  /** The forge project the issue belongs to (`owner/repo`, or a GitLab path). */
  project: string
  iid: number
  url: string
}

/**
 * What the issue's body and criteria were worth at admission (D7), frozen.
 * DP13: every hash is over the ticket contract's CANONICAL form, never the
 * forge's raw markdown — a line-ending or CLI-formatting difference must not
 * read as an edit.
 */
export type TaskIssueSnapshot = {
  /** Primary divergence gate: canonical whole-body hash, tagged `sha256:t2:<hex>`. */
  body_hash: string
  /**
   * Per-section canonical hash, so a divergence can name which section moved.
   * OPTIONAL, exactly as in the contract (`packages/contract/src/tasks.ts`):
   * `body_hash` alone is the real gate and this is a breakdown of it, so a
   * snapshot without it is still usable — reconciliation simply cannot NAME
   * the section that moved. The mirror carried it as REQUIRED after the
   * contract made it optional, which is the silent drift the manual-mirror
   * convention exists to prevent (round-4 review, mineur 3).
   */
  section_hashes?: {
    context: string
    goal: string
    scope: string
    out_of_scope: string
  }
  criteria: AcceptanceCriterion[]
  /** Forensic only (`sha256:raw:<hex>`): never used to decide a status change. */
  raw_body_hash?: string
  taken_at: string
}

/** What the workspace config ASKED for (mirrors the CLI's IsolationMode). */
export type IsolationMode = 'auto' | 'container' | 'policy' | 'microvm'

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

/**
 * A repository handed to a conversation that did not start with one (mirrors
 * the contract). `branch` and `base` mean what they mean on TaskRecord,
 * except they belong to THIS repository: several attachments each carry
 * their own.
 */
export type TaskAttachment = {
  /** Registry id of the attached project. */
  project_id: string
  /** Absolute root of the attached repository. */
  repo: string
  /** Directory name inside the conversation's workspace: the repo's basename. */
  name: string
  /** Absolute path of the worktree, inside the conversation's workspace. */
  worktree: string
  branch: string
  base: string
}

/** The closed set of `TaskActivity.phase` values. Mirrors packages/contract/src/tasks.ts. */
export const TASK_ACTIVITY_PHASES = ['checks', 'verification', 'proof', 'review', 'recap'] as const

export type TaskActivityPhase = (typeof TASK_ACTIVITY_PHASES)[number]

/** What a task's agent is doing right now, and since when (ISO-8601). Purely
 * informational, unlike `TaskStatus` or `checks_status`. Mirrors
 * packages/contract/src/tasks.ts. */
export type TaskActivity = {
  phase: TaskActivityPhase
  since: string
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
  /**
   * Repositories handed to this conversation after it started, in the order
   * they were attached. Absent means the conversation was never given one:
   * either it works on the single repository named by `base`/`branch` above
   * (the ordinary case), or it has no repository at all; the two are told
   * apart by the project's own `kind`, never by this field.
   */
  attachments?: TaskAttachment[]
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
  /** Full agent CLI this task's turns run with. Absent on older records = workspace boot command. */
  agent?: string
  /** Why the task is where it is, when that is a degradation. Absent on
   * records written before reason codes existed, and on tasks nothing went
   * wrong with — absence claims nothing. */
  reason?: TaskReason
  /**
   * Last aggregated checks-run status the end-of-turn gate observed.
   * OPTIONAL: absent on records written before the gate, and on a turn that
   * produced no commit. Never `'running'` — the gate waits for a terminal
   * status. Mirror of packages/contract/src/tasks.ts.
   */
  checks_status?: Exclude<TaskChecksStatus, 'running'>
  /**
   * What the task's agent is doing right now, when it is running, and since
   * when. Absent on records written before this field existed, and on a task
   * between phases (or not running). Mirror of packages/contract/src/tasks.ts.
   */
  activity?: TaskActivity
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
  /** The forge issue this task was created from, when it was (T2.4, D7). */
  issue?: TaskIssueRef
  /** What the issue's body and criteria were worth at launch (T2.4, D7). */
  issue_snapshot?: TaskIssueSnapshot
  /**
   * Acceptance criteria this task is judged against when they did not come
   * from a forge issue (T2.5, D6). Absent = no criteria (records written
   * before the field, and tasks that still have none).
   */
  criteria?: AcceptanceCriterion[]
  created_at: string
  updated_at: string
}

// Mirrors packages/cli/src/task-plan.ts (T2.6): the dry-run answer of
// POST /api/tasks/preview — what a conversation WOULD be if it were launched
// now. Never persisted anywhere, so it carries no `version`: the server
// computes it fresh on every call and the client re-parses it tolerantly
// (`parseTaskPlan`, composables/useTaskPlan.ts) rather than trusting the wire.

export type TaskPlan = {
  /** 'fork': a new codesema/task-* branch. 'work_on': the caller's own branch. */
  mode: 'fork' | 'work_on'
  /** Repo root the conversation would run in — the PROJECT's, not the launch repo's. */
  repo: string
  /** Title the task would carry (the issue's own title when created from a ticket). */
  title: string
  /** Branch the conversation would run on. */
  branch: string
  /**
   * False when `branch` could not be predicted: every -2…-99 suffix is taken
   * and the real creation appends the task's own id, which does not exist yet.
   * `branch` is then the family, not the name — say so, never promise it.
   */
  branch_certain: boolean
  /**
   * Directory the worktree would be created under: the checkout lands in
   * `<worktree_root>/<task id>`, and that id is minted at creation.
   */
  worktree_root: string
  /** Branch a fork starts from. Empty in work-on mode: nothing is branched. */
  base: string
  /** Branch the eventual MR would target. */
  target: string
  /** Set when no trunk could be detected — the gap is stated, not hidden. */
  base_note?: string
  isolation: TaskIsolation
  /** Why that isolation, in the server's own words: a degradation is never silent. */
  isolation_reason: string
  /** Agent command resolved for this project (or the one the composer picked). */
  agent: string
  /** Rank the task would wait at; null = it would start at once. */
  queue_position: number | null
  /** Issue the conversation would be bound to. Read, never frozen. */
  issue: TaskIssueRef | null
  auto_ship: boolean
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

// Mirrors packages/contract/src/tasks.ts: the outcome of the MECHANICAL
// verification of a task (a fresh VM replays the validated runbook's tests
// with the ticket's worktree attached; the agent's own claim never enters
// this record).

export type TaskVerificationStatus = 'passed' | 'failed' | 'refused' | 'error'

/** The persisted verification.json of one task (.codesema/tasks/<id>/verification.json). */
export type TaskVerification = {
  /** Worktree HEAD the verification ran against. */
  head_sha: string
  /** sha (16 hex) of the runbook whose tests were replayed. */
  runbook_sha: string
  started_at: string
  finished_at: string | null
  status: TaskVerificationStatus
  /** One entry per `runbook.tests` command that ran, in order; empty when
   * refused or errored before running. Same shape as the contract's
   * TaskCheckResult: TaskCheck is that type's own mirror name here. */
  checks: TaskCheck[]
  /** True when every `depends_on_files` entry matched the validated runbook. */
  integrity_ok: boolean
  /** The `depends_on_files` entries that differed; empty when `integrity_ok`. */
  changed_dependency_files: string[]
  /** Readable failure when status is 'error': the VM could not boot, or an
   * install/service/healthcheck step failed before the tests ever ran. */
  error: string | null
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
  | {
      project_id: string
      task_id: string
      event: {
        name: 'task_meta'
        data: {
          tokens: number
          // Machine-wide load cap (T1.3, D4) occupation at the instant this
          // frame was emitted, so the UI can render "waiting for a machine
          // slot". OPTIONAL: absent on a frame this field predates (an
          // ordinary token-meter tick) — a client that does not know it
          // simply ignores it, never throws. `queued` counts requests parked
          // in the cap's OWN FIFO (a review, a checks run) — not a turn
          // refused by tryAcquire, which never joins it (see load-cap.ts).
          load_cap?: { occupied: number; max: number; queued: number }
          // Which of the two `load_cap`-carrying transitions this frame is:
          // true entering the wait, false on obtaining the slot. Present only
          // alongside `load_cap` — the two frames are otherwise identical.
          waiting_for_slot?: boolean
        }
      }
    }
  /**
   * The task's whole checks.json after a transition — or `null`, the wire's
   * only way to say "there is no checks result any more" (T1.3: a 'running'
   * snapshot broadcast for a run that never started is TAKEN BACK; no
   * TaskChecks value can express "never ran"). Mirror of task-server.ts.
   */
  | { project_id: string; task_id: string; event: { name: 'task_checks'; data: TaskChecks | null } }
  // Agent-assisted checks setup: PROJECT-scoped, no task_id — the proposal
  // belongs to the repo, not to a conversation.
  | { project_id: string; event: { name: 'checks_proposal'; data: unknown } }
  | { project_id: string; task_id: string; event: { name: 'task_recap'; data: RecapRecord } }
  | { project_id: string; task_id: string; event: { name: 'task_evidence'; data: EvidenceRecord } }
  | {
      project_id: string
      task_id: string
      event: { name: 'task_verification'; data: TaskVerification }
    }

// Mirrors packages/cli/src/projects.ts (global project registry) and the
// /api/projects endpoints.

export type Project = {
  /** Stable 8-hex identifier, derived from the path. */
  id: string
  /** Absolute git toplevel path, or the scratch directory when kind is 'scratch'. */
  path: string
  /** Display name (basename of the path). The scratch project's is 'scratch'. */
  name: string
  /**
   * 'scratch' names the one project that is NOT a git repository: the
   * workspace's own directory, where a conversation lives before it is given
   * any repo. Always present, always first in GET /api/projects, never in
   * the registry file. Code that assumes `path` is a repo root (branches,
   * worktrees, MRs) must check this first.
   */
  kind: 'repo' | 'scratch'
  added_at: string
  /**
   * Isolation overlay for THIS repo (T1.4). Optional: older CLIs omit it and
   * the UI falls back to the process-wide `workspace` blob.
   */
  isolation?: WorkspaceInfo
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
  /**
   * Resolved agent command a new unspecified task of this project would run.
   * OPTIONAL: older CLIs omit it; the composer then falls back to GET /api/config.
   */
  agent?: string
  /**
   * D9 (T2.7): can this workspace reach a forge at all — a `gh`/`glab` that
   * runs, and an `origin` on this project's repo.
   *
   * OPTIONAL, and its ABSENCE MEANS "UNKNOWN", never "the forge is
   * available": an older CLI, or a workspace that never probed, says nothing
   * here, and a UI that read silence as availability would put the
   * degradation back in the dark. Same doctrine as `isolation_configured`
   * right above.
   */
  forge_available?: boolean
  /**
   * Why not — the forge client's own motif, verbatim. Present only alongside
   * `forge_available: false`. Never a sentence: the UI translates it (an
   * English message built by the server and rendered as is would come out in
   * English in a French workspace).
   */
  forge_reason?: ForgeUnavailableReason
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

// Mirrors packages/contract/src/evidence.ts: the normalized run evidence
// (screenshots/videos captured while proving a task's outcome). Same
// doctrine as RecapRecord above: sanitized on the server.

export type EvidenceKind = 'screenshot' | 'video'

export type EvidenceItem = {
  kind: EvidenceKind
  path: string
  bytes: number
  turn: number
  created_at: string
}

export type EvidenceStatus = 'passed' | 'failed' | 'skipped'

/** The normalized evidence of one task (.codesema/tasks/<id>/evidence.json). */
export type EvidenceRecord = {
  version: 1
  status: EvidenceStatus
  reason: string | null
  head_sha: string | null
  items: EvidenceItem[]
  intent?: ProofIntent
  review?: ProofReview
}
