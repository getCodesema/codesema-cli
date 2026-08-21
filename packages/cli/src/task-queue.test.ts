import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { writeJsonAtomic } from './atomic-write.js'
import type { TaskRecord } from './contract.js'
import {
  activeTask,
  claimActive,
  corruptQueuePath,
  createTaskQueue,
  nodeTaskQueueIo,
  QUEUE_ENTRIES_MAX,
  QUEUE_EVIDENCE_IS_EARLIER,
  QUEUE_EVIDENCE_LOST,
  QUEUE_FULL,
  QUEUE_MISSHAPEN,
  QUEUE_UNREADABLE,
  queueEntriesDropped,
  queueOverCap,
  queuePath,
  queueRecordsUnreadable,
  queueTruncated,
  queueUnopenable,
  queueUnwritable,
  readQueue,
  releaseActive,
  resetActiveClaims,
  resetQueueDegradedReports,
  type TaskQueueIo,
} from './task-queue.js'
import { appendTaskEvent, createTask, resetStoreReports, taskDir } from './tasks-store.js'

const cleanups: string[] = []

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  // Belt and braces between FILES, never inside a test: the admission guard
  // and the degradation memory are process-wide, so a leak must be caught by
  // an assertion rather than papered over here. All four suites that can touch
  // them reset both — an asymmetry here is a flake waiting for a bad ordering.
  resetActiveClaims()
  resetQueueDegradedReports()
  resetStoreReports()
})

/**
 * chmod does not bind root, so a suite run as root cannot exercise a
 * permission failure at all. The skip is gated on the UID and NOTHING else:
 * conditioning it on the failure being observed makes the test silently
 * assert nothing the day the failure stops happening — which is exactly the
 * day it should have gone red.
 */
const RUNNING_AS_ROOT = process.getuid?.() === 0

/** Every test writes into a fresh tmpdir; nothing here touches a real repo. */
function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'codesema-queue-'))
  cleanups.push(repo)
  return repo
}

/** Input for a REAL record on disk, for the tests that use no seam at all. */
const taskInput = (title: string) => ({
  title,
  prompt: title,
  autoShip: false,
  base: 'main',
  branch: '',
  worktree: '',
})

/** A 12-hex task id, the only shape the store (and this queue) accepts. */
const id = (n: number): string => n.toString(16).padStart(12, '0')

function makeQueue(cwd: string, projectId = 'deadbeef', io?: TaskQueueIo) {
  return createTaskQueue({ cwd, projectId, ...(io ? { io } : {}) })
}

function record(taskId: string, status: TaskRecord['status'], createdAt: string): TaskRecord {
  return {
    version: 1,
    id: taskId,
    title: taskId,
    status,
    base: '',
    branch: '',
    worktree: '',
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: false,
    work_on: false,
    isolation: 'policy',
    created_at: createdAt,
    updated_at: createdAt,
  }
}

describe('the persisted queue', () => {
  test('FIFO: list returns the enqueue order, each entry carries its enqueued_at, position is 1-based', () => {
    const repo = makeRepo()
    const queue = makeQueue(repo)
    expect(queue.enqueue(id(1))).toEqual({ ok: true, position: 1 })
    expect(queue.enqueue(id(2))).toEqual({ ok: true, position: 2 })

    const entries = queue.list()
    expect(entries.map((entry) => entry.id)).toEqual([id(1), id(2)])
    for (const entry of entries) {
      expect(Number.isNaN(Date.parse(entry.enqueued_at))).toBe(false)
    }
    expect(queue.position(id(1))).toBe(1)
    expect(queue.position(id(2))).toBe(2)
    expect(queue.position(id(9))).toBeNull()
    // It is on DISK, under the repo, not in a closure.
    expect(queuePath(repo)).toBe(join(repo, '.codesema', 'queue.json'))
    expect(existsSync(queuePath(repo))).toBe(true)
  })

  test('enqueue is idempotent: an id already waiting keeps its place', () => {
    const repo = makeRepo()
    const queue = makeQueue(repo)
    queue.enqueue(id(1))
    queue.enqueue(id(2))
    expect(queue.enqueue(id(1))).toEqual({ ok: true, position: 1 })
    expect(queue.list().map((entry) => entry.id)).toEqual([id(1), id(2)])
  })

  // What the retired `dequeue()` proved, through the API that actually drives
  // the runner: taking the head takes the head and nothing else.
  test('removing the head takes the head, and only the head', () => {
    const repo = makeRepo()
    const queue = makeQueue(repo)
    queue.enqueue(id(1))
    queue.enqueue(id(2))
    expect(queue.remove(id(1))).toBe(true)
    expect(queue.list().map((entry) => entry.id)).toEqual([id(2)])
    expect(queue.remove(id(2))).toBe(true)
    expect(queue.list()).toEqual([])
    expect(queue.remove(id(2))).toBe(false)
  })

  test('remove drops an id from the middle and the positions are recomputed', () => {
    const repo = makeRepo()
    const queue = makeQueue(repo)
    queue.enqueue(id(1))
    queue.enqueue(id(2))
    queue.enqueue(id(3))

    expect(queue.remove(id(2))).toBe(true)
    expect(queue.list().map((entry) => entry.id)).toEqual([id(1), id(3)])
    expect(queue.position(id(3))).toBe(2)
    expect(queue.remove(id(2))).toBe(false)
  })

  test('an id the store could never resolve is refused, NAMED, and never enters the file', () => {
    const repo = makeRepo()
    const queue = makeQueue(repo)
    expect(queue.enqueue('../escape')).toEqual({
      ok: false,
      reason: "'../escape' is not a task id",
    })
    expect(queue.enqueue('NOTHEX')).toEqual({ ok: false, reason: "'NOTHEX' is not a task id" })
    expect(queue.list()).toEqual([])
  })

  test('a full queue REFUSES instead of dropping the entry and lying about its rank', () => {
    const repo = makeRepo()
    const queue = makeQueue(repo)
    writeJsonAtomic(queuePath(repo), {
      version: 1,
      entries: Array.from({ length: QUEUE_ENTRIES_MAX }, (_, i) => ({
        id: id(i + 1),
        enqueued_at: '2026-01-01T00:00:00.000Z',
      })),
    })
    expect(queue.list()).toHaveLength(QUEUE_ENTRIES_MAX)

    const refused = queue.enqueue(id(QUEUE_ENTRIES_MAX + 1))
    expect(refused).toEqual({ ok: false, reason: QUEUE_FULL })
    // Nothing was written, and no position was invented for it.
    expect(queue.list()).toHaveLength(QUEUE_ENTRIES_MAX)
    expect(queue.position(id(QUEUE_ENTRIES_MAX + 1))).toBeNull()
    // An id already in the (full) queue still gets its real place back.
    expect(queue.enqueue(id(1))).toEqual({ ok: true, position: 1 })
  })

  // What the retired `reset()` proved — duplicates collapse, unusable ids never
  // enter — asserted where those rules actually live now.
  test('duplicates collapse and unusable ids never enter, whichever door they come by', () => {
    const repo = makeRepo()
    const queue = makeQueue(repo)
    expect(queue.enqueue(id(2))).toEqual({ ok: true, position: 1 })
    expect(queue.enqueue(id(1))).toEqual({ ok: true, position: 2 })
    // A second enqueue of a waiting id keeps its place instead of doubling it.
    expect(queue.enqueue(id(2))).toEqual({ ok: true, position: 1 })
    expect(queue.enqueue('nope')).toEqual({ ok: false, reason: "'nope' is not a task id" })
    expect(queue.list().map((entry) => entry.id)).toEqual([id(2), id(1)])

    // And through the boot door, on a file that carries both faults.
    writeJsonAtomic(queuePath(repo), {
      version: 1,
      entries: [
        { id: id(2), enqueued_at: '2026-01-01T00:00:00.000Z' },
        { id: id(2), enqueued_at: '2026-01-01T00:00:00.000Z' },
        { id: 'nope', enqueued_at: '2026-01-01T00:00:00.000Z' },
        { id: id(1), enqueued_at: '2026-01-01T00:00:00.000Z' },
      ],
    })
    const records = [
      record(id(2), 'queued', '2026-01-01T00:00:00.000Z'),
      record(id(1), 'queued', '2026-01-02T00:00:00.000Z'),
    ]
    expect(makeQueue(repo).reconcile(records).ids).toEqual([id(2), id(1)])
  })

  // The queue's writes go through `writeJsonAtomic`, whose atomicity is proved
  // in atomic-write.test.ts against the REAL node:fs — including the fact that
  // a crash between the tmp write and the rename leaves the previous file
  // intact. A copy of that proof lived here with an injected `rename` that was
  // really writeFileSync + rmSync — i.e. a deliberately NON-atomic stand-in —
  // so it could only ever demonstrate the ordering of its own fake. What is
  // worth asserting here is the one thing that belongs to this module: the
  // queue writes through that helper rather than around it.
  test('a write publishes through the shared atomic helper, never in place', () => {
    const repo = makeRepo()
    const queue = makeQueue(repo)
    queue.enqueue(id(1))
    queue.enqueue(id(2))

    // No temporary file survives a completed write, and the published file is
    // whole at every moment a reader could look at it.
    expect(existsSync(`${queuePath(repo)}.tmp`)).toBe(false)
    expect(JSON.parse(readFileSync(queuePath(repo), 'utf8')).entries).toHaveLength(2)
  })
})

describe('tolerant read', () => {
  test('an absent queue.json is a NORMAL state: empty queue, no degradation, NOT present', () => {
    const repo = makeRepo()
    expect(readQueue(repo)).toEqual({ entries: [], degraded: null, present: false })
    expect(makeQueue(repo).list()).toEqual([])
    expect(makeQueue(repo).position(id(1))).toBeNull()
  })

  test('a truncated file never throws: empty queue, PRESENT, plus a readable reason', () => {
    const repo = makeRepo()
    mkdirSync(join(repo, '.codesema'), { recursive: true })
    writeFileSync(queuePath(repo), '{"version":1,"entries":[{"id":"0000000')
    const read = readQueue(repo)
    expect(read.entries).toEqual([])
    expect(read.degraded).toBe(QUEUE_UNREADABLE)
    // The difference that matters: the file EXISTS. Calling this "no queue"
    // would promote a crash-truncated line into a clean slate.
    expect(read.present).toBe(true)
  })

  test.skipIf(RUNNING_AS_ROOT)(
    'a file that exists but cannot be OPENED is never mistaken for an absent one',
    () => {
      const repo = makeRepo()
      writeJsonAtomic(queuePath(repo), { version: 1, entries: [] })
      chmodSync(queuePath(repo), 0o000)
      try {
        const read = readQueue(repo)
        expect(read.present).toBe(true)
        expect(read.degraded).toBe(queueUnopenable('EACCES'))
        expect(read.entries).toEqual([])
      } finally {
        chmodSync(queuePath(repo), 0o600)
      }
    },
  )

  test('a well-formed file with no entries list is named for what it is', () => {
    const repo = makeRepo()
    writeJsonAtomic(queuePath(repo), { version: 1 })
    expect(readQueue(repo)).toEqual({ entries: [], degraded: QUEUE_MISSHAPEN, present: true })
  })

  test('unusable entries are dropped one by one, the rest survives, and the loss is NAMED', () => {
    const repo = makeRepo()
    writeJsonAtomic(queuePath(repo), {
      version: 1,
      entries: [
        { id: id(1), enqueued_at: '2026-01-01T00:00:00.000Z' },
        { id: '../escape', enqueued_at: '2026-01-01T00:00:00.000Z' },
        'not an object',
        { id: id(1) },
        { id: id(2) },
      ],
    })
    const read = readQueue(repo)
    // Three lines went: an unusable id, a non-object, a duplicate.
    expect(read.degraded).toBe(queueEntriesDropped(3))
    // The duplicate is gone, and the entry without a timestamp got an honest one.
    expect(read.entries.map((entry) => entry.id)).toEqual([id(1), id(2)])
    expect(Number.isNaN(Date.parse(read.entries[1]?.enqueued_at ?? ''))).toBe(false)
  })

  // T1.2 re-review, MINOR 8: entries past the cap are perfectly LEGIBLE — the
  // reader just refuses to hold them. Calling that "unusable entries" sends
  // whoever reads the message hunting for corrupt bytes that are not there.
  test('entries past the cap are named for what they are, not called unusable', () => {
    const repo = makeRepo()
    const entries = Array.from({ length: QUEUE_ENTRIES_MAX + 3 }, (_, n) => ({
      id: id(n + 1),
      enqueued_at: '2026-01-01T00:00:00.000Z',
    }))
    writeJsonAtomic(queuePath(repo), { version: 1, entries })

    const read = readQueue(repo)
    expect(read.entries).toHaveLength(QUEUE_ENTRIES_MAX)
    expect(read.degraded).toBe(queueOverCap(3))
    expect(read.degraded).not.toContain('unusable')
  })

  test('a file that is both mangled AND too long reports BOTH losses', () => {
    const repo = makeRepo()
    const entries: unknown[] = [
      'not an object',
      ...Array.from({ length: QUEUE_ENTRIES_MAX + 1 }, (_, n) => ({
        id: id(n + 1),
        enqueued_at: '2026-01-01T00:00:00.000Z',
      })),
    ]
    writeJsonAtomic(queuePath(repo), { version: 1, entries })

    const read = readQueue(repo)
    expect(read.degraded).toContain(queueEntriesDropped(1))
    expect(read.degraded).toContain(queueOverCap(1))
  })

  test('a clean file reports no degradation at all', () => {
    const repo = makeRepo()
    makeQueue(repo).enqueue(id(1))
    expect(readQueue(repo)).toMatchObject({ degraded: null, present: true })
  })
})

describe('reconcile', () => {
  test('drops terminal and vanished ids, keeps the valid ones in place, appends orphans by created_at', () => {
    const repo = makeRepo()
    writeJsonAtomic(queuePath(repo), {
      version: 1,
      entries: [
        { id: id(1), enqueued_at: '2026-01-01T00:00:00.000Z' },
        { id: id(2), enqueued_at: '2026-01-01T00:00:00.000Z' },
        { id: id(3), enqueued_at: '2026-01-01T00:00:00.000Z' },
      ],
    })
    const result = makeQueue(repo).reconcile([
      record(id(1), 'shipped', '2026-01-01T00:00:00.000Z'),
      // id(2) has no record at all: it vanished.
      record(id(3), 'queued', '2026-01-01T00:00:00.000Z'),
      record(id(5), 'queued', '2026-01-03T00:00:00.000Z'),
      record(id(4), 'queued', '2026-01-02T00:00:00.000Z'),
      record(id(6), 'waiting_for_you', '2026-01-04T00:00:00.000Z'),
    ])

    expect(result.ids).toEqual([id(3), id(4), id(5)])
    expect(result.removed).toEqual([id(1), id(2)])
    expect(result.appended).toEqual([id(4), id(5)])
    expect(result.degraded).toBeNull()
    expect(readQueue(repo).entries.map((entry) => entry.id)).toEqual([id(3), id(4), id(5)])
  })

  test('no queue.json: NOTHING is resumed and nothing is written — only a line this system wrote restarts', () => {
    const repo = makeRepo()
    const result = makeQueue(repo).reconcile([
      record(id(2), 'queued', '2026-02-01T00:00:00.000Z'),
      record(id(1), 'queued', '2026-01-01T00:00:00.000Z'),
      record(id(3), 'shipped', '2025-01-01T00:00:00.000Z'),
    ])
    // A 'queued' record in a tree with no queue file is an orphan of a session
    // that died, not a task waiting its turn: enqueuing it here would mean a
    // boot starting agents on work nobody lined up.
    expect(result).toEqual({
      ids: [],
      removed: [],
      appended: [],
      degraded: null,
      present: false,
    })
    expect(existsSync(queuePath(repo))).toBe(false)
  })

  test('a repo with nothing to queue is left strictly alone: no .codesema conjured', () => {
    const repo = makeRepo()
    const result = makeQueue(repo).reconcile([record(id(1), 'shipped', '2026-01-01T00:00:00.000Z')])
    expect(result.ids).toEqual([])
    expect(existsSync(join(repo, '.codesema'))).toBe(false)
  })

  test('a queue that already said the right thing is not rewritten', () => {
    const repo = makeRepo()
    makeQueue(repo).enqueue(id(1))
    const before = readFileSync(queuePath(repo), 'utf8')
    makeQueue(repo).reconcile([record(id(1), 'queued', '2026-01-01T00:00:00.000Z')])
    // Byte for byte: the enqueued_at of a waiting task is not reset by a boot.
    expect(readFileSync(queuePath(repo), 'utf8')).toBe(before)
  })

  test('a corrupt file is reported ONCE, kept aside, and repaired in place', () => {
    const repo = makeRepo()
    mkdirSync(join(repo, '.codesema'), { recursive: true })
    writeFileSync(queuePath(repo), 'not json at all')

    const first = makeQueue(repo).reconcile([record(id(1), 'queued', '2026-01-01T00:00:00.000Z')])
    expect(first.degraded).toBe(QUEUE_UNREADABLE)
    expect(first.ids).toEqual([id(1)])
    // The bytes that caused it survive the repair: a degradation whose
    // evidence is destroyed is half a degradation.
    expect(readFileSync(corruptQueuePath(repo), 'utf8')).toBe('not json at all')

    const second = makeQueue(repo).reconcile([record(id(1), 'queued', '2026-01-01T00:00:00.000Z')])
    expect(second.degraded).toBeNull()
  })

  test('a corrupt file with NOTHING to re-enqueue is still reported, and still kept aside', () => {
    const repo = makeRepo()
    mkdirSync(join(repo, '.codesema'), { recursive: true })
    writeFileSync(queuePath(repo), '{"entries": [')

    // No queued record at all: the rebuilt queue is empty, and the degradation
    // has no task journal to land in — it must NOT vanish because of that.
    const result = makeQueue(repo).reconcile([record(id(1), 'shipped', '2026-01-01T00:00:00.000Z')])
    expect(result.ids).toEqual([])
    expect(result.degraded).toBe(QUEUE_UNREADABLE)
    expect(readFileSync(corruptQueuePath(repo), 'utf8')).toBe('{"entries": [')
  })

  test('a queue it cannot write degrades, it never throws the boot away', () => {
    const repo = makeRepo()
    makeQueue(repo).enqueue(id(1))
    const io: TaskQueueIo = {
      ...nodeTaskQueueIo,
      write: () => {
        throw Object.assign(new Error('read-only file system'), { code: 'EROFS' })
      },
    }
    const result = makeQueue(repo, 'deadbeef', io).reconcile([
      record(id(1), 'queued', '2026-01-01T00:00:00.000Z'),
      record(id(2), 'queued', '2026-01-02T00:00:00.000Z'),
    ])
    expect(result.ids).toEqual([id(1), id(2)])
    expect(result.degraded).toBe(queueUnwritable('EROFS'))
  })
})

// T1.2 re-review round 4, MAJOR 1: a READ used to `preserve` — i.e. rename
// queue.json away — the moment it came back degraded, and only the mutation
// paths ever wrote a replacement. Every read-only path (list, position, the
// runner's pump, the server's listing) therefore DESTROYED the project's line
// while reporting, at most, the loss of a single entry.
describe('a degraded read', () => {
  const oneBadEntry = (repo: string, good: number): void => {
    writeJsonAtomic(queuePath(repo), {
      version: 1,
      entries: [
        ...Array.from({ length: good }, (_, n) => ({
          id: id(n + 1),
          enqueued_at: '2026-01-01T00:00:00.000Z',
        })),
        { id: 'NOT-AN-ID!!', enqueued_at: '2026-01-01T00:00:00.000Z' },
      ],
    })
  }

  /** The records those ids name, so the rebuild has something to rebuild from. */
  const queued =
    (n: number): (() => TaskRecord[]) =>
    () =>
      Array.from({ length: n }, (_, i) =>
        record(id(i + 1), 'queued', `2026-01-0${Math.min(i + 1, 9)}T00:00:00.000Z`),
      )

  const degradedQueue = (repo: string, records: () => TaskRecord[]) =>
    createTaskQueue({ cwd: repo, projectId: 'deadbeef', records })

  test('NEVER moves the file: a listing leaves the queue exactly where it was', () => {
    const repo = makeRepo()
    oneBadEntry(repo, 3)
    const queue = degradedQueue(repo, queued(3))

    expect(queue.list().map((entry) => entry.id)).toEqual([id(1), id(2), id(3)])
    // The whole point: the file is still there, and reading it again still
    // gives the three good ids — it used to give [] because queue.json had
    // been renamed to .corrupt by the read itself.
    expect(existsSync(queuePath(repo))).toBe(true)
    expect(existsSync(corruptQueuePath(repo))).toBe(false)
    expect(
      degradedQueue(repo, queued(3))
        .list()
        .map((entry) => entry.id),
    ).toEqual([id(1), id(2), id(3)])
    expect(queue.position(id(3))).toBe(3)
  })

  test('a MUTATION is what repairs it: evidence aside, good file back, same breath', () => {
    const repo = makeRepo()
    oneBadEntry(repo, 2)
    const queue = degradedQueue(repo, queued(2))

    expect(queue.enqueue(id(9))).toEqual({ ok: true, position: 3 })
    // The bytes that caused it are kept…
    expect(readFileSync(corruptQueuePath(repo), 'utf8')).toContain('NOT-AN-ID!!')
    // …and a usable queue took their place immediately.
    const read = readQueue(repo)
    expect(read.degraded).toBeNull()
    expect(read.entries.map((entry) => entry.id)).toEqual([id(1), id(2), id(9)])
  })

  // T1.2 re-review round 5: what a degraded read HANDS BACK. Salvage is lossy
  // by definition — here the truncation hides two of the three waiting ids —
  // and whatever the read returns is what the next mutation persists. Handing
  // back the salvage shrinks the project's line one write at a time.
  test('what comes back is the REBUILD, not the entries it happened to salvage', () => {
    const repo = makeRepo()
    mkdirSync(join(repo, '.codesema'), { recursive: true })
    // Legible up to the first entry, then cut: 2 and 3 exist only as records.
    writeFileSync(
      queuePath(repo),
      `{"version":1,"entries":[{"id":"${id(1)}","enqueued_at":"2026-01-01T00:00:00.000Z"},{"id"`,
    )
    const queue = degradedQueue(repo, queued(3))

    expect(queue.list().map((entry) => entry.id)).toEqual([id(1), id(2), id(3)])
    // And the mutation that follows persists all three, plus its own.
    expect(queue.enqueue(id(4))).toEqual({ ok: true, position: 4 })
    expect(readQueue(repo).entries.map((entry) => entry.id)).toEqual([id(1), id(2), id(3), id(4)])
  })

  // A write that cannot land must not cost the file either: `preserve` copies
  // rather than moves, so a read-only .codesema leaves the bad queue exactly
  // where it was — recoverable, and still tellable from "no queue at all".
  test('a repair whose write FAILS leaves the bad file in place, not a hole', () => {
    const repo = makeRepo()
    mkdirSync(join(repo, '.codesema'), { recursive: true })
    writeFileSync(queuePath(repo), '{"version":1,"entries":[{"id"')
    const queue = createTaskQueue({
      cwd: repo,
      projectId: 'deadbeef',
      records: queued(1),
      io: {
        ...nodeTaskQueueIo,
        write: () => {
          throw Object.assign(new Error('read-only file system'), { code: 'EROFS' })
        },
      },
    })

    expect(() => queue.enqueue(id(2))).toThrow()
    expect(readFileSync(queuePath(repo), 'utf8')).toBe('{"version":1,"entries":[{"id"')
    expect(readQueue(repo).present).toBe(true)
    expect(readFileSync(corruptQueuePath(repo), 'utf8')).toBe('{"version":1,"entries":[{"id"')
  })

  test('a corrupt file stays DISTINGUISHABLE from an absent one for the next boot', () => {
    const repo = makeRepo()
    mkdirSync(join(repo, '.codesema'), { recursive: true })
    writeFileSync(queuePath(repo), '{"version":1,"entries":[{"id"')

    // A read-only pass over it (what a listing does).
    expect(makeQueue(repo).list()).toEqual([])
    // Still PRESENT: the boot must rebuild from the records, not take this
    // for a 0.12 tree and rewrite every queued record as 'interrupted'.
    const read = readQueue(repo)
    expect(read.present).toBe(true)
    expect(read.degraded).toBe(QUEUE_UNREADABLE)
  })

  test('the FIRST incident is the evidence kept: a later one never buries it', () => {
    const repo = makeRepo()
    mkdirSync(join(repo, '.codesema'), { recursive: true })
    writeFileSync(queuePath(repo), 'first incident, unreadable')
    makeQueue(repo).enqueue(id(1))
    expect(readFileSync(corruptQueuePath(repo), 'utf8')).toBe('first incident, unreadable')

    writeFileSync(queuePath(repo), 'second incident, also unreadable')
    makeQueue(repo).enqueue(id(2))
    expect(readFileSync(corruptQueuePath(repo), 'utf8')).toBe('first incident, unreadable')
  })
})

// T1.2 re-review, MINOR 6: the tolerant-read vocabulary used to reach the BOOT
// only. A file that went bad while the workspace was running was read as an
// empty queue, silently.
describe('a degradation met OUTSIDE the boot', () => {
  test('it is named to the caller, once per file, across queue INSTANCES', () => {
    const repo = makeRepo()
    mkdirSync(join(repo, '.codesema'), { recursive: true })
    writeFileSync(queuePath(repo), '{"version":1,"entries":[{"id"')
    const reasons: string[] = []
    const fresh = () =>
      createTaskQueue({
        cwd: repo,
        projectId: 'deadbeef',
        onDegraded: (reason) => reasons.push(reason),
      })

    // The server builds a NEW queue object per HTTP request: an
    // instance-scoped memory would have said this once per request forever.
    fresh().list()
    fresh().list()
    fresh().position(id(1))
    expect(reasons).toEqual([QUEUE_UNREADABLE])
    // And no read ever moved the file.
    expect(existsSync(queuePath(repo))).toBe(true)

    // Repaired by a mutation: the next degradation is news again.
    expect(fresh().enqueue(id(1))).toEqual({ ok: true, position: 1 })
    expect(reasons).toEqual([QUEUE_UNREADABLE])
    writeFileSync(queuePath(repo), 'broken again')
    fresh().list()
    expect(reasons).toHaveLength(2)
    expect(reasons[1]).toContain(QUEUE_UNREADABLE)
    // T1.2 round 7, MINEUR 2: the .corrupt on disk belongs to the FIRST
    // incident — kept on purpose — and the second report says so instead of
    // letting an operator read the wrong bytes as this one's evidence.
    expect(reasons[1]).toContain(QUEUE_EVIDENCE_IS_EARLIER)
    expect(readFileSync(corruptQueuePath(repo), 'utf8')).toBe('{"version":1,"entries":[{"id"')
  })

  // T1.2 re-review round 5, MINOR 1: the report used to be cleared BEFORE the
  // repairing write was attempted. On a read-only .codesema the write then
  // failed, the memory was already wiped, and every subsequent read reported
  // the same reason again — the exact flood the once-per-reason rule exists to
  // prevent.
  test('a repair that could not be WRITTEN does not re-arm the notice', () => {
    const repo = makeRepo()
    mkdirSync(join(repo, '.codesema'), { recursive: true })
    writeFileSync(queuePath(repo), '{"version":1,"entries":[{"id"')
    const reasons: string[] = []
    const readOnly: TaskQueueIo = {
      ...nodeTaskQueueIo,
      write: () => {
        throw Object.assign(new Error('read-only file system'), { code: 'EROFS' })
      },
    }
    const fresh = () =>
      createTaskQueue({
        cwd: repo,
        projectId: 'deadbeef',
        io: readOnly,
        onDegraded: (reason) => reasons.push(reason),
      })

    // Five listings and a mutation that cannot land: still ONE notice.
    for (let n = 0; n < 5; n += 1) {
      fresh().list()
    }
    expect(() => fresh().enqueue(id(1))).toThrow()
    for (let n = 0; n < 5; n += 1) {
      fresh().list()
    }
    expect(reasons).toEqual([QUEUE_UNREADABLE])
  })

  test('a queue that reads clean says nothing at all', () => {
    const repo = makeRepo()
    const reasons: string[] = []
    const queue = createTaskQueue({
      cwd: repo,
      projectId: 'deadbeef',
      onDegraded: (reason) => reasons.push(reason),
    })
    queue.enqueue(id(1))
    queue.enqueue(id(2))
    expect(queue.list()).toHaveLength(2)
    expect(reasons).toEqual([])
    expect(existsSync(corruptQueuePath(repo))).toBe(false)
  })
})

// T1.2 re-review round 4, MINOR 3: sweeping stale ids one by one re-read and
// rewrote the whole file per id.
describe('removeMany', () => {
  test('drops a whole batch in ONE write, and reports what actually went', () => {
    const repo = makeRepo()
    const queue = makeQueue(repo)
    for (let n = 1; n <= 5; n += 1) {
      queue.enqueue(id(n))
    }
    let writes = 0
    const counted = makeQueue(repo, 'deadbeef', {
      ...nodeTaskQueueIo,
      write: (path, value) => {
        writes += 1
        nodeTaskQueueIo.write(path, value)
      },
    })

    // Two of the four named ids are actually in the queue.
    expect(counted.removeMany([id(2), id(4), id(42), id(43)])).toBe(2)
    expect(writes).toBe(1)
    expect(counted.list().map((entry) => entry.id)).toEqual([id(1), id(3), id(5)])

    // Nothing to drop: nothing written at all.
    expect(counted.removeMany([id(99)])).toBe(0)
    expect(counted.removeMany([])).toBe(0)
    expect(writes).toBe(1)
  })
})

// T1.2 re-review round 6, MAJEURS 1 & 2: THREE sites evict an id from the line
// on `loadTask === null`, and round 5 only protected one of them (the runner's
// sweep). `listTasks` drops every record it could not read, so both the boot
// reconciliation and the degraded-read rebuild were reading "absent from the
// list" as "gone from the disk" — one EMFILE under a burst of descriptors, one
// EACCES, and a valid task silently lost its place.
describe('an id whose record cannot be READ keeps its place', () => {
  /** Records as `listTasks` would hand them over: the illegible one is missing. */
  const withoutSecond = (): TaskRecord[] => [
    record(id(1), 'queued', '2026-01-01T00:00:00.000Z'),
    record(id(3), 'queued', '2026-01-03T00:00:00.000Z'),
  ]
  /** …while the disk still holds all three. */
  const allThreeOnDisk = (taskId: string): boolean => [id(1), id(2), id(3)].includes(taskId)

  test('site 1, the boot reconciliation: it is NOT retired from a healthy file', () => {
    const repo = makeRepo()
    writeJsonAtomic(queuePath(repo), {
      version: 1,
      entries: [id(1), id(2), id(3)].map((entryId) => ({
        id: entryId,
        enqueued_at: '2026-01-01T00:00:00.000Z',
      })),
    })
    const queue = createTaskQueue({
      cwd: repo,
      projectId: 'deadbeef',
      recordExists: allThreeOnDisk,
    })

    const outcome = queue.reconcile(withoutSecond())
    expect(outcome.removed).toEqual([])
    expect(outcome.ids).toEqual([id(1), id(2), id(3)])
    // And the file was not rewritten behind its back either.
    expect(readQueue(repo).entries.map((entry) => entry.id)).toEqual([id(1), id(2), id(3)])
  })

  test('site 2, the degraded-read rebuild: it survives the reconstruction', () => {
    const repo = makeRepo()
    // Legible entries for all three, plus one line nothing can resolve — so
    // the read degrades while id(2)'s entry is still salvageable.
    writeJsonAtomic(queuePath(repo), {
      version: 1,
      entries: [
        { id: id(1), enqueued_at: '2026-01-01T00:00:00.000Z' },
        { id: id(2), enqueued_at: '2026-01-02T00:00:00.000Z' },
        { id: 'NOT-AN-ID!!', enqueued_at: '2026-01-02T00:00:00.000Z' },
        { id: id(3), enqueued_at: '2026-01-03T00:00:00.000Z' },
      ],
    })
    const queue = createTaskQueue({
      cwd: repo,
      projectId: 'deadbeef',
      records: withoutSecond,
      recordExists: allThreeOnDisk,
      idsOnDisk: () => [id(1), id(2), id(3)],
    })

    // id(2) keeps its RANK — it is not appended at the end, it never left.
    expect(queue.list().map((entry) => entry.id)).toEqual([id(1), id(2), id(3)])
    expect(queue.position(id(2))).toBe(2)
    // The mutation that follows persists it: no rank is lost on the way.
    expect(queue.enqueue(id(4))).toEqual({ ok: true, position: 4 })
    expect(readQueue(repo).entries.map((entry) => entry.id)).toEqual([id(1), id(2), id(3), id(4)])
  })

  // T1.2 re-review round 7, BLOQUANT 1: the rule was wired into the degraded
  // READ only. The BOOT dropped such a task from the line without a word and
  // re-appended it, LAST, on some later run: no permanent loss, but a rank
  // lost in silence. Both rebuilds now get the answer from the same place.
  // No seams at all: real records on a real filesystem, so `records()`,
  // `recordExists()` and `idsOnDisk()` are the production ones. Every other
  // test of this behaviour injects them, which left the store side of the
  // feature — and the whole of `taskIdsOnDisk` — proved by nothing.
  test('end to end on the real store: the rank survives and the unplaceable one is named', () => {
    const repo = makeRepo()
    const kept = createTask(repo, taskInput('kept'))
    const illegible = createTask(repo, taskInput('illegible'))
    const lost = createTask(repo, taskInput('lost'))
    // One record that will not parse but is plainly there…
    writeFileSync(join(taskDir(repo, illegible.id), 'task.json'), '{ truncated')
    // …and one whose entry the bad bytes will eat AND whose record is equally
    // illegible: nothing anywhere can give that one a rank.
    writeFileSync(join(taskDir(repo, lost.id), 'task.json'), '{ truncated too')
    writeFileSync(
      queuePath(repo),
      JSON.stringify({
        version: 1,
        entries: [
          { id: kept.id, enqueued_at: '2026-01-01T00:00:00.000Z' },
          { id: illegible.id, enqueued_at: '2026-01-02T00:00:00.000Z' },
          { id: 'NOT-AN-ID!!', enqueued_at: '2026-01-03T00:00:00.000Z' },
        ],
      }),
    )
    const reasons: string[] = []
    const queue = createTaskQueue({
      cwd: repo,
      projectId: 'deadbeef',
      onDegraded: (reason) => reasons.push(reason),
    })

    // The illegible-but-listed one keeps its RANK; the one with no entry left
    // is named instead of vanishing.
    expect(queue.list().map((entry) => entry.id)).toEqual([kept.id, illegible.id])
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain(queueRecordsUnreadable([lost.id]))
    // Anchored on the PRODUCTION path, not on the builder that made it: this
    // is the one place a human reads, and comparing the sentence to the
    // function that produced it proves nothing about what it says — nor that
    // the id a human has to go and look at is actually in there.
    expect(reasons[0]).toContain('could not be read while the queue was rebuilt')
    expect(reasons[0]).toContain(lost.id)
    // And what is NOT in there matters just as much: the one that kept its
    // rank was never accused of losing it.
    expect(reasons[0]).not.toContain(illegible.id)
  })

  test('the BOOT names it too, word for word with the read', () => {
    const repo = makeRepo()
    mkdirSync(join(repo, '.codesema'), { recursive: true })
    writeFileSync(queuePath(repo), '{"version":1,"entries":[{"id"')
    const queue = createTaskQueue({
      cwd: repo,
      projectId: 'deadbeef',
      recordExists: allThreeOnDisk,
      idsOnDisk: () => [id(1), id(2), id(3)],
    })

    const outcome = queue.reconcile(withoutSecond())
    expect(outcome.ids).toEqual([id(1), id(3)])
    expect(outcome.degraded).toContain(QUEUE_UNREADABLE)
    expect(outcome.degraded).toContain(queueRecordsUnreadable([id(2)]))
  })

  test('a rebuild that could NOT place an unreadable record names it rather than lose it quietly', () => {
    const repo = makeRepo()
    mkdirSync(join(repo, '.codesema'), { recursive: true })
    // Truncated to nothing: id(2)'s entry is gone AND its record will not
    // parse, so no rank can be recovered for it. The one thing left is to say
    // so — it used to disappear without a word.
    writeFileSync(queuePath(repo), '{"version":1,"entries":[{"id"')
    const reasons: string[] = []
    const queue = createTaskQueue({
      cwd: repo,
      projectId: 'deadbeef',
      records: withoutSecond,
      recordExists: allThreeOnDisk,
      idsOnDisk: () => [id(1), id(2), id(3)],
      onDegraded: (reason) => reasons.push(reason),
    })

    expect(queue.list().map((entry) => entry.id)).toEqual([id(1), id(3)])
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain(QUEUE_UNREADABLE)
    expect(reasons[0]).toContain(queueRecordsUnreadable([id(2)]))
  })

  test('a record that is REALLY gone still goes, and the boot says so', () => {
    const repo = makeRepo()
    writeJsonAtomic(queuePath(repo), {
      version: 1,
      entries: [id(1), id(2)].map((entryId) => ({
        id: entryId,
        enqueued_at: '2026-01-01T00:00:00.000Z',
      })),
    })
    const queue = createTaskQueue({
      cwd: repo,
      projectId: 'deadbeef',
      recordExists: (taskId) => taskId === id(1),
    })

    const outcome = queue.reconcile([record(id(1), 'queued', '2026-01-01T00:00:00.000Z')])
    expect(outcome.removed).toEqual([id(2)])
    expect(outcome.ids).toEqual([id(1)])
  })
})

// T1.2 re-review round 6, MOYEN: the docstring promised the bytes survive and
// the file stays where it was. On the EACCES branch neither held — the copy
// failed, the catch ate it, and the rewrite landed on top of the original.
describe('evidence that could not be secured', () => {
  test('the original is left UNTOUCHED rather than overwritten, and the refusal is named', () => {
    const repo = makeRepo()
    mkdirSync(join(repo, '.codesema'), { recursive: true })
    writeFileSync(queuePath(repo), '{"version":1,"entries":[{"id"')
    const queue = createTaskQueue({
      cwd: repo,
      projectId: 'deadbeef',
      records: () => [record(id(1), 'queued', '2026-01-01T00:00:00.000Z')],
      io: { ...nodeTaskQueueIo, preserve: () => false },
    })

    expect(() => queue.enqueue(id(2))).toThrow(QUEUE_EVIDENCE_LOST)
    // The bytes — and with them the real order of the line — are still there.
    expect(readFileSync(queuePath(repo), 'utf8')).toBe('{"version":1,"entries":[{"id"')
    expect(existsSync(corruptQueuePath(repo))).toBe(false)
  })

  // The real filesystem, on the branch the docstring got wrong: a queue.json
  // that cannot be OPENED cannot be COPIED either. It used to be renamed over
  // regardless — a stray chmod destroyed the original line for good, reordered
  // what came back by created_at, and nobody said the evidence had been lost.
  test.skipIf(RUNNING_AS_ROOT)(
    'an unreadable file is never overwritten: chmod 000 costs nothing but the write',
    () => {
      const repo = makeRepo()
      // A perfectly good queue, in an order created_at would not reproduce.
      writeJsonAtomic(queuePath(repo), {
        version: 1,
        entries: [id(3), id(1), id(2)].map((entryId) => ({
          id: entryId,
          enqueued_at: '2026-01-01T00:00:00.000Z',
        })),
      })
      const original = readFileSync(queuePath(repo), 'utf8')
      chmodSync(queuePath(repo), 0o000)
      const queue = createTaskQueue({
        cwd: repo,
        projectId: 'deadbeef',
        records: () =>
          [id(1), id(2), id(3)].map((i) => record(i, 'queued', '2026-01-01T00:00:00.000Z')),
        recordExists: () => true,
      })

      try {
        expect(() => queue.enqueue(id(4))).toThrow(QUEUE_EVIDENCE_LOST)
      } finally {
        chmodSync(queuePath(repo), 0o600)
      }
      // Byte for byte what it was — the real order of the line survives.
      expect(readFileSync(queuePath(repo), 'utf8')).toBe(original)
      expect(readQueue(repo).entries.map((entry) => entry.id)).toEqual([id(3), id(1), id(2)])
      expect(existsSync(corruptQueuePath(repo))).toBe(false)
    },
  )

  test('a .corrupt from an EARLIER incident counts as secured: the repair goes through', () => {
    const repo = makeRepo()
    mkdirSync(join(repo, '.codesema'), { recursive: true })
    writeFileSync(corruptQueuePath(repo), 'the first incident')
    writeFileSync(queuePath(repo), '{"version":1,"entries":[{"id"')
    const queue = createTaskQueue({
      cwd: repo,
      projectId: 'deadbeef',
      records: () => [record(id(1), 'queued', '2026-01-01T00:00:00.000Z')],
    })

    expect(queue.enqueue(id(2))).toEqual({ ok: true, position: 2 })
    expect(readQueue(repo).entries.map((entry) => entry.id)).toEqual([id(1), id(2)])
    expect(readFileSync(corruptQueuePath(repo), 'utf8')).toBe('the first incident')
  })
})

// T1.2 re-review round 6, MINEUR 1: `reconcile` names the cap it applied; the
// degraded-read rebuild threw the same number away, so a line cut at a
// thousand said nothing on one path and everything on the other.
// T1.2 re-review round 7, MINEUR 4: the "file that is there but unusable"
// branch was reachable only through chmod, i.e. only for a non-root suite. A
// directory where a file is expected produces the SAME class of failure with
// no privileges involved at all, so this branch stays covered in a container
// running as root.
describe('an unusable file, without needing a chmod', () => {
  test('a DIRECTORY where queue.json should be is present-and-unusable, never absent', () => {
    const repo = makeRepo()
    mkdirSync(queuePath(repo), { recursive: true })

    const read = readQueue(repo)
    expect(read.present).toBe(true)
    expect(read.degraded).toBe(queueUnopenable('EISDIR'))
    expect(read.entries).toEqual([])
  })

  test('and it is never overwritten: the evidence cannot be copied, so the write is refused', () => {
    const repo = makeRepo()
    mkdirSync(queuePath(repo), { recursive: true })
    const queue = createTaskQueue({
      cwd: repo,
      projectId: 'deadbeef',
      records: () => [record(id(1), 'queued', '2026-01-01T00:00:00.000Z')],
      recordExists: () => true,
    })

    // The rebuild still answers; only the write refuses.
    expect(queue.list().map((entry) => entry.id)).toEqual([id(1)])
    expect(() => queue.enqueue(id(2))).toThrow(QUEUE_EVIDENCE_LOST)
    // Still a directory: nothing was renamed over it, nothing was invented.
    expect(statSync(queuePath(repo)).isDirectory()).toBe(true)
    expect(existsSync(corruptQueuePath(repo))).toBe(false)
  })
})

describe('the cap is named on BOTH rebuild paths', () => {
  const overCapRecords = (): TaskRecord[] =>
    Array.from({ length: QUEUE_ENTRIES_MAX + 5 }, (_, n) =>
      record(id(n + 1), 'queued', `2026-01-01T00:00:${String(n % 60).padStart(2, '0')}.000Z`),
    )

  test('the degraded read says the last five were dropped, exactly as reconcile does', () => {
    const repo = makeRepo()
    mkdirSync(join(repo, '.codesema'), { recursive: true })
    writeFileSync(queuePath(repo), '{"version":1,"entries":[{"id"')
    const reasons: string[] = []
    const queue = createTaskQueue({
      cwd: repo,
      projectId: 'deadbeef',
      records: overCapRecords,
      recordExists: () => true,
      idsOnDisk: () => overCapRecords().map((r) => r.id),
      onDegraded: (reason) => reasons.push(reason),
    })

    expect(queue.list()).toHaveLength(QUEUE_ENTRIES_MAX)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain(queueTruncated(5))

    // The boot path said it already; the two now agree word for word.
    const repo2 = makeRepo()
    mkdirSync(join(repo2, '.codesema'), { recursive: true })
    writeFileSync(queuePath(repo2), '{"version":1,"entries":[{"id"')
    const booted = createTaskQueue({
      cwd: repo2,
      projectId: 'deadbeef',
      recordExists: () => true,
    }).reconcile(overCapRecords())
    expect(booted.degraded).toContain(queueTruncated(5))
  })
})

describe('the admission guard', () => {
  test('a second id is refused while another is active for the same project', () => {
    expect(claimActive('deadbeef', id(1))).toBe(true)
    expect(activeTask('deadbeef')).toBe(id(1))
    expect(claimActive('deadbeef', id(2))).toBe(false)
    // Re-claiming one's own claim never deadlocks a task against itself.
    expect(claimActive('deadbeef', id(1))).toBe(true)

    releaseActive('deadbeef', id(1))
    expect(activeTask('deadbeef')).toBeNull()
    expect(claimActive('deadbeef', id(2))).toBe(true)
  })

  test('the guard is PER PROJECT: two projects each hold their own', () => {
    expect(claimActive('deadbeef', id(1))).toBe(true)
    expect(claimActive('cafebabe', id(2))).toBe(true)
    expect(activeTask('deadbeef')).toBe(id(1))
    expect(activeTask('cafebabe')).toBe(id(2))
  })

  test('releasing is only ever your own claim: another task cannot free it for you', () => {
    claimActive('deadbeef', id(1))
    releaseActive('deadbeef', id(2))
    expect(activeTask('deadbeef')).toBe(id(1))
  })

  test('the queue object delegates to the same process-wide guard', () => {
    const repo = makeRepo()
    const queue = makeQueue(repo, 'deadbeef')
    expect(queue.claimActive(id(1))).toBe(true)
    // Same project, another handle on it: the claim is one and the same.
    expect(makeQueue(makeRepo(), 'deadbeef').claimActive(id(2))).toBe(false)
    expect(queue.activeTask()).toBe(id(1))
    queue.releaseActive(id(1))
    expect(queue.activeTask()).toBeNull()
  })
})

// T1.2 re-review round 8, BLOQUANT 3 — the ROOT of the two above.
//
// Every other assertion in this repo checks a degradation with
// `toContain(queueRecordsUnreadable([id]))`: the expected value is built by
// the very function under test, so the message is only ever compared to
// ITSELF. Empty the function and 1453 tests stay green — the content of what
// the workspace says, and the ids it names, were proved by nothing. That is
// how a sentence that was FALSE (blocker 1) and a sentence that was never
// emitted at all (blocker 2) both went unnoticed.
//
// This block is the anchor: every reason the module can utter is pinned to a
// literal here, so emptying or gutting any of them takes a test down. It is
// deliberately the ONLY place that hardcodes them — the production assertions
// elsewhere stay expressive; they just are no longer the only proof.
describe('the vocabulary of degradations, anchored to literals', () => {
  test('the constants say what they say', () => {
    expect(QUEUE_UNREADABLE).toBe(
      'queue.json was unreadable (truncated or invalid JSON): the queue was rebuilt from the tasks on disk',
    )
    expect(QUEUE_MISSHAPEN).toBe(
      'queue.json carried no usable entries list: the queue was rebuilt from the tasks on disk',
    )
    expect(QUEUE_FULL).toBe('the queue of this project already holds 1000 tasks')
    expect(QUEUE_EVIDENCE_LOST).toBe(
      'queue.json is unusable AND could not be copied to queue.json.corrupt: it is left untouched rather than overwritten, so the original order survives for a post-mortem',
    )
    expect(QUEUE_EVIDENCE_IS_EARLIER).toBe(
      'note: queue.json.corrupt holds the bytes of an EARLIER incident, kept on purpose; the current one was not copied over it',
    )
  })

  test('the builders carry their detail, their count, and their ids', () => {
    expect(queueUnopenable('EACCES')).toBe(
      'queue.json could not be opened (EACCES): the queue was rebuilt from the tasks on disk',
    )
    expect(queueUnwritable('EROFS')).toBe(
      'queue.json could not be written (EROFS): the queue of this project is only in memory until the next successful write',
    )
    expect(queueTruncated(7)).toBe(
      'the reconciled queue held more than 1000 tasks: the last 7 were dropped',
    )
    // The ids are the payload: a message that names none of them is useless to
    // the human who has to go and look.
    expect(queueRecordsUnreadable(['aaaaaaaaaaaa'])).toBe(
      '1 task record could not be read while the queue was rebuilt (aaaaaaaaaaaa): any place they held in the line is not recoverable',
    )
    expect(queueRecordsUnreadable(['aaaaaaaaaaaa', 'bbbbbbbbbbbb'])).toBe(
      '2 task records could not be read while the queue was rebuilt (aaaaaaaaaaaa, bbbbbbbbbbbb): any place they held in the line is not recoverable',
    )
  })

  test('the two that plural, plural — and never say the same thing as each other', () => {
    // "dropped" is about bytes nobody could read; "ignored" is about perfectly
    // legible ids the reader refuses to hold. Someone sent looking for corrupt
    // bytes that are not there has been sent by the wrong sentence.
    expect(queueEntriesDropped(1)).toBe(
      '1 unusable entry was dropped from queue.json: the order of the tasks they named is lost',
    )
    expect(queueEntriesDropped(3)).toBe(
      '3 unusable entries were dropped from queue.json: the order of the tasks they named is lost',
    )
    expect(queueOverCap(1)).toBe(
      'queue.json listed more than 1000 tasks: the last 1 entry was ignored',
    )
    expect(queueOverCap(4)).toBe(
      'queue.json listed more than 1000 tasks: the last 4 entries were ignored',
    )
  })

  test('the cap the sentences quote is the cap the module enforces', () => {
    // The literals above hardcode 1000 on purpose; this is what keeps them
    // honest if the constant ever moves.
    expect(QUEUE_ENTRIES_MAX).toBe(1000)
  })
})

// T2.6. `position()` only speaks about ids ALREADY waiting; the preview needs
// the rank a task that does not exist yet would take. The whole point is that
// asking costs nothing: no entry, no claim, not one byte of queue.json — and
// (review round 1, majeur 1) not one line of anybody's journal either.
/** `n` waiting records, so the reconciliation a projection runs keeps them. */
const waiting = (n: number): TaskRecord[] =>
  Array.from({ length: n }, (_, i) =>
    record(id(i + 1), 'queued', `2026-01-${(i + 1).toString().padStart(2, '0')}T00:00:00.000Z`),
  )

/** A queue whose records are exactly `records` — nothing else is on disk. */
const lineQueue = (repo: string, projectId: string, records: readonly TaskRecord[]) =>
  createTaskQueue({
    cwd: repo,
    projectId,
    records: () => [...records],
    recordExists: (taskId) => records.some((candidate) => candidate.id === taskId),
  })

/** Writes `ids` as the file's line, without going through the queue. */
const writeLine = (repo: string, ids: readonly string[]): void => {
  writeJsonAtomic(queuePath(repo), {
    version: 1,
    entries: ids.map((entryId) => ({ id: entryId, enqueued_at: '2026-01-01T00:00:00.000Z' })),
  })
}

/** A queue.json cut mid-write: legible as bytes, unusable as JSON. */
const truncatedQueue = (repo: string): void => {
  mkdirSync(join(repo, '.codesema'), { recursive: true })
  writeFileSync(queuePath(repo), '{"version":1,"entries":[{"id"')
}

/** `lineQueue`, plus the degradation sink the workspace wires in. */
const reportingQueue = (
  repo: string,
  records: readonly TaskRecord[],
  onDegraded: (reason: string, ids: readonly string[]) => void,
) =>
  createTaskQueue({
    cwd: repo,
    projectId: 'degraded',
    records: () => [...records],
    recordExists: (taskId) => records.some((candidate) => candidate.id === taskId),
    onDegraded,
  })

describe('projectedAdmission — the rank a NOT-YET-ADMITTED task would take', () => {
  test('an idle project would start the task at once: no rank, the same null create answers with', () => {
    const repo = makeRepo()
    const queue = makeQueue(repo)
    expect(queue.projectedAdmission()).toEqual({ admissible: true, position: null })
  })

  test('a project whose slot is taken would make it wait at 1, even on an empty file', () => {
    const repo = makeRepo()
    const queue = makeQueue(repo, 'busyproj')
    expect(claimActive('busyproj', id(7))).toBe(true)
    expect(queue.projectedAdmission()).toEqual({ admissible: true, position: 1 })
    releaseActive('busyproj', id(7))
    expect(queue.projectedAdmission()).toEqual({ admissible: true, position: null })
  })

  test('the rank FOLLOWS everything already waiting', () => {
    const repo = makeRepo()
    const records = waiting(2)
    writeLine(
      repo,
      records.map((r) => r.id),
    )
    expect(lineQueue(repo, 'deadbeef', records).projectedAdmission()).toEqual({
      admissible: true,
      position: 3,
    })
  })

  // The boundary between "waits behind someone" and "starts at once" is ONE
  // entry wide, and every other fixture in this file steps straight over it
  // (0, 2, 3, 1000). Mutating `entries.length > 0` to `> 1` used to leave the
  // whole suite green while a task that would wait behind exactly one other
  // was announced as starting immediately.
  test('a line of exactly ONE entry is still a line: rank 2, not “starts at once”', () => {
    const repo = makeRepo()
    const records = waiting(1)
    writeLine(repo, [id(1)])
    expect(lineQueue(repo, 'oneentry', records).projectedAdmission()).toEqual({
      admissible: true,
      position: 2,
    })
    // …and it is genuinely the entry that decides, not the claim: nothing is
    // running, so an EMPTY line in the same project answers null.
    expect(activeTask('oneentry')).toBeNull()
    writeLine(repo, [])
    expect(lineQueue(repo, 'oneentry', []).projectedAdmission()).toEqual({
      admissible: true,
      position: null,
    })
  })

  test('a full queue projects the very refusal enqueue would give', () => {
    const repo = makeRepo()
    const records = waiting(QUEUE_ENTRIES_MAX)
    writeLine(
      repo,
      records.map((r) => r.id),
    )
    const queue = lineQueue(repo, 'deadbeef', records)
    expect(queue.projectedAdmission()).toEqual({ admissible: false, reason: QUEUE_FULL })
    // Same words the real refusal uses — the preview's 503 and create's 503
    // are the same sentence because they read the same constant.
    expect(queue.enqueue(id(QUEUE_ENTRIES_MAX + 1))).toEqual({ ok: false, reason: QUEUE_FULL })
  })

  test('projecting mutates NOTHING: queue.json is byte-identical and no claim is taken', () => {
    const repo = makeRepo()
    const records = waiting(3)
    writeLine(
      repo,
      records.map((r) => r.id),
    )
    const queue = lineQueue(repo, 'readonly', records)
    const before = readFileSync(queuePath(repo), 'utf8')

    expect(queue.projectedAdmission()).toEqual({ admissible: true, position: 4 })
    expect(queue.projectedAdmission()).toEqual({ admissible: true, position: 4 })

    expect(readFileSync(queuePath(repo), 'utf8')).toBe(before)
    expect(queue.list().map((entry) => entry.id)).toEqual([id(1), id(2), id(3)])
    // Not admitted, not reserved: the guard is still free for whoever asks next.
    expect(activeTask('readonly')).toBeNull()
    expect(queue.claimActive(id(9))).toBe(true)
    releaseActive('readonly', id(9))
  })

  test('a project with no queue.json at all is not given one by a projection', () => {
    const repo = makeRepo()
    const queue = makeQueue(repo)
    expect(existsSync(queuePath(repo))).toBe(false)
    expect(queue.projectedAdmission()).toEqual({ admissible: true, position: null })
    expect(existsSync(queuePath(repo))).toBe(false)
  })

  // Review round 1, MAJEUR 2. The admission path reaches `enqueue` through
  // `recover()` → `reconcile()`, so what `create` meets is the RECONCILED
  // line. A projection that counted the file's raw entries answered about a
  // line that no longer exists — and the two answers were not "slightly off",
  // they were opposite verdicts on the same repo.
  describe('the projection answers about the RECONCILED line, never about the bytes', () => {
    test('entries whose records are already shipped hold no rank at all', () => {
      const repo = makeRepo()
      const shipped = Array.from({ length: 3 }, (_, i) =>
        record(id(i + 1), 'shipped', '2026-01-01T00:00:00.000Z'),
      )
      writeLine(
        repo,
        shipped.map((r) => r.id),
      )
      // Raw, the file says three are waiting — and it used to answer 4.
      expect(readQueue(repo).entries).toHaveLength(3)
      expect(lineQueue(repo, 'stale', shipped).projectedAdmission()).toEqual({
        admissible: true,
        position: null,
      })
    })

    test('a thousand entries no record backs is not a full queue, it is an empty one', () => {
      const repo = makeRepo()
      writeLine(
        repo,
        Array.from({ length: QUEUE_ENTRIES_MAX }, (_, i) => id(i + 1)),
      )
      // Not a 503: `create` would reconcile every one of them away and admit
      // the task at once, so a preview that refused it refused a creation
      // that succeeds.
      expect(lineQueue(repo, 'ghosts', []).projectedAdmission()).toEqual({
        admissible: true,
        position: null,
      })
    })

    test('a queued record the file never knew about is counted, exactly as reconcile counts it', () => {
      const repo = makeRepo()
      const records = waiting(2)
      // The file names only the first; the second is an orphan the rebuild
      // appends at the end — so the newcomer lands third, not second.
      writeLine(repo, [id(1)])
      expect(lineQueue(repo, 'orphan', records).projectedAdmission()).toEqual({
        admissible: true,
        position: 3,
      })
    })
  })

  // Review round 1, MAJEUR 1. Every other read of this queue REPORTS a
  // degradation through the sink, and the sink writes: a journal line per task
  // in the line, and `appendTaskEvent`'s own recursive mkdir under each of
  // them. A projection is what a dry run reads, and a dry run writes nothing.
  describe('a projection never reports, and never consumes the report', () => {
    const collecting = (repo: string, records: readonly TaskRecord[], seen: string[][]) =>
      reportingQueue(repo, records, (reason, ids) => seen.push([reason, ...ids]))

    test('an unreadable queue.json is projected against WITHOUT a single sink call', () => {
      const repo = makeRepo()
      truncatedQueue(repo)
      const records = waiting(3)
      const seen: string[][] = []

      // The rank is still the reconciled one: refusing to report is not
      // refusing to answer.
      expect(collecting(repo, records, seen).projectedAdmission()).toEqual({
        admissible: true,
        position: 4,
      })
      expect(seen).toEqual([])
      // And the bad bytes are still exactly where they were: no repair, no
      // evidence copy, no queue.json conjured beside them.
      expect(readFileSync(queuePath(repo), 'utf8')).toBe('{"version":1,"entries":[{"id"')
      expect(existsSync(corruptQueuePath(repo))).toBe(false)
    })

    // DP9's own premise, from the other side: `appendTaskEvent` mkdirs the
    // task's directory on its way to the journal, so the sink RESURRECTS a
    // task whose directory retention deleted. The control at the end is what
    // makes the assertion above a fact about the projection rather than about
    // this rig: the same queue, read for real, does resurrect it.
    test('a task whose directory is GONE is not brought back by a projection', () => {
      const repo = makeRepo()
      truncatedQueue(repo)
      const ghost = record(id(1), 'queued', '2026-01-01T00:00:00.000Z')
      const seen: string[] = []
      const queue = createTaskQueue({
        cwd: repo,
        projectId: 'ghosted',
        records: () => [ghost],
        recordExists: () => true,
        // The workspace's real sink, in miniature (task-server.ts).
        onDegraded: (reason, ids) => {
          seen.push(reason)
          for (const taskId of ids) {
            appendTaskEvent(repo, taskId, { type: 'error', data: { message: reason } })
          }
        },
      })
      expect(existsSync(taskDir(repo, id(1)))).toBe(false)

      expect(queue.projectedAdmission()).toEqual({ admissible: true, position: 2 })
      expect(seen).toEqual([])
      expect(existsSync(taskDir(repo, id(1)))).toBe(false)

      // Control: a real read of the very same queue goes through the sink…
      queue.list()
      expect(seen).toHaveLength(1)
      // …and that is what a directory coming back looks like.
      expect(existsSync(taskDir(repo, id(1)))).toBe(true)
    })

    test('the warning owed to the next REAL read is still owed after a projection', () => {
      const repo = makeRepo()
      truncatedQueue(repo)
      const records = waiting(2)
      const seen: string[][] = []

      // Three dry runs in a row…
      for (let n = 0; n < 3; n++) {
        expect(collecting(repo, records, seen).projectedAdmission()).toMatchObject({
          admissible: true,
        })
      }
      expect(seen).toEqual([])

      // …and the first listing still gets the whole warning. The report is
      // once-per-reason and process-wide: had a projection consumed it, this
      // would be silence, and the degradation would reach nobody.
      expect(collecting(repo, records, seen).list()).toHaveLength(2)
      expect(seen).toHaveLength(1)
      expect(seen[0]?.[0]).toContain(QUEUE_UNREADABLE)
      expect(seen[0]?.slice(1)).toEqual([id(1), id(2)])
    })
  })
})
