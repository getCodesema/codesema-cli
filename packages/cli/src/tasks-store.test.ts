import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  TASK_CHECK_TAIL_MAX,
  TASK_EVENT_DATA_STRING_MAX,
  type TaskChecks,
  type TaskRecord,
} from './contract.js'
import {
  appendTaskEvent,
  createTask,
  listTasks,
  loadTask,
  onStoreUnreadable,
  readTaskChecks,
  readTaskEvents,
  removeTaskDir,
  resetJournalCursors,
  resetStoreReports,
  saveTask,
  setJournalReader,
  taskDir,
  taskIdsOnDisk,
  taskRecordExists,
  tasksDir,
  writeTaskChecks,
} from './tasks-store.js'

/**
 * chmod does not bind root, so a suite run as root cannot exercise a
 * permission failure at all. The skip is gated on the UID and NOTHING else:
 * conditioning it on the failure being observed makes the test silently
 * assert nothing the day the failure stops happening.
 */
const RUNNING_AS_ROOT = process.getuid?.() === 0

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'codesema-tasks-'))
})

afterEach(() => {
  // Both are process-wide test seams: leaving either armed would leak the
  // counting reader (or a warm cursor) into the next test.
  setJournalReader(null)
  resetJournalCursors()
  resetStoreReports()
  rmSync(cwd, { recursive: true, force: true })
})

const input = {
  title: 'Add rate limiting',
  prompt: 'Add rate limiting to the API',
  autoShip: false,
  base: 'main',
  branch: 'codesema/task-add-rate-limiting',
  worktree: '/repo/.codesema/worktrees/x',
}

describe('createTask', () => {
  test('creates the directory, task.json, and a 12-hex id', () => {
    const record = createTask(cwd, input)
    expect(record.id).toMatch(/^[0-9a-f]{12}$/)
    expect(existsSync(join(taskDir(cwd, record.id), 'task.json'))).toBe(true)
    expect(record.status).toBe('queued')
    expect(record.auto_ship).toBe(false)
    expect(record.created_at).toBe(record.updated_at)
  })

  test('the initial prompt becomes the first open turn', () => {
    const record = createTask(cwd, input)
    expect(record.turns.length).toBe(1)
    expect(record.turns[0]?.prompt).toBe(input.prompt)
    expect(record.turns[0]?.response).toBeNull()
    expect(record.turns[0]?.question).toBeNull()
    expect(record.turns[0]?.ended_at).toBeNull()
  })

  test('two tasks get distinct ids and directories', () => {
    const a = createTask(cwd, input)
    const b = createTask(cwd, { ...input, title: 'Other' })
    expect(a.id).not.toBe(b.id)
    expect(listTasks(cwd).length).toBe(2)
  })

  test('.codesema/ gets its auto .gitignore (ensureWorkDir reused)', () => {
    createTask(cwd, input)
    expect(readFileSync(join(cwd, '.codesema', '.gitignore'), 'utf8')).toBe('*\n')
  })
})

describe('saveTask / loadTask round-trip', () => {
  test('a saved record loads back deep-equal', () => {
    const record = createTask(cwd, input)
    record.status = 'waiting_for_you'
    record.agent_session_id = 'sess-42'
    record.turns[0]!.response = 'Working on it'
    record.turns[0]!.question = 'Which limiter, token bucket or sliding window?'
    record.work_ms = 1234
    record.updated_at = new Date().toISOString()
    saveTask(cwd, record)
    expect(loadTask(cwd, record.id)).toEqual(record)
  })

  test('saveTask writes verbatim: updated_at is the caller responsibility', () => {
    const record = createTask(cwd, input)
    saveTask(cwd, record)
    expect(loadTask(cwd, record.id)?.updated_at).toBe(record.updated_at)
  })

  test('atomic write: no tmp file left behind, file is complete JSON', () => {
    const record = createTask(cwd, input)
    record.title = 'x'.repeat(150)
    saveTask(cwd, record)
    const names = readdirSync(taskDir(cwd, record.id))
    expect(names).not.toContain('task.json.tmp')
    // A partial write would fail to parse; the rename guarantees completeness.
    const parsed = JSON.parse(readFileSync(join(taskDir(cwd, record.id), 'task.json'), 'utf8'))
    expect(parsed.title).toBe(record.title)
  })

  test('unknown id: null', () => {
    expect(loadTask(cwd, 'aaaaaaaaaaaa')).toBeNull()
  })

  test('malformed id (traversal attempt): null, nothing read outside tasks/', () => {
    writeFileSync(join(cwd, 'task.json'), JSON.stringify(createTask(cwd, input)))
    expect(loadTask(cwd, '..')).toBeNull()
    expect(loadTask(cwd, 'A1B2C3D4E5F6')).toBeNull()
    expect(loadTask(cwd, '')).toBeNull()
  })

  test('corrupt task.json: null, never a crash', () => {
    const record = createTask(cwd, input)
    writeFileSync(join(taskDir(cwd, record.id), 'task.json'), '{ not json')
    expect(loadTask(cwd, record.id)).toBeNull()
  })

  test('task.json whose id does not match its directory: null', () => {
    const record = createTask(cwd, input)
    const moved = { ...record, id: 'ffffffffffff' }
    writeFileSync(join(taskDir(cwd, record.id), 'task.json'), JSON.stringify(moved))
    expect(loadTask(cwd, record.id)).toBeNull()
  })

  test('unknown status on disk degrades to failed via the sanitizer', () => {
    const record = createTask(cwd, input)
    const future = { ...record, status: 'hyper_done' }
    writeFileSync(join(taskDir(cwd, record.id), 'task.json'), JSON.stringify(future))
    expect(loadTask(cwd, record.id)?.status).toBe('failed')
  })
})

describe('listTasks', () => {
  test('no tasks dir yet: empty list', () => {
    expect(listTasks(cwd)).toEqual([])
  })

  test('sorted by updated_at desc', () => {
    const a = createTask(cwd, { ...input, title: 'a' })
    const b = createTask(cwd, { ...input, title: 'b' })
    const c = createTask(cwd, { ...input, title: 'c' })
    a.updated_at = '2026-08-14T10:00:00.000Z'
    b.updated_at = '2026-08-14T12:00:00.000Z'
    c.updated_at = '2026-08-14T11:00:00.000Z'
    saveTask(cwd, a)
    saveTask(cwd, b)
    saveTask(cwd, c)
    expect(listTasks(cwd).map((r) => r.title)).toEqual(['b', 'c', 'a'])
  })

  test('a corrupt task is skipped, the others survive', () => {
    const ok = createTask(cwd, { ...input, title: 'ok' })
    const broken = createTask(cwd, { ...input, title: 'broken' })
    writeFileSync(join(taskDir(cwd, broken.id), 'task.json'), 'garbage')
    const listed = listTasks(cwd)
    expect(listed.length).toBe(1)
    expect(listed[0]?.id).toBe(ok.id)
  })

  test('stray files and non-task directories under tasks/ are ignored', () => {
    const ok = createTask(cwd, input)
    writeFileSync(join(tasksDir(cwd), 'notes.txt'), 'hello')
    mkdirSync(join(tasksDir(cwd), 'not-a-task-id'))
    // A directory with a valid-looking name but no task.json is skipped too.
    mkdirSync(join(tasksDir(cwd), 'bbbbbbbbbbbb'))
    expect(listTasks(cwd).map((r) => r.id)).toEqual([ok.id])
  })
})

describe('appendTaskEvent / readTaskEvents', () => {
  let record: TaskRecord

  beforeEach(() => {
    record = createTask(cwd, input)
  })

  test('seq starts at 1 and increments across calls', () => {
    const e1 = appendTaskEvent(cwd, record.id, { type: 'turn_started', data: { turn: 1 } })
    const e2 = appendTaskEvent(cwd, record.id, { type: 'message', data: { text: 'hi' } })
    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)
    expect(typeof e1.at).toBe('string')
  })

  test('events round-trip through the journal in order', () => {
    appendTaskEvent(cwd, record.id, { type: 'turn_started', data: { turn: 1 } })
    appendTaskEvent(cwd, record.id, {
      type: 'tool_use',
      data: { tool: 'Edit', file: 'a.ts', ok: true, note: null },
    })
    const events = readTaskEvents(cwd, record.id)
    expect(events.map((e) => e.type)).toEqual(['turn_started', 'tool_use'])
    expect(events[1]?.data).toEqual({ tool: 'Edit', file: 'a.ts', ok: true, note: null })
  })

  test('event data is bounded at write time', () => {
    appendTaskEvent(cwd, record.id, {
      type: 'message',
      data: { text: 'x'.repeat(TASK_EVENT_DATA_STRING_MAX + 1000) },
    })
    const events = readTaskEvents(cwd, record.id)
    expect(events[0]?.data.text).toBe('x'.repeat(TASK_EVENT_DATA_STRING_MAX))
  })

  test('corrupt lines interleaved in the journal are skipped silently', () => {
    appendTaskEvent(cwd, record.id, { type: 'turn_started', data: {} })
    const journal = join(taskDir(cwd, record.id), 'events.jsonl')
    appendFileSync(journal, '{ truncated line\n')
    appendFileSync(journal, 'not json at all\n')
    appendFileSync(journal, '\n')
    appendTaskEvent(cwd, record.id, { type: 'message', data: { text: 'after' } })
    appendFileSync(journal, '{"seq":"NaN","type":"message","data":{}}\n')
    const events = readTaskEvents(cwd, record.id)
    expect(events.map((e) => e.type)).toEqual(['turn_started', 'message'])
  })

  test('seq stays monotonic after corrupt lines and re-reads', () => {
    appendTaskEvent(cwd, record.id, { type: 'turn_started', data: {} })
    appendTaskEvent(cwd, record.id, { type: 'message', data: {} })
    const journal = join(taskDir(cwd, record.id), 'events.jsonl')
    // Simulates a crash mid-append: the tail line is truncated.
    appendFileSync(journal, '{"seq":3,"at":"2026-08-14T10:0')
    const e = appendTaskEvent(cwd, record.id, { type: 'error', data: { message: 'boom' } })
    expect(e.seq).toBe(3)
    expect(readTaskEvents(cwd, record.id).map((x) => x.seq)).toEqual([1, 2, 3])
  })

  test('afterSeq filters strictly newer events (SSE catch-up)', () => {
    appendTaskEvent(cwd, record.id, { type: 'turn_started', data: {} })
    appendTaskEvent(cwd, record.id, { type: 'message', data: {} })
    appendTaskEvent(cwd, record.id, { type: 'question', data: { text: '?' } })
    expect(readTaskEvents(cwd, record.id, { afterSeq: 1 }).map((e) => e.seq)).toEqual([2, 3])
    expect(readTaskEvents(cwd, record.id, { afterSeq: 3 })).toEqual([])
    expect(readTaskEvents(cwd, record.id, { afterSeq: 0 }).length).toBe(3)
  })

  test('no journal yet: empty list, never a crash', () => {
    expect(readTaskEvents(cwd, record.id)).toEqual([])
    expect(readTaskEvents(cwd, 'cccccccccccc')).toEqual([])
  })

  test('malformed id: read returns empty, append throws loudly', () => {
    expect(readTaskEvents(cwd, '../oops')).toEqual([])
    expect(() => appendTaskEvent(cwd, '../oops', { type: 'message', data: {} })).toThrow()
  })
})

describe('journal cost: the in-memory seq cursor', () => {
  let record: TaskRecord

  beforeEach(() => {
    record = createTask(cwd, input)
  })

  /** Arms the read seam and returns the paths it was asked to read, in order. */
  function countReads(): string[] {
    const reads: string[] = []
    setJournalReader((path) => {
      reads.push(path)
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    })
    return reads
  }

  test('10 000 appends on one task read the journal exactly once', () => {
    const reads = countReads()
    for (let i = 0; i < 10_000; i += 1) {
      appendTaskEvent(cwd, record.id, { type: 'tool_use', data: { tool: 'Edit', ok: true } })
    }
    // The acceptance criterion is a CALL COUNT, never a stopwatch: recomputing
    // the seq by re-reading the whole journal made an append O(journal size).
    expect(reads).toHaveLength(1)
    setJournalReader(null)
    const events = readTaskEvents(cwd, record.id)
    expect(events).toHaveLength(10_000)
    expect(events.at(-1)?.seq).toBe(10_000)
  })

  test('a first append on an existing journal reads once, then resumes at max + 1', () => {
    appendTaskEvent(cwd, record.id, { type: 'turn_started', data: { turn: 1 } })
    appendTaskEvent(cwd, record.id, { type: 'message', data: { text: 'hi' } })
    resetJournalCursors()
    const reads = countReads()
    expect(appendTaskEvent(cwd, record.id, { type: 'message', data: { text: 'again' } }).seq).toBe(
      3,
    )
    expect(reads).toHaveLength(1)
    // The cursor is warm now: the next appends cost no read at all.
    expect(appendTaskEvent(cwd, record.id, { type: 'message', data: { text: 'more' } }).seq).toBe(4)
    expect(reads).toHaveLength(1)
  })

  test('seq stays strictly increasing and gapless across store restarts', () => {
    for (let i = 0; i < 5; i += 1) {
      appendTaskEvent(cwd, record.id, { type: 'message', data: { n: i } })
    }
    resetJournalCursors()
    for (let i = 0; i < 5; i += 1) {
      appendTaskEvent(cwd, record.id, { type: 'message', data: { n: 5 + i } })
    }
    resetJournalCursors()
    const last = appendTaskEvent(cwd, record.id, { type: 'shipped', data: {} })
    expect(last.seq).toBe(11)
    expect(readTaskEvents(cwd, record.id).map((e) => e.seq)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ])
  })

  test('a crash-truncated tail is still repaired by the first append after a restart', () => {
    appendTaskEvent(cwd, record.id, { type: 'turn_started', data: {} })
    appendTaskEvent(cwd, record.id, { type: 'message', data: {} })
    const journal = join(taskDir(cwd, record.id), 'events.jsonl')
    // Crash mid-append: the tail line has no newline. Only IT may be lost.
    appendFileSync(journal, '{"seq":3,"at":"2026-08-14T10:0')
    resetJournalCursors()
    const e = appendTaskEvent(cwd, record.id, { type: 'error', data: { message: 'boom' } })
    expect(e.seq).toBe(3)
    expect(readFileSync(journal, 'utf8')).toContain('10:0\n{')
    expect(readTaskEvents(cwd, record.id).map((x) => x.seq)).toEqual([1, 2, 3])
  })

  test('the cold cursor takes the max of the VALID seqs and never throws', () => {
    const journal = join(taskDir(cwd, record.id), 'events.jsonl')
    writeFileSync(
      journal,
      `${[
        '{"seq":1,"at":"2026-08-14T10:00:00.000Z","type":"turn_started","data":{}}',
        'not json at all',
        '{"seq":"NaN","type":"message","data":{}}',
        '{"seq":7,"at":"2026-08-14T10:02:00.000Z","type":"message","data":{"text":"seven"}}',
        '{"seq":4,"at":"2026-08-14T10:03:00.000Z","type":"hyper_event","data":{}}',
        '',
      ].join('\n')}`,
    )
    const e = appendTaskEvent(cwd, record.id, { type: 'message', data: { text: 'after' } })
    expect(e.seq).toBe(8)
    expect(readTaskEvents(cwd, record.id).map((x) => x.seq)).toEqual([1, 7, 8])
  })

  test('an append made behind our back invalidates the cached cursor', () => {
    appendTaskEvent(cwd, record.id, { type: 'turn_started', data: {} })
    const journal = join(taskDir(cwd, record.id), 'events.jsonl')
    // Another writer (or a hand edit) grew the file: the size no longer matches
    // what this process left, so the cursor is re-derived instead of trusted.
    appendFileSync(
      journal,
      '{"seq":9,"at":"2026-08-14T10:04:00.000Z","type":"message","data":{}}\n',
    )
    const reads = countReads()
    expect(appendTaskEvent(cwd, record.id, { type: 'message', data: {} }).seq).toBe(10)
    expect(reads).toHaveLength(1)
  })

  test('readTaskEvents({afterSeq}) stays exact on a journal written through the cursor', () => {
    for (let i = 1; i <= 50; i += 1) {
      appendTaskEvent(cwd, record.id, { type: 'message', data: { n: i } })
    }
    const caught = readTaskEvents(cwd, record.id, { afterSeq: 30 })
    expect(caught.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 31))
    // File order, not just the seq set: the SSE catch-up of J5 replays it as is.
    expect(caught.map((e) => e.data.n)).toEqual(Array.from({ length: 20 }, (_, i) => i + 31))
    expect(readTaskEvents(cwd, record.id, { afterSeq: 50 })).toEqual([])
    expect(readTaskEvents(cwd, record.id, { afterSeq: 0 })).toHaveLength(50)
  })

  test('a .codesema/tasks tree written by 0.12 is resumed without a gap', () => {
    // Fixture written by hand in the 0.12 on-disk format (unchanged here): a
    // task directory this process has never touched, journal included.
    const id = 'a1b2c3d4e5f6'
    const dir = join(tasksDir(cwd), id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'task.json'),
      `${JSON.stringify(
        {
          version: 1,
          id,
          title: 'Written by 0.12',
          status: 'waiting_for_you',
          base: 'main',
          branch: 'codesema/task-written-by-012',
          worktree: join(cwd, '.codesema', 'worktrees', id),
          agent_session_id: 'sess-012',
          turns: [
            {
              prompt: 'do the thing',
              response: 'done',
              question: null,
              started_at: '2026-08-14T09:00:00.000Z',
              ended_at: '2026-08-14T09:05:00.000Z',
            },
          ],
          review_ref: null,
          work_ms: 300_000,
          wait_ms: 0,
          auto_ship: false,
          work_on: false,
          isolation: 'policy',
          created_at: '2026-08-14T09:00:00.000Z',
          updated_at: '2026-08-14T09:05:00.000Z',
        },
        null,
        2,
      )}\n`,
    )
    writeFileSync(
      join(dir, 'events.jsonl'),
      `${[
        '{"seq":1,"at":"2026-08-14T09:00:00.000Z","type":"turn_started","data":{"turn":1}}',
        '{"seq":2,"at":"2026-08-14T09:01:00.000Z","type":"tool_use","data":{"tool":"Edit","file":"a.ts","ok":true,"note":null}}',
        '{"seq":3,"at":"2026-08-14T09:05:00.000Z","type":"message","data":{"text":"done"}}',
      ].join('\n')}\n`,
    )

    const e = appendTaskEvent(cwd, id, { type: 'review_started', data: { turn: 1 } })
    expect(e.seq).toBe(4)
    expect(readTaskEvents(cwd, id).map((x) => x.seq)).toEqual([1, 2, 3, 4])
    expect(readTaskEvents(cwd, id, { afterSeq: 2 }).map((x) => x.type)).toEqual([
      'message',
      'review_started',
    ])
    // The rest of the 0.12 tree stays readable, not just its journal.
    expect(loadTask(cwd, id)?.title).toBe('Written by 0.12')
  })
})

describe('readTaskChecks / writeTaskChecks', () => {
  let record: TaskRecord

  beforeEach(() => {
    record = createTask(cwd, input)
  })

  const checks = (over: Partial<TaskChecks> = {}): TaskChecks => ({
    head_sha: 'abc123',
    started_at: '2026-08-14T10:00:00.000Z',
    finished_at: '2026-08-14T10:01:00.000Z',
    status: 'passed',
    checks: [
      { command: 'bun test', status: 'passed', exit_code: 0, duration_ms: 1200, tail: 'ok\n' },
    ],
    error: null,
    ...over,
  })

  test('round-trips through disk, atomically (no tmp file left behind)', () => {
    const written = writeTaskChecks(cwd, record.id, checks())
    expect(readTaskChecks(cwd, record.id)).toEqual(written)
    expect(existsSync(join(taskDir(cwd, record.id), 'checks.json'))).toBe(true)
    expect(existsSync(join(taskDir(cwd, record.id), 'checks.json.tmp'))).toBe(false)
  })

  test('each write overwrites the previous run', () => {
    writeTaskChecks(cwd, record.id, checks({ status: 'running', finished_at: null }))
    writeTaskChecks(cwd, record.id, checks({ status: 'failed' }))
    expect(readTaskChecks(cwd, record.id)?.status).toBe('failed')
  })

  test('the write sanitizes: oversized tail is truncated on disk and in the returned copy', () => {
    const big = checks()
    big.checks[0]!.tail = `${'x'.repeat(TASK_CHECK_TAIL_MAX + 500)}END`
    const written = writeTaskChecks(cwd, record.id, big)
    expect(written.checks[0]?.tail.length).toBe(TASK_CHECK_TAIL_MAX)
    expect(readTaskChecks(cwd, record.id)?.checks[0]?.tail.endsWith('END')).toBe(true)
  })

  test('never run, corrupt file or unusable content: null, never a crash', () => {
    expect(readTaskChecks(cwd, record.id)).toBeNull()
    const path = join(taskDir(cwd, record.id), 'checks.json')
    writeFileSync(path, '{ not json')
    expect(readTaskChecks(cwd, record.id)).toBeNull()
    writeFileSync(path, JSON.stringify({ status: 'greenish' }))
    expect(readTaskChecks(cwd, record.id)).toBeNull()
  })

  test('malformed id: read returns null, write throws loudly', () => {
    expect(readTaskChecks(cwd, '../oops')).toBeNull()
    expect(() => writeTaskChecks(cwd, '../oops', checks())).toThrow()
  })

  test('a payload the sanitizer rejects is refused, not written', () => {
    expect(() =>
      writeTaskChecks(cwd, record.id, { status: 'nope' } as unknown as TaskChecks),
    ).toThrow()
    expect(existsSync(join(taskDir(cwd, record.id), 'checks.json'))).toBe(false)
  })
})

// T1.2: the queue sweep DELETES entries on a null loadTask, so it needs the
// difference between "no such task" and "I could not find out". Collapsing the
// second into the first costs a perfectly valid task its place in the line.
describe('taskRecordExists', () => {
  test('true for a record that is there, even when it is illegible', () => {
    const record = createTask(cwd, { ...input, title: 'legible' })
    expect(taskRecordExists(cwd, record.id)).toBe(true)

    writeFileSync(join(taskDir(cwd, record.id), 'task.json'), '{ truncated')
    // Unreadable is NOT gone: loadTask says nothing, this still says it exists.
    expect(loadTask(cwd, record.id)).toBeNull()
    expect(taskRecordExists(cwd, record.id)).toBe(true)
  })

  test('false only when it is genuinely not there', () => {
    const record = createTask(cwd, { ...input, title: 'doomed' })
    rmSync(taskDir(cwd, record.id), { recursive: true, force: true })
    expect(taskRecordExists(cwd, record.id)).toBe(false)
    expect(taskRecordExists(cwd, 'aaaaaaaaaaaa')).toBe(false)
    // An id the store could never resolve is not a task at all.
    expect(taskRecordExists(cwd, '../escape')).toBe(false)
  })

  test.skipIf(RUNNING_AS_ROOT)(
    'a task DIRECTORY we cannot even look into is not reported as gone',
    () => {
      const record = createTask(cwd, { ...input, title: 'locked away' })
      chmodSync(taskDir(cwd, record.id), 0o000)
      try {
        // EACCES on the directory: we could not find out, and "could not find
        // out" must never be read as "gone" by a caller that evicts on false.
        expect(taskRecordExists(cwd, record.id)).toBe(true)
      } finally {
        chmodSync(taskDir(cwd, record.id), 0o700)
      }
    },
  )
})

// T1.2 re-review round 7, BLOQUANT 2: the queue's "a record we could not place
// is at least NAMED" rests entirely on this function, and every test of that
// behaviour injected a hand-written `idsOnDisk`. The filters and the catch
// below were exercised by nothing at all — a version returning [] left the
// whole suite green while the feature silently disappeared. Real filesystem,
// no seam.
describe('taskIdsOnDisk', () => {
  test('every task DIRECTORY, readable or not — and nothing else', () => {
    const readable = createTask(cwd, { ...input, title: 'readable' })
    const illegible = createTask(cwd, { ...input, title: 'illegible' })
    writeFileSync(join(taskDir(cwd, illegible.id), 'task.json'), '{ truncated')

    // Things that are NOT tasks, next door: a file where a directory would be,
    // a directory whose name is not a task id, and one in the wrong charset.
    writeFileSync(join(tasksDir(cwd), 'aaaaaaaaaaab'), 'a file, not a directory')
    mkdirSync(join(tasksDir(cwd), 'not-an-id'), { recursive: true })
    mkdirSync(join(tasksDir(cwd), 'ZZZZZZZZZZZZ'), { recursive: true })

    const ids = taskIdsOnDisk(cwd)
    expect(new Set(ids)).toEqual(new Set([readable.id, illegible.id]))
    // The illegible one is the whole point: listTasks drops it, this keeps it.
    expect(listTasks(cwd).map((r) => r.id)).toEqual([readable.id])
  })

  test('no tasks directory at all is simply no tasks', () => {
    expect(taskIdsOnDisk(cwd)).toEqual([])
  })

  test.skipIf(RUNNING_AS_ROOT)(
    'a tasks directory it cannot LIST yields nothing, never a throw — and SAYS so',
    () => {
      createTask(cwd, { ...input, title: 'hidden' })
      const said: { cwd: string; reason: string }[] = []
      onStoreUnreadable((where, reason) => said.push({ cwd: where, reason }))
      chmodSync(tasksDir(cwd), 0o000)
      try {
        expect(taskIdsOnDisk(cwd)).toEqual([])
        // Same guard on the neighbour that rebuilds from it: the queue's list()
        // is documented as never throwing and reads through here.
        expect(listTasks(cwd)).toEqual([])
      } finally {
        chmodSync(tasksDir(cwd), 0o700)
      }
      // T1.2 re-review round 8, BLOQUANT 2: the guard above bought invariant 1
      // (tolerant reads) by spending invariant 2 (no silent degradation). An
      // empty answer from a store full of tasks is the single most misleading
      // value this module can return, and both readers used to return it
      // without a word. Literal anchor, not `toContain(storeUnlistable(...))`:
      // asserting a message against the very function that built it proves
      // nothing about its content.
      expect(said).toHaveLength(1)
      expect(said[0]?.cwd).toBe(cwd)
      expect(said[0]?.reason).toContain('the task store of this project could not be listed')
      expect(said[0]?.reason).toContain('EACCES')
      expect(said[0]?.reason).toContain('no task is treated as gone')
    },
  )

  // T1.9 review round 3, Mineur 10: every test of the store guard denied
  // access on `tasks/` itself — the READDIR failure path, which existed even
  // BEFORE the CRITIQUE fix (`statSync` was added ON TOP of it, guarding the
  // STAT of `tasks/` itself). None of them exercised the branch the fix
  // actually added: a `statSync(tasksDir(cwd))` that fails for a reason OTHER
  // than "never created" — the exact case `existsSync` used to collapse into
  // `false` (a store this process genuinely has, just cannot currently see).
  // Reproduced by denying traversal on tasks/'s PARENT (`.codesema/`): the
  // directory has never been listed, only `statSync`'d, so this can only be
  // caught by the code this round's CRITIQUE fix touched.
  test.skipIf(RUNNING_AS_ROOT)(
    'tasks/ unreachable through its PARENT (EACCES on statSync, not on readdir) is reported, never read as "never created"',
    () => {
      createTask(cwd, { ...input, title: 'hidden' })
      const said: { cwd: string; reason: string }[] = []
      onStoreUnreadable((where, reason) => said.push({ cwd: where, reason }))
      const workDir = join(cwd, '.codesema')
      chmodSync(workDir, 0o000)
      try {
        expect(taskIdsOnDisk(cwd)).toEqual([])
        expect(listTasks(cwd)).toEqual([])
      } finally {
        chmodSync(workDir, 0o700)
      }
      // The whole point: this is NOT "a store that was never created" (that
      // case reports NOTHING, see the test below) — it is a store this
      // process could not reach, and invariant 2 forbids conflating the two.
      expect(said.length).toBeGreaterThan(0)
      expect(said[0]?.cwd).toBe(cwd)
      expect(said[0]?.reason).toContain('EACCES')
    },
  )

  test.skipIf(RUNNING_AS_ROOT)(
    'one dark store is one notice, and it re-arms once it clears',
    () => {
      createTask(cwd, { ...input, title: 'hidden' })
      const said: string[] = []
      onStoreUnreadable((_where, reason) => said.push(reason))
      chmodSync(tasksDir(cwd), 0o000)
      try {
        // Both readers, several times over: a store read on every listing must
        // not turn one broken directory into a stream of identical notices.
        taskIdsOnDisk(cwd)
        listTasks(cwd)
        taskIdsOnDisk(cwd)
        expect(said).toHaveLength(1)
      } finally {
        chmodSync(tasksDir(cwd), 0o700)
      }
      // Readable again: the incident is forgotten, so a RELAPSE is said afresh
      // rather than swallowed by a memory of the previous one.
      expect(listTasks(cwd)).toHaveLength(1)
      chmodSync(tasksDir(cwd), 0o000)
      try {
        expect(listTasks(cwd)).toEqual([])
      } finally {
        chmodSync(tasksDir(cwd), 0o700)
      }
      expect(said).toHaveLength(2)
    },
  )

  test('a store that was never created is not a store that broke', () => {
    const said: string[] = []
    onStoreUnreadable((_where, reason) => said.push(reason))
    expect(listTasks(cwd)).toEqual([])
    expect(taskIdsOnDisk(cwd)).toEqual([])
    expect(said).toEqual([])
  })

  // T1.2 re-review round 9: the sink path above is well covered — and the sink
  // is what the TASK SERVER registers. Every CLI path that never starts the
  // task server (a review, a prep, a ship) has none, and there the console is
  // the only voice invariant 2 has left. Nothing held either of its two
  // branches, which is how a last resort quietly stops being one.
  test.skipIf(RUNNING_AS_ROOT)('with NO sink registered, the console is the voice', () => {
    createTask(cwd, { ...input, title: 'hidden' })
    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }
    chmodSync(tasksDir(cwd), 0o000)
    try {
      expect(listTasks(cwd)).toEqual([])
    } finally {
      chmodSync(tasksDir(cwd), 0o700)
      console.warn = realWarn
    }
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('the task store of this project could not be listed')
  })

  test.skipIf(RUNNING_AS_ROOT)('a sink that THROWS does not take the degradation with it', () => {
    createTask(cwd, { ...input, title: 'hidden' })
    onStoreUnreadable(() => {
      throw new Error('listener blew up')
    })
    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }
    chmodSync(tasksDir(cwd), 0o000)
    try {
      // Contained: a broken listener must not turn a tolerated read into a
      // crash for every caller of the store.
      expect(listTasks(cwd)).toEqual([])
    } finally {
      chmodSync(tasksDir(cwd), 0o700)
      console.warn = realWarn
    }
    // …and not hidden either: the reason still reached a human.
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('the task store of this project could not be listed')
  })
})

describe('removeTaskDir', () => {
  test('removes the whole task directory: task.json, events.jsonl, checks.json, everything', () => {
    const task = createTask(cwd, { ...input, title: 'to purge' })
    appendTaskEvent(cwd, task.id, { type: 'error', data: { message: 'x' } })
    expect(existsSync(taskDir(cwd, task.id))).toBe(true)

    expect(removeTaskDir(cwd, task.id)).toBe(true)

    expect(existsSync(taskDir(cwd, task.id))).toBe(false)
  })

  test('a directory that was already gone is still a success, not a failure', () => {
    expect(removeTaskDir(cwd, 'aaaaaaaaaaaa')).toBe(true)
  })

  // T1.9 review round 1, Mineur 5: `isTaskId` is the ONLY thing standing
  // between this function's `id` argument and `taskDir(cwd, id)` — join()
  // resolves `..` segments exactly like any other path component, so an id
  // that is not a valid 12-hex task id must be refused before it ever
  // reaches rmSync, or a path-traversal-shaped "id" would let this recursive
  // delete escape .codesema/tasks/ entirely. Proven directly: a sibling
  // directory outside tasks/ survives a call built to reach it.
  test('an id shaped like a path-traversal attempt is refused before anything is touched', () => {
    const outside = join(cwd, 'not-a-task-dir')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'canary.txt'), 'must survive')

    const traversal = `../../../../../../..${outside}`
    expect(removeTaskDir(cwd, traversal)).toBe(false)

    expect(existsSync(join(outside, 'canary.txt'))).toBe(true)
  })

  test('a garden-variety invalid id (too short, uppercase, non-hex) is refused the same way', () => {
    expect(removeTaskDir(cwd, 'not-hex')).toBe(false)
    expect(removeTaskDir(cwd, 'AAAAAAAAAAAA')).toBe(false)
    expect(removeTaskDir(cwd, '')).toBe(false)
  })
})
