// File store for agent tasks: .codesema/tasks/<id>/task.json (current state,
// atomic rewrite) + events.jsonl (append-only journal, one JSON line per
// event). Reads never crash on corrupt data: a broken task.json yields null,
// a broken journal line is skipped. No UI strings here, so no i18n.

import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { ensureWorkDir } from './config.js'
import {
  isTaskId,
  sanitizeTaskChecks,
  sanitizeTaskEvent,
  sanitizeTaskRecord,
  TASK_REASON_DETAIL_MAX,
  type ReasonCode,
  type TaskChecks,
  type TaskEvent,
  type TaskEventData,
  type TaskEventType,
  type TaskIsolation,
  type TaskReason,
  type TaskRecord,
} from './contract.js'

export function tasksDir(cwd: string): string {
  return join(cwd, '.codesema', 'tasks')
}

export function taskDir(cwd: string, id: string): string {
  return join(tasksDir(cwd), id)
}

export type CreateTaskInput = {
  title: string
  prompt: string
  autoShip: boolean
  base: string
  branch: string
  worktree: string
  /** Work-on mode (POST /api/tasks `branch`): the task works directly on `branch`. Defaults to false (fork mode). */
  workOn?: boolean
  /** Containment of the task's turns, resolved by the manager. Defaults to 'policy'. */
  isolation?: TaskIsolation
}

/**
 * Creates a task on disk: fresh id, its directory, and task.json. The initial
 * prompt becomes the first (still open) turn — TaskRecord has no prompt field,
 * the runner picks the queued task up and runs that turn. Status starts at
 * 'queued'; the runner promotes it to 'running' when a slot frees up.
 */
export function createTask(cwd: string, input: CreateTaskInput): TaskRecord {
  ensureWorkDir(cwd)
  const id = randomBytes(6).toString('hex')
  const now = new Date().toISOString()
  const record: TaskRecord = {
    version: 1,
    id,
    title: input.title,
    status: 'queued',
    base: input.base,
    branch: input.branch,
    worktree: input.worktree,
    agent_session_id: null,
    turns: [
      { prompt: input.prompt, response: null, question: null, started_at: now, ended_at: null },
    ],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: input.autoShip,
    work_on: input.workOn === true,
    // Fixed here, once: nothing downstream may change how a task is contained.
    isolation: input.isolation ?? 'policy',
    created_at: now,
    updated_at: now,
  }
  saveTask(cwd, record)
  return record
}

/**
 * Atomic rewrite (tmp + rename on the same filesystem): a crash mid-write
 * leaves either the previous task.json or the new one, never a partial file.
 * Writes the record verbatim — timestamps (updated_at) are the caller's job,
 * so an in-memory record never silently diverges from the disk copy.
 */
export function saveTask(cwd: string, record: TaskRecord): void {
  const dir = taskDir(cwd, record.id)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, 'task.json.tmp')
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`)
  renameSync(tmp, join(dir, 'task.json'))
}

/** Null on unknown id, unreadable file, invalid JSON or unusable record. */
export function loadTask(cwd: string, id: string): TaskRecord | null {
  // The id is joined into a path: reject anything that is not one of ours
  // (also blocks traversal from user-supplied ids in HTTP routes).
  if (!isTaskId(id)) {
    return null
  }
  const path = join(taskDir(cwd, id), 'task.json')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  const record = sanitizeTaskRecord(raw)
  // The directory name is the canonical id: a record claiming another id was
  // copied or tampered with, treat it as corrupt rather than trust either id.
  return record && record.id === id ? record : null
}

/** All readable tasks, most recently updated first. Corrupt ones are skipped. */
export function listTasks(cwd: string): TaskRecord[] {
  const dir = tasksDir(cwd)
  if (!existsSync(dir)) {
    return []
  }
  const records: TaskRecord[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }
    const record = loadTask(cwd, entry.name)
    if (record) {
      records.push(record)
    }
  }
  // ISO-8601 strings sort lexicographically; id tie-break keeps the order stable.
  return records.toSorted(
    (a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id),
  )
}

/**
 * Builds the reason a producer states on a record: the code, plus that
 * producer's OWN readable message in `detail`, verbatim. The message is never
 * replaced — the code only names it — and the bound is applied HERE because
 * saveTask writes records exactly as handed to it.
 */
export function taskReason(code: ReasonCode, detail?: string): TaskReason {
  const text = typeof detail === 'string' ? detail.trim().slice(0, TASK_REASON_DETAIL_MAX) : ''
  return { code, ...(text ? { detail: text } : {}) }
}

export type AppendTaskEventInput = {
  type: TaskEventType
  data: TaskEventData
  /**
   * Names the degradation this event reports, when it reports one. Optional
   * and carried BESIDE `data`, never inside it: producers keep writing the
   * exact payload they always wrote, and the code is added to it.
   */
  reason_code?: ReasonCode
}

/** Tolerant read of a journal: null when there is none, or it cannot be read. */
function defaultJournalReader(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

let journalReader: (path: string) => string | null = defaultJournalReader

/**
 * Test seam: every read of an events.jsonl content goes through this hook, so a
 * test can count journal reads (an append must cost zero of them once the
 * cursor is warm) without instrumenting readFileSync globally. Pass null to
 * restore the real read.
 */
export function setJournalReader(reader: ((path: string) => string | null) | null): void {
  journalReader = reader ?? defaultJournalReader
}

/**
 * What this process knows about a journal without reading it again. `seq` is
 * the highest seq written so far (0 on an empty or unreadable journal), `size`
 * the byte length events.jsonl had when we last left it, and `needsNewline`
 * says the tail line is unterminated (a crash mid-append) so the next append
 * must close it first.
 */
type JournalCursor = {
  seq: number
  size: number
  needsNewline: boolean
}

/**
 * Journal cursors, keyed by the events.jsonl path. Filled by ONE tolerant read
 * at first access, then kept up to date in memory: appending an event costs a
 * write, never a re-read of the whole journal — a chatty turn writes tens of
 * thousands of tool_use/tool_result lines, and re-reading each time made an
 * append O(journal size).
 *
 * Correct as long as a single process appends to a given journal, which is what
 * D1 guarantees (one workspace process per machine behind the global lock). The
 * stat guard below still catches an outside append, so the cache degrades to a
 * re-read instead of corrupting the journal; a second concurrent writer would
 * have to be revisited together with the store itself.
 *
 * Never persisted: after a crash or a restart the map is empty, the first
 * append re-reads the journal and the seq resumes from the highest valid seq on
 * disk — the same single code path as a cold first access, never a counter
 * reset to 0.
 */
const journalCursors = new Map<string, JournalCursor>()

/** Test seam: drops the in-memory cursors, i.e. simulates a store restart. */
export function resetJournalCursors(): void {
  journalCursors.clear()
}

/** Size of the journal on disk; 0 when there is none. Metadata only, no read. */
function journalSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

/**
 * Derives a cursor from disk with ONE tolerant read: illegible lines are
 * ignored (they must not reset the counter) and nothing here ever throws —
 * invariant 5, the journal is informative, never a reason to fail a task.
 */
function readJournalCursor(path: string): JournalCursor {
  const raw = journalReader(path)
  if (raw === null) {
    return { seq: 0, size: 0, needsNewline: false }
  }
  let seq = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const event = sanitizeTaskEvent(parsed)
    if (event && event.seq > seq) {
      seq = event.seq
    }
  }
  return {
    seq,
    size: Buffer.byteLength(raw, 'utf8'),
    needsNewline: raw.length > 0 && !raw.endsWith('\n'),
  }
}

/**
 * The cursor to write the next event with. Reads the journal only when this
 * process has never touched it, or when its size no longer matches what we
 * left (hand editing, a crash-truncated tail, an outside writer): the memory
 * copy is dropped rather than trusted.
 */
function journalCursor(path: string): JournalCursor {
  const cached = journalCursors.get(path)
  if (cached && cached.size === journalSize(path)) {
    return cached
  }
  const fresh = readJournalCursor(path)
  journalCursors.set(path, fresh)
  return fresh
}

/**
 * Appends one journal line with an auto-incremented seq (1-based, one past the
 * highest valid seq already on disk — corrupt lines don't reset the counter)
 * and at = now. The event is sanitized before writing so the journal stays
 * bounded no matter what the caller passes in data. The seq comes from the
 * in-memory cursor, so the journal is read once per task per process, not once
 * per event.
 */
export function appendTaskEvent(cwd: string, id: string, input: AppendTaskEventInput): TaskEvent {
  if (!isTaskId(id)) {
    throw new Error(`invalid task id: ${id}`)
  }
  const dir = taskDir(cwd, id)
  const path = join(dir, 'events.jsonl')
  const cursor = journalCursor(path)
  const event = sanitizeTaskEvent({
    seq: cursor.seq + 1,
    at: new Date().toISOString(),
    type: input.type,
    data: input.data,
    ...(input.reason_code ? { reason_code: input.reason_code } : {}),
  })
  if (!event) {
    // Unreachable through the typed input; kept as a hard invariant so a bad
    // caller fails loudly instead of writing an unreadable line.
    throw new Error('invalid task event')
  }
  mkdirSync(dir, { recursive: true })
  // A crash mid-append can leave a truncated tail with no newline; appending
  // directly would glue this event onto the broken line and lose both. Close
  // the broken line first so only the corrupt one is sacrificed.
  const line = `${cursor.needsNewline ? '\n' : ''}${JSON.stringify(event)}\n`
  appendFileSync(path, line)
  journalCursors.set(path, {
    seq: event.seq,
    size: cursor.size + Buffer.byteLength(line, 'utf8'),
    needsNewline: false,
  })
  return event
}

/**
 * Latest checks run of a task (.codesema/tasks/<id>/checks.json). Null on
 * unknown id, never-run task, unreadable file or unusable content — the API
 * turns null into a 404, never a crash.
 */
export function readTaskChecks(cwd: string, id: string): TaskChecks | null {
  if (!isTaskId(id)) {
    return null
  }
  const path = join(taskDir(cwd, id), 'checks.json')
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
  return sanitizeTaskChecks(raw)
}

/**
 * Atomic rewrite of checks.json (tmp + rename, same recipe as saveTask):
 * every snapshot of a run overwrites the previous one, a crash mid-write
 * never leaves a partial file. The payload is sanitized before writing so
 * the file on disk is always bounded; the sanitized copy is returned so the
 * caller broadcasts exactly what was persisted.
 */
export function writeTaskChecks(cwd: string, id: string, checks: TaskChecks): TaskChecks {
  if (!isTaskId(id)) {
    throw new Error(`invalid task id: ${id}`)
  }
  const clean = sanitizeTaskChecks(checks)
  if (!clean) {
    // Unreachable through the typed input; a hard invariant like appendTaskEvent's.
    throw new Error('invalid task checks')
  }
  const dir = taskDir(cwd, id)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, 'checks.json.tmp')
  writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`)
  renameSync(tmp, join(dir, 'checks.json'))
  return clean
}

/**
 * Reads the journal in file order. Corrupt or truncated lines (crash mid-append,
 * hand editing) are silently skipped — the journal is informative, never a
 * reason to fail a task. afterSeq filters to events strictly newer, for SSE
 * catch-up after a reconnect.
 */
export function readTaskEvents(cwd: string, id: string, opts?: { afterSeq?: number }): TaskEvent[] {
  if (!isTaskId(id)) {
    return []
  }
  const path = join(taskDir(cwd, id), 'events.jsonl')
  const raw = journalReader(path)
  if (raw === null) {
    return []
  }
  const afterSeq = opts?.afterSeq
  const events: TaskEvent[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const event = sanitizeTaskEvent(parsed)
    if (!event) {
      continue
    }
    if (afterSeq !== undefined && event.seq <= afterSeq) {
      continue
    }
    events.push(event)
  }
  return events
}
