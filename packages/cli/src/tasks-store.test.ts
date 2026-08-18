import {
  appendFileSync,
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
  readTaskChecks,
  readTaskEvents,
  saveTask,
  taskDir,
  tasksDir,
  writeTaskChecks,
} from './tasks-store.js'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'codesema-tasks-'))
})

afterEach(() => {
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
