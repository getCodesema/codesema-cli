import { execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  AGENT_KILL_GRACE_MS,
  AGENT_WATCHDOG_DEFAULTS,
  AgentWatchdogError,
  effectiveAbsoluteCapMs,
  runAgent,
  type AgentClock,
  type AgentRunOptions,
} from './agent.js'
import { loadConfig, resolveWatchdogBudgets } from './config.js'
import type { TaskEvent, TaskRecord, TaskStatus, TaskTurn } from './contract.js'
import type { CostDegradation } from './cost.js'
import { DEFAULT_TIMEOUT_S } from './fix.js'
import { tryGit } from './git.js'
import { setLanguage } from './i18n.js'
import { CAGE_FORWARDED_ENV, type RunContainerTurnOptions } from './task-isolation.js'
import {
  buildTaskPrompt,
  costEvent,
  costRunEnv,
  createTaskRunner,
  createTaskSlotPool,
  parseTaskBranchProposal,
  parseTaskQuestion,
  runTaskTurn,
  supportsSessionResume,
  taskCommandFor,
} from './task-runner.js'
import { appendTaskEvent, createTask, loadTask, readTaskEvents, saveTask } from './tasks-store.js'

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
      // No usage frame in this stream: the cost is UNKNOWN, never 0.
      cost: null,
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

  test('streamed text is reported per agent message, each under its own index', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'demo', 'do the thing')
    const texts: [string, number][] = []
    // Two things said around one tool call: two messages, two bubbles.
    const raw = jsonl([
      { type: 'system', subtype: 'init', session_id: 'sess-123' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'reading the file' },
            { type: 'tool_use', name: 'Read', input: { file_path: 'a.txt' } },
          ],
        },
      },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'all done' }] } },
      { type: 'result', result: 'all done' },
    ])
    await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'do the thing',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: () => {},
      onText: (text, seq) => texts.push([text, seq]),
      runAgentFn: (options) => {
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
    })
    expect(texts).toEqual([
      ['reading the file', 0],
      ['all done', 1],
    ])
  })

  test('a provider without stream-json streams everything as message 0', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'demo', 'do the thing')
    const texts: [string, number][] = []
    await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'do the thing',
      command: 'my-agent --run',
      timeoutMs: 1000,
      onEvent: () => {},
      onText: (text, seq) => texts.push([text, seq]),
      runAgentFn: (options) => {
        options.onText?.('half')
        options.onText?.('half a reply')
        return Promise.resolve('half a reply')
      },
    })
    expect(texts).toEqual([
      ['half', 0],
      ['half a reply', 0],
    ])
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
      // Not a stream-json provider: nothing to price, so no cost — not 0.
      cost: null,
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
    // A failure that names nothing claims no code: the codes are ADDED where
    // there is one to add, never invented to fill the field.
    expect(error?.reason_code).toBeUndefined()
    expect(loadTask(repo, task.id)?.reason).toBeUndefined()
  })

  test('a watchdog kill is RESUMABLE, names inactivity_timeout, and keeps the worktree', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'stuck', 'work')
    let stuck = true
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: (options) => {
        if (stuck) {
          return Promise.reject(
            new AgentWatchdogError('inactivity', 'agent said nothing for 30 min'),
          )
        }
        const raw = claudeStream('picked it back up')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
    })
    runner.start(task)
    // 'interrupted', never 'failed': inactivity_timeout is retryable in D2 —
    // what has to change is the run, not the work — and 'failed' is terminal.
    await until(() => status(repo, task.id) === 'interrupted')

    const record = loadTask(repo, task.id)
    // The readable message stays exactly what the producer wrote; the code
    // rides beside it, on the record and on the journal line alike.
    expect(record?.reason?.code).toBe('inactivity_timeout')
    expect(record?.reason?.detail).toBe('agent said nothing for 30 min')
    const event = readTaskEvents(repo, task.id).find((e) => e.type === 'interrupted')
    expect(event?.reason_code).toBe('inactivity_timeout')
    // Distinct from a human Stop, which says 'agent interrupted' and claims
    // interrupted_by_user.
    expect(event?.data.message).toBe('agent said nothing for 30 min')
    // T1.6: the branch and whatever the agent wrote before it died are the
    // only account of the cut — a watchdog that tidied up would erase it.
    expect(record?.worktree).not.toBe('')
    expect(existsSync(record?.worktree ?? '')).toBe(true)

    // And the turn can actually be picked back up, work intact.
    stuck = false
    expect(runner.resume(task.id)).toEqual({ ok: true })
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const resumed = loadTask(repo, task.id)
    expect(resumed?.turns).toHaveLength(1)
    expect(resumed?.turns[0]?.response).toBe('picked it back up')
    // Moving again drops the reason it was carrying: a stale claim is a lie.
    expect(resumed?.reason).toBeUndefined()
  })

  test('a Stop landing on a run the watchdog already cut keeps the watchdog cause', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'cut then stopped', 'work')
    let stop: () => void = () => {}
    let armed = false
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: () =>
        new Promise((_resolve, reject) => {
          // The agent is already being killed by the watchdog when the human
          // hits Stop: they are REACTING to a task that stopped answering.
          stop = () => reject(new AgentWatchdogError('inactivity', 'agent said nothing'))
          armed = true
        }),
    })
    runner.start(task)
    await until(() => armed)
    runner.interrupt(task.id)
    stop()
    await until(() => loadTask(repo, task.id)?.reason !== undefined)
    const record = loadTask(repo, task.id)
    expect(record?.status).toBe('interrupted')
    // Both paths land on 'interrupted', so only the CODE tells them apart —
    // and it must name what actually happened.
    expect(record?.reason?.code).toBe('inactivity_timeout')
    const event = readTaskEvents(repo, task.id).find((e) => e.type === 'interrupted')
    expect(event?.reason_code).toBe('inactivity_timeout')
  })

  test('a tool-budget kill names the same code as a silent one', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'stuck tool', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: () =>
        Promise.reject(new AgentWatchdogError('tool_budget', 'tool never came back')),
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'interrupted')
    // Two budgets, one code: from the outside the run died of silence.
    expect(loadTask(repo, task.id)?.reason?.code).toBe('inactivity_timeout')
    expect(loadTask(repo, task.id)?.reason?.detail).toBe('tool never came back')
  })

  test('the runner hands its watchdog budgets down to the agent run', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'budgets', 'work')
    const seen: (AgentRunOptions['watchdog'] | undefined)[] = []
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      watchdog: { inactivityMs: 60_000, toolBudgetMs: 120_000, heartbeatMs: 5_000 },
      runAgentFn: (options) => {
        seen.push(options.watchdog)
        const raw = claudeStream('done')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(seen[0]).toEqual({ inactivityMs: 60_000, toolBudgetMs: 120_000, heartbeatMs: 5_000 })
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
    // The cage is the DEFAULT path wherever a runtime exists, so it gets the
    // same watchdog as the host path — and the same raised ceiling, since a
    // 1 234 ms one would cancel the watchdog before it ever ticked.
    expect(call?.timeoutMs).toBe(effectiveAbsoluteCapMs(1234, AGENT_WATCHDOG_DEFAULTS))
    expect(call?.watchdog).toEqual(AGENT_WATCHDOG_DEFAULTS)
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

// --- T1.7: the DEFAULT configuration, end to end ---------------------------

describe('watchdog on the default configuration', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
  })

  /** Virtual time: the D3 budgets are counted in hours, no test may wait one. */
  function fakeClock(): AgentClock & { advance: (ms: number) => void } {
    let now = 1_000_000
    let nextId = 1
    const timers = new Map<number, { due: number; fn: () => void }>()
    return {
      now: () => now,
      setTimer(fn, ms) {
        const id = nextId++
        timers.set(id, { due: now + ms, fn })
        return () => timers.delete(id)
      },
      advance(ms) {
        const target = now + ms
        for (;;) {
          let pick: [number, { due: number; fn: () => void }] | null = null
          for (const entry of timers) {
            if (entry[1].due <= target && (pick === null || entry[1].due < pick[1].due)) {
              pick = entry
            }
          }
          if (pick === null) {
            break
          }
          timers.delete(pick[0])
          now = pick[1].due
          pick[1].fn()
        }
        now = target
      },
    }
  }

  function fakeChild(): {
    child: ChildProcess
    ops: string[]
    close: (code: number | null) => void
  } {
    const ops: string[] = []
    const closeListeners: ((code: number | null) => void)[] = []
    const child = {
      pid: 777,
      stdin: { on: () => child.stdin, write: () => true, end: () => ops.push('stdin:end') },
      stdout: { on: () => child.stdout, destroy: () => ops.push('stdout:destroy') },
      on(event: string, listener: (arg: never) => void) {
        if (event === 'close') {
          closeListeners.push(listener as (code: number | null) => void)
        }
        return child
      },
      kill: (signal?: NodeJS.Signals) => {
        ops.push(`child.kill:${signal}`)
        return true
      },
    }
    return {
      child: child as unknown as ChildProcess,
      ops,
      close: (code) => {
        for (const listener of closeListeners) {
          listener(code)
        }
      },
    }
  }

  test('a mute agent is cut at 30 min with inactivity_timeout, never by the ceiling', async () => {
    // The exact chain the workspace composes at boot (workspace.ts): no config
    // anywhere, so `timeout` falls back to DEFAULT_TIMEOUT_S (900 s) and the
    // budgets to D3 (1 800 s / 7 200 s). Before T1.7's effective ceiling, that
    // 900 s ceiling fired first and the watchdog could never tick once: a live
    // task still died at 15 min, and a dead one still went unnamed.
    const configDir = mkdtempSync(join(tmpdir(), 'codesema-wd-e2e-'))
    cleanups.push(configDir)
    process.env.CODESEMA_CONFIG_DIR = configDir
    const config = loadConfig(null)
    const timeoutMs = (config.timeout ?? DEFAULT_TIMEOUT_S) * 1000
    const watchdog = resolveWatchdogBudgets(config)
    expect(timeoutMs).toBe(900_000)
    expect(watchdog).toEqual(AGENT_WATCHDOG_DEFAULTS)

    const repo = makeRepo()
    const task = makeTask(repo, 'mute agent', 'work')
    const clock = fakeClock()
    const fake = fakeChild()
    let started = false
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs,
      watchdog,
      // The REAL runAgent, with only the process and the clock injected: the
      // runner composes absoluteCapMs and the budgets exactly as in production.
      runAgentFn: (options) => {
        started = true
        return runAgent({
          ...options,
          clock,
          spawnFn: () => fake.child,
          killFn: (pid, signal) => fake.ops.push(`kill:${pid}:${signal}`),
        })
      },
    })
    runner.start(task)
    await until(() => started)

    // 15 min: what used to kill this task. Nothing happens.
    clock.advance(15 * 60_000 + 1000)
    expect(fake.ops.filter((op) => op.includes('SIGTERM'))).toEqual([])
    // 30 min of silence: the watchdog, and only the watchdog, cuts it.
    clock.advance(15 * 60_000)
    expect(fake.ops.filter((op) => op.includes('SIGTERM'))).toHaveLength(1)
    clock.advance(AGENT_KILL_GRACE_MS)
    fake.close(null)

    await until(() => status(repo, task.id) === 'interrupted')
    const record = loadTask(repo, task.id)
    expect(record?.reason?.code).toBe('inactivity_timeout')
    // Named by the watchdog, never by the ceiling: no `agent.timeout` wording.
    expect(record?.reason?.detail).not.toContain('900')
    expect(existsSync(record?.worktree ?? '')).toBe(true)
  })
})

describe('heartbeat reaches the record', () => {
  test('a long tool keeps beating on heartbeat_at, without moving updated_at', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'long tool', 'run the suite')
    const beats: TaskRecord[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      onTask: (record) => beats.push(structuredClone(record)),
      runAgentFn: async (options) => {
        // The agent is deep inside a tool: nothing streams, and only a beat
        // can tell this apart from a crash.
        options.onHeartbeat?.({ at: 1000, idleMs: 30_000, inFlightTools: 1 })
        options.onHeartbeat?.({ at: 2000, idleMs: 60_000, inFlightTools: 1 })
        await gate
        const raw = claudeStream('suite green')
        options.onText?.(raw)
        return raw
      },
    })
    runner.start(task)
    await until(() => (loadTask(repo, task.id)?.heartbeat_at ?? null) !== null)

    const running = loadTask(repo, task.id)
    expect(running?.status).toBe('running')
    expect(typeof running?.heartbeat_at).toBe('string')
    // A beat says the agent is alive, not that anything happened: the activity
    // sort must not be reordered by a task that is merely breathing.
    const beatFrames = beats.filter((r) => r.heartbeat_at !== undefined)
    expect(beatFrames.length).toBeGreaterThanOrEqual(1)
    const stamps = new Set(beats.map((r) => r.updated_at))
    expect(stamps.size).toBe(1)

    release()
    await until(() => status(repo, task.id) === 'waiting_for_you')
    // The beat survives on disk and stays readable after the turn.
    expect(loadTask(repo, task.id)?.heartbeat_at).toBe(running?.heartbeat_at)
  })

  test('a record with no beat claims none — absence is never "dead"', () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'fresh', 'work')
    expect(loadTask(repo, task.id)?.heartbeat_at).toBeUndefined()
  })
})

// --- cost (T1.8) ---

/** claude-opus-5 lower bound: $5/MTok base input, $0.50/MTok cache read. */
const OPUS5_BOUND = (input: number, cacheRead = 0) => input * 50_000 + cacheRead * 5_000

type Usage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation?: Record<string, number>
}

/** claude stream-json carrying usage, exactly as the provider reports it. */
const costStream = (
  response: string,
  model: string,
  usage: Usage,
  result: Record<string, unknown> = {},
) =>
  jsonl([
    { type: 'system', subtype: 'init', session_id: 'sess-123' },
    {
      type: 'assistant',
      message: { id: 'msg_01', model, content: [{ type: 'text', text: response }], usage },
    },
    // Claude Code repeats the same usage on every content block of the same
    // API response: the parser must charge it once.
    {
      type: 'assistant',
      message: { id: 'msg_01', model, content: [{ type: 'text', text: response }], usage },
    },
    { type: 'result', subtype: 'success', result: response, ...result },
  ])

const runWithUsage = (
  model: string,
  usage: Usage,
  result: Record<string, unknown> = {},
  response = 'done',
) => ({
  run: (options: AgentRunOptions) => {
    const raw = costStream(response, model, usage, result)
    options.onText?.(raw)
    return Promise.resolve(raw)
  },
})

const costEvents = (repo: string, id: string) =>
  readTaskEvents(repo, id).filter((e) => e.type === 'cost')

describe('costEvent — every cause reads as itself', () => {
  /**
   * Keyed by CAUSE, so this table is exhaustive at COMPILE time: the day a
   * tenth degradation is added to CostDegradation, this object stops
   * typechecking until it is described here too.
   */
  const CASES: Record<
    CostDegradation['cause'],
    { degradation: CostDegradation; name: string; says: string }
  > = {
    partner_platform: {
      degradation: { cause: 'partner_platform', signal: 'CLAUDE_CODE_USE_BEDROCK' },
      name: 'cost_partner_platform_unpriced',
      says: 'partner-operated platform',
    },
    model_unpriced: {
      degradation: { cause: 'model_unpriced', model: 'x' },
      name: 'cost_model_unpriced',
      says: 'no row in the fallback price table',
    },
    price_expired: {
      degradation: { cause: 'price_expired', model: 'x', at: '2027-01-01' },
      name: 'cost_price_expired',
      says: 'rate windows do not cover this turn',
    },
    turn_undated: {
      degradation: { cause: 'turn_undated', model: 'x', at: '' },
      name: 'cost_turn_undated',
      says: 'no readable start date',
    },
    counters_unusable: {
      degradation: { cause: 'counters_unusable', model: 'x' },
      name: 'cost_counters_unusable',
      says: 'not usable token counts',
    },
    harness_amount_unusable: {
      degradation: { cause: 'harness_amount_unusable', subtype: 'success' },
      name: 'cost_harness_amount_unusable',
      says: 'not a usable amount',
    },
    drift: {
      degradation: { cause: 'drift', lowerBoundTicks: 2, harnessTicks: 1 },
      name: 'cost_drift',
      says: 'structurally cannot',
    },
    turn_unrepresentable: {
      degradation: { cause: 'turn_unrepresentable', keptTicks: 9, droppedTicks: 4 },
      name: 'cost_turn_unrepresentable',
      says: 'UNDERSTATES',
    },
    total_unrepresentable: {
      degradation: { cause: 'total_unrepresentable', turns: 3 },
      name: 'cost_total_unrepresentable',
      says: 'NOT an unpriced task',
    },
  }

  test('each of the nine causes gets its own name, a neutral type and a true message', () => {
    const entries = Object.entries(CASES)
    expect(entries).toHaveLength(9)
    const names = new Set<string>()
    for (const [cause, { degradation, name, says }] of entries) {
      // The table's key really is the cause it describes.
      expect(degradation.cause).toBe(cause as CostDegradation['cause'])
      const event = costEvent(degradation)
      // Neutral vehicle, never 'error': a gap in the accounting is not a
      // failure of the work.
      expect(event.type).toBe('cost')
      expect(event.data.name).toBe(name)
      // The name is ADDED to a readable message, it never replaces it, and
      // the message states the REAL cause.
      expect(String(event.data.message)).toContain(says)
      names.add(name)
    }
    // No two causes share a name: that is the whole point of naming them.
    expect(names.size).toBe(entries.length)
  })
})

describe('costRunEnv — what the meter is allowed to read', () => {
  const HOST = {
    PATH: '/usr/bin',
    CLAUDE_CODE_USE_BEDROCK: '1',
    ANTHROPIC_API_KEY: 'k',
    SOME_OTHER_SECRET: 'nope',
  }

  test('on the host: the environment the agent itself gets', () => {
    const env = costRunEnv(false, 'claude -p', HOST)
    // agentEnv keeps CLAUDE_*/ANTHROPIC_* for claude, and drops the rest.
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe('1')
    expect(env.SOME_OTHER_SECRET).toBeUndefined()
  })

  test('in the cage: ONLY the variables the cage actually forwards', () => {
    const env = costRunEnv(true, 'claude -p', HOST)
    // CAGE_FORWARDED_ENV carries neither of the partner switches, so the
    // meter must not see one: an operator with CLAUDE_CODE_USE_BEDROCK
    // exported for another tool would otherwise have every caged turn
    // declared "partner platform" and stripped of its cost, while the agent
    // inside the box was in fact billing first-party.
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(CAGE_FORWARDED_ENV).not.toContain('CLAUDE_CODE_USE_BEDROCK')
    expect(CAGE_FORWARDED_ENV).not.toContain('CLAUDE_CODE_USE_VERTEX')
    // What IS forwarded comes through, so the set stays derived, not guessed.
    expect(env.ANTHROPIC_API_KEY).toBe('k')
    expect(env.SOME_OTHER_SECRET).toBeUndefined()
  })

  test('a custom command inherits everything, and so does the meter', () => {
    expect(costRunEnv(false, 'my-agent --run', HOST).SOME_OTHER_SECRET).toBe('nope')
  })
})

describe('turn cost', () => {
  test('no result cost: the turn carries the input-and-cache LOWER BOUND', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'bounded', 'work')
    const events: { type: string; data: Record<string, unknown> }[] = []
    const outcome = await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'work',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: (e) => events.push(e),
      runAgentFn: runWithUsage('claude-opus-5', {
        input_tokens: 1_000,
        output_tokens: 400,
        cache_read_input_tokens: 20_000,
      }).run,
    })
    expect(outcome.cost).toEqual({ ticks: OPUS5_BOUND(1_000, 20_000), basis: 'lower_bound' })
    expect(Number.isSafeInteger(outcome.cost?.ticks)).toBe(true)
    expect(events.some((e) => e.type === 'cost')).toBe(false)
  })

  test('a result frame with a cost supersedes the bound and declares "harness"', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'harnessed', 'work')
    const outcome = await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'work',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: () => {},
      runAgentFn: runWithUsage(
        'claude-opus-5',
        { input_tokens: 1_000, output_tokens: 400 },
        {
          total_cost_usd: 0.25,
          modelUsage: { 'claude-opus-5': { costUSD: 0.25 } },
        },
      ).run,
    })
    // The harness figure covers output and subagents; the bound does not.
    expect(outcome.cost).toEqual({ ticks: 2_500_000_000, basis: 'harness' })
    expect(outcome.cost?.ticks).toBeGreaterThan(OPUS5_BOUND(1_000))
  })

  test('an unpriced model: no cost at all, plus a NEUTRAL named journal event', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'unpriced', 'work')
    const events: { type: string; data: Record<string, unknown> }[] = []
    const outcome = await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'work',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: (e) => events.push(e),
      runAgentFn: runWithUsage('some-other-model-v3', {
        input_tokens: 1_000,
        output_tokens: 400,
      }).run,
    })
    expect(outcome.cost).toBeNull()
    const degraded = events.find((e) => e.data.name === 'cost_model_unpriced')
    expect(degraded).toBeDefined()
    // Neutral vehicle: a gap in the accounting is not an error of the work.
    expect(degraded?.type).toBe('cost')
    expect(degraded?.data.model).toBe('some-other-model-v3')
    // The readable message is there too, and it says the REAL cause.
    expect(String(degraded?.data.message)).toContain('some-other-model-v3')
    expect(String(degraded?.data.message)).toContain('no row in the fallback price table')
  })

  test('a partner-platform run is left unpriced, harness figure included', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'bedrock', 'work')
    const events: { type: string; data: Record<string, unknown> }[] = []
    const outcome = await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'work',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: (e) => events.push(e),
      runAgentFn: runWithUsage(
        'us.anthropic.claude-opus-4-5-20251101-v1:0',
        { input_tokens: 1_000, output_tokens: 400 },
        { total_cost_usd: 0.25 },
      ).run,
    })
    // Never a first-party figure on somebody else's invoice.
    expect(outcome.cost).toBeNull()
    const degraded = events.find((e) => e.data.name === 'cost_partner_platform_unpriced')
    expect(degraded?.type).toBe('cost')
    expect(String(degraded?.data.message)).toContain('partner-operated platform')
  })

  test('cost_drift: a bound above the harness figure is reported, never blocking', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'drifting', 'work')
    const events: { type: string; data: Record<string, unknown> }[] = []
    const outcome = await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'work',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: (e) => events.push(e),
      runAgentFn: runWithUsage(
        'claude-opus-5',
        { input_tokens: 1_000_000 },
        { total_cost_usd: 0.01 },
      ).run,
    })
    const drift = events.find((e) => e.data.name === 'cost_drift')
    expect(drift?.type).toBe('cost')
    expect(drift?.data.lower_bound_ticks).toBe(OPUS5_BOUND(1_000_000))
    expect(drift?.data.harness_ticks).toBe(100_000_000)
    // Informative only: the turn still ends with the harness figure.
    expect(outcome.cost).toEqual({ ticks: 100_000_000, basis: 'harness' })
  })

  test('the record total equals the sum of its turns, with coverage and basis', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'summed', 'first instruction')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: (options) =>
        options.prompt.includes('second instruction')
          ? runWithUsage('claude-opus-5', { input_tokens: 2_000 }).run(options)
          : runWithUsage('claude-opus-5', { input_tokens: 1_000 }).run(options),
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const afterFirst = loadTask(repo, task.id)
    expect(afterFirst?.turns[0]?.cost_ticks).toBe(OPUS5_BOUND(1_000))
    expect(afterFirst?.turns[0]?.cost_basis).toBe('lower_bound')
    expect(afterFirst?.cost_ticks).toBe(OPUS5_BOUND(1_000))
    expect(afterFirst?.cost_turns).toBe(1)
    expect(afterFirst?.cost_basis).toBe('lower_bound')

    expect(runner.reply(task.id, 'second instruction')).toEqual({ ok: true })
    await until(() => (loadTask(repo, task.id)?.turns.length ?? 0) === 2)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id)
    const turns = record?.turns ?? []
    expect(turns).toHaveLength(2)
    expect(turns[1]?.cost_ticks).toBe(OPUS5_BOUND(2_000))
    // The invariant itself: the record's total IS the sum of its turns.
    const sum = turns.reduce((acc, turn) => acc + (turn.cost_ticks ?? 0), 0)
    expect(record?.cost_ticks).toBe(sum)
    expect(record?.cost_ticks).toBe(OPUS5_BOUND(3_000))
    expect(record?.cost_turns).toBe(2)
    expect(Number.isSafeInteger(record?.cost_ticks)).toBe(true)
  })

  test('one lower-bound turn makes the record total a lower bound', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'mixed', 'first instruction')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: (options) =>
        options.prompt.includes('second instruction')
          ? // No harness figure on this one: it can only be bounded.
            runWithUsage('claude-opus-5', { input_tokens: 2_000 }).run(options)
          : runWithUsage('claude-opus-5', { input_tokens: 1_000 }, { total_cost_usd: 0.25 }).run(
              options,
            ),
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(loadTask(repo, task.id)?.cost_basis).toBe('harness')

    expect(runner.reply(task.id, 'second instruction')).toEqual({ ok: true })
    await until(() => (loadTask(repo, task.id)?.turns.length ?? 0) === 2)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id)
    expect(record?.turns[0]?.cost_basis).toBe('harness')
    expect(record?.turns[1]?.cost_basis).toBe('lower_bound')
    // A sum is never more authoritative than its weakest term.
    expect(record?.cost_basis).toBe('lower_bound')
    expect(record?.cost_turns).toBe(2)
  })

  test('an INTERRUPTED turn keeps the cost it had already accrued', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'killed mid-flight', 'work')
    const usage = { input_tokens: 1_000, cache_read_input_tokens: 20_000 }
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 60_000,
      runAgentFn: (options) =>
        new Promise((_resolve, reject) => {
          // The agent streams its first response, then hangs until it is killed.
          options.onText?.(
            jsonl([
              { type: 'system', subtype: 'init', session_id: 'sess-123' },
              {
                type: 'assistant',
                message: { id: 'msg_01', model: 'claude-opus-5', content: [], usage },
              },
            ]),
          )
          options.signal?.addEventListener('abort', () => reject(new Error('agent interrupted')))
        }),
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'running')
    await until(() => (loadTask(repo, task.id)?.status ?? '') === 'running')
    expect(runner.interrupt(task.id)).toEqual({ ok: true })
    await until(() => status(repo, task.id) === 'interrupted')

    const record = loadTask(repo, task.id)
    // The turn SPENT this before it was killed: dropping it would report a
    // cut turn as free.
    expect(record?.turns[0]?.cost_ticks).toBe(OPUS5_BOUND(1_000, 20_000))
    expect(record?.turns[0]?.cost_basis).toBe('lower_bound')
    expect(record?.cost_ticks).toBe(OPUS5_BOUND(1_000, 20_000))
    expect(record?.cost_turns).toBe(1)
  })

  /**
   * Interrupts a turn after it has streamed `usage`, then resumes it with a
   * second stream. Returns the record once the resumed turn has settled.
   */
  const interruptThenResume = async (
    repo: string,
    task: TaskRecord,
    first: Usage,
    second: (options: AgentRunOptions) => Promise<string>,
  ) => {
    let attempt = 0
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 60_000,
      runAgentFn: (options) => {
        attempt++
        if (attempt > 1) {
          return second(options)
        }
        options.onText?.(
          jsonl([
            { type: 'system', subtype: 'init', session_id: 'sess-123' },
            {
              type: 'assistant',
              message: { id: 'msg_01', model: 'claude-opus-5', content: [], usage: first },
            },
          ]),
        )
        return new Promise<string>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('agent interrupted')))
        })
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'running')
    expect(runner.interrupt(task.id)).toEqual({ ok: true })
    await until(() => status(repo, task.id) === 'interrupted')
    const afterKill = loadTask(repo, task.id)?.turns[0]?.cost_ticks
    expect(runner.resume(task.id)).toEqual({ ok: true })
    await until(() => status(repo, task.id) === 'waiting_for_you')
    return { afterKill, record: loadTask(repo, task.id) }
  }

  test('resume: a second attempt that measured NOTHING keeps the first floor', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'resumed blind', 'work')
    // The resumed attempt streams no usage at all: it cannot prove the turn
    // was free, so what the killed attempt spent must survive.
    const { afterKill, record } = await interruptThenResume(
      repo,
      task,
      { input_tokens: 1_000, cache_read_input_tokens: 20_000 },
      (options) => fakeClaude(() => 'done').run(options),
    )
    expect(afterKill).toBe(OPUS5_BOUND(1_000, 20_000))
    // resume() re-ran the very same turn, in place.
    expect(record?.turns).toHaveLength(1)
    expect(record?.turns[0]?.cost_ticks).toBe(OPUS5_BOUND(1_000, 20_000))
    expect(record?.turns[0]?.cost_basis).toBe('lower_bound')
    expect(record?.cost_ticks).toBe(OPUS5_BOUND(1_000, 20_000))
    expect(record?.cost_turns).toBe(1)
  })

  test('resume: a second floor ADDS to the first — the turn burned both', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'resumed bounded', 'work')
    const { record } = await interruptThenResume(repo, task, { input_tokens: 1_000 }, (options) =>
      runWithUsage('claude-opus-5', { input_tokens: 400 }).run(options),
    )
    expect(record?.turns).toHaveLength(1)
    expect(record?.turns[0]?.cost_ticks).toBe(OPUS5_BOUND(1_400))
    expect(record?.turns[0]?.cost_basis).toBe('lower_bound')
    expect(record?.cost_ticks).toBe(OPUS5_BOUND(1_400))
  })

  test('resume: a harness figure ADDS to a floor, and the sum is a lower bound', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'resumed harnessed', 'work')
    const { record } = await interruptThenResume(repo, task, { input_tokens: 1_000 }, (options) =>
      runWithUsage('claude-opus-5', { input_tokens: 400 }, { total_cost_usd: 0.25 }).run(options),
    )
    // The killed attempt's floor plus the resumed attempt's harness estimate.
    expect(record?.turns).toHaveLength(1)
    expect(record?.turns[0]?.cost_ticks).toBe(OPUS5_BOUND(1_000) + 2_500_000_000)
    // One term is a floor, so the whole turn is: a sum is never more
    // authoritative than its weakest term.
    expect(record?.turns[0]?.cost_basis).toBe('lower_bound')
    expect(record?.cost_basis).toBe('lower_bound')
  })

  /** Drives a turn through the CAGE seam with a usage-bearing stream. */
  const cagedTurn = async (
    repo: string,
    task: TaskRecord,
    model: string,
    events: { type: string; data: Record<string, unknown> }[],
  ) =>
    runTaskTurn({
      cwd: repo,
      task,
      prompt: 'work',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: (e) => events.push(e),
      runContainerTurnFn: (options) => {
        const raw = costStream('done', model, { input_tokens: 1_000 })
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
    })

  test('IN THE CAGE: a host-only partner variable never strips the cost', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'caged first-party', 'work', 'container')
    const events: { type: string; data: Record<string, unknown> }[] = []
    // The operator has the switch exported in their shell for another tool.
    // The cage does NOT forward it, so the agent inside bills first-party —
    // and the meter must read the environment of the process that RUNS, not
    // ours. Getting this wrong deletes T1.8's whole output for the task.
    const previous = process.env.CLAUDE_CODE_USE_BEDROCK
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    try {
      const outcome = await cagedTurn(repo, task, 'claude-opus-5', events)
      expect(outcome.cost).toEqual({ ticks: OPUS5_BOUND(1_000), basis: 'lower_bound' })
      expect(events.some((e) => e.data.name === 'cost_partner_platform_unpriced')).toBe(false)
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_USE_BEDROCK
      } else {
        process.env.CLAUDE_CODE_USE_BEDROCK = previous
      }
    }
  })

  test('IN THE CAGE: a partner-shaped model id still strips the cost', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'caged bedrock', 'work', 'container')
    const events: { type: string; data: Record<string, unknown> }[] = []
    // The signal that survives the box is the one that comes back ON the
    // stream, and it is the one that catches a real Bedrock run.
    const outcome = await cagedTurn(
      repo,
      task,
      'us.anthropic.claude-opus-4-5-20251101-v1:0',
      events,
    )
    expect(outcome.cost).toBeNull()
    expect(events.some((e) => e.data.name === 'cost_partner_platform_unpriced')).toBe(true)
  })

  test('ON THE HOST: the partner variable is read, and strips the cost', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'host bedrock', 'work')
    const events: { type: string; data: Record<string, unknown> }[] = []
    const previous = process.env.CLAUDE_CODE_USE_BEDROCK
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    try {
      const outcome = await runTaskTurn({
        cwd: repo,
        task,
        prompt: 'work',
        command: 'claude -p',
        timeoutMs: 1000,
        onEvent: (e) => events.push(e),
        runAgentFn: runWithUsage('claude-opus-5', { input_tokens: 1_000 }).run,
      })
      expect(outcome.cost).toBeNull()
      const degraded = events.find((e) => e.data.name === 'cost_partner_platform_unpriced')
      expect(degraded?.data.signal).toBe('CLAUDE_CODE_USE_BEDROCK')
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_USE_BEDROCK
      } else {
        process.env.CLAUDE_CODE_USE_BEDROCK = previous
      }
    }
  })

  test('a turn with no readable start date says THAT, not "model unpriced"', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'undated', 'work')
    // A record whose turn lost its stamp: the model IS in the table, so
    // blaming the model would send a maintainer to the wrong place.
    const firstTurn = task.turns[0]
    if (firstTurn) {
      firstTurn.started_at = ''
    }
    const events: { type: string; data: Record<string, unknown> }[] = []
    const outcome = await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'work',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: (e) => events.push(e),
      runAgentFn: runWithUsage('claude-opus-5', { input_tokens: 1_000 }).run,
    })
    expect(outcome.cost).toBeNull()
    const degraded = events.find((e) => e.type === 'cost')
    expect(degraded?.data.name).toBe('cost_turn_undated')
    expect(String(degraded?.data.message)).toContain('no readable start date')
    expect(events.some((e) => e.data.name === 'cost_model_unpriced')).toBe(false)
  })

  test('a turn with NO stamp at all prices nothing: there is no clock on this path', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'no turn to date', 'work')
    // The last-resort fallback, where a clock reading would otherwise slip in
    // and quietly bill the turn at today's rate. Empty is the honest answer.
    task.turns = []
    const events: { type: string; data: Record<string, unknown> }[] = []
    const outcome = await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'work',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: (e) => events.push(e),
      runAgentFn: runWithUsage('claude-opus-5', { input_tokens: 1_000 }).run,
    })
    expect(outcome.cost).toBeNull()
    expect(events.find((e) => e.type === 'cost')?.data.name).toBe('cost_turn_undated')
  })

  test('a complete result frame with a broken amount names its own cause', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'broken amount', 'work')
    const events: { type: string; data: Record<string, unknown> }[] = []
    const outcome = await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'work',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: (e) => events.push(e),
      runAgentFn: runWithUsage('claude-opus-5', { input_tokens: 1_000 }, { total_cost_usd: -3 })
        .run,
    })
    // The bound takes over, and the broken figure is not swallowed.
    expect(outcome.cost).toEqual({ ticks: OPUS5_BOUND(1_000), basis: 'lower_bound' })
    const degraded = events.find((e) => e.data.name === 'cost_harness_amount_unusable')
    expect(degraded?.type).toBe('cost')
    expect(degraded?.data.subtype).toBe('success')
  })

  test('a budget-cut result frame is read: its figures are complete', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'budget cut', 'work')
    const outcome = await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'work',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: () => {},
      runAgentFn: runWithUsage(
        'claude-opus-5',
        { input_tokens: 1_000 },
        { subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.25 },
      ).run,
    })
    expect(outcome.cost).toEqual({ ticks: 2_500_000_000, basis: 'harness' })
  })

  test('subagent frames are excluded from the floor, but not from the tokens', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'with subagents', 'work')
    const outcome = await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'work',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: () => {},
      runAgentFn: (options) => {
        const raw = jsonl([
          { type: 'system', subtype: 'init', session_id: 'sess-123' },
          {
            type: 'assistant',
            message: {
              id: 'msg_main',
              model: 'claude-opus-5',
              content: [],
              usage: { input_tokens: 1_000, output_tokens: 10 },
            },
          },
          {
            type: 'assistant',
            parent_tool_use_id: 'toolu_01',
            message: {
              id: 'msg_sub',
              model: 'claude-opus-5',
              content: [],
              usage: { input_tokens: 500_000, output_tokens: 20 },
            },
          },
          { type: 'result', subtype: 'success', result: 'done' },
        ])
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
    })
    // The floor is the MAIN loop's input and cache only.
    expect(outcome.cost).toEqual({ ticks: OPUS5_BOUND(1_000), basis: 'lower_bound' })
    // The tokens still count the whole tree: those were burned by this turn.
    expect(outcome.tokens).toBe(1_000 + 10 + 500_000 + 20)
  })

  test("an attempt's cost is folded AT MOST ONCE, whichever way the turn exits", async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'both exits', 'work')
    // finishTurn folds the cost and THEN goes on to persist; a host callback
    // that throws there sends the very same attempt into failTurn through the
    // promise chain's .catch. Without the marker on the attempt, the same
    // figure is folded twice — and since the fold is additive, the turn (and
    // the record total derived from it) doubles.
    let thrown = false
    let broadcasts = 0
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: runWithUsage('claude-opus-5', { input_tokens: 1_000 }).run,
      onTask: (broadcast) => {
        broadcasts++
        // Blow up on the FIRST broadcast that already carries the folded cost:
        // that is finishTurn's own persist, after accrueCost has run.
        if (!thrown && broadcast.cost_ticks !== undefined) {
          thrown = true
          throw new Error('broadcast blew up after the fold')
        }
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'failed')

    const record = loadTask(repo, task.id)
    // Counted once, not twice.
    expect(record?.turns[0]?.cost_ticks).toBe(OPUS5_BOUND(1_000))
    expect(record?.cost_ticks).toBe(OPUS5_BOUND(1_000))
    expect(record?.cost_turns).toBe(1)
    // Both exit paths really did run for this one attempt.
    expect(thrown).toBe(true)
    expect(broadcasts).toBeGreaterThan(2)
  })

  test('a turn whose sum leaves the exact integer range keeps its figure and SAYS so', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'overflowing turn', 'work')
    // A turn already carrying a figure at the top of the exact range: the new
    // attempt's measure cannot be added to it. Nothing downstream can notice
    // on its own — the turn still carries a usable figure, so the record total
    // stays an ordinary total — which is why the event is the only signal.
    const firstTurn = task.turns[0]
    if (firstTurn) {
      firstTurn.cost_ticks = Number.MAX_SAFE_INTEGER
      firstTurn.cost_basis = 'harness'
    }
    saveTask(repo, task)
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: runWithUsage('claude-opus-5', { input_tokens: 1_000 }).run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    const record = loadTask(repo, task.id)
    expect(record?.turns[0]?.cost_ticks).toBe(Number.MAX_SAFE_INTEGER)
    const said = costEvents(repo, task.id).find((e) => e.data.name === 'cost_turn_unrepresentable')
    expect(said).toBeDefined()
    expect(said?.data.kept_ticks).toBe(Number.MAX_SAFE_INTEGER)
    expect(said?.data.dropped_ticks).toBe(OPUS5_BOUND(1_000))
    expect(String(said?.data.message)).toContain('UNDERSTATES')
  })

  test('a record total that leaves the exact integer range is DROPPED and SAID', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'overflowing total', 'work')
    const settled = (ticks: number): TaskTurn => ({
      prompt: 'an earlier instruction',
      response: 'done',
      question: null,
      started_at: '2026-08-19T09:00:00.000Z',
      ended_at: '2026-08-19T09:01:00.000Z',
      cost_ticks: ticks,
      cost_basis: 'harness',
    })
    // Two settled turns whose figures cannot be summed exactly, plus the live
    // one. The record also carries a STALE total, so its removal is visible:
    // keeping it would state a figure that is no longer the sum of anything.
    task.turns.unshift(settled(Number.MAX_SAFE_INTEGER), settled(Number.MAX_SAFE_INTEGER))
    task.cost_ticks = 42
    task.cost_turns = 2
    task.cost_basis = 'harness'
    // start() always reloads from disk, so the seeded record has to be there.
    saveTask(repo, task)
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: runWithUsage('claude-opus-5', { input_tokens: 1_000 }).run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    const record = loadTask(repo, task.id)
    // The stale total is gone — all three keys, since they are one fact.
    expect(record && 'cost_ticks' in record).toBe(false)
    expect(record && 'cost_turns' in record).toBe(false)
    expect(record && 'cost_basis' in record).toBe(false)
    // The turns themselves are untouched: only the SUM is unstatable.
    expect(record?.turns).toHaveLength(3)
    expect(record?.turns[0]?.cost_ticks).toBe(Number.MAX_SAFE_INTEGER)
    expect(record?.turns[2]?.cost_ticks).toBe(OPUS5_BOUND(1_000))
    // And it does not look like an unpriced task: the cause is in the journal,
    // with the coverage the sum would have had.
    const said = costEvents(repo, task.id).find((e) => e.data.name === 'cost_total_unrepresentable')
    expect(said).toBeDefined()
    expect(said?.type).toBe('cost')
    expect(said?.data.turns).toBe(3)
    expect(String(said?.data.message)).toContain('NOT an unpriced task')
  })

  test('a task no turn of which could be priced keeps no total: unknown, not 0', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'unknown cost', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: runWithUsage('some-other-model-v3', {
        input_tokens: 1_000,
        output_tokens: 400,
      }).run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id)
    expect(record && 'cost_ticks' in record).toBe(false)
    expect(record && 'cost_turns' in record).toBe(false)
    expect(record && 'cost_basis' in record).toBe(false)
    expect(record?.turns[0] && 'cost_ticks' in record.turns[0]).toBe(false)
    // But the tokens were still counted: only the PRICE is unknown.
    expect(record?.turns[0]?.tokens).toBe(1_400)
    // And the degradation reached the journal, on a neutral line.
    expect(costEvents(repo, task.id).map((e) => e.data.name)).toEqual(['cost_model_unpriced'])
  })

  test('a stream with no usage at all leaves the task without a cost', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'no usage', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done').run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id)
    expect(record && 'cost_ticks' in record).toBe(false)
    expect(costEvents(repo, task.id)).toEqual([])
  })
})
