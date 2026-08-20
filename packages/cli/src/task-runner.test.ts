import { execFileSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
import {
  acceptanceCriterionId,
  EARS_RESPONSE,
  EARS_TRIGGER,
  isActiveTaskStatus,
  TICKET_BODY_HASH_TAG,
  type AcceptanceCriterion,
  type TaskEvent,
  type TaskIssueSnapshot,
  type TaskRecord,
  type TaskStatus,
  type TaskTurn,
} from './contract.js'
import type { CostDegradation } from './cost.js'
import { DEFAULT_TIMEOUT_S } from './fix.js'
import { refExists, tryGit } from './git.js'
import { setLanguage } from './i18n.js'
import { createLoadCap, type LoadCap } from './load-cap.js'
import { projectIdFor } from './projects.js'
import { CAGE_FORWARDED_ENV, type RunContainerTurnOptions } from './task-isolation.js'
import {
  activeTask,
  createTaskQueue,
  readQueue,
  resetActiveClaims,
  resetQueueDegradedReports,
} from './task-queue.js'
import {
  buildTaskPrompt,
  costEvent,
  costRunEnv,
  createTaskRunner,
  createTaskSlotPool,
  parseCriteriaProposal,
  parseTaskBranchProposal,
  parseTaskQuestion,
  pendingResumeTurn,
  runTaskTurn,
  supportsSessionResume,
  taskCommandFor,
  taskCriteria,
} from './task-runner.js'
import { branchCheckoutPath, type WorktreeLockFn } from './task-worktree.js'
import { appendTaskEvent, createTask, loadTask, readTaskEvents, saveTask } from './tasks-store.js'
import { acquireWorktreeLock, type WorktreeLockHandle } from './worktree-lock.js'

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

  test('opencode gets --format json; resume uses -s; first turn has no session flag', () => {
    expect(taskCommandFor('opencode run', { session: { kind: 'new', id: 'uuid-1' } })).toBe(
      'opencode run --format json',
    )
    expect(taskCommandFor('opencode run', { session: { kind: 'resume', id: 'sess-9' } })).toBe(
      'opencode run --format json -s sess-9',
    )
    expect(taskCommandFor('opencode run --format json', { session: null })).toBe(
      'opencode run --format json',
    )
    expect(taskCommandFor('opencode run', { session: null })).not.toContain(
      '--dangerously-skip-permissions',
    )
  })
})

describe('supportsSessionResume', () => {
  test('claude in print mode, and opencode', () => {
    expect(supportsSessionResume('claude -p')).toBe(true)
    expect(supportsSessionResume('claude -p --model opus')).toBe(true)
    expect(supportsSessionResume('claude --model opus')).toBe(false)
    expect(supportsSessionResume('opencode run')).toBe(true)
    expect(supportsSessionResume('opencode run -m anthropic/claude-sonnet-4-5')).toBe(true)
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

const SAMPLE_CRITERIA_TEXTS = [
  'WHEN the user submits a valid payload THE SYSTEM SHALL persist the rate limit',
  'WHEN the bucket is empty THE SYSTEM SHALL reject the request',
  'WHEN the window elapses THE SYSTEM SHALL refill the bucket',
  'WHEN a client exceeds its quota THE SYSTEM SHALL return 429',
] as const

function sampleCriteria(): AcceptanceCriterion[] {
  return SAMPLE_CRITERIA_TEXTS.map((text) => ({ id: acceptanceCriterionId(text), text }))
}

function taskWithCriteria(extra: Partial<TaskRecord> = {}): TaskRecord {
  return {
    title: 'Add rate limiting',
    isolation: 'policy',
    criteria: sampleCriteria(),
    ...extra,
  } as TaskRecord
}

describe('buildTaskPrompt with acceptance criteria (T2.5)', () => {
  test('each criterion and its id are present in the prompt', () => {
    const prompt = buildTaskPrompt(taskWithCriteria())
    for (const criterion of sampleCriteria()) {
      expect(prompt).toContain(criterion.id)
      expect(prompt).toContain(criterion.text)
    }
  })

  test('the prompt announces verification criterion by criterion', () => {
    const prompt = buildTaskPrompt(taskWithCriteria())
    expect(prompt.toLowerCase()).toContain('criterion by criterion')
  })

  test('standing instructions stay intact, including the container line, without stealing first or last line', () => {
    const prompt = buildTaskPrompt(taskWithCriteria({ isolation: 'container' }), {
      askBranchName: true,
    })
    const lines = prompt.split('\n')
    expect(lines[0]).toBe(
      'You are an autonomous coding agent working on a task in a dedicated git worktree of this repository (your current directory).',
    )
    expect(lines.at(-1)).toContain("'BRANCH: <name>'")
    expect(prompt).toContain('Work only inside this worktree')
    expect(prompt).toContain('Do NOT commit')
    expect(prompt).toContain('Follow the existing code style')
    expect(prompt).toContain('cheap checks')
    expect(prompt).toContain('QUESTION: <your question>')
    expect(prompt).toContain('short plain-text summary')
    expect(prompt).toContain('You are running inside a container')
    expect(prompt).toContain('git commands will fail')
  })

  test('a task without criteria does not grow an empty section', () => {
    const prompt = buildTaskPrompt({ title: 'Add rate limiting' } as TaskRecord)
    expect(prompt).not.toContain('Acceptance criteria:')
    expect(prompt).not.toContain('CRITERION:')
  })

  test('a task that already has criteria is never asked for a draft', () => {
    const prompt = buildTaskPrompt(taskWithCriteria())
    expect(prompt).not.toContain('CRITERION:')
    expect(prompt).not.toContain('This task has no acceptance criteria yet')
  })

  test('issue_snapshot.criteria count as already having criteria', () => {
    const snapshot: TaskIssueSnapshot = {
      body_hash: `${TICKET_BODY_HASH_TAG}:${'a'.repeat(64)}`,
      criteria: sampleCriteria(),
      taken_at: '2026-08-14T09:00:00.000Z',
    }
    const task = { title: 'From issue', issue_snapshot: snapshot } as TaskRecord
    expect(taskCriteria(task).map((c) => c.id)).toEqual(sampleCriteria().map((c) => c.id))
    const prompt = buildTaskPrompt(task)
    expect(prompt).toContain(sampleCriteria()[0]!.id)
    expect(prompt).not.toContain('This task has no acceptance criteria yet')
  })
})

describe('parseCriteriaProposal', () => {
  const block = [
    'CRITERION: WHEN a THE SYSTEM SHALL b',
    'CRITERION: WHEN c THE SYSTEM SHALL d',
    'CRITERION: WHEN e THE SYSTEM SHALL f',
    '',
    'I started the work.',
  ].join('\n')

  test('the same input yields the same output, in the same order', () => {
    expect(parseCriteriaProposal(block)).toEqual(parseCriteriaProposal(block))
    expect(parseCriteriaProposal(block)?.texts).toEqual([
      'WHEN a THE SYSTEM SHALL b',
      'WHEN c THE SYSTEM SHALL d',
      'WHEN e THE SYSTEM SHALL f',
    ])
  })

  test('protocol lines are stripped from the user-visible rest', () => {
    const parsed = parseCriteriaProposal(block)
    expect(parsed?.rest).toBe('I started the work.')
    expect(parsed?.rest).not.toContain('CRITERION:')
  })

  test('no protocol line is the normal absent case', () => {
    expect(parseCriteriaProposal('all done, tests pass')).toBeNull()
    expect(parseCriteriaProposal('did stuff\nCRITERION: WHEN a THE SYSTEM SHALL b')).toBeNull()
  })

  test('blank lines between protocol lines stay protocol', () => {
    const parsed = parseCriteriaProposal(
      'CRITERION: WHEN a THE SYSTEM SHALL b\n\nCRITERION: WHEN c THE SYSTEM SHALL d\nprose',
    )
    expect(parsed?.texts).toEqual(['WHEN a THE SYSTEM SHALL b', 'WHEN c THE SYSTEM SHALL d'])
    expect(parsed?.rest).toBe('prose')
  })

  test('a BRANCH-stripped rest still parses', () => {
    const full = `BRANCH: fix-rate-limit\n${block}`
    const branch = parseTaskBranchProposal(full)
    const parsed = parseCriteriaProposal(branch?.rest ?? '')
    expect(parsed?.texts).toHaveLength(3)
    expect(parsed?.rest).toBe('I started the work.')
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

const openLocks: WorktreeLockHandle[] = []

afterEach(() => {
  for (const lock of openLocks.splice(0)) {
    lock.release()
  }
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  // Belt and braces between FILES, never inside a test: the admission guard
  // and the degradation memory are process-wide, so a leak must be caught by
  // an assertion rather than papered over here. All four suites that can touch
  // them reset both — an asymmetry here is a flake waiting for a bad ordering.
  resetActiveClaims()
  resetQueueDegradedReports()
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

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

/** Agent that never resolves until its abort signal fires (a SIGTERMed run). */
const hangingAgent = (options: AgentRunOptions): Promise<string> =>
  new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('agent interrupted')))
  })

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
      'criteria',
      'message',
    ])
    expect(events[1]?.data).toEqual({ name: 'Write', input: '{"file_path":"a.txt"}' })
    expect(events[2]?.data).toEqual({ summary: 'wrote a.txt' })
    expect(fake.commands[0]).toContain('--session-id')
  })

  test('opencode json feeds onText, tools, session, tokens and a real zero cost', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'demo', 'do the thing')
    const events: { type: string; data: Record<string, unknown> }[] = []
    const texts: [string, number][] = []
    const raw = jsonl([
      { type: 'step_start', sessionID: 'oc-sess' },
      {
        type: 'tool_use',
        name: 'Write',
        part: {
          name: 'Write',
          state: {
            status: 'completed',
            input: { file_path: 'a.txt' },
            output: 'wrote a.txt',
          },
        },
        sessionID: 'oc-sess',
      },
      { type: 'text', part: { text: 'all done' }, sessionID: 'oc-sess' },
      {
        type: 'step_finish',
        part: { tokens: { total: 8946, input: 33, output: 17 }, cost: 0 },
        sessionID: 'oc-sess',
      },
    ])
    const outcome = await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'do the thing',
      command: 'opencode run',
      timeoutMs: 1000,
      onEvent: (e) => events.push(e),
      onText: (text, seq) => texts.push([text, seq]),
      runAgentFn: async (options) => {
        expect(options.command).toContain('--format json')
        expect(options.command).not.toContain('-s ')
        expect(options.command).not.toContain('--dangerously-skip-permissions')
        options.onText?.(raw)
        return raw
      },
    })
    expect(outcome).toEqual({
      kind: 'done',
      response: 'all done',
      sessionId: 'oc-sess',
      tokens: 8946,
      cost: { ticks: 0, basis: 'harness' },
    })
    expect(events.map((e) => e.type)).toEqual([
      'turn_started',
      'tool_use',
      'tool_result',
      'criteria',
      'message',
    ])
    expect(events[1]?.data).toEqual({ name: 'Write', input: '{"file_path":"a.txt"}' })
    expect(events[2]?.data).toEqual({ summary: 'wrote a.txt' })
    expect(texts).toEqual([['all done', 0]])
  })

  test('opencode first turn without a stream session id does not seed a uuid', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'demo', 'do the thing')
    const raw = jsonl([{ type: 'text', part: { text: 'ok' } }])
    const outcome = await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'do the thing',
      command: 'opencode run',
      timeoutMs: 1000,
      onEvent: () => {},
      runAgentFn: async (options) => {
        options.onText?.(raw)
        return raw
      },
    })
    expect(outcome.sessionId).toBeNull()
  })

  test('opencode resume turns pass -s with the stored session', async () => {
    const repo = makeRepo()
    const task = { ...makeTask(repo, 'demo', 'again'), agent_session_id: 'oc-sess' }
    let seen = ''
    await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'again',
      command: 'opencode run',
      timeoutMs: 1000,
      onEvent: () => {},
      runAgentFn: async (options) => {
        seen = options.command
        return 'ok'
      },
    })
    expect(seen).toBe('opencode run --format json -s oc-sess')
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
      'criteria',
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
    expect(types).toEqual([
      'turn_started',
      'tool_use',
      'tool_result',
      'criteria',
      'message',
      'commit',
    ])
    const commit = readTaskEvents(repo, task.id).at(-1)
    expect(commit?.data.files_changed).toBe(1)
    expect(typeof commit?.data.sha).toBe('string')
    expect(String(commit?.data.sha)).toMatch(/^[0-9a-f]{40}$/)
    // Broadcast hooks mirrored the store writes.
    expect(seenEvents.map((e) => e.type)).toEqual(types)
    expect(seenTasks.map((r) => r.status)).toEqual(['running', 'waiting_for_you'])
  })

  test('bootstraps dependencies after the worktree exists and before the agent runs', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'package-lock.json'), '{"lockfileVersion":2}')
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'lock'], { cwd: repo, stdio: 'ignore' })
    const task = makeTask(repo, 'Add feature', 'write feature.txt')
    const fake = fakeClaude(() => 'ok', ['feature.txt'])
    const seenEvents: TaskEvent[] = []
    const installs: string[] = []
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: (_id, event) => seenEvents.push(event),
      runAgentFn: fake.run,
      bootstrapInstallFn: async (opts) => {
        installs.push(opts.worktree)
        opts.onStart?.('npm ci')
        return {
          status: 'passed',
          command: 'npm ci',
          fingerprint: 'aaaaaaaaaaaaaaaa',
          detail: '',
        }
      },
    })
    expect(runner.start(task)).toEqual({ ok: true })
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(installs).toHaveLength(1)
    expect(installs[0]?.length).toBeGreaterThan(0)
    expect(seenEvents.map((e) => e.type).slice(0, 3)).toEqual(['prep', 'prep', 'turn_started'])
    expect(seenEvents[0]?.data.name).toBe('install_started')
    expect(seenEvents[1]?.data.name).toBe('install_passed')
    expect(loadTask(repo, task.id)?.install_lock_hash).toBe('aaaaaaaaaaaaaaaa')
  })

  test('a record with agent runs that command, not the runner default', async () => {
    const repo = makeRepo()
    const task = createTask(repo, {
      title: 'oc',
      prompt: 'do it',
      autoShip: false,
      base: '',
      branch: '',
      worktree: '',
      agent: 'opencode run',
    })
    const fake = fakeClaude(() => 'done')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fake.run,
    })
    expect(runner.start(task)).toEqual({ ok: true })
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(fake.commands[0]).toContain('opencode')
    expect(fake.commands[0]).not.toContain('claude')
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

  test('T1.6: a commit git refuses names the worktree and the branch, and keeps the original message', async () => {
    const repo = makeRepo()
    // A hook every worktree of this repo shares (hooks live in the common
    // .git dir, never per-worktree): the one realistic way to make `git
    // commit` itself fail without touching the runner's own code.
    const hook = join(repo, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, '#!/bin/sh\nexit 1\n')
    chmodSync(hook, 0o755)
    const task = makeTask(repo, 'blocked commit', 'write a file')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'wrote it', ['agent.txt']).run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    const record = loadTask(repo, task.id)
    // The turn still succeeds — only the commit was refused.
    expect(record?.turns[0]?.response).toBe('wrote it')
    const errorEvent = readTaskEvents(repo, task.id).find((e) => e.type === 'error')
    expect(errorEvent?.data.worktree).toBe(record?.worktree)
    expect(errorEvent?.data.branch).toBe(record?.branch)
    // The original readable message is still there, not replaced by the new fields.
    expect(typeof errorEvent?.data.message).toBe('string')
    expect(String(errorEvent?.data.message).length).toBeGreaterThan(0)
    // Nothing was committed: the work is still sitting in the worktree, uncommitted.
    expect(tryGit(['status', '--porcelain'], record?.worktree ?? '')).not.toBe('')
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

  test('ONE active task per project: the extra tasks queue FIFO and run later', async () => {
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
      // Deliberately generous: what caps this repo is the per-project rule,
      // not a slot budget (which is inert since T1.2).
      maxParallel: 8,
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
    // The slot is taken synchronously; the status flips once the worktree has
    // materialized (which now waits for the repo's worktree lock).
    expect(runner.runningCount()).toBe(1)
    await until(() => status(repo, first.id) === 'running')
    expect(status(repo, second.id)).toBe('queued')
    // The wait is named, not mute: the resource it waits for is busy (D2).
    expect(loadTask(repo, second.id)?.reason).toEqual({
      code: 'resource_busy',
      detail: 'another task of this project is already active',
    })
    // And its place in the line is on disk, not in a closure.
    expect(readQueue(repo).entries.map((e) => e.id)).toEqual([second.id])

    release()
    await until(
      () =>
        status(repo, first.id) === 'waiting_for_you' &&
        status(repo, second.id) === 'waiting_for_you',
    )
    expect(runner.runningCount()).toBe(0)
    // A task that got its turn drops the reason it was waiting for.
    expect('reason' in (loadTask(repo, second.id) ?? {})).toBe(false)
    expect(readQueue(repo).entries).toEqual([])
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

  // Replaces 'a shared slot pool caps concurrency ACROSS runners': that is
  // exactly what T1.2 stops doing. The slot pool no longer governs anything —
  // a project is capped against ITSELF, never against another project.
  test('two distinct projects advance SIMULTANEOUSLY, one running task each', async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    const first = makeTask(repoA, 'first', 'task one')
    const second = makeTask(repoB, 'second', 'task two')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runAgentFn = async (options: AgentRunOptions): Promise<string> => {
      // BOTH agents hang until the gate opens: nothing can finish early and
      // hand a slot over, so 'running' on both sides means truly at once.
      await gate
      const raw = claudeStream('done')
      options.onText?.(raw)
      return raw
    }
    // A pool of ONE, shared, still configured: it must not cap anything.
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
    // Admission is per project now, so the inert pool caps nothing: both
    // repos run. A status flips once its worktree has materialized, which
    // waits for that repo's worktree lock.
    await until(() => status(repoA, first.id) === 'running')
    await until(() => status(repoB, second.id) === 'running')
    expect(runnerA.runningCount()).toBe(1)
    expect(runnerB.runningCount()).toBe(1)
    // Neither repo has anyone waiting: both tasks were admitted.
    expect(readQueue(repoA).entries).toEqual([])
    expect(readQueue(repoB).entries).toEqual([])

    release()
    await until(
      () =>
        status(repoA, first.id) === 'waiting_for_you' &&
        status(repoB, second.id) === 'waiting_for_you',
    )
    // Exit assertions, not just a wait: both runners let go, and — even
    // though the pool no longer governs admission — the slots it was handed
    // come back. An inert component that leaked would still be a leak.
    expect(runnerA.runningCount()).toBe(0)
    expect(runnerB.runningCount()).toBe(0)
    expect(pool.running.size).toBe(0)
    expect(activeTask(projectIdFor(repoA))).toBeNull()
    expect(activeTask(projectIdFor(repoB))).toBeNull()
  })

  test('the slot pool no longer lets two tasks of the SAME project run, whatever its capacity', async () => {
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
      // Room for ten: the per-project rule still admits exactly one.
      slots: createTaskSlotPool(10),
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
    // The first flips to 'running' once its worktree has materialized (which
    // waits for the repo's worktree lock); the second must never move.
    await until(() => status(repo, first.id) === 'running')
    expect(status(repo, second.id)).toBe('queued')
    expect(runner.runningCount()).toBe(1)

    release()
    await until(() => status(repo, second.id) === 'waiting_for_you')
  })

  test('a queue persisted by a previous run starts on its own when a runner is rebuilt', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'left waiting', 'work')
    // Exactly what a shutdown leaves behind now: the record still 'queued',
    // the id still in queue.json, and no process holding anything.
    createTaskQueue({ cwd: repo, projectId: 'aaaaaaaa' }).enqueue(task.id)
    expect(readQueue(repo).entries.map((e) => e.id)).toEqual([task.id])

    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: fakeClaude(() => 'done\nQUESTION: next?').run,
    })
    // No start(), no reply(), no human gesture: the file was the instruction.
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(readQueue(repo).entries).toEqual([])
    expect(runner.runningCount()).toBe(0)
  })
})

describe('criteria prompting at runtime (T2.5)', () => {
  const earsDraft = [
    'CRITERION: WHEN the user submits a valid payload THE SYSTEM SHALL persist the rate limit',
    'CRITERION: WHEN the bucket is empty THE SYSTEM SHALL reject the request',
    'CRITERION: WHEN the window elapses THE SYSTEM SHALL refill the bucket',
    '',
    'I started the work.',
  ].join('\n')

  test('turn 1 of a task without criteria asks for an EARS draft', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'no criteria', 'do the thing')
    const prompts: string[] = []
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: (options) => {
        prompts.push(options.prompt)
        return Promise.resolve(fakeClaude(() => 'ok').run(options))
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(prompts[0]).toContain('CRITERION:')
    expect(prompts[0]).toContain(EARS_TRIGGER)
    expect(prompts[0]).toContain(EARS_RESPONSE)
    expect(prompts[0]).toContain('This task has no acceptance criteria yet')
  })

  test('turn 1 of a task with criteria never asks for a draft', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'has criteria', 'do the thing')
    task.criteria = sampleCriteria()
    saveTask(repo, task)
    const prompts: string[] = []
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: (options) => {
        prompts.push(options.prompt)
        return Promise.resolve(fakeClaude(() => 'ok').run(options))
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(prompts[0]).toContain(sampleCriteria()[0]!.id)
    expect(prompts[0]).toContain('criterion by criterion')
    expect(prompts[0]).not.toContain('This task has no acceptance criteria yet')
    expect(prompts[0]).not.toContain("'CRITERION:")
  })

  test('a parseable draft never lands on task.json', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'drafted', 'do the thing')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => earsDraft).run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const onDisk = JSON.parse(
      readFileSync(join(repo, '.codesema', 'tasks', task.id, 'task.json'), 'utf8'),
    ) as { criteria?: unknown; issue_snapshot?: unknown }
    expect(onDisk.criteria).toBeUndefined()
    expect(onDisk.issue_snapshot).toBeUndefined()
    expect(loadTask(repo, task.id)?.criteria).toBeUndefined()
    expect(loadTask(repo, task.id)?.turns[0]?.response).toBe('I started the work.')
    expect(loadTask(repo, task.id)?.turns[0]?.response).not.toContain('CRITERION:')
  })

  test('later turns without a human validation still write no criteria', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'drafted later', 'start work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'codex exec -',
      timeoutMs: 1000,
      runAgentFn: (options) =>
        Promise.resolve(
          options.prompt.includes('New instruction') ? 'step two' : `${earsDraft}\nQUESTION: next?`,
        ),
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    runner.reply(task.id, 'continue')
    await until(
      () =>
        loadTask(repo, task.id)?.turns.length === 2 && status(repo, task.id) === 'waiting_for_you',
    )
    const onDisk = JSON.parse(
      readFileSync(join(repo, '.codesema', 'tasks', task.id, 'task.json'), 'utf8'),
    ) as { criteria?: unknown }
    expect(onDisk.criteria).toBeUndefined()
  })

  test('an unreadable draft continues the task, journals the reason, and does not replace the reply', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'unreadable', 'do the thing')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'I just started, no protocol here.').run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(status(repo, task.id)).toBe('waiting_for_you')
    expect(loadTask(repo, task.id)?.criteria).toBeUndefined()
    expect(loadTask(repo, task.id)?.turns[0]?.response).toBe('I just started, no protocol here.')
    const events = readTaskEvents(repo, task.id)
    const unparsed = events.find((e) => e.type === 'criteria' && e.data.name === 'draft_unparsed')
    expect(unparsed).toBeDefined()
    expect(typeof unparsed?.data.message).toBe('string')
    expect(String(unparsed?.data.message).length).toBeGreaterThan(0)
    expect(events.some((e) => e.type === 'message')).toBe(true)
  })

  test('--resume later turns stay the message alone, even when the task has criteria', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'resumed', 'set up storage')
    task.criteria = sampleCriteria()
    saveTask(repo, task)
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
    expect(runner.reply(task.id, 'postgres')).toEqual({ ok: true })
    await until(
      () =>
        loadTask(repo, task.id)?.turns.length === 2 && status(repo, task.id) === 'waiting_for_you',
    )
    expect(fake.prompts[1]).toBe('postgres')
    expect(fake.prompts[1]).not.toContain('Acceptance criteria:')
    expect(fake.prompts[1]).not.toContain(sampleCriteria()[0]!.id)
  })

  test('the transcript path re-injects criteria on a later turn', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'transcripted', 'start work')
    task.criteria = sampleCriteria()
    saveTask(repo, task)
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
    expect(prompts[1]).toContain('Previous turns of this task:')
    expect(prompts[1]).toContain('New instruction: yes, continue')
    for (const criterion of sampleCriteria()) {
      expect(prompts[1]).toContain(criterion.id)
      expect(prompts[1]).toContain(criterion.text)
    }
  })

  test('a snapshot of issue criteria is not overwritten by turn 1', async () => {
    const repo = makeRepo()
    const snapshot: TaskIssueSnapshot = {
      body_hash: `${TICKET_BODY_HASH_TAG}:${'a'.repeat(64)}`,
      criteria: sampleCriteria(),
      taken_at: '2026-08-14T09:00:00.000Z',
    }
    const task = createTask(repo, {
      title: 'from issue',
      prompt: 'do the thing',
      autoShip: false,
      base: '',
      branch: '',
      worktree: '',
      issue: {
        forge: 'github',
        project: 'acme/repo',
        iid: 12,
        url: 'https://github.com/acme/repo/issues/12',
      },
      issueSnapshot: snapshot,
    })
    const prompts: string[] = []
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: (options) => {
        prompts.push(options.prompt)
        return Promise.resolve(fakeClaude(() => earsDraft).run(options))
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(prompts[0]).not.toContain('This task has no acceptance criteria yet')
    const reloaded = loadTask(repo, task.id)
    expect(reloaded?.issue_snapshot?.criteria).toEqual(sampleCriteria())
    expect(reloaded?.criteria).toBeUndefined()
    expect(reloaded?.turns[0]?.response).toContain('CRITERION:')
  })
})

// --- T1.3 (D4): the machine-wide load cap --------------------------------

describe('machine load cap (T1.3, D4)', () => {
  test('AC1/AC3: a slot held by something ELSE on the shared machine cap blocks a turn on an otherwise-free project, and it starts the moment the slot frees — with a reason distinguishable from the project-busy one', async () => {
    const repo = makeRepo()
    const cap = createLoadCap(1)
    // Simulates a heavy consumer this runner does not own (a review, a checks
    // run, or a turn on ANOTHER project) already holding the one machine slot.
    const holderRelease = cap.tryAcquire('review')
    expect(holderRelease).not.toBeNull()

    const task = makeTask(repo, 'machine-blocked', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      loadCap: cap,
      runAgentFn: fakeClaude(() => 'done').run,
    })
    runner.start(task)

    // Never gets a chance to run: nothing about ITS OWN project is busy — the
    // MACHINE is. The record names that, and the wording differs from the
    // project-busy one ('another task of this project is already active').
    await until(() => loadTask(repo, task.id)?.reason !== undefined)
    expect(status(repo, task.id)).toBe('queued')
    expect(loadTask(repo, task.id)?.reason).toEqual({
      code: 'resource_busy',
      detail:
        'the machine-wide load cap (maxConcurrentAgents) has no free slot for a turn, a review or a checks run',
    })
    expect(loadTask(repo, task.id)?.reason?.detail).not.toBe(
      'another task of this project is already active',
    )

    holderRelease?.()
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
  })

  // Round 4 (mineur): T1.3 is what turned "a slot freed ANYWHERE on the
  // machine" into a reason to poke every runner in the process. A runner that
  // shut down and kept its subscription would go on being pumped by every
  // other project's releases for the rest of the process's life — a leak this
  // ticket created and its own shutdown has to close.
  test('shutdown unsubscribes the runner from the machine-wide slot notifications', async () => {
    const repo = makeRepo()
    const real = createLoadCap(2)
    let live = 0
    const cap: LoadCap = {
      ...real,
      onSlotFreed(listener) {
        live++
        const off = real.onSlotFreed(listener)
        return () => {
          live--
          off()
        }
      },
    }
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      loadCap: cap,
      runAgentFn: fakeClaude(() => 'done').run,
    })
    expect(live).toBe(1)
    await runner.shutdown()
    // The mutant this kills: dropping `unsubscribeSlotFreed()` from
    // `shutdown()` — nothing else in the suite ever looks at the listener set.
    expect(live).toBe(0)
  })

  // Adversarial review round 3, MINEUR: a task that waits on the machine cap,
  // gets its slot, and later waits again (a fresh reply, machine saturated a
  // second time) gets journaled BOTH times, never silently treated as
  // "already stated" from its FIRST wait.
  //
  // What kills what, MEASURED rather than reasoned (round 4, point 5 — the
  // previous note here had it exactly backwards). Instrumenting both
  // `machineWaiting.delete` sites over the whole CLI suite: the one on
  // `launch()`'s success path fires 11 times with the id actually present;
  // the one at the top of `schedule()` fires ZERO times — by the time a human
  // gesture re-schedules a task, `launch()` has already cleared it. So the
  // reachable cleanup is `launch()`'s, and `schedule()`'s is the unreached
  // belt.
  //
  // Neither delete is killable on its own, and NOT because either is
  // unreachable — because they cover for each other: drop `launch()`'s and
  // the id stays in the set until `schedule()`'s (until then dead code) picks
  // it up on the next reply, which restores `enteringWait` just in time.
  // Removing BOTH turns this test red, which is the honest statement of what
  // it protects: that the id is cleared SOMEWHERE between two waits. Anyone
  // deleting one of them on the grounds that "it never fires" should delete
  // `schedule()`'s, not `launch()`'s — and even then only knowing this test
  // will no longer notice a later refactor that removes the other.
  test('a task that gets its slot and later waits again on the machine cap is journaled BOTH times', async () => {
    const repo = makeRepo()
    const cap = createLoadCap(1)
    const holderA = cap.tryAcquire('review')
    expect(holderA).not.toBeNull()

    const task = makeTask(repo, 'twice-blocked', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      loadCap: cap,
      runAgentFn: fakeClaude(() => 'done\nQUESTION: next?').run,
    })
    runner.start(task)

    const machineBusyEvents = () =>
      readTaskEvents(repo, task.id).filter(
        (e) => e.type === 'queue' && e.data.name === 'machine_busy',
      )
    await until(() => machineBusyEvents().length >= 1)
    expect(machineBusyEvents()).toHaveLength(1)

    // Freed: the task obtains the slot, runs its turn, settles.
    holderA?.()
    await until(() => status(repo, task.id) === 'waiting_for_you')

    const holderB = cap.tryAcquire('review')
    expect(holderB).not.toBeNull()
    expect(runner.reply(task.id, 'continue')).toMatchObject({ ok: true })

    await until(() => machineBusyEvents().length >= 2)
    expect(machineBusyEvents()).toHaveLength(2)

    holderB?.()
    await until(() => status(repo, task.id) === 'waiting_for_you')
  })

  test('AC6: two concurrent start() on DIFFERENT projects sharing a cap of 1 never both pass, and the loser is retried once the winner is done', async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    const cap = createLoadCap(1)
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const runAgentFn = async (options: AgentRunOptions): Promise<string> => {
      await gate
      const raw = claudeStream('done')
      options.onText?.(raw)
      return raw
    }
    const runnerA = createTaskRunner({
      cwd: repoA,
      command: 'claude -p',
      timeoutMs: 5000,
      loadCap: cap,
      runAgentFn,
    })
    const runnerB = createTaskRunner({
      cwd: repoB,
      command: 'claude -p',
      timeoutMs: 5000,
      loadCap: cap,
      runAgentFn,
    })
    const taskA = makeTask(repoA, 'a', 'work a')
    const taskB = makeTask(repoB, 'b', 'work b')
    // Both start() calls run to completion, synchronously, before this test
    // itself awaits anything: the reservation inside launch() is what decides
    // the winner, not a race this test could ever observe mid-flight.
    runnerA.start(taskA)
    runnerB.start(taskB)
    expect(cap.snapshot().occupied).toBe(1)

    const aRunning = () => status(repoA, taskA.id) === 'running'
    const bRunning = () => status(repoB, taskB.id) === 'running'
    await until(() => aRunning() || bRunning())
    // Exactly one — never both, never neither.
    expect(aRunning() !== bRunning()).toBe(true)
    const [loserRepo, loserTask] = aRunning() ? [repoB, taskB] : [repoA, taskA]
    expect(loadTask(loserRepo, loserTask.id)?.status).toBe('queued')
    expect(loadTask(loserRepo, loserTask.id)?.reason?.code).toBe('resource_busy')

    releaseGate()
    await until(
      () =>
        status(repoA, taskA.id) === 'waiting_for_you' &&
        status(repoB, taskB.id) === 'waiting_for_you',
    )
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
  })

  test('AC5: N+2 mixed turns, reviews and checks on a shared cap all get served and released, no interlock', async () => {
    // Three projects; a cap of 2 so at least one of the three must queue.
    const repos = [makeRepo(), makeRepo(), makeRepo()]
    const cap = createLoadCap(2)
    // Two extra, unrelated heavy consumers occupy load beyond what the three
    // turns alone would need — mixed kinds, exactly AC5's "types mélangés".
    const reviewRelease = await cap.acquire('review')
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const runAgentFn = async (options: AgentRunOptions): Promise<string> => {
      await gate
      const raw = claudeStream('done')
      options.onText?.(raw)
      return raw
    }
    const runners = repos.map((repo) =>
      createTaskRunner({
        cwd: repo,
        command: 'claude -p',
        timeoutMs: 5000,
        loadCap: cap,
        runAgentFn,
      }),
    )
    const tasks = repos.map((repo, i) => makeTask(repo, `t${i}`, `work ${i}`))

    for (const [i, runner] of runners.entries()) {
      runner.start(tasks[i]!)
    }
    // Exactly one turn (cap 2 minus the one review already held) can be
    // running at once; the other two stay machine-blocked in their own
    // project queue.
    await until(() => runners.some((r) => r.runningCount() === 1))
    expect(cap.snapshot().occupied).toBe(2)

    // A fourth, unrelated consumer now joins the FIFO BEHIND the two
    // machine-blocked turns — the cap is genuinely full at this point (review
    // + the one running turn), so this one queues rather than jumping in.
    const checksAcquire = cap.acquire('checks')
    await Promise.resolve()
    expect(cap.snapshot().queued).toBeGreaterThanOrEqual(1)

    // Release the review: the machine cap's own FIFO hands that slot straight
    // to checks (the only thing actually PARKED in it — the two blocked turns
    // retry via onSlotFreed instead, since launch()'s tryAcquire never
    // queues). Opening the gate then lets the running turn finish, freeing
    // its slot for the two still-blocked turns, one after the other.
    reviewRelease()
    releaseGate()
    await until(() => tasks.every((task, i) => status(repos[i]!, task.id) === 'waiting_for_you'))
    const checksRelease = await checksAcquire
    checksRelease()
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 2, queued: 0 })
    for (const runner of runners) {
      expect(runner.runningCount()).toBe(0)
    }
  })

  test("design.md Decision 4: the turn's slot is released BEFORE onTurnDone can acquire its own, so a cap of 1 never self-deadlocks", async () => {
    const repo = makeRepo()
    const cap = createLoadCap(1)
    const task = makeTask(repo, 'self-deadlock guard', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      loadCap: cap,
      runAgentFn: fakeClaude(() => 'done').run,
      onTurnDone: async (record, io) => {
        // Simulates the REAL reviewer (task-review.ts): it acquires its OWN
        // 'review' slot from the SAME shared cap. With a cap of 1 and the
        // turn's own slot still held, this acquire would never resolve — the
        // assertion below is exactly that it does.
        const release = await cap.acquire('review')
        record.status = 'review_ok'
        io.persist()
        release()
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'review_ok')
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
  })

  // CRITIQUE/MAJEUR 1 (adversarial review): the D2 vocabulary requirement is
  // "journal AND API", not API alone — and only ONCE per transition, not once
  // per retried launch() attempt.
  test('entering the machine-cap wait journals exactly one "queue" event, however many times onSlotFreed retries it', async () => {
    const repo = makeRepo()
    const cap = createLoadCap(1)
    const holderRelease = cap.tryAcquire('turn')
    const task = makeTask(repo, 'journaled wait', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      loadCap: cap,
      runAgentFn: fakeClaude(() => 'done').run,
    })
    runner.start(task)
    await until(() => loadTask(repo, task.id)?.reason?.code === 'resource_busy')

    // Chain the ONE slot through two more unrelated consumers via a DIRECT
    // FIFO hand-off (cap stays saturated throughout: it is never actually
    // free until the very last release) — each hand-off fires onSlotFreed,
    // so our task's pump() retries and misses AGAIN each time. Only the
    // FINAL, real release ever lets it in.
    const w1 = cap.acquire('checks')
    holderRelease?.() // hands straight to w1; the cap stays full
    const w1Release = await w1
    await Promise.resolve()

    const w2 = cap.acquire('review')
    w1Release() // hands straight to w2; still full
    const w2Release = await w2
    await Promise.resolve()

    const queueEvents = readTaskEvents(repo, task.id).filter((e) => e.type === 'queue')
    expect(queueEvents).toHaveLength(1)
    expect(queueEvents[0]?.data).toEqual({
      name: 'machine_busy',
      message:
        'the machine-wide load cap (maxConcurrentAgents) has no free slot for a turn, a review or a checks run',
    })
    expect(queueEvents[0]?.reason_code).toBe('resource_busy')

    w2Release() // nobody left queued: this one actually frees the slot
    await until(() => status(repo, task.id) === 'waiting_for_you')
    // Still exactly one: obtaining the slot is not a second "entering wait".
    expect(readTaskEvents(repo, task.id).filter((e) => e.type === 'queue')).toHaveLength(1)
  })

  // Same requirement, the project-busy motif (schedule()'s own branch).
  test('waiting behind another task of the SAME project journals its own distinct "queue" event, once', async () => {
    const repo = makeRepo()
    let releaseGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })
    const runAgentFn = async (options: AgentRunOptions): Promise<string> => {
      await gate
      const raw = claudeStream('done')
      options.onText?.(raw)
      return raw
    }
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn,
    })
    const first = makeTask(repo, 'first', 'work one')
    const second = makeTask(repo, 'second', 'work two')
    runner.start(first)
    await until(() => status(repo, first.id) === 'running')
    runner.start(second)
    await until(() => loadTask(repo, second.id)?.reason?.code === 'resource_busy')

    const queueEvents = readTaskEvents(repo, second.id).filter((e) => e.type === 'queue')
    expect(queueEvents).toHaveLength(1)
    expect(queueEvents[0]?.data).toEqual({
      name: 'project_busy',
      message: 'another task of this project is already active',
    })

    releaseGate()
    await until(() => status(repo, first.id) === 'waiting_for_you')
    await until(
      () => status(repo, second.id) === 'waiting_for_you' || status(repo, second.id) === 'running',
    )
  })

  // MAJEUR 3 (adversarial review): removing releaseLoadSlot() from launch()'s
  // async `.finally()` is a mutant zero test caught — a worktree that never
  // materializes leaked the machine-cap slot FOR GOOD, since nothing else in
  // the process would ever release it again.
  test('a materialization failure releases the machine-cap slot: the cap recovers, it does not leak', async () => {
    const repo = makeRepo()
    const blocker = await acquireWorktreeLock(repo)
    const impatient: WorktreeLockFn = (cwd, signal) =>
      acquireWorktreeLock(cwd, { timeoutMs: 5, sleepFn: () => Promise.resolve(), signal })
    const cap = createLoadCap(1)
    const task = makeTask(repo, 'materialization fails', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      loadCap: cap,
      runAgentFn: fakeClaude(() => 'must not run').run,
      worktreeLockFn: impatient,
    })

    runner.start(task)
    await until(() => status(repo, task.id) === 'interrupted')

    // The turn never ran (the worktree lock gave up first), yet the slot
    // `launch()` reserved before any of that must be back: nothing else in
    // this process would ever free it otherwise.
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
    blocker.release()
    // Proven by USE, not just by the counter: a fresh acquire succeeds.
    const fresh = cap.tryAcquire('turn')
    expect(fresh).not.toBeNull()
    fresh?.()
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

  test('T1.6: a rename git refuses is journaled with its reason, and the task keeps its slug', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'something vague', 'fix it')
    // Every codesema/task-* fork lives under this shared subdirectory: made
    // read-only from inside the agent call (once the fork branch already
    // exists), `git branch -m` can no longer write the renamed ref into it.
    const refsSubdir = join(repo, '.git', 'refs', 'heads', 'codesema')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: (options) => {
        chmodSync(refsSubdir, 0o500)
        const raw = claudeStream('BRANCH: fix-preview-rename\nfixed')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
    })
    try {
      runner.start(task)
      await until(() => status(repo, task.id) === 'waiting_for_you')
      const record = loadTask(repo, task.id)
      // Refused: the task keeps the slug of its title.
      expect(record?.branch).toBe('codesema/task-something-vague')
      const refused = readTaskEvents(repo, task.id).find(
        (e) => typeof e.data.name === 'string' && e.data.name.startsWith('branch_rename_'),
      )
      expect(refused?.data.name).toBe('branch_rename_git_refused')
      expect(refused?.data.kept_branch).toBe('codesema/task-something-vague')
      // No D2 code: a cosmetic rename declining stops nothing (DP14).
      expect(refused?.reason_code).toBeUndefined()
      // The turn itself never failed over a cosmetic rename.
      expect(readTaskEvents(repo, task.id).map((e) => e.type)).not.toContain('error')
    } finally {
      chmodSync(refsSubdir, 0o700)
    }
  })

  test('T1.6: an already-pushed rename is journaled too, not just git_refused', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'something vague', 'fix it')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: (options) => {
        // Published from inside the agent call, once the fork branch exists
        // (its name is now known) but before the turn finishes and tries the
        // rename.
        execFileSync(
          'git',
          ['update-ref', 'refs/remotes/origin/codesema/task-something-vague', 'HEAD'],
          { cwd: repo },
        )
        const raw = claudeStream('BRANCH: fix-preview-rename\nfixed')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id)
    expect(record?.branch).toBe('codesema/task-something-vague')
    const refused = readTaskEvents(repo, task.id).find(
      (e) => typeof e.data.name === 'string' && e.data.name.startsWith('branch_rename_'),
    )
    expect(refused?.data.name).toBe('branch_rename_already_pushed')
    expect(refused?.data.kept_branch).toBe('codesema/task-something-vague')
  })

  test('T1.6: a rename to the name the branch already has is journaled as already_named', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'fix preview rename', 'fix it')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      // The agent proposes exactly the slug it already has.
      runAgentFn: fakeClaude(() => 'BRANCH: fix-preview-rename\nfixed').run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id)
    expect(record?.branch).toBe('codesema/task-fix-preview-rename')
    const refused = readTaskEvents(repo, task.id).find(
      (e) => typeof e.data.name === 'string' && e.data.name.startsWith('branch_rename_'),
    )
    expect(refused?.data.name).toBe('branch_rename_already_named')
  })

  test('T1.6: a proposal with nothing usable is journaled as unusable_proposal', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'something vague', 'fix it')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      // 'task' passes parseTaskBranchProposal's own validity check (a plain
      // identifier) but slugs to slug()'s LAST-RESORT sentinel: the one input
      // that reaches renameTaskBranch's `unusable_proposal` path rather than
      // being filtered out earlier as unparseable ('!!! ???' never reaches
      // renameTaskBranch at all — parseTaskBranchProposal drops it first).
      runAgentFn: fakeClaude(() => 'BRANCH: task\nfixed').run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id)
    expect(record?.branch).toBe('codesema/task-something-vague')
    const refused = readTaskEvents(repo, task.id).find(
      (e) => typeof e.data.name === 'string' && e.data.name.startsWith('branch_rename_'),
    )
    expect(refused?.data.name).toBe('branch_rename_unusable_proposal')
  })

  test('a work-on materialization that loses the lock keeps its branch claimed', async () => {
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
    // A third party holds the repo lock and never lets go, with a budget short
    // enough for a test: the materialization loses.
    const blocker = await acquireWorktreeLock(repo)
    const impatient: WorktreeLockFn = (cwd, signal) =>
      acquireWorktreeLock(cwd, { timeoutMs: 5, sleepFn: () => Promise.resolve(), signal })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'must not run').run,
      worktreeLockFn: impatient,
    })

    runner.start(task)
    await until(() => status(repo, task.id) === 'interrupted')

    const stopped = loadTask(repo, task.id)
    expect(stopped?.reason?.code).toBe('resource_busy')
    // Resumable, therefore ACTIVE, therefore still the owner of its branch —
    // that is exactly what the server's one-conversation-per-branch guard
    // reads. Under the old terminal 'failed' the branch was released, and a
    // second conversation could have been opened on top of this one.
    expect(isActiveTaskStatus(stopped?.status ?? 'failed')).toBe(true)
    expect(stopped?.branch).toBe('feature/mine')
    // Nothing was taken meanwhile: the branch is not checked out anywhere.
    expect(branchCheckoutPath(repo, 'feature/mine')).toBeNull()

    // And the claim is not a dead end: the conversation really does start on
    // that branch once the lock frees.
    blocker.release()
    runner.reply(task.id, 'try again')
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const resumed = loadTask(repo, task.id)
    expect(resumed?.branch).toBe('feature/mine')
    expect(branchCheckoutPath(repo, 'feature/mine')).toBe(resumed?.worktree ?? '')
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

describe('baseline recorded by the runner', () => {
  test('the turn is measured from the start point, and the WIP left behind is announced', async () => {
    const repo = makeRepo()
    // The human's working tree at the moment the task starts: an uncommitted
    // edit and a file that was never added.
    writeFileSync(join(repo, 'base.txt'), 'a\nuncommitted local edit\n')
    writeFileSync(join(repo, 'scratch.txt'), 'personal notes\n')
    const task = makeTask(repo, 'Add feature', 'write feature.txt')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'feature written', ['feature.txt']).run,
    })

    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    const record = loadTask(repo, task.id)
    expect(record?.baseline_sha).toMatch(/^[0-9a-f]{40}$/)
    expect(record?.baseline_sha).toBe(
      execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: repo }).toString().trim(),
    )
    // The agent did NOT inherit the human's work in progress…
    expect(readFileSync(join(record?.worktree ?? '', 'base.txt'), 'utf8')).toBe('a\n')
    expect(existsSync(join(record?.worktree ?? '', 'scratch.txt'))).toBe(false)
    // …and that is said out loud, once, rather than left to be discovered.
    const notice = readTaskEvents(repo, task.id).find(
      (e) => typeof e.data.uncommitted_files === 'number',
    )
    expect(notice?.type).toBe('message')
    expect(notice?.data.uncommitted_files).toBe(2)
    expect(String(notice?.data.text)).toContain('NOT carried')
    expect(String(notice?.data.text)).toContain(String(record?.baseline_sha).slice(0, 12))
    // The turn's diff holds its work and nothing else.
    const changed = (
      tryGit(['diff', '--name-only', `${record?.baseline_sha}..HEAD`], record?.worktree ?? '') ?? ''
    )
      .split('\n')
      .filter(Boolean)
    expect(changed).toEqual(['feature.txt'])
  })

  test('a clean checkout is never told it left anything behind', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'Add feature', 'write feature.txt')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done', ['feature.txt']).run,
    })

    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    expect(readTaskEvents(repo, task.id).some((e) => 'uncommitted_files' in e.data)).toBe(false)
  })

  test('the notice is a one-off: a second turn does not repeat it', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'scratch.txt'), 'personal notes\n')
    const task = makeTask(repo, 'two turns', 'first')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'codex exec -',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done', ['one.txt']).run,
    })

    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    runner.reply(task.id, 'continue')
    await until(() => loadTask(repo, task.id)?.turns.length === 2)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    const notices = readTaskEvents(repo, task.id).filter((e) => 'uncommitted_files' in e.data)
    expect(notices).toHaveLength(1)
  })

  test('a worktree rebuilt on a DIRTY checkout never moves the anchor', async () => {
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
    const runner = createTaskRunner({
      cwd: repo,
      command: 'codex exec -',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'turn done', ['turn1.txt']).run,
    })

    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const first = loadTask(repo, task.id)
    expect(first?.baseline_sha).toMatch(/^[0-9a-f]{40}$/)

    // Crash: the worktree is gone. The human has been working in their own
    // checkout meanwhile, so the rebuild happens on a DIRTY repo.
    rmSync(first?.worktree ?? '', { recursive: true, force: true })
    writeFileSync(join(repo, 'base.txt'), 'a\nhuman work in progress\n')
    writeFileSync(join(repo, 'secret-notes.txt'), 'private\n')
    runner.reply(task.id, 'continue')
    await until(() => loadTask(repo, task.id)?.turns.length === 2)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    const second = loadTask(repo, task.id)
    // WRITE-ONCE: the anchor belongs to the conversation. Moving it here would
    // drop turn 1 out of every diff measured from it.
    expect(second?.baseline_sha).toBe(first?.baseline_sha ?? '')
    const changed = (
      tryGit(['diff', '--name-only', `${second?.baseline_sha}..HEAD`], second?.worktree ?? '') ?? ''
    )
      .split('\n')
      .filter(Boolean)
    expect(changed).toContain('turn1.txt')
    // And the human's private work in progress is nowhere near the branch.
    expect(changed).not.toContain('secret-notes.txt')
    expect(changed).not.toContain('base.txt')
    expect(existsSync(join(second?.worktree ?? '', 'secret-notes.txt'))).toBe(false)
  })

  test('a materialization that names its degradation lands the code on the record', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'busy repo', 'work')
    // The producer this exists for is the repo's worktree lock giving up
    // (`resource_busy`); any failure that names itself travels the same way.
    const named = Object.assign(new Error('worktree lock held by pid 4242'), {
      reasonCode: 'resource_busy',
    })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: () => Promise.reject(named),
    })

    runner.start(task)
    await until(() => status(repo, task.id) === 'interrupted')

    // The EVENT names the same outcome as the status: a task parked on
    // 'interrupted', with a resume affordance, is not announced by an 'error'.
    expect(readTaskEvents(repo, task.id).some((e) => e.type === 'error')).toBe(false)
    const event = readTaskEvents(repo, task.id).find((e) => e.type === 'interrupted')
    // The payload is untouched; the code rides beside it.
    expect(event?.data).toEqual({ message: 'worktree lock held by pid 4242' })
    expect(event?.reason_code).toBe('resource_busy')
    const record = loadTask(repo, task.id)
    expect(record?.reason).toEqual({
      code: 'resource_busy',
      detail: 'worktree lock held by pid 4242',
    })
    // 'resource_busy' is RETRYABLE: it must not land on a status nothing can
    // pick back up. The turn is still there to resume.
    expect(record?.status).toBe('interrupted')
    expect(pendingResumeTurn(record as TaskRecord)).not.toBeNull()
  })

  test('a TERMINAL degradation lands on failed, and is announced as an error', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'unrecoverable', 'work')
    // The other half of the rule: waiting changes nothing for a terminal code,
    // so parking the task on 'interrupted' would offer a Resume that can only
    // reproduce the same failure. 'failed' is the honest end of the line.
    const named = Object.assign(new Error('the merge cannot be replayed'), {
      reasonCode: 'merge_conflict',
    })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: () => Promise.reject(named),
    })

    runner.start(task)
    await until(() => status(repo, task.id) === 'failed')

    const events = readTaskEvents(repo, task.id)
    expect(events.some((e) => e.type === 'interrupted')).toBe(false)
    const error = events.find((e) => e.type === 'error')
    expect(error?.reason_code).toBe('merge_conflict')
    expect(loadTask(repo, task.id)?.reason?.code).toBe('merge_conflict')
  })

  test('a producer that spells its code the wire way is read all the same', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'snake case producer', 'work')
    // Producers in this codebase write `reasonCode`; the wire, the journal and
    // anything read back from disk write `reason_code`. The READER tolerates
    // both, or half the degradations would be dropped on the floor.
    const named = Object.assign(new Error('nobody is answering'), {
      reason_code: 'forge_unreachable',
    })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: () => Promise.reject(named),
    })

    runner.start(task)
    await until(() => status(repo, task.id) === 'interrupted')
    expect(loadTask(repo, task.id)?.reason?.code).toBe('forge_unreachable')
  })

  test('an unnamed failure still lands as a plain error, with no invented code', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'plain failure', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: () => Promise.reject(new Error('agent exploded')),
    })

    runner.start(task)
    await until(() => status(repo, task.id) === 'failed')

    const error = readTaskEvents(repo, task.id).find((e) => e.type === 'error')
    expect(error?.reason_code).toBeUndefined()
    expect('reason' in (loadTask(repo, task.id) ?? {})).toBe(false)
  })

  test('an interrupt while the worktree queues for the repo lock lands on INTERRUPTED', async () => {
    const repo = makeRepo()
    // Another holder has the repo lock, so the launch queues behind it for the
    // whole 75 s budget: only the interrupt can end this.
    openLocks.push(await acquireWorktreeLock(repo))
    const task = makeTask(repo, 'queued behind the lock', 'work')
    const fake = fakeClaude(() => 'must not run')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fake.run,
    })

    runner.start(task)
    expect(runner.runningCount()).toBe(1)
    expect(runner.interrupt(task.id)).toEqual({ ok: true })
    await until(() => status(repo, task.id) === 'interrupted')

    const record = loadTask(repo, task.id)
    // 'failed' would be a dead end — nothing resumes from it — while
    // 'interrupted' is exactly what the Resume button picks back up.
    expect(record?.status).toBe('interrupted')
    expect(record?.reason?.code).toBe('interrupted_by_user')
    expect(fake.prompts).toHaveLength(0)
  })

  test('a materialization whose lock wait runs out carries resource_busy to the record', async () => {
    const repo = makeRepo()
    // A holder that never lets go, and a budget short enough for a test.
    openLocks.push(await acquireWorktreeLock(repo))
    const impatient: WorktreeLockFn = (cwd, signal) =>
      acquireWorktreeLock(cwd, {
        timeoutMs: 5,
        sleepFn: () => Promise.resolve(),
        signal,
      })
    const task = makeTask(repo, 'never gets its turn', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'must not run').run,
      worktreeLockFn: impatient,
    })

    runner.start(task)
    await until(() => status(repo, task.id) === 'interrupted')

    const record = loadTask(repo, task.id)
    // Retryable by name, with who was holding and for how long, all the way to
    // the record — not just inside an error object nobody reads.
    expect(record?.reason?.code).toBe('resource_busy')
    expect(record?.reason?.detail).toContain(String(process.pid))
    const event = readTaskEvents(repo, task.id).find((e) => e.type === 'interrupted')
    expect(event?.reason_code).toBe('resource_busy')
    // Retryable, so resumable: the whole point of the code.
    expect(pendingResumeTurn(record as TaskRecord)).not.toBeNull()
    expect(runner.resume(task.id)).toEqual({ ok: true })
  })

  test('an abandon that cannot get the repo lock cleans up anyway, and SAYS it did', async () => {
    const repo = makeRepo()
    // Short budgets: the wait runs out instead of holding the test for 75 s.
    const impatient: WorktreeLockFn = (cwd, signal) =>
      acquireWorktreeLock(cwd, {
        timeoutMs: 5,
        sleepFn: () => Promise.resolve(),
        signal,
      })
    const task = makeTask(repo, 'to abandon', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done').run,
      worktreeLockFn: impatient,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const worktree = loadTask(repo, task.id)?.worktree ?? ''

    // A holder that never lets go, exactly when the abandon needs the lock.
    openLocks.push(await acquireWorktreeLock(repo))
    expect(await runner.abandon(task.id)).toEqual({ ok: true })

    // It cleaned up rather than strand the worktree forever…
    expect(existsSync(worktree)).toBe(false)
    expect(status(repo, task.id)).toBe('failed')
    // …and the degradation is named and readable, not inferred later.
    const notice = readTaskEvents(repo, task.id).find((e) =>
      String(e.data.message).includes('WITHOUT the repo lock'),
    )
    expect(notice?.reason_code).toBe('resource_busy')
    expect(String(notice?.data.message)).toContain(String(process.pid))
  })

  test('nothing may start a turn while an abandon is waiting for the repo lock', async () => {
    const repo = makeRepo()
    const impatient: WorktreeLockFn = (cwd, signal) =>
      acquireWorktreeLock(cwd, {
        timeoutMs: 400,
        sleepFn: () => sleep(20),
        signal,
      })
    const task = makeTask(repo, 'abandon me', 'work')
    const fake = fakeClaude(() => 'done')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fake.run,
      worktreeLockFn: impatient,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(fake.prompts).toHaveLength(1)

    // A third party holds the repo lock, so the abandon parks inside its await
    // — the exact window where its guards and its record snapshot are stale.
    openLocks.push(await acquireWorktreeLock(repo))
    const abandon = runner.abandon(task.id)
    // Without the in-flight token this reply is accepted, runs a REAL agent
    // turn on a worktree about to be deleted, and has its record overwritten
    // by the abandon's snapshot.
    expect(runner.reply(task.id, 'sneak a turn in')).toMatchObject({ ok: false, code: 409 })
    expect(runner.resume(task.id)).toMatchObject({ ok: false, code: 409 })
    expect(await runner.abandon(task.id)).toMatchObject({ ok: false, code: 409 })
    expect(await abandon).toEqual({ ok: true })

    // One turn ran, one turn survives, and the worktree is gone.
    expect(fake.prompts).toHaveLength(1)
    const record = loadTask(repo, task.id)
    expect(record?.turns).toHaveLength(1)
    expect(record?.status).toBe('failed')
    expect(existsSync(record?.worktree ?? '')).toBe(false)
  })

  test('an abandon whose cleanup cannot happen REPORTS it instead of rejecting', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'unremovable', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done').run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    // The lock itself is broken (an unwritable .codesema, a read-only mount):
    // this is NOT a spent wait, so removeTaskWorktree lets it through — and
    // the HTTP layer that dispatches abandon() has no catch, so an unhandled
    // rejection here would take the whole server down.
    const broken = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done').run,
      worktreeLockFn: () => Promise.reject(new Error('EROFS: read-only file system')),
    })
    const result = await broken.abandon(task.id)

    expect(result).toMatchObject({ ok: false, code: 500 })
    expect(String((result as { error: string }).error)).toContain('EROFS')
    // The task keeps what it still has: both are still true.
    expect(status(repo, task.id)).toBe('waiting_for_you')
    expect(existsSync(loadTask(repo, task.id)?.worktree ?? '')).toBe(true)
    // And the runner did not stay stuck on it.
    expect(await runner.abandon(task.id)).toEqual({ ok: true })
  })

  test('abandon releases the HOME volume of a container-isolated task', async () => {
    const repo = makeRepo()
    // Started as 'policy' so the turn runs on the fake host agent — real
    // container isolation is a different module's concern (task-isolation.test.ts).
    // The record is flipped to 'container' right before the abandon this test
    // is actually about, so only the RELEASE gate is exercised here.
    const task = makeTask(repo, 'caged task', 'work', 'policy')
    const released: string[] = []
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done').run,
      releaseAgentHomeFn: (opts) => {
        released.push(opts.taskId)
        return Promise.resolve({ released: true })
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id) as TaskRecord
    record.isolation = 'container'
    saveTask(repo, record)
    expect(await runner.abandon(task.id)).toEqual({ ok: true })

    expect(released).toEqual([task.id])
    const event = readTaskEvents(repo, task.id).find((e) => e.type === 'resource')
    expect(event?.data.name).toBe('home_volume_released')
    // Neutral vocabulary (DP9/DP10): a release outcome never carries a D2 code.
    expect(event?.reason_code).toBeUndefined()
  })

  test('abandon on a policy-isolated task never attempts a release: nothing was ever created', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'host task', 'work', 'policy')
    let calls = 0
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done').run,
      releaseAgentHomeFn: () => {
        calls++
        return Promise.resolve({ released: true })
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(await runner.abandon(task.id)).toEqual({ ok: true })

    expect(calls).toBe(0)
    expect(readTaskEvents(repo, task.id).find((e) => e.type === 'resource')).toBeUndefined()
  })

  // T1.9 review round 3, Majeur 6(b): the ADDED requirement "Abandon
  // libérant les ressources sans détruire de travail" had zero test coverage
  // — no line in this file mentioned `branch`, `work_on` or `preserved`. This
  // is the T1.6 non-regression spec.md's "Abandon d'une tâche work_on"
  // scenario asks for directly: the volume is released, the worktree is
  // retired, and the branch — the USER's, not this conversation's to delete
  // — is never touched, same commit before and after.
  test('abandon on a work_on task releases the volume and retires the worktree, but the branch is NEVER touched (T1.6 non-regression)', async () => {
    const repo = makeRepo()
    execFileSync('git', ['branch', 'existing-feature'], { cwd: repo, stdio: 'ignore' })
    const shaBefore = execFileSync('git', ['rev-parse', 'existing-feature'], { cwd: repo })
      .toString()
      .trim()
    // Started as 'policy' so the turn runs on the fake host agent — real
    // container isolation is a different module's concern, same pattern as
    // the 'abandon releases the HOME volume of a container-isolated task'
    // test above: the record is flipped to 'container' right before the
    // abandon this test is actually about.
    const task = createTask(repo, {
      title: 'work on existing feature',
      prompt: 'work',
      autoShip: false,
      base: '',
      branch: 'existing-feature',
      worktree: '',
      workOn: true,
    })
    const released: string[] = []
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done').run,
      releaseAgentHomeFn: (opts) => {
        released.push(opts.taskId)
        return Promise.resolve({ released: true })
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const worktree = loadTask(repo, task.id)?.worktree ?? ''
    expect(worktree).not.toBe('')
    const record = loadTask(repo, task.id) as TaskRecord
    record.isolation = 'container'
    saveTask(repo, record)

    expect(await runner.abandon(task.id)).toEqual({ ok: true })

    expect(status(repo, task.id)).toBe('failed')
    expect(existsSync(worktree)).toBe(false) // the worktree IS retired
    expect(released).toEqual([task.id]) // the volume IS released
    // The branch survives, untouched: same name, same commit.
    const branches = execFileSync('git', ['branch', '--list', 'existing-feature'], {
      cwd: repo,
    }).toString()
    expect(branches).toContain('existing-feature')
    expect(
      execFileSync('git', ['rev-parse', 'existing-feature'], { cwd: repo }).toString().trim(),
    ).toBe(shaBefore)
  })

  test('a release failure never blocks the abandon from reaching its terminal status', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'caged task', 'work', 'policy')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done').run,
      releaseAgentHomeFn: () =>
        Promise.resolve({ released: false, reason: 'rm-failed', detail: 'daemon busy' }),
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id) as TaskRecord
    record.isolation = 'container'
    saveTask(repo, record)
    expect(await runner.abandon(task.id)).toEqual({ ok: true })

    expect(status(repo, task.id)).toBe('failed')
    const event = readTaskEvents(repo, task.id).find((e) => e.type === 'resource')
    expect(event?.data.name).toBe('home_volume_not_released')
    expect(String(event?.data.message)).toContain('daemon busy')
    expect(event?.reason_code).toBeUndefined()
  })

  // T1.9 review round 3, Mineur 3: `releaseTaskHome` used to be awaited
  // BEFORE `persist(current)` — a daemon blocked on `volume rm` could delay
  // writing the terminal status by up to the release seam's own budget, and a
  // process death in that window would strand the task on a non-terminal
  // status. Proven directly: the fake release reads the record back WHILE it
  // is still being awaited, and the terminal status must already be there.
  test('abandon persists the terminal status BEFORE awaiting the HOME volume release, never after', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'caged task', 'work', 'policy')
    let observedDuringRelease: TaskStatus | undefined
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done').run,
      releaseAgentHomeFn: () => {
        observedDuringRelease = loadTask(repo, task.id)?.status
        return Promise.resolve({ released: true })
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id) as TaskRecord
    record.isolation = 'container'
    saveTask(repo, record)

    expect(await runner.abandon(task.id)).toEqual({ ok: true })

    expect(observedDuringRelease).toBe('failed')
  })

  test('no container runtime detected: named distinctly from an ordinary release failure', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'caged task', 'work', 'policy')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done').run,
      releaseAgentHomeFn: () => Promise.resolve({ released: false, reason: 'no-runtime' }),
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id) as TaskRecord
    record.isolation = 'container'
    saveTask(repo, record)
    expect(await runner.abandon(task.id)).toEqual({ ok: true })

    const event = readTaskEvents(repo, task.id).find((e) => e.type === 'resource')
    expect(event?.data.name).toBe('container_runtime_absent')
  })

  test('an abandon never writes back the record it read before waiting', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'shipped under it', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done').run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    // A third party holds the repo lock: the abandon parks inside its await,
    // holding a snapshot taken BEFORE it.
    const blocker = await acquireWorktreeLock(repo)
    const abandon = runner.abandon(task.id)
    // A ship settles in that window — it runs one layer up (task-server), on
    // its own copy of the record, and writes it.
    const shipped = loadTask(repo, task.id) as TaskRecord
    shipped.status = 'shipped'
    shipped.reason = { code: 'forge_unreachable', detail: 'pushed, no MR' }
    saveTask(repo, shipped)
    blocker.release()
    expect(await abandon).toEqual({ ok: true })

    // The abandon decided on a RE-READ, not on its snapshot: writing the old
    // copy back would have buried a pushed branch under 'failed'.
    const record = loadTask(repo, task.id)
    expect(record?.status).toBe('shipped')
    expect(record?.reason?.code).toBe('forge_unreachable')
    expect(existsSync(record?.worktree ?? '')).toBe(false)
  })

  test('an abandon that fails puts a queued task back in its queue', async () => {
    const repo = makeRepo()
    const running = makeTask(repo, 'holds the only slot', 'work')
    const waiting = makeTask(repo, 'still queued', 'work')
    const fake = fakeClaude(() => 'done')
    // The SAME runner, whose lock breaks only for the abandon: a queue belongs
    // to its runner, so the requeue can only be observed on the one that
    // dropped the task in the first place.
    let lockBroken = false
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 60_000,
      maxParallel: 1,
      runAgentFn: (options: AgentRunOptions) =>
        options.prompt.includes('holds the only slot') ? hangingAgent(options) : fake.run(options),
      worktreeLockFn: (cwd, signal) =>
        lockBroken
          ? Promise.reject(new Error('EROFS: read-only file system'))
          : acquireWorktreeLock(cwd, signal ? { signal } : {}),
    })
    runner.start(running)
    await until(() => status(repo, running.id) === 'running')
    // Behind the active one, so the gesture answers with its rank (T1.2).
    expect(runner.start(waiting)).toEqual({ ok: true, queue_position: 1 })
    expect(status(repo, waiting.id)).toBe('queued')

    // The cleanup cannot happen: the task changes in no way — so it must not
    // come out of this dropped from every queue, 'queued' and unstartable.
    lockBroken = true
    expect(await runner.abandon(waiting.id)).toMatchObject({ ok: false, code: 500 })
    lockBroken = false

    // Still in the queue (start() says so) and still reachable: it runs the
    // moment the slot frees.
    expect(runner.start(waiting)).toMatchObject({ ok: false, code: 409 })
    runner.interrupt(running.id)
    await until(() => status(repo, waiting.id) === 'waiting_for_you')
  })

  test('shutdown waits for an abandon that is still holding its record', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'abandoned at the door', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done').run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const worktree = loadTask(repo, task.id)?.worktree ?? ''

    const blocker = await acquireWorktreeLock(repo)
    const abandon = runner.abandon(task.id)
    setTimeout(() => blocker.release(), 60)
    // An abandon is a worktree removal followed by a record write: draining
    // between the two would exit with the worktree gone and the record still
    // naming it.
    await runner.shutdown()
    expect(status(repo, task.id)).toBe('failed')
    expect(existsSync(worktree)).toBe(false)
    expect(await abandon).toEqual({ ok: true })
  })

  test('a repo lock taken from a live pid is REPORTED where the human reads', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'stolen lock', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done').run,
      // What acquireWorktreeLock hands back when its pid-recycling valve fires.
      worktreeLockFn: async (cwd, signal) => ({
        ...(await acquireWorktreeLock(cwd, signal ? { signal } : {})),
        stolen: { pid: 4242, ageMs: 1_800_000 },
      }),
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    const notice = readTaskEvents(repo, task.id).find((e) =>
      String(e.data.message).includes('taken from pid 4242'),
    )
    expect(notice?.reason_code).toBe('resource_busy')
    expect(String(notice?.data.message)).toContain('1800s')
  })

  test('a stolen lock is REPORTED on the rebuild path too, not just on the first fork', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'stolen on rebuild', 'work')
    // Only the SECOND acquisition reports a steal, so the notice can only come
    // from the path that adopts the branch back — the one this round added.
    let acquisitions = 0
    const runner = createTaskRunner({
      cwd: repo,
      command: 'codex exec -',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'turn done', ['agent.txt']).run,
      worktreeLockFn: async (cwd, signal) => {
        acquisitions += 1
        const handle = await acquireWorktreeLock(cwd, signal ? { signal } : {})
        return acquisitions === 1 ? handle : { ...handle, stolen: { pid: 77, ageMs: 900_000 } }
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const first = loadTask(repo, task.id)
    expect(readTaskEvents(repo, task.id).some((e) => e.type === 'error')).toBe(false)

    rmSync(first?.worktree ?? '', { recursive: true, force: true })
    runner.reply(task.id, 'continue')
    await until(() => loadTask(repo, task.id)?.turns.length === 2)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    // Same branch (the rebuild adopted it) AND the degradation is named.
    expect(loadTask(repo, task.id)?.branch).toBe(first?.branch ?? '')
    const notice = readTaskEvents(repo, task.id).find((e) =>
      String(e.data.message).includes('taken from pid 77'),
    )
    expect(notice?.reason_code).toBe('resource_busy')
  })

  test('a stolen lock is REPORTED on a work-on materialization too', async () => {
    const repo = makeRepo()
    execFileSync('git', ['branch', 'feature/shared'], { cwd: repo })
    const task = createTask(repo, {
      title: 'work on shared',
      prompt: 'keep going',
      autoShip: false,
      base: 'main',
      branch: 'feature/shared',
      worktree: '',
      workOn: true,
    })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done').run,
      worktreeLockFn: async (cwd, signal) => ({
        ...(await acquireWorktreeLock(cwd, signal ? { signal } : {})),
        stolen: { pid: 5150, ageMs: 1_200_000 },
      }),
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    const notice = readTaskEvents(repo, task.id).find((e) =>
      String(e.data.message).includes('taken from pid 5150'),
    )
    expect(notice?.reason_code).toBe('resource_busy')
  })

  test('a conversation interrupted BEFORE its first materialization still gets its anchor', async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, 'scratch.txt'), 'work in progress\n')
    // Another holder has the repo lock: the launch parks before materializing.
    const blocker = await acquireWorktreeLock(repo)
    const task = makeTask(repo, 'interrupted early', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'codex exec -',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done', ['agent.txt']).run,
    })
    runner.start(task)
    expect(runner.interrupt(task.id)).toEqual({ ok: true })
    await until(() => status(repo, task.id) === 'interrupted')

    // Its turn was stamped ended_at by failTurn, yet NOTHING ran: no worktree,
    // no branch, no commit. reply() is the documented way back.
    const stopped = loadTask(repo, task.id)
    expect(stopped?.worktree).toBe('')
    expect(stopped?.turns[0]?.ended_at).not.toBeNull()
    expect(stopped?.baseline_sha).toBeUndefined()

    blocker.release()
    runner.reply(task.id, 'try again')
    await until(() => status(repo, task.id) === 'waiting_for_you')

    const resumed = loadTask(repo, task.id)
    // The anchor is posted, because an empty worktree PROVED nothing could be
    // on the branch — and the WIP notice, which lives in the same branch of
    // the logic, is emitted with it.
    expect(resumed?.baseline_sha).toMatch(/^[0-9a-f]{40}$/)
    const notice = readTaskEvents(repo, task.id).find((e) => 'uncommitted_files' in e.data)
    expect(notice?.data.uncommitted_files).toBe(1)
    // And no journal line claims turns that never ran.
    expect(
      readTaskEvents(repo, task.id).some((e) => String(e.data.text).includes('already existed')),
    ).toBe(false)
  })

  test('a work-on conversation names its BRANCH in the notice, never the MR target', async () => {
    const repo = makeRepo()
    execFileSync('git', ['branch', 'feature/mine'], { cwd: repo })
    writeFileSync(join(repo, 'scratch.txt'), 'work in progress\n')
    const task = createTask(repo, {
      title: 'work on my branch',
      prompt: 'keep going',
      autoShip: false,
      // In work-on mode `base` is the MR TARGET: naming it beside the branch
      // tip's sha would label the sha with something it has nothing to do with.
      base: 'main',
      branch: 'feature/mine',
      worktree: '',
      workOn: true,
    })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done').run,
    })

    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    const record = loadTask(repo, task.id)
    const notice = readTaskEvents(repo, task.id).find((e) => 'uncommitted_files' in e.data)
    expect(String(notice?.data.text)).toContain(
      `feature/mine@${String(record?.baseline_sha).slice(0, 12)}`,
    )
    expect(String(notice?.data.text)).not.toContain('main@')
  })

  test('a 0.12 conversation resumed without an anchor gets none: its turns would vanish', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'legacy conversation', 'first')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'codex exec -',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'turn done', ['turn1.txt']).run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    // Rewind the record to what 0.12 wrote: no anchor, and a turn already ran.
    const legacy = loadTask(repo, task.id)
    const worktree = legacy?.worktree ?? ''
    delete legacy?.baseline_sha
    saveTask(repo, legacy as TaskRecord)
    rmSync(worktree, { recursive: true, force: true })

    runner.reply(task.id, 'continue')
    await until(() => loadTask(repo, task.id)?.turns.length === 2)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    // Anchoring NOW would put turn 1's work behind the baseline and out of
    // every review measured from it: better none, said out loud.
    expect(loadTask(repo, task.id)?.baseline_sha).toBeUndefined()
    const notice = readTaskEvents(repo, task.id).find((e) =>
      String(e.data.text).includes('anchoring one now'),
    )
    expect(notice).toBeDefined()
    expect(String(notice?.data.text)).toContain('main...HEAD')
  })

  // Rewritten (was: 'a fork rebuilt on a base that MOVED re-anchors, and says
  // the anchor moved'). It locked the behaviour this round abrogates: a rebuild
  // used to forge a BRAND-NEW branch, leaving the commits of the earlier turns
  // on a branch nothing referenced any more. Re-forging is now the exception,
  // not the rule, and the re-anchoring it forces is asserted by the test below.
  test.each([
    ['the base moved meanwhile', true],
    ['the base did not move at all', false],
  ])(
    'a fork rebuilt after its worktree vanished goes back to its OWN branch (%s)',
    async (_label, baseMoves) => {
      const repo = makeRepo()
      const task = makeTask(repo, 'rebuilt fork', 'work')
      const runner = createTaskRunner({
        cwd: repo,
        command: 'codex exec -',
        timeoutMs: 1000,
        runAgentFn: fakeClaude(() => 'turn done', ['agent.txt']).run,
      })
      runner.start(task)
      await until(() => status(repo, task.id) === 'waiting_for_you')
      const first = loadTask(repo, task.id)
      const work = tryGit(['rev-parse', 'HEAD'], first?.worktree ?? '')

      // Crash: the worktree is gone. The BRANCH still carries turn 1's commit.
      rmSync(first?.worktree ?? '', { recursive: true, force: true })
      if (baseMoves) {
        writeFileSync(join(repo, 'teammate.txt'), 'not the agent\n')
        execFileSync('git', ['add', '-A'], { cwd: repo })
        execFileSync('git', ['commit', '-m', 'feat: teammate work'], { cwd: repo, stdio: 'ignore' })
      }

      runner.reply(task.id, 'continue')
      await until(() => loadTask(repo, task.id)?.turns.length === 2)
      await until(() => status(repo, task.id) === 'waiting_for_you')

      const second = loadTask(repo, task.id)
      // Same branch, same lineage, immobile anchor: forking a fresh branch here
      // would leave turn 1's commit on a branch nothing points at — out of the
      // diff, out of the review, out of the ship, and not even deleted on abandon.
      expect(second?.branch).toBe(first?.branch ?? '')
      expect(second?.baseline_sha).toBe(first?.baseline_sha ?? '')
      expect(refExists(`refs/heads/${first?.branch}-2`, repo)).toBe(false)
      // The work of turn 1 is IN this worktree, not orphaned beside it.
      expect(existsSync(join(second?.worktree ?? '', 'agent.txt'))).toBe(true)
      expect(
        tryGit(['merge-base', '--is-ancestor', work ?? '', 'HEAD'], second?.worktree ?? ''),
      ).toBe('')
      const changed = (
        tryGit(['diff', '--name-only', `${second?.baseline_sha}..HEAD`], second?.worktree ?? '') ??
        ''
      )
        .split('\n')
        .filter(Boolean)
      expect(changed).toContain('agent.txt')
      expect(changed).not.toContain('teammate.txt')
      // Nothing foreign happened, so nothing is announced: the notice below
      // must stay a real signal, not a line printed on every rebuild.
      expect(readTaskEvents(repo, task.id).some((e) => 'foreign_commits' in e.data)).toBe(false)
    },
  )

  test('a rebuild NAMES the commits a third party pushed while the worktree was gone', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'shared branch', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'codex exec -',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'turn done', ['agent.txt']).run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const first = loadTask(repo, task.id)
    const branch = first?.branch ?? ''
    // The conversation remembers where it left its branch.
    expect(first?.head_sha).toBe(tryGit(['rev-parse', `refs/heads/${branch}`], repo) ?? '')

    rmSync(first?.worktree ?? '', { recursive: true, force: true })
    execFileSync('git', ['worktree', 'prune'], { cwd: repo })
    // Somebody else pushes three commits onto the task's branch meanwhile.
    const theirs = join(mkdtempSync(join(tmpdir(), 'codesema-theirs-')), 'wt')
    cleanups.push(theirs)
    execFileSync('git', ['worktree', 'add', theirs, branch], { cwd: repo, stdio: 'ignore' })
    for (const n of [1, 2, 3]) {
      writeFileSync(join(theirs, `theirs-${n}.txt`), 'not the agent\n')
      execFileSync('git', ['add', '-A'], { cwd: theirs })
      execFileSync('git', ['commit', '-m', `feat: theirs ${n}`], { cwd: theirs, stdio: 'ignore' })
    }
    execFileSync('git', ['worktree', 'remove', '--force', theirs], { cwd: repo, stdio: 'ignore' })

    runner.reply(task.id, 'continue')
    await until(() => loadTask(repo, task.id)?.turns.length === 2)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    // The branch is still adopted — that is where the conversation's own work
    // is — but the anchor cannot catch what landed after it: foreign commits
    // sit INSIDE baseline..HEAD, so the review would sign them as the agent's.
    const second = loadTask(repo, task.id)
    expect(second?.branch).toBe(branch)
    expect(second?.baseline_sha).toBe(first?.baseline_sha ?? '')
    const notice = readTaskEvents(repo, task.id).find((e) => 'foreign_commits' in e.data)
    expect(notice?.data.foreign_commits).toBe(3)
    expect(String(notice?.data.text)).toContain('from outside this conversation')
    expect(String(notice?.data.text)).toContain(branch)
    // And the tip it now remembers is the one it actually found.
    expect(second?.head_sha).toBe(tryGit(['rev-parse', 'HEAD'], second?.worktree ?? '') ?? '')
  })

  test('a branch whose ref survives but whose object does not is re-forked, not fatal', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'dangling ref', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'codex exec -',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'turn done', ['agent.txt']).run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const first = loadTask(repo, task.id)
    const branch = first?.branch ?? ''

    rmSync(first?.worktree ?? '', { recursive: true, force: true })
    execFileSync('git', ['worktree', 'prune'], { cwd: repo })
    // A partial clone, an interrupted fetch, a corrupted object store: the REF
    // is still there and resolves, the commit it names is not. `rev-parse
    // --verify` answers for the ref and says yes — which is exactly why the
    // gate has to peel to a commit before trusting it.
    const dangling = 'dead'.repeat(10)
    writeFileSync(join(repo, '.git', 'refs', 'heads', `${branch}`), `${dangling}\n`)
    expect(tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo)).toBe(
      dangling,
    )

    runner.reply(task.id, 'continue')
    await until(() => loadTask(repo, task.id)?.turns.length === 2)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    // The conversation survives — re-forked and out loud — instead of dying on
    // a raw, locale-dependent git error with no reason code and no Resume.
    expect(status(repo, task.id)).toBe('waiting_for_you')
    const notice = readTaskEvents(repo, task.id).find((e) =>
      String(e.data.text).includes('FRESH fork'),
    )
    expect(String(notice?.data.text)).toContain('no longer exists')
    expect(readTaskEvents(repo, task.id).some((e) => e.type === 'error')).toBe(false)
  })

  test('a rebuild that CANNOT take its branch back re-forks, and names what it leaves', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'branch taken', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'codex exec -',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'turn done', ['agent.txt']).run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const first = loadTask(repo, task.id)

    // The worktree is gone AND somebody checked the branch out elsewhere: git
    // will not hand it over, so a fresh fork is the only way to keep going.
    rmSync(first?.worktree ?? '', { recursive: true, force: true })
    // The registration of the deleted directory still claims the branch: drop
    // it, exactly as a `git worktree prune` from any other tool would.
    execFileSync('git', ['worktree', 'prune'], { cwd: repo })
    const squatter = join(mkdtempSync(join(tmpdir(), 'codesema-squatter-')), 'wt')
    cleanups.push(squatter)
    execFileSync('git', ['worktree', 'add', squatter, first?.branch ?? ''], {
      cwd: repo,
      stdio: 'ignore',
    })

    runner.reply(task.id, 'continue')
    await until(() => loadTask(repo, task.id)?.turns.length === 2)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    const second = loadTask(repo, task.id)
    expect(second?.branch).not.toBe(first?.branch ?? '')
    // New lineage, new anchor: keeping the old one would credit the agent with
    // whatever the base gained meanwhile.
    expect(second?.baseline_sha).toBe(
      execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: repo }).toString().trim(),
    )
    // And the work left behind is NAMED — branch and commit count — instead of
    // being left for the human to discover from a diff that lost a turn.
    const notice = readTaskEvents(repo, task.id).find((e) => 'stranded_branch' in e.data)
    expect(notice?.data.stranded_branch).toBe(first?.branch ?? '')
    expect(notice?.data.stranded_commits).toBe(1)
    expect(String(notice?.data.text)).toContain('FRESH fork')
    expect(String(notice?.data.text)).toContain(first?.branch ?? '')
    // Nothing was deleted: the commits are still reachable from that branch.
    expect(refExists(`refs/heads/${first?.branch}`, repo)).toBe(true)
    execFileSync('git', ['worktree', 'remove', '--force', squatter], { cwd: repo, stdio: 'ignore' })
  })

  test('a rebuild whose branch was DELETED re-forks, and says the branch is gone', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'branch deleted', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'codex exec -',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'turn done', ['agent.txt']).run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const first = loadTask(repo, task.id)

    rmSync(first?.worktree ?? '', { recursive: true, force: true })
    execFileSync('git', ['worktree', 'prune'], { cwd: repo })
    execFileSync('git', ['branch', '-D', first?.branch ?? ''], { cwd: repo, stdio: 'ignore' })

    runner.reply(task.id, 'continue')
    await until(() => loadTask(repo, task.id)?.turns.length === 2)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    // Nothing to strand — the branch itself is gone, and the freed name is
    // taken again — but the conversation still says it was re-forked and that
    // the earlier turns' commits are not in this worktree. That is the part
    // nobody can guess, and it is said whether or not the base moved.
    const notice = readTaskEvents(repo, task.id).find((e) =>
      String(e.data.text).includes('FRESH fork'),
    )
    expect(String(notice?.data.text)).toContain('no longer exists')
    expect(String(notice?.data.text)).toContain(first?.branch ?? '')
  })

  test('a fork records that it created its branch; a work-on adoption does not', async () => {
    const repo = makeRepo()
    execFileSync('git', ['branch', 'feature/theirs'], { cwd: repo })
    const forked = makeTask(repo, 'forking', 'work')
    const adopted = createTask(repo, {
      title: 'adopting',
      prompt: 'work',
      autoShip: false,
      base: 'main',
      branch: 'feature/theirs',
      worktree: '',
      workOn: true,
    })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: fakeClaude(() => 'done').run,
    })

    runner.start(forked)
    await until(() => status(repo, forked.id) === 'waiting_for_you')
    runner.start(adopted)
    await until(() => status(repo, adopted.id) === 'waiting_for_you')

    expect(loadTask(repo, forked.id)?.created_branch).toBe(true)
    // Absent, not false: the branch was already there, so it is not ours to delete.
    expect('created_branch' in (loadTask(repo, adopted.id) ?? {})).toBe(false)
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

  test("a record with its own agent runs that CLI and that CLI's egress", async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'caged', 'do it', 'container')
    task.agent = 'opencode run'
    const cage = fakeCage()
    await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'do it',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: () => {},
      allowedDomains: ['api.anthropic.com', 'platform.claude.com'],
      runContainerTurnFn: cage.run,
    })
    const call = cage.calls[0]
    expect(call?.command).toContain('opencode')
    expect(call?.command).not.toContain('claude')
    expect(call?.allowedDomains).toEqual(['opencode.ai', 'models.opencode.ai'])
  })

  test('a project-pinned allowlist wins over the task agent', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'caged', 'do it', 'container')
    task.agent = 'opencode run'
    const cage = fakeCage()
    await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'do it',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: () => {},
      allowedDomains: ['npm.acme-internal.example'],
      pinAllowedDomains: true,
      runContainerTurnFn: cage.run,
    })
    expect(cage.calls[0]?.allowedDomains).toEqual(['npm.acme-internal.example'])
  })

  test('getChecksConfig is re-read at the turn and wins over the snapshot (T1.4)', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'caged', 'do it', 'container')
    const cage = fakeCage()
    let image = 'stale'
    await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'do it',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: () => {},
      checksConfig: { image: 'stale' },
      getChecksConfig: () => ({ image }),
      runContainerTurnFn: cage.run,
    })
    expect(cage.calls[0]?.checksConfig?.image).toBe('stale')
    image = 'fresh'
    await runTaskTurn({
      cwd: repo,
      task,
      prompt: 'do it',
      command: 'claude -p',
      timeoutMs: 1000,
      onEvent: () => {},
      checksConfig: { image: 'stale' },
      getChecksConfig: () => ({ image }),
      runContainerTurnFn: cage.run,
    })
    expect(cage.calls[1]?.checksConfig?.image).toBe('fresh')
  })

  test('getChecksConfig returning null does not fall back on the snapshot (T1.4)', async () => {
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
      checksConfig: { image: 'stale' },
      getChecksConfig: () => null,
      runContainerTurnFn: cage.run,
    })
    expect(cage.calls[0]?.checksConfig).toBeNull()
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

  // I2 (adversarial review, mineur). `runTaskTurn`'s own getter is proven
  // twice above, and the manager is proven to BUILD a `getChecksConfig` —
  // but the link between them, inside `createTaskRunner`, was not: replacing
  // `opts.getChecksConfig ? … : opts.checksConfig` with `opts.checksConfig`
  // left the suite green while the cage of EVERY production turn lost its
  // base-image config in silence (task-server passes ONLY the getter).
  test('createTaskRunner re-reads getChecksConfig per turn, with no snapshot behind it (T1.4)', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'caged', 'do it', 'container')
    const calls: RunContainerTurnOptions[] = []
    let image = 'oven/bun:1'
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      // Exactly what task-server.ts passes: the getter, and nothing else.
      getChecksConfig: () => ({ image }),
      runContainerTurnFn: (options) => {
        calls.push(options)
        return Promise.resolve(claudeStream('done in the box'))
      },
    })
    expect(runner.start(task)).toEqual({ ok: true })
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(calls[0]?.checksConfig?.image).toBe('oven/bun:1')
    // A checks-apply between two turns lands without rebuilding the runner.
    image = 'node:26'
    expect(runner.reply(task.id, 'again')).toEqual({ ok: true })
    await until(() => calls.length === 2)
    expect(calls[1]?.checksConfig?.image).toBe('node:26')
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
    // finishTurn folds the cost and THEN goes on to commit, review and
    // persist; anything throwing there sends the very same attempt into
    // failTurn through the promise chain's .catch. Without the marker on the
    // attempt, the same figure is folded twice — and since the fold is
    // additive, the turn (and the record total derived from it) doubles.
    //
    // The lever is a reviewer that blows up in a way finishTurn's own error
    // handler cannot even render, so the throw escapes it. (A throwing
    // broadcast listener no longer works as one: T1.2 contains those on
    // purpose — see 'a listener that throws never leaks the claim'.)
    class Unrenderable extends Error {
      override get message(): string {
        throw new Error('reviewer blew up beyond repair')
      }
    }
    let reviewed = false
    let broadcasts = 0
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: runWithUsage('claude-opus-5', { input_tokens: 1_000 }).run,
      onTurnDone: () => {
        reviewed = true
        throw new Unrenderable()
      },
      onTask: (broadcast) => {
        broadcasts++
        // The 'reviewing' frame is finishTurn's own persist, after accrueCost
        // has run: the cost is already on the record when the throw happens.
        if (broadcast.status === 'reviewing') {
          expect(broadcast.cost_ticks).toBe(OPUS5_BOUND(1_000))
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
    expect(reviewed).toBe(true)
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
