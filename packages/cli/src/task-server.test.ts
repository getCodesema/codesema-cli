import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentRunOptions } from './agent.js'
import type { TaskChecks, TaskEvent, TaskRecord } from './contract.js'
import { addProject, listProjects, type Project } from './projects.js'
import { readChecksConfig } from './repo-config.js'
import { createSession, startServer } from './serve.js'
import type { RunChecksOptions } from './task-checks.js'
import type { TaskRunner, TaskRunnerOptions } from './task-runner.js'
import { createTaskManager, type TaskEnvelope, type TaskManager } from './task-server.js'
import type { ShipOutcome, ShipTaskOptions } from './task-ship.js'
import {
  appendTaskEvent,
  createTask,
  loadTask,
  readTaskChecks,
  readTaskEvents,
  saveTask,
  writeTaskChecks,
} from './tasks-store.js'

// --- rigs -----------------------------------------------------------------

// The project registry is global state: redirected to a fresh tmpdir per test
// via CODESEMA_CONFIG_DIR so tests never touch the real ~/.config/codesema.
let configDir: string
const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
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
}

/** Captures the manager→runner seam without ever launching an agent. */
function fakeRunner(): FakeRunnerRig {
  const rig: FakeRunnerRig = {
    allRunnerOptions: [],
    starts: [],
    replies: [],
    interrupts: [],
    abandons: [],
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
        interrupt: (id) => {
          rig.interrupts.push(id)
          return { ok: true }
        },
        abandon: (id) => {
          rig.abandons.push(id)
          return { ok: true }
        },
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
    expect(loadTask(repoB, queued.id)?.status).toBe('queued')
    expect(readTaskEvents(repoB, queued.id)).toHaveLength(0)
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
    expect(await manager.ship('deadbeef', 'aaaaaaaaaaaa')).toMatchObject({ ok: false, code: 404 })
    expect(manager.abandon('deadbeef', 'aaaaaaaaaaaa')).toMatchObject({ ok: false, code: 404 })
    expect(rig.allRunnerOptions).toHaveLength(0)
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
    expect(envelopes).toEqual([
      {
        project_id: projectB.id,
        task_id: created.record.id,
        event: { name: 'task', data: created.record },
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
    expect(manager.abandon(project.id, record.id)).toEqual({
      ok: false,
      code: 409,
      error: 'ship in progress',
    })
    release({ pushed: true, mrUrl: null, note: null })
    expect(await inFlight).toEqual({ ok: true })
    expect(loadTask(project.path, record.id)?.status).toBe('shipped')
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
    const statusBefore = loadTask(project.path, record.id)?.status
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      createRunnerFn: rig.createRunnerFn,
      reviewTurnFn: async () => {},
      runChecksFn: () => Promise.reject(new Error('engine exploded')),
    })
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
    const io = { emit: () => {}, persist: () => {}, text: () => {} }

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
          return { ok: false, code: 404, error: 'unknown project' }
        }
        calls.abandons.push(id)
        return { ok: true }
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
      checksSetup: (projectId) => {
        if (!known(projectId)) {
          return { ok: false, code: 404, error: 'unknown project' }
        }
        calls.checksSetups.push(projectId)
        return { ok: true }
      },
      checksSetupStatus: (projectId) => (known(projectId) ? { status: 'idle' } : null),
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
      expect(JSON.parse(abandoned.body)).toEqual({ ok: true })
      expect(calls.abandons).toEqual([record.id])
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

  test('maxParallel is GLOBAL: one slot serves two projects, FIFO across repos', async () => {
    const projectA = register(makeRepo())
    const projectB = register(makeRepo())
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
    // ONE global slot: project B's task queues even though its repo is idle.
    expect(loadTask(projectA.path, first.record.id)?.status).toBe('running')
    expect(loadTask(projectB.path, second.record.id)?.status).toBe('queued')

    release()
    // The slot freed in project A is handed to project B's queue.
    await until(
      () =>
        loadTask(projectA.path, first.record.id)?.status === 'review_ok' &&
        loadTask(projectB.path, second.record.id)?.status === 'review_ok',
    )
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
