// File store for agent tasks: .codesema/tasks/<id>/task.json (current state,
// atomic rewrite) + events.jsonl (append-only journal, one JSON line per
// event). Reads never crash on corrupt data: a broken task.json yields null,
// a broken journal line is skipped. No UI strings here, so no i18n.

import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  type Dirent,
} from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.js'
import { ensureWorkDir } from './config.js'
import {
  isTaskId,
  sanitizeTaskChecks,
  sanitizeTaskEvent,
  sanitizeTaskRecord,
  TASK_REASON_DETAIL_MAX,
  type AcceptanceCriterion,
  type ReasonCode,
  type TaskChecks,
  type TaskEvent,
  type TaskEventData,
  type TaskEventType,
  type TaskIsolation,
  type TaskIssueRef,
  type TaskIssueSnapshot,
  type TaskReason,
  type TaskRecord,
} from './contract.js'
import { queueBrainEvent } from './task-brain.js'

export function tasksDir(cwd: string): string {
  return join(cwd, '.codesema', 'tasks')
}

/**
 * Per-process cache of `record.brain_ticket?.id`, keyed by `${cwd}\0${id}`.
 * `brain_ticket` is WRITE-ONCE (see `CreateTaskInput.brainTicket`'s own doc
 * comment), so a cache entry never goes stale for the lifetime of its task.
 * `appendTaskEvent` is on the hot path of a chatty turn (tens of thousands
 * of `tool_use`/`tool_result` lines), and reloading task.json on every
 * single append just to answer "does this task have a brain_ticket" would
 * cost exactly what the journal cursor cache below exists to avoid.
 * `createTask` warms it directly for every task (brain-ticket or not, so
 * `null` is cached rather than leaving a gap); a task written by an earlier
 * process gets one lazy `loadTask` the first time one of its events is
 * appended in THIS process.
 */
const brainTicketIdCache = new Map<string, string | null>()

/**
 * A separator that cannot appear in a `cwd` (an absolute path) or a 12-hex
 * task id: NUL, built at RUNTIME with `fromCharCode` rather than written as
 * a literal escape in a template string, because source-shape.test.ts
 * requires every source file to stay byte-for-byte plain text, and a literal
 * escape here risks being saved as the raw byte instead (same runtime
 * character, but a file `rg` then treats as binary and silently stops
 * scanning).
 */
const KEY_SEP = String.fromCharCode(0)

function brainTicketCacheKey(cwd: string, id: string): string {
  return `${cwd}${KEY_SEP}${id}`
}

/** Test hygiene: drops the cache, i.e. simulates a fresh process. */
export function resetBrainTicketIdCache(): void {
  brainTicketIdCache.clear()
}

/**
 * Test hygiene: the cache's raw entry for one task, with the same
 * undefined/null distinction `appendTaskEvent` reads it with: `undefined`
 * (never touched) versus `null` (touched, cached as "no ticket").
 */
export function peekBrainTicketIdCache(cwd: string, id: string): string | null | undefined {
  return brainTicketIdCache.get(brainTicketCacheKey(cwd, id))
}

export function taskDir(cwd: string, id: string): string {
  return join(tasksDir(cwd), id)
}

/**
 * Retention (T1.9) ONLY: deletes a task's whole directory — task.json,
 * events.jsonl, checks.json, everything. Callers past the retention window
 * decided the task itself, not just its worktree, no longer belongs on disk.
 *
 * This is the ONE place that removes a task directory outright, so it is
 * also the ONE place that proves DP9's premise: once this returns `true`,
 * `appendTaskEvent(cwd, id, …)` on this id would `mkdirSync` a fresh, empty
 * directory back into existence — an events.jsonl with no task.json beside
 * it. Retention's own outcome is therefore NEVER journaled here; the caller
 * reports it through the workspace's notice channel instead.
 *
 * Tolerant like every other write in this store (invariant 1): a removal
 * that cannot complete (permissions, a file still open) returns `false`
 * rather than throwing, and the caller decides whether that is worth saying
 * out loud.
 */
export function removeTaskDir(cwd: string, id: string): boolean {
  if (!isTaskId(id)) {
    return false
  }
  try {
    rmSync(taskDir(cwd, id), { recursive: true, force: true })
    // Arm/brain integration: the ONE eviction `brainTicketIdCache` needs.
    // WRITE-ONCE means a live task's entry never goes stale, but a removed
    // task's directory is gone for good (this function's own doc comment):
    // an entry for it staying in the cache forever would be the one leak in
    // an otherwise process-lifetime-bounded cache.
    brainTicketIdCache.delete(brainTicketCacheKey(cwd, id))
    return true
  } catch {
    return false
  }
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
  /**
   * Full agent CLI this task's turns run with. WRITE-ONCE: copied onto the
   * record when present, omitted otherwise (older records inherit the
   * workspace boot command at runtime).
   */
  agent?: string
  /**
   * T2.4/D7: the forge issue this task was created from, and what its body was
   * worth at that moment. Always given TOGETHER by the manager (never one
   * without the other) — absent for the ordinary title+prompt path.
   */
  issue?: TaskIssueRef
  issueSnapshot?: TaskIssueSnapshot
  /**
   * Arm/brain integration: the brain ticket this task was created from, when
   * it was one. WRITE-ONCE, same discipline as `issue`: fixed here, at
   * creation, never re-decided by a later turn.
   */
  brainTicket?: { id: string; title: string; url?: string }
  /**
   * The brain's already-validated acceptance criteria, frozen onto the
   * record in this SAME write. Never posed as a second write through
   * `applyTaskCriteria` (task-criteria.ts): the task's very first turn reads
   * `taskCriteria(record)` (task-runner.ts) to build its prompt, and
   * criteria landing even one write later would race that read.
   */
  criteria?: AcceptanceCriterion[]
}

/**
 * Creates a task on disk: fresh id, its directory, and task.json. The initial
 * prompt becomes the first (still open) turn — TaskRecord has no prompt field,
 * the runner picks the queued task up and runs that turn. Status starts at
 * 'queued'; the runner promotes it to 'running' when a slot frees up.
 */
export function createTask(cwd: string, input: CreateTaskInput): TaskRecord {
  ensureWorkDir(cwd)
  // T2.4/D7 (round-2 adversarial review, mineur): `issue`/`issueSnapshot` are
  // documented as ALWAYS given together — but two INDEPENDENT conditional
  // spreads below could previously drift apart under a future edit without
  // either a type error or a test noticing, silently writing a record that
  // names a ticket with no snapshot (or the reverse). Fail loudly here
  // instead, and let a single guard — not two — decide whether either lands.
  if ((input.issue == null) !== (input.issueSnapshot == null)) {
    throw new Error('createTask: issue and issueSnapshot must be given together, or not at all')
  }
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
    ...(input.agent ? { agent: input.agent } : {}),
    ...(input.issue && input.issueSnapshot
      ? { issue: input.issue, issue_snapshot: input.issueSnapshot }
      : {}),
    ...(input.brainTicket ? { brain_ticket: input.brainTicket } : {}),
    ...(input.criteria && input.criteria.length > 0 ? { criteria: input.criteria } : {}),
    created_at: now,
    updated_at: now,
  }
  saveTask(cwd, record)
  brainTicketIdCache.set(brainTicketCacheKey(cwd, id), input.brainTicket?.id ?? null)
  return record
}

/**
 * Atomic rewrite (writeJsonAtomic, the shared tmp + rename recipe): a crash
 * mid-write leaves either the previous task.json or the new one, never a
 * partial file. Writes the record verbatim — timestamps (updated_at) are the
 * caller's job, so an in-memory record never silently diverges from the disk
 * copy.
 */
export function saveTask(cwd: string, record: TaskRecord): void {
  writeJsonAtomic(join(taskDir(cwd, record.id), 'task.json'), record)
}

/** Null on unknown id, unreadable file, invalid JSON or unusable record. */
/**
 * Whether a task's record file EXISTS, whatever state it is in.
 *
 * `loadTask` returns null for two very different facts — "there is no such
 * task" and "I could not read it right now" (EMFILE under a burst of open
 * descriptors, an EACCES, a half-written file). Callers that DELETE things on
 * a null — the queue sweep did — need the difference: evicting a perfectly
 * valid id from its project's line because the process momentarily ran out of
 * file descriptors is a silent loss of its place.
 */
export function taskRecordExists(cwd: string, id: string): boolean {
  if (!isTaskId(id)) {
    return false
  }
  try {
    statSync(join(taskDir(cwd, id), 'task.json'))
    return true
  } catch (err) {
    // ENOENT (nothing there, dangling symlink included) and ENOTDIR (the path
    // is not even a directory any more) are the two ways to be sure it is
    // gone. Every other errno — EACCES on the task's own directory, EIO,
    // ELOOP — means we could not find out, and "could not find out" must
    // never be read as "gone": `existsSync` collapsed all of them into false,
    // so a directory turned unreadable evicted a perfectly valid id.
    const code = (err as NodeJS.ErrnoException).code
    return code !== 'ENOENT' && code !== 'ENOTDIR'
  }
}

/**
 * Known three-voice inconsistency, harmless today, written down so the next
 * reader does not rediscover it as a surprise: a task directory that is a
 * SYMLINK to a real one is hidden by `listTasks` and by `taskIdsOnDisk` (both
 * filter on `isDirectory()`, which is false for a link and is not followed),
 * while `taskRecordExists` above says `true` for it — `statSync` does follow.
 * So such an id would keep its rank in the queue while being invisible in
 * every listing. A symlinked task directory is not a supported shape, nothing
 * codesema writes creates one, and the current behaviour (hiding it) is the
 * one we want; the note exists only so that a future change to any of the
 * three remembers there are three.
 */

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

/**
 * Said when the tasks/ directory itself will not list. Exported so the caller
 * that surfaces it and the test that asserts it name the same string.
 *
 * The fragment before the parenthesis is the load-bearing half: it is what an
 * operator greps for, and what the tests anchor on literally.
 */
export const STORE_UNLISTABLE = 'the task store of this project could not be listed'

export function storeUnlistable(detail: string): string {
  return `${STORE_UNLISTABLE} (${detail}): it reads as EMPTY until that clears — no task is treated as gone, and nothing is written on the strength of it`
}

/**
 * Where the failure above is SAID. Registered by whoever owns a user-facing
 * channel (the task server turns it into a workspace notice); the console is
 * the last resort so that "returns [] instead of throwing" can never become
 * "returns [] and says nothing" — that trade was invariant 1 bought at
 * invariant 2's expense, and it made a whole store go dark in silence.
 */
export type StoreUnreadableSink = (cwd: string, reason: string) => void

let storeSink: StoreUnreadableSink | null = null
/** Dedup, per directory: one unlistable store must not become a stream. */
const storeReports = new Map<string, string>()

export function onStoreUnreadable(sink: StoreUnreadableSink | null): void {
  storeSink = sink
}

/** Test hygiene: the dedup memory and the sink are process-wide. */
export function resetStoreReports(): void {
  storeReports.clear()
  storeSink = null
}

/**
 * The ONE place tasks/ is listed. Both readers went through their own
 * `readdirSync` + `catch {}`, which is how one of them ended up reporting and
 * the other staying mute; keeping a single door means the tolerance AND the
 * notice are the same for every caller, now and later.
 */
function taskDirEntries(cwd: string): Dirent[] {
  const dir = tasksDir(cwd)
  // T1.9 review round 3, CRITIQUE: `existsSync(dir)` collapses EVERY stat
  // error into `false` — not just ENOENT, but EACCES on the parent, an
  // unmounted/renamed `.codesema`, an EIO. Read as "never created", each of
  // those silently swept a project's still-live tasks off the sweep's
  // inventory instead of reporting the store unreadable (the exact doctrine
  // `taskRecordExists` above already applies to `task.json`, and the one this
  // function's own doc comment on `report` promises but did not deliver: "no
  // task is treated as gone, and nothing is written on the strength of it").
  // `statSync` distinguishes: only ENOENT/ENOTDIR mean the store genuinely
  // was never created; everything else is "could not find out", which must
  // never be read as "empty".
  try {
    statSync(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // A store that was never created is not a store that broke.
      storeReports.delete(dir)
      return []
    }
    report(cwd, dir, storeUnlistable(code ?? (err as Error).message))
    return []
  }
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    // Readable again: forget the incident, so a later relapse is said afresh.
    storeReports.delete(dir)
    return entries
  } catch (err) {
    // Tolerant like every other read of this store (invariant 1): a tasks/
    // directory that will not list right now (EACCES, EMFILE under a burst of
    // descriptors) yields no records rather than throwing — the queue's
    // `list()` is documented as never throwing and rebuilds itself from here.
    // But tolerance is not silence (invariant 2): an empty answer from a
    // directory full of tasks is the single most misleading value this module
    // can return, and `taskIdsOnDisk` returning [] is precisely the moment the
    // queue loses its ability to NAME what it could not place.
    const detail = (err as NodeJS.ErrnoException).code ?? (err as Error).message
    report(cwd, dir, storeUnlistable(detail))
    return []
  }
}

function report(cwd: string, dir: string, reason: string): void {
  if (storeReports.get(dir) === reason) {
    return
  }
  storeReports.set(dir, reason)
  const sink = storeSink
  if (!sink) {
    console.warn(reason)
    return
  }
  try {
    sink(cwd, reason)
  } catch {
    // A listener that throws must not turn a degradation into a crash, and
    // must not swallow the degradation either.
    console.warn(reason)
  }
}

/** All readable tasks, most recently updated first. Corrupt ones are skipped. */
/**
 * Ids of every task DIRECTORY on disk, readable or not.
 *
 * `listTasks` silently drops anything it could not parse, so on its own it
 * cannot answer "did this task disappear, or did I merely fail to read it?".
 * Subtracting its ids from these gives exactly the records that exist and are
 * currently illegible — the set the queue must not treat as gone.
 * Directory names only: no JSON is parsed here.
 */
export function taskIdsOnDisk(cwd: string): string[] {
  return taskDirEntries(cwd)
    .filter((entry) => entry.isDirectory() && isTaskId(entry.name))
    .map((entry) => entry.name)
}

export function listTasks(cwd: string): TaskRecord[] {
  const records: TaskRecord[] = []
  for (const entry of taskDirEntries(cwd)) {
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

/**
 * Tolerant read of a journal, with ONE distinction that matters: `''` when
 * there is no journal at all, `null` when there is one and it could not be
 * read.
 *
 * A task that has never journalled anything has no file, and that is genuinely
 * "no events" — an empty answer is the truth for it. Every OTHER error (EACCES
 * after a chmod, EMFILE under a descriptor storm, EIO on a failing disk) means
 * the journal exists and this process could not see it, which is a completely
 * different fact. Callers that DERIVE something from the journal — the T3.3
 * fix loop derives a spent budget from it — must be able to tell "zero" from
 * "I could not know", or an unreadable journal reads as a fresh full budget on
 * every single turn. Same trap, same doctrine as `taskRecordExists` on the
 * record side: `null` for two very different facts is how a refusal becomes a
 * permission.
 */
function defaultJournalReader(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? '' : null
  }
}

let journalReader: (path: string) => string | null = defaultJournalReader

/**
 * Test seam: every read of an events.jsonl content goes through this hook, so a
 * test can count journal reads (an append must cost zero of them once the
 * cursor is warm) without instrumenting readFileSync globally, and so a test
 * can simulate a journal that EXISTS and cannot be read (return null) as
 * opposed to one that is absent (return ''). Pass null to restore the real
 * read.
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
  // Arm/brain integration: fire-and-forget, cache-gated (see
  // `brainTicketIdCache`'s own doc comment) so a chatty turn's tens of
  // thousands of tool_use/tool_result lines never cost an extra task.json
  // read each: only the FIRST event of a task this process has not yet
  // touched pays for one.
  const cacheKey = brainTicketCacheKey(cwd, id)
  let ticketId = brainTicketIdCache.get(cacheKey)
  if (ticketId === undefined) {
    ticketId = loadTask(cwd, id)?.brain_ticket?.id ?? null
    brainTicketIdCache.set(cacheKey, ticketId)
  }
  if (ticketId) {
    queueBrainEvent({ cwd, taskId: id, ticketId, event })
  }
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
 * Atomic rewrite of checks.json (the same shared recipe as saveTask): every
 * snapshot of a run overwrites the previous one, a crash mid-write never
 * leaves a partial file. The payload is sanitized before writing so the file
 * on disk is always bounded; the sanitized copy is returned so the caller
 * broadcasts exactly what was persisted.
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
  writeJsonAtomic(join(taskDir(cwd, id), 'checks.json'), clean)
  return clean
}

/**
 * Erases a task's checks.json — the ONLY way back to "nothing ever ran here",
 * which no `writeTaskChecks` payload can express (`TaskChecks` has no "never
 * ran" status; the ABSENCE of the file is that state, and `readTaskChecks`
 * returns null for it). Used to undo a 'running' snapshot for a run that
 * turned out never to start (task-server.ts's abandoned load-cap wait): the
 * alternative — leaving 'running' behind — strands the UI's "Re-run checks"
 * button disabled forever, since it derives from `status === 'running'`.
 * Silent on an absent file and on an unknown id: erasing what is not there
 * is already the requested state, never an error.
 */
export function removeTaskChecks(cwd: string, id: string): void {
  if (!isTaskId(id)) {
    return
  }
  rmSync(join(taskDir(cwd, id), 'checks.json'), { force: true })
}

/**
 * Everything ONE read of a journal could establish — the events, and what the
 * read had to give up on. Two facts `readTaskEvents`'s bare `TaskEvent[]`
 * cannot carry, and that a caller deriving state from the journal needs:
 *
 *  - `unreadable`: the journal exists and could not be read. `events` is then
 *    empty and means NOTHING — it is the absence of an answer, not the answer
 *    zero. A derivation that confuses the two grants on ignorance.
 *  - `dropped`: how many non-empty lines did not survive parse+sanitize (a
 *    crash-truncated tail, a hand edit). The events are still usable — the
 *    journal is informative, never a reason to fail a task — but a caller
 *    counting them knows its count may be short, and can say so instead of
 *    quietly acting on a number a corruption moved.
 */
export type TaskJournalRead = {
  events: TaskEvent[]
  unreadable: boolean
  dropped: number
}

/**
 * Reads the journal in file order, reporting what it could not read (see
 * `TaskJournalRead`). Corrupt or truncated lines are skipped rather than
 * fatal, and nothing here ever throws. afterSeq filters to events strictly
 * newer, for SSE catch-up after a reconnect.
 */
export function readTaskJournal(
  cwd: string,
  id: string,
  opts?: { afterSeq?: number },
): TaskJournalRead {
  if (!isTaskId(id)) {
    // Not "this task has no events": this is a refusal to look, and the only
    // honest shape for it is the same one an unreadable journal takes.
    return { events: [], unreadable: true, dropped: 0 }
  }
  const path = join(taskDir(cwd, id), 'events.jsonl')
  const raw = journalReader(path)
  if (raw === null) {
    return { events: [], unreadable: true, dropped: 0 }
  }
  const afterSeq = opts?.afterSeq
  const events: TaskEvent[] = []
  let dropped = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      dropped += 1
      continue
    }
    const event = sanitizeTaskEvent(parsed)
    if (!event) {
      dropped += 1
      continue
    }
    if (afterSeq !== undefined && event.seq <= afterSeq) {
      continue
    }
    events.push(event)
  }
  return { events, unreadable: false, dropped }
}

/**
 * The journal's events and nothing else — what every reader that only wants
 * the timeline uses. An unreadable journal and an empty one both answer `[]`
 * here; a caller that must tell them apart reads `readTaskJournal` instead.
 */
export function readTaskEvents(cwd: string, id: string, opts?: { afterSeq?: number }): TaskEvent[] {
  return readTaskJournal(cwd, id, opts).events
}
