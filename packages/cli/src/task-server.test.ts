import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentRunOptions } from './agent.js'
import { writeJsonAtomic } from './atomic-write.js'
import {
  isTerminalReason,
  type ReviewRecord,
  type TaskChecks,
  type TaskEvent,
  type TaskRecord,
  type Verdict,
} from './contract.js'
import { createLoadCap } from './load-cap.js'
import { addProject, listProjects, projectsPath, type Project } from './projects.js'
import { archiveRecord } from './record.js'
import { readChecksConfig } from './repo-config.js'
import { createSession, startServer } from './serve.js'
import type { RunChecksOptions } from './task-checks.js'
import type { HomeVolumeSweepOutcome } from './task-isolation.js'
import {
  activeTask,
  corruptQueuePath,
  QUEUE_ENTRIES_MAX,
  QUEUE_UNREADABLE,
  queuePath,
  readQueue,
  resetActiveClaims,
  resetQueueDegradedReports,
} from './task-queue.js'
import type { TaskRetentionOutcome } from './task-retention.js'
import { readTaskReview, type CreateTaskReviewerOptions } from './task-review.js'
import { pendingResumeTurn, type TaskRunner, type TaskRunnerOptions } from './task-runner.js'
import {
  createTaskManager,
  QUEUE_BROADCAST_MAX,
  queueEntriesRetired,
  type TaskEnvelope,
  type TaskManager,
} from './task-server.js'
import type { ShipOutcome, ShipTaskOptions } from './task-ship.js'
import {
  appendTaskEvent,
  createTask,
  listTasks,
  loadTask,
  readTaskChecks,
  readTaskEvents,
  resetStoreReports,
  saveTask,
  STORE_UNLISTABLE,
  taskDir,
  taskRecordExists,
  writeTaskChecks,
} from './tasks-store.js'

// --- rigs -----------------------------------------------------------------

// The project registry is global state: redirected to a fresh tmpdir per test
// via CODESEMA_CONFIG_DIR so tests never touch the real ~/.config/codesema.
let configDir: string
const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
/**
 * chmod does not bind root, so a suite run as root cannot exercise a
 * permission failure at all. The skip is gated on the UID and NOTHING else:
 * conditioning it on the failure being observed makes the test silently
 * assert nothing the day the failure stops happening — which is exactly the
 * day it should have gone red.
 */
const RUNNING_AS_ROOT = process.getuid?.() === 0

const cleanups: string[] = []

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'codesema-task-server-cfg-'))
  cleanups.push(configDir)
  process.env.CODESEMA_CONFIG_DIR = configDir
})

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
  if (previousConfigDir === undefined) {
    delete process.env.CODESEMA_CONFIG_DIR
  } else {
    process.env.CODESEMA_CONFIG_DIR = previousConfigDir
  }
})

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codesema-task-server-'))
  cleanups.push(dir)
  return dir
}

/** Real git repo: projects must be git roots, and the runner creates worktrees. */
function makeRepo(): string {
  const repo = makeDir()
  const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  run(['init', '-b', 'main'])
  run(['config', 'user.email', 't@t'])
  run(['config', 'user.name', 't'])
  writeFileSync(join(repo, 'base.txt'), 'a\n')
  run(['add', '-A'])
  run(['commit', '-m', 'init: base'])
  return repo
}

/** Registers a repo in the global registry, as the workspace boot would. */
function register(repo: string): Project {
  const added = addProject(repo)
  if (!added.ok) {
    throw new Error(added.error)
  }
  return added.project
}

function seedTask(cwd: string, title = 'seeded', prompt = 'do work'): TaskRecord {
  return createTask(cwd, {
    title,
    prompt,
    autoShip: false,
    base: '',
    branch: '',
    worktree: '',
  })
}

/** A minimal archivable review record, as the task reviewer produces one. */
function fakeReviewRecord(verdict: Verdict, summary: string): ReviewRecord {
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
    review: { verdict, summary, findings: [], narrative: null },
  }
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

type FakeRunnerRig = {
  createRunnerFn: (options: TaskRunnerOptions) => TaskRunner
  /** Hooks the manager passed to the LAST runner created (onTask/onEvent/onText). */
  runnerOptions: () => TaskRunnerOptions
  /** One entry per createRunnerFn call: the manager builds one runner per project. */
  allRunnerOptions: TaskRunnerOptions[]
  starts: TaskRecord[]
  replies: { id: string; message: string }[]
  interrupts: string[]
  abandons: string[]
  resumes: string[]
  /** Task ids the runner reports as having an abandon in flight. */
  abandoning: Set<string>
}

/** Captures the manager→runner seam without ever launching an agent. */
function fakeRunner(): FakeRunnerRig {
  const rig: FakeRunnerRig = {
    allRunnerOptions: [],
    starts: [],
    replies: [],
    interrupts: [],
    abandons: [],
    resumes: [],
    abandoning: new Set<string>(),
    runnerOptions: () => {
      const last = rig.allRunnerOptions.at(-1)
      if (!last) {
        throw new Error('runner never created')
      }
      return last
    },
    createRunnerFn: (options) => {
      rig.allRunnerOptions.push(options)
      return {
        start: (task) => {
          rig.starts.push(task)
          return { ok: true }
        },
        reply: (id, message) => {
          rig.replies.push({ id, message })
          return { ok: false, code: 409, error: 'task is not waiting for a reply' }
        },
        resume: (id) => {
          rig.resumes.push(id)
          return { ok: true }
        },
        interrupt: (id) => {
          rig.interrupts.push(id)
          return { ok: true }
        },
        abandon: (id) => {
          rig.abandons.push(id)
          return Promise.resolve({ ok: true as const })
        },
        isAbandoning: (id) => rig.abandoning.has(id),
        shutdown: () => Promise.resolve(),
        runningCount: () => 0,
      }
    },
  }
  return rig
}

const managerOpts = { command: 'claude -p', timeoutMs: 1000 }

// --- createTaskManager ----------------------------------------------------

describe('createTaskManager', () => {
  test('boot marks orphaned running/reviewing tasks as interrupted, across EVERY project', () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    register(repoA)
    register(repoB)
    const running = seedTask(repoA, 'was running')
    running.status = 'running'
    saveTask(repoA, running)
    const reviewing = seedTask(repoB, 'was reviewing')
    reviewing.status = 'reviewing'
    saveTask(repoB, reviewing)
    const waiting = seedTask(repoA, 'was waiting')
    waiting.status = 'waiting_for_you'
    saveTask(repoA, waiting)
    const queued = seedTask(repoB, 'still queued')

    createTaskManager({ ...managerOpts, ...fakeRunner() })

    for (const [cwd, id] of [
      [repoA, running.id],
      [repoB, reviewing.id],
    ] as const) {
      const record = loadTask(cwd, id)
      expect(record?.status).toBe('interrupted')
      expect(record?.turns.at(-1)?.ended_at).not.toBeNull()
      expect(readTaskEvents(cwd, id).map((e) => e.type)).toContain('interrupted')
    }
    // Untouched states stay untouched: only dead-process states are rewritten.
    expect(loadTask(repoA, waiting.id)?.status).toBe('waiting_for_you')
    // A 'queued' record in a repo that has NO queue.json was orphaned by a
    // session that died before it could run: it is not a task waiting its
    // turn, and no boot gets to start an agent on it by surprise. It becomes
    // 'interrupted' — the state a human Resume knows how to pick up — and the
    // WHY is in its journal.
    expect(loadTask(repoB, queued.id)?.status).toBe('interrupted')
    expect(readTaskEvents(repoB, queued.id).map((e) => ({ type: e.type, data: e.data }))).toEqual([
      {
        type: 'interrupted',
        data: { message: 'orphaned by an earlier session: nothing was queued to start it' },
      },
    ])
    // Nothing was enqueued, and no queue file was conjured for it either.
    expect(existsSync(queuePath(repoB))).toBe(false)
  })

  // T8. A worktree is a VIEW; the branch is where the commits live. Boot
  // therefore judges a vanished worktree on its branch: still there means the
  // runner checks it back out — same branch, same anchor, nothing stranded —
  // so the task stays resumable. Gone too means the work is unrecoverable, and
  // only that is 'failed', said out loud.
  test('boot judges a vanished worktree on its BRANCH, not on the checkout', () => {
    const repo = makeRepo()
    register(repo)
    const lost = seedTask(repo, 'worktree deleted by hand')
    lost.status = 'interrupted'
    lost.worktree = join(repo, '.codesema', 'worktrees', lost.id)
    saveTask(repo, lost)
    // Same accident, but the branch survived it: the work is one checkout away.
    const recoverable = seedTask(repo, 'worktree deleted, branch alive')
    recoverable.status = 'interrupted'
    recoverable.worktree = join(repo, '.codesema', 'worktrees', recoverable.id)
    recoverable.branch = 'codesema/task-alive'
    execFileSync('git', ['branch', 'codesema/task-alive'], { cwd: repo })
    saveTask(repo, recoverable)
    // Never materialized one (a task interrupted while still queued): it has
    // nothing to lose, and its resume simply creates the worktree.
    const neverMaterialized = seedTask(repo, 'stopped while queued')
    neverMaterialized.status = 'interrupted'
    saveTask(repo, neverMaterialized)

    createTaskManager({ ...managerOpts, ...fakeRunner() })

    expect(loadTask(repo, lost.id)?.status).toBe('failed')
    expect(readTaskEvents(repo, lost.id).at(-1)).toMatchObject({
      type: 'error',
      data: { message: 'worktree and branch are both gone, the task cannot be resumed' },
    })
    expect(loadTask(repo, recoverable.id)?.status).toBe('interrupted')
    expect(readTaskEvents(repo, recoverable.id)).toHaveLength(0)
    // The code must agree with the status AND with the message beside it: the
    // work is unreachable, waiting changes nothing, so it is TERMINAL. A
    // retryable code here (it used to be `agent_error`) makes a consumer offer
    // a new attempt that the API then refuses.
    const lostReason = loadTask(repo, lost.id)?.reason
    expect(lostReason?.detail).toBe('worktree and branch are both gone, the task cannot be resumed')
    expect(lostReason && isTerminalReason(lostReason.code)).toBe(true)
    expect(readTaskEvents(repo, lost.id).at(-1)?.reason_code).toBe(lostReason?.code)
    expect(loadTask(repo, neverMaterialized.id)?.status).toBe('interrupted')
    expect(readTaskEvents(repo, neverMaterialized.id)).toHaveLength(0)
  })

  test('boot keeps an interrupted task whose worktree is still on disk', () => {
    const repo = makeRepo()
    register(repo)
    const alive = seedTask(repo, 'stopped mid-turn')
    alive.status = 'interrupted'
    alive.worktree = join(repo, '.codesema', 'worktrees', alive.id)
    mkdirSync(alive.worktree, { recursive: true })
    saveTask(repo, alive)

    createTaskManager({ ...managerOpts, ...fakeRunner() })

    expect(loadTask(repo, alive.id)?.status).toBe('interrupted')
    expect(readTaskEvents(repo, alive.id)).toHaveLength(0)
  })

  test('every scoped call on an unregistered project is a 404, never a crash', async () => {
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })

    const input = { title: 't', prompt: 'p', autoShip: false }
    expect(manager.list('deadbeef')).toBeNull()
    expect(manager.get('deadbeef', 'aaaaaaaaaaaa')).toBeNull()
    expect(manager.create('deadbeef', input)).toEqual({
      ok: false,
      code: 404,
      error: 'unknown project',
    })
    expect(manager.reply('deadbeef', 'aaaaaaaaaaaa', 'hi')).toMatchObject({ ok: false, code: 404 })
    expect(manager.interrupt('deadbeef', 'aaaaaaaaaaaa')).toMatchObject({ ok: false, code: 404 })
    expect(manager.resume('deadbeef', 'aaaaaaaaaaaa')).toMatchObject({ ok: false, code: 404 })
    expect(await manager.ship('deadbeef', 'aaaaaaaaaaaa')).toMatchObject({ ok: false, code: 404 })
    expect(await manager.abandon('deadbeef', 'aaaaaaaaaaaa')).toMatchObject({
      ok: false,
      code: 404,
    })
    expect(rig.allRunnerOptions).toHaveLength(0)
  })

  test('isolation: an available cage makes new tasks caged, and says so in the journal', () => {
    const project = register(makeRepo())
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      isolation: {
        available: true,
        mode: 'container',
        reason: 'podman is available',
        configured: 'auto',
        runtime: 'podman',
      },
    })
    const created = manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    expect(created.ok).toBe(true)
    const record = created.ok ? created.record : null
    expect(record?.isolation).toBe('container')
    // Persisted, not just returned: the runner reads the record from disk.
    expect(loadTask(project.path, record?.id ?? '')?.isolation).toBe('container')
    const isolation = readTaskEvents(project.path, record?.id ?? '').find(
      (event) => event.type === 'isolation',
    )
    expect(isolation?.data).toMatchObject({ isolation: 'container', reason: 'podman is available' })
  })

  test("isolation 'auto' without a cage falls back to policy WITH the reason journaled", () => {
    const project = register(makeRepo())
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      isolation: {
        available: false,
        mode: 'policy',
        reason: 'no container runtime found (install docker or podman)',
        configured: 'auto',
        runtime: null,
      },
    })
    const created = manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    expect(created.ok).toBe(true)
    const id = created.ok ? created.record.id : ''
    expect(loadTask(project.path, id)?.isolation).toBe('policy')
    const isolation = readTaskEvents(project.path, id).find((event) => event.type === 'isolation')
    expect(isolation?.data.isolation).toBe('policy')
    expect(String(isolation?.data.reason)).toContain('no container runtime found')
  })

  test("isolation 'container' with no cage refuses the creation (409), leaving nothing behind", () => {
    const project = register(makeRepo())
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      isolation: {
        available: false,
        mode: 'policy',
        reason: 'docker is installed but its engine does not answer',
        configured: 'container',
        runtime: 'docker',
      },
    })
    const created = manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    expect(created).toMatchObject({ ok: false, code: 409 })
    expect(created.ok ? '' : created.error).toContain('does not answer')
    expect(listTasks(project.path)).toHaveLength(0)
    expect(rig.starts).toHaveLength(0)
  })

  test('the cage-unavailable 409 names itself resource_busy, message untouched', () => {
    const project = register(makeRepo())
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      isolation: {
        available: false,
        mode: 'policy',
        reason: 'docker is installed but its engine does not answer',
        configured: 'container',
        runtime: 'docker',
      },
    })
    const created = manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    // The code is ADDED beside the readable error, which is unchanged.
    expect(created).toMatchObject({
      ok: false,
      code: 409,
      reason_code: 'resource_busy',
      error: expect.stringContaining('does not answer'),
    })
  })

  test('a refusal the vocabulary has no word for carries no code at all', () => {
    const project = register(makeRepo())
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
    const refused = manager.create(project.id, {
      title: 't',
      prompt: 'p',
      autoShip: false,
      base: 'nope',
      branch: 'also-nope',
    })
    expect(refused).toMatchObject({ ok: false, code: 400 })
    expect(refused.ok ? true : 'reason_code' in refused).toBe(false)
  })

  test('an unprobed manager creates policy tasks: nothing pretends to be caged', () => {
    const project = register(makeRepo())
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
    const created = manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    expect(created.ok && created.record.isolation).toBe('policy')
    expect(manager.workspaceInfo()).toMatchObject({
      isolation_available: false,
      isolation_default: 'policy',
    })
  })

  test('workspaceInfo reports the probe verbatim, reason included', () => {
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      isolation: {
        available: true,
        mode: 'container',
        reason: 'docker is available',
        configured: 'auto',
        runtime: 'docker',
      },
    })
    expect(manager.workspaceInfo()).toEqual({
      isolation_available: true,
      isolation_default: 'container',
      isolation_reason: 'docker is available',
      isolation_configured: 'auto',
    })
  })

  test('the egress allowlist and the repo checks config reach the runner', () => {
    const project = register(makeRepo())
    mkdirSync(join(project.path, '.codesema'), { recursive: true })
    writeFileSync(
      join(project.path, '.codesema', 'config.json'),
      JSON.stringify({ checks: { image: 'oven/bun:1', commands: ['bun test'] } }),
    )
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      allowedDomains: ['api.anthropic.com', 'registry.npmjs.org'],
    })
    manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    const options = rig.runnerOptions()
    expect(options.allowedDomains).toEqual(['api.anthropic.com', 'registry.npmjs.org'])
    expect(options.checksConfig?.image).toBe('oven/bun:1')
  })

  test('create validates title and prompt before touching the store', () => {
    const project = register(makeRepo())
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })

    const base = { prompt: 'do it', autoShip: false }
    expect(manager.create(project.id, { ...base, title: '   ' })).toMatchObject({
      ok: false,
      code: 400,
    })
    expect(manager.create(project.id, { ...base, title: 'x'.repeat(201) })).toMatchObject({
      ok: false,
      code: 400,
    })
    expect(manager.create(project.id, { title: 't', prompt: '', autoShip: false })).toMatchObject({
      ok: false,
      code: 400,
    })
    expect(
      manager.create(project.id, { title: 't', prompt: 'p'.repeat(20_001), autoShip: false }),
    ).toMatchObject({ ok: false, code: 400 })
    expect(manager.list(project.id)).toHaveLength(0)
    expect(rig.starts).toHaveLength(0)
  })

  test('create validates an explicit base: unknown, option-lookalike and oversized are 400', () => {
    const repo = makeRepo()
    execFileSync('git', ['branch', 'feature'], { cwd: repo, stdio: 'ignore' })
    const project = register(repo)
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })

    const input = { title: 't', prompt: 'p', autoShip: false }
    expect(manager.create(project.id, { ...input, base: 'nope' })).toMatchObject({
      ok: false,
      code: 400,
      error: expect.stringContaining('nope'),
    })
    expect(manager.create(project.id, { ...input, base: '-evil' })).toMatchObject({
      ok: false,
      code: 400,
    })
    expect(manager.create(project.id, { ...input, base: 'b'.repeat(201) })).toMatchObject({
      ok: false,
      code: 400,
    })
    // Nothing was persisted or handed to the runner by the refusals.
    expect(manager.list(project.id)).toHaveLength(0)
    expect(rig.starts).toHaveLength(0)

    // Valid base (trimmed): recorded on the task, branch/worktree still lazy.
    const created = manager.create(project.id, { ...input, base: '  feature  ' })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }
    expect(created.record.base).toBe('feature')
    expect(created.record.branch).toBe('')
    expect(loadTask(repo, created.record.id)?.base).toBe('feature')
    expect(rig.starts.map((r) => r.id)).toEqual([created.record.id])

    // A blank base means absent: auto-detection at launch, base stays empty.
    const blank = manager.create(project.id, { ...input, base: '   ' })
    expect(blank.ok).toBe(true)
    if (blank.ok) {
      expect(blank.record.base).toBe('')
    }
  })

  test('create work-on: branch/base exclusivity and branch validation are 400, nothing persisted', () => {
    const repo = makeRepo()
    execFileSync('git', ['branch', 'feature'], { cwd: repo, stdio: 'ignore' })
    const project = register(repo)
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })

    const input = { title: 't', prompt: 'p', autoShip: false }
    expect(manager.create(project.id, { ...input, branch: 'feature', base: 'main' })).toMatchObject(
      { ok: false, code: 400, error: expect.stringContaining('exclusive') },
    )
    expect(manager.create(project.id, { ...input, branch: 'ghost' })).toMatchObject({
      ok: false,
      code: 400,
      error: expect.stringContaining('ghost'),
    })
    expect(manager.create(project.id, { ...input, branch: '-evil' })).toMatchObject({
      ok: false,
      code: 400,
    })
    expect(manager.create(project.id, { ...input, branch: 'b'.repeat(201) })).toMatchObject({
      ok: false,
      code: 400,
    })
    expect(manager.list(project.id)).toHaveLength(0)
    expect(rig.starts).toHaveLength(0)
  })

  test('create work-on: records the branch verbatim, work_on, and the MR target as base', () => {
    const repo = makeRepo()
    const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    run(['branch', 'feature'])
    run(['branch', 'feature-two'])
    run(['branch', 'feature-three'])
    // An MR target may only exist on origin: simulate a remote-only 'release'.
    run(['update-ref', 'refs/remotes/origin/release', 'main'])
    const project = register(repo)
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })
    const input = { title: 't', prompt: 'p', autoShip: false }

    // No target: base is the same trunk auto-detection as fork mode.
    const plain = manager.create(project.id, { ...input, branch: '  feature  ' })
    expect(plain.ok).toBe(true)
    if (!plain.ok) {
      return
    }
    expect(plain.record.branch).toBe('feature')
    expect(plain.record.work_on).toBe(true)
    expect(plain.record.base).toBe('main')
    // The worktree stays lazy, as in fork mode: the runner materializes it.
    expect(plain.record.worktree).toBe('')
    expect(loadTask(repo, plain.record.id)).toMatchObject({ branch: 'feature', work_on: true })
    expect(rig.starts.map((r) => r.id)).toEqual([plain.record.id])

    // A remote-only target resolves and becomes the base.
    const targeted = manager.create(project.id, {
      ...input,
      branch: 'feature-two',
      target: 'release',
    })
    expect(targeted.ok).toBe(true)
    if (targeted.ok) {
      expect(targeted.record.base).toBe('release')
    }

    // An unresolvable target falls back to auto-detection — never a 400.
    const bogus = manager.create(project.id, { ...input, branch: 'feature-three', target: 'nope' })
    expect(bogus.ok).toBe(true)
    if (bogus.ok) {
      expect(bogus.record.base).toBe('main')
    }
  })

  test('create work-on: ONE active conversation per branch — 409 with existing_task_id; terminal tasks never block', () => {
    const repo = makeRepo()
    execFileSync('git', ['branch', 'feature'], { cwd: repo, stdio: 'ignore' })
    const project = register(repo)
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })
    const seeded = seedTask(repo, 'already there')
    seeded.branch = 'feature'
    seeded.status = 'waiting_for_you'
    saveTask(repo, seeded)

    const input = { title: 't', prompt: 'p', autoShip: false }
    const refused = manager.create(project.id, { ...input, branch: 'feature' })
    expect(refused).toMatchObject({
      ok: false,
      code: 409,
      error: expect.stringContaining('feature'),
      existing_task_id: seeded.id,
    })
    expect(manager.list(project.id)).toHaveLength(1)

    // shipped (and failed) are terminal: the branch is free again.
    seeded.status = 'shipped'
    saveTask(repo, seeded)
    const allowed = manager.create(project.id, { ...input, branch: 'feature' })
    expect(allowed.ok).toBe(true)
  })

  test('create work-on: a branch checked out in ANY worktree (main included) is a 409, nothing persisted', () => {
    const repo = makeRepo()
    const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    run(['branch', 'feature'])
    run(['worktree', 'add', join(repo, '.codesema', 'elsewhere'), 'feature'])
    const project = register(repo)
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })
    const input = { title: 't', prompt: 'p', autoShip: false }

    // 'main' is held by the MAIN worktree.
    expect(manager.create(project.id, { ...input, branch: 'main' })).toMatchObject({
      ok: false,
      code: 409,
      error: expect.stringContaining('checked out'),
    })
    // 'feature' is held by a secondary worktree.
    expect(manager.create(project.id, { ...input, branch: 'feature' })).toMatchObject({
      ok: false,
      code: 409,
      error: expect.stringContaining('checked out'),
    })
    expect(manager.list(project.id)).toHaveLength(0)
    expect(rig.starts).toHaveLength(0)
  })

  test('create persists a queued task in ITS project repo, broadcasts, hands to the runner', () => {
    const projectA = register(makeRepo())
    const projectB = register(makeRepo())
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })
    const envelopes: TaskEnvelope[] = []
    manager.subscribe((envelope) => envelopes.push(envelope))

    const created = manager.create(projectB.id, {
      title: '  Audit the auth flow  ',
      prompt: 'look at login',
      autoShip: true,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }
    // The task lives in project B's repo — and ONLY there.
    const onDisk = loadTask(projectB.path, created.record.id)
    expect(onDisk).toMatchObject({
      title: 'Audit the auth flow',
      status: 'queued',
      auto_ship: true,
    })
    expect(onDisk?.turns[0]?.prompt).toBe('look at login')
    expect(loadTask(projectA.path, created.record.id)).toBeNull()
    expect(manager.list(projectA.id)).toHaveLength(0)
    expect(rig.starts.map((r) => r.id)).toEqual([created.record.id])
    // The runner was built for project B's repo.
    expect(rig.runnerOptions().cwd).toBe(projectB.path)
    expect(envelopes).toMatchObject([
      {
        project_id: projectB.id,
        task_id: created.record.id,
        event: { name: 'task', data: created.record },
      },
      // The isolation decision is broadcast with the record it belongs to.
      {
        project_id: projectB.id,
        task_id: created.record.id,
        event: { name: 'task_event', data: { type: 'isolation' } },
      },
    ])
  })

  test('runner hooks fan out as project-scoped task / task_event / task_text envelopes', () => {
    const project = register(makeRepo())
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })
    const envelopes: TaskEnvelope[] = []
    const unsubscribe = manager.subscribe((envelope) => envelopes.push(envelope))

    const record = seedTask(project.path)
    // Touch the project so its runner (and hooks) exist.
    expect(manager.interrupt(project.id, record.id)).toEqual({ ok: true })
    const event: TaskEvent = { seq: 1, at: new Date().toISOString(), type: 'message', data: {} }
    const hooks = rig.runnerOptions()
    hooks.onTask?.(record)
    hooks.onEvent?.(record.id, event)
    hooks.onText?.(record.id, 'streamed text')

    expect(envelopes).toEqual([
      { project_id: project.id, task_id: record.id, event: { name: 'task', data: record } },
      { project_id: project.id, task_id: record.id, event: { name: 'task_event', data: event } },
      {
        project_id: project.id,
        task_id: record.id,
        event: { name: 'task_text', data: { text: 'streamed text' } },
      },
    ])

    unsubscribe()
    hooks.onText?.(record.id, 'after unsubscribe')
    expect(envelopes).toHaveLength(3)
  })

  test('task_text carries the message index when there is one, and nothing when there is not', () => {
    const project = register(makeRepo())
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })
    const envelopes: TaskEnvelope[] = []
    manager.subscribe((envelope) => envelopes.push(envelope))

    const record = seedTask(project.path)
    expect(manager.interrupt(project.id, record.id)).toEqual({ ok: true })
    const hooks = rig.runnerOptions()
    // The agent's second message of the turn: an indexed bubble.
    hooks.onText?.(record.id, 'second message', 1)
    // The review's progress line: no index, it replaces the previous line.
    hooks.onText?.(record.id, 'reading the diff')

    expect(envelopes.filter((e) => e.event.name === 'task_text')).toEqual([
      {
        project_id: project.id,
        task_id: record.id,
        event: { name: 'task_text', data: { text: 'second message', seq: 1 } },
      },
      {
        project_id: project.id,
        task_id: record.id,
        event: { name: 'task_text', data: { text: 'reading the diff' } },
      },
    ])
  })

  test('reply and interrupt delegate to the right project runner and propagate its verdict', () => {
    const projectA = register(makeRepo())
    const projectB = register(makeRepo())
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })

    expect(manager.reply(projectA.id, 'aaaaaaaaaaaa', 'hello')).toMatchObject({
      ok: false,
      code: 409,
    })
    expect(rig.replies).toEqual([{ id: 'aaaaaaaaaaaa', message: 'hello' }])
    expect(manager.interrupt(projectB.id, 'bbbbbbbbbbbb')).toEqual({ ok: true })
    expect(rig.interrupts).toEqual(['bbbbbbbbbbbb'])
    expect(manager.resume(projectB.id, 'bbbbbbbbbbbb')).toEqual({ ok: true })
    expect(rig.resumes).toEqual(['bbbbbbbbbbbb'])
    // One runner per touched project, each bound to its own repo.
    expect(rig.allRunnerOptions.map((o) => o.cwd)).toEqual([projectA.path, projectB.path])
  })

  test('get is project-scoped: a task is only reachable through ITS project', () => {
    const projectA = register(makeRepo())
    const projectB = register(makeRepo())
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
    const record = seedTask(projectA.path)

    const found = manager.get(projectA.id, record.id)
    expect(found?.record.id).toBe(record.id)
    expect(found?.events).toEqual([])
    expect(manager.get(projectB.id, record.id)).toBeNull()
    expect(manager.get(projectA.id, 'aaaaaaaaaaaa')).toBeNull()
    expect(manager.get(projectA.id, '../escape')).toBeNull()
  })

  test('listAll aggregates every registered project with its tasks', () => {
    const projectA = register(makeRepo())
    const projectB = register(makeRepo())
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
    const a = seedTask(projectA.path, 'in A')
    const b1 = seedTask(projectB.path, 'in B one')
    const b2 = seedTask(projectB.path, 'in B two')

    const all = manager.listAll()
    expect(all.map((entry) => entry.project.id)).toEqual([projectA.id, projectB.id])
    expect(all[0]?.records.map((r) => r.id)).toEqual([a.id])
    expect(new Set(all[1]?.records.map((r) => r.id))).toEqual(new Set([b1.id, b2.id]))
  })
})

// --- manager.ship (T5) ----------------------------------------------------

/** A task parked on a post-review status, as the reviewer leaves it. */
function seedShippable(cwd: string, status: 'review_ok' | 'review_ko' = 'review_ok'): TaskRecord {
  const record = seedTask(cwd, 'shippable task')
  record.status = status
  record.base = 'origin/main'
  record.branch = 'codesema/task-shippable-task'
  record.worktree = join(cwd, '.codesema', 'worktrees', record.id)
  saveTask(cwd, record)
  return record
}

function shipStub(outcome: ShipOutcome | Promise<ShipOutcome>) {
  const calls: ShipTaskOptions[] = []
  const fn = (options: ShipTaskOptions): Promise<ShipOutcome> => {
    calls.push(options)
    return Promise.resolve(outcome)
  }
  return { calls, fn }
}

describe('manager.ship', () => {
  test('gate: only review_ok / review_ko ship; shipped and unknown ids refuse', async () => {
    const project = register(makeRepo())
    const cwd = project.path
    const stub = shipStub({ pushed: true, mrUrl: null, note: null })
    const manager = createTaskManager({ ...managerOpts, shipTaskFn: stub.fn, ...fakeRunner() })

    expect(await manager.ship(project.id, 'aaaaaaaaaaaa')).toMatchObject({ ok: false, code: 404 })
    const queued = seedTask(cwd, 'still queued')
    expect(await manager.ship(project.id, queued.id)).toEqual({
      ok: false,
      code: 409,
      error: 'task is queued',
    })
    const waiting = seedTask(cwd, 'waiting')
    waiting.status = 'waiting_for_you'
    saveTask(cwd, waiting)
    expect(await manager.ship(project.id, waiting.id)).toMatchObject({ ok: false, code: 409 })
    const shipped = seedShippable(cwd)
    shipped.status = 'shipped'
    saveTask(cwd, shipped)
    // Idempotence: a second ship must never open a double MR.
    expect(await manager.ship(project.id, shipped.id)).toEqual({
      ok: false,
      code: 409,
      error: 'task is already shipped',
    })
    expect(stub.calls).toHaveLength(0)
  })

  test('review_ok ship: shipped event with the MR URL, record flips to shipped', async () => {
    const project = register(makeRepo())
    const cwd = project.path
    const stub = shipStub({ pushed: true, mrUrl: 'https://github.com/o/r/pull/9', note: null })
    const manager = createTaskManager({ ...managerOpts, shipTaskFn: stub.fn, ...fakeRunner() })
    const record = seedShippable(cwd)
    const envelopes: TaskEnvelope[] = []
    manager.subscribe((envelope) => envelopes.push(envelope))

    expect(await manager.ship(project.id, record.id)).toEqual({ ok: true })
    // The ship runs in the PROJECT's repo (push + forge CLI cwd).
    expect(stub.calls).toMatchObject([{ cwd, task: { id: record.id } }])
    expect(loadTask(cwd, record.id)?.status).toBe('shipped')
    const events = readTaskEvents(cwd, record.id)
    expect(events).toMatchObject([
      { type: 'shipped', data: { mr_url: 'https://github.com/o/r/pull/9' } },
    ])
    // Journal event first, then the full record — store-first, like the runner.
    expect(envelopes.map((e) => e.event.name)).toEqual(['task_event', 'task'])
    expect(envelopes.every((e) => e.project_id === project.id)).toBe(true)
    expect(envelopes.at(-1)?.event.data).toMatchObject({ status: 'shipped' })
  })

  test('ship without a forge CLI: the shipped event and the record both name it', async () => {
    const project = register(makeRepo())
    const cwd = project.path
    const note =
      'no forge CLI (gh or glab) available — branch pushed, open the merge request manually'
    const stub = shipStub({ pushed: true, mrUrl: null, note, reasonCode: 'forge_unreachable' })
    const manager = createTaskManager({ ...managerOpts, shipTaskFn: stub.fn, ...fakeRunner() })
    const record = seedShippable(cwd)

    expect(await manager.ship(project.id, record.id)).toEqual({ ok: true })
    // The journal keeps the note it always carried, and gains the code beside it.
    expect(readTaskEvents(cwd, record.id)).toMatchObject([
      { type: 'shipped', data: { mr_url: null, note }, reason_code: 'forge_unreachable' },
    ])
    expect(loadTask(cwd, record.id)?.reason).toEqual({ code: 'forge_unreachable', detail: note })
    // Shipped all the same: the branch IS on origin.
    expect(loadTask(cwd, record.id)?.status).toBe('shipped')
  })

  test('a ship that opened its MR clears any reason the task was carrying', async () => {
    const project = register(makeRepo())
    const cwd = project.path
    const stub = shipStub({ pushed: true, mrUrl: 'https://github.com/o/r/pull/9', note: null })
    const manager = createTaskManager({ ...managerOpts, shipTaskFn: stub.fn, ...fakeRunner() })
    const record = seedShippable(cwd, 'review_ko')
    record.reason = { code: 'review_blocked', detail: 'review failed: agent timed out' }
    saveTask(cwd, record)

    expect(await manager.ship(project.id, record.id)).toEqual({ ok: true })
    const shipped = loadTask(cwd, record.id)
    expect(shipped && 'reason' in shipped).toBe(false)
    expect(readTaskEvents(cwd, record.id)[0]).not.toHaveProperty('reason_code')
  })

  test('push failure: status unchanged, readable error event, 502 result', async () => {
    const project = register(makeRepo())
    const cwd = project.path
    const stub = shipStub({ pushed: false, error: 'git push failed: permission denied' })
    const manager = createTaskManager({ ...managerOpts, shipTaskFn: stub.fn, ...fakeRunner() })
    const record = seedShippable(cwd)

    expect(await manager.ship(project.id, record.id)).toEqual({
      ok: false,
      code: 502,
      error: 'git push failed: permission denied',
    })
    // Retryable: the task is exactly where it was before the attempt.
    expect(loadTask(cwd, record.id)?.status).toBe('review_ok')
    expect(readTaskEvents(cwd, record.id)).toMatchObject([
      { type: 'error', data: { message: 'git push failed: permission denied' } },
    ])
  })

  test('a rejecting shipTaskFn degrades to a push failure, never a crash', async () => {
    const project = register(makeRepo())
    const manager = createTaskManager({
      ...managerOpts,
      shipTaskFn: () => Promise.reject(new Error('boom')),
      ...fakeRunner(),
    })
    const record = seedShippable(project.path)
    expect(await manager.ship(project.id, record.id)).toEqual({
      ok: false,
      code: 502,
      error: 'boom',
    })
    expect(loadTask(project.path, record.id)?.status).toBe('review_ok')
  })

  test('while a ship is in flight: reply, abandon and a second ship are refused', async () => {
    const project = register(makeRepo())
    let release!: (outcome: ShipOutcome) => void
    const pending = new Promise<ShipOutcome>((resolve) => {
      release = resolve
    })
    const manager = createTaskManager({
      ...managerOpts,
      shipTaskFn: () => pending,
      ...fakeRunner(),
    })
    const record = seedShippable(project.path)

    // ship() runs synchronously up to its first await: the in-flight guard is
    // set before this call returns, no yield needed.
    const inFlight = manager.ship(project.id, record.id)
    expect(await manager.ship(project.id, record.id)).toEqual({
      ok: false,
      code: 409,
      error: 'ship already in progress',
    })
    expect(manager.reply(project.id, record.id, 'wait')).toEqual({
      ok: false,
      code: 409,
      error: 'ship in progress',
    })
    expect(await manager.abandon(project.id, record.id)).toEqual({
      ok: false,
      code: 409,
      error: 'ship in progress',
    })
    // A resume would start a turn (and a commit) under the branch being
    // pushed: same wait as a reply.
    expect(manager.resume(project.id, record.id)).toEqual({
      ok: false,
      code: 409,
      error: 'ship in progress',
    })
    release({ pushed: true, mrUrl: null, note: null })
    expect(await inFlight).toEqual({ ok: true })
    expect(loadTask(project.path, record.id)?.status).toBe('shipped')
  })

  test('ship and abandon refuse each other, in BOTH directions', async () => {
    const project = register(makeRepo())
    const rig = fakeRunner()
    let release!: (outcome: ShipOutcome) => void
    const pending = new Promise<ShipOutcome>((resolve) => {
      release = resolve
    })
    const manager = createTaskManager({ ...managerOpts, shipTaskFn: () => pending, ...rig })
    const record = seedShippable(project.path)

    // Direction 1 — abandon in flight, ship arrives. The abandon is deleting
    // this very worktree and will write the record when it lands: a push from
    // a directory being removed is broken at best, and whichever settled last
    // would erase the other's outcome. Guarding only the other way would leave
    // exactly half the race open.
    rig.abandoning.add(record.id)
    expect(await manager.ship(project.id, record.id)).toEqual({
      ok: false,
      code: 409,
      error: 'task is being abandoned',
    })
    rig.abandoning.delete(record.id)

    // Direction 2 — ship in flight, abandon arrives.
    const inFlight = manager.ship(project.id, record.id)
    expect(await manager.abandon(project.id, record.id)).toEqual({
      ok: false,
      code: 409,
      error: 'ship in progress',
    })
    expect(rig.abandons).toEqual([])
    release({ pushed: true, mrUrl: null, note: null })
    expect(await inFlight).toEqual({ ok: true })
  })

  test('a successful ship releases the HOME volume of a container-isolated task', async () => {
    const project = register(makeRepo())
    const cwd = project.path
    const stub = shipStub({ pushed: true, mrUrl: null, note: null })
    const released: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      shipTaskFn: stub.fn,
      ...fakeRunner(),
      releaseAgentHomeFn: (opts) => {
        released.push(opts.taskId)
        return Promise.resolve({ released: true })
      },
    })
    const record = seedShippable(cwd)
    record.isolation = 'container'
    saveTask(cwd, record)

    expect(await manager.ship(project.id, record.id)).toEqual({ ok: true })

    expect(released).toEqual([record.id])
    const event = readTaskEvents(cwd, record.id).find((e) => e.type === 'resource')
    expect(event?.data.name).toBe('home_volume_released')
    expect(event?.reason_code).toBeUndefined()
  })

  test('ship on a policy-isolated task never attempts a release', async () => {
    const project = register(makeRepo())
    const cwd = project.path
    const stub = shipStub({ pushed: true, mrUrl: null, note: null })
    let calls = 0
    const manager = createTaskManager({
      ...managerOpts,
      shipTaskFn: stub.fn,
      ...fakeRunner(),
      releaseAgentHomeFn: () => {
        calls++
        return Promise.resolve({ released: true })
      },
    })
    const record = seedShippable(cwd) // default isolation: 'policy'

    expect(await manager.ship(project.id, record.id)).toEqual({ ok: true })

    expect(calls).toBe(0)
    expect(readTaskEvents(cwd, record.id).find((e) => e.type === 'resource')).toBeUndefined()
  })

  test('a release failure is named and journaled, and never turns the ship into a failure', async () => {
    const project = register(makeRepo())
    const cwd = project.path
    const stub = shipStub({ pushed: true, mrUrl: 'https://github.com/o/r/pull/1', note: null })
    const manager = createTaskManager({
      ...managerOpts,
      shipTaskFn: stub.fn,
      ...fakeRunner(),
      releaseAgentHomeFn: () =>
        Promise.resolve({ released: false, reason: 'rm-failed', detail: 'daemon busy' }),
    })
    const record = seedShippable(cwd)
    record.isolation = 'container'
    saveTask(cwd, record)

    expect(await manager.ship(project.id, record.id)).toEqual({ ok: true })

    expect(loadTask(cwd, record.id)?.status).toBe('shipped')
    const event = readTaskEvents(cwd, record.id).find((e) => e.type === 'resource')
    expect(event?.data.name).toBe('home_volume_not_released')
    expect(String(event?.data.message)).toContain('daemon busy')
    expect(event?.reason_code).toBeUndefined()
  })

  test('no container runtime at ship time: named distinctly from an ordinary release failure', async () => {
    const project = register(makeRepo())
    const cwd = project.path
    const stub = shipStub({ pushed: true, mrUrl: null, note: null })
    const manager = createTaskManager({
      ...managerOpts,
      shipTaskFn: stub.fn,
      ...fakeRunner(),
      releaseAgentHomeFn: () => Promise.resolve({ released: false, reason: 'no-runtime' }),
    })
    const record = seedShippable(cwd)
    record.isolation = 'container'
    saveTask(cwd, record)

    expect(await manager.ship(project.id, record.id)).toEqual({ ok: true })

    const event = readTaskEvents(cwd, record.id).find((e) => e.type === 'resource')
    expect(event?.data.name).toBe('container_runtime_absent')
  })
})

// --- manager.checks -------------------------------------------------------

/** A finished TaskChecks the injected runChecksFn can resolve with. */
function finishedChecks(over: Partial<TaskChecks> = {}): TaskChecks {
  return {
    head_sha: 'abc123',
    started_at: '2026-08-14T10:00:00.000Z',
    finished_at: '2026-08-14T10:01:00.000Z',
    status: 'passed',
    checks: [
      { command: 'bun test', status: 'passed', exit_code: 0, duration_ms: 500, tail: 'ok\n' },
    ],
    error: null,
    ...over,
  }
}

/** Seeds a task that HAS committed work: worktree = a real repo, commit event in the journal. */
function seedCommittedTask(projectPath: string): { record: TaskRecord; worktree: string } {
  const worktree = makeRepo()
  const record = seedTask(projectPath)
  record.worktree = worktree
  saveTask(projectPath, record)
  appendTaskEvent(projectPath, record.id, {
    type: 'commit',
    data: { sha: 'abc', files_changed: 1, turn: record.turns.length },
  })
  return { record, worktree }
}

describe('manager.checks', () => {
  test('guards: no commit is a 409, unknown task/project are 404, gone worktree is a 409', () => {
    const project = register(makeRepo())
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      createRunnerFn: rig.createRunnerFn,
      reviewTurnFn: async () => {},
      runChecksFn: () => Promise.resolve(finishedChecks()),
    })
    const record = seedTask(project.path)
    expect(manager.checks(project.id, record.id)).toEqual({
      ok: false,
      code: 409,
      error: 'task has no commit to check',
    })
    expect(manager.checks(project.id, 'aaaaaaaaaaaa')).toMatchObject({ ok: false, code: 404 })
    expect(manager.checks('ghost', record.id)).toMatchObject({ ok: false, code: 404 })
    // A commit event alone is not enough: the worktree must still exist.
    appendTaskEvent(project.path, record.id, { type: 'commit', data: { turn: 1 } })
    expect(manager.checks(project.id, record.id)).toMatchObject({ ok: false, code: 409 })
    // Nothing was ever written for the task.
    expect(readTaskChecks(project.path, record.id)).toBeNull()
    expect(manager.getChecks(project.id, record.id)).toBeNull()
  })

  test('manual run: running is visible immediately, 409 while in flight, final + journal event after', async () => {
    const project = register(makeRepo())
    const { record, worktree } = seedCommittedTask(project.path)
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree }).toString().trim()

    let release!: (checks: TaskChecks) => void
    const gate = new Promise<TaskChecks>((resolve) => {
      release = resolve
    })
    const seen: RunChecksOptions[] = []
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      createRunnerFn: rig.createRunnerFn,
      reviewTurnFn: async () => {},
      runChecksFn: (options) => {
        seen.push(options)
        return gate
      },
    })
    const envelopes: TaskEnvelope[] = []
    manager.subscribe((envelope) => envelopes.push(envelope))

    expect(manager.checks(project.id, record.id)).toEqual({ ok: true })
    // 'running' hit the disk and the stream BEFORE the engine did anything.
    expect(readTaskChecks(project.path, record.id)?.status).toBe('running')
    expect(manager.getChecks(project.id, record.id)?.status).toBe('running')
    const checksFrames = () => envelopes.filter((e) => e.event.name === 'task_checks')
    expect(checksFrames()).toMatchObject([
      { project_id: project.id, task_id: record.id, event: { data: { status: 'running' } } },
    ])
    // T1.3 (D4): the checks call now sits behind an `await loadCap.acquire`,
    // which yields at least one microtask even when a slot is free — 'running'
    // above is still synchronous, but seeing the engine actually get called
    // now needs one tick.
    await Promise.resolve()
    // The engine got the worktree, its HEAD, and no config (none in this repo).
    expect(seen[0]?.worktree).toBe(worktree)
    expect(seen[0]?.headSha).toBe(headSha)
    expect(seen[0]?.config).toBeNull()

    // One run at a time per task.
    expect(manager.checks(project.id, record.id)).toEqual({
      ok: false,
      code: 409,
      error: 'checks already running',
    })

    // Progress snapshots flow through as task_checks frames too.
    seen[0]?.onUpdate?.(finishedChecks({ status: 'running', finished_at: null }))
    expect(checksFrames().length).toBe(2)

    release(
      finishedChecks({
        status: 'failed',
        checks: [
          { command: 'bun test', status: 'passed', exit_code: 0, duration_ms: 5, tail: '' },
          { command: 'bun run lint', status: 'failed', exit_code: 1, duration_ms: 5, tail: 'x' },
          { command: 'bun run e2e', status: 'timeout', exit_code: null, duration_ms: 5, tail: '' },
        ],
      }),
    )
    await until(() =>
      readTaskEvents(project.path, record.id).some((event) => event.type === 'checks'),
    )
    // Final state persisted, journal summarizes it (timeout counts as failed).
    expect(readTaskChecks(project.path, record.id)?.status).toBe('failed')
    const journal = readTaskEvents(project.path, record.id).find((e) => e.type === 'checks')
    expect(journal?.data).toEqual({ status: 'failed', passed: 1, failed: 2 })
    // The journal line was broadcast as a task_event, the final as task_checks.
    expect(checksFrames().at(-1)?.event.data).toMatchObject({ status: 'failed' })
    expect(
      envelopes.some((e) => e.event.name === 'task_event' && e.event.data.type === 'checks'),
    ).toBe(true)
    // The run settled: a new one may start.
    expect(manager.checks(project.id, record.id)).toEqual({ ok: true })
  })

  test('a rejecting engine degrades to status error and NEVER touches the task record', async () => {
    const project = register(makeRepo())
    const { record } = seedCommittedTask(project.path)
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      createRunnerFn: rig.createRunnerFn,
      reviewTurnFn: async () => {},
      runChecksFn: () => Promise.reject(new Error('engine exploded')),
    })
    // Read AFTER the boot recovery settled the record: what this asserts is
    // that the CHECKS never move it, not what boot did with an orphan.
    const statusBefore = loadTask(project.path, record.id)?.status
    expect(manager.checks(project.id, record.id)).toEqual({ ok: true })
    await until(() => readTaskChecks(project.path, record.id)?.status === 'error')
    expect(readTaskChecks(project.path, record.id)?.error).toBe('engine exploded')
    const journal = readTaskEvents(project.path, record.id).find((e) => e.type === 'checks')
    expect(journal?.data).toEqual({ status: 'error', passed: 0, failed: 0 })
    // The TASK is untouched: checks are best-effort by contract.
    expect(loadTask(project.path, record.id)?.status).toBe(statusBefore)
    // And the in-flight flag was released even on the error path.
    expect(manager.checks(project.id, record.id)).toEqual({ ok: true })
  })

  test('auto-trigger: onTurnDone starts checks for a committed turn WITHOUT blocking the review', async () => {
    const project = register(makeRepo())
    const rig = fakeRunner()
    let release!: (checks: TaskChecks) => void
    const gate = new Promise<TaskChecks>((resolve) => {
      release = resolve
    })
    let runs = 0
    const manager = createTaskManager({
      ...managerOpts,
      createRunnerFn: rig.createRunnerFn,
      reviewTurnFn: async (record) => {
        record.status = 'review_ok'
      },
      runChecksFn: () => {
        runs++
        return gate
      },
    })
    // Force the lazy context (and thus the runner + its onTurnDone) to exist.
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const { record } = seedCommittedTask(project.path)
    const io = {
      emit: () => {},
      persist: () => {},
      text: () => {},
      signal: new AbortController().signal,
    }

    // onTurnDone resolves while the checks promise is still pending: the
    // review was never gated on the container run.
    await rig.runnerOptions().onTurnDone!(record, io)
    expect(runs).toBe(1)
    expect(record.status).toBe('review_ok')
    expect(readTaskChecks(project.path, record.id)?.status).toBe('running')

    release(finishedChecks())
    await until(() => readTaskChecks(project.path, record.id)?.status === 'passed')

    // A turn WITHOUT a fresh commit (last commit event belongs to turn 1,
    // record now has 2 turns) never re-triggers.
    const again = loadTask(project.path, record.id)!
    again.turns.push({
      prompt: 'follow-up',
      response: 'done',
      question: null,
      started_at: new Date().toISOString(),
      ended_at: null,
    })
    saveTask(project.path, again)
    await rig.runnerOptions().onTurnDone!(again, io)
    expect(runs).toBe(1)
  })
})

// --- HTTP surface ---------------------------------------------------------

type RawResponse = { status: number; body: string }

function rawRequest(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolveResponse, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => resolveResponse({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on('error', reject)
    if (opts.body !== undefined) {
      req.write(opts.body)
    }
    req.end()
  })
}

async function tasksToken(port: number): Promise<string> {
  const html = await rawRequest(port, '/')
  const match = /__CODESEMA_TASKS_TOKEN__="([a-f0-9]{32})"/.exec(html.body)
  expect(match).not.toBeNull()
  return match![1]!
}

describe('task routes without a task manager', () => {
  test('every task and project route answers 501, review routes are untouched', async () => {
    const repo = makeDir()
    const started = await startServer(createSession(), { cwd: repo, port: 5101 })
    try {
      expect((await rawRequest(started.port, '/api/tasks?project=deadbeef')).status).toBe(501)
      expect((await rawRequest(started.port, '/api/tasks/events')).status).toBe(501)
      expect(
        (await rawRequest(started.port, '/api/tasks/aaaaaaaaaaaa?project=deadbeef')).status,
      ).toBe(501)
      expect(
        (await rawRequest(started.port, '/api/tasks', { method: 'POST', body: '{}' })).status,
      ).toBe(501)
      expect(
        (
          await rawRequest(started.port, '/api/tasks/aaaaaaaaaaaa/reply?project=deadbeef', {
            method: 'POST',
            body: '{}',
          })
        ).status,
      ).toBe(501)
      expect(
        (await rawRequest(started.port, '/api/tasks/aaaaaaaaaaaa/checks?project=deadbeef')).status,
      ).toBe(501)
      expect(
        (await rawRequest(started.port, '/api/tasks/aaaaaaaaaaaa/review?project=deadbeef')).status,
      ).toBe(501)
      expect(
        (
          await rawRequest(started.port, '/api/tasks/aaaaaaaaaaaa/checks?project=deadbeef', {
            method: 'POST',
          })
        ).status,
      ).toBe(501)
      expect((await rawRequest(started.port, '/api/projects')).status).toBe(501)
      expect(
        (await rawRequest(started.port, '/api/projects', { method: 'POST', body: '{}' })).status,
      ).toBe(501)
      expect(
        (await rawRequest(started.port, '/api/projects/deadbeef', { method: 'DELETE' })).status,
      ).toBe(501)
      // No tasks token is injected when the manager is absent.
      const html = await rawRequest(started.port, '/')
      expect(html.body).not.toContain('__CODESEMA_TASKS_TOKEN__')
      // The review API still answers as before.
      expect((await rawRequest(started.port, '/api/status')).status).toBe(200)
    } finally {
      await started.stop()
    }
  })
})

describe('task routes with a stub manager', () => {
  function stubManager(project: Project) {
    const listeners = new Set<(envelope: TaskEnvelope) => void>()
    const record = seedTask(project.path, 'stubbed task', 'stub work')
    const calls = {
      creates: [] as string[],
      replies: [] as { project: string; id: string; message: string }[],
      ships: [] as string[],
      abandons: [] as string[],
      checksStarts: [] as string[],
      checksSetups: [] as string[],
      checksApplies: [] as string[],
      resumes: [] as { project: string; id: string }[],
    }
    const known = (projectId: string) => projectId === project.id
    const manager: TaskManager = {
      list: (projectId) => (known(projectId) ? [record] : null),
      listAll: () => [{ project, records: [record] }],
      get: (projectId, id) =>
        known(projectId) && id === record.id ? { record, events: [] } : null,
      create: (projectId) => {
        if (!known(projectId)) {
          return { ok: false, code: 404, error: 'unknown project' }
        }
        calls.creates.push(projectId)
        return { ok: true, record }
      },
      reply: (projectId, id, message) => {
        if (!known(projectId)) {
          return { ok: false, code: 404, error: 'unknown project' }
        }
        calls.replies.push({ project: projectId, id, message })
        return { ok: false, code: 409, error: 'task is not waiting for a reply' }
      },
      resume: (projectId, id) => {
        if (!known(projectId)) {
          return { ok: false, code: 404, error: 'unknown project' }
        }
        calls.resumes.push({ project: projectId, id })
        return { ok: true }
      },
      interrupt: (projectId) =>
        known(projectId) ? { ok: true } : { ok: false, code: 404, error: 'unknown project' },
      ship: (projectId, id) => {
        if (!known(projectId)) {
          return Promise.resolve({ ok: false as const, code: 404, error: 'unknown project' })
        }
        calls.ships.push(id)
        return Promise.resolve({ ok: false as const, code: 409, error: 'task is queued' })
      },
      abandon: (projectId, id) => {
        if (!known(projectId)) {
          return Promise.resolve({ ok: false as const, code: 404, error: 'unknown project' })
        }
        calls.abandons.push(id)
        // T1.6: exercises the HTTP layer's propagation of `preserved_branch`.
        return Promise.resolve({ ok: true as const, preserved_branch: record.branch })
      },
      checks: (projectId, id) => {
        if (!known(projectId)) {
          return { ok: false, code: 404, error: 'unknown project' }
        }
        calls.checksStarts.push(id)
        return { ok: true }
      },
      getChecks: (projectId, id) =>
        known(projectId) && id === record.id ? readTaskChecks(project.path, id) : null,
      getReview: (projectId, id, ref) =>
        known(projectId) ? readTaskReview(project.path, id, ref) : null,
      checksSetup: (projectId) => {
        if (!known(projectId)) {
          return { ok: false, code: 404, error: 'unknown project' }
        }
        calls.checksSetups.push(projectId)
        return { ok: true }
      },
      checksSetupStatus: (projectId) => (known(projectId) ? { status: 'idle' } : null),
      workspaceInfo: () => ({
        isolation_available: false,
        isolation_default: 'policy',
        isolation_reason: 'stub',
        isolation_configured: 'policy',
      }),
      startPending: () => [],
      sweepOrphanedVolumes: async () => {},
      applyRetention: async () => {},
      checksApply: (projectId) => {
        if (!known(projectId)) {
          return { ok: false, code: 404, error: 'unknown project' }
        }
        calls.checksApplies.push(projectId)
        return { ok: false, code: 409, error: 'no checks proposal to apply' }
      },
      shutdown: () => Promise.resolve(),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    const emit = (envelope: TaskEnvelope) => {
      for (const listener of listeners) {
        listener(envelope)
      }
    }
    return { manager, record, calls, emit }
  }

  test('CRUD routes: project scoping (400 missing, 404 unknown), create, Host guard', async () => {
    const project = register(makeRepo())
    const { manager, record, calls } = stubManager(project)
    const started = await startServer(createSession(), {
      cwd: project.path,
      port: 5121,
      taskManager: manager,
      currentProjectId: project.id,
    })
    try {
      const token = await tasksToken(started.port)

      // project= is MANDATORY on every scoped route.
      expect((await rawRequest(started.port, '/api/tasks')).status).toBe(400)
      expect((await rawRequest(started.port, `/api/tasks/${record.id}`)).status).toBe(400)
      // Unknown project: 404.
      expect((await rawRequest(started.port, '/api/tasks?project=ffffffff')).status).toBe(404)
      expect(
        (await rawRequest(started.port, `/api/tasks/${record.id}?project=ffffffff`)).status,
      ).toBe(404)

      const list = await rawRequest(started.port, `/api/tasks?project=${project.id}`)
      expect(list.status).toBe(200)
      expect(JSON.parse(list.body)).toMatchObject([{ id: record.id, title: 'stubbed task' }])

      const one = await rawRequest(started.port, `/api/tasks/${record.id}?project=${project.id}`)
      expect(one.status).toBe(200)
      expect(JSON.parse(one.body)).toMatchObject({ record: { id: record.id }, events: [] })

      expect(
        (await rawRequest(started.port, `/api/tasks/aaaaaaaaaaaa?project=${project.id}`)).status,
      ).toBe(404)
      expect(
        (await rawRequest(started.port, `/api/tasks/UPPER-not-id?project=${project.id}`)).status,
      ).toBe(404)

      // Create carries the project in the BODY (project_id), not the query.
      const created = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': token },
        body: JSON.stringify({ project_id: project.id, title: 't', prompt: 'p' }),
      })
      expect(created.status).toBe(201)
      expect(JSON.parse(created.body)).toMatchObject({ id: record.id })
      expect(calls.creates).toEqual([project.id])

      // Missing project_id: 400 before the manager is reached.
      const noProject = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': token },
        body: JSON.stringify({ title: 't', prompt: 'p' }),
      })
      expect(noProject.status).toBe(400)
      // Unknown project_id: the manager's 404 comes through.
      const ghostProject = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': token },
        body: JSON.stringify({ project_id: 'ffffffff', title: 't', prompt: 'p' }),
      })
      expect(ghostProject.status).toBe(404)

      const badBody = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': token },
        body: JSON.stringify({ project_id: project.id, title: 42, prompt: 'p' }),
      })
      expect(badBody.status).toBe(400)
      expect(calls.creates).toEqual([project.id])

      // DNS-rebinding guard stays active on every task route.
      const rebound = await rawRequest(started.port, `/api/tasks?project=${project.id}`, {
        headers: { host: 'evil.com' },
      })
      expect(rebound.status).toBe(403)
    } finally {
      await started.stop()
    }
  })

  test('mutations without the tasks token are refused before reaching the manager', async () => {
    const project = register(makeRepo())
    const { manager, record, calls } = stubManager(project)
    const started = await startServer(createSession(), {
      cwd: project.path,
      port: 5131,
      taskManager: manager,
    })
    const scoped = (path: string) => `${path}?project=${project.id}`
    try {
      const noToken = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ project_id: project.id, title: 't', prompt: 'p' }),
      })
      expect(noToken.status).toBe(403)
      const badToken = await rawRequest(started.port, scoped(`/api/tasks/${record.id}/reply`), {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': 'wrong' },
        body: JSON.stringify({ message: 'hello' }),
      })
      expect(badToken.status).toBe(403)
      const badInterrupt = await rawRequest(
        started.port,
        scoped(`/api/tasks/${record.id}/interrupt`),
        { method: 'POST' },
      )
      expect(badInterrupt.status).toBe(403)
      // abandon deletes a worktree and a branch: same CSRF token gate.
      const badAbandon = await rawRequest(started.port, scoped(`/api/tasks/${record.id}/abandon`), {
        method: 'POST',
      })
      expect(badAbandon.status).toBe(403)
      expect(calls.abandons).toHaveLength(0)
      // ship pushes to origin: same gate again.
      const badShip = await rawRequest(started.port, scoped(`/api/tasks/${record.id}/ship`), {
        method: 'POST',
      })
      expect(badShip.status).toBe(403)
      expect(calls.ships).toHaveLength(0)
      expect(calls.creates).toHaveLength(0)
      expect(calls.replies).toHaveLength(0)
    } finally {
      await started.stop()
    }
  })

  test('actions: project scoping and manager verdict propagation', async () => {
    const project = register(makeRepo())
    const { manager, record, calls } = stubManager(project)
    const started = await startServer(createSession(), {
      cwd: project.path,
      port: 5141,
      taskManager: manager,
    })
    try {
      const token = await tasksToken(started.port)
      const headers = { 'x-codesema-tasks-token': token }

      // Missing project param: 400 on every action.
      const unscoped = await rawRequest(started.port, `/api/tasks/${record.id}/reply`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: 'hello' }),
      })
      expect(unscoped.status).toBe(400)
      expect(calls.replies).toHaveLength(0)

      // Unknown project: 404 from the manager.
      const ghost = await rawRequest(
        started.port,
        `/api/tasks/${record.id}/reply?project=ffffffff`,
        { method: 'POST', headers, body: JSON.stringify({ message: 'hello' }) },
      )
      expect(ghost.status).toBe(404)

      const conflict = await rawRequest(
        started.port,
        `/api/tasks/${record.id}/reply?project=${project.id}`,
        { method: 'POST', headers, body: JSON.stringify({ message: 'hello' }) },
      )
      expect(conflict.status).toBe(409)
      expect(JSON.parse(conflict.body)).toEqual({ error: 'task is not waiting for a reply' })
      expect(calls.replies).toEqual([{ project: project.id, id: record.id, message: 'hello' }])

      const badBody = await rawRequest(
        started.port,
        `/api/tasks/${record.id}/reply?project=${project.id}`,
        { method: 'POST', headers, body: JSON.stringify({ message: 7 }) },
      )
      expect(badBody.status).toBe(400)

      const badId = await rawRequest(
        started.port,
        `/api/tasks/not-an-id/reply?project=${project.id}`,
        { method: 'POST', headers, body: JSON.stringify({ message: 'hello' }) },
      )
      expect(badId.status).toBe(404)

      // T5: the ship route delegates to manager.ship and forwards its verdict.
      const ship = await rawRequest(
        started.port,
        `/api/tasks/${record.id}/ship?project=${project.id}`,
        { method: 'POST', headers },
      )
      expect(ship.status).toBe(409)
      expect(JSON.parse(ship.body)).toEqual({ error: 'task is queued' })
      expect(calls.ships).toEqual([record.id])

      const interrupted = await rawRequest(
        started.port,
        `/api/tasks/${record.id}/interrupt?project=${project.id}`,
        { method: 'POST', headers },
      )
      expect(interrupted.status).toBe(200)

      const abandoned = await rawRequest(
        started.port,
        `/api/tasks/${record.id}/abandon?project=${project.id}`,
        { method: 'POST', headers },
      )
      expect(abandoned.status).toBe(200)
      // T1.6: the manager's `preserved_branch` rides through taskActionBody verbatim.
      expect(JSON.parse(abandoned.body)).toEqual({ ok: true, preserved_branch: record.branch })
      expect(calls.abandons).toEqual([record.id])

      // T8: resume takes no body at all — the instruction is on the record.
      const resumed = await rawRequest(
        started.port,
        `/api/tasks/${record.id}/resume?project=${project.id}`,
        { method: 'POST', headers },
      )
      expect(resumed.status).toBe(200)
      expect(JSON.parse(resumed.body)).toEqual({ ok: true })
      expect(calls.resumes).toEqual([{ project: project.id, id: record.id }])
      // Same guards as every other mutation: CSRF token, then the project.
      expect(
        (
          await rawRequest(started.port, `/api/tasks/${record.id}/resume?project=${project.id}`, {
            method: 'POST',
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await rawRequest(started.port, `/api/tasks/${record.id}/resume?project=ffffffff`, {
            method: 'POST',
            headers,
          })
        ).status,
      ).toBe(404)
    } finally {
      await started.stop()
    }
  })

  // T1.2: a gesture that lands the task BEHIND another one is a success, not a
  // refusal — and the caller must be able to render the right thing without a
  // second round-trip, exactly like POST /api/tasks does on creation. The
  // mirror case matters just as much: a refusal carries its machine-readable
  // reason_code NEXT TO the readable message, never instead of it.
  test('reply and resume carry the queue position on success, the reason code on refusal', async () => {
    const project = register(makeRepo())
    const base = stubManager(project)
    const manager: TaskManager = {
      ...base.manager,
      reply: () => ({ ok: true, queue_position: 3 }),
      resume: () => ({ ok: true, queue_position: 1 }),
      abandon: () =>
        Promise.resolve({
          ok: false as const,
          code: 503,
          error: 'the queue of this project is full',
          reason_code: 'resource_busy' as const,
        }),
    }
    const started = await startServer(createSession(), {
      cwd: project.path,
      port: 5151,
      taskManager: manager,
    })
    try {
      const token = await tasksToken(started.port)
      const headers = { 'x-codesema-tasks-token': token }
      const scoped = (action: string) =>
        `/api/tasks/${base.record.id}/${action}?project=${project.id}`

      const replied = await rawRequest(started.port, scoped('reply'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ message: 'hello' }),
      })
      expect(replied.status).toBe(200)
      expect(JSON.parse(replied.body)).toEqual({ ok: true, queue_position: 3 })

      const resumed = await rawRequest(started.port, scoped('resume'), { method: 'POST', headers })
      expect(resumed.status).toBe(200)
      expect(JSON.parse(resumed.body)).toEqual({ ok: true, queue_position: 1 })

      const refused = await rawRequest(started.port, scoped('abandon'), { method: 'POST', headers })
      expect(refused.status).toBe(503)
      expect(JSON.parse(refused.body)).toEqual({
        error: 'the queue of this project is full',
        reason_code: 'resource_busy',
      })
    } finally {
      await started.stop()
    }
  })

  test('checks routes: GET 404 before any run then the file, POST under the token → 202', async () => {
    const project = register(makeRepo())
    const { manager, record, calls, emit } = stubManager(project)
    const started = await startServer(createSession(), {
      cwd: project.path,
      port: 5161,
      taskManager: manager,
    })
    const path = `/api/tasks/${record.id}/checks?project=${project.id}`
    try {
      const token = await tasksToken(started.port)

      // Never run: 404. Scoping mirrors the other task routes.
      expect((await rawRequest(started.port, path)).status).toBe(404)
      expect((await rawRequest(started.port, `/api/tasks/${record.id}/checks`)).status).toBe(400)
      expect(
        (await rawRequest(started.port, `/api/tasks/${record.id}/checks?project=ffffffff`)).status,
      ).toBe(404)
      expect(
        (await rawRequest(started.port, `/api/tasks/not-an-id/checks?project=${project.id}`))
          .status,
      ).toBe(404)

      // POST is a mutation: CSRF token required, 202 once accepted.
      expect((await rawRequest(started.port, path, { method: 'POST' })).status).toBe(403)
      expect(calls.checksStarts).toHaveLength(0)
      const accepted = await rawRequest(started.port, path, {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': token },
      })
      expect(accepted.status).toBe(202)
      expect(JSON.parse(accepted.body)).toEqual({ ok: true })
      expect(calls.checksStarts).toEqual([record.id])

      // Once checks.json exists the GET serves it verbatim.
      writeTaskChecks(project.path, record.id, {
        head_sha: 'abc',
        started_at: '2026-08-14T10:00:00.000Z',
        finished_at: '2026-08-14T10:01:00.000Z',
        status: 'failed',
        checks: [
          { command: 'bun test', status: 'failed', exit_code: 1, duration_ms: 9, tail: 'ko' },
        ],
        error: null,
      })
      const got = await rawRequest(started.port, path)
      expect(got.status).toBe(200)
      expect(JSON.parse(got.body)).toMatchObject({
        status: 'failed',
        checks: [{ command: 'bun test', status: 'failed' }],
      })

      // task_checks envelopes ride the SAME global SSE stream as everything else.
      const chunks: string[] = []
      const req = request(
        { host: '127.0.0.1', port: started.port, path: '/api/tasks/events' },
        (res) => {
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            chunks.push(chunk)
          })
        },
      )
      req.end()
      await until(() => chunks.join('').includes('event: task\n'))
      emit({
        project_id: project.id,
        task_id: record.id,
        event: {
          name: 'task_checks',
          data: {
            head_sha: 'abc',
            started_at: '2026-08-14T10:00:00.000Z',
            finished_at: null,
            status: 'running',
            checks: [],
            error: null,
          },
        },
      })
      await until(() => chunks.join('').includes('event: task_checks\n'))
      const frame = /event: task_checks\nid: \d+\ndata: (.*)\n/.exec(chunks.join(''))
      expect(frame).not.toBeNull()
      expect(JSON.parse(frame![1]!)).toMatchObject({
        project_id: project.id,
        task_id: record.id,
        event: { name: 'task_checks', data: { status: 'running' } },
      })
      req.destroy()
    } finally {
      await started.stop()
    }
  })

  test('review route: 404 before any review, then the archive, ref-scoped and traversal-proof', async () => {
    const project = register(makeRepo())
    const { manager, record } = stubManager(project)
    const started = await startServer(createSession(), {
      cwd: project.path,
      port: 5171,
      taskManager: manager,
    })
    const path = `/api/tasks/${record.id}/review?project=${project.id}`
    try {
      // No review yet: 404, exactly like a task whose checks never ran.
      expect((await rawRequest(started.port, path)).status).toBe(404)
      // Same scoping contract as every other task route.
      expect((await rawRequest(started.port, `/api/tasks/${record.id}/review`)).status).toBe(400)
      expect(
        (await rawRequest(started.port, `/api/tasks/${record.id}/review?project=ffffffff`)).status,
      ).toBe(404)
      expect(
        (await rawRequest(started.port, `/api/tasks/not-an-id/review?project=${project.id}`))
          .status,
      ).toBe(404)

      // The task's own archive, once a review ran.
      const stored = loadTask(project.path, record.id)!
      stored.review_ref = archiveRecord(fakeReviewRecord('approve', 'looks good'), project.path)
      saveTask(project.path, stored)
      const got = await rawRequest(started.port, path)
      expect(got.status).toBe(200)
      expect(JSON.parse(got.body)).toMatchObject({
        review: { verdict: 'approve', summary: 'looks good' },
      })

      // A ref opens THAT turn's archive instead of the latest one.
      const older = fakeReviewRecord('request_changes', 'previous turn')
      older.meta.branch = 'codesema/task-older'
      const olderRef = archiveRecord(older, project.path)
      const byRef = await rawRequest(started.port, `${path}&ref=${encodeURIComponent(olderRef)}`)
      expect(byRef.status).toBe(200)
      expect(JSON.parse(byRef.body)).toMatchObject({ review: { verdict: 'request_changes' } })

      // A ref pointing anywhere else reads nothing — no traversal, no
      // absolute path outside the project's reviews directory.
      const outside = join(project.path, 'secret.json')
      writeFileSync(outside, JSON.stringify(fakeReviewRecord('approve', 'not yours')))
      expect(
        (await rawRequest(started.port, `${path}&ref=${encodeURIComponent(outside)}`)).status,
      ).toBe(404)
      expect(
        (await rawRequest(started.port, `${path}&ref=${encodeURIComponent('../../secret.json')}`))
          .status,
      ).toBe(404)

      // Read-only: no CSRF token needed, and POST is not a thing here.
      expect((await rawRequest(started.port, path, { method: 'POST' })).status).toBe(405)
    } finally {
      await started.stop()
    }
  })

  test('the global SSE stream replays every project then forwards envelopes', async () => {
    const project = register(makeRepo())
    const { manager, record, emit } = stubManager(project)
    const started = await startServer(createSession(), {
      cwd: project.path,
      port: 5151,
      taskManager: manager,
    })
    try {
      const chunks: string[] = []
      const req = request(
        { host: '127.0.0.1', port: started.port, path: '/api/tasks/events' },
        (res) => {
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            chunks.push(chunk)
          })
        },
      )
      req.end()

      // Initial replay: one 'task' frame per record of EVERY project, enveloped.
      await until(() => chunks.join('').includes('event: task\n'))
      const replayed = /event: task\nid: \d+\ndata: (.*)\n/.exec(chunks.join(''))
      expect(replayed).not.toBeNull()
      expect(JSON.parse(replayed![1]!)).toMatchObject({
        project_id: project.id,
        task_id: record.id,
        event: { name: 'task', data: { id: record.id, status: 'queued' } },
      })

      // Live envelopes keep the same shape, under their own SSE event name.
      const event: TaskEvent = {
        seq: 1,
        at: new Date().toISOString(),
        type: 'message',
        data: { text: 'hi' },
      }
      emit({
        project_id: project.id,
        task_id: record.id,
        event: { name: 'task_event', data: event },
      })
      emit({
        project_id: project.id,
        task_id: record.id,
        event: { name: 'task_text', data: { text: 'stream' } },
      })
      await until(() => chunks.join('').includes('event: task_text'))
      const stream = chunks.join('')
      expect(stream).toContain('event: task_event')
      expect(stream).toContain(
        `data: {"project_id":"${project.id}","task_id":"${record.id}","event":{"name":"task_event"`,
      )
      expect(stream).toContain('"name":"task_text","data":{"text":"stream"}')
      req.destroy()
    } finally {
      await started.stop()
    }
  })
})

// --- /api/projects --------------------------------------------------------

describe('project routes', () => {
  test('GET lists the registry with the current project; POST/DELETE edit it under the token', async () => {
    const current = register(makeRepo())
    const { manager } = (() => {
      const rig = fakeRunner()
      return { manager: createTaskManager({ ...managerOpts, ...rig }) }
    })()
    const started = await startServer(createSession(), {
      cwd: current.path,
      port: 5161,
      taskManager: manager,
      currentProjectId: current.id,
    })
    try {
      const token = await tasksToken(started.port)

      const initial = await rawRequest(started.port, '/api/projects')
      expect(initial.status).toBe(200)
      expect(JSON.parse(initial.body)).toEqual({
        projects: [
          {
            id: current.id,
            path: current.path,
            name: current.name,
            added_at: current.added_at,
          },
        ],
        current: current.id,
        workspace: {
          isolation_available: false,
          isolation_default: 'policy',
          isolation_reason: 'container isolation was not probed',
          isolation_configured: 'policy',
        },
      })

      // Register a second repo by path.
      const other = makeRepo()
      const added = await rawRequest(started.port, '/api/projects', {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': token },
        body: JSON.stringify({ path: other }),
      })
      expect(added.status).toBe(201)
      const project = JSON.parse(added.body) as Project
      expect(project.id).toMatch(/^[0-9a-f]{8}$/)
      expect(listProjects().map((p) => p.id)).toEqual([current.id, project.id])

      // Not a git ROOT: 400 with a readable error.
      const notRoot = await rawRequest(started.port, '/api/projects', {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': token },
        body: JSON.stringify({ path: makeDir() }),
      })
      expect(notRoot.status).toBe(400)
      // Malformed body: 400.
      const badBody = await rawRequest(started.port, '/api/projects', {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': token },
        body: JSON.stringify({ path: 42 }),
      })
      expect(badBody.status).toBe(400)

      // The new project's tasks are immediately reachable, no restart needed.
      expect((await rawRequest(started.port, `/api/tasks?project=${project.id}`)).status).toBe(200)

      // DELETE unregisters ONLY: the repo stays on disk.
      const removed = await rawRequest(started.port, `/api/projects/${project.id}`, {
        method: 'DELETE',
        headers: { 'x-codesema-tasks-token': token },
      })
      expect(removed.status).toBe(200)
      expect(listProjects().map((p) => p.id)).toEqual([current.id])
      expect(
        (
          await rawRequest(started.port, `/api/projects/${project.id}`, {
            method: 'DELETE',
            headers: { 'x-codesema-tasks-token': token },
          })
        ).status,
      ).toBe(404)

      // Mutations without the token never reach the registry.
      const noTokenAdd = await rawRequest(started.port, '/api/projects', {
        method: 'POST',
        body: JSON.stringify({ path: other }),
      })
      expect(noTokenAdd.status).toBe(403)
      const noTokenDelete = await rawRequest(started.port, `/api/projects/${current.id}`, {
        method: 'DELETE',
      })
      expect(noTokenDelete.status).toBe(403)
      expect(listProjects().map((p) => p.id)).toEqual([current.id])
    } finally {
      await started.stop()
    }
  })

  test('GET /api/projects/discover: repos around the launch dir, registered ones flagged', async () => {
    // Launch dir is NOT a repo: its direct children are scanned. One child is
    // already registered (the current project), one is a fresh repo, one is a
    // plain directory.
    const base = makeDir()
    const knownPath = join(base, 'known')
    mkdirSync(knownPath)
    execFileSync('git', ['init', '-b', 'main'], { cwd: knownPath, stdio: 'ignore' })
    const known = register(knownPath)
    const freshPath = join(base, 'fresh')
    mkdirSync(freshPath)
    execFileSync('git', ['init', '-b', 'main'], { cwd: freshPath, stdio: 'ignore' })
    mkdirSync(join(base, 'plain'))

    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })
    const started = await startServer(createSession(), {
      cwd: base,
      port: 5165,
      taskManager: manager,
      currentProjectId: known.id,
    })
    try {
      const res = await rawRequest(started.port, '/api/projects/discover')
      expect(res.status).toBe(200)
      const body = JSON.parse(res.body) as {
        candidates: { name: string; registered: boolean }[]
      }
      expect(body.candidates.map((c) => [c.name, c.registered])).toEqual([
        ['fresh', false],
        ['known', true],
      ])
    } finally {
      await started.stop()
    }
  })

  test('GET /api/projects/discover without a task manager: 501', async () => {
    const started = await startServer(createSession(), { cwd: makeRepo(), port: 5166 })
    try {
      expect((await rawRequest(started.port, '/api/projects/discover')).status).toBe(501)
    } finally {
      await started.stop()
    }
  })
})

// --- end to end: real manager + real runner + injected agent --------------

describe('workspace server end to end', () => {
  const jsonl = (events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
  const claudeStream = (response: string) =>
    jsonl([
      { type: 'system', subtype: 'init', session_id: 'sess-e2e' },
      { type: 'result', result: response },
    ])

  test('a refusal over HTTP carries reason_code in its body, next to the message', async () => {
    const project = register(makeRepo())
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      isolation: {
        available: false,
        mode: 'policy',
        reason: 'docker is installed but its engine does not answer',
        configured: 'container',
        runtime: 'docker',
      },
    })
    const started = await startServer(createSession(), {
      cwd: project.path,
      port: 5197,
      taskManager: manager,
      currentProjectId: project.id,
    })
    try {
      const token = await tasksToken(started.port)
      const refused = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': token },
        body: JSON.stringify({ project_id: project.id, title: 't', prompt: 'p' }),
      })
      expect(refused.status).toBe(409)
      const body = JSON.parse(refused.body) as { error: string; reason_code?: string }
      // Both halves reach the client: the message a human reads, and the code
      // a machine branches on.
      expect(body.reason_code).toBe('resource_busy')
      expect(body.error).toContain('does not answer')
      expect(manager.list(project.id)).toHaveLength(0)
    } finally {
      await started.stop()
    }
  })

  test('create over HTTP runs a turn to waiting_for_you, then reply runs turn 2', async () => {
    const project = register(makeRepo())
    const repo = project.path
    let firstTurnGate: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      firstTurnGate = resolve
    })
    const runAgentFn = async (options: AgentRunOptions): Promise<string> => {
      if (!options.command.includes('--resume')) {
        await gate
      }
      const raw = claudeStream(
        options.command.includes('--resume')
          ? 'second turn done'
          : 'first pass done.\nQUESTION: which flavor?',
      )
      options.onText?.(raw)
      return raw
    }
    const manager = createTaskManager({ command: 'claude -p', timeoutMs: 5000, runAgentFn })
    const started = await startServer(createSession(), {
      cwd: repo,
      port: 5171,
      taskManager: manager,
      currentProjectId: project.id,
    })
    try {
      const token = await tasksToken(started.port)
      const created = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': token },
        body: JSON.stringify({
          project_id: project.id,
          title: 'Pick a flavor',
          prompt: 'try things',
        }),
      })
      expect(created.status).toBe(201)
      const record = JSON.parse(created.body) as TaskRecord
      expect(record.status).toBe('queued')

      // While the first turn runs, a reply is a 409 through the whole stack.
      await until(() => loadTask(repo, record.id)?.status === 'running')
      const early = await rawRequest(
        started.port,
        `/api/tasks/${record.id}/reply?project=${project.id}`,
        {
          method: 'POST',
          headers: { 'x-codesema-tasks-token': token },
          body: JSON.stringify({ message: 'too early' }),
        },
      )
      expect(early.status).toBe(409)

      firstTurnGate()
      await until(() => loadTask(repo, record.id)?.status === 'waiting_for_you')
      const waiting = await rawRequest(
        started.port,
        `/api/tasks/${record.id}?project=${project.id}`,
      )
      expect(waiting.status).toBe(200)
      const detail = JSON.parse(waiting.body) as { record: TaskRecord; events: TaskEvent[] }
      expect(detail.record.turns[0]?.question).toBe('which flavor?')
      expect(detail.events.map((e) => e.type)).toContain('question')

      const replied = await rawRequest(
        started.port,
        `/api/tasks/${record.id}/reply?project=${project.id}`,
        {
          method: 'POST',
          headers: { 'x-codesema-tasks-token': token },
          body: JSON.stringify({ message: 'vanilla' }),
        },
      )
      expect(replied.status).toBe(200)
      // Turn 2 ends 'done': the automatic review kicks in (T4). The fake agent
      // wrote nothing, so the diff vs base is empty and the reviewer lands on
      // review_ok through its no-changes path — no review agent ever spawned.
      await until(
        () =>
          loadTask(repo, record.id)?.turns.length === 2 &&
          loadTask(repo, record.id)?.status === 'review_ok',
      )
      expect(loadTask(repo, record.id)?.turns[1]?.response).toBe('second turn done')
      expect(readTaskEvents(repo, record.id).map((e) => e.type)).toContain('message')

      const list = await rawRequest(started.port, `/api/tasks?project=${project.id}`)
      expect(JSON.parse(list.body)).toMatchObject([{ id: record.id }])
    } finally {
      await started.stop()
    }
  })

  test('GET /api/tasks carries queue_position: the waiting conversations, in order', async () => {
    const project = register(makeRepo())
    const repo = project.path
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runAgentFn = async (options: AgentRunOptions): Promise<string> => {
      if (options.prompt.includes('first work')) {
        await gate
      }
      const raw = claudeStream('done.\nQUESTION: next?')
      options.onText?.(raw)
      return raw
    }
    const manager = createTaskManager({ command: 'claude -p', timeoutMs: 5000, runAgentFn })
    const started = await startServer(createSession(), {
      cwd: repo,
      port: 5173,
      taskManager: manager,
      currentProjectId: project.id,
    })
    try {
      const token = await tasksToken(started.port)
      const create = async (title: string, prompt: string): Promise<string> => {
        const res = await rawRequest(started.port, '/api/tasks', {
          method: 'POST',
          headers: { 'x-codesema-tasks-token': token },
          body: JSON.stringify({ project_id: project.id, title, prompt }),
        })
        expect(res.status).toBe(201)
        return (JSON.parse(res.body) as TaskRecord).id
      }
      const running = await create('running one', 'first work')
      await until(() => loadTask(repo, running)?.status === 'running')
      const second = await create('waiting one', 'second work')
      const third = await create('waiting two', 'third work')

      const list = await rawRequest(started.port, `/api/tasks?project=${project.id}`)
      expect(list.status).toBe(200)
      const byId = new Map(
        (JSON.parse(list.body) as TaskRecord[]).map((r) => [r.id, r.queue_position]),
      )
      // The one at work carries no rank; the two waiting carry theirs, in order.
      expect(byId.get(running)).toBeUndefined()
      expect(byId.get(second)).toBe(1)
      expect(byId.get(third)).toBe(2)

      release()
      await until(() => loadTask(repo, third)?.status === 'waiting_for_you')
      // The line emptied: nobody claims a position any more.
      const after = await rawRequest(started.port, `/api/tasks?project=${project.id}`)
      for (const r of JSON.parse(after.body) as TaskRecord[]) {
        expect(r.queue_position).toBeUndefined()
      }
    } finally {
      await started.stop()
    }
  })

  test('base=… over HTTP: worktree branches from that commit, unknown base is a 400', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    // A branch whose content diverges from main, checked back out of.
    run(['checkout', '-b', 'feature'])
    writeFileSync(join(repo, 'feature.txt'), 'f\n')
    run(['add', '-A'])
    run(['commit', '-m', 'feat: feature file'])
    run(['checkout', 'main'])
    const featureSha = execFileSync('git', ['rev-parse', 'feature'], { cwd: repo })
      .toString()
      .trim()

    const runAgentFn = (): Promise<string> => Promise.resolve(claudeStream('all done'))
    const manager = createTaskManager({ command: 'claude -p', timeoutMs: 5000, runAgentFn })
    const started = await startServer(createSession(), {
      cwd: repo,
      port: 5191,
      taskManager: manager,
      currentProjectId: project.id,
    })
    try {
      const token = await tasksToken(started.port)
      const headers = { 'x-codesema-tasks-token': token }

      // Unknown base: readable 400 from the manager, no task ever persisted.
      const bad = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers,
        body: JSON.stringify({ project_id: project.id, title: 't', prompt: 'p', base: 'nope' }),
      })
      expect(bad.status).toBe(400)
      expect((JSON.parse(bad.body) as { error: string }).error).toContain('nope')

      // Non-string base: schema-level 400 before the manager is reached.
      const badType = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers,
        body: JSON.stringify({ project_id: project.id, title: 't', prompt: 'p', base: 42 }),
      })
      expect(badType.status).toBe(400)
      expect(manager.list(project.id)).toHaveLength(0)

      // Valid base: created, and the materialized worktree STARTS AT feature.
      const created = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          project_id: project.id,
          title: 'From feature',
          prompt: 'work here',
          base: 'feature',
        }),
      })
      expect(created.status).toBe(201)
      const record = JSON.parse(created.body) as TaskRecord
      expect(record.base).toBe('feature')

      // The injected agent changes nothing, so the turn lands on review_ok
      // through the reviewer's no-changes path (no review agent spawned).
      await until(() => loadTask(repo, record.id)?.status === 'review_ok')
      const task = loadTask(repo, record.id)
      expect(task?.base).toBe('feature')
      expect(task?.worktree).not.toBe('')
      expect(existsSync(join(task!.worktree, 'feature.txt'))).toBe(true)
      const worktreeHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: task!.worktree })
        .toString()
        .trim()
      expect(worktreeHead).toBe(featureSha)
    } finally {
      await started.stop()
    }
  })

  test('work-on over HTTP: the turn commits DIRECTLY on the branch; a duplicate conversation is a 409', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    run(['branch', 'feature'])
    const shaBefore = execFileSync('git', ['rev-parse', 'feature'], { cwd: repo }).toString().trim()

    // The agent writes a file; the runner commits it at end of turn.
    const runAgentFn = async (options: AgentRunOptions): Promise<string> => {
      writeFileSync(join(options.cwd, 'work-on.txt'), 'w\n')
      const raw = claudeStream('did the work')
      options.onText?.(raw)
      return Promise.resolve(raw)
    }
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn,
      // The diff vs base is non-empty here: stub the reviewer so no real
      // review agent ever spawns.
      reviewTurnFn: async (record, io) => {
        record.status = 'review_ok'
        io.persist()
        return Promise.resolve()
      },
    })
    const started = await startServer(createSession(), {
      cwd: repo,
      port: 5195,
      taskManager: manager,
      currentProjectId: project.id,
    })
    try {
      const token = await tasksToken(started.port)
      const headers = { 'x-codesema-tasks-token': token }

      // branch and base together: 400 through the whole stack.
      const both = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          project_id: project.id,
          title: 't',
          prompt: 'p',
          branch: 'feature',
          base: 'main',
        }),
      })
      expect(both.status).toBe(400)

      const created = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          project_id: project.id,
          title: 'Work on feature',
          prompt: 'continue the work',
          branch: 'feature',
        }),
      })
      expect(created.status).toBe(201)
      const record = JSON.parse(created.body) as TaskRecord
      expect(record).toMatchObject({ branch: 'feature', work_on: true, base: 'main' })

      await until(() => loadTask(repo, record.id)?.status === 'review_ok')
      const task = loadTask(repo, record.id)
      // The worktree IS the branch: the turn's commit advanced refs/heads/feature.
      expect(task?.branch).toBe('feature')
      expect(
        execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: task!.worktree })
          .toString()
          .trim(),
      ).toBe('feature')
      const tip = execFileSync('git', ['rev-parse', 'refs/heads/feature'], { cwd: repo })
        .toString()
        .trim()
      expect(tip).not.toBe(shaBefore)
      const subject = execFileSync('git', ['log', '-1', '--pretty=%s', 'feature'], { cwd: repo })
        .toString()
        .trim()
      expect(subject).toBe(`task(${record.id}): Work on feature — turn 1`)
      // No derived codesema/task-* branch anywhere.
      const heads = execFileSync(
        'git',
        ['for-each-ref', 'refs/heads', '--format=%(refname:short)'],
        {
          cwd: repo,
        },
      ).toString()
      expect(heads).not.toContain('codesema/task-')

      // review_ok is NOT terminal: a second conversation on the branch is a
      // 409 carrying the existing task id — the web opens that column.
      const dup = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          project_id: project.id,
          title: 'again',
          prompt: 'p',
          branch: 'feature',
        }),
      })
      expect(dup.status).toBe(409)
      expect(JSON.parse(dup.body)).toMatchObject({ existing_task_id: record.id })
    } finally {
      await started.stop()
    }
  })

  // Replaces 'maxParallel is GLOBAL: one slot serves two projects': T1.2
  // inverts it. Two projects are two independent lanes; only a project caps
  // itself.
  test('two projects run SIMULTANEOUSLY even under a one-slot maxParallel', async () => {
    const projectA = register(makeRepo())
    const projectB = register(makeRepo())
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    // BOTH hang: neither can finish early and hand a slot to the other.
    const runAgentFn = async (options: AgentRunOptions): Promise<string> => {
      await gate
      const raw = claudeStream('done')
      options.onText?.(raw)
      return raw
    }
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      // Inert since T1.2, and deliberately set to the most restrictive value.
      maxParallel: 1,
      runAgentFn,
      // Land on review_ok without spawning a review agent (empty diffs would
      // too, but the stub keeps it deterministic and fast).
      reviewTurnFn: async (record, io) => {
        record.status = 'review_ok'
        io.persist()
        return Promise.resolve()
      },
    })

    const first = manager.create(projectA.id, { title: 'A', prompt: 'task one', autoShip: false })
    const second = manager.create(projectB.id, { title: 'B', prompt: 'task two', autoShip: false })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) {
      return
    }
    // Admission is per project now: the inert global cap queues nobody, and
    // each status flips once its own worktree has materialized (which waits
    // for that repo's worktree lock).
    await until(() => loadTask(projectA.path, first.record.id)?.status === 'running')
    await until(() => loadTask(projectB.path, second.record.id)?.status === 'running')

    release()
    await until(
      () =>
        loadTask(projectA.path, first.record.id)?.status === 'review_ok' &&
        loadTask(projectB.path, second.record.id)?.status === 'review_ok',
    )
  })

  // AC2 (T1.3, D4): checks are a heavy consumer of the SAME machine cap as a
  // turn. runChecksFn injected, no real container spawned (§ 0.4).
  test('a checks run on project A blocks a turn on project B under a shared cap of 1, and it starts once checks finish', async () => {
    const projectA = register(makeRepo())
    const projectB = register(makeRepo())
    const { record: checksRecord } = seedCommittedTask(projectA.path)

    let releaseChecks: (checks: TaskChecks) => void = () => {}
    const checksGate = new Promise<TaskChecks>((resolve) => {
      releaseChecks = resolve
    })
    const cap = createLoadCap(1)
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      loadCap: cap,
      runAgentFn: async (options: AgentRunOptions): Promise<string> => {
        const raw = claudeStream('done')
        options.onText?.(raw)
        return raw
      },
      reviewTurnFn: async (record, io) => {
        record.status = 'review_ok'
        io.persist()
      },
      runChecksFn: () => checksGate,
    })

    expect(manager.checks(projectA.id, checksRecord.id)).toEqual({ ok: true })
    await until(() => cap.snapshot().occupied === 1)

    const created = manager.create(projectB.id, { title: 'B', prompt: 'task b', autoShip: false })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }
    // Held back by the MACHINE cap — project B has nothing else running.
    await until(() => loadTask(projectB.path, created.record.id)?.reason?.code === 'resource_busy')
    expect(loadTask(projectB.path, created.record.id)?.status).toBe('queued')

    releaseChecks(finishedChecks())
    await until(() => loadTask(projectB.path, created.record.id)?.status === 'review_ok')
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
  })

  // CRITIQUE (adversarial review): a checks run parked on a saturated cap has
  // no project queue of its own to make it visible or retryable — without
  // `shutdownSignal`, nothing could ever wake it, and the repro showed
  // exactly this holding the slot a review needed. `opts.shutdownSignal`
  // fixes the WAIT; this proves it wires end to end through startChecks.
  test('a checks run queued on a saturated cap is released by the shutdown signal instead of waiting forever', async () => {
    const projectA = register(makeRepo())
    const { record: checksRecord } = seedCommittedTask(projectA.path)
    const cap = createLoadCap(1)
    const holderRelease = cap.tryAcquire('turn')
    const shutdown = new AbortController()
    const runChecksFn = () => new Promise<TaskChecks>(() => {}) // must never be called
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      loadCap: cap,
      shutdownSignal: shutdown.signal,
      runChecksFn,
    })

    const envelopes: TaskEnvelope[] = []
    manager.subscribe((envelope) => envelopes.push(envelope))
    expect(manager.checks(projectA.id, checksRecord.id)).toEqual({ ok: true })
    await until(() => cap.snapshot().queued === 1)

    // Baselined BEFORE abort: boot reconciliation already appended its OWN
    // unrelated 'interrupted' line for this seeded task ("orphaned by an
    // earlier session"), so asserting on "some interrupted event exists"
    // would pass vacuously whether or not the checks fix actually fired.
    const beforeAbort = readTaskEvents(projectA.path, checksRecord.id).length
    shutdown.abort()
    // Adversarial review round 3, MAJEUR 2: a shutdown that cuts a checks run
    // off BEFORE it ever started is not a checks failure — no container ran,
    // nothing broke. The journal gets the same 'interrupted' line a turn or a
    // review cut short by the same signal gets, never 'checks'/'error'.
    await until(() => readTaskEvents(projectA.path, checksRecord.id).length > beforeAbort)
    const added = readTaskEvents(projectA.path, checksRecord.id).slice(beforeAbort)
    expect(added).toHaveLength(1)
    expect(added[0]?.type).toBe('interrupted')
    expect(added[0]?.reason_code).toBe('interrupted_by_user')
    // Round 4, MAJEUR 1: the 'running' this call broadcast BEFORE the wait is
    // taken back, not left behind. No fabricated verdict replaces it either —
    // the task had no checks result before, so it has none after, and the file
    // is gone. Leaving 'running' is what disabled the UI's "Re-run checks"
    // button forever (canRunChecks derives from it), restart included, since
    // nothing reconciles checks.json at boot.
    expect(manager.getChecks(projectA.id, checksRecord.id)).toBeNull()
    expect(readTaskChecks(projectA.path, checksRecord.id)).toBeNull()
    // And the stream said so: the last checks frame carries the null, so a
    // client already showing 'running' does not have to reload to recover.
    const lastChecksFrame = envelopes.findLast((e) => e.event.name === 'task_checks')
    expect(lastChecksFrame?.event.data).toBeNull()
    expect(readTaskEvents(projectA.path, checksRecord.id).some((e) => e.type === 'checks')).toBe(
      false,
    )

    // The wait was abandoned, not granted: the FIFO is empty (no leaked
    // waiter) and the unrelated holder's slot is untouched.
    expect(cap.snapshot()).toEqual({ occupied: 1, max: 1, queued: 0 })
    holderRelease?.()
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
  })

  // Round 4, MAJEUR 1, the other half: the task DID have a checks result
  // before the abandoned re-run. Deleting the file would lose a real verdict;
  // leaving 'running' would hide it behind a status that never finishes. The
  // snapshot captured one line above the 'running' broadcast is put back
  // verbatim, and re-broadcast.
  test('an abandoned re-run restores the checks result the task already had', async () => {
    const project = register(makeRepo())
    const { record } = seedCommittedTask(project.path)
    const previous = writeTaskChecks(project.path, record.id, finishedChecks({ status: 'passed' }))
    const cap = createLoadCap(1)
    const holderRelease = cap.tryAcquire('turn')
    const shutdown = new AbortController()
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      loadCap: cap,
      shutdownSignal: shutdown.signal,
      runChecksFn: () => new Promise<TaskChecks>(() => {}),
    })
    const envelopes: TaskEnvelope[] = []
    manager.subscribe((envelope) => envelopes.push(envelope))

    expect(manager.checks(project.id, record.id)).toEqual({ ok: true })
    // The re-run overwrote the verdict with 'running' before parking.
    expect(readTaskChecks(project.path, record.id)?.status).toBe('running')
    await until(() => cap.snapshot().queued === 1)

    shutdown.abort()
    await until(() => readTaskChecks(project.path, record.id)?.status === 'passed')
    expect(readTaskChecks(project.path, record.id)).toEqual(previous)
    expect(envelopes.findLast((e) => e.event.name === 'task_checks')?.event.data).toEqual(previous)
    holderRelease?.()
  })

  // Adversarial review round 3, MAJEUR 2 (entry guard): a shutdown already in
  // progress BEFORE a checks run is even requested must never write 'running'
  // at all — the common case behind the reviewer's repro ("Ctrl-C on a run
  // never started"), where the previous round still painted a red line.
  test('a checks run requested AFTER the shutdown signal already fired never touches checks.json', async () => {
    const project = register(makeRepo())
    const { record } = seedCommittedTask(project.path)
    const shutdown = new AbortController()
    shutdown.abort()
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      shutdownSignal: shutdown.signal,
      runChecksFn: () => {
        throw new Error('must never be called: the run must not even start')
      },
    })

    // Baselined for the same reason as the previous test: boot reconciliation
    // already appended its own unrelated 'interrupted' line for this seeded
    // task, so only a NEW event past that baseline proves the entry guard.
    const beforeChecks = readTaskEvents(project.path, record.id).length
    expect(manager.checks(project.id, record.id)).toEqual({ ok: true })
    await until(() => readTaskEvents(project.path, record.id).length > beforeChecks)
    const added = readTaskEvents(project.path, record.id).slice(beforeChecks)
    expect(added).toHaveLength(1)
    expect(added[0]?.type).toBe('interrupted')
    expect(added[0]?.reason_code).toBe('interrupted_by_user')
    // No checks.json was EVER written: 'running' never got broadcast either.
    expect(manager.getChecks(project.id, record.id)).toBeNull()
  })

  // Round 4, MAJEUR 3: the ticket's CENTRAL requirement is that the
  // end-of-turn review is a citizen of the machine-wide budget. Until this
  // test, deleting `loadCap` from the manager's `createTaskReviewer({…})`
  // call left the entire suite green — the review would quietly go back to
  // running OUTSIDE the cap, the exact state T1.3 exists to remove. Every
  // other test either injects `reviewTurnFn` (which replaces the reviewer
  // wholesale, so it can say nothing about how the default one is built) or
  // exercises the runner's own turn slot, which is a different call site.
  test('the default reviewer is built WITH the manager-wide load cap instance', () => {
    const project = register(makeRepo())
    const cap = createLoadCap(3)
    const seen: CreateTaskReviewerOptions[] = []
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      loadCap: cap,
      createRunnerFn: rig.createRunnerFn,
      createReviewerFn: (options) => {
        seen.push(options)
        return async () => {}
      },
    })
    // Forces the lazy per-project assembly (store recovery, reviewer, runner):
    // `checks` on an unknown task id builds the context, then 404s.
    manager.checks(project.id, 'aaaaaaaaaaaa')

    expect(seen).toHaveLength(1)
    // Identity, not shape: a reviewer handed a DIFFERENT cap would gate on a
    // budget nothing else shares, which is indistinguishable from no cap.
    expect(seen[0]?.loadCap).toBe(cap)
    expect(seen[0]?.cwd).toBe(project.path)
    expect(seen[0]?.command).toBe(managerOpts.command)
    expect(seen[0]?.timeoutMs).toBe(managerOpts.timeoutMs)
  })

  // MAJEUR 3 (adversarial review): `maxConcurrentAgents` reaching the REAL
  // machine cap was only ever proven on the pure function
  // `resolveMaxConcurrentAgents` — never on the effective cap `createTaskManager`
  // actually builds. Two surviving mutants this catches: `createLoadCap(opts.
  // maxConcurrentAgents)` degraded to `createLoadCap()`, and the config value
  // never reaching `createTaskManager` at all (workspace.ts's own wiring,
  // exercised here at the manager's own boundary since that is what the
  // config value must reach).
  test('maxConcurrentAgents actually sizes the manager-wide cap: at most one turn runs at a time across three projects', async () => {
    const projects = [register(makeRepo()), register(makeRepo()), register(makeRepo())]
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
    // No `loadCap` injected: the manager must build its OWN, sized from this
    // option — the exact wiring the two mutants above erase.
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      maxConcurrentAgents: 1,
      runAgentFn,
      reviewTurnFn: async (record, io) => {
        record.status = 'review_ok'
        io.persist()
      },
    })

    const created = projects.map((project, i) =>
      manager.create(project.id, { title: `p${i}`, prompt: `work ${i}`, autoShip: false }),
    )
    expect(created.every((c) => c.ok)).toBe(true)
    const ids = created.map((c) => (c.ok ? c.record.id : ''))

    const runningCount = () =>
      projects.filter((p, i) => loadTask(p.path, ids[i]!)?.status === 'running').length
    await until(() => runningCount() >= 1)
    // Give the other two every chance to (wrongly) start too.
    await new Promise((r) => setTimeout(r, 20))
    expect(runningCount()).toBe(1)
    const stillQueued = projects.filter(
      (p, i) => loadTask(p.path, ids[i]!)?.reason?.code === 'resource_busy',
    )
    expect(stillQueued.length).toBe(2)

    releaseGate()
    await until(() => ids.every((id, i) => loadTask(projects[i]!.path, id)?.status === 'review_ok'))
  })

  // machine-load-cap spec, "l'UI sait pourquoi la tâche attend".
  test('a task_meta frame carries the load-cap occupation when a turn enters — and leaves — a machine-cap wait', async () => {
    const projectB = register(makeRepo())
    const cap = createLoadCap(1)
    // An unrelated heavy consumer holds the only slot.
    const holderRelease = cap.tryAcquire('checks')
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      loadCap: cap,
      runAgentFn: async (options: AgentRunOptions): Promise<string> => {
        const raw = claudeStream('done')
        options.onText?.(raw)
        return raw
      },
      reviewTurnFn: async (record, io) => {
        record.status = 'review_ok'
        io.persist()
      },
    })
    const envelopes: TaskEnvelope[] = []
    manager.subscribe((envelope) => envelopes.push(envelope))

    const created = manager.create(projectB.id, { title: 'B', prompt: 'work', autoShip: false })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }
    // MINEUR (adversarial review round 3): filtered on `load_cap` being
    // present, not just on the frame name — an ordinary onTokens tick shares
    // the same 'task_meta' name and could otherwise land between the two
    // load-cap frames and shift `[1]` onto it, failing the test for a reason
    // that has nothing to do with a real regression.
    const loadCapFrames = () =>
      envelopes.filter(
        (e): e is TaskEnvelope & { task_id: string; event: { name: 'task_meta' } } =>
          'task_id' in e &&
          e.task_id === created.record.id &&
          e.event.name === 'task_meta' &&
          e.event.data.load_cap !== undefined,
      )
    await until(() => loadCapFrames().length >= 1)
    const waiting = loadCapFrames()[0]
    expect(waiting?.event.data).toMatchObject({
      tokens: 0,
      load_cap: { occupied: 1, max: 1, queued: 0 },
      // MAJEUR 2 (adversarial review): the snapshot alone is identical on
      // entry and on grant — `waiting_for_slot` is the ONLY thing that lets
      // the UI tell them apart.
      waiting_for_slot: true,
    })

    // Freeing the OTHER holder wakes this project's pump (onSlotFreed): the
    // task obtains the slot on its very next attempt — a SECOND frame, this
    // time saying it is no longer waiting (occupied: 1, the slot it just took).
    holderRelease?.()
    await until(() => loadCapFrames().length >= 2)
    expect(loadCapFrames()[1]?.event.data).toMatchObject({
      tokens: 0,
      load_cap: { occupied: 1, max: 1, queued: 0 },
      waiting_for_slot: false,
    })
  })

  test('a second task on the SAME project stays queued with its position and starts at the end of the first', async () => {
    const project = register(makeRepo())
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
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      // Room for three tasks, and still exactly one runs: the rule is the
      // project's queue, not the (inert) slot budget.
      maxParallel: 3,
      runAgentFn,
      reviewTurnFn: async (record, io) => {
        record.status = 'review_ok'
        io.persist()
        return Promise.resolve()
      },
    })

    const first = manager.create(project.id, { title: 'A', prompt: 'task one', autoShip: false })
    const second = manager.create(project.id, { title: 'B', prompt: 'task two', autoShip: false })
    const third = manager.create(project.id, { title: 'C', prompt: 'task three', autoShip: false })
    expect(first.ok && second.ok && third.ok).toBe(true)
    if (!first.ok || !second.ok || !third.ok) {
      return
    }
    // The head flips to 'running' once its worktree has materialized (which
    // waits for the repo's worktree lock); the two behind never move.
    await until(() => loadTask(project.path, first.record.id)?.status === 'running')
    expect(loadTask(project.path, second.record.id)?.status).toBe('queued')
    expect(loadTask(project.path, third.record.id)?.status).toBe('queued')
    // GET /api/tasks: each waiting conversation carries its rank in the line,
    // and the running one carries none.
    const listed = new Map((manager.list(project.id) ?? []).map((r) => [r.id, r.queue_position]))
    expect(listed.get(first.record.id)).toBeUndefined()
    expect(listed.get(second.record.id)).toBe(1)
    expect(listed.get(third.record.id)).toBe(2)
    // And the wait is named on the record itself (D2).
    expect(loadTask(project.path, second.record.id)?.reason).toEqual({
      code: 'resource_busy',
      detail: 'another task of this project is already active',
    })

    release()
    await until(
      () =>
        loadTask(project.path, second.record.id)?.status === 'review_ok' &&
        loadTask(project.path, third.record.id)?.status === 'review_ok',
    )
    // The queue emptied itself, in order, without a single human gesture.
    expect(readQueue(project.path).entries).toEqual([])
  })

  test('boot re-hydrates the queue: the queued tasks survive a shutdown and start on their own', async () => {
    const project = register(makeRepo())
    const runAgentFn = (options: AgentRunOptions): Promise<string> => {
      const raw = claudeStream('done\nQUESTION: next?')
      options.onText?.(raw)
      return Promise.resolve(raw)
    }
    // First process: three tasks, one running (its agent hangs until the
    // shutdown SIGTERMs it), two waiting behind it.
    const dying = createTaskManager({
      command: 'claude -p',
      timeoutMs: 60_000,
      runAgentFn: (options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('agent interrupted')))
        }),
    })
    const first = dying.create(project.id, { title: 'A', prompt: 'task one', autoShip: false })
    const second = dying.create(project.id, { title: 'B', prompt: 'task two', autoShip: false })
    const third = dying.create(project.id, { title: 'C', prompt: 'task three', autoShip: false })
    expect(first.ok && second.ok && third.ok).toBe(true)
    if (!first.ok || !second.ok || !third.ok) {
      return
    }
    await until(() => loadTask(project.path, first.record.id)?.status === 'running')
    await dying.shutdown()

    // shutdown() gives the claim back itself — no test crutch here: if it
    // leaked one, the rebuilt manager below would never start anything.
    expect(activeTask(project.id)).toBeNull()

    // The two that never ran are STILL queued, in the order they arrived.
    expect(loadTask(project.path, second.record.id)?.status).toBe('queued')
    expect(loadTask(project.path, third.record.id)?.status).toBe('queued')
    expect(readQueue(project.path).entries.map((e) => e.id)).toEqual([
      second.record.id,
      third.record.id,
    ])

    // Second process. Building the manager only reconciles disk — NOTHING
    // starts yet, which is the whole point: at that instant the real workspace
    // has no HTTP server and no Ctrl-C handler.
    const reborn = createTaskManager({ command: 'claude -p', timeoutMs: 5000, runAgentFn })
    expect(loadTask(project.path, second.record.id)?.status).toBe('queued')

    // The explicit step the workspace takes AFTER the server listens, and it
    // says what it resumed.
    const resumed = reborn.startPending()
    expect(resumed.map((entry) => ({ id: entry.project.id, queued: entry.queued }))).toEqual([
      { id: project.id, queued: 2 },
    ])
    await until(() => loadTask(project.path, second.record.id)?.status === 'waiting_for_you')
    await until(() => loadTask(project.path, third.record.id)?.status === 'waiting_for_you')
    // The turn that was in flight is 'interrupted' and stays put: only a human
    // gesture restarts it (T8), the queue never does.
    expect(loadTask(project.path, first.record.id)?.status).toBe('interrupted')
  })

  test('a corrupt queue.json never fails the boot: the queue is rebuilt from the records, out loud', () => {
    const project = register(makeRepo())
    const older = seedTask(project.path, 'older')
    const newer = seedTask(project.path, 'newer')
    // Make the creation order unambiguous for the created_at rebuild.
    older.created_at = '2020-01-01T00:00:00.000Z'
    saveTask(project.path, older)
    newer.created_at = '2021-01-01T00:00:00.000Z'
    saveTask(project.path, newer)
    // What a crash mid-write would leave IF the write were not atomic.
    mkdirSync(join(project.path, '.codesema'), { recursive: true })
    writeFileSync(queuePath(project.path), '{"version":1,"entries":[{"id":"aaaa')

    // No throw, and the boot completes.
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      onNotice: (message) => notices.push(message),
    })

    expect(readQueue(project.path).entries.map((e) => e.id)).toEqual([older.id, newer.id])
    expect(manager.list(project.id)?.find((r) => r.id === older.id)?.queue_position).toBe(1)
    // The degradation is never silent: readable reason, journal event, and the
    // journal is what GET /api/tasks/:id serves back.
    for (const id of [older.id, newer.id]) {
      const events = manager.get(project.id, id)?.events ?? []
      expect(events.map((e) => ({ type: e.type, data: e.data }))).toEqual([
        { type: 'error', data: { message: QUEUE_UNREADABLE } },
      ])
    }
    // AND on the server's own output, named per project.
    expect(notices).toEqual([`${project.name}: ${QUEUE_UNREADABLE}`])
    // The bytes that caused it are kept for the post-mortem.
    expect(readFileSync(corruptQueuePath(project.path), 'utf8')).toBe(
      '{"version":1,"entries":[{"id":"aaaa',
    )
  })

  test('a corrupt queue.json with NO task to journal is still reported, and still preserved', () => {
    const project = register(makeRepo())
    // Nothing queued: the rebuilt queue is empty, so there is no task journal
    // for the degradation to land in. It must NOT disappear because of that.
    const done = seedTask(project.path, 'already shipped')
    done.status = 'shipped'
    saveTask(project.path, done)
    mkdirSync(join(project.path, '.codesema'), { recursive: true })
    writeFileSync(queuePath(project.path), 'not json at all')

    const notices: string[] = []
    createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      onNotice: (message) => notices.push(message),
    })

    expect(notices).toEqual([`${project.name}: ${QUEUE_UNREADABLE}`])
    expect(readFileSync(corruptQueuePath(project.path), 'utf8')).toBe('not json at all')
    expect(readTaskEvents(project.path, done.id)).toEqual([])
  })

  test.skipIf(RUNNING_AS_ROOT)(
    'an unreadable queue.json is not mistaken for an absent one: the tasks are not orphaned',
    () => {
      const project = register(makeRepo())
      const queued = seedTask(project.path, 'waiting')
      writeJsonAtomic(queuePath(project.path), {
        version: 1,
        entries: [{ id: queued.id, enqueued_at: '2026-01-01T00:00:00.000Z' }],
      })
      chmodSync(queuePath(project.path), 0o000)
      const notices: string[] = []
      try {
        createTaskManager({
          ...managerOpts,
          ...fakeRunner(),
          onNotice: (message) => notices.push(message),
        })
      } finally {
        chmodSync(queuePath(project.path), 0o600)
      }
      expect(notices[0]).toContain('could not be opened')
      // The record kept its place instead of being demoted to an orphan of a
      // session that never existed.
      expect(loadTask(project.path, queued.id)?.status).toBe('queued')
    },
  )

  test.skipIf(RUNNING_AS_ROOT)('ONE broken project never takes the workspace down with it', () => {
    const healthy = register(makeRepo())
    const broken = register(makeRepo())
    const healthyTask = seedTask(healthy.path, 'fine')
    writeJsonAtomic(queuePath(healthy.path), {
      version: 1,
      entries: [{ id: healthyTask.id, enqueued_at: '2026-01-01T00:00:00.000Z' }],
    })
    // A .codesema that cannot be written into: reconcile must degrade, never
    // throw the whole boot away.
    mkdirSync(join(broken.path, '.codesema'), { recursive: true })
    writeFileSync(queuePath(broken.path), 'not json at all')
    chmodSync(join(broken.path, '.codesema'), 0o500)

    const notices: string[] = []
    let manager: TaskManager | null = null
    try {
      manager = createTaskManager({
        ...managerOpts,
        ...fakeRunner(),
        onNotice: (message) => notices.push(message),
      })
    } finally {
      chmodSync(join(broken.path, '.codesema'), 0o700)
    }

    // The workspace is up, and the healthy project is untouched.
    expect(manager).not.toBeNull()
    expect(manager?.list(healthy.id)?.find((r) => r.id === healthyTask.id)?.queue_position).toBe(1)
    expect(manager?.list(broken.id)).toEqual([])
    // Named AND readable: which project, and what actually went wrong with it.
    const named = notices.filter((line) => line.startsWith(`${broken.name}:`))
    expect(named).not.toEqual([])
    expect(named.some((line) => line.includes('queue.json'))).toBe(true)
  })

  test('the queue frames refresh: when the head leaves, everyone behind is re-broadcast with a fresh rank', async () => {
    const project = register(makeRepo())
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const manager = createTaskManager({
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
    const frames: { id: string; position: number | undefined; status: string }[] = []
    manager.subscribe((envelope) => {
      if (envelope.event.name === 'task') {
        frames.push({
          id: envelope.event.data.id,
          position: envelope.event.data.queue_position,
          status: envelope.event.data.status,
        })
      }
    })

    const first = manager.create(project.id, { title: 'A', prompt: 'task one', autoShip: false })
    const second = manager.create(project.id, { title: 'B', prompt: 'task two', autoShip: false })
    const third = manager.create(project.id, { title: 'C', prompt: 'task three', autoShip: false })
    expect(first.ok && second.ok && third.ok).toBe(true)
    if (!first.ok || !second.ok || !third.ok) {
      return
    }
    // While the first runs, the two behind are broadcast with their real rank.
    const ranks = (id: string): (number | undefined)[] =>
      frames.filter((f) => f.id === id && f.status === 'queued').map((f) => f.position)
    // The head leaves the line when its worktree is there, and that mutation is
    // what re-broadcasts the two behind with their real rank.
    await until(() => ranks(second.record.id).at(-1) === 1)
    expect(ranks(third.record.id).at(-1)).toBe(2)

    release()
    await until(() => loadTask(project.path, second.record.id)?.status !== 'queued')
    // The head left: the third one MOVED UP, and a frame said so — nothing
    // else would ever have told that card it is now first in line.
    await until(() => ranks(third.record.id).at(-1) === 1)
    await until(() => loadTask(project.path, third.record.id)?.status === 'waiting_for_you')
    // And a task that left the queue never claims a rank again.
    expect(frames.filter((f) => f.status !== 'queued').every((f) => f.position === undefined)).toBe(
      true,
    )
  })

  // T1.2 re-review, MINOR 7: this fires on EVERY queue mutation. Re-reading
  // and re-broadcasting the whole line each time made N tasks cost ~N²/2
  // frames and as many task.json reads, for numbers that mostly did not move.
  test('joining the TAIL of the line refreshes nobody: only the ranks that moved go out', async () => {
    const project = register(makeRepo())
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 60_000,
      // Never finishes on its own: the head holds the claim for the whole
      // test, and lets go only when the shutdown aborts it.
      runAgentFn: (options) =>
        new Promise<string>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    })
    const queuedFrames: string[] = []
    manager.subscribe((envelope) => {
      if (envelope.event.name === 'task' && envelope.event.data.status === 'queued') {
        queuedFrames.push(`${envelope.event.data.id}#${envelope.event.data.queue_position ?? '-'}`)
      }
    })
    const head = manager.create(project.id, { title: 'A', prompt: 'one', autoShip: false })
    expect(head.ok).toBe(true)
    await until(() => manager.list(project.id)?.some((r) => r.status === 'running') === true)

    const second = manager.create(project.id, { title: 'B', prompt: 'two', autoShip: false })
    expect(second.ok).toBe(true)
    if (!second.ok) {
      return
    }
    const afterSecond = queuedFrames.length
    const third = manager.create(project.id, { title: 'C', prompt: 'three', autoShip: false })
    expect(third.ok).toBe(true)
    if (!third.ok) {
      return
    }

    // C joined BEHIND B: B's rank did not move, so no refresh frame carries
    // its number a second time. Only C's own frames appeared.
    const refreshed = queuedFrames.slice(afterSecond)
    expect(refreshed.some((f) => f.startsWith(third.record.id))).toBe(true)
    expect(refreshed.filter((f) => f === `${second.record.id}#1`)).toEqual([])

    // The OTHER half of the bound, and the one nothing exercised: past
    // QUEUE_BROADCAST_MAX, a single mutation stops sending frames at all
    // rather than costing one per waiting task. A long line is exactly where
    // an uncapped broadcast hurts, so the line has to be longer than the cap.
    const many = QUEUE_BROADCAST_MAX + 12
    for (let n = 0; n < many; n += 1) {
      expect(manager.create(project.id, { title: `f${n}`, prompt: 'x', autoShip: false }).ok).toBe(
        true,
      )
    }
    const before = queuedFrames.length
    // Stopping the SECOND one moves every rank behind it: uncapped this is
    // one frame (and one task.json read) per waiting task.
    expect(manager.interrupt(project.id, second.record.id)).toEqual({ ok: true })
    const emitted = queuedFrames.length - before
    expect(emitted).toBeLessThanOrEqual(QUEUE_BROADCAST_MAX)
    // And it really did have that many ranks to move — otherwise the bound
    // above would pass on an empty line and prove nothing.
    expect(
      manager.list(project.id)?.filter((r) => r.status === 'queued').length ?? 0,
    ).toBeGreaterThan(QUEUE_BROADCAST_MAX)
    await manager.shutdown()
  })

  // T1.2 re-review, MINOR 4: a refused creation used to leave a 'queued'
  // record on disk that NOTHING could ever start — not in queue.json, not
  // replyable, not resumable. A card promising an agent that is not coming.
  test('a creation the queue refuses leaves no zombie: the record is settled, named and abandonable', () => {
    const project = register(makeRepo())
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: async (options) => {
        const raw = claudeStream('done.\nQUESTION: next?')
        options.onText?.(raw)
        return raw
      },
    })
    // One real task first, so the project's context (and its boot
    // reconciliation) is behind us before the queue is stuffed.
    expect(manager.create(project.id, { title: 'seed', prompt: 'seed', autoShip: false }).ok).toBe(
      true,
    )
    // A queue already at its cap: the next enqueue refuses, honestly.
    writeJsonAtomic(queuePath(project.path), {
      version: 1,
      entries: Array.from({ length: QUEUE_ENTRIES_MAX }, (_, n) => ({
        id: (n + 1).toString(16).padStart(12, '0'),
        enqueued_at: '2026-01-01T00:00:00.000Z',
      })),
    })
    const frames: TaskRecord[] = []
    manager.subscribe((envelope) => {
      if (envelope.event.name === 'task') {
        frames.push(envelope.event.data)
      }
    })

    const refused = manager.create(project.id, { title: 'A', prompt: 'work', autoShip: false })
    expect(refused.ok).toBe(false)
    if (refused.ok) {
      return
    }
    expect(refused.code).toBe(503)
    expect(refused.reason_code).toBe('resource_busy')

    // Whatever record was written is now settled, not left waiting: the last
    // frame the UI got says 'failed', with the refusal's own words.
    const last = frames.at(-1)
    expect(last?.status).toBe('failed')
    expect(last?.reason?.code).toBe('resource_busy')
    expect(last?.reason?.detail).toBe(refused.error)
    expect(loadTask(project.path, last!.id)?.status).toBe('failed')
    // And it never entered the line it was refused from.
    expect(readQueue(project.path).entries.some((e) => e.id === last?.id)).toBe(false)
  })

  // T1.2 re-review, MINOR 5: containing a listener's exception is right;
  // hiding it is the silent degradation invariant 2 forbids.
  test('a subscriber that throws is contained AND reported, never swallowed', () => {
    const project = register(makeRepo())
    const notices: string[] = []
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      onNotice: (message) => notices.push(message),
    })
    const seen: string[] = []
    manager.subscribe(() => {
      throw new Error('this listener is broken')
    })
    manager.subscribe((envelope) => seen.push(envelope.event.name))

    const created = manager.create(project.id, { title: 'A', prompt: 'work', autoShip: false })
    expect(created.ok).toBe(true)

    // The other subscribers still got their frames…
    expect(seen).toContain('task')
    // …and the failure was named rather than dropped on the floor.
    expect(notices.some((line) => line.includes('this listener is broken'))).toBe(true)
    expect(notices.some((line) => line.includes('subscriber'))).toBe(true)
  })

  // T1.2 re-review round 4, MAJOR 1: GET /api/tasks decorates its listing from
  // the queue. That read used to rename queue.json away on a single unusable
  // entry — silently, with no notice, no journal line and no repair — so one
  // listing wiped the project's line for the rest of the session.
  // T1.2 re-review round 4/5, MAJOR 1. Two halves, and they must both hold.
  //
  // Half one: a READ never touches the file. It hands back the queue rebuilt
  // from the records, reports the reason on the tasks it holds and out loud —
  // and leaves the bad bytes exactly where they are, which is what keeps
  // "corrupt" tellable from "absent" for the next boot.
  test('a listing rebuilds the queue in memory, reports it, and touches no file', () => {
    const project = register(makeRepo())
    const first = seedTask(project.path, 'first')
    const second = seedTask(project.path, 'second')
    // A queue this system wrote, so the boot keeps both records 'queued'.
    writeJsonAtomic(queuePath(project.path), {
      version: 1,
      entries: [first, second].map((task) => ({
        id: task.id,
        enqueued_at: '2026-01-01T00:00:00.000Z',
      })),
    })
    const notices: string[] = []
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      onNotice: (message) => notices.push(message),
      listProjectsFn: () => [project],
      // Nothing must start: startPending() is never called here, and this
      // test is about the READ anyway.
      runAgentFn: () => new Promise<string>(() => {}),
    })

    // The file goes bad WHILE the workspace runs — after the boot pass, which
    // has its own repair. This is the path that had none. The entry of the
    // SECOND task is the one the bad bytes hide.
    writeJsonAtomic(queuePath(project.path), {
      version: 1,
      entries: [
        { id: first.id, enqueued_at: '2026-01-01T00:00:00.000Z' },
        { id: 'NOT-AN-ID!!', enqueued_at: '2026-01-01T00:00:00.000Z' },
      ],
    })
    const onDisk = readFileSync(queuePath(project.path), 'utf8')
    const eventsBefore = readTaskEvents(project.path, first.id).length

    // The listing ranks BOTH tasks: the second is rebuilt from its record,
    // not lost with the entry that named it.
    const listed = manager.list(project.id) ?? []
    const ranks = new Map(listed.map((r) => [r.id, r.queue_position]))
    expect(ranks.get(first.id)).toBe(1)
    expect(ranks.get(second.id)).toBe(2)

    // Nothing was moved, written or renamed by a read…
    expect(readFileSync(queuePath(project.path), 'utf8')).toBe(onDisk)
    expect(existsSync(corruptQueuePath(project.path))).toBe(false)
    // …the reason reached the journal of the tasks the rebuilt queue holds…
    const added = readTaskEvents(project.path, first.id).slice(eventsBefore)
    expect(
      added.some((e) => typeof e.data.message === 'string' && e.data.message.includes('unusable')),
    ).toBe(true)
    expect(readTaskEvents(project.path, second.id).some((e) => e.type === 'error')).toBe(true)
    // …and it was said out loud, once.
    expect(notices.filter((line) => line.includes('unusable'))).toHaveLength(1)
  })

  // Half two, and the one that was missing: the repair has to survive the
  // MUTATION that triggers it. A Stop on a waiting task goes read → remove →
  // write; when the repair ran inside the read, that write put the pre-repair
  // list back and the tasks the bad bytes had hidden left the queue for good,
  // still 'queued' on disk, with nothing said.
  test('a mutation on a degraded queue keeps everyone the bad bytes hid', async () => {
    const project = register(makeRepo())
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 60_000,
      listProjectsFn: () => [project],
      runAgentFn: (options) =>
        new Promise<string>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    })
    const made = ['a', 'b', 'c', 'd'].map((title) => {
      const created = manager.create(project.id, { title, prompt: title, autoShip: false })
      expect(created.ok).toBe(true)
      if (!created.ok) {
        throw new Error('creation refused')
      }
      return created.record
    })
    const [a, b, c, d] = made as [TaskRecord, TaskRecord, TaskRecord, TaskRecord]
    await until(() => loadTask(project.path, a.id)?.status === 'running')
    expect(readQueue(project.path).entries.map((e) => e.id)).toEqual([b.id, c.id, d.id])

    // The entry that names D is corrupted; B and C survive in the file.
    writeJsonAtomic(queuePath(project.path), {
      version: 1,
      entries: [
        { id: b.id, enqueued_at: '2026-01-01T00:00:00.000Z' },
        { id: c.id, enqueued_at: '2026-01-01T00:00:00.000Z' },
        { id: 'NOT-AN-ID!!', enqueued_at: '2026-01-01T00:00:00.000Z' },
      ],
    })

    // A human presses Stop on B: remove → write, straight through the repair.
    expect(manager.interrupt(project.id, b.id)).toEqual({ ok: true })

    // D is STILL in the line. It used to be gone from the file while its
    // record still said 'queued' — never to run again, and never mentioned.
    expect(readQueue(project.path).entries.map((e) => e.id)).toEqual([c.id, d.id])
    expect(loadTask(project.path, d.id)?.status).toBe('queued')
    // The repaired file is a good one now, and the bad bytes were kept.
    expect(readQueue(project.path).degraded).toBeNull()
    expect(existsSync(corruptQueuePath(project.path))).toBe(true)
    await manager.shutdown()
  })

  // T1.2 re-review round 6, MAJEUR 1: the boot's own eviction site. A single
  // transient read failure took a valid task out of the line, rewrote the file
  // without it, and said nothing — the task came back at the END of the queue
  // on some later boot, rank lost.
  test.skipIf(RUNNING_AS_ROOT)(
    'boot: a record it could not READ keeps its place, and what it DOES retire is said',
    () => {
      const project = register(makeRepo())
      const first = seedTask(project.path, 'first')
      const unreadable = seedTask(project.path, 'unreadable')
      const third = seedTask(project.path, 'third')
      const gone = seedTask(project.path, 'gone')
      writeJsonAtomic(queuePath(project.path), {
        version: 1,
        entries: [first, unreadable, third, gone].map((task) => ({
          id: task.id,
          enqueued_at: '2026-01-01T00:00:00.000Z',
        })),
      })
      // One record the boot cannot read (EACCES on its directory), and one
      // that is genuinely no longer there.
      chmodSync(join(project.path, '.codesema', 'tasks', unreadable.id), 0o000)
      rmSync(join(project.path, '.codesema', 'tasks', gone.id), { recursive: true, force: true })

      const notices: string[] = []
      try {
        createTaskManager({
          command: 'claude -p',
          timeoutMs: 5000,
          listProjectsFn: () => [project],
          onNotice: (message) => notices.push(message),
          ...fakeRunner(),
        })
      } finally {
        chmodSync(join(project.path, '.codesema', 'tasks', unreadable.id), 0o700)
      }

      // The unreadable one KEPT its rank — second, exactly where it was.
      expect(readQueue(project.path).entries.map((e) => e.id)).toEqual([
        first.id,
        unreadable.id,
        third.id,
      ])
      // And the one it really did retire was named out loud — the id AND the
      // sentence around it, literally: the phrasing is what tells an operator
      // whether to go looking, and comparing it to the builder that produced
      // it would prove nothing about what it says.
      expect(notices).toContainEqual(
        expect.stringContaining(
          `1 queued task left the queue at boot (finished, abandoned, or no longer on disk): ${gone.id}`,
        ),
      )
      expect(notices.some((line) => line.includes(unreadable.id))).toBe(false)
      expect(queueEntriesRetired(['aaaaaaaaaaaa', 'bbbbbbbbbbbb'])).toBe(
        '2 queued tasks left the queue at boot (finished, abandoned, or no longer on disk): aaaaaaaaaaaa, bbbbbbbbbbbb',
      )
    },
  )

  // T1.2 re-review round 8, BLOQUANT 1. `unplaceable` answers "what lost its
  // RANK", so it is only meaningful when the file that held the ranks went
  // bad. The boot computed it unconditionally while the read guarded it, and
  // that asymmetry turned an illegible record which had NEVER been in the line
  // into a permanent, false, non-converging alarm on a perfectly healthy
  // queue: a notice every boot, a rewrite of a good file every boot, and an
  // `error` event stamped in the journal of every innocent task in the line.
  test.skipIf(RUNNING_AS_ROOT)(
    'boot: an unrelated illegible record does not fabricate a degradation on a HEALTHY queue',
    () => {
      const project = register(makeRepo())
      const innocent = seedTask(project.path, 'innocent')
      // Never enqueued, never related to the line — just a record on disk that
      // this pass cannot parse.
      const stranger = seedTask(project.path, 'stranger')
      writeJsonAtomic(queuePath(project.path), {
        version: 1,
        entries: [{ id: innocent.id, enqueued_at: '2026-01-01T00:00:00.000Z' }],
      })
      const strangerDir = join(project.path, '.codesema', 'tasks', stranger.id)
      chmodSync(strangerDir, 0o000)

      // The file is HEALTHY: that is the whole premise.
      expect(readQueue(project.path).degraded).toBeNull()
      // Two consecutive boots, because the bug did not converge: it re-fired
      // identically forever, and one boot alone could look like a one-off.
      const notices: string[] = []
      const boot = (): void => {
        createTaskManager({
          command: 'claude -p',
          timeoutMs: 5000,
          listProjectsFn: () => [project],
          onNotice: (message) => notices.push(message),
          ...fakeRunner(),
        })
      }
      const inodeBefore = statSync(queuePath(project.path)).ino
      const observed: { notices: string[]; rewritten: boolean; events: number }[] = []
      try {
        for (const _ of [1, 2]) {
          notices.length = 0
          boot()
          observed.push({
            notices: [...notices],
            // tmp + rename publishes a NEW inode, so an unchanged one is
            // proof the good file was left exactly as it was.
            rewritten: statSync(queuePath(project.path)).ino !== inodeBefore,
            // An `error` line in an innocent task's journal is what a human
            // would act on — and it accumulated, one per boot, forever.
            events: readTaskEvents(project.path, innocent.id).length,
          })
        }
      } finally {
        chmodSync(strangerDir, 0o700)
      }
      // The three consequences asserted TOGETHER, so a regression shows all of
      // them at once rather than hiding two behind the first failure.
      expect(observed).toEqual([
        { notices: [], rewritten: false, events: 0 },
        { notices: [], rewritten: false, events: 0 },
      ])
      // The line itself is intact.
      expect(readQueue(project.path).entries.map((e) => e.id)).toEqual([innocent.id])
    },
  )

  // T1.2 re-review round 8, BLOQUANT 2. Making `listTasks` tolerant of a
  // tasks/ directory that will not list traded a loud failure ("boot recovery
  // failed (EACCES ... scandir ...)") for total silence: the whole store of a
  // project read as EMPTY, the board showed nothing, and the workspace said
  // nothing at all. Tolerance is invariant 1; saying so is invariant 2, and
  // one is not payment for the other.
  test.skipIf(RUNNING_AS_ROOT)('a task store that will not LIST is said out loud, by name', () => {
    const project = register(makeRepo())
    seedTask(project.path, 'invisible')
    const notices: string[] = []
    chmodSync(join(project.path, '.codesema', 'tasks'), 0o000)
    try {
      const manager = createTaskManager({
        command: 'claude -p',
        timeoutMs: 5000,
        listProjectsFn: () => [project],
        onNotice: (message) => notices.push(message),
        ...fakeRunner(),
      })
      // Tolerant: the workspace still booted, and listing still answers.
      expect(manager.list(project.id)).toEqual([])
    } finally {
      chmodSync(join(project.path, '.codesema', 'tasks'), 0o700)
    }
    // Not mute: the project is named, and so is the failure. The literal is
    // deliberate — anchoring on the builder that produced the string would
    // prove nothing about what it says.
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain(project.name)
    expect(notices[0]).toContain('the task store of this project could not be listed')
    expect(STORE_UNLISTABLE).toBe('the task store of this project could not be listed')
  })

  test('boot reconciles the queue with the records: terminal and vanished ids out, orphan queued in', () => {
    const project = register(makeRepo())
    const stillQueued = seedTask(project.path, 'still queued')
    const shipped = seedTask(project.path, 'already shipped')
    shipped.status = 'shipped'
    saveTask(project.path, shipped)
    const orphan = seedTask(project.path, 'queued but never enqueued')
    orphan.created_at = '2030-01-01T00:00:00.000Z'
    saveTask(project.path, orphan)
    // A file naming a terminal task, a task that no longer exists, and a
    // legitimately queued one.
    writeJsonAtomic(queuePath(project.path), {
      version: 1,
      entries: [
        { id: shipped.id, enqueued_at: '2020-01-01T00:00:00.000Z' },
        { id: 'ffffffffffff', enqueued_at: '2020-01-01T00:00:00.000Z' },
        { id: stillQueued.id, enqueued_at: '2020-01-01T00:00:00.000Z' },
      ],
    })

    createTaskManager({ ...managerOpts, ...fakeRunner() })

    // The valid one keeps its place; the orphan joins the END.
    expect(readQueue(project.path).entries.map((e) => e.id)).toEqual([stillQueued.id, orphan.id])
    // A readable file is not a degradation: nothing is journaled.
    expect(readTaskEvents(project.path, stillQueued.id)).toHaveLength(0)
  })

  test('0.12 migration: an inherited queued record becomes interrupted — never an agent started by surprise', async () => {
    const project = register(makeRepo())
    // A .codesema/tasks/ tree exactly as 0.12 wrote it: no queue.json, two
    // 'queued' records, and one 'interrupted {reason:shutdown}' whose last
    // turn never answered — the shape 0.12's shutdown produced.
    const secondQueued = seedTask(project.path, 'queued second', 'later work')
    secondQueued.created_at = '2026-01-02T00:00:00.000Z'
    saveTask(project.path, secondQueued)
    const firstQueued = seedTask(project.path, 'queued first', 'earlier work')
    firstQueued.created_at = '2026-01-01T00:00:00.000Z'
    saveTask(project.path, firstQueued)
    const stopped = seedTask(project.path, 'stopped by 0.12', 'unfinished work')
    stopped.status = 'interrupted'
    saveTask(project.path, stopped)
    appendTaskEvent(project.path, stopped.id, {
      type: 'interrupted',
      data: { reason: 'shutdown' },
    })
    expect(existsSync(queuePath(project.path))).toBe(false)

    const prompts: string[] = []
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: (options) => {
        prompts.push(options.prompt)
        const raw = claudeStream('picked it up\nQUESTION: keep going?')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
    })

    // The boot succeeded and every task is listed.
    const listed = manager.list(project.id) ?? []
    expect(new Set(listed.map((r) => r.id))).toEqual(
      new Set([firstQueued.id, secondQueued.id, stopped.id]),
    )
    // The two inherited 'queued' records are ORPHANS of a session that died,
    // not a line waiting its turn: no queue.json ever named them. They become
    // 'interrupted' — offered under "needs you" — and nothing starts.
    for (const id of [firstQueued.id, secondQueued.id]) {
      const orphan = loadTask(project.path, id)
      expect(orphan?.status).toBe('interrupted')
      // Named for a machine as well as for a human: this was the ONE
      // degradation of the store that carried no D2 code, while the CHANGELOG
      // and README both promised one.
      expect(orphan?.reason?.code).toBe('interrupted_by_user')
      expect(orphan?.reason?.detail).toBe(
        'orphaned by an earlier session: nothing was queued to start it',
      )
      const last = readTaskEvents(project.path, id).at(-1)
      expect(last?.data.message).toBe(
        'orphaned by an earlier session: nothing was queued to start it',
      )
      expect(last?.reason_code).toBe('interrupted_by_user')
    }
    expect(manager.startPending()).toEqual([])
    expect(prompts).toEqual([])
    expect(existsSync(queuePath(project.path))).toBe(false)

    // And the 0.12 'interrupted' record is still resumable, unchanged: same
    // schema, version still 1, no field removed — on a HUMAN gesture.
    const before = loadTask(project.path, stopped.id)
    expect(before?.version).toBe(1)
    expect(pendingResumeTurn(before!)).not.toBeNull()
    expect(manager.resume(project.id, stopped.id)).toEqual({ ok: true })
    await until(() => loadTask(project.path, stopped.id)?.status === 'waiting_for_you')
    expect(loadTask(project.path, stopped.id)?.version).toBe(1)
    // The orphans are resumable the same way, one human click each.
    expect(manager.resume(project.id, firstQueued.id)).toEqual({ ok: true })
    await until(() => loadTask(project.path, firstQueued.id)?.status === 'waiting_for_you')
  })

  test('auto_ship chains ship right after a review_ok, without any click', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const runAgentFn = async (options: AgentRunOptions): Promise<string> => {
      const raw = claudeStream('all done')
      options.onText?.(raw)
      return raw
    }
    const shipCalls: string[] = []
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn,
      // The fake agent writes nothing, so the real reviewer would land on its
      // no-changes review_ok path too — the stub keeps the test deterministic.
      reviewTurnFn: async (record, io) => {
        record.status = 'review_ok'
        io.persist()
        return Promise.resolve()
      },
      shipTaskFn: (options) => {
        shipCalls.push(options.task.id)
        return Promise.resolve({ pushed: true, mrUrl: 'https://github.com/o/r/pull/3', note: null })
      },
    })

    const created = manager.create(project.id, {
      title: 'Night shift',
      prompt: 'do it while I sleep',
      autoShip: true,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }
    await until(() => loadTask(repo, created.record.id)?.status === 'shipped')
    expect(shipCalls).toEqual([created.record.id])
    expect(readTaskEvents(repo, created.record.id)).toMatchObject([
      { type: 'isolation', data: { isolation: 'policy' } },
      { type: 'turn_started' },
      { type: 'message' },
      { type: 'shipped', data: { mr_url: 'https://github.com/o/r/pull/3' } },
    ])
  })

  test('auto_ship never fires on a review_ko: the KO waits for the human', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const runAgentFn = async (options: AgentRunOptions): Promise<string> => {
      const raw = claudeStream('all done')
      options.onText?.(raw)
      return raw
    }
    const shipCalls: string[] = []
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn,
      reviewTurnFn: async (record, io) => {
        record.status = 'review_ko'
        io.persist()
        return Promise.resolve()
      },
      shipTaskFn: (options) => {
        shipCalls.push(options.task.id)
        return Promise.resolve({ pushed: true, mrUrl: null, note: null })
      },
    })

    const created = manager.create(project.id, {
      title: 'Risky change',
      prompt: 'try it',
      autoShip: true,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }
    await until(() => loadTask(repo, created.record.id)?.status === 'review_ko')
    // Give a wrongly-chained ship a beat to show up before asserting it never came.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(shipCalls).toEqual([])
    expect(loadTask(repo, created.record.id)?.status).toBe('review_ko')
  })
})

describe('checks setup routes', () => {
  const PROPOSAL = {
    image: 'oven/bun:1',
    install: 'bun install --frozen-lockfile',
    commands: ['bun run typecheck', 'bun test'],
    network: true,
    timeoutSeconds: 300,
    rationale: 'bun lockfile with a pre-push hook running typecheck and tests',
  }

  test('POST proposes, GET reports, POST apply writes the config — and nothing before that', async () => {
    const project = register(makeRepo())
    const runs: AgentRunOptions[] = []
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 1000,
      runSetupAgentFn: (options) => {
        runs.push(options)
        return Promise.resolve(`Here you go:\n${JSON.stringify(PROPOSAL)}`)
      },
    })
    const started = await startServer(createSession(), {
      cwd: project.path,
      port: 5171,
      taskManager: manager,
    })
    const setupPath = `/api/projects/${project.id}/checks-setup`
    const applyPath = `/api/projects/${project.id}/checks-apply`
    try {
      const token = await tasksToken(started.port)
      const headers = { 'x-codesema-tasks-token': token }

      // Nothing ran yet: idle, and unknown projects 404 on every verb.
      expect(JSON.parse((await rawRequest(started.port, setupPath)).body)).toEqual({
        status: 'idle',
      })
      expect((await rawRequest(started.port, '/api/projects/ffffffff/checks-setup')).status).toBe(
        404,
      )
      expect(
        (
          await rawRequest(started.port, '/api/projects/ffffffff/checks-setup', {
            method: 'POST',
            headers,
          })
        ).status,
      ).toBe(404)

      // Mutations need the CSRF token.
      expect((await rawRequest(started.port, setupPath, { method: 'POST' })).status).toBe(403)
      expect((await rawRequest(started.port, applyPath, { method: 'POST' })).status).toBe(403)
      expect(runs).toHaveLength(0)

      const accepted = await rawRequest(started.port, setupPath, { method: 'POST', headers })
      expect(accepted.status).toBe(202)
      expect(JSON.parse(accepted.body)).toEqual({ ok: true })

      for (let i = 0; i < 200; i++) {
        const state = JSON.parse((await rawRequest(started.port, setupPath)).body) as {
          status: string
        }
        if (state.status === 'ready') {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(JSON.parse((await rawRequest(started.port, setupPath)).body)).toEqual({
        status: 'ready',
        proposal: PROPOSAL,
      })
      // The agent ran read-only, in the project, on a prompt-fed file list.
      expect(runs[0]?.cwd).toBe(project.path)
      expect(runs[0]?.command).toContain('--tools ""')

      // A proposal is NOT a configuration: nothing on disk until the apply.
      expect(readChecksConfig(project.path)).toBeNull()

      const applied = await rawRequest(started.port, applyPath, { method: 'POST', headers })
      expect(applied.status).toBe(200)
      expect(readChecksConfig(project.path)).toEqual({
        image: 'oven/bun:1',
        install: 'bun install --frozen-lockfile',
        commands: ['bun run typecheck', 'bun test'],
        network: true,
        timeoutSeconds: 300,
      })
      // Applying consumes the proposal.
      expect(JSON.parse((await rawRequest(started.port, setupPath)).body)).toEqual({
        status: 'idle',
      })
      const reapplied = await rawRequest(started.port, applyPath, { method: 'POST', headers })
      expect(reapplied.status).toBe(409)
      expect(JSON.parse(reapplied.body)).toEqual({ error: 'no checks proposal to apply' })
    } finally {
      await started.stop()
    }
  })

  test('a run in flight answers 409 and its transitions ride the SSE stream', async () => {
    const project = register(makeRepo())
    // One record so the SSE replay flushes the stream's headers immediately.
    seedTask(project.path)
    let release: (value: string) => void = () => {}
    const pending = new Promise<string>((resolve) => {
      release = resolve
    })
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 1000,
      runSetupAgentFn: () => pending,
    })
    const started = await startServer(createSession(), {
      cwd: project.path,
      port: 5181,
      taskManager: manager,
    })
    const setupPath = `/api/projects/${project.id}/checks-setup`
    try {
      const headers = { 'x-codesema-tasks-token': await tasksToken(started.port) }
      const chunks: string[] = []
      let connected = false
      const req = request(
        { host: '127.0.0.1', port: started.port, path: '/api/tasks/events' },
        (res) => {
          connected = true
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            chunks.push(chunk)
          })
        },
      )
      req.end()
      // The subscriber must be attached before the POST emits 'running'; the
      // replayed task frame is what proves the stream is live.
      await until(() => connected && chunks.join('').includes('event: task\n'))

      expect((await rawRequest(started.port, setupPath, { method: 'POST', headers })).status).toBe(
        202,
      )
      const busy = await rawRequest(started.port, setupPath, { method: 'POST', headers })
      expect(busy.status).toBe(409)
      expect(JSON.parse(busy.body)).toEqual({ error: 'a checks setup is already running' })

      await until(() => chunks.join('').includes('event: checks_proposal\n'))
      release(JSON.stringify(PROPOSAL))
      await until(() => chunks.join('').includes('"status":"ready"'))
      // Project-scoped frames carry no task_id: the proposal is repo-wide.
      const frame = /event: checks_proposal\nid: \d+\ndata: (.*)\n/.exec(chunks.join(''))
      expect(JSON.parse(frame![1]!)).toEqual({
        project_id: project.id,
        event: {
          name: 'checks_proposal',
          data: { status: 'running', started_at: expect.any(String) },
        },
      })
      req.destroy()
    } finally {
      await started.stop()
    }
  })

  test('without a configured agent the setup route answers 501', async () => {
    const project = register(makeRepo())
    const manager = createTaskManager({ command: '', timeoutMs: 1000 })
    const started = await startServer(createSession(), {
      cwd: project.path,
      port: 5191,
      taskManager: manager,
    })
    try {
      const headers = { 'x-codesema-tasks-token': await tasksToken(started.port) }
      const refused = await rawRequest(started.port, `/api/projects/${project.id}/checks-setup`, {
        method: 'POST',
        headers,
      })
      expect(refused.status).toBe(501)
      expect(JSON.parse(refused.body)).toEqual({ error: 'no agent configured' })
    } finally {
      await started.stop()
    }
  })

  test('without a task manager at all every checks-setup route answers 501', async () => {
    const started = await startServer(createSession(), { cwd: makeDir(), port: 5192 })
    try {
      expect((await rawRequest(started.port, '/api/projects/x/checks-setup')).status).toBe(501)
      expect(
        (await rawRequest(started.port, '/api/projects/x/checks-setup', { method: 'POST' })).status,
      ).toBe(501)
      expect(
        (await rawRequest(started.port, '/api/projects/x/checks-apply', { method: 'POST' })).status,
      ).toBe(501)
    } finally {
      await started.stop()
    }
  })
})

// --- manager.sweepOrphanedVolumes / manager.applyRetention (T1.9) ---------

describe('manager.sweepOrphanedVolumes', () => {
  test("claimed ids span EVERY registered project, and the sweep's notices are forwarded verbatim", async () => {
    const projectA = register(makeRepo())
    const projectB = register(makeRepo())
    const claimedA = seedTask(projectA.path, 'a task')
    const claimedB = seedTask(projectB.path, 'b task')
    const seenClaimed: ReadonlySet<string>[] = []
    const notices: string[] = []
    const outcome: HomeVolumeSweepOutcome = {
      removed: ['orphan1'],
      notices: [
        'orphaned HOME volume codesema-home-orphan1 removed at boot: no task record claims it',
      ],
    }
    const manager = createTaskManager({
      ...managerOpts,
      onNotice: (message) => notices.push(message),
      sweepOrphanedVolumesFn: (opts) => {
        seenClaimed.push(opts.claimedIds)
        return Promise.resolve(outcome)
      },
      ...fakeRunner(),
    })

    await manager.sweepOrphanedVolumes()

    expect(seenClaimed).toEqual([new Set([claimedA.id, claimedB.id])])
    expect(notices).toEqual(outcome.notices)
  })

  // T1.9 review round 1, Critique 1: listTasks/loadTask drops an unparsable
  // task.json IN SILENCE (no onStoreUnreadable call — the directory listed
  // fine, only the file's content didn't parse). Building claimedIds from it
  // would un-claim a LIVE task's id the moment its record is merely
  // mid-write or transiently unreadable, and the sweep would remove its
  // volume out from under it.
  test('a task whose task.json cannot currently be PARSED still claims its id (directory name, not file content)', async () => {
    const project = register(makeRepo())
    const alive = seedTask(project.path, 'mid-write or corrupt, still very much alive')
    writeFileSync(join(taskDir(project.path, alive.id), 'task.json'), '{ not json at all')
    // listTasks silently drops it — the very trap this fix avoids.
    expect(listTasks(project.path).map((r) => r.id)).not.toContain(alive.id)

    const seenClaimed: ReadonlySet<string>[] = []
    const manager = createTaskManager({
      ...managerOpts,
      sweepOrphanedVolumesFn: (opts) => {
        seenClaimed.push(opts.claimedIds)
        return Promise.resolve({ removed: [], notices: [] })
      },
      ...fakeRunner(),
    })

    await manager.sweepOrphanedVolumes()

    expect(seenClaimed[0]?.has(alive.id)).toBe(true)
  })

  test.skipIf(RUNNING_AS_ROOT)(
    'a project whose store could not be listed forbids the sweep rather than narrowing it (Risk 1)',
    async () => {
      const project = register(makeRepo())
      seedTask(project.path, 'invisible')
      let called = false
      chmodSync(join(project.path, '.codesema', 'tasks'), 0o000)
      const notices: string[] = []
      try {
        const manager = createTaskManager({
          ...managerOpts,
          onNotice: (message) => notices.push(message),
          sweepOrphanedVolumesFn: () => {
            called = true
            return Promise.resolve({ removed: [], notices: [] })
          },
          ...fakeRunner(),
        })
        await manager.sweepOrphanedVolumes()
      } finally {
        chmodSync(join(project.path, '.codesema', 'tasks'), 0o700)
      }
      expect(called).toBe(false)
      expect(notices.some((line) => line.includes('sweep skipped'))).toBe(true)
    },
  )

  test.skipIf(RUNNING_AS_ROOT)(
    'a boot-time listing failure keeps forbidding the sweep even once the store reads again (storeReadFailed is sticky, never cleared)',
    async () => {
      const project = register(makeRepo())
      seedTask(project.path, 'invisible')
      chmodSync(join(project.path, '.codesema', 'tasks'), 0o000)
      let called = false
      const notices: string[] = []
      const manager = createTaskManager({
        ...managerOpts,
        onNotice: (message) => notices.push(message),
        sweepOrphanedVolumesFn: () => {
          called = true
          return Promise.resolve({ removed: [], notices: [] })
        },
        ...fakeRunner(),
      })
      // The store reads again by the time the sweep itself would list it —
      // only the STALE boot-time failure remains. A check performed only
      // AFTER building a fresh inventory would miss this case entirely.
      chmodSync(join(project.path, '.codesema', 'tasks'), 0o700)
      await manager.sweepOrphanedVolumes()

      expect(called).toBe(false)
      expect(notices.some((line) => line.includes('sweep skipped'))).toBe(true)
    },
  )

  test('a sweep that throws is reported, never left to crash the caller', async () => {
    const project = register(makeRepo())
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      onNotice: (message) => notices.push(message),
      sweepOrphanedVolumesFn: () => Promise.reject(new Error('daemon unreachable')),
      ...fakeRunner(),
    })
    void project

    await expect(manager.sweepOrphanedVolumes()).resolves.toBeUndefined()
    expect(notices.some((line) => line.includes('daemon unreachable'))).toBe(true)
  })

  // T1.9 review round 1, Critique 2: listProjects()/registered() degrades
  // SILENTLY on a corrupt or hand-edited projects.json (documented in
  // projects.ts as "degrades to an empty (or partial) registry") — nothing
  // of that ever reached storeReadFailed, so the sweep ran on a narrowed or
  // even EMPTY project list and could remove every codesema-home-* volume
  // on the daemon. listProjectsDetailed's `complete` flag closes it.
  test('a projects.json entry the sanitizer had to drop forbids the sweep (registry incomplete, not just narrower)', async () => {
    const project = register(makeRepo())
    seedTask(project.path, 'still claims a volume')
    // Hand-edited: an id that is not 8 hex, exactly the reproduction from
    // the review — sanitizeProject drops the WHOLE entry, silently, in the
    // real listProjects().
    writeFileSync(
      projectsPath(),
      JSON.stringify({
        projects: [{ id: 'not-8-hex', path: project.path, added_at: new Date().toISOString() }],
      }),
    )
    let called = false
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      onNotice: (message) => notices.push(message),
      sweepOrphanedVolumesFn: () => {
        called = true
        return Promise.resolve({ removed: [], notices: [] })
      },
      ...fakeRunner(),
    })

    await manager.sweepOrphanedVolumes()

    expect(called).toBe(false)
    expect(notices.some((line) => line.includes('sweep skipped'))).toBe(true)
  })

  // Isolates `complete: false` from `projectCount === 0`: a SECOND, dropped
  // entry alongside one perfectly good, real project. The registry here is
  // NOT empty (one project, with a task claiming a volume) — a mutant that
  // only checks `projectCount === 0` and drops the `complete` check would
  // pass every OTHER Critique 2 test above (all of which happen to leave
  // zero surviving projects) while missing this one entirely.
  test('one dropped entry forbids the sweep even with another, perfectly readable project still in the registry', async () => {
    const good = register(makeRepo())
    seedTask(good.path, 'still claims a volume')
    const raw = JSON.parse(readFileSync(projectsPath(), 'utf8')) as { projects: unknown[] }
    raw.projects.push({ id: 'not-8-hex', path: '/nowhere', added_at: new Date().toISOString() })
    writeFileSync(projectsPath(), JSON.stringify(raw))
    expect(listProjects()).toHaveLength(1) // the registry is NOT empty
    let called = false
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      onNotice: (message) => notices.push(message),
      sweepOrphanedVolumesFn: () => {
        called = true
        return Promise.resolve({ removed: [], notices: [] })
      },
      ...fakeRunner(),
    })

    await manager.sweepOrphanedVolumes()

    expect(called).toBe(false)
    expect(notices.some((line) => line.includes('sweep skipped'))).toBe(true)
  })

  // T1.9 review round 3, CRITIQUE (ceinture `pathUnresolved`) — the correction
  // shipped WITHOUT a test, and removing `&& !pathUnresolved` left the whole
  // suite green. Non-equivalence, reproduced here: project B is registered,
  // still has live tasks, and its directory has MOVED (renamed, unmounted,
  // relocated) — `taskIdsOnDisk` on a path that no longer resolves degrades to
  // [] through taskDirEntries' own ENOENT handling, which is harmless on its
  // own and catastrophic when folded into the sweep's inventory: without the
  // belt, the sweep RUNS on an inventory amputated of every one of B's ids,
  // and each HOME volume one of B's live tasks still claims is declared
  // orphaned and destroyed. A registered path that will not resolve is not a
  // project claiming nothing — it is one this process cannot read.
  test('a registered project whose path no longer resolves forbids the sweep, it never reads as "claims nothing"', async () => {
    const good = register(makeRepo())
    seedTask(good.path, 'A still claims a volume')
    const moved = register(makeRepo())
    const liveInB = seedTask(moved.path, 'B still claims a volume too')
    // The repo MOVES: its tasks (and the volumes they claim) still exist,
    // they are simply not where the registry says any more.
    const elsewhere = `${moved.path}-relocated`
    renameSync(moved.path, elsewhere)
    cleanups.push(elsewhere)
    expect(existsSync(moved.path)).toBe(false)
    expect(taskRecordExists(elsewhere, liveInB.id)).toBe(true)
    expect(listProjects()).toHaveLength(2) // the registry itself is intact and complete

    let seenClaimed: ReadonlySet<string> | null = null
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      onNotice: (message) => notices.push(message),
      sweepOrphanedVolumesFn: (opts) => {
        seenClaimed = opts.claimedIds
        return Promise.resolve({ removed: [], notices: [] })
      },
      ...fakeRunner(),
    })

    await manager.sweepOrphanedVolumes()

    // Not "ran on A's ids only" — did not run at all.
    expect(seenClaimed).toBeNull()
    expect(notices.some((line) => line.includes('sweep skipped'))).toBe(true)
  })

  test('an unparsable projects.json forbids the sweep rather than reading as zero projects', async () => {
    writeFileSync(projectsPath(), '{ this is not json')
    let called = false
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      onNotice: (message) => notices.push(message),
      sweepOrphanedVolumesFn: () => {
        called = true
        return Promise.resolve({ removed: [], notices: [] })
      },
      ...fakeRunner(),
    })

    await manager.sweepOrphanedVolumes()

    expect(called).toBe(false)
    expect(notices.some((line) => line.includes('sweep skipped'))).toBe(true)
  })

  test('an empty (but technically well-formed) registry never runs the sweep either — belt and suspenders', async () => {
    let called = false
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      onNotice: (message) => notices.push(message),
      // A registry that reads as COMPLETE but genuinely empty — the ENOENT
      // case in listProjectsDetailed, or every project having been removed.
      // projectCount === 0 must forbid the sweep on its own, independent of
      // `complete`, per "never sweep an empty inventory".
      listProjectsDetailedFn: () => ({ projects: [], complete: true }),
      sweepOrphanedVolumesFn: () => {
        called = true
        return Promise.resolve({ removed: [], notices: [] })
      },
      ...fakeRunner(),
    })

    await manager.sweepOrphanedVolumes()

    expect(called).toBe(false)
    expect(notices.some((line) => line.includes('sweep skipped'))).toBe(true)
  })

  // T1.9 review round 1, Critique 3: claimedIds is a snapshot taken BEFORE
  // the slow volume ls/rm round trips. A task created (its task.json
  // written) in that window must not lose its volume — proven here by
  // driving the manager's OWN recheckClaimedIds end to end against a real
  // repo, exactly as sweepOrphanedHomeVolumes would call it.
  test('recheckClaimedIds is wired to the LIVE registry: a task created after the snapshot is claimed on recheck', async () => {
    const project = register(makeRepo())
    let recheck: (() => ReadonlySet<string> | null) | undefined
    const manager = createTaskManager({
      ...managerOpts,
      sweepOrphanedVolumesFn: (opts) => {
        recheck = opts.recheckClaimedIds
        return Promise.resolve({ removed: [], notices: [] })
      },
      ...fakeRunner(),
    })

    await manager.sweepOrphanedVolumes()
    expect(recheck).toBeDefined()
    expect(recheck?.()).toEqual(new Set())

    // A task created AFTER the sweep's initial snapshot but before this
    // recheck — exactly what a live volume ls/rm round trip leaves time for.
    const justCreated = seedTask(project.path, 'created mid-sweep')
    expect(recheck?.()).toEqual(new Set([justCreated.id]))
  })

  test('recheckClaimedIds returns null (never an empty Set) once the registry stops being readable — forbidding the removal it guards, not permitting it', async () => {
    const project = register(makeRepo())
    seedTask(project.path, 'x')
    let recheck: (() => ReadonlySet<string> | null) | undefined
    const manager = createTaskManager({
      ...managerOpts,
      sweepOrphanedVolumesFn: (opts) => {
        recheck = opts.recheckClaimedIds
        return Promise.resolve({ removed: [], notices: [] })
      },
      ...fakeRunner(),
    })
    await manager.sweepOrphanedVolumes()
    expect(recheck).toBeDefined()

    writeFileSync(projectsPath(), '{ broken')
    expect(recheck?.()).toBeNull()
  })
})

describe('manager.applyRetention', () => {
  test('runs per registered project, with the configured keep count and the project name on each notice', async () => {
    const projectA = register(makeRepo())
    const projectB = register(makeRepo())
    const seen: { cwd: string; keep: number }[] = []
    const outcome: TaskRetentionOutcome = {
      purged: ['x'],
      notices: ['task x: retention_worktree_purged — …'],
    }
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      taskRetention: 5,
      onNotice: (message) => notices.push(message),
      applyTaskRetentionFn: (opts) => {
        seen.push({ cwd: opts.cwd, keep: opts.keep })
        return Promise.resolve(outcome)
      },
      ...fakeRunner(),
    })

    await manager.applyRetention()

    expect(seen).toEqual([
      { cwd: projectA.path, keep: 5 },
      { cwd: projectB.path, keep: 5 },
    ])
    expect(notices).toEqual([
      `${projectA.name}: ${outcome.notices[0]}`,
      `${projectA.name}: retention purged 1 task(s)`,
      `${projectB.name}: ${outcome.notices[0]}`,
      `${projectB.name}: retention purged 1 task(s)`,
    ])
  })

  // T1.9 review round 3, Mineur 8: `outcome.purged` gets its own production
  // consumer — a per-project summary count — but only when something was
  // actually purged; a project where retention had nothing to do stays
  // silent rather than adding a "purged 0 task(s)" line nobody needs.
  test('purged summary line is skipped when nothing was actually purged', async () => {
    register(makeRepo())
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      onNotice: (message) => notices.push(message),
      applyTaskRetentionFn: () => Promise.resolve({ purged: [], notices: [] }),
      ...fakeRunner(),
    })

    await manager.applyRetention()

    expect(notices.some((line) => line.includes('purged'))).toBe(false)
  })

  test('the default keep count applies when unconfigured', async () => {
    register(makeRepo())
    const seen: number[] = []
    const manager = createTaskManager({
      ...managerOpts,
      applyTaskRetentionFn: (opts) => {
        seen.push(opts.keep)
        return Promise.resolve({ purged: [], notices: [] })
      },
      ...fakeRunner(),
    })

    await manager.applyRetention()

    expect(seen).toEqual([20]) // DEFAULT_TASK_RETENTION
  })

  test('one project failing does not stop the others (fenced per project, like boot recovery)', async () => {
    const projectA = register(makeRepo())
    const projectB = register(makeRepo())
    const notices: string[] = []
    const ran: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      onNotice: (message) => notices.push(message),
      applyTaskRetentionFn: (opts) => {
        ran.push(opts.cwd)
        if (opts.cwd === projectA.path) {
          return Promise.reject(new Error('disk full'))
        }
        return Promise.resolve({ purged: [], notices: [] })
      },
      ...fakeRunner(),
    })

    await manager.applyRetention()

    expect(ran).toEqual([projectA.path, projectB.path])
    expect(notices.some((line) => line.includes('disk full'))).toBe(true)
  })
})
