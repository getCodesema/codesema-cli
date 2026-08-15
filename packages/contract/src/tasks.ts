// Task workspace contract: types + sanitizers for agent task records and their
// append-only event journal. Same doctrine as the review contract (index.ts):
// whitelist and truncate, never throw. Everything read back from disk goes
// through here before being trusted.

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
  /** Total LLM tokens (input+output) consumed by this turn, when the agent's stream reports usage. */
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

/**
 * How a task's agent turns are contained.
 *
 * - 'container': the WHOLE turn runs inside a per-task container (worktree
 *   mounted, egress through an allowlist proxy). The cage is the guarantee, so
 *   the agent gets full Bash inside it.
 * - 'policy': the turn runs on the HOST, contained by CLI flags only (edit
 *   tools opened, user settings only, strict MCP config).
 *
 * Fixed AT CREATION and immutable: a record must never promise an isolation
 * its turns did not actually run under.
 */
export type TaskIsolation = 'container' | 'policy'

/** Flat, bounded payload: summaries only, never a full file body. */
export type TaskEventData = Record<string, string | number | boolean | null>

export type TaskEvent = {
  seq: number
  at: string
  type: TaskEventType
  data: TaskEventData
}

/**
 * Statuses that count as ACTIVE for the one-active-conversation-per-branch
 * rule: everything non-terminal. Terminal tasks (shipped, failed) never block
 * a new conversation on their branch.
 */
export function isActiveTaskStatus(status: TaskStatus): boolean {
  return status !== 'shipped' && status !== 'failed'
}

export type TaskRecord = {
  version: 1
  /** 12 lowercase hex chars, doubles as the on-disk directory name. */
  id: string
  title: string
  status: TaskStatus
  /** Fork mode: base ref the task branched from (e.g. "main"). Work-on mode: the MR target branch. */
  base: string
  /** Task branch: a generated "codesema/task-<slug>" (fork mode) or the pre-existing branch the conversation works on directly (work-on mode). */
  branch: string
  /** Absolute path of the task's git worktree. */
  worktree: string
  /** Provider session id (claude --resume), null before the first turn ran. */
  agent_session_id: string | null
  turns: TaskTurn[]
  /** Path of the archived review record produced for this task, if any. */
  review_ref: string | null
  /** Time spent working; waiting_for_you time never counts as work. */
  work_ms: number
  wait_ms: number
  auto_ship: boolean
  /**
   * True for a work-on task (POST /api/tasks `branch`): the conversation works
   * DIRECTLY on the pre-existing `branch` — the worktree is a plain checkout
   * of it, and abandoning the task must never delete the branch.
   */
  work_on: boolean
  /**
   * Containment of this task's agent turns, decided at creation from the
   * workspace configuration and the container-runtime probe. Immutable: the
   * runner reads it, never writes it.
   */
  isolation: TaskIsolation
  created_at: string
  updated_at: string
}

export const TASK_TITLE_MAX = 200
/** Bound for a caller-supplied base branch name (POST /api/tasks `base`). */
export const TASK_BASE_MAX = 200
export const TASK_PATH_MAX = 500
export const TASK_SESSION_ID_MAX = 200
/** Applies to a turn's prompt, response and question alike. */
export const TASK_TURN_TEXT_MAX = 20_000
export const TASK_TURNS_MAX = 500
export const TASK_EVENT_DATA_KEYS_MAX = 16
export const TASK_EVENT_DATA_KEY_MAX = 64
export const TASK_EVENT_DATA_STRING_MAX = 2_000

const TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'queued',
  'running',
  'waiting_for_you',
  'reviewing',
  'review_ok',
  'review_ko',
  'shipped',
  'failed',
  'interrupted',
])

const TASK_EVENT_TYPES: ReadonlySet<TaskEventType> = new Set([
  'turn_started',
  'tool_use',
  'tool_result',
  'message',
  'question',
  'commit',
  'review_started',
  'review_done',
  'checks',
  'shipped',
  'error',
  'interrupted',
  'isolation',
])

const TASK_ISOLATIONS: ReadonlySet<TaskIsolation> = new Set(['container', 'policy'])

/** The id names a directory under .codesema/tasks/: nothing else is usable. */
const TASK_ID_RE = /^[0-9a-f]{12}$/

/** Guards every id joined into a filesystem path (store, HTTP routes). */
export function isTaskId(value: unknown): value is string {
  return typeof value === 'string' && TASK_ID_RE.test(value)
}

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max) : ''

const nullableStr = (v: unknown, max: number): string | null => {
  const s = str(v, max)
  return s ? s : null
}

const isoOrNow = (v: unknown): string => (typeof v === 'string' && v ? v : new Date().toISOString())

const nonNegativeInt = (v: unknown): number =>
  Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0

function sanitizeTaskTurn(raw: unknown): TaskTurn | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const t = raw as Record<string, unknown>
  // A turn without a prompt carries no information: skip it entirely.
  const prompt = typeof t.prompt === 'string' ? t.prompt.slice(0, TASK_TURN_TEXT_MAX) : ''
  if (!prompt.trim()) {
    return null
  }
  return {
    prompt,
    response:
      typeof t.response === 'string' ? t.response.slice(0, TASK_TURN_TEXT_MAX) || null : null,
    question:
      typeof t.question === 'string' ? t.question.slice(0, TASK_TURN_TEXT_MAX) || null : null,
    started_at: isoOrNow(t.started_at),
    ended_at: typeof t.ended_at === 'string' && t.ended_at ? t.ended_at : null,
    ...(typeof t.tokens === 'number' && Number.isFinite(t.tokens) && t.tokens >= 0
      ? { tokens: Math.min(Math.round(t.tokens), 1_000_000_000) }
      : {}),
  }
}

/**
 * Revalidates a TaskRecord read back from disk. Returns null when the input
 * has no usable identity (missing or malformed id); every other field is
 * normalized to a safe default. An unknown status degrades to 'failed': a
 * record written by a newer schema is shown as broken, never as runnable.
 */
export function sanitizeTaskRecord(raw: unknown): TaskRecord | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' ? r.id.trim().toLowerCase() : ''
  if (!TASK_ID_RE.test(id)) {
    return null
  }
  const turns: TaskTurn[] = []
  if (Array.isArray(r.turns)) {
    for (const item of r.turns) {
      if (turns.length >= TASK_TURNS_MAX) {
        break
      }
      const turn = sanitizeTaskTurn(item)
      if (turn) {
        turns.push(turn)
      }
    }
  }
  const created_at = isoOrNow(r.created_at)
  return {
    version: 1,
    id,
    title: str(r.title, TASK_TITLE_MAX),
    status: TASK_STATUSES.has(r.status as TaskStatus) ? (r.status as TaskStatus) : 'failed',
    base: str(r.base, TASK_PATH_MAX),
    branch: str(r.branch, TASK_PATH_MAX),
    worktree: str(r.worktree, TASK_PATH_MAX),
    agent_session_id: nullableStr(r.agent_session_id, TASK_SESSION_ID_MAX),
    turns,
    review_ref: nullableStr(r.review_ref, TASK_PATH_MAX),
    work_ms: nonNegativeInt(r.work_ms),
    wait_ms: nonNegativeInt(r.wait_ms),
    auto_ship: r.auto_ship === true,
    // Absent on records written before work-on mode existed: those are all
    // fork tasks, so false is the honest default.
    work_on: r.work_on === true,
    // Absent on records written before the container cage existed — those all
    // ran on the host under the policy hardening, so 'policy' is the honest
    // default. An unknown value degrades the same way: a record must never
    // claim a stronger containment than the one it can prove.
    isolation: TASK_ISOLATIONS.has(r.isolation as TaskIsolation)
      ? (r.isolation as TaskIsolation)
      : 'policy',
    created_at,
    updated_at: typeof r.updated_at === 'string' && r.updated_at ? r.updated_at : created_at,
  }
}

function sanitizeTaskEventData(raw: unknown): TaskEventData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }
  const out: TaskEventData = {}
  let kept = 0
  for (const [key, value] of Object.entries(raw)) {
    if (kept >= TASK_EVENT_DATA_KEYS_MAX) {
      break
    }
    const k = key.slice(0, TASK_EVENT_DATA_KEY_MAX)
    if (!k) {
      continue
    }
    if (typeof value === 'string') {
      out[k] = value.slice(0, TASK_EVENT_DATA_STRING_MAX)
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[k] = value
    } else if (typeof value === 'boolean' || value === null) {
      out[k] = value
    } else {
      // Nested objects/arrays are dropped: the journal stays flat and bounded.
      continue
    }
    kept++
  }
  return out
}

// --- Task checks (container-run typecheck/tests/lint on the task worktree) --

/** Per-command outcome. 'skipped' = never ran (an earlier install/step failed). */
export type TaskCheckStatus = 'passed' | 'failed' | 'timeout' | 'skipped'

/**
 * Whole-run status. 'error' means the run itself could not happen (no
 * container runtime, engine bug) as opposed to a check failing;
 * 'unconfigured' means nothing to run was detected or configured.
 */
export type TaskChecksStatus = 'running' | 'passed' | 'failed' | 'error' | 'unconfigured'

export type TaskCheckResult = {
  command: string
  status: TaskCheckStatus
  /** Container exit code; null when it never exited on its own (timeout, skip). */
  exit_code: number | null
  duration_ms: number
  /** LAST ~4000 chars of the check's stdout+stderr (the end carries the verdict). */
  tail: string
}

/** The persisted checks.json of one task: latest run only, overwritten each run. */
export type TaskChecks = {
  /** Worktree HEAD the checks ran against. */
  head_sha: string
  started_at: string
  finished_at: string | null
  status: TaskChecksStatus
  checks: TaskCheckResult[]
  /** Readable failure when status is 'error' (e.g. no container runtime). */
  error: string | null
}

export const TASK_CHECK_COMMAND_MAX = 500
export const TASK_CHECK_TAIL_MAX = 4_000
export const TASK_CHECKS_LIST_MAX = 32
export const TASK_CHECKS_ERROR_MAX = 2_000
/** A git sha is 40 (64 for sha256 repos) chars; anything longer is garbage. */
const TASK_CHECKS_SHA_MAX = 64

const TASK_CHECK_STATUSES: ReadonlySet<TaskCheckStatus> = new Set([
  'passed',
  'failed',
  'timeout',
  'skipped',
])

const TASK_CHECKS_STATUSES: ReadonlySet<TaskChecksStatus> = new Set([
  'running',
  'passed',
  'failed',
  'error',
  'unconfigured',
])

function sanitizeTaskCheckResult(raw: unknown): TaskCheckResult | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const c = raw as Record<string, unknown>
  // A result without a command or with an unknown status cannot be rendered
  // honestly: skip the entry rather than invent one.
  const command = str(c.command, TASK_CHECK_COMMAND_MAX)
  if (!command || !TASK_CHECK_STATUSES.has(c.status as TaskCheckStatus)) {
    return null
  }
  return {
    command,
    status: c.status as TaskCheckStatus,
    exit_code: Number.isInteger(c.exit_code) ? (c.exit_code as number) : null,
    duration_ms: nonNegativeInt(c.duration_ms),
    // The tail's END is the valuable part (final error, summary line): truncate
    // from the front, never the back.
    tail: typeof c.tail === 'string' ? c.tail.slice(-TASK_CHECK_TAIL_MAX) : '',
  }
}

/**
 * Revalidates a TaskChecks read back from disk (checks.json) or received over
 * SSE. Same doctrine as the other sanitizers: whitelist and truncate, never
 * throw. Null when the whole-run status is unusable — a file written by a
 * newer schema must not render as a verdict it does not carry.
 */
export function sanitizeTaskChecks(raw: unknown): TaskChecks | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  if (!TASK_CHECKS_STATUSES.has(r.status as TaskChecksStatus)) {
    return null
  }
  const checks: TaskCheckResult[] = []
  if (Array.isArray(r.checks)) {
    for (const item of r.checks) {
      if (checks.length >= TASK_CHECKS_LIST_MAX) {
        break
      }
      const check = sanitizeTaskCheckResult(item)
      if (check) {
        checks.push(check)
      }
    }
  }
  return {
    head_sha: str(r.head_sha, TASK_CHECKS_SHA_MAX),
    started_at: isoOrNow(r.started_at),
    finished_at: typeof r.finished_at === 'string' && r.finished_at ? r.finished_at : null,
    status: r.status as TaskChecksStatus,
    checks,
    error: nullableStr(r.error, TASK_CHECKS_ERROR_MAX),
  }
}

/**
 * Revalidates a TaskEvent (one JSONL journal line). Returns null when the
 * line cannot be placed in the journal (missing seq) or rendered (unknown
 * type): the reader skips it and moves on, a corrupt line never crashes.
 */
export function sanitizeTaskEvent(raw: unknown): TaskEvent | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const e = raw as Record<string, unknown>
  if (!Number.isInteger(e.seq) || (e.seq as number) < 0) {
    return null
  }
  if (!TASK_EVENT_TYPES.has(e.type as TaskEventType)) {
    return null
  }
  return {
    seq: e.seq as number,
    at: isoOrNow(e.at),
    type: e.type as TaskEventType,
    data: sanitizeTaskEventData(e.data),
  }
}
