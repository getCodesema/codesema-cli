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
  /** 12 lowercase hex chars, doubles as the on-disk directory name. */
  id: string
  title: string
  status: TaskStatus
  /** Base ref the task branched from (e.g. "main"). */
  base: string
  /** Task branch, "codesema/task-<slug>". */
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
  created_at: string
  updated_at: string
}

export const TASK_TITLE_MAX = 200
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
  'shipped',
  'error',
  'interrupted',
])

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
