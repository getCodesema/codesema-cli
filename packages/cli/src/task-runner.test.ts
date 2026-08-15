import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentRunOptions } from './agent.js'
import type { TaskEvent, TaskRecord, TaskStatus } from './contract.js'
import { tryGit } from './git.js'
import { setLanguage } from './i18n.js'
import type { RunContainerTurnOptions } from './task-isolation.js'
import {
  buildTaskPrompt,
  createTaskRunner,
  createTaskSlotPool,
  parseTaskBranchProposal,
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

  describe('language rule', () => {
    afterEach(() => setLanguage(null))

    test('no configured language: the agent mirrors the user, not a fixed name', () => {
      const prompt = buildTaskPrompt(task)
      expect(prompt).toContain("reply in the language of the user's messages")
      expect(prompt).not.toContain('write every reply')
    })

    test('a configured language names it explicitly', () => {
      setLanguage('fr')
      const prompt = buildTaskPrompt(task)
      expect(prompt).toContain('write every reply to the user in French')
    })

    test('the rule scopes to the summary and QUESTION line, not code or commits', () => {
      const prompt = buildTaskPrompt(task)
      expect(prompt).toContain("QUESTION: <text>' line")
      expect(prompt).toContain('code identifiers, file paths and commit messages stay as they are')
    })

    test('the BRANCH protocol stays English regardless of the language rule', () => {
      setLanguage('fr')
      const prompt = buildTaskPrompt(task, { askBranchName: true })
      expect(prompt).toContain('kebab-case English branch name')
      expect(prompt).toContain('always in English, regardless of the language rule above')
    })
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

describe('parseTaskBranchProposal', () => {
  test('the first line names the branch and leaves the reply', () => {
    expect(parseTaskBranchProposal('BRANCH: fix-preview-rename\n\nDid the thing.')).toEqual({
      name: 'fix-preview-rename',
      rest: 'Did the thing.',
    })
    // Quoted/backticked/spaced proposals are still proposals; slug() finishes.
    expect(parseTaskBranchProposal('BRANCH: `Update Workspace Docs`\ndone')?.name).toBe(
      'Update Workspace Docs',
    )
  })

  test('no line at all is the normal absent case', () => {
    expect(parseTaskBranchProposal('all done, tests pass')).toBeNull()
    // Mid-prose mentions are prose, only the FIRST line is protocol.
    expect(parseTaskBranchProposal('did stuff\nBRANCH: too-late')).toBeNull()
  })

  test('an unusable proposal is stripped but names nothing', () => {
    expect(parseTaskBranchProposal('BRANCH: ??\ndone')).toEqual({ name: null, rest: 'done' })
    expect(parseTaskBranchProposal(`BRANCH: ${'x'.repeat(80)}\ndone`)?.name).toBeNull()
    expect(parseTaskBranchProposal('BRANCH: a name, with prose\ndone')?.name).toBeNull()
  })

  test('the BRANCH line never swallows a QUESTION on the last line', () => {
    const parsed = parseTaskBranchProposal('BRANCH: pick-a-db\nBlocked.\nQUESTION: pg or sqlite?')
    expect(parsed?.name).toBe('pick-a-db')
    expect(parseTaskQuestion(parsed?.rest ?? '')).toBe('pg or sqlite?')
  })

  test('the prompt asks for the branch name only when told to', () => {
    const task = { title: 'Add rate limiting' } as TaskRecord
    expect(buildTaskPrompt(task)).not.toContain('BRANCH:')
    expect(buildTaskPrompt(task, { askBranchName: true })).toContain("'BRANCH: <name>'")
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

function makeTask(
  repo: string,
  title: string,
  prompt: string,
  isolation: TaskRecord['isolation'] = 'policy',
): TaskRecord {
  return createTask(repo, {
    title,
    prompt,
    autoShip: false,
    base: '',
    branch: '',
    worktree: '',
    isolation,
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
    expect(outcome).toEqual({
      kind: 'done',
      response: 'all done',
      sessionId: 'sess-123',
      tokens: 0,
    })
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
    expect(outcome).toEqual({
      kind: 'done',
      response: 'plain text answer',
      sessionId: null,
      tokens: 0,
    })
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
    // Standing instructions (language rule included) are replayed on EVERY
    // turn for a provider that cannot resume a session, not just the first.
    expect(prompts[0]).toContain("reply in the language of the user's messages")
    expect(prompts[1]).toContain("reply in the language of the user's messages")
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

// Hardening (CVE-2026-25725 lesson): a worktree-written .claude/settings.json
// or .mcp.json must never be loaded by the NEXT resumed turn.
// --- the agent names its own branch (turn 1) ---

describe('agent-named task branches', () => {
  test('a valid proposal renames the branch, updates the record and leaves the reply clean', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'les docs sont à jours ?', 'check the docs')
    const fake = fakeClaude(
      () => 'BRANCH: update-workspace-docs\n\ndocs refreshed, checks pass',
      ['docs.txt'],
    )
    const seen: TaskRecord[] = []
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      onTask: (record) => seen.push(structuredClone(record)),
      runAgentFn: fake.run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    const record = loadTask(repo, task.id)
    expect(record?.branch).toBe('codesema/task-update-workspace-docs')
    expect(tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], record?.worktree ?? '')).toBe(
      'codesema/task-update-workspace-docs',
    )
    // The protocol line never reaches the conversation.
    expect(record?.turns[0]?.response).toBe('docs refreshed, checks pass')
    // The turn's commit landed on the renamed branch.
    expect(tryGit(['log', '-1', '--pretty=%s', 'codesema/task-update-workspace-docs'], repo)).toBe(
      `task(${task.id}): les docs sont à jours ? — turn 1`,
    )
    // The UI learns the new name before the end-of-turn record.
    expect(seen.map((r) => r.branch)).toContain('codesema/task-update-workspace-docs')
    expect(fake.prompts[0]).toContain("'BRANCH: <name>'")
  })

  test('a question turn still gets to name its branch', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'pick a db', 'set up storage')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(
        () => 'BRANCH: wire-storage-layer\nBlocked.\nQUESTION: postgres or sqlite?',
      ).run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id)
    expect(record?.branch).toBe('codesema/task-wire-storage-layer')
    expect(record?.turns[0]?.question).toBe('postgres or sqlite?')
    expect(record?.turns[0]?.response).toBe('Blocked.\nQUESTION: postgres or sqlite?')
  })

  test('an absent or unusable proposal silently keeps the generated name', async () => {
    const repo = makeRepo()
    const silent = makeTask(repo, 'Add feature', 'write feature.txt')
    const garbage = makeTask(repo, 'Other feature', 'write other.txt')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude((options) =>
        options.prompt.includes('write other.txt')
          ? 'BRANCH: ¯\\_(ツ)_/¯\ndone anyway'
          : 'done, no protocol line',
      ).run,
    })
    runner.start(silent)
    runner.start(garbage)
    await until(
      () =>
        status(repo, silent.id) === 'waiting_for_you' &&
        status(repo, garbage.id) === 'waiting_for_you',
    )
    expect(loadTask(repo, silent.id)?.branch).toBe('codesema/task-add-feature')
    expect(loadTask(repo, silent.id)?.turns[0]?.response).toBe('done, no protocol line')
    expect(loadTask(repo, garbage.id)?.branch).toBe('codesema/task-other-feature')
    // Unusable, but still protocol: it does not leak into the conversation.
    expect(loadTask(repo, garbage.id)?.turns[0]?.response).toBe('done anyway')
    // No error surfaced either way.
    expect(readTaskEvents(repo, garbage.id).map((e) => e.type)).not.toContain('error')
  })

  test('a name already taken gets the numeric suffix', async () => {
    const repo = makeRepo()
    execFileSync('git', ['branch', 'codesema/task-fix-preview-rename'], { cwd: repo })
    const task = makeTask(repo, 'something vague', 'fix it')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'BRANCH: fix-preview-rename\nfixed').run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(loadTask(repo, task.id)?.branch).toBe('codesema/task-fix-preview-rename-2')
  })

  test("a work-on conversation is never asked for a name and never renames the user's branch", async () => {
    const repo = makeRepo()
    execFileSync('git', ['branch', 'feature/mine'], { cwd: repo })
    const task = createTask(repo, {
      title: 'work on my branch',
      prompt: 'keep going',
      autoShip: false,
      base: 'main',
      branch: 'feature/mine',
      worktree: '',
      workOn: true,
    })
    const fake = fakeClaude(() => 'BRANCH: much-nicer-name\nkept going')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fake.run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(loadTask(repo, task.id)?.branch).toBe('feature/mine')
    expect(tryGit(['rev-parse', '--verify', 'codesema/task-much-nicer-name'], repo)).toBeNull()
    expect(fake.prompts[0]).not.toContain('BRANCH:')
    // The line was never asked for, so on a work-on task it stays plain prose.
    expect(loadTask(repo, task.id)?.turns[0]?.response).toBe('BRANCH: much-nicer-name\nkept going')
  })

  test('turn 2 never asks again, and a late BRANCH line stays prose', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'transcripted', 'start work')
    const prompts: string[] = []
    const runner = createTaskRunner({
      cwd: repo,
      // Non-resumable: turn 2 replays the standing instructions, which is
      // exactly where a re-ask would show up.
      command: 'codex exec -',
      timeoutMs: 1000,
      runAgentFn: (options) => {
        prompts.push(options.prompt)
        return Promise.resolve(
          prompts.length === 1
            ? 'BRANCH: rename-me-once\nstep one done'
            : 'BRANCH: rename-me-twice\nstep two done',
        )
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(loadTask(repo, task.id)?.branch).toBe('codesema/task-rename-me-once')
    runner.reply(task.id, 'continue')
    await until(() => loadTask(repo, task.id)?.turns.length === 2)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    expect(prompts[0]).toContain("'BRANCH: <name>'")
    expect(prompts[1]).not.toContain("'BRANCH: <name>'")
    // Not parsed on turn 2: the branch keeps turn 1's name and the line is prose.
    expect(loadTask(repo, task.id)?.branch).toBe('codesema/task-rename-me-once')
    expect(loadTask(repo, task.id)?.turns[1]?.response).toBe(
      'BRANCH: rename-me-twice\nstep two done',
    )
  })
})

describe('taskCommandFor hardening', () => {
  test('claude task commands ignore repo settings and repo MCP config', () => {
    const cmd = taskCommandFor('claude -p', { session: null })
    expect(cmd).toContain('--strict-mcp-config')
    expect(cmd).toContain('--setting-sources user')
  })

  test('user-set flags win, even quoted noise does not count as set', () => {
    const explicit = taskCommandFor('claude -p --setting-sources user,project', { session: null })
    expect(explicit).toContain('--setting-sources user,project')
    expect(explicit.match(/--setting-sources/g)).toHaveLength(1)
    const quoted = taskCommandFor(
      `claude -p --append-system-prompt 'mention --strict-mcp-config here'`,
      { session: null },
    )
    expect(quoted.match(/--strict-mcp-config/g)).toHaveLength(2)
  })

  test('non-claude commands stay untouched', () => {
    expect(taskCommandFor('codex exec -', { session: null })).not.toContain('--strict-mcp-config')
  })
})

// --- isolation branch: the same turn, in its box or on the host ------------

describe('container isolation branch', () => {
  /** Captures the caged path without ever touching a container runtime. */
  function fakeCage(response = 'done in the box') {
    const calls: RunContainerTurnOptions[] = []
    const run = (options: RunContainerTurnOptions): Promise<string> => {
      calls.push(options)
      const raw = claudeStream(response)
      options.onText?.(raw)
      return Promise.resolve(raw)
    }
    return { calls, run }
  }

  test("a 'container' record runs in the cage, never through the host agent", async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'caged', 'do it', 'container')
    const cage = fakeCage()
    const host = fakeClaude(() => 'should never run')
    const outcome = await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'do it',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: () => {},
      runAgentFn: host.run,
      runContainerTurnFn: cage.run,
    })
    expect(host.commands).toHaveLength(0)
    expect(cage.calls).toHaveLength(1)
    expect(outcome.response).toBe('done in the box')
    // The stream parser is fed exactly as on the host path.
    expect(outcome.sessionId).toBe('sess-123')
  })

  test('a caged task is told git cannot work in its box', () => {
    const caged = { title: 'x', isolation: 'container' } as TaskRecord
    expect(buildTaskPrompt(caged)).toContain('git commands will fail')
    expect(buildTaskPrompt({ title: 'x', isolation: 'policy' } as TaskRecord)).not.toContain(
      'git commands will fail',
    )
  })

  test('the caged command swaps the policy hardening for the cage flag', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'caged', 'do it', 'container')
    const cage = fakeCage()
    await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'do it',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: () => {},
      runContainerTurnFn: cage.run,
    })
    const command = cage.calls[0]?.command ?? ''
    expect(command).toContain('--dangerously-skip-permissions')
    expect(command).toContain('--output-format stream-json')
    expect(command).toContain('--session-id')
    expect(command).not.toContain('--strict-mcp-config')
    expect(command).not.toContain('--setting-sources')
  })

  test('the cage receives the task id, its worktree, the allowlist and the checks config', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'caged', 'do it', 'container')
    const cage = fakeCage()
    await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'do it',
      command: 'claude -p',
      timeoutMs: 1234,
      onEvent: () => {},
      allowedDomains: ['api.anthropic.com', 'registry.npmjs.org'],
      checksConfig: { image: 'oven/bun:1', commands: ['bun test'] },
      runContainerTurnFn: cage.run,
    })
    const call = cage.calls[0]
    expect(call?.taskId).toBe(task.id)
    expect(call?.worktree).toBe(repo)
    expect(call?.prompt).toBe('do it')
    expect(call?.timeoutMs).toBe(1234)
    expect(call?.allowedDomains).toEqual(['api.anthropic.com', 'registry.npmjs.org'])
    expect(call?.checksConfig?.image).toBe('oven/bun:1')
  })

  test("a 'policy' record keeps the host path exactly as it was", async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'host', 'do it')
    const cage = fakeCage()
    const host = fakeClaude(() => 'done on the host')
    const outcome = await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'do it',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: () => {},
      runAgentFn: host.run,
      runContainerTurnFn: cage.run,
    })
    expect(cage.calls).toHaveLength(0)
    expect(outcome.response).toBe('done on the host')
    expect(host.commands[0]).toContain('--strict-mcp-config')
    expect(host.commands[0]).not.toContain('--dangerously-skip-permissions')
  })

  test('a caged turn still gets its commit from the HOST runner (no git creds in the box)', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'Caged feature', 'write feature.txt', 'container')
    const calls: RunContainerTurnOptions[] = []
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runContainerTurnFn: (options) => {
        calls.push(options)
        // The agent writes inside the mounted worktree, as it would in its box.
        writeFileSync(join(options.worktree, 'feature.txt'), 'from the cage\n')
        return Promise.resolve(claudeStream('feature written'))
      },
    })
    expect(runner.start(task)).toEqual({ ok: true })
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id)
    expect(record?.isolation).toBe('container')
    expect(tryGit(['log', '-1', '--pretty=%s'], record?.worktree ?? '')).toBe(
      `task(${task.id}): Caged feature — turn 1`,
    )
    expect(calls[0]?.worktree).toBe(record?.worktree)
  })

  test('interrupt reaches the cage: the abort signal is handed to the container run', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'Long caged', 'wait', 'container')
    let aborted = false
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      runContainerTurnFn: (options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new Error('interrupted'))
          })
        }),
    })
    expect(runner.start(task)).toEqual({ ok: true })
    await until(() => status(repo, task.id) === 'running')
    expect(runner.interrupt(task.id)).toEqual({ ok: true })
    await until(() => status(repo, task.id) === 'interrupted')
    expect(aborted).toBe(true)
  })

  test('shutdown drains a caged turn the same way it drains a host one', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'Draining', 'wait', 'container')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      runContainerTurnFn: (options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('interrupted')))
        }),
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'running')
    await runner.shutdown()
    expect(status(repo, task.id)).toBe('interrupted')
    const last = readTaskEvents(repo, task.id).at(-1)
    expect(last?.type).toBe('interrupted')
    expect(last?.data.reason).toBe('shutdown')
  })
})
