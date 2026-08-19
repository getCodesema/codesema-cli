// Task queue of ONE project, persisted in <repo>/.codesema/queue.json, plus
// the admission guard that makes "one active task per project" true. The queue
// used to be a `string[]` living in the closure of createTaskRunner: it died
// with the process and it was capped GLOBALLY, so nothing ever guaranteed the
// invariant and a restart lost whatever was waiting. Both facts now live in
// storage.
//
// ── How the invariant holds without a partial unique index (decision D1) ────
//
// A JSON file offers NO uniqueness constraint: nothing inside it can, by
// itself, forbid a second active task on the same project. The invariant holds
// because of a COUPLE, and it needs both halves:
//
//   1. the workspace lock — `acquireWorkspaceLock` (workspace-lock.ts) — which
//      admits ONE workspace process per CONFIG DIRECTORY (the lockfile lives in
//      `globalConfigDir()`, i.e. under `CODESEMA_CONFIG_DIR` when set, else
//      `XDG_CONFIG_HOME`/`~/.config`), and is only ever stolen from a pid that
//      is already dead. That is what guarantees a single WRITER of this file —
//      and note the boundary precisely: two processes pointed at two different
//      config directories each take their own lock and would both write here.
//   2. the admission guard below — `claimActive(projectId, taskId)` — which
//      refuses a second id for a project that already holds an active one, and
//      which is taken BEFORE any `await` (the property the slot reservation in
//      the runner's `launch` used to carry: two concurrent admissions on the
//      same project must never interleave).
//
// (1) without (2) would let one process happily start two tasks of the same
// repo; (2) without (1) would let two processes each believe they hold the only
// claim, since the claim lives in memory. This is written HERE, where the file
// is read, because it is the only thing standing between the invariant and a
// naive second writer — the day one appears, D1 says to revisit the store
// itself (SQLite), not to patch around it.
//
// Reads are tolerant like every other codesema store (invariant 1): a
// truncated or hand-mangled queue.json yields whatever was still legible and a
// readable reason, never a throw — the caller rebuilds the queue from the
// records and says so out loud (invariant 2). Writes go through the shared
// tmp + rename helper (invariant 5).
//
// Three rules hold that tolerance together, and all three are easy to get
// backwards — each of them was, once.
//
// 1. A READ never moves, rewrites or deletes anything. Copying the bad bytes
//    aside (queue.json.corrupt) is a step of REPAIR, so it belongs only to the
//    paths that put a good file back in the same breath — a mutation, or the
//    boot reconciliation. `preserve` COPIES, never moves: an unreadable file
//    cannot be copied at all, and a version of this that renamed instead lost
//    the project's whole line to a single unusable entry, with nothing to put
//    it back; the next boot then found no file and could no longer tell
//    "corrupt" from "this repo predates the queue" — the very distinction the
//    0.12 migration branch rests on. A `preserve` that FAILS therefore cancels
//    the write rather than let it destroy the last copy of the real order.
//
// 2. What a degraded read HANDS BACK is the queue rebuilt from the records,
//    never the entries it happened to salvage. Salvage is lossy by definition,
//    and the first mutation persists whatever it was given: a queue handing
//    back its salvage quietly shrinks the project's line one write at a time.
//    The corollary is that repairing from the degradation SINK does not work
//    either — the sink runs inside the read, so the mutation that provoked it
//    writes its own pre-repair list straight over the repair.
//
// 3. An id is only ever taken out of the line when its record is REALLY gone.
//    `listTasks` drops every record it could not parse, so "absent from the
//    records" covers both "deleted" and "one EMFILE away from readable", and
//    all three places that evict from a queue — the boot reconciliation, the
//    degraded read, the runner's sweep — used to evict on that ambiguity.
//    One transient failure cost a valid task its rank, silently. What cannot
//    be read keeps its place; what cannot even be placed is at least named.
//    Two of the three share `reconciledEntries` below; the runner's sweep does
//    NOT go through it (it works from ids the pump already holds) and carries
//    its own `taskRecordExists` guard — worth knowing before assuming a change
//    to the shared helper reaches all three.

import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeJsonAtomic } from './atomic-write.js'
import { ensureWorkDir } from './config.js'
import { isTaskId, type TaskRecord } from './contract.js'
import { listTasks, taskIdsOnDisk, taskRecordExists } from './tasks-store.js'

/** One waiting task: its id and when it entered the queue. */
export type QueueEntry = {
  id: string
  enqueued_at: string
}

/**
 * What a read of queue.json found.
 *
 * `present` says the file EXISTS, whatever state it is in — the difference
 * between "this repo has never been driven by a queue-aware codesema" (absent:
 * benign, and what every 0.12 tree looks like) and "this repo has a queue and
 * we could not use it" (present + degraded), which are two completely
 * different situations for the caller.
 *
 * `degraded` carries the readable reason when the file could not be used as it
 * stood; null when it could.
 */
export type QueueRead = {
  entries: QueueEntry[]
  degraded: string | null
  present: boolean
}

/** What a boot reconciliation did to the file, so the caller can journal it. */
export type QueueReconcile = {
  /** The queue as it now stands on disk, in order. */
  ids: string[]
  /** Ids dropped because their record is terminal or gone. */
  removed: string[]
  /** Ids appended because a 'queued' record was missing from the file. */
  appended: string[]
  /** Readable reason when the file on disk could not be used; null otherwise. */
  degraded: string | null
  /** Whether a queue.json existed at all — see QueueRead.present. */
  present: boolean
}

/** Enqueue never fails silently: a refusal names itself. */
export type EnqueueResult = { ok: true; position: number } | { ok: false; reason: string }

/**
 * A queue longer than this is not a queue, it is a runaway loop or a mangled
 * file. Past it, `enqueue` REFUSES (loudly, so the creation fails with a
 * reason) instead of accepting an entry the file would then drop.
 */
export const QUEUE_ENTRIES_MAX = 1_000

/** Persisted shape. `version` follows the same doctrine as TaskRecord's. */
type QueueFile = {
  version: 1
  entries: QueueEntry[]
}

/**
 * Outcome of reading the file. 'absent' is ENOENT and ONLY ENOENT: any other
 * failure (EACCES, EISDIR, EIO) is a file that is there and unusable, which
 * must never be mistaken for a repo that simply has no queue.
 */
export type QueueReadResult =
  { kind: 'absent' } | { kind: 'ok'; contents: string } | { kind: 'error'; message: string }

/** Filesystem seam (§ 0.4): tests point it at a tmpdir, or at nothing at all. */
export type TaskQueueIo = {
  read: (path: string) => QueueReadResult
  /** MUST be atomic (tmp + rename) — the default is. May throw; callers say so. */
  write: (path: string, value: unknown) => void
  /**
   * Keeps a copy of an unusable queue.json so the bytes that caused the
   * degradation survive for a post-mortem. Returns whether the evidence is
   * now secured — true also when a .corrupt from an EARLIER incident is
   * already there, since the first cause is the one worth keeping and a later
   * copy would bury it under its own consequence.
   *
   * COPIES, deliberately — it used to move. Moving means the queue is gone the
   * instant the replacement write fails (a read-only .codesema, a full disk),
   * turning a degradation into the total loss this whole module exists to
   * avoid; copying leaves the bad file exactly where it was, recoverable and
   * still distinguishable from "no queue at all" at the next boot.
   *
   * Never throws — but never lies either: a file that cannot even be READ
   * (EACCES) cannot be copied, and saying so is what stops the caller from
   * overwriting the only surviving trace of the incident.
   */
  preserve: (path: string, corruptPath: string) => boolean
  /**
   * Is there already a queue.json.corrupt? Used to WARN, not to decide:
   * `preserve` keeps the first incident, so the file an operator is looking at
   * may well belong to an older one — and nothing said so.
   */
  evidence: (corruptPath: string) => boolean
}

export const nodeTaskQueueIo: TaskQueueIo = {
  read: (path) => {
    try {
      return { kind: 'ok', contents: readFileSync(path, 'utf8') }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        return { kind: 'absent' }
      }
      return { kind: 'error', message: code ?? (err as Error).message }
    }
  },
  write: (path, value) => {
    writeJsonAtomic(path, value)
  },
  evidence: (corruptPath) => existsSync(corruptPath),
  preserve: (path, corruptPath) => {
    try {
      if (existsSync(corruptPath)) {
        // Evidence of an earlier incident is already there. Overwriting it
        // would trade the first cause for its latest symptom.
        return true
      }
      copyFileSync(path, corruptPath)
      return true
    } catch {
      // A file we could not even read may well be a file we cannot copy. The
      // caller decides what that costs — it never throws from here.
      return false
    }
  },
}

export function queuePath(cwd: string): string {
  return join(cwd, '.codesema', 'queue.json')
}

/** Where an unusable queue.json is kept for the post-mortem. */
export function corruptQueuePath(cwd: string): string {
  return `${queuePath(cwd)}.corrupt`
}

// ── Admission guard: one active task per project ───────────────────────────

/**
 * Which task each project currently has ACTIVE, in this process. In memory on
 * purpose: an active task belongs to a running turn, which belongs to a
 * process — a claim that outlived its process would be a lie at the next boot
 * (and boot recovery already rewrites those records as 'interrupted'). Its
 * uniqueness rests on the workspace lock; see the D1 note at the top.
 */
const activeByProject = new Map<string, string>()

/** The id currently active for a project, or null when it is free. */
export function activeTask(projectId: string): string | null {
  return activeByProject.get(projectId) ?? null
}

/**
 * Admission guard. Takes the project's single active slot for `taskId` and
 * returns true; returns false when ANOTHER id already holds it. Re-claiming
 * one's own claim succeeds (idempotent), so a retry never deadlocks a task
 * against itself.
 *
 * Synchronous by contract, and the caller must call it before its first
 * `await`: that is what makes two concurrent admissions on the same project
 * impossible to interleave. The claim covers the WHOLE active window of a task
 * — the agent turn AND the end-of-turn review that follows it — not just the
 * 'running' status; see the runner's launch().
 */
export function claimActive(projectId: string, taskId: string): boolean {
  const holder = activeByProject.get(projectId)
  if (holder !== undefined && holder !== taskId) {
    return false
  }
  activeByProject.set(projectId, taskId)
  return true
}

/** Frees the project's slot, iff `taskId` is the one holding it. */
export function releaseActive(projectId: string, taskId: string): void {
  if (activeByProject.get(projectId) === taskId) {
    activeByProject.delete(projectId)
  }
}

/** Test seam: drops every claim, i.e. simulates a fresh process. */
export function resetActiveClaims(): void {
  activeByProject.clear()
}

// ── The persisted queue ────────────────────────────────────────────────────

function sanitizeEntry(raw: unknown, seen: Set<string>): QueueEntry | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const entry = raw as Record<string, unknown>
  // The id is joined into a path downstream and IS the entry's identity: an
  // unusable one makes the whole entry unusable.
  if (!isTaskId(entry.id) || seen.has(entry.id)) {
    return null
  }
  seen.add(entry.id)
  return {
    id: entry.id,
    // Honest default: a file written without it (or with garbage) claims
    // "now" rather than a timestamp nobody can vouch for.
    enqueued_at:
      typeof entry.enqueued_at === 'string' && entry.enqueued_at
        ? entry.enqueued_at
        : new Date().toISOString(),
  }
}

/**
 * The readable reasons a queue.json can be discarded or trimmed. Exported so
 * the caller that journals the degradation and the test that asserts it name
 * the same string — a degradation nobody can quote is a silent one.
 */
export const QUEUE_UNREADABLE =
  'queue.json was unreadable (truncated or invalid JSON): the queue was rebuilt from the tasks on disk'
export const QUEUE_MISSHAPEN =
  'queue.json carried no usable entries list: the queue was rebuilt from the tasks on disk'
export const QUEUE_FULL = `the queue of this project already holds ${QUEUE_ENTRIES_MAX} tasks`

export function queueUnopenable(detail: string): string {
  return `queue.json could not be opened (${detail}): the queue was rebuilt from the tasks on disk`
}

export function queueEntriesDropped(n: number): string {
  return `${n} unusable entr${n === 1 ? 'y was' : 'ies were'} dropped from queue.json: the order of the tasks they named is lost`
}

/**
 * Entries past the cap are NOT unusable — they are perfectly legible ids the
 * reader refuses to hold, which is a different fact and deserves its own
 * sentence: someone reading "unusable entries" would go looking for corrupt
 * bytes that are not there.
 */
export function queueOverCap(n: number): string {
  return `queue.json listed more than ${QUEUE_ENTRIES_MAX} tasks: the last ${n} entr${n === 1 ? 'y was' : 'ies were'} ignored`
}

export function queueTruncated(n: number): string {
  return `the reconciled queue held more than ${QUEUE_ENTRIES_MAX} tasks: the last ${n} were dropped`
}

/**
 * Refusal raised when a degraded queue.json could not be copied aside. The
 * write is abandoned rather than allowed to destroy the only trace of the
 * incident — the exact bytes, and the real order the line was in.
 */
export const QUEUE_EVIDENCE_LOST =
  'queue.json is unusable AND could not be copied to queue.json.corrupt: it is left untouched rather than overwritten, so the original order survives for a post-mortem'

/**
 * Records that exist on disk but could not be read while the queue was being
 * rebuilt. Their place in the line — if the bad bytes had already swallowed
 * their entry — cannot be recovered from anywhere, so the one thing left to do
 * is name them instead of letting them vanish.
 */
export function queueRecordsUnreadable(ids: readonly string[]): string {
  return `${ids.length} task record${ids.length === 1 ? '' : 's'} could not be read while the queue was rebuilt (${ids.join(', ')}): any place they held in the line is not recoverable`
}

/**
 * Said whenever a degradation is reported while a queue.json.corrupt is
 * already on disk. `preserve` deliberately keeps the FIRST incident, so the
 * bytes an operator finds there are not this incident's — and until now
 * nothing at runtime told them so.
 */
export const QUEUE_EVIDENCE_IS_EARLIER =
  'note: queue.json.corrupt holds the bytes of an EARLIER incident, kept on purpose; the current one was not copied over it'

export function queueUnwritable(detail: string): string {
  return `queue.json could not be written (${detail}): the queue of this project is only in memory until the next successful write`
}

/**
 * Reads queue.json tolerantly. NEVER throws (invariant 1). Three outcomes, and
 * the caller is expected to tell them apart:
 *  - absent: `present: false`, no degradation — a repo no queue-aware codesema
 *    ever drove (every 0.12 tree looks like this);
 *  - usable: the entries, `present: true`, no degradation (unless individual
 *    entries had to be dropped, which is named);
 *  - unusable: `present: true` plus a readable reason (invariant 2).
 */
export function readQueue(cwd: string, io: TaskQueueIo = nodeTaskQueueIo): QueueRead {
  const result = io.read(queuePath(cwd))
  if (result.kind === 'absent') {
    return { entries: [], degraded: null, present: false }
  }
  if (result.kind === 'error') {
    // The file IS there; we just cannot read it. Calling that "no queue" would
    // silently promote a permission problem into a clean slate.
    return { entries: [], degraded: queueUnopenable(result.message), present: true }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(result.contents)
  } catch {
    return { entries: [], degraded: QUEUE_UNREADABLE, present: true }
  }
  const list = (parsed as { entries?: unknown } | null)?.entries
  if (!Array.isArray(list)) {
    return { entries: [], degraded: QUEUE_MISSHAPEN, present: true }
  }
  const entries: QueueEntry[] = []
  const seen = new Set<string>()
  let dropped = 0
  let overCap = 0
  for (const item of list) {
    if (entries.length >= QUEUE_ENTRIES_MAX) {
      // Legible, just past what this reader holds: a different loss from an
      // entry it could not make sense of, and named as such.
      overCap += 1
      continue
    }
    const entry = sanitizeEntry(item, seen)
    if (entry) {
      entries.push(entry)
    } else {
      dropped += 1
    }
  }
  // Dropping entries is a real loss of order, so it is named rather than done
  // quietly: the tasks those lines pointed at will be re-appended at the end.
  return {
    entries,
    degraded: joinReasons([
      dropped > 0 ? queueEntriesDropped(dropped) : null,
      overCap > 0 ? queueOverCap(overCap) : null,
    ]),
    present: true,
  }
}

export type TaskQueue = {
  /** The project this queue guards, as used by claimActive. */
  projectId: string
  /** Waiting ids in order, each with its enqueued_at. */
  list: () => QueueEntry[]
  /**
   * Appends `taskId` if absent and returns its 1-based position. Refuses,
   * NAMED, when the id is unusable or the queue is full — never a silent drop
   * and never a position the file does not actually hold. Throws only when the
   * write itself fails; the caller turns that into a refusal of its own.
   */
  enqueue: (taskId: string) => EnqueueResult
  /** Drops `taskId` wherever it sits; false when it was not queued. */
  remove: (taskId: string) => boolean
  /**
   * Drops a whole batch in ONE read + ONE write, and returns how many entries
   * actually went. A sweep of stale ids used to call `remove` per id — each
   * one re-reading and rewriting the entire file synchronously, on the event
   * loop that also serves HTTP: a 400-entry queue with 399 dead ids cost 400
   * reads, 399 writes and ~800 ms for a single pump, and as many queue-changed
   * broadcasts.
   */
  removeMany: (taskIds: readonly string[]) => number
  /** 1-based position in the queue, or null when the id is not waiting. */
  position: (taskId: string) => number | null
  /**
   * Boot: re-hydrates the file and reconciles it with the project's records —
   * an id that is terminal or has no record at all is dropped, and a 'queued'
   * record missing from the file is appended AT THE END.
   *
   * When NO queue.json exists (`present: false`), nothing is enqueued and
   * nothing is written: a 'queued' record in such a tree was orphaned by an
   * earlier session, and only the caller decides what to do with it. Only a
   * queue THIS system wrote is ever resumed.
   *
   * Never throws: a write it cannot perform comes back as a degradation.
   */
  reconcile: (records: readonly TaskRecord[]) => QueueReconcile
  /** Admission guard — see the D1 note at the top of this file. */
  claimActive: (taskId: string) => boolean
  releaseActive: (taskId: string) => void
  activeTask: () => string | null
}

export type CreateTaskQueueOptions = {
  /** Main repo root: queue.json lives under its .codesema/. */
  cwd: string
  /** Identity of the project for the admission guard (projects.ts ids). */
  projectId: string
  /** Filesystem seam; the default drives node:fs through the atomic writer. */
  io?: TaskQueueIo
  /**
   * The project's task records, for rebuilding a queue whose file went bad.
   * A seam: the default reads them off disk. It is only ever called on a
   * degraded read, so a healthy queue costs nothing.
   */
  records?: () => readonly TaskRecord[]
  /**
   * Whether a task's record file is on disk, whatever state it is in. A seam:
   * the default asks the store. It is what keeps `records()` — which drops
   * anything it could not parse — from being read as "these are the only
   * tasks that exist".
   */
  recordExists?: (taskId: string) => boolean
  /**
   * Every task id that has a directory on disk, readable or not. A seam: the
   * default asks the store. Used only to NAME what a rebuild could not place.
   */
  idsOnDisk?: () => readonly string[]
  /**
   * A degradation met on an ORDINARY read (not the boot reconciliation): the
   * file went bad while the workspace was running. Given the readable reason
   * AND the ids the REBUILT queue holds, so the caller can journal it on the
   * tasks it actually concerns. Reported once per distinct reason — a queue is
   * read on every enqueue/position call, and one broken file must not become a
   * stream of identical notices.
   *
   * It is a REPORTING hook and nothing else: it must not write to the queue.
   * It is called from inside a read, and a repair performed there is overwritten
   * a moment later by the very mutation that triggered it — see `read` below.
   */
  onDegraded?: (reason: string, ids: readonly string[]) => void
}

/**
 * Pure half of `reconcile`: what the queue SHOULD hold, given what the file
 * says and what the records say. An entry whose record is terminal or gone
 * comes out, and a 'queued' record the file never knew about goes in at the
 * END — oldest created_at first, which is the only fair order left.
 */
function reconciledEntries(
  entries: readonly QueueEntry[],
  records: readonly TaskRecord[],
  exists: (taskId: string) => boolean,
  /**
   * The file's own verdict, and the scan that names what a rebuild could not
   * place. Both travel TOGETHER because `unplaceable` only means anything when
   * the LINE ITSELF is in question — see the guard below. Passing them as one
   * value is what keeps the guard at this single point: a call site cannot
   * hand over the scan and forget the condition that makes it truthful.
   */
  disk: { degraded: string | null; idsOnDisk: () => readonly string[] },
): {
  next: QueueEntry[]
  removed: string[]
  appended: string[]
  truncated: number
  /** On disk, but neither parsed nor placed: nothing can give them a rank. */
  unplaceable: string[]
} {
  const byId = new Map(records.map((record) => [record.id, record]))
  const kept: QueueEntry[] = []
  const removed: string[] = []
  for (const entry of entries) {
    const record = byId.get(entry.id)
    if (record) {
      // Known: the status decides, as it always has.
      if (record.status === 'queued') {
        kept.push(entry)
      } else {
        removed.push(entry.id)
      }
      continue
    }
    // NOT in the records — and that is two different facts. `listTasks` drops
    // any record it could not read (one EMFILE under a burst of descriptors,
    // one EACCES, one half-written file), so "absent from the list" is not
    // "gone from the disk". Evicting on the ambiguity costs a perfectly valid
    // task its place in the line, silently, and it comes back at the END of
    // the queue on some later boot. Only a record that is REALLY not there is
    // dropped; anything we merely failed to read keeps its rank, and the pump
    // steps over it for as long as it stays unreadable.
    if (exists(entry.id)) {
      kept.push(entry)
    } else {
      removed.push(entry.id)
    }
  }
  const known = new Set(kept.map((entry) => entry.id))
  const orphans = records
    .filter((record) => record.status === 'queued' && !known.has(record.id))
    .toSorted((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))
  const now = new Date().toISOString()
  const all = [...kept, ...orphans.map((record) => ({ id: record.id, enqueued_at: now }))]
  const next = all.slice(0, QUEUE_ENTRIES_MAX)
  // Computed HERE rather than at one call site, because every rebuild owes the
  // same answer: a record that is on disk, that this pass could not parse, and
  // whose entry the bad bytes had already eaten, has no rank left anywhere.
  // Wiring it into the degraded read only — and not into the boot — meant the
  // boot dropped such a task from the line without a word and re-appended it,
  // last, on some later run.
  //
  // And the CONDITION lives here too, for the same reason the calculation
  // does. "Unplaceable" is a statement about a LOST RANK, so it is only true
  // when the file that held the ranks went bad. On a queue.json that read
  // perfectly, an illegible record simply never was in the line — it holds no
  // rank to lose, and saying otherwise is not a small imprecision:
  //   - the sentence is false (that record never had a place),
  //   - a non-null reason makes `reconcile` WRITE, so a healthy file is
  //     rewritten on every single boot, forever, without converging,
  //   - and the server stamps an `error` event in the journal of every
  //     INNOCENT task in the line, once per boot,
  //   - on a read-only .codesema the alarm becomes pure fiction: "this
  //     project's queue is only in memory" about a queue whose order is intact.
  // Guarding it at one of the two call sites (the read did; the boot did not)
  // is exactly the divergence that put it here. And the limit of that fix,
  // stated plainly rather than overclaimed: pairing the scan with the verdict
  // makes it impossible to hand over the scan WITHOUT a verdict — it does not
  // make it impossible to hand over a WRONG one. Nothing in `string | null`
  // says "this must be readQueue's verdict on this very file", so a third
  // caller passing, say, `{ degraded: queueTruncated(n), idsOnDisk }` — a
  // plausible slip, that function lives a few lines down the same chain —
  // would bring the whole failure back. The type narrows the mistake; only
  // the two call sites below, and the tests on them, rule it out.
  const accounted = new Set<string>([
    ...records.map((record) => record.id),
    ...next.map((entry) => entry.id),
  ])
  return {
    next,
    removed,
    appended: orphans.map((record) => record.id),
    truncated: Math.max(0, all.length - QUEUE_ENTRIES_MAX),
    unplaceable:
      disk.degraded === null ? [] : disk.idsOnDisk().filter((taskId) => !accounted.has(taskId)),
  }
}

/** True when the two lists name the same ids in the same order. */
function sameOrder(before: readonly QueueEntry[], after: readonly QueueEntry[]): boolean {
  return before.length === after.length && before.every((entry, i) => entry.id === after[i]?.id)
}

/** Joins the reasons a single pass produced, so none of them is dropped. */
function joinReasons(reasons: readonly (string | null)[]): string | null {
  const kept = reasons.filter((reason): reason is string => reason !== null)
  return kept.length === 0 ? null : kept.join(' — ')
}

/**
 * Last degradation reported per queue FILE, process-wide.
 *
 * Deliberately not a field of the queue object: `queueOf(project)` builds a
 * fresh TaskQueue on every HTTP request, so an instance-scoped memory turned
 * "once per distinct reason" into "once per request" — a broken file would
 * have printed a line per listing until someone fixed it.
 */
const degradedReports = new Map<string, string>()

/**
 * Reports a degradation at most once per distinct reason and per file.
 *
 * `note` is evaluated ONLY when the report actually fires, and is deliberately
 * kept out of the dedup key: it describes the state of the evidence at the
 * moment of speaking, not the fault itself. Folding it into the key made the
 * same fault look like a new one — a repair whose write then failed left a
 * .corrupt behind, which changed the string, which re-armed the flood the
 * once-per-reason rule exists to prevent.
 */
function reportDegraded(report: {
  path: string
  reason: string
  ids: readonly string[]
  note: () => string | null
  sink?: (reason: string, ids: readonly string[]) => void
}): void {
  if (degradedReports.get(report.path) === report.reason) {
    return
  }
  degradedReports.set(report.path, report.reason)
  report.sink?.(joinReasons([report.reason, report.note()]) ?? report.reason, report.ids)
}

function clearDegradedReport(path: string): void {
  // The file reads clean again: the next degradation is news, not an echo.
  degradedReports.delete(path)
}

/** Test hygiene only: forgets which degradations were already reported. */
export function resetQueueDegradedReports(): void {
  degradedReports.clear()
}

export function createTaskQueue(opts: CreateTaskQueueOptions): TaskQueue {
  const io = opts.io ?? nodeTaskQueueIo
  const path = queuePath(opts.cwd)
  /**
   * Whether the LAST read of this file came back degraded. It is what tells a
   * write it is about to land on bytes worth keeping a copy of — and it is
   * deliberately not a licence for a READ to go copying on its own account:
   * evidence is a step of repair, and repair belongs to the paths that put a
   * good file back in the same breath.
   */
  let lastReadDegraded = false
  const readRecords = opts.records ?? (() => listTasks(opts.cwd))
  /**
   * Does this task's record exist on disk, whatever state it is in? The
   * rebuild needs the difference between "gone" and "could not read it", which
   * `records()` alone cannot give: a list of records that parsed has no way of
   * saying which ones it silently skipped.
   */
  const recordExists = opts.recordExists ?? ((taskId: string) => taskRecordExists(opts.cwd, taskId))
  const idsOnDisk = opts.idsOnDisk ?? (() => taskIdsOnDisk(opts.cwd))
  /**
   * Warns, when there is something to warn about, that the .corrupt an
   * operator is about to open belongs to an EARLIER incident: `preserve` keeps
   * the first cause on purpose, and nothing at runtime used to say so.
   * Evaluated at the moment of reporting — before this incident's own bytes
   * could have been copied — so it never mislabels the current one.
   */
  const evidenceNote = (): string | null =>
    io.evidence(corruptQueuePath(opts.cwd)) ? QUEUE_EVIDENCE_IS_EARLIER : null

  /**
   * Reads the file. Never moves, rewrites or deletes anything — a read is a
   * read.
   *
   * When the file comes back degraded, what it returns is the queue REBUILT
   * from the records, not the entries it managed to salvage. That is the whole
   * point and it took two rounds to get right:
   *
   *  - handing back the salvaged list means every caller works on a list that
   *    silently lost whatever the bad bytes hid, and the first mutation
   *    persists that loss — the project's line quietly shrinks;
   *  - repairing from inside the degradation SINK has the same effect by a
   *    longer route: the sink rewrites the file correctly, returns, and the
   *    operation that triggered it then writes its own pre-repair list on top.
   *    An `enqueue` that provoked a perfect repair could still leave two of
   *    three waiting tasks out of the file.
   *
   * So the reconstruction happens here, in memory, before anyone sees the
   * entries; the SINK only reports; and persisting the repaired file is left
   * to `write` — i.e. to the next mutation — or to the next boot. Until one of
   * those happens the bad file stays on disk exactly as it is, which is also
   * what keeps "corrupt" distinguishable from "absent" for that next boot.
   */
  const read = (): QueueEntry[] => {
    const { entries, degraded } = readQueue(opts.cwd, io)
    if (degraded === null) {
      lastReadDegraded = false
      clearDegradedReport(path)
      return entries
    }
    lastReadDegraded = true
    // Reading every task.json is not free; it happens only while the file is
    // unusable, and only until a mutation or a boot repairs it.
    const records = readRecords()
    const { next, truncated, unplaceable } = reconciledEntries(entries, records, recordExists, {
      degraded,
      idsOnDisk,
    })
    // The cap is named here exactly as `reconcile` names it: a rebuild that
    // silently kept the first thousand and dropped the rest would be the one
    // loss in this module nobody could quote. So is the other half of the
    // uncertainty: a record that exists but would not parse is a task whose
    // rank, if the bad bytes ate its entry too, nothing can give back.
    const reason = joinReasons([
      degraded,
      truncated > 0 ? queueTruncated(truncated) : null,
      unplaceable.length > 0 ? queueRecordsUnreadable(unplaceable) : null,
    ])
    reportDegraded({
      path,
      reason: reason ?? degraded,
      ids: next.map((entry) => entry.id),
      note: evidenceNote,
      ...(opts.onDegraded ? { sink: opts.onDegraded } : {}),
    })
    return next
  }

  const write = (entries: QueueEntry[]): void => {
    // Same door as every other codesema store write: the work directory
    // exists and carries its self-ignore before anything lands in it.
    ensureWorkDir(opts.cwd)
    // The ONE place the bad bytes are copied aside: the replacement is written
    // on the very next line, so the queue is repaired in the same breath the
    // evidence is secured.
    //
    // And it is a REFUSAL when the copy does not happen. `preserve` is
    // best-effort about throwing, never about lying: an unreadable file (the
    // EACCES case) cannot be copied, and writing over it anyway would destroy
    // the only surviving trace of what went wrong — the exact bytes, and the
    // real order of the line — while a docstring promised the opposite.
    if (lastReadDegraded && !io.preserve(path, corruptQueuePath(opts.cwd))) {
      throw new Error(QUEUE_EVIDENCE_LOST)
    }
    const file: QueueFile = { version: 1, entries }
    io.write(path, file)
    // Only once the good file is actually ON DISK. Clearing before the write
    // meant a write that then failed (a read-only .codesema, a full disk) left
    // the degradation unreported-but-forgotten: every subsequent read reported
    // it again, which is exactly the flood the once-per-reason rule exists to
    // prevent.
    lastReadDegraded = false
    clearDegradedReport(path)
  }

  return {
    projectId: opts.projectId,

    list: read,

    enqueue(taskId) {
      if (!isTaskId(taskId)) {
        // Nothing else in the store accepts such an id either: refusing here
        // keeps the file free of entries no reader could ever resolve.
        return { ok: false, reason: `'${taskId}' is not a task id` }
      }
      const entries = read()
      const existing = entries.findIndex((entry) => entry.id === taskId)
      if (existing >= 0) {
        return { ok: true, position: existing + 1 }
      }
      if (entries.length >= QUEUE_ENTRIES_MAX) {
        // Accepting here would mean writing an entry the cap then drops, and
        // answering with a position the file does not hold.
        return { ok: false, reason: QUEUE_FULL }
      }
      entries.push({ id: taskId, enqueued_at: new Date().toISOString() })
      write(entries)
      return { ok: true, position: entries.length }
    },

    remove(taskId) {
      const entries = read()
      const next = entries.filter((entry) => entry.id !== taskId)
      if (next.length === entries.length) {
        return false
      }
      write(next)
      return true
    },

    removeMany(taskIds) {
      if (taskIds.length === 0) {
        return 0
      }
      const drop = new Set(taskIds)
      const entries = read()
      const next = entries.filter((entry) => !drop.has(entry.id))
      const gone = entries.length - next.length
      if (gone > 0) {
        write(next)
      }
      return gone
    },

    position(taskId) {
      const index = read().findIndex((entry) => entry.id === taskId)
      return index === -1 ? null : index + 1
    },

    reconcile(records) {
      const { entries, degraded, present } = readQueue(opts.cwd, io)
      if (!present) {
        // No queue this system ever wrote: there is nothing to resume, and
        // nothing is written either (a repo with no queue must not get a
        // .codesema/ conjured under it by a mere boot). What to do with the
        // 'queued' records left behind is the caller's call — they are
        // orphans of a session that died, not a line waiting its turn.
        return { ids: [], removed: [], appended: [], degraded: null, present: false }
      }
      const { next, removed, appended, truncated, unplaceable } = reconciledEntries(
        entries,
        records,
        recordExists,
        { degraded, idsOnDisk },
      )
      const reason = joinReasons([
        degraded,
        truncated > 0 ? queueTruncated(truncated) : null,
        unplaceable.length > 0 ? queueRecordsUnreadable(unplaceable) : null,
        degraded !== null ? evidenceNote() : null,
      ])
      // Rewritten whenever it differs, or whenever the file on disk was
      // unusable: that repairs the bad bytes in place instead of leaving the
      // next boot to re-report the same degradation. The bad bytes are kept
      // aside first — a degradation whose evidence is destroyed is half a
      // degradation.
      if (reason !== null || !sameOrder(entries, next)) {
        // One place preserves, and it is the one that immediately writes the
        // replacement: `write` below. Setting the flag here is how this path
        // says "the bytes on disk are worth keeping".
        lastReadDegraded = degraded !== null
        try {
          write(next)
        } catch (err) {
          // A boot must never die because one repo's queue is read-only or
          // its filesystem is full: it degrades, and says so.
          const detail = (err as NodeJS.ErrnoException).code ?? (err as Error).message
          return {
            ids: next.map((entry) => entry.id),
            removed,
            appended,
            degraded: joinReasons([reason, queueUnwritable(detail)]),
            present: true,
          }
        }
      }
      return {
        ids: next.map((entry) => entry.id),
        removed,
        appended,
        degraded: reason,
        present: true,
      }
    },

    claimActive: (taskId) => claimActive(opts.projectId, taskId),
    releaseActive: (taskId) => releaseActive(opts.projectId, taskId),
    activeTask: () => activeTask(opts.projectId),
  }
}
