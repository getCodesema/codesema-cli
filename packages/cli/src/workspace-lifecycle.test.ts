// T8 process-lifecycle coverage: graceful shutdown drains the turns IN FLIGHT
// and persists 'interrupted' {reason:'shutdown'} while KEEPING worktrees —
// the QUEUED tasks are left queued (T1.2: their place lives in
// <repo>/.codesema/queue.json and a rebuilt runner picks them back up) —, an
// interrupted task is replyable AND resumable (resume() re-runs the turn that
// died, in place, with no new instruction), and abandon is the one
// destructive exit (worktree + branch deleted) — refused while an agent still
// works in the worktree. Real git repos in tmpdirs, injected agents.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { AgentRunOptions } from './agent.js'
import { saveGlobalConfig, saveRepoConfig } from './config.js'
import type { TaskRecord, TaskStatus } from './contract.js'
import { tryGit } from './git.js'
import { projectIdFor } from './projects.js'
import {
  activeTask,
  nodeTaskQueueIo,
  queuePath,
  readQueue,
  resetActiveClaims,
  resetQueueDegradedReports,
  type TaskQueueIo,
} from './task-queue.js'
import { createTaskRunner, DRAIN_NOTICE_MS, DRAIN_TIMEOUT_MS } from './task-runner.js'
import { createTask, loadTask, readTaskEvents, resetStoreReports, saveTask } from './tasks-store.js'
import {
  bootNotices,
  invalidLoadCapKeyNotice,
  logIsolation,
  maxParallelNotice,
  resolveMaxConcurrentAgents,
  workspaceTaskManagerOptions,
} from './workspace.js'

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
  test('aborts running agents, LEAVES queued tasks queued, keeps worktrees and branches', async () => {
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
    // The gesture answers with the place it got in the line, no round-trip.
    expect(runner.start(queued)).toEqual({ ok: true, queue_position: 1 })
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

    // T1.2: the queued task never ran and is NOT sacrificed — its place is on
    // disk, so the next boot re-hydrates the queue and starts it. Nothing is
    // written on it at all: no status change, no journal line.
    expect(status(repo, queued.id)).toBe('queued')
    expect(readQueue(repo).entries.map((e) => e.id)).toEqual([queued.id])
    expect(readTaskEvents(repo, queued.id).filter((e) => e.type === 'interrupted')).toHaveLength(0)
    expect(runner.runningCount()).toBe(0)
  })

  test('shutdown names the degradation of the turn IN FLIGHT: interrupted_by_user beside an untouched payload', async () => {
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
    runner.start(running)
    await until(() => status(repo, running.id) === 'running')
    runner.start(queued)

    await runner.shutdown()

    const event = readTaskEvents(repo, running.id).find((e) => e.type === 'interrupted')
    // The code is ADDED: it rides in its own field, and the readable payload
    // the journal has always carried is byte-for-byte what it was.
    expect(event?.reason_code).toBe('interrupted_by_user')
    expect(event?.data).toEqual({ reason: 'shutdown' })
    // The record restates it, with that same message in detail.
    expect(loadTask(repo, running.id)?.reason).toEqual({
      code: 'interrupted_by_user',
      detail: 'shutdown',
    })
    // The queued one is untouched by the drain, so it keeps the ONLY reason it
    // ever had: it is waiting for its project's active slot.
    expect(loadTask(repo, queued.id)?.reason).toEqual({
      code: 'resource_busy',
      detail: 'another task of this project is already active',
    })
  })

  test('the queued tasks survive a rebuild, in order, and start on their own', async () => {
    const repo = makeRepo()
    const running = makeTask(repo, 'in flight', 'long work')
    const firstWaiting = makeTask(repo, 'waiting one', 'later work')
    const secondWaiting = makeTask(repo, 'waiting two', 'even later work')
    const dying = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 60_000,
      runAgentFn: hangingAgent,
    })
    dying.start(running)
    await until(() => status(repo, running.id) === 'running')
    dying.start(firstWaiting)
    dying.start(secondWaiting)

    await dying.shutdown()
    // shutdown() frees the project's admission claim by itself — no test
    // crutch: the aborted turn's promise chain releases it before shutdown
    // resolves, which is exactly what lets a rebuilt runner admit anything.
    expect(activeTask(projectIdFor(repo))).toBeNull()

    expect(status(repo, firstWaiting.id)).toBe('queued')
    expect(status(repo, secondWaiting.id)).toBe('queued')
    expect(readQueue(repo).entries.map((e) => e.id)).toEqual([firstWaiting.id, secondWaiting.id])

    // "Reconstruction du manager": a new runner on the same repo, nothing else.
    const reborn = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: questionAgent().run,
    })
    // Head first, then the second — FIFO across the restart, no human gesture.
    await until(() => status(repo, firstWaiting.id) === 'waiting_for_you')
    await until(() => status(repo, secondWaiting.id) === 'waiting_for_you')
    expect(readQueue(repo).entries).toEqual([])
    expect(reborn.runningCount()).toBe(0)
    // The interrupted turn is NOT restarted by the queue: only a human gesture
    // moves it (T8), and it was never in the file.
    expect(status(repo, running.id)).toBe('interrupted')
  })

  test('a restarted turn drops the reason it stopped for: no stale claim', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'stopped then resumed', 'work')
    const agent = questionAgent()
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 60_000,
      maxParallel: 1,
      runAgentFn: agent.run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(runner.interrupt(task.id)).toEqual({ ok: true })
    expect(loadTask(repo, task.id)?.reason).toEqual({ code: 'interrupted_by_user' })

    expect(runner.reply(task.id, 'carry on')).toEqual({ ok: true })
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id)
    expect(record && 'reason' in record).toBe(false)
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

// --- the admission claim: held for the whole active window, never leaked ---

describe('the admission claim', () => {
  test('a listener that throws never leaks the claim: the project keeps admitting tasks', async () => {
    const repo = makeRepo()
    const first = makeTask(repo, 'first', 'task one')
    const second = makeTask(repo, 'second', 'task two')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      // Exactly what a broken SSE subscriber looks like from in here. It used
      // to travel back up through persist() and out of launch(), leaving the
      // claim taken FOREVER — the project never started anything again.
      onTask: () => {
        throw new Error('subscriber blew up')
      },
      onEvent: () => {
        throw new Error('subscriber blew up')
      },
      runAgentFn: questionAgent().run,
    })
    // Contained is not hidden: the frames those listeners dropped are a
    // degradation, and invariant 2 forbids the silent kind.
    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '))
    }
    try {
      expect(runner.start(first)).toEqual({ ok: true })
      await until(() => status(repo, first.id) === 'waiting_for_you')
      expect(activeTask(projectIdFor(repo))).toBeNull()

      // The proof: a second task still gets in.
      expect(runner.start(second)).toEqual({ ok: true })
      await until(() => status(repo, second.id) === 'waiting_for_you')
    } finally {
      console.warn = realWarn
    }
    expect(warnings.some((line) => line.includes('subscriber blew up'))).toBe(true)
    expect(warnings.some((line) => line.includes('listener'))).toBe(true)
  })

  test('a turn that cannot even materialize its worktree does NOT fail the task: it stays queued', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'no such base', 'work')
    // A base that does not exist anywhere: createTaskWorktree throws, and the
    // turn never starts. A turn that never started is not a failed turn.
    const seeded = loadTask(repo, task.id)!
    seeded.base = 'branch-that-never-existed'
    saveTask(repo, seeded)

    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: questionAgent().run,
    })
    // Admitted: the claim is taken and a turn is being set up. Whether the
    // worktree can be had is only known once the repo's worktree lock has been
    // waited for, so the verdict lands a tick later — not in this answer.
    expect(runner.start(task)).toEqual({ ok: true })
    await until(() => activeTask(projectIdFor(repo)) === null)

    // Still queued, still IN the line, and the claim is back — a boot that
    // turned this into 'failed' would have destroyed the queue in cascade.
    expect(status(repo, task.id)).toBe('queued')
    expect(readQueue(repo).entries.map((e) => e.id)).toEqual([task.id])
    expect(activeTask(projectIdFor(repo))).toBeNull()
    // The reason is on the record's journal, retryable rather than terminal.
    const error = readTaskEvents(repo, task.id).find((e) => e.type === 'error')
    expect(error?.data.message).toContain('branch-that-never-existed')
    expect(runner.runningCount()).toBe(0)
  })

  test('a task that cannot materialize steps ASIDE: it never starves the line behind it', async () => {
    const repo = makeRepo()
    const stuck = makeTask(repo, 'stuck', 'work')
    const behind = makeTask(repo, 'behind', 'work later')
    const seeded = loadTask(repo, stuck.id)!
    seeded.base = 'branch-that-never-existed'
    saveTask(repo, seeded)

    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: questionAgent().run,
    })
    runner.start(stuck)
    // Named once, and named as a machine can read it. (The materialization
    // waits for the repo's worktree lock, so the verdict lands a tick later.)
    const failures = () => readTaskEvents(repo, stuck.id).filter((e) => e.type === 'error')
    await until(() => failures().length === 1)
    expect(failures()[0]?.reason_code).toBe('agent_error')
    // NOT failed: a turn that never started is not a failed turn.
    expect(status(repo, stuck.id)).toBe('queued')

    // The whole point: the healthy task behind it runs. On develop the stuck
    // one would have held the project hostage until the process restarted —
    // and a restart would not have helped either.
    runner.start(behind)
    await until(() => status(repo, behind.id) === 'waiting_for_you')
    // The stuck one keeps its place in the file, and its journal did NOT grow
    // a second copy of the same error: one line per session, not one per pump.
    expect(readQueue(repo).entries.map((e) => e.id)).toEqual([stuck.id])
    expect(failures()).toHaveLength(1)

    // Its record says WHY it waits, and it does not claim to be behind an
    // active task — there is none.
    const waiting = loadTask(repo, stuck.id)!
    expect(waiting.reason?.code).toBe('agent_error')
    expect(waiting.reason?.detail).toContain('branch-that-never-existed')

    // Nothing retries it on its own — that is the point of stepping aside.
    // But a human CAN: starting it again is the retry gesture, and it is
    // accepted rather than refused with "already started" (the refusal that
    // used to leave no way back in at all). It is attempted, and journaled,
    // again — because a human asked for it.
    expect(runner.start(loadTask(repo, stuck.id)!).ok).toBe(true)
    await until(() => failures().length === 2)
    expect(status(repo, stuck.id)).toBe('queued')
    expect(readQueue(repo).entries.map((e) => e.id)).toEqual([stuck.id])

    // The other way out: a human takes it off the line for good.
    expect(runner.interrupt(stuck.id)).toEqual({ ok: true })
    expect(readQueue(repo).entries).toEqual([])
    expect(status(repo, stuck.id)).toBe('interrupted')

    // And once off the line, Resume goes through the ordinary door.
    const resumed = runner.resume(stuck.id)
    expect(resumed.ok).toBe(true)
    await until(() => failures().length === 3)
  })

  test('Stop on the ACTIVE task gives its claim back, and the next one starts', async () => {
    const repo = makeRepo()
    const running = makeTask(repo, 'running', 'work')
    const next = makeTask(repo, 'next', 'work later')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 60_000,
      runAgentFn: hangingAgent,
    })
    runner.start(running)
    await until(() => status(repo, running.id) === 'running')
    runner.start(next)
    expect(activeTask(projectIdFor(repo))).toBe(running.id)

    expect(runner.interrupt(running.id)).toEqual({ ok: true })
    // The claim moves on with the line: the next task takes it over.
    await until(() => status(repo, next.id) === 'running')
    expect(activeTask(projectIdFor(repo))).toBe(next.id)
    expect(readQueue(repo).entries).toEqual([])
  })

  test('the claim covers the REVIEW too: the next task waits for the verdict, not for the turn', async () => {
    const repo = makeRepo()
    const first = makeTask(repo, 'first', 'task one')
    const second = makeTask(repo, 'second', 'task two')
    let releaseReview: () => void = () => {}
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve
    })
    const reviewsInFlight: string[] = []
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: (options) => {
        // 'done' (no QUESTION): this is the path that goes through the review.
        const raw = claudeStream('all done')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
      onTurnDone: async (record, io) => {
        reviewsInFlight.push(record.id)
        await reviewGate
        record.status = 'review_ok'
        io.persist()
      },
    })
    runner.start(first)
    runner.start(second)
    await until(() => status(repo, first.id) === 'reviewing')

    // The review of the first is in flight, and 'reviewing' IS an active
    // status (isActiveTaskStatus): the second must not have started.
    expect(reviewsInFlight).toEqual([first.id])
    expect(status(repo, second.id)).toBe('queued')
    expect(activeTask(projectIdFor(repo))).toBe(first.id)

    releaseReview()
    await until(() => status(repo, second.id) !== 'queued')
    expect(reviewsInFlight).toEqual([first.id, second.id])
  })

  test('Ctrl-C during a review waits for it instead of orphaning the review agent', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'under review', 'work')
    let releaseReview: () => void = () => {}
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve
    })
    let reviewSettled = false
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: (options) => {
        const raw = claudeStream('all done')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
      onTurnDone: async (record, io) => {
        await reviewGate
        reviewSettled = true
        record.status = 'review_ok'
        io.persist()
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'reviewing')

    const draining = runner.shutdown()
    // Not settled yet: shutdown is genuinely waiting on the review.
    expect(reviewSettled).toBe(false)
    releaseReview()
    await draining

    // Once shutdown resolves the review has landed on disk — no agent left
    // running under a process that is about to exit.
    expect(reviewSettled).toBe(true)
    expect(status(repo, task.id)).toBe('review_ok')
    expect(activeTask(projectIdFor(repo))).toBeNull()
  })

  // T1.2 re-review, MAJOR 2: `reason` is the machine-readable surface T1.1
  // built. It must never claim a cause that is not the real one.
  test('a waiting task names the TRUE cause: busy when busy, the failure when nothing runs', async () => {
    const repo = makeRepo()
    const running = makeTask(repo, 'running', 'work')
    const behind = makeTask(repo, 'behind', 'work later')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 60_000,
      runAgentFn: hangingAgent,
    })
    runner.start(running)
    await until(() => status(repo, running.id) === 'running')
    runner.start(behind)

    // Something IS active: "another task of this project is already active"
    // is exactly true, and waiting is what fixes it.
    const waiting = loadTask(repo, behind.id)!
    expect(waiting.reason?.code).toBe('resource_busy')
    expect(waiting.reason?.detail).toBe('another task of this project is already active')
    // And the two gestures a human can aim at it refuse it for what it IS.
    // 'task is running' was the old answer to both, on a task whose turn had
    // never started — a refusal that describes the wrong state sends the
    // reader looking for a Stop button that would do nothing.
    expect(runner.reply(behind.id, 'anything')).toEqual({
      ok: false,
      code: 409,
      error: 'task is queued',
    })
    expect(runner.resume(behind.id)).toEqual({
      ok: false,
      code: 409,
      error: 'task is queued',
    })

    // Nothing active, the task simply cannot materialize: the SAME sentence
    // would have been a lie (it was, before this fix) — and the API answered
    // {ok:true} on top of it.
    const alone = makeRepo()
    const stuck = makeTask(alone, 'stuck', 'work')
    const seeded = loadTask(alone, stuck.id)!
    seeded.base = 'branch-that-never-existed'
    saveTask(alone, seeded)
    const lonely = createTaskRunner({
      cwd: alone,
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: questionAgent().run,
    })
    lonely.start(stuck)
    await until(() => activeTask(projectIdFor(alone)) === null)
    const blockedRecord = loadTask(alone, stuck.id)!
    expect(blockedRecord.reason?.code).toBe('agent_error')
    expect(blockedRecord.reason?.detail).toContain('branch-that-never-existed')
    await lonely.shutdown()
  })

  // T1.2 re-review, MAJOR 3: the claim covering the review is only safe if the
  // review can be CUT. Without a signal, shutdown() waited on the reviewer's
  // own timeout — up to 15 minutes of a terminal that looks hung.
  test('Ctrl-C CUTS a review instead of waiting out its timeout, and says what it waits for', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'under review', 'work')
    let sawSignal: AbortSignal | null = null
    const notices: string[][] = []
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      // A reviewer's real budget. Without a cut-off this is what a Ctrl-C
      // would have waited for.
      timeoutMs: 900_000,
      drainNoticeMs: 5,
      onDrainWait: (ids) => notices.push([...ids]),
      runAgentFn: (options) => {
        const raw = claudeStream('all done')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
      // A reviewer that only ever ends when it is cut — which is exactly what
      // a real review agent looks like from here. The small delay after the
      // abort is the agent dying: enough for the drain to have to say so.
      onTurnDone: (record, io) =>
        new Promise<void>((resolve) => {
          sawSignal = io.signal
          io.signal.addEventListener('abort', () => {
            setTimeout(() => {
              record.status = 'interrupted'
              io.persist()
              resolve()
            }, 40)
          })
        }),
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'reviewing')

    const started = Date.now()
    await runner.shutdown()
    // Immediate, not "after the review's 15-minute timeout".
    expect(Date.now() - started).toBeLessThan(3000)
    expect(sawSignal).not.toBeNull()
    expect(status(repo, task.id)).toBe('interrupted')
    expect(activeTask(projectIdFor(repo))).toBeNull()
    // And the wait was never mute: past the grace, it named what it waited on.
    expect(notices).toEqual([[task.id]])
  })

  test('a review that ignores the signal still leaves an INTERRUPTED task, never a false verdict', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'under review', 'work')
    let releaseReview: () => void = () => {}
    const reviewGate = new Promise<void>((resolve) => {
      releaseReview = resolve
    })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: (options) => {
        const raw = claudeStream('all done')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
      // Deaf to the signal, and it returns without settling the task: the
      // runner still refuses to leave it stranded on 'reviewing', which is
      // neither replyable nor interruptible.
      onTurnDone: async () => {
        await reviewGate
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'reviewing')

    const draining = runner.shutdown()
    releaseReview()
    await draining

    const settled = loadTask(repo, task.id)!
    expect(settled.status).toBe('interrupted')
    expect(settled.reason?.code).toBe('interrupted_by_user')
    // Literal, not `toBe(REVIEW_CUT_DETAIL)`: a detail compared to the very
    // constant that produced it proves the plumbing and nothing about the
    // sentence, and this one is what a human reads on the card.
    expect(settled.reason?.detail).toBe('the end-of-turn review was stopped by the shutdown')
    // And it is JOURNALED, like every other interruption: a status that moves
    // without a line in events.jsonl is the silence invariant 2 forbids, and
    // this belt-and-braces path was the only transition still missing one.
    const last = readTaskEvents(repo, task.id).at(-1)
    expect(last?.type).toBe('interrupted')
    expect(last?.reason_code).toBe('interrupted_by_user')
    expect(last?.data.reason).toBe('shutdown')
  })

  // T1.2 re-review round 9: every drain test above injects drainNoticeMs and
  // drainTimeoutMs, so the seams are proven and the PRODUCTION numbers were
  // held by nothing at all — 30 s could become an hour and the suite would
  // stay green while a Ctrl-C hung for that hour. Same treatment as
  // QUEUE_ENTRIES_MAX and QUEUE_BROADCAST_MAX: the value a user actually gets
  // is pinned to a literal, and the ORDER between the two is an invariant in
  // its own right — announcing the wait after giving up on it would be
  // useless.
  test('the drain budgets a user actually gets are the ones documented', () => {
    expect(DRAIN_NOTICE_MS).toBe(1_000)
    expect(DRAIN_TIMEOUT_MS).toBe(30_000)
    // Say what you are waiting for well before you stop waiting for it.
    expect(DRAIN_NOTICE_MS).toBeLessThan(DRAIN_TIMEOUT_MS)
  })

  // T1.2 re-review round 4, MINOR 8: this pass made the drain await the whole
  // end-of-turn chain — review AND the auto-ship behind it, which takes no
  // signal. A Ctrl-C must still end.
  test('the drain has a hard ceiling: it stops waiting, and says that it stopped', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'never settles', 'work')
    const gaveUp: string[][] = []
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 900_000,
      drainNoticeMs: 5,
      drainTimeoutMs: 40,
      onDrainTimeout: (ids) => gaveUp.push([...ids]),
      runAgentFn: (options) => {
        const raw = claudeStream('all done')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
      // Deaf to the signal AND never returning: the shape of an auto-ship
      // pushing to a remote that does not answer.
      onTurnDone: () => new Promise<void>(() => {}),
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'reviewing')

    const started = Date.now()
    await runner.shutdown()
    expect(Date.now() - started).toBeLessThan(3000)
    // Never silently: it named what it walked away from.
    expect(gaveUp).toEqual([[task.id]])
  })

  // T1.2 re-review, MINOR 3: 'blocked' promises "the turn NEVER started". The
  // dequeue therefore happens BEFORE the record says 'running' — the other
  // order could leave a record on 'running' with no turn in flight, which is
  // neither interruptible nor resumable and a lie on the board.
  test('a queue it cannot dequeue from leaves the task QUEUED, never a phantom running one', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'stuck', 'work')
    let writes = 0
    const io: TaskQueueIo = {
      ...nodeTaskQueueIo,
      write: (path, value) => {
        writes += 1
        // The enqueue lands; the dequeue that follows the claim does not.
        if (writes > 1) {
          throw Object.assign(new Error('read-only file system'), { code: 'EROFS' })
        }
        nodeTaskQueueIo.write(path, value)
      },
    }
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      queueIo: io,
      runAgentFn: questionAgent().run,
    })
    expect(runner.start(task).ok).toBe(true)
    await until(() => activeTask(projectIdFor(repo)) === null)

    // Untouched by the failed launch: still queued, still in the file, and
    // the claim was handed back.
    expect(status(repo, task.id)).toBe('queued')
    expect(readQueue(repo).entries.map((e) => e.id)).toEqual([task.id])
    expect(activeTask(projectIdFor(repo))).toBeNull()
    const failures = readTaskEvents(repo, task.id).filter((e) => e.type === 'error')
    expect(failures).toHaveLength(1)
    // What it SAYS, not merely that it exists: the write refusal has to reach
    // the journal in words, with its D2 code beside it.
    expect(failures[0]?.reason_code).toBe('agent_error')
    expect(String(failures[0]?.data.message)).toContain('read-only file system')
    expect(loadTask(repo, task.id)?.reason?.detail).toContain('read-only file system')
    await runner.shutdown()
  })

  // T1.2 re-review round 4, MAJOR 1: the pump's queue read is the hottest
  // read-only path there is. It used to rename queue.json away on a single
  // unusable entry, so one bad line silently emptied the project's whole line.
  test('one unusable entry never costs the project its line: the rest still runs', async () => {
    const repo = makeRepo()
    const a = makeTask(repo, 'a', 'task a')
    const b = makeTask(repo, 'b', 'task b')
    const c = makeTask(repo, 'c', 'task c')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: async (options) => {
        if (options.prompt.includes('task a')) {
          await gate
        }
        const raw = claudeStream('done.\nQUESTION: next?')
        options.onText?.(raw)
        return raw
      },
    })
    runner.start(a)
    runner.start(b)
    runner.start(c)
    await until(() => status(repo, a.id) === 'running')

    // A line no reader can make sense of, slipped in among three good ones.
    writeFileSync(
      queuePath(repo),
      JSON.stringify({
        version: 1,
        entries: [
          { id: 'NOT-AN-ID!!', enqueued_at: '2026-01-01T00:00:00.000Z' },
          { id: b.id, enqueued_at: '2026-01-01T00:00:00.000Z' },
          { id: c.id, enqueued_at: '2026-01-01T00:00:00.000Z' },
        ],
      }),
    )

    // The head finishes: the pump reads the degraded file.
    release()
    await until(() => status(repo, b.id) === 'waiting_for_you')
    // …and C still runs after B. It used to stay 'queued' forever, out of a
    // file that no longer existed, while the only reason reported spoke of a
    // single lost entry.
    await until(() => status(repo, c.id) === 'waiting_for_you')
    expect(existsSync(queuePath(repo))).toBe(true)
  })

  // T1.2 re-review round 4, MAJOR 2: the fix of round 3 lived only in
  // schedule(). The boot pump goes through launch() and never through it.
  test('a task blocked AT BOOT stops claiming it is waiting behind an active one', async () => {
    const repo = makeRepo()
    const first = makeTask(repo, 'first', 'task one')
    const second = makeTask(repo, 'second', 'task two')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 60_000,
      runAgentFn: hangingAgent,
    })
    runner.start(first)
    await until(() => status(repo, first.id) === 'running')
    runner.start(second)
    // While something IS active, that is exactly what the record says.
    expect(loadTask(repo, second.id)?.reason?.code).toBe('resource_busy')

    // The session ends, and the branch the second one needs is gone.
    expect(runner.interrupt(first.id)).toEqual({ ok: true })
    await runner.shutdown()
    const seeded = loadTask(repo, second.id)!
    seeded.base = 'branch-that-never-existed'
    saveTask(repo, seeded)
    expect(seeded.reason?.code).toBe('resource_busy')

    // A fresh boot: the constructor's pump tries it, and cannot start it.
    const reborn = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: questionAgent().run,
    })
    // Nothing runs on this project at all… (the boot pump takes the claim, then
    // hands it straight back when the worktree will not materialize).
    await until(() => activeTask(projectIdFor(repo)) === null)
    // …so the record must not still be saying it waits behind an active task:
    // that stale sentence also armed the UI's "N conversations ahead" hint.
    const after = loadTask(repo, second.id)!
    expect(after.status).toBe('queued')
    expect(after.reason?.code).toBe('agent_error')
    expect(after.reason?.detail).toContain('branch-that-never-existed')
    await reborn.shutdown()
  })

  // T1.2 re-review round 4, MINOR 3: the sweep dropped stale ids ONE BY ONE,
  // each removal re-reading and rewriting the whole file synchronously on the
  // loop that serves HTTP — and firing a queue-changed broadcast each time,
  // which had the server re-read records and re-send frames per removal.
  test('a line full of dead ids is swept in ONE write and ONE broadcast', async () => {
    const repo = makeRepo()
    const alive = makeTask(repo, 'alive', 'real work')
    // Twenty ids nothing will ever resolve, ahead of the only live one.
    const dead = Array.from({ length: 20 }, (_, n) => (n + 1).toString(16).padStart(12, '0'))
    writeFileSync(
      queuePath(repo),
      JSON.stringify({
        version: 1,
        entries: [...dead, alive.id].map((entryId) => ({
          id: entryId,
          enqueued_at: '2026-01-01T00:00:00.000Z',
        })),
      }),
    )

    let writes = 0
    let broadcasts = 0
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      onQueueChanged: () => {
        broadcasts += 1
      },
      queueIo: {
        ...nodeTaskQueueIo,
        write: (path, value) => {
          writes += 1
          nodeTaskQueueIo.write(path, value)
        },
      },
      runAgentFn: questionAgent().run,
    })
    await until(() => status(repo, alive.id) === 'waiting_for_you')

    // Exactly two writes for the whole sweep: one for the batch, one for the
    // dequeue of the task that then started. It used to be twenty-one — and a
    // `toBeLessThanOrEqual` here would have passed just as happily on one,
    // which would mean the task never started at all.
    expect(writes).toBe(2)
    expect(broadcasts).toBe(2)
    expect(readQueue(repo).entries).toEqual([])
    await runner.shutdown()
  })

  // T1.2 re-review round 7: three branches of the queue's error handling that
  // nothing exercised — the two catches that keep a failing queue write from
  // becoming a crashed gesture, and the sweep's "no longer waiting" arm.
  test('a Stop on a queue that will not write degrades loudly instead of throwing', async () => {
    const repo = makeRepo()
    const head = makeTask(repo, 'head', 'work')
    const behind = makeTask(repo, 'behind', 'work later')
    let allowWrites = true
    const degradations: string[] = []
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 60_000,
      onQueueDegraded: (reason) => degradations.push(reason),
      queueIo: {
        ...nodeTaskQueueIo,
        write: (path, value) => {
          if (!allowWrites) {
            throw Object.assign(new Error('read-only file system'), { code: 'EROFS' })
          }
          nodeTaskQueueIo.write(path, value)
        },
      },
      runAgentFn: hangingAgent,
    })
    runner.start(head)
    await until(() => status(repo, head.id) === 'running')
    runner.start(behind)
    expect(readQueue(repo).entries.map((e) => e.id)).toEqual([behind.id])

    // The disk turns read-only, then a human presses Stop on the waiting one.
    allowWrites = false
    expect(runner.interrupt(behind.id)).toEqual({ ok: true })
    // The gesture succeeded, the task is settled, and the queue's refusal to
    // write was NAMED rather than thrown at the caller or swallowed.
    expect(status(repo, behind.id)).toBe('interrupted')
    expect(degradations.some((line) => line.includes('read-only file system'))).toBe(true)

    allowWrites = true
    await runner.shutdown()
  })

  test('a queue that will not take the task at all refuses the creation, named', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'never enqueued', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      queueIo: {
        ...nodeTaskQueueIo,
        write: () => {
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
        },
      },
      runAgentFn: questionAgent().run,
    })

    // enqueue throws; schedule turns it into a refusal instead of a 500.
    const refused = runner.start(task)
    expect(refused).toEqual({
      ok: false,
      code: 503,
      error: 'no space left on device',
      reason_code: 'resource_busy',
    })
    // And the record says the same thing the caller was told.
    expect(loadTask(repo, task.id)?.reason?.code).toBe('resource_busy')
    expect(loadTask(repo, task.id)?.reason?.detail).toContain('no space left on device')
    await runner.shutdown()
  })

  test('an entry whose task is no longer WAITING is swept out of the line', async () => {
    const repo = makeRepo()
    const head = makeTask(repo, 'head', 'task one')
    const moved = makeTask(repo, 'moved on', 'task two')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: async (options) => {
        if (options.prompt.includes('task one')) {
          await gate
        }
        const raw = claudeStream('done.\nQUESTION: next?')
        options.onText?.(raw)
        return raw
      },
    })
    runner.start(head)
    runner.start(moved)
    await until(() => status(repo, head.id) === 'running')

    // Its record leaves 'queued' behind the runner's back — the shape a crash
    // at the wrong moment leaves. It is neither gone nor unreadable: it simply
    // has no business making anyone wait behind it.
    const settled = loadTask(repo, moved.id)!
    settled.status = 'shipped'
    saveTask(repo, settled)

    release()
    await until(() => readQueue(repo).entries.length === 0)
    // Swept, and NOT rewritten: sweeping is not a status change.
    expect(loadTask(repo, moved.id)?.status).toBe('shipped')
    await runner.shutdown()
  })

  // T1.2 re-review round 4, MINOR 2: loadTask returns null for "no such task"
  // AND for "could not read it just now". Only the first may cost a rank.
  test('a task.json that cannot be READ keeps its place; only a task that is GONE loses it', async () => {
    const repo = makeRepo()
    const head = makeTask(repo, 'head', 'task one')
    const unreadable = makeTask(repo, 'unreadable', 'task two')
    const vanished = makeTask(repo, 'vanished', 'task three')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: async (options) => {
        if (options.prompt.includes('task one')) {
          await gate
        }
        const raw = claudeStream('done.\nQUESTION: next?')
        options.onText?.(raw)
        return raw
      },
    })
    runner.start(head)
    runner.start(unreadable)
    runner.start(vanished)
    await until(() => status(repo, head.id) === 'running')

    // One record is there but illegible (a truncated write, an EIO); the
    // other is genuinely gone.
    writeFileSync(join(repo, '.codesema', 'tasks', unreadable.id, 'task.json'), '{ truncated')
    rmSync(join(repo, '.codesema', 'tasks', vanished.id), { recursive: true, force: true })

    release()
    await until(() => readQueue(repo).entries.length === 1)
    // The vanished one is out. The illegible one KEEPS its place — evicting
    // it would silently cost a valid task its rank over a transient failure.
    expect(readQueue(repo).entries.map((e) => e.id)).toEqual([unreadable.id])
    await runner.shutdown()
  })

  test('a turn that waited in the queue starts its clock when it STARTS, not when it was created', async () => {
    const repo = makeRepo()
    const first = makeTask(repo, 'first', 'task one')
    const second = makeTask(repo, 'second', 'task two')
    // A creation timestamp from another era: the record carries it on turn 1.
    const stale = loadTask(repo, second.id)!
    stale.turns[0]!.started_at = '2020-01-01T00:00:00.000Z'
    saveTask(repo, stale)

    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: async (options) => {
        if (options.prompt.includes('task one')) {
          await gate
        }
        const raw = claudeStream('done.\nQUESTION: next?')
        options.onText?.(raw)
        return raw
      },
    })
    runner.start(first)
    runner.start(second)
    expect(loadTask(repo, second.id)?.turns[0]?.started_at).toBe('2020-01-01T00:00:00.000Z')

    release()
    await until(() => status(repo, second.id) === 'waiting_for_you')
    // Rewritten at launch: the UI would otherwise show "running for years".
    const startedAt = Date.parse(loadTask(repo, second.id)!.turns[0]!.started_at)
    expect(Date.now() - startedAt).toBeLessThan(60_000)
  })
})

// --- the deprecated maxParallelTasks key, said out loud (T1.3) -------------

describe('maxParallelNotice', () => {
  test('a configured key is announced deprecated, and names what replaces it', () => {
    const line = maxParallelNotice(5)
    expect(line).toContain('maxParallelTasks=5')
    expect(line).toContain('deprecated')
    expect(line).toContain('maxConcurrentAgents')
  })

  test('an unset key says nothing at all', () => {
    expect(maxParallelNotice(undefined)).toBeNull()
  })
})

describe('resolveMaxConcurrentAgents (design.md Decision 5)', () => {
  test('neither key set: undefined, so the caller applies its own default', () => {
    expect(resolveMaxConcurrentAgents({})).toBeUndefined()
  })

  test('only the deprecated key set: its value is honored', () => {
    expect(resolveMaxConcurrentAgents({ maxParallelTasks: 2 })).toBe(2)
  })

  test('only the explicit key set: its value is honored', () => {
    expect(resolveMaxConcurrentAgents({ maxConcurrentAgents: 7 })).toBe(7)
  })

  test('both set: the explicit maxConcurrentAgents wins the value', () => {
    expect(resolveMaxConcurrentAgents({ maxConcurrentAgents: 7, maxParallelTasks: 2 })).toBe(7)
  })
})

// Adversarial review round 3, MAJEUR 1: the previous round's coverage of
// `shutdownSignal` and `maxConcurrentAgents` injected them straight into
// `createTaskManager`, which proves that function honors them but nothing
// about workspace.ts's OWN wiring — deleting `shutdownSignal: draining.signal`
// from workspace.ts left the whole suite (2065 tests) green. These tests call
// the exact function `workspace()` spreads into its `createTaskManager` call,
// so a regression at THAT call site (not just inside createTaskManager) is
// what turns them red.
// The ONE argument `workspace()` builds its task manager with. Round 3 tested
// three fields of it; round 4 (MAJEUR 2) made it the WHOLE argument, because
// the five the call site still spelled out inline were what let a merge
// resolution drop the spread — and with it `shutdownSignal` and
// `maxConcurrentAgents` — without a single red test.
describe('workspaceTaskManagerOptions (the whole createTaskManager argument)', () => {
  /** The boot facts the caller resolves (agent command, ceilings, cage). */
  const boot = () => ({
    command: 'claude -p',
    timeoutMs: 90_000,
    watchdog: { inactivityMs: 1000, toolBudgetMs: 2000, heartbeatMs: 500 },
    isolation: {
      available: true,
      mode: 'container' as const,
      reason: 'podman is available',
      configured: 'auto' as const,
      runtime: 'podman' as const,
    },
    allowedDomains: ['registry.npmjs.org'],
    flags: { timeout: 15, isolation: 'policy' as const },
  })

  test('shutdownSignal is the signal draining.abort() actually fires', () => {
    const draining = new AbortController()
    const opts = workspaceTaskManagerOptions({}, draining, boot())
    expect(opts.shutdownSignal).toBe(draining.signal)
    expect(opts.shutdownSignal?.aborted).toBe(false)
    draining.abort()
    expect(opts.shutdownSignal?.aborted).toBe(true)
  })

  // The mutant this kills: dropping `...boot` from the returned literal. The
  // typecheck already refuses a call site that stops using this function at
  // all (command/timeoutMs are required); this covers the other half — the
  // function being called but throwing half its input away.
  test('every boot fact reaches the manager options verbatim', () => {
    const input = boot()
    const opts = workspaceTaskManagerOptions({}, new AbortController(), input)
    expect(opts.command).toBe(input.command)
    expect(opts.timeoutMs).toBe(input.timeoutMs)
    expect(opts.watchdog).toEqual(input.watchdog)
    expect(opts.isolation).toEqual(input.isolation)
    expect(opts.allowedDomains).toEqual(input.allowedDomains)
    expect(opts.flags).toEqual(input.flags)
  })

  test('neither key configured: maxParallel and maxConcurrentAgents are both absent', () => {
    const opts = workspaceTaskManagerOptions({}, new AbortController(), boot())
    expect(opts.maxParallel).toBeUndefined()
    expect(opts.maxConcurrentAgents).toBeUndefined()
  })

  test('only the explicit key: maxConcurrentAgents carries it, maxParallel stays absent', () => {
    const opts = workspaceTaskManagerOptions(
      { maxConcurrentAgents: 3 },
      new AbortController(),
      boot(),
    )
    expect(opts.maxConcurrentAgents).toBe(3)
    expect(opts.maxParallel).toBeUndefined()
  })

  test('only the deprecated alias: it feeds BOTH maxParallel (round-trip) and maxConcurrentAgents (D5)', () => {
    // The mutant this kills: `resolveMaxConcurrentAgents(config) ->
    // config.maxConcurrentAgents` at the call site — it would ignore the
    // alias entirely and leave maxConcurrentAgents undefined here, breaking
    // AC-10 ("an effective cap of 2" via the deprecated key alone).
    const opts = workspaceTaskManagerOptions({ maxParallelTasks: 2 }, new AbortController(), boot())
    expect(opts.maxParallel).toBe(2)
    expect(opts.maxConcurrentAgents).toBe(2)
  })

  test('both keys: the explicit maxConcurrentAgents wins the value, maxParallel still round-trips', () => {
    const opts = workspaceTaskManagerOptions(
      { maxConcurrentAgents: 7, maxParallelTasks: 2 },
      new AbortController(),
      boot(),
    )
    expect(opts.maxConcurrentAgents).toBe(7)
    expect(opts.maxParallel).toBe(2)
  })

  // A SOURCE-SHAPE assertion, deliberately, and the only kind available for
  // this one fact. `workspace()` cannot be called from a test (it listens on
  // a port, takes the global workspace lock, probes container runtimes and
  // installs real SIGINT handlers), so nothing runtime-level can observe how
  // it builds its manager. Moving every option into
  // `workspaceTaskManagerOptions` makes DELETING the call a typecheck error
  // (`command`/`timeoutMs` are required) — but it does NOT stop a merge
  // resolution from replacing the call with an inline literal that supplies
  // those two and quietly drops `shutdownSignal` and `maxConcurrentAgents`.
  // That is not hypothetical: the T2.4 rebase conflicts on exactly this call,
  // and taking its side does exactly that.
  //
  // Not tautological: it compares nothing to the constant that produces it —
  // it pins an architectural invariant ("this call site delegates, it does
  // not decide") that neither the type system nor any runtime assertion can
  // express here.
  test('workspace() builds its manager THROUGH this function and nothing else', () => {
    const code = readFileSync(join(import.meta.dir, 'workspace.ts'), 'utf8')
      .split('\n')
      // Comment lines mention the call by name on purpose; only code counts.
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .join('\n')
    // T1.9 put an injection seam on the call TARGET
    // (`opts.createTaskManagerFn ?? createTaskManager`) — that seam is how the
    // boot wiring gets tested at all, and it is why the literal
    // `createTaskManager(` no longer appears. The invariant pinned here is
    // unchanged and lives on the ARGUMENT: whatever builds the manager is
    // handed the whole object this function returns, with nothing decided
    // inline beside it.
    expect(code.match(/createTaskManager[)\s]*\(/g) ?? []).toHaveLength(1)
    expect(/createTaskManager\)\(\s*workspaceTaskManagerOptions\(/.test(code)).toBe(true)
  })
})

// MINEUR (adversarial review): an invalid machine-cap value used to disappear
// in total silence — the boot line that says so, for both keys, both scopes.
describe('invalidLoadCapKeyNotice', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string
  let repoDir: string

  afterEach(() => {
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
    if (configDir) {
      rmSync(configDir, { recursive: true, force: true })
    }
    if (repoDir) {
      rmSync(repoDir, { recursive: true, force: true })
    }
  })

  function withConfigDir(): void {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-invalid-cap-cfg-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
  }

  test('nothing configured: silence', () => {
    withConfigDir()
    repoDir = mkdtempSync(join(tmpdir(), 'codesema-invalid-cap-repo-'))
    expect(invalidLoadCapKeyNotice(repoDir)).toBeNull()
    expect(invalidLoadCapKeyNotice(null)).toBeNull()
  })

  test('a usable value: silence', () => {
    withConfigDir()
    repoDir = mkdtempSync(join(tmpdir(), 'codesema-invalid-cap-repo-'))
    saveRepoConfig(repoDir, { maxConcurrentAgents: 3 })
    expect(invalidLoadCapKeyNotice(repoDir)).toBeNull()
  })

  test('an invalid maxConcurrentAgents in the REPO config is named as global-only (T1.4)', () => {
    withConfigDir()
    repoDir = mkdtempSync(join(tmpdir(), 'codesema-invalid-cap-repo-'))
    saveRepoConfig(repoDir, { maxConcurrentAgents: 0 })
    expect(invalidLoadCapKeyNotice(repoDir)).toBeNull()
    expect(bootNotices({}, repoDir).some((line) => line.includes('maxConcurrentAgents'))).toBe(true)
  })

  test('the deprecated alias in a repo file is named as global-only (T1.4)', () => {
    withConfigDir()
    repoDir = mkdtempSync(join(tmpdir(), 'codesema-invalid-cap-repo-'))
    saveRepoConfig(repoDir, { maxParallelTasks: -1 })
    expect(invalidLoadCapKeyNotice(repoDir)).toBeNull()
    expect(bootNotices({}, repoDir).some((line) => line.includes('maxParallelTasks'))).toBe(true)
  })

  test('outside any repo (repoRoot null), only the global config is consulted', () => {
    withConfigDir()
    // No repo config exists at all here; a null repoRoot must not throw
    // trying to read one.
    expect(invalidLoadCapKeyNotice(null)).toBeNull()
  })

  // Round 4 (mineur): each notice was proven on its own; that the BOOT prints
  // them — both of them, in this order — rested on reading `workspace()`,
  // which no test can call. `bootNotices` is that assembly, extracted.
  describe('bootNotices (what the boot actually prints)', () => {
    test('nothing to say: no lines at all', () => {
      withConfigDir()
      repoDir = mkdtempSync(join(tmpdir(), 'codesema-boot-notices-repo-'))
      expect(bootNotices({}, repoDir)).toEqual([])
    })

    test('an invalid GLOBAL value AND a deprecated key: both lines, deprecation first', () => {
      withConfigDir()
      repoDir = mkdtempSync(join(tmpdir(), 'codesema-boot-notices-repo-'))
      saveGlobalConfig({ maxConcurrentAgents: 0 })
      const lines = bootNotices({ maxParallelTasks: 2 }, repoDir)
      // The mutant this kills: dropping either entry from the array. A silent
      // deprecation, or a value silently ignored, is invariant 2's exact
      // failure mode — and the whole reason this ticket added the two lines.
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain('maxParallelTasks')
      expect(lines[1]).toContain('maxConcurrentAgents')
    })

    test('a well-formed repo load-cap key is named as ignored, not as unusable (T1.4)', () => {
      withConfigDir()
      repoDir = mkdtempSync(join(tmpdir(), 'codesema-boot-notices-repo-'))
      saveRepoConfig(repoDir, { maxConcurrentAgents: 3 })
      const lines = bootNotices({}, repoDir)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toContain('maxConcurrentAgents')
      expect(lines[0]).toMatch(/ignored|global/i)
    })

    test('only the deprecated key set: one line, the deprecation', () => {
      withConfigDir()
      repoDir = mkdtempSync(join(tmpdir(), 'codesema-boot-notices-repo-'))
      expect(bootNotices({ maxParallelTasks: 4 }, repoDir)).toEqual([maxParallelNotice(4)!])
    })

    // A SOURCE-SHAPE assertion, same kind and for the same reason as
    // 'workspace() builds its manager THROUGH this function and nothing else'
    // 190 lines above: `workspace()` listens on a port, takes the global
    // workspace lock, probes container runtimes and installs real SIGINT
    // handlers, so no runtime assertion can observe what it prints at boot.
    //
    // The gap this closes was measured, not imagined (adversarial round 5,
    // MAJEUR A): replacing the loop with `for (const line of [] as string[])`
    // kept `tsc --noEmit` green and the whole suite at 0 fail, while BOTH
    // normative boot lines vanished in silence — the `maxParallelTasks`
    // deprecation warning and the `workspace.invalidLoadCapKey` notice. The
    // three tests above prove the array's CONTENT; this one proves the boot
    // still reads it, which is the half invariant 2 (no silent degradation)
    // actually depends on.
    //
    // Not tautological: it compares nothing to the constant that produces it.
    test('workspace() prints EVERY bootNotices line, and gets them from nowhere else', () => {
      const code = readFileSync(join(import.meta.dir, 'workspace.ts'), 'utf8')
        .split('\n')
        // Comment lines name the call on purpose; only code counts.
        .filter((line) => !/^\s*(\*|\/\/)/.test(line))
        .join('\n')
      // Exactly two mentions: the declaration and the one call site.
      expect(code.match(/\bbootNotices\(/g) ?? []).toHaveLength(2)
      // And that call site iterates the result, printing each line as-is.
      expect(
        /for\s*\(\s*const\s+line\s+of\s+bootNotices\([^)]*\)\s*\)\s*\{\s*console\.log\(line\)\s*\}/.test(
          code,
        ),
      ).toBe(true)
    })
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

// --- resume: restarting the interrupted turn itself ------------------------

describe('resume', () => {
  test('restarts the turn that died, in place, on the resumed session', async () => {
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
    // A second turn that the shutdown catches mid-flight: its prompt is on
    // the record, its response never came.
    runner.reply(task.id, 'keep going')
    await until(() => loadTask(repo, task.id)?.turns.length === 2)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const interrupted = loadTask(repo, task.id)!
    interrupted.status = 'interrupted'
    interrupted.turns[1]!.response = null
    interrupted.turns[1]!.question = null
    saveTask(repo, interrupted)

    expect(runner.resume(task.id)).toEqual({ ok: true })
    await until(() => loadTask(repo, task.id)?.turns[1]?.response !== null)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    const after = loadTask(repo, task.id)!
    // NO third turn: the conversation keeps one instruction per turn.
    expect(after.turns).toHaveLength(2)
    expect(after.turns[1]?.response).toContain('Blocked.')
    // Same instruction, resumed session — nothing was invented for the agent.
    expect(agent.seen.prompts.at(-1)).toBe('keep going')
    expect(agent.seen.commands.at(-1)).toContain('--resume sess-123')
  })

  test('a task interrupted before its first run replays it with no session', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'never ran', 'initial instruction')
    // Exactly what a shutdown does to a still-queued task.
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
        return Promise.resolve('picked it up\nQUESTION: keep going?')
      },
    })
    expect(runner.resume(task.id)).toEqual({ ok: true })
    await until(() => status(repo, task.id) === 'waiting_for_you')
    // Turn 1 again: the standing instructions plus the original prompt, with
    // no transcript to replay (nothing ever happened).
    expect(loadTask(repo, task.id)?.turns).toHaveLength(1)
    expect(prompts[0]).toContain('initial instruction')
    expect(prompts[0]).not.toContain('Previous turns of this task:')
  })

  test('refused when the last turn already answered: only a reply moves it', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'answered', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: questionAgent().run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    // Stopping a conversation the agent already answered leaves nothing to
    // redo — a Resume there would silently repeat a finished turn.
    expect(runner.interrupt(task.id)).toEqual({ ok: true })
    expect(runner.resume(task.id)).toEqual({
      ok: false,
      code: 409,
      error: 'task has no interrupted turn to resume',
    })
    // The documented way forward still works.
    expect(runner.reply(task.id, 'and now this')).toEqual({ ok: true })
  })

  // Rewritten (was: 'refused when the materialized worktree is gone', which
  // asserted a 409 'task worktree is gone'). The refusal is gone AND the danger
  // it named is gone with it: the rebuild takes the conversation's own branch
  // back — where its commits are — instead of forking a fresh one beside them.
  // That is what makes offering Resume honest; refusing would have been the
  // only safe answer while the rebuild still stranded work.
  test('rebuilds a materialized worktree that vanished, keeping the branch and its work', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'homeless', 'work')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 60_000,
      runAgentFn: hangingAgent,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'running')
    runner.interrupt(task.id)
    await until(() => status(repo, task.id) === 'interrupted')
    const before = loadTask(repo, task.id)!
    expect(existsSync(before.worktree)).toBe(true)
    // Deleted behind codesema's back (a cleaned tmpdir, a stray rm).
    rmSync(before.worktree, { recursive: true, force: true })
    // The base moves meanwhile: the rebuild must NOT follow it onto a new fork.
    execFileSync('git', ['commit', '--allow-empty', '-m', 'base moved'], {
      cwd: repo,
      stdio: 'ignore',
    })

    expect(runner.resume(task.id)).toEqual({ ok: true })
    await until(() => status(repo, task.id) === 'running')
    const after = loadTask(repo, task.id)!
    expect(existsSync(after.worktree)).toBe(true)
    // Same branch, same anchor, and no orphan branch left behind: the work the
    // conversation had committed stays inside the range the review measures.
    expect(after.branch).toBe(before.branch)
    expect(after.baseline_sha).toBe(before.baseline_sha ?? '')
    expect(branchExists(repo, `${before.branch}-2`)).toBe(false)
    expect(tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], after.worktree)).toBe(before.branch)
    runner.interrupt(task.id)
    await until(() => status(repo, task.id) === 'interrupted')
  })

  test('gate: unknown id, non-interrupted statuses, and a drain in progress', async () => {
    const repo = makeRepo()
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: questionAgent().run,
    })
    expect(runner.resume('aaaaaaaaaaaa')).toMatchObject({ ok: false, code: 404 })

    for (const state of ['queued', 'waiting_for_you', 'review_ok', 'shipped', 'failed'] as const) {
      const task = makeTask(repo, `is ${state}`, 'work')
      const seeded = loadTask(repo, task.id)!
      seeded.status = state
      saveTask(repo, seeded)
      expect(runner.resume(task.id)).toEqual({
        ok: false,
        code: 409,
        error: `task is ${state}`,
      })
    }

    const draining = makeTask(repo, 'too late', 'work')
    const seeded = loadTask(repo, draining.id)!
    seeded.status = 'interrupted'
    saveTask(repo, seeded)
    await runner.shutdown()
    expect(runner.resume(draining.id)).toEqual({ ok: false, code: 409, error: 'shutting down' })
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
    expect(await runner.abandon(task.id)).toEqual({
      ok: false,
      code: 409,
      error: 'task is running',
    })

    runner.interrupt(task.id)
    await until(() => status(repo, task.id) === 'interrupted')
    const { worktree, branch } = loadTask(repo, task.id)!
    expect(existsSync(worktree)).toBe(true)
    expect(branchExists(repo, branch)).toBe(true)

    expect(await runner.abandon(task.id)).toEqual({ ok: true })
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
    expect(await runner.abandon(task.id)).toEqual({ ok: true })
    // --force removal: dirty files do not save a worktree from an abandon.
    expect(existsSync(worktree)).toBe(false)
    expect(branchExists(repo, branch)).toBe(false)
    expect(status(repo, task.id)).toBe('failed')
  })

  test("abandoning a work-on conversation never deletes the user's own branch", async () => {
    const repo = makeRepo()
    execFileSync('git', ['branch', 'feature/mine'], { cwd: repo, stdio: 'ignore' })
    const task = createTask(repo, {
      title: 'on my branch',
      prompt: 'work',
      autoShip: false,
      base: 'main',
      branch: 'feature/mine',
      worktree: '',
      workOn: true,
    })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: questionAgent().run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const { worktree } = loadTask(repo, task.id)!
    // The conversation ADOPTED this branch; it never brought it into existence.
    expect(loadTask(repo, task.id)?.created_branch).toBeUndefined()

    expect(await runner.abandon(task.id)).toEqual({ ok: true })
    expect(existsSync(worktree)).toBe(false)
    // Only the checkout is discarded: deleting a branch the human already had
    // is never ours to decide.
    expect(branchExists(repo, 'feature/mine')).toBe(true)
  })

  // MAJEUR 1 of the T1.6 review round: this is the MOST COMMON work-on case
  // (a plain adopted branch, `created_branch` absent) and it was signalling
  // NOTHING when it carried commits — the branch survived (it always did),
  // but neither the journal nor the API said a branch full of work had just
  // been kept. `hasOwnCommits` is now computed unconditionally, so the signal
  // fires here exactly as it does for a branch this conversation forked.
  test("T1.6: a plain adopted work-on branch signals when it carries the user's commits", async () => {
    const repo = makeRepo()
    execFileSync('git', ['branch', 'feature/mine'], { cwd: repo, stdio: 'ignore' })
    const task = createTask(repo, {
      title: 'on my branch, real work',
      prompt: 'work',
      autoShip: false,
      base: 'main',
      branch: 'feature/mine',
      worktree: '',
      workOn: true,
    })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: (options) => {
        writeFileSync(join(options.cwd, 'work.txt'), 'done\n')
        const raw = claudeStream('shipped it')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(loadTask(repo, task.id)?.created_branch).toBeUndefined()

    const result = await runner.abandon(task.id)
    expect(result).toEqual({ ok: true, preserved_branch: 'feature/mine' })
    expect(branchExists(repo, 'feature/mine')).toBe(true)
    const preserved = readTaskEvents(repo, task.id).find((e) => e.data.name === 'branch_preserved')
    expect(preserved).toMatchObject({
      type: 'branch',
      data: { preserved_branch: 'feature/mine', preserved_branch_commits: 1 },
    })
  })

  // T1.6 REVIEW ROUND: this test used to be named "... cleans it up" and
  // asserted the local head was DELETED. That is exactly the destroyed-work
  // bug the adversarial review reproduced: origin/<branch> can vanish between
  // two turns (merged, renamed, cleaned up on the forge — the nominal case of
  // a colleague's MR), and the local head this conversation created is then
  // the ONLY copy of any commit it carries. `abandon()` can no longer tell
  // "empty, safe to delete" from "the origin copy just vanished" from inside
  // this call, so a work-on conversation's branch is NEVER deleted here any
  // more, full stop — whether this conversation created its local head or
  // adopted one that already existed. The old intention (not letting empty
  // local heads accumulate forever) stays valid; it is deferred to T1.9's
  // configurable retention, which purges what abandon no longer dares to.
  test('abandoning a work-on conversation never deletes the local head it created, even empty', async () => {
    const repo = makeRepo()
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    // The branch exists on origin only, as it does for a teammate's MR that was
    // never pulled: materializing the conversation creates the LOCAL head.
    execFileSync('git', ['update-ref', 'refs/remotes/origin/feature/theirs', sha], { cwd: repo })
    const task = createTask(repo, {
      title: 'their branch',
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
      runAgentFn: questionAgent().run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(loadTask(repo, task.id)?.created_branch).toBe(true)
    expect(branchExists(repo, 'feature/theirs')).toBe(true)

    // No commit was ever made (questionAgent never writes): still kept.
    expect(await runner.abandon(task.id)).toEqual({ ok: true })
    expect(branchExists(repo, 'feature/theirs')).toBe(true)
    expect(
      tryGit(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/feature/theirs'], repo),
    ).not.toBeNull()
  })

  test('T1.6: preserved_branch_commits is never a fabricated 0 (branch reset backward past its anchor)', async () => {
    const repo = makeRepo() // one commit, c1 ("init: base").
    // A second commit BEFORE the task forks: the fork's baseline is this one.
    writeFileSync(join(repo, 'second.txt'), 'b\n')
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'second commit'], { cwd: repo, stdio: 'ignore' })
    const c1 = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: repo, encoding: 'utf8' }).trim()

    const task = makeTask(repo, 'reset backward', 'do nothing new')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: questionAgent().run, // never commits
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id)!
    expect(record.baseline_sha).toBeDefined() // the SECOND commit, HEAD at fork time.

    // The branch is reset BACKWARD to an ancestor of its own anchor: its tip
    // differs from the anchor (so `hasOwnCommits` reads true, the safe side),
    // but nothing is "ahead" of that anchor — the opposite, if anything.
    execFileSync('git', ['update-ref', `refs/heads/${record.branch}`, c1], { cwd: repo })

    const result = await runner.abandon(task.id)
    expect(result).toEqual({ ok: true, preserved_branch: record.branch })
    const preserved = readTaskEvents(repo, task.id).find((e) => e.data.name === 'branch_preserved')
    expect(preserved?.data.preserved_branch).toBe(record.branch)
    // The one value this field must never carry: a fabricated 0 would claim
    // "0 commits of its own" on a line whose whole point is that it DOES.
    expect(preserved?.data.preserved_branch_commits).toBeUndefined()
  })

  // MINEUR of the T1.6 review round: the repli was silent exactly where it
  // fails hardest — no baseline_sha AND `record.base` names nothing at all
  // (a deleted base branch, or the '' a work-on task's base is left at when
  // the server never set it). That is the maximal degradation, and it was
  // the only one of the three T1.6 facts with no journal line.
  test('T1.6: an unresolvable repli is journaled as baseline_sha_unresolved, not silently', async () => {
    const repo = makeRepo()
    execFileSync('git', ['branch', 'feature/mine'], { cwd: repo, stdio: 'ignore' })
    const task = createTask(repo, {
      title: 'no base recorded',
      prompt: 'work',
      autoShip: false,
      base: '',
      branch: 'feature/mine',
      worktree: '',
      workOn: true,
    })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: questionAgent().run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id)!
    const legacy: Partial<TaskRecord> = { ...record }
    delete legacy.baseline_sha
    saveTask(repo, legacy as TaskRecord)

    // An anchor that cannot be resolved at all reads as "has own commits"
    // (branchHasOwnCommits's safe default), so this also signals a preserved
    // branch — correctly: nothing here can prove it does NOT carry work.
    expect(await runner.abandon(task.id)).toEqual({ ok: true, preserved_branch: 'feature/mine' })
    const events = readTaskEvents(repo, task.id)
    const unresolved = events.find((e) => e.data.name === 'baseline_sha_unresolved')
    expect(unresolved).toBeDefined()
    expect(unresolved?.type).toBe('branch')
    expect(unresolved?.reason_code).toBeUndefined()
    const preserved = events.find((e) => e.data.name === 'branch_preserved')
    expect(preserved).toBeDefined()
    expect(preserved?.data.preserved_branch_commits).toBeUndefined()
    // Still never deleted: an adopted work-on branch, full stop.
    expect(branchExists(repo, 'feature/mine')).toBe(true)
  })

  test('T1.6 REVIEW ROUND 3, MAJEUR 1: never announces a branch that is already gone', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'stale checkout', 'do the thing')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: (options) => {
        writeFileSync(join(options.cwd, 'work.txt'), 'done\n')
        const raw = claudeStream('shipped it')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id)!

    // Out-of-band cleanup BEFORE abandon runs: a stale checkout removed by
    // hand, or an earlier partial abandon that deleted the branch but never
    // wrote its record back. `branchHasOwnCommits` correctly cannot prove
    // this branch was empty (its tip cannot even be read any more) — the
    // DECISION not to delete is moot, but the ANNOUNCEMENT must not follow.
    execFileSync('git', ['worktree', 'remove', '--force', record.worktree], {
      cwd: repo,
      stdio: 'ignore',
    })
    execFileSync('git', ['branch', '-D', record.branch], { cwd: repo, stdio: 'ignore' })
    expect(branchExists(repo, record.branch)).toBe(false)

    const result = await runner.abandon(task.id)
    // No `preserved_branch`: naming a ref that does not exist is the exact
    // lie this fix rules out.
    expect(result).toEqual({ ok: true })
    const events = readTaskEvents(repo, task.id)
    expect(events.some((e) => e.data.name === 'branch_preserved')).toBe(false)
    const gone = events.find((e) => e.data.name === 'branch_gone')
    expect(gone).toBeDefined()
    expect(gone?.type).toBe('branch')
    expect(gone?.data.preserved_branch).toBeUndefined()
    expect(gone?.reason_code).toBeUndefined()
  })

  test('T1.6 REVIEW ROUND 3, MAJEUR 2: an unresolvable baseline_sha is journaled too', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'bogus anchor', 'do nothing new')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: questionAgent().run, // never commits
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id)!
    expect(record.baseline_sha).toBeDefined()

    // Shape-valid, resolves to nothing: the contract only checks
    // /^[0-9a-f]{7,64}$/ (sanitizeBaselineSha), never that the object still
    // exists in THIS repo — reachable via a git filter-repo, a re-clone into
    // the same directory, a .codesema/ restored from another clone's backup,
    // a shallow fetch, or a hand-edited record.
    saveTask(repo, { ...record, baseline_sha: 'deadbeefcafe' })

    const result = await runner.abandon(task.id)
    const events = readTaskEvents(repo, task.id)
    const unresolved = events.find((e) => e.data.name === 'baseline_sha_unresolved')
    expect(unresolved).toBeDefined()
    expect(unresolved?.type).toBe('branch')
    expect(unresolved?.reason_code).toBeUndefined()
    // Cannot be measured against a bogus anchor: treated as carrying a commit
    // of its own (the safe reading), so it is kept and signalled — the
    // branch never actually moved, but nothing here can prove that any more.
    expect(result).toEqual({ ok: true, preserved_branch: record.branch })
    expect(branchExists(repo, record.branch)).toBe(true)
  })

  test('T1.6 REVIEW ROUND 3, MINEUR: an untouched work-on branch with no commits still gets a line', async () => {
    const repo = makeRepo()
    execFileSync('git', ['branch', 'feature/mine'], { cwd: repo, stdio: 'ignore' })
    const task = createTask(repo, {
      title: 'on my branch, nothing new',
      prompt: 'work',
      autoShip: false,
      base: 'main',
      branch: 'feature/mine',
      worktree: '',
      workOn: true,
    })
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: questionAgent().run,
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')

    expect(await runner.abandon(task.id)).toEqual({ ok: true })
    expect(branchExists(repo, 'feature/mine')).toBe(true)
    const untouched = readTaskEvents(repo, task.id).find((e) => e.data.name === 'branch_untouched')
    expect(untouched).toBeDefined()
    expect(untouched?.type).toBe('branch')
    expect(untouched?.reason_code).toBeUndefined()
  })

  test('T1.6: the destroyed-work scenario the review reproduced no longer loses the commit', async () => {
    const repo = makeRepo()
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    execFileSync('git', ['update-ref', 'refs/remotes/origin/feature/theirs', sha], { cwd: repo })
    const task = createTask(repo, {
      title: 'their branch, about to lose origin',
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
      runAgentFn: (options) => {
        writeFileSync(join(options.cwd, 'work.txt'), 'done\n')
        const raw = claudeStream('shipped it')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const commitSha = tryGit(['rev-parse', 'refs/heads/feature/theirs'], repo)

    // Between turns, a colleague merges/renames/cleans up the branch on the
    // forge: origin/feature/theirs is gone. The local head is now the ONLY
    // copy of `commitSha`.
    execFileSync('git', ['update-ref', '-d', 'refs/remotes/origin/feature/theirs'], { cwd: repo })

    expect(await runner.abandon(task.id)).toEqual({ ok: true, preserved_branch: 'feature/theirs' })
    expect(branchExists(repo, 'feature/theirs')).toBe(true)
    // The commit is still reachable from SOME ref — nothing dangling, nothing
    // for `git gc` to reap.
    const containing = execFileSync(
      'git',
      ['for-each-ref', '--format=%(refname)', '--contains', commitSha ?? ''],
      { cwd: repo, encoding: 'utf8' },
    ).trim()
    expect(containing).toContain('refs/heads/feature/theirs')
  })

  test('T1.6: abandon keeps a branch that carries a commit of its own, and says so', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'real work', 'do the thing')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      // A 'done' turn with a real change: commitTurn actually commits it.
      runAgentFn: (options) => {
        writeFileSync(join(options.cwd, 'work.txt'), 'done\n')
        const raw = claudeStream('shipped it')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const { worktree, branch, baseline_sha: baseline } = loadTask(repo, task.id)!
    // Sanity: the branch really did move past its baseline before abandoning it.
    expect(tryGit(['rev-parse', `refs/heads/${branch}`], repo)).not.toBe(baseline ?? null)

    const result = await runner.abandon(task.id)
    expect(result).toEqual({ ok: true, preserved_branch: branch })
    // The worktree — a disposable checkout — is still gone.
    expect(existsSync(worktree)).toBe(false)
    // The branch — the deliverable — survives.
    expect(branchExists(repo, branch)).toBe(true)

    const events = readTaskEvents(repo, task.id)
    // The fact travels on its OWN 'branch' event (T1.6 review round): the
    // existing 'worktree removed, task abandoned' line is never touched, not
    // even with extra fields.
    const preserved = events.find((e) => e.data.name === 'branch_preserved')
    expect(preserved).toMatchObject({
      type: 'branch',
      data: { preserved_branch: branch, preserved_branch_commits: 1 },
    })
    // No D2 code: a preserved branch is the doctrine working, not a
    // degradation (DP14) — the cause is `data.name`, not `reason_code`.
    expect(preserved?.reason_code).toBeUndefined()

    const last = events.at(-1)
    expect(last?.type).toBe('error')
    expect(last?.data).toEqual({ message: 'worktree removed, task abandoned' })
    expect(last?.reason_code).toBeUndefined()
  })

  test('T1.6: a work-on head this conversation created is kept when it carries a commit', async () => {
    const repo = makeRepo()
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    // Branch exists on origin only: materializing the conversation creates the
    // LOCAL head (created_branch: true), exactly like the 'cleans it up' test
    // above — except this one leaves a commit of its own on it.
    execFileSync('git', ['update-ref', 'refs/remotes/origin/feature/theirs', sha], { cwd: repo })
    const task = createTask(repo, {
      title: 'their branch, real work',
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
      runAgentFn: (options) => {
        writeFileSync(join(options.cwd, 'work.txt'), 'done\n')
        const raw = claudeStream('shipped it')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    expect(loadTask(repo, task.id)?.created_branch).toBe(true)

    const result = await runner.abandon(task.id)
    // Carrying a commit overrides the created-local-head rule: it is no
    // longer "empty enough" for cleaning up the local head to be a no-op.
    expect(result).toEqual({ ok: true, preserved_branch: 'feature/theirs' })
    expect(branchExists(repo, 'feature/theirs')).toBe(true)
  })

  test('T1.6: a pre-baseline record falls back to base, journals the fallback, and still decides correctly', async () => {
    const repo = makeRepo()

    // A: no commit of its own -> still deletable without a baseline_sha.
    const idle = makeTask(repo, 'idle legacy', 'do nothing new')
    const idleRunner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: questionAgent().run,
    })
    idleRunner.start(idle)
    await until(() => status(repo, idle.id) === 'waiting_for_you')
    const idleRecord = loadTask(repo, idle.id)!
    const idleLegacy: Partial<TaskRecord> = { ...idleRecord }
    delete idleLegacy.baseline_sha
    saveTask(repo, idleLegacy as TaskRecord)

    expect(await idleRunner.abandon(idle.id)).toEqual({ ok: true })
    expect(branchExists(repo, idleRecord.branch)).toBe(false)
    const fallbackEvent = readTaskEvents(repo, idle.id).find(
      (e) => e.data.name === 'baseline_sha_fallback',
    )
    expect(fallbackEvent).toBeDefined()
    // No D2 code: a precision loss, not a stop (DP14).
    expect(fallbackEvent?.reason_code).toBeUndefined()

    // B: a commit of its own -> preserved even without a baseline_sha.
    const busy = makeTask(repo, 'busy legacy', 'do the thing')
    const busyRunner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: (options) => {
        writeFileSync(join(options.cwd, 'work.txt'), 'done\n')
        const raw = claudeStream('shipped it')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
    })
    busyRunner.start(busy)
    await until(() => status(repo, busy.id) === 'waiting_for_you')
    const busyRecord = loadTask(repo, busy.id)!
    const busyLegacy: Partial<TaskRecord> = { ...busyRecord }
    delete busyLegacy.baseline_sha
    saveTask(repo, busyLegacy as TaskRecord)

    const result = await busyRunner.abandon(busy.id)
    expect(result).toEqual({ ok: true, preserved_branch: busyRecord.branch })
    expect(branchExists(repo, busyRecord.branch)).toBe(true)
  })

  test('T1.6: a record WITH baseline_sha is decided from it, not from a (possibly moved) base', async () => {
    const repo = makeRepo()
    const task = makeTask(repo, 'quiet with baseline', 'do nothing new')
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: questionAgent().run, // never commits
    })
    runner.start(task)
    await until(() => status(repo, task.id) === 'waiting_for_you')
    const record = loadTask(repo, task.id)!
    const baseline = record.baseline_sha
    expect(typeof baseline).toBe('string')

    // main moves AFTER the baseline was captured — a foreign commit unrelated
    // to this task. If the anchor were re-resolved from `record.base` instead
    // of read from `baseline_sha`, it would now disagree with the branch's own
    // (unmoved) tip and wrongly read as "carries a commit of its own".
    writeFileSync(join(repo, 'unrelated.txt'), 'x\n')
    execFileSync('git', ['add', '-A'], { cwd: repo, stdio: 'ignore' })
    execFileSync('git', ['commit', '-m', 'unrelated work on main'], { cwd: repo, stdio: 'ignore' })
    expect(tryGit(['rev-parse', `refs/heads/${record.branch}`], repo)).toBe(baseline ?? null)
    expect(tryGit(['rev-parse', 'refs/heads/main'], repo)).not.toBe(baseline ?? null)

    const result = await runner.abandon(task.id)
    // Decided from the UNMOVED baseline_sha: still nothing of its own, so
    // still deletable — base having drifted since must not change that.
    expect(result).toEqual({ ok: true })
    expect(branchExists(repo, record.branch)).toBe(false)
  })

  test('guard rails: unknown id, reviewing task, and a never-started task', async () => {
    const repo = makeRepo()
    const runner = createTaskRunner({
      cwd: repo,
      command: 'claude -p',
      timeoutMs: 1000,
      runAgentFn: questionAgent().run,
    })
    expect(await runner.abandon('aaaaaaaaaaaa')).toMatchObject({ ok: false, code: 404 })

    // 'reviewing' means T4's review agent still works in the worktree.
    const reviewing = makeTask(repo, 'under review', 'work')
    const seeded = loadTask(repo, reviewing.id)!
    seeded.status = 'reviewing'
    saveTask(repo, seeded)
    expect(await runner.abandon(reviewing.id)).toEqual({
      ok: false,
      code: 409,
      error: 'task is reviewing',
    })

    // A queued task never got a worktree: abandon still lands on 'failed'.
    const fresh = makeTask(repo, 'never started', 'work')
    expect(await runner.abandon(fresh.id)).toEqual({ ok: true })
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

  expect(await runner.abandon(task.id)).toEqual({ ok: true })
  const after = loadTask(repo, task.id)
  expect(after?.status).toBe('shipped')
  expect(existsSync(after!.worktree)).toBe(false)
})

// --- boot: the isolation the workspace actually offers, said out loud ------

describe('logIsolation', () => {
  function captured(fn: () => void): string {
    const lines: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => lines.push(args.join(' '))
    try {
      fn()
    } finally {
      console.log = original
    }
    return lines.join('\n')
  }

  test('cage on: the line names the runtime and what it lets out', () => {
    const output = captured(() =>
      logIsolation(
        {
          available: true,
          mode: 'container',
          reason: 'podman is available',
          configured: 'auto',
          runtime: 'podman',
        },
        ['api.anthropic.com'],
      ),
    )
    expect(output).toContain('podman')
    expect(output).toContain('api.anthropic.com')
  })

  test('cage off: the WHY is on screen — the downgrade is never silent', () => {
    const output = captured(() =>
      logIsolation(
        {
          available: false,
          mode: 'policy',
          reason: 'no container runtime found (install docker or podman)',
          configured: 'auto',
          runtime: null,
        },
        ['api.anthropic.com'],
      ),
    )
    expect(output).toContain('no container runtime found')
    expect(output).toContain('policy')
  })
})
