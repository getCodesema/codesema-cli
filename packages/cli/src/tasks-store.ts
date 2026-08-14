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
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { ensureWorkDir } from './config.js'
import {
  isTaskId,
  sanitizeTaskChecks,
  sanitizeTaskEvent,
  sanitizeTaskRecord,
  type TaskChecks,
  type TaskEvent,
  type TaskEventData,
  type TaskEventType,
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

export type AppendTaskEventInput = {
  type: TaskEventType
  data: TaskEventData
}

/**
 * Appends one journal line with an auto-incremented seq (1-based, one past the
 * highest valid seq already on disk — corrupt lines don't reset the counter)
 * and at = now. The event is sanitized before writing so the journal stays
 * bounded no matter what the caller passes in data.
 */
export function appendTaskEvent(cwd: string, id: string, input: AppendTaskEventInput): TaskEvent {
  if (!isTaskId(id)) {
    throw new Error(`invalid task id: ${id}`)
  }
  let last = 0
  for (const event of readTaskEvents(cwd, id)) {
    if (event.seq > last) {
      last = event.seq
    }
  }
  const event = sanitizeTaskEvent({
    seq: last + 1,
    at: new Date().toISOString(),
    type: input.type,
    data: input.data,
  })
  if (!event) {
    // Unreachable through the typed input; kept as a hard invariant so a bad
    // caller fails loudly instead of writing an unreadable line.
    throw new Error('invalid task event')
  }
  const dir = taskDir(cwd, id)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'events.jsonl')
  // A crash mid-append can leave a truncated tail with no newline; appending
  // directly would glue this event onto the broken line and lose both. Close
  // the broken line first so only the corrupt one is sacrificed.
  let prefix = ''
  try {
    const raw = readFileSync(path, 'utf8')
    if (raw.length > 0 && !raw.endsWith('\n')) {
      prefix = '\n'
    }
  } catch {
    // No journal yet: nothing to repair.
  }
  appendFileSync(path, `${prefix}${JSON.stringify(event)}\n`)
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
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
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
