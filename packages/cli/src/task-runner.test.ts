import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentRunOptions } from './agent.js'
import type { TaskEvent, TaskRecord, TaskStatus } from './contract.js'
import { tryGit } from './git.js'
import {
  buildTaskPrompt,
  createTaskRunner,
  createTaskSlotPool,
  parseTaskQuestion,
  runTaskTurn,
  supportsSessionResume,
  taskCommandFor,
} from './task-runner.js'
import { appendTaskEvent, createTask, loadTask, readTaskEvents } from './tasks-store.js'

// --- pure helpers ---

describe('taskCommandFor', () => {
  test('claude write mode: edit tools + stream flags + fresh session id', () => {
    const cmd = taskCommandFor('claude -p', { session: { kind: 'new', id: 'uuid-1' } })
    expect(cmd).toContain('--permission-mode acceptEdits')
    expect(cmd).toContain('--output-format stream-json --include-partial-messages --verbose')
    expect(cmd).toContain('--session-id uuid-1')
    expect(cmd).not.toContain('--resume')
  })

  test('claude later turns resume the stored session', () => {
    const cmd = taskCommandFor('claude -p', { session: { kind: 'resume', id: 'sess-9' } })
    expect(cmd).toContain('--resume sess-9')
    expect(cmd).not.toContain('--session-id')
  })

  test('codex and gemini get their edit flags but never session flags', () => {
    expect(taskCommandFor('codex exec -', { session: null })).toBe(
      'codex exec --sandbox workspace-write -',
    )
    expect(taskCommandFor('gemini', { session: null })).toBe('gemini --approval-mode auto_edit')
  })

  test('a custom claude output format disables the stream flags but keeps the session', () => {
    const cmd = taskCommandFor('claude -p --output-format json', {
      session: { kind: 'new', id: 'uuid-1' },
    })
    expect(cmd).not.toContain('stream-json')
    expect(cmd).toContain('--session-id uuid-1')
  })
})

describe('supportsSessionResume', () => {
  test('claude in print mode only', () => {
    expect(supportsSessionResume('claude -p')).toBe(true)
    expect(supportsSessionResume('claude -p --model opus')).toBe(true)
    expect(supportsSessionResume('claude --model opus')).toBe(false)
    expect(supportsSessionResume('codex exec -')).toBe(false)
    expect(supportsSessionResume('gemini')).toBe(false)
  })
})

describe('buildTaskPrompt / parseTaskQuestion', () => {
  const task = { title: 'Add rate limiting' } as TaskRecord

  test('the prompt carries the title, the no-commit rule and the QUESTION protocol, no persona', () => {
    const prompt = buildTaskPrompt(task)
    expect(prompt).toContain('Add rate limiting')
    expect(prompt).toContain('Do NOT commit')
    expect(prompt).toContain('QUESTION: <your question>')
    // The roles layer is gone: the task prompt is neutral, no role section.
    expect(prompt).not.toContain('Role instructions:')
  })

  test('a QUESTION on the last line is parsed, mid-prose mentions are not', () => {
    expect(parseTaskQuestion('did stuff\nQUESTION: Redis or in-memory?')).toBe(
      'Redis or in-memory?',
    )
    expect(parseTaskQuestion('did stuff\nQUESTION: Redis or in-memory?\n\n')).toBe(
      'Redis or in-memory?',
    )
    expect(parseTaskQuestion('I asked myself QUESTION: what now?\nThen I fixed it.')).toBeNull()
    expect(parseTaskQuestion('all done, tests pass')).toBeNull()
    expect(parseTaskQuestion('QUESTION:')).toBeNull()
  })
})

// --- test rig: real git repo + real store + injected agent ---

const cleanups: string[] = []

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'codesema-task-runner-'))
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

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeTask(repo: string, title: string, prompt: string): TaskRecord {
  return createTask(repo, {
    title,
    prompt,
    autoShip: false,
    base: '',
    branch: '',
    worktree: '',
  })
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

const status = (repo: string, id: string): TaskStatus | null => loadTask(repo, id)?.status ?? null

const jsonl = (events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`

const claudeStream = (response: string) =>
  jsonl([
    { type: 'system', subtype: 'init', session_id: 'sess-123' },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'a.txt' } }],
      },
    },
    { type: 'user', message: { content: [{ type: 'tool_result', content: 'wrote a.txt' }] } },
    { type: 'result', result: response },
  ])

type FakeClaude = {
  commands: string[]
  prompts: string[]
  run: (options: AgentRunOptions) => Promise<string>
}

/** Simulates claude stream-json: optionally writes files into the worktree first. */
function fakeClaude(respond: (options: AgentRunOptions) => string, write?: string[]): FakeClaude {
  const fake: FakeClaude = {
    commands: [],
    prompts: [],
    run: (options) => {
      fake.commands.push(options.command)
      fake.prompts.push(options.prompt)
      for (const name of write ?? []) {
        writeFileSync(join(options.cwd, name), `content of ${name}\n`)
      }
      const raw = claudeStream(respond(options))
      options.onText?.(raw)
      return Promise.resolve(raw)
    },
  }
  return fake
}

// --- runTaskTurn ---

describe('runTaskTurn', () => {
  test('emits turn_started, tool events and the final message; captures the session', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'demo', 'do the thing')
    const events: { type: string; data: Record<string, unknown> }[] = []
    const texts: string[] = []
    const fake = fakeClaude(() => 'all done')
    const outcome = await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'do the thing',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: (e) => events.push(e),
      onText: (text) => texts.push(text),
      runAgentFn: fake.run,
    })
    expect(outcome).toEqual({ kind: 'done', response: 'all done', sessionId: 'sess-123' })
    expect(events.map((e) => e.type)).toEqual([
      'turn_started',
      'tool_use',
      'tool_result',
      'message',
    ])
    expect(events[1]?.data).toEqual({ name: 'Write', input: '{"file_path":"a.txt"}' })
    expect(events[2]?.data).toEqual({ summary: 'wrote a.txt' })
    expect(fake.commands[0]).toContain('--session-id')
  })

  test('a QUESTION last line turns the outcome into a question', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'demo', 'do the thing')
    const events: { type: string }[] = []
    const outcome = await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'do the thing',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: (e) => events.push(e),
      runAgentFn: fakeClaude(() => 'I need input.\nQUESTION: Redis or in-memory?').run,
    })
    expect(outcome).toMatchObject({ kind: 'question', question: 'Redis or in-memory?' })
    expect(events.map((e) => e.type)).toEqual([
      'turn_started',
      'tool_use',
      'tool_result',
      'question',
    ])
  })

  test('an existing session id switches the command to --resume', async () => {
    const repo = makeRepo()
    const task = { ...makeTask(repo, 'demo', 'x'), agent_session_id: 'sess-42' }
    const fake = fakeClaude(() => 'ok')
    await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'continue',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: () => {},
      runAgentFn: fake.run,
    })
    expect(fake.commands[0]).toContain('--resume sess-42')
    expect(fake.commands[0]).not.toContain('--session-id')
  })

  test('non-claude agents: plain stdout is the response, no session', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'demo', 'x')
    const outcome = await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'go',
      command: 'codex exec -',
      timeoutMs: 1000,
      onEvent: () => {},
      runAgentFn: (options) => {
        options.onText?.('plain text answer')
        return Promise.resolve('plain text answer')
      },
    })
    expect(outcome).toEqual({ kind: 'done', response: 'plain text answer', sessionId: null })
  })

  test('the roles layer is gone: no role flags ever reach the command', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'demo', 'x')
    const fake = fakeClaude(() => 'ok')
    await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'go',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: () => {},
      runAgentFn: fake.run,
    })
    expect(fake.commands[0]).toContain('--permission-mode acceptEdits')
    expect(fake.commands[0]).not.toContain('--append-system-prompt')
    expect(fake.commands[0]).not.toContain('--tools ""')
  })
})

// --- createTaskRunner ---

describe('createTaskRunner', () => {
  test('full cycle: queued -> running -> waiting_for_you with the runner commit', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'Add feature', 'write feature.txt')
    const fake = fakeClaude(() => 'feature written, checks pass', ['feature.txt'])
    const seenTasks: TaskRecord[] = []
    const seenEvents: TaskEvent[] = []
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      onTask: (record) => seenTasks.push(structuredClone(record)),
      onEvent: (_id, event) => seenEvents.push(event),
      runAgentFn: fake.run,
    })

    expect(runner.start(task)).toEqual({ ok: true })
    await until(() => status(repo, task.id) === 'waiting_for_you')

    const record = loadTask(repo, task.id)
    expect(record).not.toBeNull()
    expect(record?.agent_session_id).toBe('sess-123')
    expect(record?.turns).toHaveLength(1)
    expect(record?.turns[0]?.response).toBe('feature written, checks pass')
    expect(record?.turns[0]?.question).toBeNull()
    expect(record?.turns[0]?.ended_at).not.toBeNull()
    expect(record?.branch.startsWith('codesema/task-add-feature')).toBe(true)
    expect(record?.base).toBe('main')
    expect(record?.work_ms).toBeGreaterThanOrEqual(0)

    // The runner, not the agent, committed the worktree.
    expect(tryGit(['log', '-1', '--pretty=%s'], record?.worktree ?? '')).toBe(
      `task(${task.id}): Add feature — turn 1`,
    )
    // First turn's prompt = standing instructions + the user prompt.
    expect(fake.prompts[0]).toContain('Do NOT commit')
    expect(fake.prompts[0]).toContain('write feature.txt')

    const types = readTaskEvents(repo, task.id).map((e) => e.type)
    expect(types).toEqual(['turn_started', 'tool_use', 'tool_result', 'message', 'commit'])
    const commit = readTaskEvents(repo, task.id).at(-1)
    expect(commit?.data.files_changed).toBe(1)
    expect(typeof commit?.data.sha).toBe('string')
    expect(String(commit?.data.sha)).toMatch(/^[0-9a-f]{40}$/)
    // Broadcast hooks mirrored the store writes.
    expect(seenEvents.map((e) => e.type)).toEqual(types)
    expect(seenTasks.map((r) => r.status)).toEqual(['running', 'waiting_for_you'])
  })

  test('a turn without changes ends without a commit event', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'read only', 'just look around')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'nothing to change').run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(readTaskEvents(repo, task.id).map((e) => e.type)).not.toContain('commit')
  })

  test('question -> waiting_for_you -> reply resumes the session in turn 2', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'pick a db', 'set up storage')
    const fake = fakeClaude((options) =>
      options.command.includes('--resume')
        ? 'postgres wired in'
        : 'Blocked on a choice.\nQUESTION: postgres or sqlite?',
    )
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fake.run,
    })
    runner.start(task)
    await until(() => loadTask(repo, task.id)?.turns[0]?.question === 'postgres or sqlite?')
    expect(status(repo, task.id)).toBe('waiting_for_you')

    // Let some human-latency accrue so wait_ms is measurable.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(runner.reply(task.id, 'postgres')).toEqual({ ok: true })
    await until(
      () =>
        loadTask(repo, task.id)?.turns.length === 2 && status(repo, task.id) === 'waiting_for_you',
    )

    const record = loadTask(repo, task.id)
    expect(record?.turns[1]?.prompt).toBe('postgres')
    expect(record?.turns[1]?.response).toBe('postgres wired in')
    expect(record?.turns[1]?.question).toBeNull()
    expect(record?.wait_ms).toBeGreaterThan(0)
    // Turn 2 resumed the session captured in turn 1, with the reply as sole prompt.
    expect(fake.commands[1]).toContain('--resume sess-123')
    expect(fake.prompts[1]).toBe('postgres')
    expect(readTaskEvents(repo, task.id).map((e) => e.type)).toContain('question')
  })

  test('non-resumable providers replay the transcript on turn 2', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'transcripted', 'start work')
    const prompts: string[] = []
    const runner = createTaskRunner({
      cwd: repo,
      command: 'codex exec -',
      timeoutMs: 1000,
      runAgentFn: (options) => {
        prompts.push(options.prompt)
        return Promise.resolve(
          prompts.length === 1 ? 'step one done\nQUESTION: continue?' : 'step two done',
        )
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    runner.reply(task.id, 'yes, continue')
    await until(
      () =>
        loadTask(repo, task.id)?.turns.length === 2 && status(repo, task.id) === 'waiting_for_you',
    )

    expect(loadTask(repo, task.id)?.agent_session_id).toBeNull()
    expect(prompts[1]).toContain('Previous turns of this task:')
    expect(prompts[1]).toContain('start work')
    expect(prompts[1]).toContain('New instruction: yes, continue')
  })

  test('interrupt SIGTERMs the running turn and persists interrupted', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'long runner', 'never finishes')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 60_000,
      runAgentFn: (options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('agent interrupted')))
        }),
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'running')
    expect(runner.interrupt(task.id)).toEqual({ ok: true })
    await until(() => status(repo, task.id) === 'interrupted')

    const record = loadTask(repo, task.id)
    expect(record?.turns[0]?.ended_at).not.toBeNull()
    expect(readTaskEvents(repo, task.id).map((e) => e.type)).toContain('interrupted')
    expect(runner.runningCount()).toBe(0)
  })

  test('interrupting a waiting task needs no agent', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'waiting', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'ok\nQUESTION: next?').run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(runner.interrupt(task.id)).toEqual({ ok: true })
    expect(status(repo, task.id)).toBe('interrupted')
  })

  test('an agent failure lands on failed with an error event', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'boom', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: () => Promise.reject(new Error('agent exploded')),
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'failed')
    const error = readTaskEvents(repo, task.id).find((e) => e.type === 'error')
    expect(error?.data.message).toBe('agent exploded')
  })

  test('maxParallel caps concurrency: extra tasks queue FIFO and run later', async () => {
    const repo = makeRepo()
    const first = makeTask(repo, 'first', 'task one')
    const second = makeTask(repo, 'second', 'task two')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      maxParallel: 1,
      runAgentFn: async (options) => {
        if (options.prompt.includes('task one')) {
          await gate
        }
        const raw = claudeStream('done')
        options.onText?.(raw)
        return raw
      },
    })
    runner.start(first)
    runner.start(second)
    expect(runner.runningCount()).toBe(1)
    expect(status(repo, first.id)).toBe('running')
    expect(status(repo, second.id)).toBe('queued')

    release()
    await until(
      () =>
        status(repo, first.id) === 'waiting_for_you' &&
        status(repo, second.id) === 'waiting_for_you',
    )
    expect(runner.runningCount()).toBe(0)
  })

  test('start/reply/interrupt guard rails: wrong state and unknown ids', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'guarded', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done').run,
    })
    expect(runner.reply(task.id, 'hello')).toMatchObject({ ok: false, code: 409 })
    expect(runner.reply(task.id, '   ')).toMatchObject({ ok: false, code: 400 })
    expect(runner.interrupt('aaaaaaaaaaaa')).toMatchObject({ ok: false, code: 404 })
    expect(runner.start({ ...task, id: 'aaaaaaaaaaaa' })).toMatchObject({ ok: false, code: 404 })

    runner.start(task)
    expect(runner.start(task)).toMatchObject({ ok: false, code: 409 })
    await until(() => status(repo, task.id) === 'waiting_for_you')
    // A finished (non-queued) task cannot be started again.
    expect(runner.start(task)).toMatchObject({ ok: false, code: 409 })
    // But events appended out-of-band do not confuse the runner.
    appendTaskEvent(repo, task.id, { type: 'message', data: { text: 'noise' } })
    expect(runner.interrupt(task.id)).toEqual({ ok: true })
  })

  test('a shared slot pool caps concurrency ACROSS runners and hands freed slots over', async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    const first = makeTask(repoA, 'first', 'task one')
    const second = makeTask(repoB, 'second', 'task two')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runAgentFn = async (options: AgentRunOptions): Promise<string> => {
      if (options.prompt.includes('task one')) {
        await gate
      }
      const raw = claudeStream('done')
      options.onText?.(raw)
      return raw
    }
    const pool = createTaskSlotPool(1)
    const runnerA = createTaskRunner({
      cwd: repoA,
      command: 'claude -p',
      timeoutMs: 5000,
      slots: pool,
      runAgentFn,
    })
    const runnerB = createTaskRunner({
      cwd: repoB,
      command: 'claude -p',
      timeoutMs: 5000,
      slots: pool,
      runAgentFn,
    })
    runnerA.start(first)
    runnerB.start(second)
    // ONE global slot: repo B's task queues even though its own runner is idle.
    expect(status(repoA, first.id)).toBe('running')
    expect(status(repoB, second.id)).toBe('queued')
    expect(runnerB.runningCount()).toBe(0)

    release()
    // The slot freed by runner A wakes runner B's queue.
    await until(
      () =>
        status(repoA, first.id) === 'waiting_for_you' &&
        status(repoB, second.id) === 'waiting_for_you',
    )
    expect(pool.running.size).toBe(0)
  })
})
