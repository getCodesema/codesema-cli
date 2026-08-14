// T8 process-lifecycle coverage: graceful shutdown drains the runner and
// persists 'interrupted' {reason:'shutdown'} while KEEPING worktrees, an
// interrupted task is replyable (that is the resume path), and abandon is the
// one destructive exit (worktree + branch deleted) — refused while an agent
// still works in the worktree. Real git repos in tmpdirs, injected agents.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentRunOptions } from './agent.js'
import type { TaskRecord, TaskStatus } from './contract.js'
import { tryGit } from './git.js'
import { createTaskRunner } from './task-runner.js'
import { createTask, loadTask, readTaskEvents, saveTask } from './tasks-store.js'

const cleanups: string[] = []

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'codesema-lifecycle-'))
  cleanups.push(repo)
  const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  run(['init', '-b', 'main'])
  run(['config', 'user.email', 't@t'])
  run(['config', 'user.name', 't'])
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repo, stdio: 'ignore' })
  return repo
}

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

const branchExists = (repo: string, branch: string): boolean =>
  tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo) !== null

const jsonl = (events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`

/** Minimal claude stream-json: init (session capture) + final result text. */
const claudeStream = (response: string, sessionId = 'sess-123') =>
  jsonl([
    { type: 'system', subtype: 'init', session_id: sessionId },
    { type: 'result', result: response },
  ])

/**
 * Question-only agent: every turn ends in a QUESTION so tasks always land on
 * 'waiting_for_you' without entering T4's done-turn review path.
 */
function questionAgent(question = 'what next?') {
  const seen = { commands: [] as string[], prompts: [] as string[] }
  const run = (options: AgentRunOptions): Promise<string> => {
    seen.commands.push(options.command)
    seen.prompts.push(options.prompt)
    const raw = claudeStream(`Blocked.\nQUESTION: ${question}`)
    options.onText?.(raw)
    return Promise.resolve(raw)
  }
  return { seen, run }
}

/** Agent that never resolves until its abort signal fires (a SIGTERMed run). */
const hangingAgent = (options: AgentRunOptions): Promise<string> =>
  new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('agent interrupted')))
  })

// --- shutdown --------------------------------------------------------------

describe('runner shutdown', () => {
  test('aborts running agents, interrupts queued tasks, keeps worktrees and branches', async () => {
    const repo = makeRepo()
    const running = makeTask(repo, 'in flight', 'long work')
    const queued = makeTask(repo, 'still queued', 'later work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 60_000,
      maxParallel: 1,
      runAgentFn: hangingAgent,
    })
    expect(runner.start(running)).toEqual({ ok: true })
    await until(() => status(repo, running.id) === 'running')
    expect(runner.start(queued)).toEqual({ ok: true })
    expect(status(repo, queued.id)).toBe('queued')

    await runner.shutdown()

    // Once shutdown resolves, everything is already persisted: no polling.
    const interrupted = loadTask(repo, running.id)
    expect(interrupted?.status).toBe('interrupted')
    expect(interrupted?.turns[0]?.ended_at).not.toBeNull()
    const event = readTaskEvents(repo, running.id).find((e) => e.type === 'interrupted')
    expect(event?.data).toEqual({ reason: 'shutdown' })
    // Worktree AND branch survive: an interrupted task must be resumable.
    expect(existsSync(interrupted?.worktree ?? '')).toBe(true)
    expect(branchExists(repo, interrupted?.branch ?? '')).toBe(true)

    // The queued task never ran, but 'queued' with no live process would be
    // unstartable at next boot: it is interrupted too, with the same reason.
    expect(status(repo, queued.id)).toBe('interrupted')
    expect(readTaskEvents(repo, queued.id).map((e) => ({ type: e.type, data: e.data }))).toEqual([
      { type: 'interrupted', data: { reason: 'shutdown' } },
    ])
    expect(runner.runningCount()).toBe(0)
  })

  test('start and reply are refused while draining', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'late arrival', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: questionAgent().run,
    })
    await runner.shutdown()
    expect(runner.start(task)).toEqual({ ok: false, code: 409, error: 'shutting down' })
    expect(runner.reply(task.id, 'hello')).toEqual({ ok: false, code: 409, error: 'shutting down' })
  })
})

// --- resume: reply on an interrupted task ----------------------------------

describe('reply on an interrupted task', () => {
  test('resumes the stored claude session with --resume', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'resumable', 'start work')
    const agent = questionAgent()
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: agent.run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(runner.interrupt(task.id)).toEqual({ ok: true })
    expect(status(repo, task.id)).toBe('interrupted')

    // The 409 of T3 is lifted for 'interrupted': reply IS the resume gesture.
    expect(runner.reply(task.id, 'please continue')).toEqual({ ok: true })
    await until(
      () =>
        loadTask(repo, task.id)?.turns.length === 2 && status(repo, task.id) === 'waiting_for_you',
    )
    // Turn 2 resumed the session captured before the interruption — no fresh
    // worktree either: the surviving one is reused (single worktree per task).
    expect(agent.seen.commands[1]).toContain('--resume sess-123')
    expect(agent.seen.prompts[1]).toBe('please continue')
    const record = loadTask(repo, task.id)
    expect(record?.turns[1]?.response).toContain('Blocked.')
  })

  test('a task interrupted before its first run replays the transcript (no session)', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'never ran', 'initial instruction')
    // Simulate a shutdown that caught the task while still queued.
    const seeded = loadTask(repo, task.id)!
    seeded.status = 'interrupted'
    saveTask(repo, seeded)

    const prompts: string[] = []
    const runner = createTaskRunner({
      cwd: repo,
      command: 'codex exec -',
      timeoutMs: 1000,
      runAgentFn: (options) => {
        prompts.push(options.prompt)
        return Promise.resolve('resumed fine\nQUESTION: keep going?')
      },
    })
    expect(runner.reply(task.id, 'yes, do it')).toEqual({ ok: true })
    await until(() => status(repo, task.id) === 'waiting_for_you')
    // No provider session to resume: the transcript replay carries turn 1.
    expect(prompts[0]).toContain('Previous turns of this task:')
    expect(prompts[0]).toContain('initial instruction')
    expect(prompts[0]).toContain('New instruction: yes, do it')
  })

  test('time spent interrupted counts as neither work nor wait', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'timed', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: questionAgent().run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    runner.interrupt(task.id)
    const waitBefore = loadTask(repo, task.id)!.wait_ms
    await new Promise((resolve) => setTimeout(resolve, 30))
    runner.reply(task.id, 'go on')
    await until(
      () =>
        loadTask(repo, task.id)?.turns.length === 2 && status(repo, task.id) === 'waiting_for_you',
    )
    // The 30ms parked on 'interrupted' was not accrued into wait_ms.
    expect(loadTask(repo, task.id)!.wait_ms).toBe(waitBefore)
  })
})

// --- abandon ---------------------------------------------------------------

describe('abandon', () => {
  test('refused while running; allowed once interrupted, deleting worktree AND branch', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'doomed', 'work forever')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 60_000,
      runAgentFn: hangingAgent,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'running')
    expect(runner.abandon(task.id)).toEqual({ ok: false, code: 409, error: 'task is running' })

    runner.interrupt(task.id)
    await until(() => status(repo, task.id) === 'interrupted')
    const { worktree, branch } = loadTask(repo, task.id)!
    expect(existsSync(worktree)).toBe(true)
    expect(branchExists(repo, branch)).toBe(true)

    expect(runner.abandon(task.id)).toEqual({ ok: true })
    expect(existsSync(worktree)).toBe(false)
    expect(branchExists(repo, branch)).toBe(false)
    const record = loadTask(repo, task.id)
    expect(record?.status).toBe('failed')
    const last = readTaskEvents(repo, task.id).at(-1)
    expect(last).toMatchObject({
      type: 'error',
      data: { message: 'worktree removed, task abandoned' },
    })
  })

  test('abandons a waiting task with uncommitted agent changes in the worktree', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'half done', 'write stuff')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      // A question turn leaves the worktree dirty (question turns never commit).
      runAgentFn: (options) => {
        writeFileSync(join(options.cwd, 'dirty.txt'), 'wip\n')
        const raw = claudeStream('half way.\nQUESTION: continue?')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const { worktree, branch } = loadTask(repo, task.id)!
    expect(runner.abandon(task.id)).toEqual({ ok: true })
    // --force removal: dirty files do not save a worktree from an abandon.
    expect(existsSync(worktree)).toBe(false)
    expect(branchExists(repo, branch)).toBe(false)
    expect(status(repo, task.id)).toBe('failed')
  })

  test('guard rails: unknown id, reviewing task, and a never-started task', () => {
    const repo = makeRepo()
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: questionAgent().run,
    })
    expect(runner.abandon('aaaaaaaaaaaa')).toMatchObject({ ok: false, code: 404 })

    // 'reviewing' means T4's review agent still works in the worktree.
    const reviewing = makeTask(repo, 'under review', 'work')
    const seeded = loadTask(repo, reviewing.id)!
    seeded.status = 'reviewing'
    saveTask(repo, seeded)
    expect(runner.abandon(reviewing.id)).toEqual({
      ok: false,
      code: 409,
      error: 'task is reviewing',
    })

    // A queued task never got a worktree: abandon still lands on 'failed'.
    const fresh = makeTask(repo, 'never started', 'work')
    expect(runner.abandon(fresh.id)).toEqual({ ok: true })
    expect(status(repo, fresh.id)).toBe('failed')
  })
})

// Cleanup of a SHIPPED task is housekeeping, never a discard: the status must
// keep saying the work made it out.
test('abandoning a shipped task keeps the shipped status', async () => {
  const repo = makeRepo()
  const task = makeTask(repo, 'shipped one', 'do work')
  const runner = createTaskRunner({
    cwd: repo,
    command: 'claude -p',
    timeoutMs: 1000,
    runAgentFn: () => Promise.resolve('done'),
  })
  runner.start(loadTask(repo, task.id)!)
  await until(() => ['waiting_for_you', 'review_ok'].includes(status(repo, task.id) ?? ''))
  const shippedRecord = loadTask(repo, task.id)!
  shippedRecord.status = 'shipped'
  saveTask(repo, shippedRecord)

  expect(runner.abandon(task.id)).toEqual({ ok: true })
  const after = loadTask(repo, task.id)
  expect(after?.status).toBe('shipped')
  expect(existsSync(after!.worktree)).toBe(false)
})
