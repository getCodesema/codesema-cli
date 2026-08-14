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
  | 'shipped'
  | 'error'
  | 'interrupted'

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
  created_at: string
  updated_at: string
}

/**
 * One frame of the global /api/tasks/events SSE stream. Every frame is
 * project-enveloped: the workspace drives N repos over one stream.
 */
export type TaskEnvelope =
  | { project_id: string; task_id: string; event: { name: 'task'; data: TaskRecord } }
  | { project_id: string; task_id: string; event: { name: 'task_event'; data: TaskEvent } }
  | { project_id: string; task_id: string; event: { name: 'task_text'; data: { text: string } } }

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

export type ProjectsResponse = { projects: Project[]; current: string | null }

/** Git repo detected around the launch directory (GET /api/projects/discover). */
export type ProjectCandidate = {
  path: string
  name: string
  /** Already registered: shown as added instead of offered. */
  registered: boolean
}

export type DiscoverResponse = { candidates: ProjectCandidate[] }
