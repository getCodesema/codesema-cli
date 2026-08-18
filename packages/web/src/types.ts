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
  files: { path: string; additions: number; deletions: number }[]
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

export type TaskTurn = {
  prompt: string
  response: string | null
  question: string | null
  started_at: string
  ended_at: string | null
  /** Total LLM tokens of the turn, when the agent stream reported usage. */
  tokens?: number
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
}

export type TaskRecord = {
  version: 1
  id: string
  title: string
  status: TaskStatus
  base: string
  branch: string
  worktree: string
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
