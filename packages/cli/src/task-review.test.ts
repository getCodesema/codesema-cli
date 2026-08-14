import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { Finding, ReviewRecord, TaskRecord, TaskStatus, Verdict } from './contract.js'
import { archiveRecord } from './record.js'
import type { runSimpleFlow, SimpleOutcome } from './review.js'
import {
  buildFixTurnPrompt,
  createTaskReviewer,
  taskReviewVerdict,
  type CreateTaskReviewerOptions,
} from './task-review.js'
import { createTaskRunner, type TaskTurnIo } from './task-runner.js'
import { createTaskWorktree } from './task-worktree.js'
import {
  createTask,
  loadTask,
  readTaskEvents,
  saveTask,
  type AppendTaskEventInput,
} from './tasks-store.js'

// --- rig ------------------------------------------------------------------

const cleanups: string[] = []

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'codesema-task-review-'))
  cleanups.push(repo)
  const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  run(['init', '-b', 'main'])
  run(['config', 'user.email', 't@t'])
  run(['config', 'user.name', 't'])
  writeFileSync(join(repo, 'base.txt'), 'a\n')
  run(['add', '-A'])
  run(['commit', '-m', 'init: base'])
  return repo
}

/** A persisted task with a real worktree, as the runner leaves it mid-review. */
function makeTaskWithWorktree(repo: string, title: string): TaskRecord {
  const record = createTask(repo, {
    title,
    prompt: 'do work',
    autoShip: false,
    base: '',
    branch: '',
    worktree: '',
  })
  const wt = createTaskWorktree(repo, record.id, title)
  record.base = wt.base
  record.branch = wt.branch
  record.worktree = wt.worktree
  record.status = 'reviewing'
  saveTask(repo, record)
  return record
}

/** Simulates the runner's end-of-turn commit inside the worktree. */
function commitChange(worktree: string, name: string): void {
  writeFileSync(join(worktree, name), `content of ${name}\n`)
  const run = (args: string[]) => execFileSync('git', args, { cwd: worktree, stdio: 'ignore' })
  run(['add', '-A'])
  run(['commit', '-m', `add ${name}`])
}

type IoRig = {
  io: TaskTurnIo
  events: AppendTaskEventInput[]
  /** Status snapshot at each persist call: the last one is the final state. */
  persisted: TaskStatus[]
  texts: string[]
}

function fakeIo(record: TaskRecord): IoRig {
  const rig: IoRig = { events: [], persisted: [], texts: [], io: null as unknown as TaskTurnIo }
  rig.io = {
    emit: (input) => rig.events.push(input),
    persist: () => rig.persisted.push(record.status),
    text: (text) => rig.texts.push(text),
  }
  return rig
}

function fakeReview(verdict: Verdict, findings: Finding[] = []): ReviewRecord {
  return {
    version: 1,
    meta: {
      title: 'task review',
      branch: 'codesema/task-x',
      target: 'main',
      merge_base: 'abc',
      repo_root: '/nowhere',
      created_at: new Date().toISOString(),
    },
    commits: [],
    diff: '',
    review: { verdict, summary: 'summary', findings, narrative: null },
  }
}

type SimpleFlowOptions = Parameters<typeof runSimpleFlow>[0]

function fakeSimpleFlow(outcome: SimpleOutcome | ((opts: SimpleFlowOptions) => SimpleOutcome)) {
  const calls: SimpleFlowOptions[] = []
  const fn = (options: SimpleFlowOptions): Promise<SimpleOutcome> => {
    calls.push(options)
    return Promise.resolve(typeof outcome === 'function' ? outcome(options) : outcome)
  }
  return { calls, fn }
}

function reviewer(
  repo: string,
  overrides: Partial<CreateTaskReviewerOptions> = {},
): ReturnType<typeof createTaskReviewer> {
  return createTaskReviewer({
    cwd: repo,
    command: 'claude -p',
    timeoutMs: 1000,
    ...overrides,
  })
}

// --- taskReviewVerdict ----------------------------------------------------

describe('taskReviewVerdict', () => {
  const major: Finding = { file: 'a.ts', severity: 'major', message: 'bug' }
  const info: Finding = { file: 'a.ts', severity: 'info', message: 'nit' }
  const praise: Finding = { file: 'a.ts', severity: 'major', kind: 'praise', message: 'nice' }

  test('approve is ok, request_changes is ko, whatever the findings', () => {
    expect(taskReviewVerdict(fakeReview('approve', [major]))).toBe('review_ok')
    expect(taskReviewVerdict(fakeReview('request_changes'))).toBe('review_ko')
  })

  test('comment is ko only with an actionable finding (non-info, non-praise/why)', () => {
    expect(taskReviewVerdict(fakeReview('comment', [major]))).toBe('review_ko')
    expect(taskReviewVerdict(fakeReview('comment', [info, praise]))).toBe('review_ok')
    expect(taskReviewVerdict(fakeReview('comment'))).toBe('review_ok')
  })
})

// --- createTaskReviewer ---------------------------------------------------

describe('createTaskReviewer', () => {
  test('no diff vs base: review_ok without ever spawning a review', async () => {
    const repo = makeRepo()
    const record = makeTaskWithWorktree(repo, 'idle task')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: false, failure: 'run', message: 'must not be called' })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(flow.calls).toHaveLength(0)
    expect(record.status).toBe('review_ok')
    expect(record.review_ref).toBeNull()
    expect(rig.persisted).toEqual(['review_ok'])
    expect(rig.events).toEqual([{ type: 'message', data: { text: 'no changes' } }])
  })

  test('approve verdict: review_ok, archive in the MAIN repo, review_done event', async () => {
    const repo = makeRepo()
    const record = makeTaskWithWorktree(repo, 'green task')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(record.status).toBe('review_ok')
    // Real prep ran on the worktree: the flow saw the task's cumulative diff.
    expect(flow.calls[0]?.input.repo_root).toBe(record.worktree)
    expect(flow.calls[0]?.input.diff).toContain('feature.txt')
    expect(flow.calls[0]?.input.branch).toBe(record.branch)
    // Archived under <main repo>/.codesema/reviews, never in the worktree.
    expect(record.review_ref).toStartWith(join(repo, '.codesema', 'reviews'))
    expect(record.review_ref?.startsWith(record.worktree)).toBe(false)
    expect(existsSync(record.review_ref ?? '')).toBe(true)
    expect(rig.events.map((e) => e.type)).toEqual(['review_started', 'review_done'])
    expect(rig.events[1]?.data).toEqual({ verdict: 'approve', findings_count: 0 })
  })

  test('request_changes verdict lands on review_ko with the findings count', async () => {
    const repo = makeRepo()
    const record = makeTaskWithWorktree(repo, 'red task')
    commitChange(record.worktree, 'buggy.txt')
    const rig = fakeIo(record)
    const finding: Finding = { file: 'buggy.txt', severity: 'critical', message: 'oh no' }
    const flow = fakeSimpleFlow({
      ok: true,
      record: fakeReview('request_changes', [finding]),
      reportLines: [],
    })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(record.status).toBe('review_ko')
    expect(record.review_ref).not.toBeNull()
    expect(rig.events[1]?.data).toEqual({ verdict: 'request_changes', findings_count: 1 })
  })

  test('a failed review is review_ko with an error event, never a throw', async () => {
    const repo = makeRepo()
    const record = makeTaskWithWorktree(repo, 'flaky review')
    commitChange(record.worktree, 'work.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: false, failure: 'run', message: 'agent timed out' })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(record.status).toBe('review_ko')
    expect(record.review_ref).toBeNull()
    expect(rig.events.map((e) => e.type)).toEqual(['review_started', 'error'])
    expect(rig.events[1]?.data.message).toBe('review failed: agent timed out')
  })

  test('a prep crash follows the same review_ko path', async () => {
    const repo = makeRepo()
    const record = makeTaskWithWorktree(repo, 'bad prep')
    commitChange(record.worktree, 'work.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, {
      runSimpleFlowFn: flow.fn,
      prepFn: () => {
        throw new Error('target vanished')
      },
    })(record, rig.io)

    expect(flow.calls).toHaveLength(0)
    expect(record.status).toBe('review_ko')
    expect(rig.events.map((e) => e.type)).toEqual(['review_started', 'error'])
    expect(rig.events[1]?.data.message).toBe('review failed: target vanished')
  })

  test('session partials are relayed as SSE-only progress, never journal events', async () => {
    const repo = makeRepo()
    const record = makeTaskWithWorktree(repo, 'streamed review')
    commitChange(record.worktree, 'work.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow((options) => {
      options.session.setPartial({
        findings: [{ file: 'work.txt', message: 'found something' }],
        stepTitles: [],
      })
      return { ok: true, record: fakeReview('approve'), reportLines: [] }
    })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(rig.texts).toHaveLength(1)
    // Only the bounded lifecycle events reach the persisted journal.
    expect(rig.events.map((e) => e.type)).toEqual(['review_started', 'review_done'])
  })

  test("mode 'dual' drives runDualFlow and tags the review_started event", async () => {
    const repo = makeRepo()
    const record = makeTaskWithWorktree(repo, 'dual task')
    commitChange(record.worktree, 'work.txt')
    const rig = fakeIo(record)
    const simple = fakeSimpleFlow({ ok: false, failure: 'run', message: 'wrong flow' })
    let dualCalls = 0

    await reviewer(repo, {
      mode: 'dual',
      runSimpleFlowFn: simple.fn,
      runDualFlowFn: () => {
        dualCalls++
        return Promise.resolve({ ok: true, record: fakeReview('approve'), reportLines: [] })
      },
    })(record, rig.io)

    expect(simple.calls).toHaveLength(0)
    expect(dualCalls).toBe(1)
    expect(record.status).toBe('review_ok')
    expect(rig.events[0]).toMatchObject({ type: 'review_started', data: { mode: 'dual' } })
  })
})

// --- buildFixTurnPrompt ---------------------------------------------------

describe('buildFixTurnPrompt', () => {
  test('rebuilds the fix prompt from the archived review', () => {
    const repo = makeRepo()
    const finding: Finding = { file: 'a.ts', line: 3, severity: 'major', message: 'off by one' }
    const saved = archiveRecord(fakeReview('request_changes', [finding]), repo)
    const task = { review_ref: saved } as TaskRecord

    const prompt = buildFixTurnPrompt(task, [0])
    expect(prompt).toContain('off by one')
    expect(prompt).toContain('applying code review fixes')
    // Unknown finding ids are silently dropped by buildAgentFixPrompt.
    expect(buildFixTurnPrompt(task, [99])).not.toContain('off by one')
  })

  test('null without an archive, on a missing file and on corrupt JSON', () => {
    const repo = makeRepo()
    expect(buildFixTurnPrompt({ review_ref: null } as TaskRecord, [0])).toBeNull()
    expect(
      buildFixTurnPrompt({ review_ref: join(repo, 'nope.json') } as TaskRecord, [0]),
    ).toBeNull()
    const corrupt = join(repo, 'corrupt.json')
    writeFileSync(corrupt, '{not json')
    expect(buildFixTurnPrompt({ review_ref: corrupt } as TaskRecord, [0])).toBeNull()
  })
})

// --- runner integration: done turn -> reviewing -> verdict ----------------

describe('task runner with the reviewer hooked on onTurnDone', () => {
  const jsonl = (events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
  const claudeStream = (response: string) =>
    jsonl([
      { type: 'system', subtype: 'init', session_id: 'sess-rev' },
      { type: 'result', result: response },
    ])

  /** Fake claude that writes a file into the worktree, so the runner commits. */
  const writingAgent =
    (response: string) =>
    (options: { cwd: string; onText?: (text: string) => void }): Promise<string> => {
      writeFileSync(join(options.cwd, 'feature.txt'), 'made by agent\n')
      const raw = claudeStream(response)
      options.onText?.(raw)
      return Promise.resolve(raw)
    }

  async function until(cond: () => boolean, timeoutMs = 3000): Promise<void> {
    const start = Date.now()
    while (!cond()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('timeout waiting for condition')
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  test('done turn flows queued -> running -> reviewing -> review_ok, then reply is accepted', async () => {
    const repo = makeRepo()
    const task = createTask(repo, {
      title: 'Reviewed feature',
      prompt: 'write feature.txt',
      autoShip: false,
      base: '',
      branch: '',
      worktree: '',
    })
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })
    const statuses: TaskStatus[] = []
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      onTask: (record) => statuses.push(record.status),
      runAgentFn: writingAgent('feature written'),
      onTurnDone: reviewer(repo, { runSimpleFlowFn: flow.fn }),
    })

    expect(runner.start(task)).toEqual({ ok: true })
    await until(() => loadTask(repo, task.id)?.status === 'review_ok')

    expect(statuses).toEqual(['running', 'reviewing', 'review_ok'])
    const record = loadTask(repo, task.id)
    expect(record?.review_ref).toStartWith(join(repo, '.codesema', 'reviews'))
    const types = readTaskEvents(repo, task.id).map((e) => e.type)
    expect(types).toContain('commit')
    expect(types).toContain('review_started')
    expect(types).toContain('review_done')
    // The commit precedes the review: the reviewed diff is the committed work.
    expect(types.indexOf('commit')).toBeLessThan(types.indexOf('review_started'))

    // 'review_ok' is replyable: the follow-up turn goes through a new review.
    expect(runner.reply(task.id, 'polish it')).toEqual({ ok: true })
    await until(
      () =>
        loadTask(repo, task.id)?.turns.length === 2 &&
        loadTask(repo, task.id)?.status === 'review_ok',
    )
  })

  test('a review failure leaves the task on review_ko, not failed, work intact', async () => {
    const repo = makeRepo()
    const task = createTask(repo, {
      title: 'Review blows up',
      prompt: 'write feature.txt',
      autoShip: false,
      base: '',
      branch: '',
      worktree: '',
    })
    const flow = fakeSimpleFlow({ ok: false, failure: 'run', message: 'review agent died' })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: writingAgent('all done'),
      onTurnDone: reviewer(repo, { runSimpleFlowFn: flow.fn }),
    })

    runner.start(task)
    await until(() => loadTask(repo, task.id)?.status === 'review_ko')

    const record = loadTask(repo, task.id)
    // The turn itself succeeded: response recorded, commit kept.
    expect(record?.turns[0]?.response).toBe('all done')
    expect(record?.review_ref).toBeNull()
    const types = readTaskEvents(repo, task.id).map((e) => e.type)
    expect(types).toContain('commit')
    expect(types).toContain('error')
    // 'review_ko' is replyable too: that's the "fix the findings" path.
    expect(runner.reply(task.id, 'try again')).toEqual({ ok: true })
  })

  test('a question turn never triggers the reviewer', async () => {
    const repo = makeRepo()
    const task = createTask(repo, {
      title: 'Asks first',
      prompt: 'p',
      autoShip: false,
      base: '',
      branch: '',
      worktree: '',
    })
    const flow = fakeSimpleFlow({ ok: false, failure: 'run', message: 'must not be called' })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: (options: { onText?: (text: string) => void }) => {
        const raw = claudeStream('Blocked.\nQUESTION: which way?')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
      onTurnDone: reviewer(repo, { runSimpleFlowFn: flow.fn }),
    })

    runner.start(task)
    await until(() => loadTask(repo, task.id)?.status === 'waiting_for_you')
    expect(flow.calls).toHaveLength(0)
    expect(readTaskEvents(repo, task.id).map((e) => e.type)).not.toContain('review_started')
  })
})
