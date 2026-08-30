import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentRunOptions } from './agent.js'
import { writeJsonAtomic } from './atomic-write.js'
import { loadGlobalConfig, saveGlobalConfig, saveRepoConfig, trustRepoAgent } from './config.js'
import {
  acceptanceCriterionId,
  isTerminalReason,
  TICKET_BODY_HASH_TAG,
  type CriterionVerdict,
  type Finding,
  type ReviewRecord,
  type RunbookConfig,
  type RunbookValidation,
  type TaskChecks,
  type TaskEvent,
  type TaskIssueRef,
  type TaskIssueSnapshot,
  type TaskRecord,
  type TaskStatus,
  type TaskVerification,
  type Verdict,
} from './contract.js'
import type { ForgeCli, ForgeCliOutcome, ForgeIssuesExecFn } from './forge-issues.js'
import { t as translate } from './i18n.js'
import { createLoadCap } from './load-cap.js'
import type { SandboxDriver, SandboxSweepOutcome } from './microsandbox-driver.js'
import type { ProjectSnapshot } from './microvm-snapshot.js'
import type { RunMicrovmTurnOptions } from './microvm-turn.js'
import { addProject, listProjects, projectsPath, scratchProject, type Project } from './projects.js'
import { archiveRecord } from './record.js'
import { readChecksConfig } from './repo-config.js'
import { runbookSha as computeRunbookSha } from './runbook-setup.js'
import { createSession, startServer } from './serve.js'
import type { MicrovmStepExecutorOptions, RunChecksOptions, StepExecutor } from './task-checks.js'
import {
  AUTO_FIX_EXHAUSTED_NAME,
  AUTO_FIX_JOURNAL_DAMAGED_NAME,
  AUTO_FIX_NOT_QUEUED_NAME,
  AUTO_FIX_NOT_STARTED_NAME,
  AUTO_FIX_ROUND_NAME,
  AUTO_FIX_SHIP_NAME,
  autoFixRoundsUsed,
  JUDGMENT_ONLY_MAX_ROUNDS,
} from './task-fix-loop.js'
import type { HomeVolumeSweepOutcome } from './task-isolation.js'
import type { TaskPlan } from './task-plan.js'
import {
  activeTask,
  claimActive,
  corruptQueuePath,
  QUEUE_ENTRIES_MAX,
  QUEUE_UNREADABLE,
  queuePath,
  readQueue,
  releaseActive,
  resetActiveClaims,
  resetQueueDegradedReports,
} from './task-queue.js'
import { RECAP_MARKER_PREFIX } from './task-recap-publish.js'
import { writeTaskRecap } from './task-recap.js'
import type { TaskRetentionOutcome } from './task-retention.js'
import { readTaskReview, type CreateTaskReviewerOptions } from './task-review.js'
import {
  pendingResumeTurn,
  type TaskActionResult,
  type TaskRunner,
  type TaskRunnerOptions,
  type TaskTurnIo,
} from './task-runner.js'
import {
  BOOT_ISSUE_RECONCILE_CONCURRENCY,
  createTaskManager,
  DEFAULT_BOOT_ISSUE_RECONCILE_DEADLINE_MS,
  QUEUE_BROADCAST_MAX,
  queueEntriesRetired,
  type TaskEnvelope,
  type TaskManager,
} from './task-server.js'
import type { ShipOutcome, ShipTaskOptions } from './task-ship.js'
import {
  readTaskVerification,
  writeTaskVerification,
  type VerifyTaskOptions,
} from './task-verification.js'
import {
  appendTaskEvent,
  createTask,
  listTasks,
  loadTask,
  readTaskChecks,
  readTaskEvents,
  resetStoreReports,
  saveTask,
  setJournalReader,
  STORE_UNLISTABLE,
  taskDir,
  taskReason,
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
  attaches: { id: string; repo: { project_id: string; path: string } }[]
}

/**
 * Captures the manager→runner seam without ever launching an agent.
 *
 * `replyResult` (T3.3) is what `reply()` answers. The default stays the 409 it
 * has always been — a manager test that only wants to SEE the call must not
 * have to think about it — and a caller that drives the automatic fix loop
 * passes `{ ok: true }`, which is what the real runner answers on a task its
 * review just settled.
 */
function fakeRunner(opts: { replyResult?: TaskActionResult } = {}): FakeRunnerRig {
  const replyResult: TaskActionResult = opts.replyResult ?? {
    ok: false,
    code: 409,
    error: 'task is not waiting for a reply',
  }
  const rig: FakeRunnerRig = {
    allRunnerOptions: [],
    starts: [],
    replies: [],
    interrupts: [],
    abandons: [],
    resumes: [],
    abandoning: new Set<string>(),
    attaches: [] as { id: string; repo: { project_id: string; path: string } }[],
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
          return replyResult
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
        attach: (id, repo) => {
          rig.attaches.push({ id, repo })
          return Promise.resolve({ ok: true as const })
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
    expect(await manager.create('deadbeef', input)).toEqual({
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

  test('isolation: an available cage makes new tasks caged, and says so in the journal', async () => {
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
    const created = await manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
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

  test("isolation 'auto' without a cage falls back to policy WITH the reason journaled", async () => {
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
    const created = await manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    expect(created.ok).toBe(true)
    const id = created.ok ? created.record.id : ''
    expect(loadTask(project.path, id)?.isolation).toBe('policy')
    const isolation = readTaskEvents(project.path, id).find((event) => event.type === 'isolation')
    expect(isolation?.data.isolation).toBe('policy')
    expect(String(isolation?.data.reason)).toContain('no container runtime found')
  })

  test("isolation 'container' with no cage refuses the creation (409), leaving nothing behind", async () => {
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
    const created = await manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    expect(created).toMatchObject({ ok: false, code: 409 })
    expect(created.ok ? '' : created.error).toContain('does not answer')
    expect(listTasks(project.path)).toHaveLength(0)
    expect(rig.starts).toHaveLength(0)
  })

  test('the cage-unavailable 409 names itself resource_busy, message untouched', async () => {
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
    const created = await manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    // The code is ADDED beside the readable error, which is unchanged.
    expect(created).toMatchObject({
      ok: false,
      code: 409,
      reason_code: 'resource_busy',
      error: expect.stringContaining('does not answer'),
    })
  })

  test('a refusal the vocabulary has no word for carries no code at all', async () => {
    const project = register(makeRepo())
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
    const refused = await manager.create(project.id, {
      title: 't',
      prompt: 'p',
      autoShip: false,
      base: 'nope',
      branch: 'also-nope',
    })
    expect(refused).toMatchObject({ ok: false, code: 400 })
    expect(refused.ok ? true : 'reason_code' in refused).toBe(false)
  })

  test('an unprobed manager creates policy tasks: nothing pretends to be caged', async () => {
    const project = register(makeRepo())
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
    const created = await manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
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
      agent: 'claude -p',
    })
  })

  test('the egress allowlist and the repo checks config reach the runner', async () => {
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
      flags: { isolationAllowedDomains: ['api.anthropic.com', 'registry.npmjs.org'] },
    })
    await manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    const options = rig.runnerOptions()
    expect(options.allowedDomains).toEqual(['api.anthropic.com', 'registry.npmjs.org'])
    expect(options.getChecksConfig?.()?.image).toBe('oven/bun:1')
  })

  test('checks-apply is picked up on the next turn without rebuilding the runner (T1.4)', async () => {
    const project = register(makeRepo())
    mkdirSync(join(project.path, '.codesema'), { recursive: true })
    writeFileSync(
      join(project.path, '.codesema', 'config.json'),
      JSON.stringify({ checks: { image: 'oven/bun:1' } }),
    )
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })
    await manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    const getter = rig.runnerOptions().getChecksConfig
    expect(getter?.()?.image).toBe('oven/bun:1')
    writeFileSync(
      join(project.path, '.codesema', 'config.json'),
      JSON.stringify({ checks: { image: 'node:26' } }),
    )
    expect(getter?.()?.image).toBe('node:26')
    expect(rig.allRunnerOptions).toHaveLength(1)
  })

  test('two projects keep their own isolation, timeout and agent (T1.4)', async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    saveRepoConfig(repoA, {
      isolation: 'container',
      timeout: 30,
      agent: 'claude -p --model opus',
    })
    saveRepoConfig(repoB, { isolation: 'policy', timeout: 120 })
    trustRepoAgent(repoA, 'claude -p --model opus')
    const projectA = register(repoA)
    const projectB = register(repoB)
    const rig = fakeRunner()
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      timeoutMs: 900_000,
      command: 'claude -p',
      onNotice: (message) => notices.push(message),
      isolation: {
        available: true,
        mode: 'container',
        reason: 'podman is available',
        configured: 'auto',
        runtime: 'podman',
      },
    })
    const createdA = await manager.create(projectA.id, {
      title: 'a',
      prompt: 'p',
      autoShip: false,
    })
    const createdB = await manager.create(projectB.id, {
      title: 'b',
      prompt: 'p',
      autoShip: false,
    })
    expect(createdA.ok && createdA.record.isolation).toBe('container')
    expect(createdB.ok && createdB.record.isolation).toBe('policy')
    const optsByCwd = new Map(rig.allRunnerOptions.map((options) => [options.cwd, options]))
    expect(optsByCwd.get(repoA)?.timeoutMs).toBe(30_000)
    expect(optsByCwd.get(repoB)?.timeoutMs).toBe(120_000)
    expect(optsByCwd.get(repoA)?.command).toBe('claude -p --model opus')
    expect(optsByCwd.get(repoB)?.command).toBe('claude -p')
    expect(manager.workspaceInfo(projectA.id)).toMatchObject({
      isolation_configured: 'container',
      isolation_available: true,
      agent: 'claude -p --model opus',
    })
    expect(manager.workspaceInfo(projectB.id)).toMatchObject({
      isolation_configured: 'policy',
      isolation_available: false,
      agent: 'claude -p',
    })
  })

  // T1.4 review round 6, MAJEUR A1. The egress allowlist is the ONLY of the
  // four per-project settings that was still read off the launch repo at boot
  // and handed over as THE fallback, so a sibling that declared none ran its
  // CAGED agent against A's widened allowlist — an inter-repo widening of
  // trust on the isolation surface (invariant 3). Both halves were unproven:
  // this pins the per-project read, workspace-lifecycle pins the boot line.
  test("the egress allowlist is per project: a sibling never inherits the launch repo's (T1.4 A1)", async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    saveRepoConfig(repoA, { isolationAllowedDomains: ['npm.acme-internal.example'] })
    const projectA = register(repoA)
    const projectB = register(repoB)
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      allowedDomains: ['api.anthropic.com'],
    })
    await manager.create(projectA.id, { title: 'a', prompt: 'p', autoShip: false })
    await manager.create(projectB.id, { title: 'b', prompt: 'p', autoShip: false })
    const optsByCwd = new Map(rig.allRunnerOptions.map((options) => [options.cwd, options]))
    expect(optsByCwd.get(repoA)?.allowedDomains).toEqual(['npm.acme-internal.example'])
    // The cross-assertion is what kills the leak: B keeps the claude default,
    // never A's widened list, never a launch-agent allowlist.
    expect(optsByCwd.get(repoB)?.allowedDomains).toEqual([
      'api.anthropic.com',
      'platform.claude.com',
    ])
  })

  test('a sibling opencode project without an allowlist gets opencode domains, not Anthropic', async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    saveRepoConfig(repoB, { agent: 'opencode run' })
    trustRepoAgent(repoB, 'opencode run')
    const projectA = register(repoA)
    const projectB = register(repoB)
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      command: 'claude -p',
      isolation: {
        available: true,
        mode: 'container',
        reason: 'podman is available',
        configured: 'auto',
        runtime: 'podman',
      },
    })
    await manager.create(projectA.id, { title: 'a', prompt: 'p', autoShip: false })
    await manager.create(projectB.id, { title: 'b', prompt: 'p', autoShip: false })
    const optsByCwd = new Map(rig.allRunnerOptions.map((options) => [options.cwd, options]))
    expect(optsByCwd.get(repoA)?.allowedDomains).toEqual([
      'api.anthropic.com',
      'platform.claude.com',
    ])
    expect(optsByCwd.get(repoB)?.allowedDomains).toEqual(['opencode.ai', 'models.opencode.ai'])
  })

  // C5 (adversarial review, mineur): the README promises the three `watchdog*`
  // keys are "Resolved per project" too, and `projectRuntime` does resolve
  // them — but nothing turned red when it stopped. A project's budgets decide
  // when its agent is declared dead; inheriting A's 60 s silence budget kills
  // B's legitimately quiet tool call.
  test('the three watchdog budgets are per project, and a sibling keeps the boot ones (T1.4)', async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    saveRepoConfig(repoA, {
      watchdogInactivitySeconds: 60,
      watchdogToolBudgetSeconds: 120,
      watchdogHeartbeatSeconds: 5,
    })
    const projectA = register(repoA)
    const projectB = register(repoB)
    const rig = fakeRunner()
    const bootBudgets = { inactivityMs: 1_800_000, toolBudgetMs: 7_200_000, heartbeatMs: 30_000 }
    const manager = createTaskManager({ ...managerOpts, ...rig, watchdog: bootBudgets })
    await manager.create(projectA.id, { title: 'a', prompt: 'p', autoShip: false })
    await manager.create(projectB.id, { title: 'b', prompt: 'p', autoShip: false })
    const optsByCwd = new Map(rig.allRunnerOptions.map((options) => [options.cwd, options]))
    expect(optsByCwd.get(repoA)?.watchdog).toEqual({
      inactivityMs: 60_000,
      toolBudgetMs: 120_000,
      heartbeatMs: 5_000,
    })
    expect(optsByCwd.get(repoB)?.watchdog).toEqual(bootBudgets)
  })

  // C6 (adversarial review, mineur): the end-of-turn reviewer is a second
  // agent run, on the same branch, and it is built from the SAME per-project
  // resolution as the runner. Nothing pinned that: a reviewer left on the
  // launch repo's command would run B's review with A's TOFU-approved agent,
  // and with A's ceiling.
  test("the end-of-turn reviewer of a project uses THAT project's command and ceiling (T1.4)", () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    saveRepoConfig(repoA, { agent: 'claude -p --model opus', timeout: 30 })
    trustRepoAgent(repoA, 'claude -p --model opus')
    const projectA = register(repoA)
    const projectB = register(repoB)
    const seen: CreateTaskReviewerOptions[] = []
    const manager = createTaskManager({
      ...managerOpts,
      createRunnerFn: fakeRunner().createRunnerFn,
      createReviewerFn: (options) => {
        seen.push(options)
        return async () => {}
      },
    })
    // Forces the lazy per-project assembly for both projects.
    manager.checks(projectA.id, 'aaaaaaaaaaaa')
    manager.checks(projectB.id, 'aaaaaaaaaaaa')
    const byCwd = new Map(seen.map((options) => [options.cwd, options]))
    expect(byCwd.get(repoA)?.command).toBe('claude -p --model opus')
    expect(byCwd.get(repoA)?.timeoutMs).toBe(30_000)
    expect(byCwd.get(repoB)?.command).toBe(managerOpts.command)
    expect(byCwd.get(repoB)?.timeoutMs).toBe(managerOpts.timeoutMs)
  })

  // T3.2: `mode` used to be omitted at this call site, so `createTaskReviewer`
  // fell through to its own implicit 'simple' — a project that had asked for
  // 'dual' got a simple review and nothing said so. Deleting `mode` from the
  // manager's `createTaskReviewer({…})` call is what this turns red.
  test('the reviewer is built with the review mode THAT project resolved (T3.2)', () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    saveRepoConfig(repoA, { reviewMode: 'dual' })
    const projectA = register(repoA)
    const projectB = register(repoB)
    const seen: CreateTaskReviewerOptions[] = []
    const manager = createTaskManager({
      ...managerOpts,
      createRunnerFn: fakeRunner().createRunnerFn,
      createReviewerFn: (options) => {
        seen.push(options)
        return async () => {}
      },
    })
    manager.checks(projectA.id, 'aaaaaaaaaaaa')
    manager.checks(projectB.id, 'aaaaaaaaaaaa')
    const byCwd = new Map(seen.map((options) => [options.cwd, options]))
    expect(byCwd.get(repoA)?.mode).toBe('dual')
    // Explicit, not absent: a project that declares nothing still gets the
    // value named at the call site.
    expect(byCwd.get(repoB)?.mode).toBe('simple')
  })

  // J2 (adversarial review, mineur): proposing a checks configuration is a
  // third agent run, and its `resolveCommand` seam was branched in production
  // with nothing red in either direction — a proposal for B would have been
  // computed by the launch repo's agent.
  test("a checks proposal for a project runs THAT project's agent (T1.4)", async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    saveRepoConfig(repoB, { agent: 'claude -p --model haiku' })
    trustRepoAgent(repoB, 'claude -p --model haiku')
    register(repoA)
    const projectB = register(repoB)
    const runs: AgentRunOptions[] = []
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      command: 'claude -p',
      runSetupAgentFn: (options) => {
        runs.push(options)
        return Promise.resolve('{}')
      },
    })
    expect(manager.checksSetup(projectB.id)).toEqual({ ok: true })
    await until(() => runs.length === 1)
    expect(runs[0]?.command).toContain('claude -p --model haiku')
    expect(runs[0]?.command).not.toBe(managerOpts.command)
  })

  // P5 (adversarial review, mineur): the TOFU warning of a SIBLING was only
  // ever proven by its negative — three tests assert the notice is ABSENT, and
  // all three stay green when the notice is deleted outright. Invariant 2 is
  // about the positive case: an agent command a repo declared and nobody
  // approved is dropped, and the human is told which one and why.
  test("a sibling's unapproved repo agent is NAMED, not silently dropped (T1.4)", async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    saveRepoConfig(repoB, { agent: 'claude -p --model opus' })
    const projectB = register(repoB)
    const rig = fakeRunner()
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      command: 'claude -p',
      // The boot already said its piece about the LAUNCH repo; B is not it.
      launchRepoPath: repoA,
      onNotice: (message) => notices.push(message),
    })
    await manager.create(projectB.id, { title: 'b', prompt: 'p', autoShip: false })
    expect(rig.runnerOptions().command).toBe('claude -p')
    const named = notices.filter((line) => line.includes('claude -p --model opus'))
    expect(named).toHaveLength(1)
    expect(named[0]).toMatch(/not approved/)
  })

  test("a sibling without agent inherits the global command, not the launch repo's (T1.4)", async () => {
    saveGlobalConfig({ agent: 'codex exec -' })
    const repoA = makeRepo()
    const repoB = makeRepo()
    saveRepoConfig(repoA, { agent: 'claude -p --model opus' })
    trustRepoAgent(repoA, 'claude -p --model opus')
    const projectA = register(repoA)
    const projectB = register(repoB)
    const rig = fakeRunner()
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      command: 'codex exec -',
      onNotice: (message) => notices.push(message),
    })
    await manager.create(projectA.id, { title: 'a', prompt: 'p', autoShip: false })
    await manager.create(projectB.id, { title: 'b', prompt: 'p', autoShip: false })
    const optsByCwd = new Map(rig.allRunnerOptions.map((options) => [options.cwd, options]))
    expect(optsByCwd.get(repoA)?.command).toBe('claude -p --model opus')
    expect(optsByCwd.get(repoB)?.command).toBe('codex exec -')
    expect(notices.some((line) => line.includes('not approved'))).toBe(false)
  })

  test('a global agent is not TOFU-warned as repo-provided (T1.4)', async () => {
    saveGlobalConfig({ agent: 'codex exec -' })
    const project = register(makeRepo())
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      command: 'codex exec -',
      onNotice: (message) => notices.push(message),
    })
    await manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    expect(notices.some((line) => line.includes('not approved'))).toBe(false)
  })

  test('--agent bypasses TOFU for an untrusted repo command (T1.4)', async () => {
    const repo = makeRepo()
    saveRepoConfig(repo, { agent: 'claude -p --model opus' })
    const project = register(repo)
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      command: 'claude -p',
      flags: { agent: 'codex exec -' },
    })
    await manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    expect(rig.runnerOptions().command).toBe('codex exec -')
  })

  test('a per-task opencode agent is refused under policy, even when the project default could cage', async () => {
    const repo = makeRepo()
    saveRepoConfig(repo, { isolation: 'policy' })
    const project = register(repo)
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      command: 'claude -p',
      isolation: {
        available: true,
        mode: 'container',
        reason: 'podman is available',
        configured: 'auto',
        runtime: 'podman',
      },
    })
    const created = await manager.create(project.id, {
      title: 't',
      prompt: 'p',
      autoShip: false,
      agent: 'opencode',
    })
    expect(created).toMatchObject({ ok: false, code: 400 })
    expect(created.ok ? true : 'reason_code' in created).toBe(false)
    expect(created.ok ? '' : created.error).toMatch(/opencode\.json|MCP/)
    expect(listTasks(project.path)).toHaveLength(0)
  })

  test('a per-task agent is stored as the resolved command and cages against it', async () => {
    const repo = makeRepo()
    const project = register(repo)
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      command: 'claude -p',
      isolation: {
        available: true,
        mode: 'container',
        reason: 'podman is available',
        configured: 'auto',
        runtime: 'podman',
      },
    })
    const created = await manager.create(project.id, {
      title: 't',
      prompt: 'p',
      autoShip: false,
      agent: 'opencode run',
    })
    expect(created.ok && created.record.agent).toBe('opencode run')
    expect(created.ok && created.record.isolation).toBe('container')
  })

  test('setDefaultCommand is the fallback stored on unspecified new tasks', async () => {
    const project = register(makeRepo())
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner(), command: 'claude -p' })
    expect(manager.defaultCommand()).toBe('claude -p')
    manager.setDefaultCommand('claude -p --model opus')
    expect(manager.defaultCommand()).toBe('claude -p --model opus')
    const created = await manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    expect(created.ok && created.record.agent).toBe('claude -p --model opus')
  })

  test('an unknown per-task agent is a 400 and writes nothing', async () => {
    const project = register(makeRepo())
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
    const created = await manager.create(project.id, {
      title: 't',
      prompt: 'p',
      autoShip: false,
      agent: 'my-agent run',
    })
    expect(created).toMatchObject({ ok: false, code: 400 })
    expect(listTasks(project.path)).toHaveLength(0)
  })

  test('policy + opencode is refused at create, never a host policy task', async () => {
    const repo = makeRepo()
    saveRepoConfig(repo, { isolation: 'policy', agent: 'opencode run' })
    trustRepoAgent(repo, 'opencode run')
    const project = register(repo)
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      command: 'opencode run',
      isolation: {
        available: true,
        mode: 'container',
        reason: 'podman is available',
        configured: 'auto',
        runtime: 'podman',
      },
    })
    const created = await manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    expect(created).toMatchObject({ ok: false, code: 400 })
    expect(created.ok ? true : 'reason_code' in created).toBe(false)
    expect(created.ok ? '' : created.error).toMatch(/opencode\.json|MCP/)
    expect(listTasks(project.path)).toHaveLength(0)
  })

  test('container isolation with opencode and no runtime is 409, same as claude', async () => {
    const repo = makeRepo()
    saveRepoConfig(repo, { isolation: 'container' })
    const project = register(repo)
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      command: 'opencode run',
      isolation: {
        available: false,
        mode: 'policy',
        reason: 'docker is installed but its engine does not answer',
        configured: 'container',
        runtime: 'docker',
      },
    })
    const created = await manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    expect(created).toMatchObject({
      ok: false,
      code: 409,
      reason_code: 'resource_busy',
      error: expect.stringContaining('does not answer'),
    })
  })

  test('container isolation with a non-claude agent is a 400, not a retryable 409 (T1.4)', async () => {
    const repo = makeRepo()
    saveRepoConfig(repo, { isolation: 'container' })
    const project = register(repo)
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      command: 'codex exec -',
      isolation: {
        available: true,
        mode: 'container',
        reason: 'podman is available',
        configured: 'auto',
        runtime: 'podman',
      },
    })
    const created = await manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    expect(created).toMatchObject({ ok: false, code: 400 })
    expect(created.ok ? '' : created.error).toContain('codex')
    expect(created.ok ? true : 'reason_code' in created).toBe(false)
  })

  test('workspaceInfo overlays a global policy onto a live runtime probe (T1.4)', () => {
    saveGlobalConfig({ isolation: 'policy' })
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      isolation: {
        available: true,
        mode: 'container',
        reason: 'podman is available',
        configured: 'auto',
        runtime: 'podman',
      },
    })
    expect(manager.workspaceInfo()).toMatchObject({
      isolation_available: false,
      isolation_default: 'policy',
      isolation_configured: 'policy',
    })
  })

  // Unspecified tasks follow a FRESH projectRuntime snapshot (the session
  // default, or the repo's own agent), not the runner's frozen boot command.
  // The chosen CLI is stored on the record so later turns keep it.
  test('unspecified create isolation follows the live project agent, not the frozen runner', async () => {
    const repo = makeRepo()
    saveRepoConfig(repo, { isolation: 'policy', agent: 'codex exec -' })
    trustRepoAgent(repo, 'codex exec -')
    const project = register(repo)
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      command: 'claude -p',
      isolation: {
        available: true,
        mode: 'container',
        reason: 'podman is available',
        configured: 'auto',
        runtime: 'podman',
      },
    })
    const first = await manager.create(project.id, { title: 'a', prompt: 'p', autoShip: false })
    expect(first.ok && first.record.isolation).toBe('policy')
    expect(first.ok && first.record.agent).toBe('codex exec -')
    saveRepoConfig(repo, { isolation: 'container', agent: 'claude -p' })
    trustRepoAgent(repo, 'claude -p')
    expect(manager.workspaceInfo(project.id)).toMatchObject({
      isolation_configured: 'container',
      isolation_available: true,
    })
    const second = await manager.create(project.id, { title: 'b', prompt: 'p', autoShip: false })
    expect(second.ok && second.record.isolation).toBe('container')
    expect(second.ok && second.record.agent).toBe('claude -p')
    expect(rig.allRunnerOptions).toHaveLength(1)
    expect(rig.runnerOptions().command).toBe('codex exec -')
  })

  test('a non-cageable project agent is a 400, even when the session default could cage (T1.4)', async () => {
    const repo = makeRepo()
    saveRepoConfig(repo, { isolation: 'container', agent: 'codex exec -' })
    trustRepoAgent(repo, 'codex exec -')
    const project = register(repo)
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      // Deliberately CAGEABLE, and deliberately different from the repo's:
      // the refusal below must follow the live project agent, not this one.
      command: 'claude -p',
      isolation: {
        available: true,
        mode: 'container',
        reason: 'podman is available',
        configured: 'auto',
        runtime: 'podman',
      },
    })
    const created = await manager.create(project.id, { title: 'a', prompt: 'p', autoShip: false })
    expect(created).toMatchObject({ ok: false, code: 400 })
    expect(created.ok).toBe(false)
    if (!created.ok) {
      expect(created.error).toContain('codex exec -')
      expect(created.error).not.toContain('Restart the workspace')
    }
  })

  // G4 (adversarial review, mineur). "Restart the workspace to pick up X" is
  // only true when X could actually be caged. A disk edit from one non-claude
  // agent to ANOTHER non-claude agent would 400 again after the reboot, so
  // the hint must not fire — the decision stays right, and the ANNOUNCEMENT
  // must not promise a trip that leads nowhere (§6 bis).
  test('an edit from one non-claude agent to another promises no useful restart (T1.4)', async () => {
    const repo = makeRepo()
    saveRepoConfig(repo, { isolation: 'container', agent: 'codex exec -' })
    trustRepoAgent(repo, 'codex exec -')
    const project = register(repo)
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      command: 'claude -p',
      isolation: {
        available: true,
        mode: 'container',
        reason: 'podman is available',
        configured: 'auto',
        runtime: 'podman',
      },
    })
    expect(
      await manager.create(project.id, { title: 'a', prompt: 'p', autoShip: false }),
    ).toMatchObject({
      ok: false,
      code: 400,
    })
    // The file now names a DIFFERENT agent — and it still cannot be caged.
    saveRepoConfig(repo, { isolation: 'container', agent: 'gemini -p' })
    trustRepoAgent(repo, 'gemini -p')
    const second = await manager.create(project.id, { title: 'b', prompt: 'p', autoShip: false })
    expect(second).toMatchObject({ ok: false, code: 400 })
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.error).toContain('gemini')
      expect(second.error).not.toContain('Restart the workspace')
      expect(second.error).not.toContain('codex exec -')
    }
  })

  test('isolation-mode edits still apply when the frozen command can be caged (T1.4 A)', async () => {
    const repo = makeRepo()
    saveRepoConfig(repo, { isolation: 'policy' })
    const project = register(repo)
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
    const first = await manager.create(project.id, { title: 'a', prompt: 'p', autoShip: false })
    expect(first.ok && first.record.isolation).toBe('policy')
    saveRepoConfig(repo, { isolation: 'container' })
    const second = await manager.create(project.id, { title: 'b', prompt: 'p', autoShip: false })
    expect(second.ok && second.record.isolation).toBe('container')
    expect(rig.allRunnerOptions).toHaveLength(1)
    expect(rig.runnerOptions().command).toBe('claude -p')
  })

  test('a launch-repo TOFU warning is not repeated at context() (T1.4 C)', async () => {
    const repo = makeRepo()
    saveRepoConfig(repo, { agent: 'claude -p --model opus' })
    const project = register(repo)
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      onNotice: (message) => notices.push(message),
      launchRepoPath: repo,
    })
    await manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    expect(notices.some((line) => line.includes('not approved'))).toBe(false)
  })

  test('a sibling custom agent is named at context construction (T1.4 D)', async () => {
    const repo = makeRepo()
    saveRepoConfig(repo, { agent: 'mytool run' })
    trustRepoAgent(repo, 'mytool run')
    const project = register(repo)
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      command: 'claude -p',
      onNotice: (message) => notices.push(message),
    })
    await manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    expect(notices.some((line) => line.includes('mytool run'))).toBe(true)
  })

  test('a repo load-cap warning is not repeated on the second context of the same path (T1.4)', async () => {
    const repo = makeRepo()
    saveRepoConfig(repo, { maxConcurrentAgents: 1 })
    const project = register(repo)
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      onNotice: (message) => notices.push(message),
      globalOnlyNoticeShown: [repo],
    })
    await manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    expect(notices.some((line) => line.includes('maxConcurrentAgents'))).toBe(false)
  })

  test('an existing record keeps its isolation after the project config changes (T1.4)', () => {
    const repo = makeRepo()
    const project = register(repo)
    const seeded = seedTask(repo)
    seeded.isolation = 'policy'
    saveTask(repo, seeded)
    saveRepoConfig(repo, { isolation: 'container' })
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      isolation: {
        available: true,
        mode: 'container',
        reason: 'podman is available',
        configured: 'auto',
        runtime: 'podman',
      },
    })
    expect(manager.list(project.id)?.find((record) => record.id === seeded.id)?.isolation).toBe(
      'policy',
    )
    const reloaded = loadTask(repo, seeded.id)
    expect(reloaded?.isolation).toBe('policy')
    if (reloaded) {
      saveTask(repo, reloaded)
    }
    expect(loadTask(repo, seeded.id)?.isolation).toBe('policy')
  })

  test('a repo maxConcurrentAgents is named and does not size the project (T1.4)', async () => {
    const repo = makeRepo()
    saveRepoConfig(repo, { maxConcurrentAgents: 1 })
    const project = register(repo)
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      onNotice: (message) => notices.push(message),
    })
    await manager.create(project.id, { title: 't', prompt: 'p', autoShip: false })
    expect(notices.some((line) => line.includes('maxConcurrentAgents'))).toBe(true)
  })

  test('a CLI isolation flag wins over both projects (T1.4)', async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    saveRepoConfig(repoA, { isolation: 'policy' })
    saveRepoConfig(repoB, { isolation: 'container' })
    const projectA = register(repoA)
    const projectB = register(repoB)
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      flags: { isolation: 'policy' },
      isolation: {
        available: true,
        mode: 'container',
        reason: 'podman is available',
        configured: 'auto',
        runtime: 'podman',
      },
    })
    const createdA = await manager.create(projectA.id, {
      title: 'a',
      prompt: 'p',
      autoShip: false,
    })
    const createdB = await manager.create(projectB.id, {
      title: 'b',
      prompt: 'p',
      autoShip: false,
    })
    expect(createdA.ok && createdA.record.isolation).toBe('policy')
    expect(createdB.ok && createdB.record.isolation).toBe('policy')
  })

  test('create validates title and prompt before touching the store', async () => {
    const project = register(makeRepo())
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })

    const base = { prompt: 'do it', autoShip: false }
    expect(await manager.create(project.id, { ...base, title: '   ' })).toMatchObject({
      ok: false,
      code: 400,
    })
    expect(await manager.create(project.id, { ...base, title: 'x'.repeat(201) })).toMatchObject({
      ok: false,
      code: 400,
    })
    expect(
      await manager.create(project.id, { title: 't', prompt: '', autoShip: false }),
    ).toMatchObject({
      ok: false,
      code: 400,
    })
    expect(
      await manager.create(project.id, { title: 't', prompt: 'p'.repeat(20_001), autoShip: false }),
    ).toMatchObject({ ok: false, code: 400 })
    expect(manager.list(project.id)).toHaveLength(0)
    expect(rig.starts).toHaveLength(0)
  })

  test('create validates an explicit base: unknown, option-lookalike and oversized are 400', async () => {
    const repo = makeRepo()
    execFileSync('git', ['branch', 'feature'], { cwd: repo, stdio: 'ignore' })
    const project = register(repo)
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })

    const input = { title: 't', prompt: 'p', autoShip: false }
    expect(await manager.create(project.id, { ...input, base: 'nope' })).toMatchObject({
      ok: false,
      code: 400,
      error: expect.stringContaining('nope'),
    })
    expect(await manager.create(project.id, { ...input, base: '-evil' })).toMatchObject({
      ok: false,
      code: 400,
    })
    expect(await manager.create(project.id, { ...input, base: 'b'.repeat(201) })).toMatchObject({
      ok: false,
      code: 400,
    })
    // Nothing was persisted or handed to the runner by the refusals.
    expect(manager.list(project.id)).toHaveLength(0)
    expect(rig.starts).toHaveLength(0)

    // Valid base (trimmed): recorded on the task, branch/worktree still lazy.
    const created = await manager.create(project.id, { ...input, base: '  feature  ' })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }
    expect(created.record.base).toBe('feature')
    expect(created.record.branch).toBe('')
    expect(loadTask(repo, created.record.id)?.base).toBe('feature')
    expect(rig.starts.map((r) => r.id)).toEqual([created.record.id])

    // A blank base means absent: auto-detection at launch, base stays empty.
    const blank = await manager.create(project.id, { ...input, base: '   ' })
    expect(blank.ok).toBe(true)
    if (blank.ok) {
      expect(blank.record.base).toBe('')
    }
  })

  test('create work-on: branch/base exclusivity and branch validation are 400, nothing persisted', async () => {
    const repo = makeRepo()
    execFileSync('git', ['branch', 'feature'], { cwd: repo, stdio: 'ignore' })
    const project = register(repo)
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })

    const input = { title: 't', prompt: 'p', autoShip: false }
    expect(
      await manager.create(project.id, { ...input, branch: 'feature', base: 'main' }),
    ).toMatchObject({ ok: false, code: 400, error: expect.stringContaining('exclusive') })
    expect(await manager.create(project.id, { ...input, branch: 'ghost' })).toMatchObject({
      ok: false,
      code: 400,
      error: expect.stringContaining('ghost'),
    })
    expect(await manager.create(project.id, { ...input, branch: '-evil' })).toMatchObject({
      ok: false,
      code: 400,
    })
    expect(await manager.create(project.id, { ...input, branch: 'b'.repeat(201) })).toMatchObject({
      ok: false,
      code: 400,
    })
    expect(manager.list(project.id)).toHaveLength(0)
    expect(rig.starts).toHaveLength(0)
  })

  test('create work-on: records the branch verbatim, work_on, and the MR target as base', async () => {
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
    const plain = await manager.create(project.id, { ...input, branch: '  feature  ' })
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
    const targeted = await manager.create(project.id, {
      ...input,
      branch: 'feature-two',
      target: 'release',
    })
    expect(targeted.ok).toBe(true)
    if (targeted.ok) {
      expect(targeted.record.base).toBe('release')
    }

    // An unresolvable target falls back to auto-detection — never a 400.
    const bogus = await manager.create(project.id, {
      ...input,
      branch: 'feature-three',
      target: 'nope',
    })
    expect(bogus.ok).toBe(true)
    if (bogus.ok) {
      expect(bogus.record.base).toBe('main')
    }
  })

  test('create work-on: ONE active conversation per branch — 409 with existing_task_id; terminal tasks never block', async () => {
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
    const refused = await manager.create(project.id, { ...input, branch: 'feature' })
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
    const allowed = await manager.create(project.id, { ...input, branch: 'feature' })
    expect(allowed.ok).toBe(true)
  })

  test('create work-on: a branch checked out in ANY worktree (main included) is a 409, nothing persisted', async () => {
    const repo = makeRepo()
    const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    run(['branch', 'feature'])
    run(['worktree', 'add', join(repo, '.codesema', 'elsewhere'), 'feature'])
    const project = register(repo)
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })
    const input = { title: 't', prompt: 'p', autoShip: false }

    // 'main' is held by the MAIN worktree.
    expect(await manager.create(project.id, { ...input, branch: 'main' })).toMatchObject({
      ok: false,
      code: 409,
      error: expect.stringContaining('checked out'),
    })
    // 'feature' is held by a secondary worktree.
    expect(await manager.create(project.id, { ...input, branch: 'feature' })).toMatchObject({
      ok: false,
      code: 409,
      error: expect.stringContaining('checked out'),
    })
    expect(manager.list(project.id)).toHaveLength(0)
    expect(rig.starts).toHaveLength(0)
  })

  test('create persists a queued task in ITS project repo, broadcasts, hands to the runner', async () => {
    const projectA = register(makeRepo())
    const projectB = register(makeRepo())
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })
    const envelopes: TaskEnvelope[] = []
    manager.subscribe((envelope) => envelopes.push(envelope))

    const created = await manager.create(projectB.id, {
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
    // The scratch project leads every workspace listing, task-less here: the
    // SSE replay has to carry it too, or a conversation held there would be
    // invisible until the client refetched.
    expect(all.map((entry) => entry.project.id)).toEqual([
      scratchProject().id,
      projectA.id,
      projectB.id,
    ])
    expect(all[0]?.records).toEqual([])
    expect(all[1]?.records.map((r) => r.id)).toEqual([a.id])
    expect(new Set(all[2]?.records.map((r) => r.id))).toEqual(new Set([b1.id, b2.id]))
  })
})

// --- manager.create — from a forge issue (T2.4) ----------------------------

/** A repo with an `origin` remote: `getIssue` refuses to probe without one. */
function makeRepoWithRemote(remote = 'https://github.com/acme/repo.git'): string {
  const repo = makeRepo()
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repo, stdio: 'ignore' })
  return repo
}

type ForgeCall = { cli: ForgeCli; args: string[]; cwd: string }

/** The only way a forge binary is ever "run" in this file: the argv IS the assertion. */
function forgeRig(reply: (call: ForgeCall) => ForgeCliOutcome) {
  const calls: ForgeCall[] = []
  const execFn: ForgeIssuesExecFn = (cli, args, cwd) => {
    const call = { cli, args, cwd }
    calls.push(call)
    return Promise.resolve(reply(call))
  }
  return { calls, execFn }
}

/** A gh `issue view --json <fields>` payload, as `parseGhIssue` reads it. */
function ghIssuePayload(body: string, title = 'Fix flaky worktree cleanup'): string {
  return JSON.stringify({
    number: 42,
    title,
    body,
    state: 'OPEN',
    labels: [],
    author: { id: 'u1', is_bot: false, login: 'octocat', name: 'The Octocat' },
    createdAt: '2026-07-20T09:00:00Z',
    updatedAt: '2026-07-28T10:00:00Z',
    url: 'https://github.com/acme/repo/issues/42',
  })
}

/** A gh candidate answering `issue view` with `body`/`title`, `missing` for anything else. */
function ghIssueRig(body: string, title?: string) {
  return forgeRig((call) => {
    if (call.cli === 'gh' && call.args[0] === 'issue' && call.args[1] === 'view') {
      return { kind: 'ok', stdout: ghIssuePayload(body, title) }
    }
    return { kind: 'missing' }
  })
}

const ISSUE_CRITERIA = [
  'WHEN a ticket is launched THE SYSTEM SHALL lint its body',
  'WHEN a section is missing THE SYSTEM SHALL name that section',
  'WHEN the body is conforming THE SYSTEM SHALL accept it',
]

/** A conforming ticket body (five sections, three EARS criteria). */
function conformingTicketBody(): string {
  return [
    '**Context**\n\nTickets are launched from the workspace.',
    '**Goal**\n\nFreeze the ticket format once.',
    '**Scope**\n\npackages/contract/src/ticket.ts',
    `**Acceptance criteria**\n\n${ISSUE_CRITERIA.map((c) => `- ${c}`).join('\n')}`,
    '**Out of scope**\n\nPosting the issue on the forge.',
  ].join('\n\n')
}

const VALID_ISSUE_REF: TaskIssueRef = {
  forge: 'github',
  project: 'acme/repo',
  iid: 42,
  url: 'https://github.com/acme/repo/issues/42',
}

describe('manager.create — from a forge issue (T2.4)', () => {
  test('a conforming issue is admitted: title from the issue, criteria frozen in issue_snapshot', async () => {
    const project = register(makeRepoWithRemote())
    const rig = fakeRunner()
    const { calls, execFn } = ghIssueRig(conformingTicketBody())
    const manager = createTaskManager({ ...managerOpts, ...rig, issueExecFn: execFn })

    const created = await manager.create(project.id, {
      autoShip: false,
      issue: VALID_ISSUE_REF,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      throw new Error('unreachable')
    }
    expect(created.record.title).toBe('Fix flaky worktree cleanup')
    expect(created.record.issue).toEqual(VALID_ISSUE_REF)
    expect(created.record.issue_snapshot?.criteria.map((c) => c.text)).toEqual(ISSUE_CRITERIA)
    // Persisted, not just returned.
    const persisted = loadTask(project.path, created.record.id)
    expect(persisted?.issue).toEqual(VALID_ISSUE_REF)
    expect(persisted?.issue_snapshot?.criteria).toHaveLength(3)
    // The read went through the injected seam: no real binary, no network.
    expect(calls.some((c) => c.cli === 'gh' && c.args.includes('view'))).toBe(true)
    // The admission-time 'issue' journal event is there, named 'bound'.
    const bound = readTaskEvents(project.path, created.record.id).find(
      (e) => e.type === 'issue' && e.data.name === 'bound',
    )
    expect(bound).toBeDefined()
    // …and nothing claims a coverage gap on a body that has none: the
    // disclosure below has to be CONDITIONAL, not posed on every admission.
    expect(
      readTaskEvents(project.path, created.record.id).some(
        (e) => e.type === 'issue' && e.data.name === 'coverage_gap',
      ),
    ).toBe(false)
  })

  // Round-5 adversarial review, MAJEUR 2. The three legs of this disclosure
  // were each tested apart — the computation (`admitIssue.coverage_gap`), the
  // constructor (`issueCoverageGapEvent`) and the web rendering — while the
  // WIRE between them was not: forcing `if (coverageGap)` to `if (false)` in
  // `create` left the whole suite green. DP13 requires the blind spot of the
  // edit detector to be NAMED at admission, and the CHANGELOG announces it,
  // so the wire is what has to fail when it goes.
  test('an issue carrying content outside the five sections journals the coverage_gap disclosure', async () => {
    const project = register(makeRepoWithRemote())
    // Prepended: content AFTER the last heading is read as more of THAT
    // section (still covered); only content BEFORE the first recognized
    // heading is genuinely outside every one of the five.
    const stray = 'Some unrelated note nobody put under a recognized heading, on and on. '.repeat(
      10,
    )
    const { execFn } = ghIssueRig(`${stray}\n\n${conformingTicketBody()}`)
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner(), issueExecFn: execFn })

    const created = await manager.create(project.id, { autoShip: false, issue: VALID_ISSUE_REF })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      throw new Error('unreachable')
    }
    const events = readTaskEvents(project.path, created.record.id)
    const gap = events.find((e) => e.type === 'issue' && e.data.name === 'coverage_gap')
    expect(gap).toBeDefined()
    // DP14: a disclosure, not a degradation — no D2 code, and the creation
    // was not refused.
    expect(gap?.reason_code).toBeUndefined()
    expect(created.record.issue_snapshot).toBeDefined()
    // It rides ALONGSIDE 'bound', never instead of it.
    expect(events.some((e) => e.type === 'issue' && e.data.name === 'bound')).toBe(true)
  })

  test('the title+prompt path stays available, unaffected: no issue, no criteria', async () => {
    const project = register(makeRepo())
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })
    const created = await manager.create(project.id, {
      title: 'plain task',
      prompt: 'do the thing',
      autoShip: false,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      throw new Error('unreachable')
    }
    expect(created.record.issue).toBeUndefined()
    expect(created.record.issue_snapshot).toBeUndefined()
  })

  test('iid that is not a decimal integer is refused before any forge call, no residue', async () => {
    const project = register(makeRepoWithRemote())
    const rig = fakeRunner()
    const { calls, execFn } = ghIssueRig(conformingTicketBody())
    const manager = createTaskManager({ ...managerOpts, ...rig, issueExecFn: execFn })
    const before = listTasks(project.path).length

    for (const iid of ['12', 1.5, '0x1f', 0, -1]) {
      const refused = await manager.create(project.id, {
        autoShip: false,
        issue: { ...VALID_ISSUE_REF, iid },
      })
      expect(refused.ok).toBe(false)
      if (refused.ok) {
        throw new Error('unreachable')
      }
      expect(refused.code).toBe(400)
    }
    expect(calls).toHaveLength(0)
    expect(listTasks(project.path)).toHaveLength(before)
  })

  test('a body that fails the ticket lint is refused, naming the reason, no residue at all', async () => {
    const project = register(makeRepoWithRemote())
    const rig = fakeRunner()
    const broken = conformingTicketBody().replace('**Goal**', '**Not a section**')
    const { execFn } = ghIssueRig(broken)
    const manager = createTaskManager({ ...managerOpts, ...rig, issueExecFn: execFn })

    const refused = await manager.create(project.id, { autoShip: false, issue: VALID_ISSUE_REF })
    expect(refused.ok).toBe(false)
    if (refused.ok) {
      throw new Error('unreachable')
    }
    expect(refused.code).toBe(400)
    expect(refused.error).toContain('section_missing')
    // No record, no worktree, no queue entry: the refusal left nothing behind.
    expect(listTasks(project.path)).toHaveLength(0)
    expect(existsSync(queuePath(project.path))).toBe(false)
    expect(rig.starts).toHaveLength(0)
  })

  test('the forge being unreachable refuses the creation with forge_unreachable, no residue', async () => {
    const project = register(makeRepoWithRemote())
    const rig = fakeRunner()
    const { execFn } = forgeRig(() => ({ kind: 'missing' }))
    const manager = createTaskManager({ ...managerOpts, ...rig, issueExecFn: execFn })

    const refused = await manager.create(project.id, { autoShip: false, issue: VALID_ISSUE_REF })
    expect(refused.ok).toBe(false)
    if (refused.ok) {
      throw new Error('unreachable')
    }
    expect(refused.code).toBe(502)
    expect(refused.reason_code).toBe('forge_unreachable')
    expect(listTasks(project.path)).toHaveLength(0)
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

  // MAJEUR 2, the wiring half. `data.note` is raw English no component reads,
  // and `SUMMARY_KEYS.shipped` probes 'url'/'branch' — neither of which this
  // payload carries — so all three of these used to render as the same green
  // 'Publiée' line as a nominal ship. `data.name` is the rendered half.
  test('a ship that landed short of its recap NAMES it on the shipped event', async () => {
    const project = register(makeRepo())
    const cwd = project.path
    const note =
      'recap withheld from the merge request: it looks like it carries a secret (recap.md: an AWS access key id)'
    const stub = shipStub({
      pushed: true,
      mrUrl: 'https://github.com/o/r/pull/9',
      note,
      recapState: 'recap_blocked_secrets',
    })
    const manager = createTaskManager({ ...managerOpts, shipTaskFn: stub.fn, ...fakeRunner() })
    const record = seedShippable(cwd)

    expect(await manager.ship(project.id, record.id)).toEqual({ ok: true })
    expect(readTaskEvents(cwd, record.id)).toMatchObject([
      {
        type: 'shipped',
        data: { mr_url: 'https://github.com/o/r/pull/9', note, name: 'recap_blocked_secrets' },
      },
    ])
    // Still a ship: the branch IS on origin and the MR IS open. The name says
    // what did not ride along, it never turns the ship into a failure.
    expect(loadTask(cwd, record.id)?.status).toBe('shipped')
    expect(readTaskEvents(cwd, record.id)[0]).not.toHaveProperty('reason_code')
  })

  test('a ship that carried its recap names nothing: no badge on the ordinary case', async () => {
    const project = register(makeRepo())
    const cwd = project.path
    const stub = shipStub({ pushed: true, mrUrl: 'https://github.com/o/r/pull/9', note: null })
    const manager = createTaskManager({ ...managerOpts, shipTaskFn: stub.fn, ...fakeRunner() })
    const record = seedShippable(cwd)

    expect(await manager.ship(project.id, record.id)).toEqual({ ok: true })
    expect(readTaskEvents(cwd, record.id)[0]?.data).not.toHaveProperty('name')
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

  // D20: `cycle_step` is a crash-recovery marker, not a normal ship() concern
  // — these prove it is posed and cleared exactly where the plan says, in the
  // SAME writes ship() already makes.
  test('D20: a ship that will auto-merge afterward advances cycle_step to merge in the same write', async () => {
    const project = register(makeRepo())
    const cwd = project.path
    const stub = shipStub({ pushed: true, mrUrl: 'https://github.com/o/r/pull/9', note: null })
    const manager = createTaskManager({
      ...managerOpts,
      shipTaskFn: stub.fn,
      ...fakeRunner(),
      mergeSettings: { policy: 'auto', deleteBranch: false, allowMergeWithoutChecks: false },
    })
    const record = seedShippable(cwd)

    expect(await manager.ship(project.id, record.id)).toEqual({ ok: true })
    expect(loadTask(cwd, record.id)?.cycle_step).toBe('merge')
  })

  test('D20: an ordinary ship under mergePolicy human never sets cycle_step', async () => {
    const project = register(makeRepo())
    const cwd = project.path
    const stub = shipStub({ pushed: true, mrUrl: 'https://github.com/o/r/pull/9', note: null })
    const manager = createTaskManager({ ...managerOpts, shipTaskFn: stub.fn, ...fakeRunner() })
    const record = seedShippable(cwd)

    expect(await manager.ship(project.id, record.id)).toEqual({ ok: true })
    expect(loadTask(cwd, record.id)?.cycle_step).toBeUndefined()
  })

  test('D20: a stale cycle_step does not survive a shipRefusal', async () => {
    const project = register(makeRepo())
    const cwd = project.path
    const stub = shipStub({ pushed: true, mrUrl: null, note: null })
    const manager = createTaskManager({ ...managerOpts, shipTaskFn: stub.fn, ...fakeRunner() })
    const shipped = seedShippable(cwd)
    shipped.status = 'shipped'
    shipped.cycle_step = 'merge'
    saveTask(cwd, shipped)

    expect(await manager.ship(project.id, shipped.id)).toEqual({
      ok: false,
      code: 409,
      error: 'task is already shipped',
    })
    expect(stub.calls).toHaveLength(0)
    // A stale marker a refusal saw must not outlive the refusal, or a
    // resumed boot would keep calling ship() on this exact refusal forever.
    expect(loadTask(cwd, shipped.id)?.cycle_step).toBeUndefined()
  })

  test('D20: a stale cycle_step does not survive a push failure', async () => {
    const project = register(makeRepo())
    const cwd = project.path
    const stub = shipStub({ pushed: false, error: 'git push failed: permission denied' })
    const manager = createTaskManager({ ...managerOpts, shipTaskFn: stub.fn, ...fakeRunner() })
    const record = seedShippable(cwd)
    record.cycle_step = 'ship'
    saveTask(cwd, record)

    expect(await manager.ship(project.id, record.id)).toEqual({
      ok: false,
      code: 502,
      error: 'git push failed: permission denied',
    })
    expect(loadTask(cwd, record.id)?.status).toBe('review_ok')
    expect(loadTask(cwd, record.id)?.cycle_step).toBeUndefined()
  })
})

// --- D20: cycle_step ship/merge --------------------------------------------

describe('D20: cycle_step boot recovery, idempotence and reentrancy', () => {
  test('a crash between review_ok and ship resumes the ship on the next boot', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const seeded = seedShippable(repo)
    seeded.auto_ship = true
    seeded.cycle_step = 'ship'
    saveTask(repo, seeded)

    const stub = shipStub({ pushed: true, mrUrl: 'https://github.com/o/r/pull/1', note: null })
    // A fresh manager over the SAME .codesema/: nothing here remembers the
    // process that set cycle_step, only the disk does.
    const manager = createTaskManager({ ...managerOpts, shipTaskFn: stub.fn, ...fakeRunner() })

    await manager.startPending()

    expect(stub.calls).toMatchObject([{ task: { id: seeded.id } }])
    const record = loadTask(repo, seeded.id)
    expect(record?.status).toBe('shipped')
    // Default mergePolicy is human: nothing to chain into, so the resumed
    // ship clears the marker outright rather than advancing it.
    expect(record?.cycle_step).toBeUndefined()
  })

  test('a crash between shipped and merge resumes the merge on the next boot', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const seeded = seedShippable(repo)
    seeded.status = 'shipped'
    seeded.cycle_step = 'merge'
    saveTask(repo, seeded)

    const mergeCalls: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      mergeSettings: { policy: 'auto', deleteBranch: false, allowMergeWithoutChecks: false },
      mergeTaskFn: (options) => {
        mergeCalls.push(options.task.id)
        return Promise.resolve({
          kind: 'merged' as const,
          cli: 'gh' as const,
          url: 'https://github.com/o/r/pull/2',
          readiness: { ready: true, conditions: [], blockers: [] },
          events: [{ type: 'merge' as const, data: { name: 'merged', cli: 'gh' } }],
        })
      },
    })

    await manager.startPending()

    expect(mergeCalls).toEqual([seeded.id])
    const record = loadTask(repo, seeded.id)
    expect(record?.status).toBe('shipped')
    expect(record?.cycle_step).toBeUndefined()
    expect(
      readTaskEvents(repo, seeded.id).some(
        (event) => event.type === 'merge' && event.data.name === 'merged',
      ),
    ).toBe(true)
  })

  test('a cycle_step resumed on an already-merged ticket never calls mergeTaskFn again', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const seeded = seedShippable(repo)
    seeded.status = 'shipped'
    seeded.cycle_step = 'merge'
    saveTask(repo, seeded)
    // The earlier, crashed call's own line: the merge landed, but the process
    // died before it cleared cycle_step.
    appendTaskEvent(repo, seeded.id, { type: 'merge', data: { name: 'merged', cli: 'gh' } })

    let calls = 0
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      mergeSettings: { policy: 'auto', deleteBranch: false, allowMergeWithoutChecks: false },
      mergeTaskFn: () => {
        calls += 1
        return Promise.resolve({
          kind: 'merged' as const,
          cli: 'gh' as const,
          url: null,
          readiness: { ready: true, conditions: [], blockers: [] },
          events: [],
        })
      },
    })

    await manager.startPending()

    expect(calls).toBe(0)
    expect(loadTask(repo, seeded.id)?.cycle_step).toBeUndefined()
  })

  test("runMergeStep's merging guard refuses a second concurrent resume for the same task", async () => {
    const project = register(makeRepo())
    const repo = project.path
    const seeded = seedShippable(repo)
    seeded.status = 'shipped'
    seeded.cycle_step = 'merge'
    saveTask(repo, seeded)

    let calls = 0
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      mergeSettings: { policy: 'auto', deleteBranch: false, allowMergeWithoutChecks: false },
      mergeTaskFn: async () => {
        calls += 1
        // Widens the in-flight window: if the guard were absent, a second
        // concurrent resume would land its own mergeTaskFn call well inside it.
        await new Promise((resolve) => setTimeout(resolve, 20))
        return {
          kind: 'merged' as const,
          cli: 'gh' as const,
          url: null,
          readiness: { ready: true, conditions: [], blockers: [] },
          events: [{ type: 'merge' as const, data: { name: 'merged', cli: 'gh' } }],
        }
      },
    })

    await Promise.all([manager.startPending(), manager.startPending()])

    expect(calls).toBe(1)
    expect(loadTask(repo, seeded.id)?.cycle_step).toBeUndefined()
  })

  test('reply is refused with 409 while a resumed merge is in flight, and purges nothing while refused', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const seeded = seedShippable(repo)
    seeded.status = 'shipped'
    seeded.cycle_step = 'merge'
    saveTask(repo, seeded)

    let entered = false
    let releaseMerge: () => void = () => {}
    const inFlight = new Promise<void>((resolve) => {
      releaseMerge = resolve
    })
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      mergeSettings: { policy: 'auto', deleteBranch: false, allowMergeWithoutChecks: false },
      mergeTaskFn: async () => {
        entered = true
        await inFlight
        return {
          kind: 'merged' as const,
          cli: 'gh' as const,
          url: null,
          readiness: { ready: true, conditions: [], blockers: [] },
          events: [{ type: 'merge' as const, data: { name: 'merged', cli: 'gh' } }],
        }
      },
    })

    const pending = manager.startPending()
    await until(() => entered)

    expect(manager.reply(project.id, seeded.id, 'try again')).toEqual({
      ok: false,
      code: 409,
      error: 'merge in progress',
    })
    expect(rig.replies).toEqual([])

    releaseMerge()
    await pending
    expect(loadTask(repo, seeded.id)?.cycle_step).toBeUndefined()
  })
})

describe('D20: reply/resume/abandon purge a stale cycle_step', () => {
  test('reply purges cycle_step before delegating to the runner', () => {
    const project = register(makeRepo())
    const repo = project.path
    const seeded = seedTask(repo, 'stale marker')
    seeded.status = 'waiting_for_you'
    seeded.cycle_step = 'ship'
    saveTask(repo, seeded)
    const rig = fakeRunner({ replyResult: { ok: true } })
    const manager = createTaskManager({ ...managerOpts, ...rig })

    const result = manager.reply(project.id, seeded.id, 'try again')

    expect(result.ok).toBe(true)
    expect(rig.replies).toEqual([{ id: seeded.id, message: 'try again' }])
    expect(loadTask(repo, seeded.id)?.cycle_step).toBeUndefined()
  })

  test('resume purges cycle_step before delegating to the runner', () => {
    const project = register(makeRepo())
    const repo = project.path
    const seeded = seedTask(repo, 'stale marker')
    seeded.status = 'interrupted'
    seeded.cycle_step = 'merge'
    saveTask(repo, seeded)
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })

    const result = manager.resume(project.id, seeded.id)

    expect(result.ok).toBe(true)
    expect(rig.resumes).toEqual([seeded.id])
    expect(loadTask(repo, seeded.id)?.cycle_step).toBeUndefined()
  })

  test('abandon purges cycle_step before delegating to the runner', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const seeded = seedTask(repo, 'stale marker')
    seeded.status = 'waiting_for_you'
    seeded.cycle_step = 'ship'
    saveTask(repo, seeded)
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })

    const result = await manager.abandon(project.id, seeded.id)

    expect(result.ok).toBe(true)
    expect(rig.abandons).toEqual([seeded.id])
    expect(loadTask(repo, seeded.id)?.cycle_step).toBeUndefined()
  })

  test('a task carrying no cycle_step at all is left exactly as it was (no needless write)', () => {
    const project = register(makeRepo())
    const repo = project.path
    const seeded = seedTask(repo, 'nothing stale')
    seeded.status = 'waiting_for_you'
    saveTask(repo, seeded)
    const before = loadTask(repo, seeded.id)?.updated_at
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig })

    manager.reply(project.id, seeded.id, 'go')

    // reply() itself still runs (the runner stub records it); only the
    // defensive purge is a no-op when there is nothing to purge.
    expect(rig.replies).toEqual([{ id: seeded.id, message: 'go' }])
    expect(loadTask(repo, seeded.id)?.updated_at).toBe(before)
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

// --- D22 (minimal): post-merge checks replay -------------------------------

/** A landed-merge outcome `mergeTaskFn` can resolve with, shared by the D22 tests below. */
function mergedOutcome() {
  return Promise.resolve({
    kind: 'merged' as const,
    cli: 'gh' as const,
    url: null,
    readiness: { ready: true, conditions: [], blockers: [] },
    events: [{ type: 'merge' as const, data: { name: 'merged', cli: 'gh' } }],
  })
}

describe('D22 (minimal): post-merge checks replay', () => {
  test('a landed merge journals post_merge_checks without waiting for it to complete the turn', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const seeded = seedShippable(repo)
    seeded.status = 'shipped'
    seeded.cycle_step = 'merge'
    saveTask(repo, seeded)

    let releaseReplay: () => void = () => {}
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve
    })
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      mergeSettings: { policy: 'auto', deleteBranch: false, allowMergeWithoutChecks: false },
      mergeTaskFn: mergedOutcome,
      replayPostMergeChecksFn: async () => {
        await replayGate
        return finishedChecks({
          status: 'failed',
          checks: [
            {
              command: 'bun test',
              status: 'failed',
              exit_code: 1,
              duration_ms: 500,
              tail: 'boom\n',
            },
          ],
        })
      },
    })

    await manager.startPending()

    // The merge step already completed the task — still gated behind
    // `replayGate` — with no post_merge_checks line yet: completion never
    // awaited the replay.
    expect(loadTask(repo, seeded.id)?.status).toBe('shipped')
    expect(loadTask(repo, seeded.id)?.cycle_step).toBeUndefined()
    expect(readTaskEvents(repo, seeded.id).some((e) => e.type === 'post_merge_checks')).toBe(false)

    releaseReplay()
    await until(() => readTaskEvents(repo, seeded.id).some((e) => e.type === 'post_merge_checks'))

    const event = readTaskEvents(repo, seeded.id).find((e) => e.type === 'post_merge_checks')
    // `record.base` is 'origin/main' (seedShippable): the event names the
    // bare target the replay actually fetched.
    expect(event?.data).toMatchObject({ status: 'failed', passed: 0, failed: 1, target: 'main' })
    expect(event?.reason_code).toBe('checks_failed')
  })

  test('a replay that could not even run (null) is logged, never journaled, never crashes', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const seeded = seedShippable(repo)
    seeded.status = 'shipped'
    seeded.cycle_step = 'merge'
    saveTask(repo, seeded)

    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      onNotice: (message) => notices.push(message),
      mergeSettings: { policy: 'auto', deleteBranch: false, allowMergeWithoutChecks: false },
      mergeTaskFn: mergedOutcome,
      replayPostMergeChecksFn: async () => null,
    })

    await manager.startPending()
    expect(loadTask(repo, seeded.id)?.status).toBe('shipped')

    await until(() => notices.some((m) => m.includes('post-merge checks replay')))
    expect(readTaskEvents(repo, seeded.id).some((e) => e.type === 'post_merge_checks')).toBe(false)
  })

  test('the replay hook itself throwing is caught and never crashes the merge step', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const seeded = seedShippable(repo)
    seeded.status = 'shipped'
    seeded.cycle_step = 'merge'
    saveTask(repo, seeded)

    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      onNotice: (message) => notices.push(message),
      mergeSettings: { policy: 'auto', deleteBranch: false, allowMergeWithoutChecks: false },
      mergeTaskFn: mergedOutcome,
      replayPostMergeChecksFn: () => {
        throw new Error('boom: broken seam')
      },
    })

    await manager.startPending()
    expect(loadTask(repo, seeded.id)?.status).toBe('shipped')

    await until((): boolean =>
      notices.some((m) => m.includes('post-merge checks replay hook failed unexpectedly')),
    )
    expect(readTaskEvents(repo, seeded.id).some((e) => e.type === 'post_merge_checks')).toBe(false)
  })
})

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
    expect(journal?.data).toEqual({
      status: 'error',
      passed: 0,
      failed: 0,
      error: 'engine exploded',
    })
    // The TASK is untouched: checks are best-effort by contract.
    expect(loadTask(project.path, record.id)?.status).toBe(statusBefore)
    // And the in-flight flag was released even on the error path.
    expect(manager.checks(project.id, record.id)).toEqual({ ok: true })
  })

  test('auto-trigger: onTurnDone waits for checks of a committed turn BEFORE the review', async () => {
    const project = register(makeRepo())
    const rig = fakeRunner()
    let release!: (checks: TaskChecks) => void
    const gate = new Promise<TaskChecks>((resolve) => {
      release = resolve
    })
    let runs = 0
    let reviewStarted = false
    const manager = createTaskManager({
      ...managerOpts,
      createRunnerFn: rig.createRunnerFn,
      reviewTurnFn: async (record) => {
        reviewStarted = true
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

    const done = rig.runnerOptions().onTurnDone!(record, io)
    await until(() => runs === 1)
    // Checks are in flight: the review must not have started, and the
    // decision is not taken yet.
    expect(reviewStarted).toBe(false)
    expect(record.status).not.toBe('review_ok')
    expect(readTaskChecks(project.path, record.id)?.status).toBe('running')

    release(finishedChecks())
    await done
    expect(reviewStarted).toBe(true)
    expect(record.status).toBe('review_ok')
    expect(readTaskChecks(project.path, record.id)?.status).toBe('passed')

    // A turn WITHOUT a fresh commit (last commit event belongs to turn 1,
    // record now has 2 turns) never re-triggers and does not delay.
    const again = loadTask(project.path, record.id)!
    again.turns.push({
      prompt: 'follow-up',
      response: 'done',
      question: null,
      started_at: new Date().toISOString(),
      ended_at: null,
    })
    saveTask(project.path, again)
    reviewStarted = false
    await rig.runnerOptions().onTurnDone!(again, io)
    expect(runs).toBe(1)
    expect(reviewStarted).toBe(true)
  })
})

// --- checks gate (T3.1) ---------------------------------------------------

describe('checks gate (T3.1)', () => {
  function turnIo(cwd: string, record: TaskRecord) {
    return {
      emit: (input: Parameters<typeof appendTaskEvent>[2]) =>
        appendTaskEvent(cwd, record.id, input),
      persist: () => saveTask(cwd, record),
      text: () => {},
      signal: new AbortController().signal,
    }
  }

  async function driveTurn(opts: {
    checks: TaskChecks | Promise<TaskChecks>
    review?: (record: TaskRecord) => void | Promise<void>
    autoShip?: boolean
    shipTaskFn?: (options: ShipTaskOptions) => Promise<ShipOutcome>
    loadCap?: ReturnType<typeof createLoadCap>
  }) {
    const project = register(makeRepo())
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      createRunnerFn: rig.createRunnerFn,
      ...(opts.loadCap ? { loadCap: opts.loadCap } : {}),
      ...(opts.shipTaskFn ? { shipTaskFn: opts.shipTaskFn } : {}),
      reviewTurnFn: async (record) => {
        if (opts.review) {
          await opts.review(record)
        } else {
          record.status = 'review_ok'
        }
      },
      runChecksFn: () => Promise.resolve(opts.checks),
    })
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const { record } = seedCommittedTask(project.path)
    if (opts.autoShip) {
      record.auto_ship = true
      saveTask(project.path, record)
    }
    await rig.runnerOptions().onTurnDone!(record, turnIo(project.path, record))
    return { project, record, manager, rig }
  }

  test('AC1: checks failed + review OK → not ready, carries checks_failed', async () => {
    const { record, project } = await driveTurn({
      checks: finishedChecks({
        status: 'failed',
        checks: [
          { command: 'bun test', status: 'failed', exit_code: 1, duration_ms: 5, tail: 'boom' },
        ],
      }),
    })
    expect(record.status).toBe('review_ko')
    expect(record.reason?.code).toBe('checks_failed')
    expect(record.reason?.detail).toContain('bun test')
    expect(record.checks_status).toBe('failed')
    const journal = readTaskEvents(project.path, record.id).find((e) => e.type === 'checks')
    expect(journal?.reason_code).toBe('checks_failed')
    expect(journal?.data.status).toBe('failed')
    expect(loadTask(project.path, record.id)?.reason?.code).toBe('checks_failed')
  })

  test('AC1: a timeout check blocks with checks_failed even if the review is green', async () => {
    const { record } = await driveTurn({
      checks: finishedChecks({
        status: 'passed',
        checks: [
          { command: 'bun test', status: 'timeout', exit_code: null, duration_ms: 5, tail: '' },
        ],
      }),
    })
    expect(record.status).toBe('review_ko')
    expect(record.reason?.code).toBe('checks_failed')
    expect(record.reason?.detail).toContain('timed out')
    expect(record.reason?.detail).toContain('bun test')
  })

  test('AC2: checks passed + review OK → review_ok, no checks reason', async () => {
    const { record } = await driveTurn({ checks: finishedChecks({ status: 'passed' }) })
    expect(record.status).toBe('review_ok')
    expect(record.reason).toBeUndefined()
    expect(record.checks_status).toBe('passed')
  })

  test('AC3: unconfigured does not block and is said on the record and in the journal', async () => {
    const { record, project } = await driveTurn({
      checks: finishedChecks({ status: 'unconfigured', checks: [], error: null }),
    })
    expect(record.status).toBe('review_ok')
    expect(record.reason).toBeUndefined()
    expect(record.checks_status).toBe('unconfigured')
    const journal = readTaskEvents(project.path, record.id).find((e) => e.type === 'checks')
    expect(journal?.data.status).toBe('unconfigured')
    expect(journal?.reason_code).toBeUndefined()
    expect(loadTask(project.path, record.id)?.checks_status).toBe('unconfigured')
  })

  test('AC3: no lockfile → no plan is unconfigured, distinct from a green run', async () => {
    // Real engine, no injected runChecksFn: a worktree with leftover CI
    // declarations but no recognised lockfile resolves no plan.
    const project = register(makeRepo())
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      createRunnerFn: rig.createRunnerFn,
      reviewTurnFn: async (record) => {
        record.status = 'review_ok'
      },
    })
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const { record, worktree } = seedCommittedTask(project.path)
    writeFileSync(
      join(worktree, 'lefthook.yml'),
      'pre-push:\n  commands:\n    all:\n      run: make check\n',
    )
    await rig.runnerOptions().onTurnDone!(record, turnIo(project.path, record))
    expect(record.status).toBe('review_ok')
    expect(record.checks_status).toBe('unconfigured')
    expect(readTaskChecks(project.path, record.id)?.status).toBe('unconfigured')
    const journal = readTaskEvents(project.path, record.id).find((e) => e.type === 'checks')
    expect(journal?.data.status).toBe('unconfigured')
    expect(journal?.data.status).not.toBe('passed')
  })

  test('AC4: no runtime / engine throw → named error, non-blocking, said in the API', async () => {
    const { record, project, manager } = await driveTurn({
      checks: finishedChecks({
        status: 'error',
        checks: [],
        error: 'no container runtime found: install docker or podman to run checks in a sandbox',
      }),
    })
    expect(record.status).toBe('review_ok')
    expect(record.checks_status).toBe('error')
    expect(record.reason).toBeUndefined()
    const persisted = manager.getChecks(project.id, record.id)
    expect(persisted?.status).toBe('error')
    expect(persisted?.error).toContain('no container runtime')
    const journal = readTaskEvents(project.path, record.id).find((e) => e.type === 'checks')
    expect(journal?.data.status).toBe('error')
    expect(journal?.data.error).toContain('no container runtime')
  })

  test('non-regression: a rejecting runChecks becomes error and never stays running', async () => {
    const project = register(makeRepo())
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      createRunnerFn: rig.createRunnerFn,
      reviewTurnFn: async (record) => {
        record.status = 'review_ok'
      },
      runChecksFn: () => Promise.reject(new Error('engine exploded')),
    })
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const { record } = seedCommittedTask(project.path)
    await rig.runnerOptions().onTurnDone!(record, turnIo(project.path, record))
    expect(readTaskChecks(project.path, record.id)?.status).toBe('error')
    expect(readTaskChecks(project.path, record.id)?.error).toBe('engine exploded')
    expect(record.status).toBe('review_ok')
    expect(record.checks_status).toBe('error')
  })

  test('AC5: checks slot is released before the review acquires, including on failed/error/unconfigured', async () => {
    for (const status of ['failed', 'error', 'unconfigured'] as const) {
      const cap = createLoadCap(1)
      const order: string[] = []
      const project = register(makeRepo())
      const rig = fakeRunner()
      const manager = createTaskManager({
        ...managerOpts,
        loadCap: cap,
        createRunnerFn: rig.createRunnerFn,
        runChecksFn: async () => {
          order.push(`checks-held:${cap.snapshot().occupied}`)
          return finishedChecks({
            status,
            checks:
              status === 'failed'
                ? [
                    {
                      command: 'bun test',
                      status: 'failed',
                      exit_code: 1,
                      duration_ms: 5,
                      tail: '',
                    },
                  ]
                : [],
            error: status === 'error' ? 'no runtime' : null,
          })
        },
        reviewTurnFn: async (record) => {
          order.push(`review-before-acquire:${cap.snapshot().occupied}`)
          const release = await cap.acquire('review')
          try {
            order.push(`review-held:${cap.snapshot().occupied}`)
            record.status = 'review_ok'
          } finally {
            release()
          }
        },
      })
      manager.checks(project.id, 'aaaaaaaaaaaa')
      const { record } = seedCommittedTask(project.path)
      await rig.runnerOptions().onTurnDone!(record, turnIo(project.path, record))
      expect(order).toEqual(['checks-held:1', 'review-before-acquire:0', 'review-held:1'])
      expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
    }
  })

  test('AC5: a saturated cap makes the end of turn WAIT, never fail, and names the wait', async () => {
    const cap = createLoadCap(1)
    const holder = cap.tryAcquire('turn')
    const project = register(makeRepo())
    const rig = fakeRunner()
    const envelopes: TaskEnvelope[] = []
    const manager = createTaskManager({
      ...managerOpts,
      loadCap: cap,
      createRunnerFn: rig.createRunnerFn,
      reviewTurnFn: async (record) => {
        record.status = 'review_ok'
      },
      runChecksFn: () => Promise.resolve(finishedChecks()),
    })
    manager.subscribe((e) => envelopes.push(e))
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const { record } = seedCommittedTask(project.path)
    const done = rig.runnerOptions().onTurnDone!(record, turnIo(project.path, record))
    await until(() => cap.snapshot().queued === 1)
    const queued = readTaskEvents(project.path, record.id).filter((e) => e.type === 'queue')
    expect(queued.length).toBeGreaterThanOrEqual(1)
    expect(queued[0]?.data.name).toBe('machine_busy')
    expect(queued[0]?.reason_code).toBe('resource_busy')
    expect(record.status).not.toBe('failed')
    holder?.()
    await done
    expect(record.status).toBe('review_ok')
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
  })

  test('AC6: ship while checks run is 409 resource_busy, no residue', async () => {
    const project = register(makeRepo())
    const { record } = seedCommittedTask(project.path)
    record.status = 'review_ok'
    record.base = 'origin/main'
    record.branch = 'codesema/task-shippable-task'
    saveTask(project.path, record)
    let release!: (checks: TaskChecks) => void
    const gate = new Promise<TaskChecks>((resolve) => {
      release = resolve
    })
    const shipCalls: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      runChecksFn: () => gate,
      shipTaskFn: (options) => {
        shipCalls.push(options.task.id)
        return Promise.resolve({ pushed: true, mrUrl: null, note: null })
      },
    })
    expect(manager.checks(project.id, record.id)).toEqual({ ok: true })
    const refused = await manager.ship(project.id, record.id)
    expect(refused).toEqual({
      ok: false,
      code: 409,
      error: 'checks are still running',
      reason_code: 'resource_busy',
    })
    expect(shipCalls).toEqual([])
    expect(loadTask(project.path, record.id)?.status).toBe('review_ok')
    expect(existsSync(record.worktree)).toBe(true)
    release(finishedChecks())
    await until(() => readTaskChecks(project.path, record.id)?.status === 'passed')
    expect(await manager.ship(project.id, record.id)).toEqual({ ok: true })
    expect(shipCalls).toEqual([record.id])
  })

  test('a 409 from startChecks (already running) does not stall the end of turn', async () => {
    const project = register(makeRepo())
    const { record } = seedCommittedTask(project.path)
    let release!: (checks: TaskChecks) => void
    const gate = new Promise<TaskChecks>((resolve) => {
      release = resolve
    })
    const rig = fakeRunner()
    let reviews = 0
    const manager = createTaskManager({
      ...managerOpts,
      createRunnerFn: rig.createRunnerFn,
      reviewTurnFn: async (rec) => {
        reviews++
        rec.status = 'review_ok'
      },
      runChecksFn: () => gate,
    })
    expect(manager.checks(project.id, record.id)).toEqual({ ok: true })
    await rig.runnerOptions().onTurnDone!(record, turnIo(project.path, record))
    expect(reviews).toBe(1)
    expect(record.status).toBe('review_ok')
    release(finishedChecks())
    await until(() => readTaskChecks(project.path, record.id)?.status === 'passed')
  })

  test('auto_ship does not fire when checks fail even if the review is green', async () => {
    const shipCalls: string[] = []
    const { record } = await driveTurn({
      autoShip: true,
      checks: finishedChecks({
        status: 'failed',
        checks: [{ command: 'bun test', status: 'failed', exit_code: 1, duration_ms: 5, tail: '' }],
      }),
      shipTaskFn: (options) => {
        shipCalls.push(options.task.id)
        return Promise.resolve({ pushed: true, mrUrl: 'https://example/mr/1', note: null })
      },
    })
    expect(record.status).toBe('review_ko')
    expect(shipCalls).toEqual([])
  })
})

// --- issue reconciliation (T2.4/D7/DP13) -----------------------------------

/** A real emit/persist `io`, so the reconciliation's journal writes are observable. */
function taskIo(cwd: string, record: TaskRecord) {
  const emitted: TaskEvent[] = []
  const io = {
    emit: (input: Parameters<typeof appendTaskEvent>[2]) => {
      emitted.push(appendTaskEvent(cwd, record.id, input))
    },
    persist: () => saveTask(cwd, record),
    text: () => {},
    signal: new AbortController().signal,
  }
  return { io, emitted }
}

/** Seeds a 'queued', admitted-from-issue task with a real manager, fakeRunner, and no queue.json. */
async function seedIssueTask(project: Project, body: string): Promise<TaskRecord> {
  const rig = fakeRunner()
  const { execFn } = ghIssueRig(body)
  const manager = createTaskManager({ ...managerOpts, ...rig, issueExecFn: execFn })
  const created = await manager.create(project.id, { autoShip: false, issue: VALID_ISSUE_REF })
  if (!created.ok) {
    throw new Error('fixture setup failed')
  }
  return created.record
}

describe('onTurnDone — issue reconciliation (T2.4/DP13, pre-review recomparison point)', () => {
  test('hash unchanged: no journal line, review runs normally', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    let reviewRan = false
    const { execFn } = ghIssueRig(body)
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      issueExecFn: execFn,
      reviewTurnFn: async (r) => {
        reviewRan = true
        r.status = 'review_ok'
      },
    })
    manager.checks(project.id, 'aaaaaaaaaaaa') // forces the lazy context/runner to exist
    const { io, emitted } = taskIo(project.path, record)
    await rig.runnerOptions().onTurnDone!(record, io)
    expect(reviewRan).toBe(true)
    expect(record.status).toBe('review_ok')
    expect(emitted.some((e) => e.type === 'issue')).toBe(false)
  })

  test('edited: waiting_for_you, named journal event, review is SKIPPED (never restarts a turn)', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    let reviewRan = false
    const edited = body.replace(
      'Tickets are launched from the workspace.',
      'Tickets are launched from somewhere else now.',
    )
    const { execFn } = ghIssueRig(edited)
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      issueExecFn: execFn,
      reviewTurnFn: async () => {
        reviewRan = true
      },
    })
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const { io, emitted } = taskIo(project.path, record)
    await rig.runnerOptions().onTurnDone!(record, io)
    expect(reviewRan).toBe(false)
    expect(record.status).toBe('waiting_for_you')
    const event = emitted.find((e) => e.type === 'issue')
    expect(event?.data.name).toBe('edited')
    expect(event?.data.sections).toBe('context')
    // Persisted, not just mutated in memory.
    expect(loadTask(project.path, record.id)?.status).toBe('waiting_for_you')
  })

  test('body no longer lints: not_ticket, waiting_for_you, distinct name from edited, review SKIPPED', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    let reviewRan = false
    const broken = body.replace('**Goal**', '**Not a section**')
    const { execFn } = ghIssueRig(broken)
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      issueExecFn: execFn,
      reviewTurnFn: async () => {
        reviewRan = true
      },
    })
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const { io, emitted } = taskIo(project.path, record)
    await rig.runnerOptions().onTurnDone!(record, io)
    expect(reviewRan).toBe(false)
    expect(record.status).toBe('waiting_for_you')
    const event = emitted.find((e) => e.type === 'issue')
    expect(event?.data.name).toBe('not_ticket')
    expect(String(event?.data.message)).toContain('section_missing')
  })

  test('cosmetic (raw moved, canonical meaning did not): neutral line, status untouched, review still runs', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    let reviewRan = false
    const crlf = body.replaceAll('\n', '\r\n')
    const { execFn } = ghIssueRig(crlf)
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      issueExecFn: execFn,
      reviewTurnFn: async (r) => {
        reviewRan = true
        r.status = 'review_ok'
      },
    })
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const { io, emitted } = taskIo(project.path, record)
    await rig.runnerOptions().onTurnDone!(record, io)
    expect(reviewRan).toBe(true)
    expect(record.status).toBe('review_ok')
    const event = emitted.find((e) => e.type === 'issue')
    expect(event?.data.name).toBe('cosmetic')
    expect(event?.reason_code).toBeUndefined()
  })

  test('forge unreachable: continues on the snapshot, forge_unreachable journaled on an "issue" line, review still runs', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    let reviewRan = false
    const { execFn } = forgeRig(() => ({ kind: 'missing' }))
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      issueExecFn: execFn,
      reviewTurnFn: async (r) => {
        reviewRan = true
        r.status = 'review_ok'
      },
    })
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const { io, emitted } = taskIo(project.path, record)
    await rig.runnerOptions().onTurnDone!(record, io)
    expect(reviewRan).toBe(true)
    // Round-5 review, MAJEUR 1: the line is an 'issue' fact named
    // 'unreachable' (DP15), NOT an 'error' — red would be a cry-wolf on a
    // task that carries on unmodified, and 'error' renders the server's
    // English `data.message` verbatim in a French journal. The D2 code still
    // rides it: `reason_code` is independent of the type.
    const event = emitted.find((e) => e.type === 'issue' && e.data.name === 'unreachable')
    expect(event).toBeDefined()
    expect(event?.reason_code).toBe('forge_unreachable')
    expect(emitted.some((e) => e.type === 'error')).toBe(false)
    expect(record.reason?.code).toBe('forge_unreachable')
  })

  // DP14, adversarial review: a `forge_unreachable` left by an EARLIER
  // reconciliation is a claim about that past attempt. The moment the forge
  // answers again, the claim is stale and must not linger as a silent lie
  // about the task's present state — cleared even on 'unchanged', whose own
  // journal stays silent (the silence is about the LINE, not the fix).
  test('a stale forge_unreachable reason is cleared once the forge answers again, even on "unchanged"', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    // Set directly on the in-memory record passed to onTurnDone below —
    // never reloaded from disk, same pattern every other test in this
    // describe block uses: the second manager's OWN generic boot recovery
    // (unrelated to T2.4) would otherwise stamp a 'running' record it finds
    // on disk as 'interrupted'/orphaned before this test ever runs, clobbering
    // whatever reason a reload would see.
    record.reason = { code: 'forge_unreachable', detail: 'an earlier attempt could not reach it' }

    let reviewRan = false
    const { execFn } = ghIssueRig(body) // same body: the outcome is 'unchanged'
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      issueExecFn: execFn,
      reviewTurnFn: async (r) => {
        reviewRan = true
        r.status = 'review_ok'
      },
    })
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const { io, emitted } = taskIo(project.path, record)
    await rig.runnerOptions().onTurnDone!(record, io)
    expect(reviewRan).toBe(true)
    // 'unchanged' stays silent on the journal — the fix is not an event.
    expect(emitted.some((e) => e.type === 'issue')).toBe(false)
    expect(record.reason).toBeUndefined()
  })

  // DP14, same doctrine, on the 'cosmetic' path: the reason clears AND the
  // neutral cosmetic line still fires — the two are independent.
  test('a stale forge_unreachable reason is also cleared on "cosmetic", alongside its own neutral line', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    record.reason = { code: 'forge_unreachable', detail: 'an earlier attempt could not reach it' }

    const crlf = body.replaceAll('\n', '\r\n')
    const { execFn } = ghIssueRig(crlf)
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      issueExecFn: execFn,
      reviewTurnFn: async (r) => {
        r.status = 'review_ok'
      },
    })
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const { io, emitted } = taskIo(project.path, record)
    await rig.runnerOptions().onTurnDone!(record, io)
    expect(emitted.find((e) => e.type === 'issue')?.data.name).toBe('cosmetic')
    expect(record.reason).toBeUndefined()
  })

  // Round-2 adversarial review, majeur 3: the erasure's SPECIFICITY (only
  // ever a forge_unreachable) was uncovered — the two existing DP14 tests
  // both plant `forge_unreachable` and never check that a DIFFERENT reason
  // is left alone. `record.reason !== undefined` would pass every existing
  // assertion while erasing every code, not just this one's own.
  test('a non-forge reason (resource_busy) survives an "unchanged" reconciliation untouched', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    record.reason = {
      code: 'resource_busy',
      detail: 'another task of this project is already active',
    }

    const { execFn } = ghIssueRig(body) // same body: 'unchanged'
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      issueExecFn: execFn,
      reviewTurnFn: async (r) => {
        r.status = 'review_ok'
      },
    })
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const { io, emitted } = taskIo(project.path, record)
    await rig.runnerOptions().onTurnDone!(record, io)
    expect(emitted.some((e) => e.type === 'issue')).toBe(false)
    expect(record.reason).toEqual({
      code: 'resource_busy',
      detail: 'another task of this project is already active',
    })
  })

  test('a non-forge reason (checks_failed) survives a "cosmetic" reconciliation untouched', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    record.reason = { code: 'checks_failed', detail: 'lint failed on 2 files' }

    const crlf = body.replaceAll('\n', '\r\n')
    const { execFn } = ghIssueRig(crlf)
    const rig = fakeRunner()
    const manager = createTaskManager({
      ...managerOpts,
      ...rig,
      issueExecFn: execFn,
      reviewTurnFn: async (r) => {
        r.status = 'review_ok'
      },
    })
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const { io, emitted } = taskIo(project.path, record)
    await rig.runnerOptions().onTurnDone!(record, io)
    expect(emitted.find((e) => e.type === 'issue')?.data.name).toBe('cosmetic')
    expect(record.reason).toEqual({ code: 'checks_failed', detail: 'lint failed on 2 files' })
  })
})

describe('boot — issue reconciliation (T2.4/D7)', () => {
  test('a project with no ticketed task makes no forge call at all', () => {
    const project = register(makeRepo())
    seedTask(project.path, 'plain, no issue')
    const { calls, execFn } = forgeRig(() => ({ kind: 'missing' }))
    createTaskManager({ ...managerOpts, ...fakeRunner(), issueExecFn: execFn })
    expect(calls).toHaveLength(0)
    void project
  })

  test('a queued task whose issue was edited moves to waiting_for_you and leaves the queue', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    writeJsonAtomic(queuePath(project.path), {
      version: 1,
      entries: [{ id: record.id, enqueued_at: new Date().toISOString() }],
    })
    expect(readQueue(project.path).entries.map((e) => e.id)).toEqual([record.id])

    const edited = body.replace(
      'Tickets are launched from the workspace.',
      'Tickets are launched from somewhere else now.',
    )
    const { execFn } = ghIssueRig(edited)
    // Nothing calls startPending() here: this proves reconciliation itself
    // runs regardless (a workspace that never queues anything still gets an
    // honest 'waiting_for_you'), independent of the CRITICAL ordering test
    // right below.
    createTaskManager({ ...managerOpts, ...fakeRunner(), issueExecFn: execFn })

    await until(() => loadTask(project.path, record.id)?.status === 'waiting_for_you')
    expect(readQueue(project.path).entries.map((e) => e.id)).toEqual([])
    const journal = readTaskEvents(project.path, record.id)
    expect(journal.some((e) => e.type === 'issue' && e.data.name === 'edited')).toBe(true)
  })

  // CRITICAL, adversarial review: `startPending()`'s first `context()` call
  // builds a runner whose first `pump()` is SYNCHRONOUS — before the fix,
  // this always won the race against the boot reconciliation pass's very
  // first `await`, deterministically starting a full agent turn on a queued
  // task's STALE ticket, every single time, regardless of forge latency. The
  // fix makes `startPending()` await the whole reconciliation pass first.
  // No `until()` polling here on purpose: if the ordering is right, this is
  // no longer a race to wait out — `startPending()` resolving IS the proof.
  test('startPending() never pumps a queued task whose issue was edited: reconciliation lands first, deterministically', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    writeJsonAtomic(queuePath(project.path), {
      version: 1,
      entries: [{ id: record.id, enqueued_at: new Date().toISOString() }],
    })
    const edited = body.replace(
      'Tickets are launched from the workspace.',
      'Tickets are launched from somewhere else now.',
    )
    const { execFn } = ghIssueRig(edited)
    const rig = fakeRunner()
    const manager = createTaskManager({ ...managerOpts, ...rig, issueExecFn: execFn })

    await manager.startPending()

    expect(loadTask(project.path, record.id)?.status).toBe('waiting_for_you')
    expect(readQueue(project.path).entries.map((e) => e.id)).toEqual([])
    // The deterministic bug this guards against: the fake runner's `start`
    // must never have been called for this record — no agent turn is ever
    // launched on a stale ticket, not even a narrow-window one.
    expect(rig.starts.map((t) => t.id)).not.toContain(record.id)
  })

  test('an unreachable forge at boot leaves the task on its snapshot, journaled, never blocking', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    writeJsonAtomic(queuePath(project.path), {
      version: 1,
      entries: [{ id: record.id, enqueued_at: new Date().toISOString() }],
    })
    const { execFn } = forgeRig(() => ({ kind: 'missing' }))
    createTaskManager({ ...managerOpts, ...fakeRunner(), issueExecFn: execFn })

    await until(() =>
      readTaskEvents(project.path, record.id).some(
        (e) =>
          e.type === 'issue' &&
          e.data.name === 'unreachable' &&
          e.reason_code === 'forge_unreachable',
      ),
    )
    // The task was NEVER dropped from the queue: an unreachable forge is not an edit.
    expect(readQueue(project.path).entries.map((e) => e.id)).toEqual([record.id])
    expect(loadTask(project.path, record.id)?.reason?.code).toBe('forge_unreachable')
  })

  // Round-2 adversarial review, mineur: the test above compares the observed
  // peak against the constant ITSELF, so a mutant widening the cap (6 → 12)
  // would still pass — the test would just be asserting a bigger number
  // against itself. Pin the published value literally so that mutant dies
  // here instead of surviving unnoticed.
  test('the published boot reconciliation concurrency cap is 6', () => {
    expect(BOOT_ISSUE_RECONCILE_CONCURRENCY).toBe(6)
  })

  // Round-5 adversarial review, mineur — the SAME hole, one constant over.
  // Every test of the deadline goes through the `bootIssueReconcileDeadlineMs`
  // seam, so the shipped default was pinned by nothing at all: raising it to
  // 45_000_000 left the whole suite green while the CHANGELOG went on
  // publishing "45 s". Same remedy as its neighbour above: pin the published
  // value literally, so a refactor that pushes the wall to infinity dies here.
  test('the published boot reconciliation deadline is 45s', () => {
    expect(DEFAULT_BOOT_ISSUE_RECONCILE_DEADLINE_MS).toBe(45_000)
  })

  // Majeur 3, adversarial review: an unbounded fan-out opens one subprocess
  // per ticketed task, on the same tick, across every registered project —
  // a real rate-limit hazard. The concurrency-limited pool must never exceed
  // its own published cap, however many tasks boot finds.
  test(`boot never runs more than ${BOOT_ISSUE_RECONCILE_CONCURRENCY} forge calls at once, across every ticketed task combined`, async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const total = BOOT_ISSUE_RECONCILE_CONCURRENCY * 2 + 1
    for (let i = 0; i < total; i += 1) {
      await seedIssueTask(project, body)
    }
    let inFlight = 0
    let peak = 0
    const execFn: ForgeIssuesExecFn = (_cli, _args, _cwd) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      return new Promise((resolveCall) => {
        setTimeout(() => {
          inFlight -= 1
          resolveCall({ kind: 'ok', stdout: ghIssuePayload(body) })
        }, 5)
      })
    }
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner(), issueExecFn: execFn })
    await manager.startPending()
    expect(peak).toBeLessThanOrEqual(BOOT_ISSUE_RECONCILE_CONCURRENCY)
    // Sanity: with `total` well above the cap and a real delay per call, the
    // pool really did run several calls at once rather than accidentally
    // serializing (which would make the bound above trivially true).
    expect(peak).toBeGreaterThan(1)
  })

  // The reload guard (`loadTask` + `isActiveTaskStatus`) that lets boot
  // reconciliation apply its result only at a BOUNDARY — this test fails red
  // if that guard is removed, which is exactly the adversarial review's
  // "two guards ... entirely non-tested" finding.
  test('a task that ships while its own boot reconciliation is still in flight is never reopened', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    writeJsonAtomic(queuePath(project.path), {
      version: 1,
      entries: [{ id: record.id, enqueued_at: new Date().toISOString() }],
    })
    const edited = body.replace(
      'Tickets are launched from the workspace.',
      'Tickets are launched from somewhere else now.',
    )
    let releaseForge: (() => void) | undefined
    const gate = new Promise<void>((resolveGate) => {
      releaseForge = resolveGate
    })
    const execFn: ForgeIssuesExecFn = async (_cli, _args, _cwd) => {
      await gate
      return { kind: 'ok', stdout: ghIssuePayload(edited) }
    }
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner(), issueExecFn: execFn })
    const pending = manager.startPending()

    // While the forge round trip is still gated open, the task ships via a
    // completely different path (e.g. a human's own manual action) — the
    // in-memory closure inside the reconciliation pass is now stale.
    const inFlight = loadTask(project.path, record.id)
    if (!inFlight) {
      throw new Error('fixture setup failed')
    }
    inFlight.status = 'shipped'
    saveTask(project.path, inFlight)

    releaseForge?.()
    await pending

    expect(loadTask(project.path, record.id)?.status).toBe('shipped')
    // The 'edited' outcome must not even have been journaled against a task
    // that is no longer at a boundary.
    const journal = readTaskEvents(project.path, record.id)
    expect(journal.some((e) => e.type === 'issue' && e.data.name === 'edited')).toBe(false)
  })

  // The enumeration filter (`isActiveTaskStatus(record.status)` in the
  // targets loop) — removing it calls the forge for every TERMINAL ticketed
  // task of the whole history, on every boot, which is exactly what majeur 3
  // warns amplifies. Synchronous on purpose: the enumeration loop runs to
  // completion before the pool's first `await`, so this needs no `until()`.
  test('a shipped ticketed task is never probed at boot, even with a stale snapshot', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    const shipped = loadTask(project.path, record.id)
    if (!shipped) {
      throw new Error('fixture setup failed')
    }
    shipped.status = 'shipped'
    saveTask(project.path, shipped)

    // A snapshot the forge would report as 'edited' if it were ever asked —
    // it must simply never be asked.
    const edited = body.replace(
      'Tickets are launched from the workspace.',
      'Tickets are launched from somewhere else now.',
    )
    const { calls, execFn } = ghIssueRig(edited)
    createTaskManager({ ...managerOpts, ...fakeRunner(), issueExecFn: execFn })
    expect(calls).toHaveLength(0)
  })

  // Round-2 adversarial review, majeur 1: reproduced verbatim — a task whose
  // process died mid-turn carries `interrupted_by_user`, posed by the
  // ordinary (non-T2.4) boot recovery. `applyIssueReconcile`'s 'unreachable'
  // branch used to overwrite ANY reason unconditionally; the DP14 erasure
  // logic then cleared what was BY THEN a forge_unreachable IT had posed,
  // losing the real reason for good on the very next boot. Two full boots.
  test('a stale forge_unreachable never overwrites — nor, later, erases — an unrelated reason another mechanism already posed', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    const interrupted = loadTask(project.path, record.id)
    if (!interrupted) {
      throw new Error('fixture setup failed')
    }
    interrupted.status = 'interrupted'
    interrupted.reason = {
      code: 'interrupted_by_user',
      detail: 'orphaned by an earlier session: nothing was queued to start it',
    }
    saveTask(project.path, interrupted)

    // Boot 1: forge unreachable. THIS attempt's own event still names
    // forge_unreachable (a true statement about what just happened) — but
    // the record's persisted reason must survive untouched.
    const { execFn: unreachableExecFn } = forgeRig(() => ({ kind: 'missing' }))
    const boot1 = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      issueExecFn: unreachableExecFn,
    })
    await boot1.startPending()
    expect(loadTask(project.path, record.id)?.reason?.code).toBe('interrupted_by_user')
    expect(
      readTaskEvents(project.path, record.id).some(
        (e) =>
          e.type === 'issue' &&
          e.data.name === 'unreachable' &&
          e.reason_code === 'forge_unreachable',
      ),
    ).toBe(true)

    // Boot 2: forge answers again (same body: 'unchanged'). The erasure
    // logic must never touch a reason it did not itself pose.
    const { execFn: unchangedExecFn } = ghIssueRig(body)
    const boot2 = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      issueExecFn: unchangedExecFn,
    })
    await boot2.startPending()
    expect(loadTask(project.path, record.id)?.reason?.code).toBe('interrupted_by_user')
  })

  // Round-2 adversarial review, majeur 4: `pendingResumeTurn` requires
  // `status === 'interrupted'` — an 'interrupted' record with its last
  // turn's `response === null` IS the Resume affordance. The boot guard used
  // to treat 'interrupted' as a boundary like any other, silently retiring
  // that affordance forever the moment an edit landed.
  test('an interrupted, mid-flight ticketed task keeps its Resume affordance: journaled, status untouched', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    const interrupted = loadTask(project.path, record.id)
    if (!interrupted) {
      throw new Error('fixture setup failed')
    }
    interrupted.status = 'interrupted'
    interrupted.turns.push({
      prompt: 'do work',
      response: null,
      question: null,
      started_at: new Date().toISOString(),
      ended_at: null,
    })
    saveTask(project.path, interrupted)
    expect(pendingResumeTurn(interrupted)).not.toBeNull() // sanity: genuinely resumable

    const edited = body.replace(
      'Tickets are launched from the workspace.',
      'Tickets are launched from somewhere else now.',
    )
    const { execFn } = ghIssueRig(edited)
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner(), issueExecFn: execFn })
    await manager.startPending()

    const fresh = loadTask(project.path, record.id)
    expect(fresh?.status).toBe('interrupted')
    expect(pendingResumeTurn(fresh!)).not.toBeNull()
    const journal = readTaskEvents(project.path, record.id)
    expect(journal.some((e) => e.type === 'issue' && e.data.name === 'edited')).toBe(true)
  })

  // Round-2 adversarial review, majeur 5, four fixes.
  test('a hung forge call degrades to forge_unreachable at the deadline, never blocking startPending() past it', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    writeJsonAtomic(queuePath(project.path), {
      version: 1,
      entries: [{ id: record.id, enqueued_at: new Date().toISOString() }],
    })
    // A forge call that never settles at all — the pathological case a
    // Promise.race against a plain per-call timeout cannot protect against
    // on its own if nothing else bounds it.
    const execFn: ForgeIssuesExecFn = () => new Promise(() => {})
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      issueExecFn: execFn,
      bootIssueReconcileDeadlineMs: 20,
    })
    await manager.startPending()
    expect(loadTask(project.path, record.id)?.reason?.code).toBe('forge_unreachable')
    // 'unreachable' never touches the queue — the task keeps its place in line.
    expect(readQueue(project.path).entries.map((e) => e.id)).toEqual([record.id])
  })

  test('a notice is printed before the wait, naming how many ticketed tasks are being reconciled', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    await seedIssueTask(project, body)
    const notices: string[] = []
    const { execFn } = ghIssueRig(body)
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      issueExecFn: execFn,
      onNotice: (message) => notices.push(message),
    })
    await manager.startPending()
    expect(notices.some((m) => m.includes('reconciling 1 ticketed task'))).toBe(true)
  })

  test('a project with no origin remote skips the forge entirely for every one of its ticketed tasks, at once', async () => {
    // Borrow a realistic issue/issue_snapshot from a repo that DOES have a
    // remote — the shapes are unrelated to which repo they end up saved on.
    const withRemote = register(makeRepoWithRemote())
    const donor = await seedIssueTask(withRemote, conformingTicketBody())
    const donorFresh = loadTask(withRemote.path, donor.id)
    if (!donorFresh?.issue || !donorFresh.issue_snapshot) {
      throw new Error('fixture setup failed')
    }
    // Retire the donor immediately: it exists only to hand over a realistic
    // issue/issue_snapshot shape, and must not itself count as a ticketed
    // task the boot pass below also has to (correctly) reach the forge for.
    donorFresh.status = 'shipped'
    saveTask(withRemote.path, donorFresh)

    const noRemote = register(makeRepo())
    const a = seedTask(noRemote.path, 'no-remote task A')
    const b = seedTask(noRemote.path, 'no-remote task B')
    for (const t of [a, b]) {
      // 'interrupted', not the default 'queued': a bare seedTask() record has
      // no queue.json entry, and the ordinary (unrelated) boot recovery would
      // otherwise flag it as an orphaned 0.12-style record and pose its OWN
      // reason first — exactly what majeur 1's fix then correctly refuses to
      // overwrite, which would make this test assert the wrong thing.
      t.status = 'interrupted'
      t.issue = donorFresh.issue
      t.issue_snapshot = donorFresh.issue_snapshot
      saveTask(noRemote.path, t)
    }

    const { calls, execFn } = forgeRig(() => ({
      kind: 'ok',
      stdout: ghIssuePayload(conformingTicketBody()),
    }))
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner(), issueExecFn: execFn })
    await manager.startPending()

    // No forge call was EVER made for this project: the per-project remote
    // precheck alone skipped both of its ticketed tasks at once.
    expect(calls).toHaveLength(0)
    expect(loadTask(noRemote.path, a.id)?.reason?.code).toBe('forge_unreachable')
    expect(loadTask(noRemote.path, b.id)?.reason?.code).toBe('forge_unreachable')
    // T2.7 round-2 adversarial review, surviving mutant M34: only the CODE
    // was ever pinned here, so the motif on this very line — the one T2.7
    // rewrote through the shared composer, with "this site and
    // forgeIssueReason can no longer drift apart" in its comment — could be
    // changed to any other slug with the whole suite still green. The comment
    // was standing in for the proof.
    expect(loadTask(noRemote.path, a.id)?.reason?.detail).toBe('no-remote')
    expect(loadTask(noRemote.path, b.id)?.reason?.detail).toBe('no-remote')
  })

  /**
   * Borrows a realistic `issue` + `issue_snapshot` from a repo that HAS a
   * remote, then plants it on a task of ANOTHER repo. The shapes are unrelated
   * to which repo they end up saved on, and this is the only way to give a
   * repo a ticketed task without registering it first.
   */
  async function donorIssue(): Promise<{ issue: TaskIssueRef; snapshot: TaskIssueSnapshot }> {
    const withRemote = register(makeRepoWithRemote())
    const donor = await seedIssueTask(withRemote, conformingTicketBody())
    const fresh = loadTask(withRemote.path, donor.id)
    if (!fresh?.issue || !fresh.issue_snapshot) {
      throw new Error('fixture setup failed')
    }
    // Retire it: it exists only to hand over a shape, and must not itself
    // count as a ticketed task the passes below have to reach a forge for.
    fresh.status = 'shipped'
    saveTask(withRemote.path, fresh)
    return { issue: fresh.issue, snapshot: fresh.issue_snapshot }
  }

  /** Plants a 'queued' ticketed task on `repo` (registered or not) and queues it. */
  function plantTicketedTask(
    repo: string,
    origin: { issue: TaskIssueRef; snapshot: TaskIssueSnapshot },
  ): TaskRecord {
    const record = seedTask(repo, 'planted ticketed task')
    record.issue = origin.issue
    record.issue_snapshot = origin.snapshot
    record.status = 'queued'
    saveTask(repo, record)
    writeJsonAtomic(queuePath(repo), {
      version: 1,
      entries: [{ id: record.id, enqueued_at: new Date().toISOString() }],
    })
    return record
  }

  // Round-4 adversarial review, MAJEUR 2. `sanitizeIssueSnapshot` drops the
  // WHOLE snapshot when `body_hash` carries a tag this build does not produce
  // — which is exactly what the previous revision of this very branch wrote
  // (`sha256:t1:`), and what any future bump of TICKET_BODY_HASH_TAG will do
  // to every already-bound task. `TaskRecord.issue` survives that drop, so the
  // task keeps claiming it carries a ticket while both recomparison points
  // skip it forever on their `!record.issue_snapshot` guard, and the first
  // rewrite of the record erases the snapshot from disk. That was total,
  // permanent silence; invariant 2 forbids it.
  test('a snapshot tagged for a scheme this build no longer produces is NAMED, not silently dropped', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    writeJsonAtomic(queuePath(project.path), {
      version: 1,
      entries: [{ id: record.id, enqueued_at: new Date().toISOString() }],
    })
    // Rewrite task.json with the PREVIOUS tag, byte for byte what the earlier
    // revision of this branch persisted.
    const raw = JSON.parse(
      readFileSync(join(taskDir(project.path, record.id), 'task.json'), 'utf8'),
    ) as {
      issue_snapshot: { body_hash: string }
    }
    raw.issue_snapshot.body_hash = raw.issue_snapshot.body_hash.replace(
      `${TICKET_BODY_HASH_TAG}:`,
      'sha256:t1:',
    )
    writeJsonAtomic(join(taskDir(project.path, record.id), 'task.json'), raw)
    // Precondition: the sanitizer really does drop the whole snapshot while
    // keeping `issue` — the exact asymmetry this test exists for.
    expect(loadTask(project.path, record.id)?.issue).toBeTruthy()
    expect(loadTask(project.path, record.id)?.issue_snapshot).toBeUndefined()

    const notices: string[] = []
    const { calls, execFn } = ghIssueRig(body)
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      issueExecFn: execFn,
      onNotice: (message) => notices.push(message),
    })
    await manager.startPending()

    const journal = readTaskEvents(project.path, record.id)
    expect(journal.some((e) => e.type === 'issue' && e.data.name === 'snapshot_unreadable')).toBe(
      true,
    )
    expect(notices.some((m) => m.includes(record.id) && m.includes('edit detection'))).toBe(true)
    // DP10 holds: no eleventh D2 code, and nothing is stopped — the task keeps
    // its status and its place, it is only the edit detector that retired.
    expect(loadTask(project.path, record.id)?.reason).toBeUndefined()
    expect(loadTask(project.path, record.id)?.status).toBe('queued')
    // And no forge call was made for it: there is nothing to compare against.
    expect(calls).toHaveLength(0)
  })

  // Round-4 adversarial review, MINEUR 1: `canPoseReason` is a TWO-part
  // condition and only its first half (`!record.reason`) was covered. Dropping
  // `|| code === 'forge_unreachable'` left every test green while a SECOND
  // forge failure stopped refreshing the detail — the journal would keep
  // showing "no-remote" once the real cause had become "deadline exceeded" —
  // and `mutated` went false, so neither saveTask nor the broadcast happened.
  test('a second forge failure REFRESHES the forge_unreachable detail it posed itself', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)
    writeJsonAtomic(queuePath(project.path), {
      version: 1,
      entries: [{ id: record.id, enqueued_at: new Date().toISOString() }],
    })

    // First pass: no forge CLI answers at all.
    const { execFn: noCli } = forgeRig(() => ({ kind: 'missing' }))
    await createTaskManager({ ...managerOpts, ...fakeRunner(), issueExecFn: noCli }).startPending()
    const first = loadTask(project.path, record.id)?.reason
    expect(first?.code).toBe('forge_unreachable')
    expect(first?.detail).toBe('no-cli')

    // Second pass, SAME record, different cause: the hard deadline.
    const hangs: ForgeIssuesExecFn = () => new Promise(() => {})
    await createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      issueExecFn: hangs,
      bootIssueReconcileDeadlineMs: 20,
    }).startPending()

    const second = loadTask(project.path, record.id)?.reason
    expect(second?.code).toBe('forge_unreachable')
    expect(second?.detail).toContain('deadline')
    // T2.7 round-2 adversarial review, mineur 6: the motif leads, here as
    // everywhere else. `timed-out` and not `cli-error`: we stopped waiting,
    // which says nothing about the forge's own health.
    expect(second?.detail?.startsWith('timed-out: ')).toBe(true)
    // The stale cause is gone from the persisted record, not merely shadowed.
    expect(second?.detail).not.toContain('no-cli')
  })

  // Round-4 adversarial review, MINEUR 2: `applyUnreachableAt`'s own shutdown
  // guard was dead weight in the suite — the only aborted-signal test used a
  // repo WITH a remote, which reaches it through the worker, and the worker
  // checks the signal itself first. The no-remote path calls it DIRECTLY, with
  // no check in front of it: this is the one door that proves the guard.
  test('an already-aborted shutdown signal blocks the no-remote degradation too, before any write', async () => {
    const origin = await donorIssue()
    const noRemote = register(makeRepo())
    const record = plantTicketedTask(noRemote.path, origin)

    const controller = new AbortController()
    controller.abort()
    const { calls, execFn } = forgeRig(() => ({ kind: 'missing' }))
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      issueExecFn: execFn,
      shutdownSignal: controller.signal,
    })
    await manager.startPending()

    expect(calls).toHaveLength(0)
    const after = loadTask(noRemote.path, record.id)
    expect(after?.reason).toBeUndefined()
    expect(readTaskEvents(noRemote.path, record.id)).toHaveLength(0)
  })

  test('an already-aborted shutdown signal stops the T2.4 boot pass from writing anything', async () => {
    const project = register(makeRepoWithRemote())
    const body = conformingTicketBody()
    const record = await seedIssueTask(project, body)

    const edited = body.replace(
      'Tickets are launched from the workspace.',
      'Tickets are launched from somewhere else now.',
    )
    const { execFn } = ghIssueRig(edited)
    const controller = new AbortController()
    controller.abort()
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      issueExecFn: execFn,
      shutdownSignal: controller.signal,
    })
    await manager.startPending()

    // The T2.4 pass itself never wrote anything: no forge_unreachable reason
    // posed, and no reconciliation-caused 'issue' event beyond admission's
    // own 'bound' — whatever the ordinary (unrelated) boot recovery for a
    // 'running' record left by a dead process independently produces (this
    // signal does not gate that mechanism, and it is not this test's
    // concern).
    const after = loadTask(project.path, record.id)
    expect(after?.reason?.code).not.toBe('forge_unreachable')
    const reconcileEvents = readTaskEvents(project.path, record.id).filter(
      (e) => e.type === 'issue' && e.data.name !== 'bound',
    )
    expect(reconcileEvents).toHaveLength(0)
  })

  // Round-4 adversarial review, MAJEUR 3 — the round-1 critique through a
  // SECOND door. `startPending()` awaits the boot pass, which closes the door
  // for every project registered when the manager was built. A project
  // registered LATER never went through it: any human gesture on it builds its
  // context, `context()` rebuilds its queue from queue.json BEFORE the runner
  // exists, and the runner's first `pump()` is SYNCHRONOUS — so a full agent
  // turn starts on a stale ticket, deterministically, and its work is then
  // thrown away without a review ('edited' skips it).
  //
  // Both tests below use the REAL runner and a REAL agent seam: a fakeRunner
  // cannot show a pump that should not have happened.
  describe('a project registered mid-session', () => {
    /** Real manager + real runner; counts every agent invocation. */
    function realManager(
      issueExecFn: ForgeIssuesExecFn,
      onNotice?: (message: string) => void,
    ): { manager: TaskManager; invocations: () => number } {
      let invocations = 0
      const manager = createTaskManager({
        command: 'claude -p',
        timeoutMs: 5000,
        issueExecFn,
        ...(onNotice ? { onNotice } : {}),
        runAgentFn: async (options: AgentRunOptions) => {
          invocations += 1
          const raw = `${JSON.stringify({ type: 'result', result: 'done' })}\n`
          options.onText?.(raw)
          return raw
        },
      })
      return { manager, invocations: () => invocations }
    }

    test('never starts a turn on its ticketed task before this session compared it to the forge', async () => {
      const body = conformingTicketBody()
      const origin = await donorIssue()
      // Prepared on disk, deliberately NOT registered: it must be invisible to
      // the boot pass's synchronous enumeration.
      const late = makeRepoWithRemote()
      const record = plantTicketedTask(late, origin)

      register(makeRepo()) // an ordinary project, so the boot pass has work
      const edited = body.replace(
        'Tickets are launched from the workspace.',
        'Tickets are launched from somewhere else now.',
      )
      const notices: string[] = []
      const { manager, invocations } = realManager(ghIssueRig(edited).execFn, (message) =>
        notices.push(message),
      )
      await manager.startPending()

      // NOW it joins the workspace, and a human gesture builds its context.
      const lateProject = register(late)
      manager.checks(lateProject.id, 'aaaaaaaaaaaa')

      await until(() => loadTask(late, record.id)?.status === 'waiting_for_you')
      // The whole point: not one agent turn ran on the stale ticket.
      expect(invocations()).toBe(0)
      expect(readQueue(late).entries.map((e) => e.id)).toEqual([])
      expect(
        readTaskEvents(late, record.id).some((e) => e.type === 'issue' && e.data.name === 'edited'),
      ).toBe(true)
      // Invariant 2: the hold is SAID, never a queue that silently stops.
      expect(notices.some((m) => m.includes('held out of the queue'))).toBe(true)
      await manager.shutdown()
    })

    test('and starts it as soon as that comparison says the ticket did not move', async () => {
      const body = conformingTicketBody()
      const origin = await donorIssue()
      const late = makeRepoWithRemote()
      const record = plantTicketedTask(late, origin)

      register(makeRepo())
      // Same body: 'unchanged'. The hold must be a DELAY, not a deadlock —
      // nothing else in the process would ever pump this queue again.
      const { manager, invocations } = realManager(ghIssueRig(body).execFn)
      await manager.startPending()

      const lateProject = register(late)
      manager.checks(lateProject.id, 'aaaaaaaaaaaa')

      await until(() => invocations() > 0, 8000)
      expect(loadTask(late, record.id)?.status).not.toBe('queued')
      await manager.shutdown()
    })

    // Round-5 adversarial review, mineur. "Put back AT ITS ORIGINAL RANK" is
    // why `holdTicketedTasks` remembers the WHOLE pre-hold order rather than
    // just the ids it lifted — and reversing that remembered order left every
    // test green, because the two above queue exactly ONE task each and
    // reversing a one-element list is a no-op. Three in line, the ticketed one
    // in the MIDDLE, is the shape that can tell the rule from its absence.
    test('the held ticketed task goes back at its ORIGINAL rank, not at the tail', async () => {
      const body = conformingTicketBody()
      const origin = await donorIssue()
      const late = makeRepoWithRemote()
      const plainA = seedTask(late, 'plain A')
      plainA.status = 'queued'
      saveTask(late, plainA)
      const ticketed = plantTicketedTask(late, origin)
      const plainC = seedTask(late, 'plain C')
      plainC.status = 'queued'
      saveTask(late, plainC)
      writeJsonAtomic(queuePath(late), {
        version: 1,
        entries: [plainA, ticketed, plainC].map((task) => ({
          id: task.id,
          enqueued_at: new Date().toISOString(),
        })),
      })

      register(makeRepo()) // an ordinary project, so the boot pass has work
      const rig = fakeRunner()
      const manager = createTaskManager({
        ...managerOpts,
        ...rig,
        // Same body: 'unchanged', so the hold is released rather than turning
        // into a status change that would remove tasks from the line.
        issueExecFn: ghIssueRig(body).execFn,
      })
      await manager.startPending()

      const lateProject = register(late)
      manager.checks(lateProject.id, 'aaaaaaaaaaaa')

      // The rebuild enqueues every id but the LAST, which goes to
      // `runner.start()` instead — that is the only gesture that both puts a
      // task at the tail and pumps. Read as one line, queue-then-started IS
      // the restored order.
      await until(() => rig.starts.length > 0)
      const restored = [
        ...readQueue(late).entries.map((entry) => entry.id),
        ...rig.starts.map((task) => task.id),
      ]
      expect(restored).toEqual([plainA.id, ticketed.id, plainC.id])
      // Nothing was dropped or re-ranked on the way, and the held one is
      // still just waiting: the hold is a DELAY, never a status change.
      expect(loadTask(late, ticketed.id)?.status).toBe('queued')
      await manager.shutdown()
    })
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
      // T2.6: the dry-run answers 501 like its twin, and for the same reason.
      expect(
        (await rawRequest(started.port, '/api/tasks/preview', { method: 'POST', body: '{}' }))
          .status,
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
    let sessionAgent = 'claude -p'
    const stubPlan: TaskPlan = {
      mode: 'fork',
      repo: project.path,
      title: 'stubbed task',
      branch: 'codesema/task-stubbed-task',
      branch_certain: true,
      worktree_root: `${project.path}/.codesema/worktrees`,
      base: 'main',
      target: 'main',
      isolation: 'policy',
      isolation_reason: 'stub',
      agent: 'claude -p',
      queue_position: null,
      issue: null,
      auto_ship: false,
    }
    const calls = {
      creates: [] as string[],
      createInputs: [] as unknown[],
      previews: [] as string[],
      previewInputs: [] as unknown[],
      replies: [] as { project: string; id: string; message: string }[],
      ships: [] as string[],
      abandons: [] as string[],
      checksStarts: [] as string[],
      checksSetups: [] as string[],
      attaches: [] as { projectId: string; taskId: string; repoProjectId: string }[],
      checksApplies: [] as string[],
      resumes: [] as { project: string; id: string }[],
    }
    const known = (projectId: string) => projectId === project.id
    const manager: TaskManager = {
      list: (projectId) => (known(projectId) ? [record] : null),
      listAll: () => [{ project, records: [record] }],
      get: (projectId, id) =>
        known(projectId) && id === record.id ? { record, events: [] } : null,
      preview: async (projectId, input) => {
        if (!known(projectId)) {
          return { ok: false, code: 404, error: 'unknown project' }
        }
        calls.previews.push(projectId)
        calls.previewInputs.push(input)
        return { ok: true, plan: stubPlan }
      },
      create: async (projectId, input) => {
        if (!known(projectId)) {
          return { ok: false, code: 404, error: 'unknown project' }
        }
        calls.creates.push(projectId)
        calls.createInputs.push(input)
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
      getVerification: () => null,
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
        agent: sessionAgent,
      }),
      startPending: () => Promise.resolve([]),
      sweepOrphanedVolumes: async () => {},
      sweepOrphanedSandboxes: async () => {},
      applyRetention: async () => {},
      attach: (projectId, taskId, repoProjectId) => {
        if (!known(projectId)) {
          return Promise.resolve({ ok: false as const, code: 404, error: 'unknown project' })
        }
        calls.attaches.push({ projectId, taskId, repoProjectId })
        return Promise.resolve({ ok: true as const })
      },
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
      defaultCommand: () => sessionAgent,
      setDefaultCommand: (command) => {
        sessionAgent = command
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

      const unknownAgent = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': token },
        body: JSON.stringify({
          project_id: project.id,
          title: 't',
          prompt: 'p',
          agent: 'my-agent run',
        }),
      })
      expect(unknownAgent.status).toBe(400)
      expect(calls.creates).toEqual([project.id])

      const byId = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': token },
        body: JSON.stringify({
          project_id: project.id,
          title: 't',
          prompt: 'p',
          agent: 'opencode',
        }),
      })
      expect(byId.status).toBe(201)
      expect((calls.createInputs.at(-1) as { agent?: string }).agent).toBe('opencode run')

      const byCommand = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': token },
        body: JSON.stringify({
          project_id: project.id,
          title: 't',
          prompt: 'p',
          agent: 'opencode run',
        }),
      })
      expect(byCommand.status).toBe(201)
      expect((calls.createInputs.at(-1) as { agent?: string }).agent).toBe('opencode run')

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
      expect(calls.creates).toEqual([project.id, project.id, project.id])

      // T2.4: `issue` is an alternative to title/prompt, reaching the manager verbatim
      // as `unknown` — validation is entirely task-issue.ts's job, not serve.ts's.
      const fromIssue = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': token },
        body: JSON.stringify({
          project_id: project.id,
          issue: { forge: 'github', project: 'acme/repo', iid: 42, url: 'https://x/42' },
        }),
      })
      expect(fromIssue.status).toBe(201)
      const lastInput = calls.createInputs.at(-1) as Record<string, unknown>
      expect(lastInput.title).toBeUndefined()
      expect(lastInput.prompt).toBeUndefined()
      expect(lastInput.issue).toEqual({
        forge: 'github',
        project: 'acme/repo',
        iid: 42,
        url: 'https://x/42',
      })

      // Neither title/prompt NOR issue: refused before the manager is reached.
      const neither = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': token },
        body: JSON.stringify({ project_id: project.id }),
      })
      expect(neither.status).toBe(400)
      expect(calls.creates).toEqual([project.id, project.id, project.id, project.id])

      // issue must be an object, not an array or a scalar.
      const issueIsArray = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': token },
        body: JSON.stringify({ project_id: project.id, issue: [] }),
      })
      expect(issueIsArray.status).toBe(400)

      // DNS-rebinding guard stays active on every task route.
      const rebound = await rawRequest(started.port, `/api/tasks?project=${project.id}`, {
        headers: { host: 'evil.com' },
      })
      expect(rebound.status).toBe(403)
    } finally {
      await started.stop()
    }
  })

  test('GET /api/config includes agent + agents, and PUT /api/config/agent updates it', async () => {
    const project = register(makeRepo())
    const { manager } = stubManager(project)
    const started = await startServer(createSession(), {
      cwd: project.path,
      port: 5122,
      taskManager: manager,
    })
    try {
      const html = await rawRequest(started.port, '/')
      const tokenMatch = /__CODESEMA_CONFIG_TOKEN__="([a-f0-9]{32})"/.exec(html.body)
      expect(tokenMatch).not.toBeNull()
      const token = tokenMatch![1]!

      const initial = await rawRequest(started.port, '/api/config')
      expect(initial.status).toBe(200)
      const snapshot = JSON.parse(initial.body) as {
        agent?: string
        model?: string
        effort?: string
        agents?: {
          id: string
          label: string
          bin: string
          command: string
          detected: boolean
          models: string[]
          efforts: string[]
        }[]
      }
      expect(snapshot.agent).toBe('claude -p')
      expect(snapshot.model).toBe('')
      expect(snapshot.effort).toBe('')
      expect(Array.isArray(snapshot.agents)).toBe(true)
      expect(
        snapshot.agents?.some((a) => a.id === 'opencode' && a.command === 'opencode run'),
      ).toBe(true)
      expect(snapshot.agents?.every((a) => typeof a.detected === 'boolean')).toBe(true)
      // The picker needs a model list and the effort levels per agent.
      const claudeOption = snapshot.agents?.find((a) => a.id === 'claude')
      expect(claudeOption?.models).toContain('opus')
      expect(claudeOption?.efforts).toContain('xhigh')
      expect(snapshot.agents?.find((a) => a.id === 'gemini')?.efforts).toEqual([])

      const forbidden = await rawRequest(started.port, '/api/config/agent', {
        method: 'PUT',
        body: '{"agent":"opencode"}',
      })
      expect(forbidden.status).toBe(403)

      const unknown = await rawRequest(started.port, '/api/config/agent', {
        method: 'PUT',
        headers: { 'x-codesema-config-token': token },
        body: '{"agent":"my-agent run"}',
      })
      expect(unknown.status).toBe(400)

      const updated = await rawRequest(started.port, '/api/config/agent', {
        method: 'PUT',
        headers: { 'x-codesema-config-token': token },
        body: '{"agent":"opencode"}',
      })
      expect(updated.status).toBe(200)
      expect(JSON.parse(updated.body)).toEqual({
        ok: true,
        agent: 'opencode run',
        model: '',
        effort: '',
      })

      const after = await rawRequest(started.port, '/api/config')
      expect(JSON.parse(after.body).agent).toBe('opencode run')

      const modeled = await rawRequest(started.port, '/api/config/agent', {
        method: 'PUT',
        headers: { 'x-codesema-config-token': token },
        body: '{"agent":"opencode","model":"openrouter/anthropic/claude-sonnet-4"}',
      })
      expect(modeled.status).toBe(200)
      expect(JSON.parse(modeled.body)).toEqual({
        ok: true,
        agent: 'opencode run -m openrouter/anthropic/claude-sonnet-4',
        model: 'openrouter/anthropic/claude-sonnet-4',
        effort: '',
      })
      expect(loadGlobalConfig()).toMatchObject({
        agent: 'opencode run -m openrouter/anthropic/claude-sonnet-4',
        agentId: 'opencode',
        model: 'openrouter/anthropic/claude-sonnet-4',
      })
      const overlaid = JSON.parse((await rawRequest(started.port, '/api/config')).body) as {
        agent?: string
        agents?: { id: string; command: string }[]
      }
      expect(overlaid.agent).toBe('opencode run -m openrouter/anthropic/claude-sonnet-4')
      expect(overlaid.agents?.find((a) => a.id === 'opencode')?.command).toBe(
        'opencode run -m openrouter/anthropic/claude-sonnet-4',
      )
      expect(overlaid.agents?.find((a) => a.id === 'claude')?.command).toBe('claude -p')

      const withEffort = await rawRequest(started.port, '/api/config/agent', {
        method: 'PUT',
        headers: { 'x-codesema-config-token': token },
        body: '{"agent":"opencode","model":"openrouter/anthropic/claude-sonnet-4","effort":"high"}',
      })
      expect(JSON.parse(withEffort.body)).toEqual({
        ok: true,
        agent: 'opencode run -m openrouter/anthropic/claude-sonnet-4 --variant high',
        model: 'openrouter/anthropic/claude-sonnet-4',
        effort: 'high',
      })
      const readBack = JSON.parse((await rawRequest(started.port, '/api/config')).body) as {
        model?: string
        effort?: string
      }
      expect(readBack.model).toBe('openrouter/anthropic/claude-sonnet-4')
      expect(readBack.effort).toBe('high')

      const cleared = await rawRequest(started.port, '/api/config/agent', {
        method: 'PUT',
        headers: { 'x-codesema-config-token': token },
        body: '{"agent":"opencode","model":"","effort":""}',
      })
      expect(JSON.parse(cleared.body)).toEqual({
        ok: true,
        agent: 'opencode run',
        model: '',
        effort: '',
      })
      expect(loadGlobalConfig().model).toBeUndefined()
      expect(loadGlobalConfig().effort).toBeUndefined()
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

  test('ship 409 forwards reason_code next to the readable error (T3.1 checks in flight)', async () => {
    const project = register(makeRepo())
    const base = stubManager(project)
    const manager: TaskManager = {
      ...base.manager,
      ship: async () => ({
        ok: false as const,
        code: 409,
        error: 'checks are still running',
        reason_code: 'resource_busy' as const,
      }),
    }
    const started = await startServer(createSession(), {
      cwd: project.path,
      port: 5142,
      taskManager: manager,
    })
    try {
      const token = await tasksToken(started.port)
      const ship = await rawRequest(
        started.port,
        `/api/tasks/${base.record.id}/ship?project=${project.id}`,
        { method: 'POST', headers: { 'x-codesema-tasks-token': token } },
      )
      expect(ship.status).toBe(409)
      expect(JSON.parse(ship.body)).toEqual({
        error: 'checks are still running',
        reason_code: 'resource_busy',
      })
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
  // T1.4 review round 6, MAJEUR B2. The wiring of `workspaceInfo` on the REAL
  // route was pinned by a single project with no config of its own, so both
  // halves of the per-project overlay survived mutation with the suite green:
  // `workspaceInfo(project.id)` -> `workspaceInfo(tasks.currentProjectId)`
  // (every registry entry then reports the CURRENT project's cage) and
  // `workspaceInfo(tasks.currentProjectId)` -> `workspaceInfo()` (the blob
  // then reports the process-wide fallback rather than the current project).
  // Two projects that DISAGREE are what tells the three apart.
  test('GET /api/projects gives each project ITS own isolation, and the blob the current one (T1.4)', async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    // A is the launch/current repo and opted out of the cage; B did not.
    saveRepoConfig(repoA, { isolation: 'policy' })
    saveRepoConfig(repoB, { isolation: 'auto' })
    const current = register(repoA)
    const sibling = register(repoB)
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      command: 'claude -p',
      isolation: {
        available: true,
        mode: 'container',
        reason: 'podman is available',
        configured: 'auto',
        runtime: 'podman',
      },
    })
    const started = await startServer(createSession(), {
      cwd: current.path,
      port: 5162,
      taskManager: manager,
      currentProjectId: current.id,
    })
    try {
      const body = JSON.parse((await rawRequest(started.port, '/api/projects')).body) as {
        current: string
        workspace: { isolation_available: boolean; isolation_configured: string }
        projects: {
          id: string
          isolation: { isolation_available: boolean; isolation_configured: string }
        }[]
      }
      const byId = new Map(body.projects.map((project) => [project.id, project.isolation]))
      expect(byId.get(current.id)).toMatchObject({
        isolation_available: false,
        isolation_configured: 'policy',
        agent: 'claude -p',
      })
      // The sibling really is caged, and saying otherwise to the UI is an
      // under-claim of containment on one card and an over-claim on the other.
      expect(byId.get(sibling.id)).toMatchObject({
        isolation_available: true,
        isolation_configured: 'auto',
      })
      // ...and the process-wide blob follows the CURRENT project, not the
      // global fallback (which, here, would claim the cage is on).
      expect(body.workspace).toMatchObject({
        isolation_available: false,
        isolation_configured: 'policy',
      })
    } finally {
      await started.stop()
    }
  })

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
      // `makeRepo()` builds a repo with NO remote, so both blobs carry D9's
      // forge verdict for it — and, since nothing probed a forge CLI here,
      // `no-remote` is the motif either way (it wins over the machine probe,
      // like the forge client's own ladder decides it).
      const forgeFacts = { forge_available: false, forge_reason: 'no-remote' }
      const scratch = scratchProject()
      expect(JSON.parse(initial.body)).toEqual({
        current: current.id,
        workspace: {
          isolation_available: false,
          isolation_default: 'policy',
          isolation_reason: 'container isolation was not probed',
          isolation_configured: 'policy',
          agent: 'claude -p',
          ...forgeFacts,
        },
        projects: [
          // The scratch project leads the list and carries NO forge verdict:
          // it has no repository, so `forgeRemote` answers 'unknown' rather
          // than the 'no-remote' a remote-less repo earns.
          {
            id: scratch.id,
            path: scratch.path,
            name: scratch.name,
            kind: 'scratch',
            added_at: scratch.added_at,
            isolation: {
              isolation_available: false,
              isolation_default: 'policy',
              isolation_reason: 'container isolation was not probed',
              isolation_configured: 'policy',
              agent: 'claude -p',
            },
          },
          {
            id: current.id,
            path: current.path,
            name: current.name,
            kind: 'repo',
            added_at: current.added_at,
            isolation: {
              isolation_available: false,
              isolation_default: 'policy',
              isolation_reason: 'container isolation was not probed',
              isolation_configured: 'policy',
              agent: 'claude -p',
              ...forgeFacts,
            },
          },
        ],
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

    const first = await manager.create(projectA.id, {
      title: 'A',
      prompt: 'task one',
      autoShip: false,
    })
    const second = await manager.create(projectB.id, {
      title: 'B',
      prompt: 'task two',
      autoShip: false,
    })
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

    const created = await manager.create(projectB.id, {
      title: 'B',
      prompt: 'task b',
      autoShip: false,
    })
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

    const created = await Promise.all(
      projects.map((project, i) =>
        manager.create(project.id, { title: `p${i}`, prompt: `work ${i}`, autoShip: false }),
      ),
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

    const created = await manager.create(projectB.id, {
      title: 'B',
      prompt: 'work',
      autoShip: false,
    })
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

    const first = await manager.create(project.id, {
      title: 'A',
      prompt: 'task one',
      autoShip: false,
    })
    const second = await manager.create(project.id, {
      title: 'B',
      prompt: 'task two',
      autoShip: false,
    })
    const third = await manager.create(project.id, {
      title: 'C',
      prompt: 'task three',
      autoShip: false,
    })
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
    const first = await dying.create(project.id, {
      title: 'A',
      prompt: 'task one',
      autoShip: false,
    })
    const second = await dying.create(project.id, {
      title: 'B',
      prompt: 'task two',
      autoShip: false,
    })
    const third = await dying.create(project.id, {
      title: 'C',
      prompt: 'task three',
      autoShip: false,
    })
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
    const resumed = await reborn.startPending()
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

    const first = await manager.create(project.id, {
      title: 'A',
      prompt: 'task one',
      autoShip: false,
    })
    const second = await manager.create(project.id, {
      title: 'B',
      prompt: 'task two',
      autoShip: false,
    })
    const third = await manager.create(project.id, {
      title: 'C',
      prompt: 'task three',
      autoShip: false,
    })
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
    const head = await manager.create(project.id, { title: 'A', prompt: 'one', autoShip: false })
    expect(head.ok).toBe(true)
    await until(() => manager.list(project.id)?.some((r) => r.status === 'running') === true)

    const second = await manager.create(project.id, { title: 'B', prompt: 'two', autoShip: false })
    expect(second.ok).toBe(true)
    if (!second.ok) {
      return
    }
    const afterSecond = queuedFrames.length
    const third = await manager.create(project.id, { title: 'C', prompt: 'three', autoShip: false })
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
      expect(
        (await manager.create(project.id, { title: `f${n}`, prompt: 'x', autoShip: false })).ok,
      ).toBe(true)
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
  test('a creation the queue refuses leaves no zombie: the record is settled, named and abandonable', async () => {
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
    expect(
      (await manager.create(project.id, { title: 'seed', prompt: 'seed', autoShip: false })).ok,
    ).toBe(true)
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

    const refused = await manager.create(project.id, {
      title: 'A',
      prompt: 'work',
      autoShip: false,
    })
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
  test('a subscriber that throws is contained AND reported, never swallowed', async () => {
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

    const created = await manager.create(project.id, {
      title: 'A',
      prompt: 'work',
      autoShip: false,
    })
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
    const made = await Promise.all(
      ['a', 'b', 'c', 'd'].map(async (title) => {
        const created = await manager.create(project.id, { title, prompt: title, autoShip: false })
        expect(created.ok).toBe(true)
        if (!created.ok) {
          throw new Error('creation refused')
        }
        return created.record
      }),
    )
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
    expect(await manager.startPending()).toEqual([])
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

    const created = await manager.create(project.id, {
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
      // T2.5: a task launched without criteria journals the unreadable
      // turn-1 draft and continues — the ship still chains on review_ok.
      { type: 'criteria', data: { name: 'draft_unparsed' } },
      { type: 'message' },
      { type: 'shipped', data: { mr_url: 'https://github.com/o/r/pull/3' } },
      // T3.6: the merge step chains on the ship and journals D12's four
      // conditions ONE BY ONE, satisfied or not — which is the whole point:
      // "checked and it passed" has to be distinguishable from "never
      // checked". This manager carries no `mergeSettings`, so the default
      // `human` policy applies and NOTHING is merged, whatever the verdicts.
      { type: 'merge', data: { name: 'condition_unmet', condition: 'review' } },
      { type: 'merge', data: { name: 'condition_unmet', condition: 'checks', detail: 'no_run' } },
      {
        type: 'merge',
        data: { name: 'condition_unmet', condition: 'criteria', detail: 'absent' },
      },
      { type: 'merge', data: { name: 'condition_met', condition: 'branch' } },
      { type: 'merge', data: { name: 'policy_human', ready: false } },
    ])
    // ...and the default policy moved no status: the task is `shipped`, not
    // handed back to a human over a merge nobody asked for.
    expect(loadTask(repo, created.record.id)?.status).toBe('shipped')
    expect(loadTask(repo, created.record.id)?.reason).toBeUndefined()
  })

  test('T3.6: mergePolicy auto merges a green task, and the status stays shipped', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const runAgentFn = async (options: AgentRunOptions): Promise<string> => {
      const raw = claudeStream('all done')
      options.onText?.(raw)
      return raw
    }
    const mergeCalls: string[] = []
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn,
      reviewTurnFn: async (record, io) => {
        record.status = 'review_ok'
        io.persist()
        return Promise.resolve()
      },
      shipTaskFn: () =>
        Promise.resolve({ pushed: true, mrUrl: 'https://github.com/o/r/pull/9', note: null }),
      mergeSettings: { policy: 'auto', deleteBranch: false, allowMergeWithoutChecks: false },
      // The gate itself is proven in task-merge.test.ts; what this test proves
      // is the WIRING — that the step runs after the ship, on the record as it
      // stands on DISK, and that a landed merge moves no status.
      mergeTaskFn: (options) => {
        mergeCalls.push(options.task.id)
        expect(options.task.status).toBe('shipped')
        expect(options.settings.policy).toBe('auto')
        return Promise.resolve({
          kind: 'merged',
          cli: 'gh',
          url: 'https://github.com/o/r/pull/9',
          readiness: { ready: true, conditions: [], blockers: [] },
          events: [{ type: 'merge', data: { name: 'merged', cli: 'gh' } }],
        })
      },
    })

    const created = await manager.create(project.id, {
      title: 'Night shift',
      prompt: 'do it while I sleep',
      autoShip: true,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }
    await until(() =>
      readTaskEvents(repo, created.record.id).some((event) => event.type === 'merge'),
    )
    expect(mergeCalls).toEqual([created.record.id])
    const record = loadTask(repo, created.record.id)
    expect(record?.status).toBe('shipped')
    expect(record?.reason).toBeUndefined()
  })

  test('T3.6: a refused merge hands the task back with its reason, and the 409 says why', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const runAgentFn = async (options: AgentRunOptions): Promise<string> => {
      const raw = claudeStream('all done')
      options.onText?.(raw)
      return raw
    }
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn,
      reviewTurnFn: async (record, io) => {
        record.status = 'review_ok'
        io.persist()
        return Promise.resolve()
      },
      shipTaskFn: () => Promise.resolve({ pushed: true, mrUrl: null, note: null }),
      // The REAL gate under `auto`: this task has no criteria and no archived
      // review, so it is refused long before any forge CLI is reached — which
      // is exactly why no exec seam is needed here.
      mergeSettings: { policy: 'auto', deleteBranch: false, allowMergeWithoutChecks: false },
    })

    const created = await manager.create(project.id, {
      title: 'Night shift',
      prompt: 'do it while I sleep',
      autoShip: true,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }
    // Waited on the merge gate's own line, not on the status: a wait on the
    // status turns every regression of the transition below into a TIMEOUT,
    // which is indistinguishable from a slow machine. The `refused` line is
    // written first and unconditionally, so what follows is an assertion.
    await until(() =>
      readTaskEvents(repo, created.record.id).some(
        (event) => event.type === 'merge' && event.data.name === 'refused',
      ),
    )
    const record = loadTask(repo, created.record.id)
    expect(record?.status).toBe('waiting_for_you')
    expect(record?.reason?.code).toBe('review_blocked')
    expect(isTerminalReason(record!.reason!.code)).toBe(true)
    const names = readTaskEvents(repo, created.record.id)
      .filter((event) => event.type === 'merge')
      .map((event) => event.data.name)
    // Four conditions, one line each, then the refusal.
    expect(names).toEqual([
      'condition_unmet',
      'condition_unmet',
      'condition_unmet',
      'condition_met',
      'refused',
    ])
    // ...and the dead end T3.3 left behind is closed: the 409 names WHY.
    const refusal = await manager.ship(project.id, created.record.id)
    expect(refusal.ok).toBe(false)
    expect(refusal.ok === false && refusal.code).toBe(409)
    expect(refusal.ok === false && refusal.error).toContain('no end-of-turn review is archived')
    expect(refusal.ok === false && refusal.reason_code).toBe('review_blocked')
  })

  // T3.6 adversarial review, MAJEUR 3. `specs/auto-merge/spec.md` requires it
  // in those words — "Conflit de merge sans résolution automatique — DOIT
  // produire la raison `merge_conflict` et faire passer la tâche en attente
  // humaine" — and NOTHING held it: deleting `|| outcome.kind === 'failed'`
  // from `runMergeStep`'s transition left 3 069 tests green. task-merge.test.ts
  // proves the gate returns `failed`/`merge_conflict`; the STATUS is
  // task-server.ts's own work, and the only server test under `auto` either
  // returned `merged` or went through the real refusal path.
  //
  // With the mutant, a conflict leaves the task on `shipped`, with no reason
  // and no "needs you" — the most consequential failure mode of the ticket,
  // entirely unguarded.
  test('T3.6: a merge the FORGE refused hands the task back on waiting_for_you', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const runAgentFn = async (options: AgentRunOptions): Promise<string> => {
      const raw = claudeStream('all done')
      options.onText?.(raw)
      return raw
    }
    const CONFLICT =
      'gh: not mergeable — resolve the overlap on the branch; nothing was rebased, reset or deleted'
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn,
      reviewTurnFn: async (record, io) => {
        record.status = 'review_ok'
        io.persist()
        return Promise.resolve()
      },
      shipTaskFn: () =>
        Promise.resolve({ pushed: true, mrUrl: 'https://github.com/o/r/pull/7', note: null }),
      mergeSettings: { policy: 'auto', deleteBranch: false, allowMergeWithoutChecks: false },
      // The four conditions HELD — this is the forge refusing afterwards,
      // which is `failed`, not `refused`. The two land on the same status by
      // design: nothing failed on our side, and what is needed is a person.
      mergeTaskFn: () =>
        Promise.resolve({
          kind: 'failed',
          reason: { code: 'merge_conflict', detail: CONFLICT },
          readiness: { ready: true, conditions: [], blockers: [] },
          events: [
            {
              type: 'merge',
              data: { name: 'failed', cli: 'gh', message: CONFLICT },
              reason_code: 'merge_conflict',
            },
          ],
        }),
    })

    const created = await manager.create(project.id, {
      title: 'Night shift',
      prompt: 'do it while I sleep',
      autoShip: true,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }
    // Waited on the JOURNAL line, not on the status: a wait on the status
    // turns the regression this test exists for into a timeout, which is
    // indistinguishable from a slow machine.
    await until(() =>
      readTaskEvents(repo, created.record.id).some(
        (event) => event.type === 'merge' && event.data.name === 'failed',
      ),
    )
    const record = loadTask(repo, created.record.id)
    expect(record?.status).toBe('waiting_for_you')
    expect(record?.reason?.code).toBe('merge_conflict')
    expect(record?.reason?.detail).toBe(CONFLICT)
    // Never `failed`, and never left on `shipped`: the branch and the merge
    // request are intact, and what is missing is a human.
    expect(record?.status).not.toBe('shipped')
    expect(record?.status).not.toBe('failed')
    expect(isTerminalReason(record!.reason!.code)).toBe(true)
  })

  // The mutation this kills: deleting the `record.status !== 'shipped'` guard
  // from `runMergeStep`. It is the ONLY thing standing between a ship that
  // FAILED to push (502, status left on `review_ok`) and a `gh pr merge` on a
  // branch that was never pushed — the auto-ship path calls the merge step
  // straight after the ship, whatever the ship answered.
  test('T3.6: a ship that never pushed is never merged', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const runAgentFn = async (options: AgentRunOptions): Promise<string> => {
      const raw = claudeStream('all done')
      options.onText?.(raw)
      return raw
    }
    const mergeCalls: string[] = []
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn,
      reviewTurnFn: async (record, io) => {
        record.status = 'review_ok'
        io.persist()
        return Promise.resolve()
      },
      shipTaskFn: () =>
        Promise.resolve({ pushed: false, error: 'push refused: no upstream configured' }),
      mergeSettings: { policy: 'auto', deleteBranch: false, allowMergeWithoutChecks: false },
      mergeTaskFn: (options) => {
        mergeCalls.push(options.task.id)
        return Promise.resolve({
          kind: 'held',
          readiness: { ready: false, conditions: [], blockers: [] },
          events: [],
        })
      },
    })

    const created = await manager.create(project.id, {
      title: 'Night shift',
      prompt: 'do it while I sleep',
      autoShip: true,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }
    // The ship's own failure line: written before the merge step is even
    // reached, so waiting on it is waiting past the decision under test.
    await until(() =>
      readTaskEvents(repo, created.record.id).some((event) => event.type === 'error'),
    )
    // Give a wrongly-chained merge a beat to show up before asserting it never came.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mergeCalls).toEqual([])
    // ...and the record is exactly where the failed ship left it: retryable,
    // branch and worktree intact.
    expect(loadTask(repo, created.record.id)?.status).toBe('review_ok')
    expect(readTaskEvents(repo, created.record.id).some((event) => event.type === 'merge')).toBe(
      false,
    )
  })

  // The mutation this kills: `await runMergeStep(...)` → `void
  // runMergeStep(...)` in the auto-ship path. The site's own comment carries
  // the whole argument — "AWAITED and not fired off … A dangling promise would
  // let this hook return … while every gate stays green" — and a comment is
  // not a test.
  //
  // The observable is the project's ADMISSION CLAIM, which the runner holds
  // for the whole active window of a task and gives back in the turn promise's
  // `finally`, after `onTurnDone` resolves. Fired off, the hook returns while
  // the merge is still in flight and the claim goes back immediately.
  test('T3.6: the merge step is awaited — the project stays claimed until it lands', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const runAgentFn = async (options: AgentRunOptions): Promise<string> => {
      const raw = claudeStream('all done')
      options.onText?.(raw)
      return raw
    }
    let entered = false
    let releaseMerge: () => void = () => {}
    const inFlight = new Promise<void>((resolve) => {
      releaseMerge = resolve
    })
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn,
      reviewTurnFn: async (record, io) => {
        record.status = 'review_ok'
        io.persist()
        return Promise.resolve()
      },
      shipTaskFn: () => Promise.resolve({ pushed: true, mrUrl: null, note: null }),
      mergeSettings: { policy: 'auto', deleteBranch: false, allowMergeWithoutChecks: false },
      mergeTaskFn: async () => {
        entered = true
        await inFlight
        return {
          kind: 'held',
          readiness: { ready: false, conditions: [], blockers: [] },
          events: [],
        }
      },
    })

    const created = await manager.create(project.id, {
      title: 'Night shift',
      prompt: 'do it while I sleep',
      autoShip: true,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) {
      return
    }
    await until(() => entered)
    // A fired-off merge step returns from the hook on this very tick; the
    // claim would already be back. The wait is one-sided: awaited, the claim
    // is held for as long as this test cares to look.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(activeTask(project.id)).toBe(created.record.id)
    releaseMerge()
    // ...and it IS given back once the step lands — the assertion above is a
    // real hold, not a leak.
    await until(() => activeTask(project.id) === null)
    expect(loadTask(repo, created.record.id)?.status).toBe('shipped')
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

    const created = await manager.create(project.id, {
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

  // Without the scratch project in the walk, registering a SINGLE repository
  // would make every conversation held outside one read as orphaned, and the
  // sweep would take its HOME volume out from under a live task.
  test('conversations of the scratch project claim their ids too', async () => {
    const project = register(makeRepo())
    const inRepo = seedTask(project.path, 'a task')
    const scratch = scratchProject()
    mkdirSync(scratch.path, { recursive: true })
    const outsideRepo = seedTask(scratch.path, 'just talking')
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

    expect(seenClaimed).toEqual([new Set([outsideRepo.id, inRepo.id])])
  })

  test('an empty registry says exactly that, never that something could not be read', async () => {
    const notices: string[] = []
    const swept: unknown[] = []
    const manager = createTaskManager({
      ...managerOpts,
      onNotice: (message) => notices.push(message),
      sweepOrphanedVolumesFn: (opts) => {
        swept.push(opts)
        return Promise.resolve({ removed: [], notices: [] })
      },
      ...fakeRunner(),
    })

    await manager.sweepOrphanedVolumes()

    expect(swept).toHaveLength(0)
    expect(notices).toEqual([
      'orphaned HOME volume sweep skipped: no repository registered to claim them',
    ])
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

describe('manager.sweepOrphanedSandboxes', () => {
  const fakeDriver = { kind: 'fake' } as unknown as SandboxDriver
  const microvmConfigured = {
    available: true,
    mode: 'microvm' as const,
    reason: 'microsandbox is available',
    configured: 'microvm' as const,
    runtime: null,
    // The gate reads THIS capability field, never `configured` — see the
    // sweep's own doc (task-server.ts) for why: the boot probe never
    // actually reaches this manager with `configured: 'microvm'` in
    // production, only ever 'auto'.
    microvm: { available: true, reason: 'microsandbox is available' },
  }

  test('a no-op, silently, when the workspace is not configured for microvm', async () => {
    const project = register(makeRepo())
    seedTask(project.path, 'a task')
    const notices: string[] = []
    let called = false
    const manager = createTaskManager({
      ...managerOpts,
      onNotice: (message) => notices.push(message),
      sandboxDriverFn: () => fakeDriver,
      sweepOrphanedSandboxesFn: () => {
        called = true
        return Promise.resolve({ removed: [], notices: [] })
      },
      ...fakeRunner(),
    })

    await manager.sweepOrphanedSandboxes()

    expect(called).toBe(false)
    expect(notices).toEqual([])
  })

  test("claimed ids span EVERY registered project, and the sweep's notices are forwarded verbatim", async () => {
    const projectA = register(makeRepo())
    const projectB = register(makeRepo())
    const claimedA = seedTask(projectA.path, 'a task')
    const claimedB = seedTask(projectB.path, 'b task')
    const seenClaimed: ReadonlySet<string>[] = []
    const notices: string[] = []
    const outcome: SandboxSweepOutcome = {
      removed: ['codesema-dev-orphan1'],
      notices: ['orphaned sandbox codesema-dev-orphan1 removed at boot: no task record claims it'],
    }
    const manager = createTaskManager({
      ...managerOpts,
      isolation: microvmConfigured,
      onNotice: (message) => notices.push(message),
      sandboxDriverFn: () => fakeDriver,
      sweepOrphanedSandboxesFn: (opts) => {
        seenClaimed.push(opts.claimedIds)
        expect(opts.driver).toBe(fakeDriver)
        return Promise.resolve(outcome)
      },
      ...fakeRunner(),
    })

    await manager.sweepOrphanedSandboxes()

    expect(seenClaimed).toEqual([new Set([claimedA.id, claimedB.id])])
    expect(notices).toEqual(outcome.notices)
  })

  test('an empty registry says exactly that, never that something could not be read', async () => {
    const notices: string[] = []
    const swept: unknown[] = []
    const manager = createTaskManager({
      ...managerOpts,
      isolation: microvmConfigured,
      onNotice: (message) => notices.push(message),
      sandboxDriverFn: () => fakeDriver,
      sweepOrphanedSandboxesFn: (opts) => {
        swept.push(opts)
        return Promise.resolve({ removed: [], notices: [] })
      },
      ...fakeRunner(),
    })

    await manager.sweepOrphanedSandboxes()

    expect(swept).toHaveLength(0)
    expect(notices).toEqual([
      'orphaned microvm sandbox sweep skipped: no repository registered to claim them',
    ])
  })

  test('a sweep that throws is reported as a notice, never as an unhandled rejection', async () => {
    const project = register(makeRepo())
    seedTask(project.path, 'a task')
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      isolation: microvmConfigured,
      onNotice: (message) => notices.push(message),
      sandboxDriverFn: () => fakeDriver,
      sweepOrphanedSandboxesFn: () => Promise.reject(new Error('driver unreachable')),
      ...fakeRunner(),
    })

    await expect(manager.sweepOrphanedSandboxes()).resolves.toBeUndefined()
    expect(notices).toEqual(['orphaned microvm sandbox sweep failed: driver unreachable'])
  })

  test('the default driver (createMicrosandboxDriver, not yet implemented) is never reached when a seam is given', async () => {
    const project = register(makeRepo())
    seedTask(project.path, 'a task')
    let sawDriver = false
    const manager = createTaskManager({
      ...managerOpts,
      isolation: microvmConfigured,
      sandboxDriverFn: () => {
        sawDriver = true
        return fakeDriver
      },
      sweepOrphanedSandboxesFn: () => Promise.resolve({ removed: [], notices: [] }),
      ...fakeRunner(),
    })

    await manager.sweepOrphanedSandboxes()

    expect(sawDriver).toBe(true)
  })

  test('recheckClaimedIds narrows to null on a broken registry, same as the HOME volume sweep', async () => {
    const project = register(makeRepo())
    seedTask(project.path, 'x')
    let recheck: (() => ReadonlySet<string> | null) | undefined
    const manager = createTaskManager({
      ...managerOpts,
      isolation: microvmConfigured,
      sandboxDriverFn: () => fakeDriver,
      sweepOrphanedSandboxesFn: (opts) => {
        recheck = opts.recheckClaimedIds
        return Promise.resolve({ removed: [], notices: [] })
      },
      ...fakeRunner(),
    })
    await manager.sweepOrphanedSandboxes()
    expect(recheck).toBeDefined()

    writeFileSync(projectsPath(), '{ broken')
    expect(recheck?.()).toBeNull()
  })

  test('a boot probe configured "auto" (the real production shape) still triggers the sweep when the machine reports microvm capability', async () => {
    // workspace.ts's boot probe always calls probeIsolation with
    // `configured: 'auto'`, never 'microvm' — this is the exact shape a
    // gate on `probe.configured === 'microvm'` never saw, so the sweep
    // never ran in production even on a machine that CAN run microvm.
    const project = register(makeRepo())
    seedTask(project.path, 'a task')
    let called = false
    const manager = createTaskManager({
      ...managerOpts,
      isolation: {
        available: true,
        mode: 'container',
        reason: 'docker is available',
        configured: 'auto',
        runtime: 'docker',
        microvm: { available: true, reason: 'microsandbox is available' },
      },
      sandboxDriverFn: () => fakeDriver,
      sweepOrphanedSandboxesFn: () => {
        called = true
        return Promise.resolve({ removed: [], notices: [] })
      },
      ...fakeRunner(),
    })

    await manager.sweepOrphanedSandboxes()

    expect(called).toBe(true)
  })

  test('the machine capability answering "unavailable" skips the sweep, even for a project explicitly configured for microvm', async () => {
    const project = register(makeRepo())
    seedTask(project.path, 'a task')
    let called = false
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      onNotice: (message) => notices.push(message),
      isolation: {
        available: false,
        mode: 'policy',
        reason: 'microsandbox is not installed',
        configured: 'microvm',
        runtime: null,
        microvm: { available: false, reason: 'microsandbox is not installed' },
      },
      sandboxDriverFn: () => fakeDriver,
      sweepOrphanedSandboxesFn: () => {
        called = true
        return Promise.resolve({ removed: [], notices: [] })
      },
      ...fakeRunner(),
    })

    await manager.sweepOrphanedSandboxes()

    expect(called).toBe(false)
    expect(notices).toEqual([])
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

    // Retention covers the scratch project too: conversations held there pile
    // up exactly like a repo's, and nothing else would ever purge them.
    const scratch = scratchProject()
    expect(seen).toEqual([
      { cwd: scratch.path, keep: 5 },
      { cwd: projectA.path, keep: 5 },
      { cwd: projectB.path, keep: 5 },
    ])
    expect(notices).toEqual([
      `${scratch.name}: ${outcome.notices[0]}`,
      `${scratch.name}: retention purged 1 task(s)`,
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

    expect(seen).toEqual([20, 20]) // DEFAULT_TASK_RETENTION, scratch then repo
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

    expect(ran).toEqual([scratchProject().path, projectA.path, projectB.path])
    expect(notices.some((line) => line.includes('disk full'))).toBe(true)
  })
})

// ── T2.6 · POST /api/tasks/preview ─────────────────────────────────────────
//
// The property this whole ticket rests on is the ABSENCE of effects, and the
// spec names how it must be proven: a fingerprint of the tree around the call,
// `.codesema/tasks/` and `queue.json` included, plus the repo's refs and
// worktrees. Not a spy on the seams we happened to think of — a preview that
// wrote through a path nobody mocked would sail past that.

/** Every path under `dir`, with size and mtime. */
function treeFingerprint(dir: string): string[] {
  const out: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).toSorted((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        out.push(`d ${relative(dir, full)}`)
        walk(full)
        continue
      }
      out.push(`f ${relative(dir, full)} ${statSync(full).size} ${statSync(full).mtimeMs}`)
    }
  }
  walk(dir)
  return out
}

const gitOut = (repo: string, args: string[]): string =>
  execFileSync('git', args, { cwd: repo }).toString().trim()

describe('T2.6 manager.preview', () => {
  const previewInput = { title: 'Fix flaky cleanup', prompt: 'do it', autoShip: false }

  test('an unregistered project is the SAME 404 create gives', async () => {
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
    expect(await manager.preview('deadbeef', previewInput)).toEqual({
      ok: false,
      code: 404,
      error: 'unknown project',
    })
    // The very same refusal object the creation route would answer with.
    expect(await manager.preview('deadbeef', previewInput)).toEqual(
      (await manager.create('deadbeef', previewInput)) as never,
    )
  })

  test('the tree, the refs and the worktrees are IDENTICAL before and after', async () => {
    const project = register(makeRepo())
    const repo = project.path
    execFileSync('git', ['branch', 'fix/x'], { cwd: repo })
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
    // A real, launched task first, so `.codesema/tasks/`, `queue.json` and the
    // project context all exist before the fingerprint is taken: previewing
    // into a pristine repo would prove far less.
    expect(
      (await manager.create(project.id, { title: 'seed', prompt: 'p', autoShip: false })).ok,
    ).toBe(true)
    const tasksBefore = manager.list(project.id)?.map((r) => r.id)
    const queueBefore = existsSync(queuePath(repo)) ? readFileSync(queuePath(repo), 'utf8') : null
    const treeBefore = treeFingerprint(repo)
    const refsBefore = gitOut(repo, ['for-each-ref', '--format=%(refname) %(objectname)'])
    const worktreesBefore = gitOut(repo, ['worktree', 'list', '--porcelain'])

    for (let n = 0; n < 3; n++) {
      expect((await manager.preview(project.id, previewInput)).ok).toBe(true)
      expect((await manager.preview(project.id, { ...previewInput, branch: 'fix/x' })).ok).toBe(
        true,
      )
    }

    expect(treeFingerprint(repo)).toEqual(treeBefore)
    expect(gitOut(repo, ['for-each-ref', '--format=%(refname) %(objectname)'])).toBe(refsBefore)
    expect(gitOut(repo, ['worktree', 'list', '--porcelain'])).toBe(worktreesBefore)
    // Named explicitly, because these are the two the spec calls out.
    expect(existsSync(queuePath(repo)) ? readFileSync(queuePath(repo), 'utf8') : null).toBe(
      queueBefore,
    )
    expect(manager.list(project.id)?.map((r) => r.id)).toEqual(tasksBefore)
    // No branch of ours, no journal line anywhere.
    expect(gitOut(repo, ['branch', '--list', 'codesema/task-fix-flaky-cleanup'])).toBe('')
    for (const id of tasksBefore ?? []) {
      expect(readTaskEvents(repo, id).some((e) => e.data?.message === 'preview')).toBe(false)
    }
  })

  // The case above previews into a project whose CONTEXT already exists (the
  // seed create built it). That hides the write this ticket most has to avoid:
  // building a context RECONCILES the project's store and rebuilds its
  // queue.json, and a context is built exactly once — so previewing into a
  // project this session has never touched is where a `context()` call would
  // finally show. Measured: without this case, routing `preview` through
  // `context()` leaves the fingerprint above untouched.
  test('previewing a project this session never touched builds no context, and writes nothing', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
    // Seeded AFTER the boot pass: a 'queued' record in a repo with no
    // queue.json is exactly what a reconciliation rewrites (to 'interrupted',
    // with a journal line). Nothing but a context build can reach it now.
    const orphan = seedTask(repo, 'queued by a session that died')
    const treeBefore = treeFingerprint(repo)

    const previewed = await manager.preview(project.id, previewInput)
    expect(previewed.ok).toBe(true)

    expect(treeFingerprint(repo)).toEqual(treeBefore)
    expect(loadTask(repo, orphan.id)?.status).toBe('queued')
    expect(readTaskEvents(repo, orphan.id)).toEqual([])
    expect(existsSync(queuePath(repo))).toBe(false)
  })

  test('two identical previews carry the identical plan: nothing is consumed', async () => {
    const project = register(makeRepo())
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
    const first = await manager.preview(project.id, previewInput)
    const second = await manager.preview(project.id, previewInput)
    expect(first.ok).toBe(true)
    expect(second).toEqual(first)
  })

  test('an idle project announces no rank at all: the task would start at once', async () => {
    const project = register(makeRepo())
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
    const previewed = await manager.preview(project.id, previewInput)
    // Null, not 0 — the same "absence means not waiting" `create` answers with.
    expect(previewed.ok && previewed.plan.queue_position).toBeNull()
  })

  test('the announced rank follows the line, and the line does not move', async () => {
    const project = register(makeRepo())
    const repo = project.path
    // The manager is built BEFORE the line is laid out: its boot pass
    // reconciles every registered project, and this test is about a queue it
    // must not touch afterwards.
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
    const running = seedTask(repo, 'running one')
    running.status = 'running'
    saveTask(repo, running)
    expect(claimActive(project.id, running.id)).toBe(true)
    const queued = [seedTask(repo, 'first'), seedTask(repo, 'second')]
    writeJsonAtomic(queuePath(repo), {
      version: 1,
      entries: queued.map((task) => ({
        id: task.id,
        enqueued_at: '2026-01-01T00:00:00.000Z',
      })),
    })
    const queueBefore = readFileSync(queuePath(repo), 'utf8')
    const orderBefore = readQueue(repo).entries.map((e) => e.id)

    const previewed = await manager.preview(project.id, previewInput)
    expect(previewed.ok && previewed.plan.queue_position).toBe(3)
    // Byte for byte, and in the same order.
    expect(readFileSync(queuePath(repo), 'utf8')).toBe(queueBefore)
    expect(readQueue(repo).entries.map((e) => e.id)).toEqual(orderBefore)
    // Not admitted: the project's own slot is still the running task's.
    expect(activeTask(project.id)).toBe(running.id)
  })

  // Review round 1, m1: this used to build a line of a thousand ids no record
  // backed, never call `create`, and assert a 503 — and in that very repo
  // `create` answers 201, because the admission path reconciles the ghosts
  // away first. Both halves are exercised now, on a line that is genuinely
  // full, and the two refusals are compared word for word.
  test('a full line is the SAME 503 create ends up returning, minus the record', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const seed = seedTask(repo, 'the line')
    const line = Array.from({ length: QUEUE_ENTRIES_MAX }, (_, n) =>
      (n + 1).toString(16).padStart(12, '0'),
    )
    for (const taskId of line) {
      saveTask(repo, { ...seed, id: taskId, title: `waiting ${taskId}` })
    }
    // The project's own slot is held, so the line cannot drain under the test
    // and nothing is ever launched.
    const running = seedTask(repo, 'running one')
    running.status = 'running'
    saveTask(repo, running)
    expect(claimActive(project.id, running.id)).toBe(true)
    writeJsonAtomic(queuePath(repo), {
      version: 1,
      entries: line.map((taskId) => ({ id: taskId, enqueued_at: '2026-01-01T00:00:00.000Z' })),
    })
    // The REAL runner: `create`'s 503 comes from `runner.start()` meeting the
    // same `enqueue` this projection projects, and a fake runner never gets
    // near it.
    const manager = createTaskManager({ ...managerOpts, runAgentFn: () => Promise.resolve('') })
    const before = manager.list(project.id)?.length ?? 0
    const queueBefore = readFileSync(queuePath(repo), 'utf8')

    const previewed = await manager.preview(project.id, previewInput)
    expect(previewed).toMatchObject({ ok: false, code: 503, reason_code: 'resource_busy' })
    expect(previewed.ok ? '' : previewed.error).toContain(`${QUEUE_ENTRIES_MAX} tasks`)
    // A refusal leaves NOTHING behind — the line is untouched, and no record
    // appeared to be settled.
    expect(manager.list(project.id)?.length).toBe(before)
    expect(readFileSync(queuePath(repo), 'utf8')).toBe(queueBefore)

    // …and now the half the name always promised. Same code, same words, same
    // reason_code, because both read them off `enqueue`'s own QUEUE_FULL.
    const created = await manager.create(project.id, previewInput)
    expect(created).toMatchObject({
      ok: false,
      code: 503,
      reason_code: 'resource_busy',
      error: previewed.ok ? '' : previewed.error,
    })
    // The one difference, and the reason the name says "minus the record":
    // `create` has a record on disk it must settle rather than abandon on
    // 'queued'; a preview never wrote one.
    const settled = manager.list(project.id)?.filter((task) => task.status === 'failed') ?? []
    expect(settled).toHaveLength(1)
    expect(manager.list(project.id)?.length).toBe(before + 1)
    releaseActive(project.id, running.id)
  })

  test('the agent and the isolation announced are THIS project’s, not the launch repo’s', async () => {
    const repoA = makeRepo()
    const repoB = makeRepo()
    saveRepoConfig(repoA, { isolation: 'container', agent: 'claude -p --model opus' })
    saveRepoConfig(repoB, { isolation: 'policy' })
    trustRepoAgent(repoA, 'claude -p --model opus')
    const projectA = register(repoA)
    const projectB = register(repoB)
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      command: 'claude -p',
      launchRepoPath: repoA,
      isolation: {
        available: true,
        mode: 'container',
        reason: 'podman is available',
        configured: 'auto',
        runtime: 'podman',
      },
    })

    const a = await manager.preview(projectA.id, previewInput)
    const b = await manager.preview(projectB.id, previewInput)
    expect(a.ok && a.plan.agent).toBe('claude -p --model opus')
    expect(a.ok && a.plan.isolation).toBe('container')
    expect(a.ok && a.plan.repo).toBe(repoA)
    // The workspace was LAUNCHED from A: B must not inherit either.
    expect(b.ok && b.plan.agent).toBe('claude -p')
    expect(b.ok && b.plan.isolation).toBe('policy')
    expect(b.ok && b.plan.isolation_reason).toBe(translate('isolation.reasonConfigured'))
    expect(b.ok && b.plan.repo).toBe(repoB)
  })

  test('an issue is READ into the plan and never frozen: no snapshot, no record', async () => {
    const project = register(makeRepoWithRemote())
    const { execFn } = ghIssueRig(conformingTicketBody(), 'Bind the ticket')
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner(), issueExecFn: execFn })
    const previewed = await manager.preview(project.id, {
      autoShip: false,
      issue: VALID_ISSUE_REF,
    })
    expect(previewed.ok).toBe(true)
    if (!previewed.ok) {
      return
    }
    expect(previewed.plan.issue).toEqual(VALID_ISSUE_REF)
    // The issue's OWN title drives the branch, exactly as create would.
    expect(previewed.plan.title).toBe('Bind the ticket')
    expect(previewed.plan.branch).toBe('codesema/task-bind-the-ticket')
    // D-d: previewing is not launching. Nothing dates the ticket, and nothing
    // of the snapshot's shape (`body_hash`, `taken_at`) reaches the plan.
    expect(manager.list(project.id)).toEqual([])
    expect(JSON.stringify(previewed.plan)).not.toContain('taken_at')
    expect(JSON.stringify(previewed.plan)).not.toContain('body_hash')
  })

  test('a malformed issue reference is refused exactly as create refuses it', async () => {
    const project = register(makeRepoWithRemote())
    const { execFn } = ghIssueRig(conformingTicketBody())
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner(), issueExecFn: execFn })
    const bad = { ...VALID_ISSUE_REF, iid: 'forty-two' }
    expect(await manager.preview(project.id, { autoShip: false, issue: bad })).toEqual(
      (await manager.create(project.id, { autoShip: false, issue: bad })) as never,
    )
    expect(manager.list(project.id)).toEqual([])
  })
})

// Review round 1, MAJEUR 1 and MAJEUR 2 — two failures of the SAME choice:
// consulting the queue through the path built for real operations.
//
//  - reading it WROTE. A degraded read reports through the sink, and the sink
//    stamps an `error` event in the journal of every task in the line (and
//    mkdirs its directory on the way). A dry run journaled three tasks it was
//    only supposed to look at, and ate the once-per-reason warning that the
//    next real `create` was owed.
//  - reading it RAW answered about a line that no longer existed. The
//    admission path reconciles (`recover()` → `reconcile()`) BEFORE it
//    enqueues, so entries a dead session left behind hold no rank — while the
//    projection counted them, and refused what `create` accepts.
//
// The fingerprints of the existing suite could not see either one: they only
// ever previewed against a HEALTHY, already-reconciled queue.json.
/** A queue.json cut mid-write: legible as bytes, unusable as JSON. */
function truncateQueue(repo: string): void {
  mkdirSync(join(repo, '.codesema'), { recursive: true })
  writeFileSync(queuePath(repo), '{"version":1,"entries":[{"id"')
}

describe('T2.6 preview against a queue.json nobody has reconciled', () => {
  const previewInput = { title: 'Fix flaky cleanup', prompt: 'do it', autoShip: false }

  /** The REAL runner, so `create` meets the real `enqueue`; its agent never runs. */
  const realManager = (notices: string[] = []) =>
    createTaskManager({
      ...managerOpts,
      runAgentFn: () => Promise.resolve(''),
      onNotice: (message: string) => notices.push(message),
    })

  /** Holds the project's admission slot, so no line drains under a test. */
  const holdSlot = (project: Project): TaskRecord => {
    const running = seedTask(project.path, 'running one')
    running.status = 'running'
    saveTask(project.path, running)
    expect(claimActive(project.id, running.id)).toBe(true)
    return running
  }

  test('an unreadable queue.json is previewed against without one journal line', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      onNotice: (message: string) => notices.push(message),
    })
    // Seeded AFTER the boot pass, and the file broken after it too: nothing
    // in this session has reconciled either.
    const queued = [seedTask(repo, 'one'), seedTask(repo, 'two'), seedTask(repo, 'three')]
    truncateQueue(repo)
    const treeBefore = treeFingerprint(repo)
    notices.length = 0

    const previewed = await manager.preview(project.id, previewInput)
    expect(previewed.ok).toBe(true)
    // Refusing to REPORT is not refusing to answer: the rank is the rebuilt
    // line's, the three waiting tasks included.
    expect(previewed.ok && previewed.plan.queue_position).toBe(4)

    // The whole failure of round 1, in one assertion.
    for (const task of queued) {
      expect(readTaskEvents(repo, task.id)).toEqual([])
    }
    // …and nothing else moved either: no repair, no evidence copy, no file.
    expect(treeFingerprint(repo)).toEqual(treeBefore)
    expect(existsSync(corruptQueuePath(repo))).toBe(false)
    expect(notices).toEqual([])

    // The report is once-per-reason and PROCESS-WIDE. Had the preview
    // consumed it, this listing would be silent and the degradation would
    // reach nobody at all — which is what makes the silence above a property
    // of the projection rather than of this rig.
    manager.list(project.id)
    expect(notices.some((line) => line.includes(QUEUE_UNREADABLE))).toBe(true)
    for (const task of queued) {
      expect(readTaskEvents(repo, task.id).map((event) => event.type)).toEqual(['error'])
    }
  })

  // The sink's OTHER hazard, on a real filesystem: `appendTaskEvent` mkdirs
  // its way to the journal, so it writes into a task whose record this pass
  // could not even parse — one the rebuild keeps precisely because "could not
  // read it" must never be read as "gone". (A directory that is outright GONE
  // needs the record seam; that one is pinned in task-queue.test.ts.)
  test('a task whose record will not parse is not written into by a preview', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
    const unreadable = seedTask(repo, 'unparseable')
    const events = join(taskDir(repo, unreadable.id), 'events.jsonl')
    writeFileSync(join(taskDir(repo, unreadable.id), 'task.json'), '{"version":1,"id"')
    // Legible entry, then one nothing can make sense of: the file parses, so
    // the good entry is KEPT, and the loss makes the read degraded.
    mkdirSync(join(repo, '.codesema'), { recursive: true })
    writeFileSync(
      queuePath(repo),
      `{"version":1,"entries":[{"id":"${unreadable.id}","enqueued_at":"2026-01-01T00:00:00.000Z"},"NOT-AN-ID!!"]}`,
    )
    const treeBefore = treeFingerprint(repo)

    const previewed = await manager.preview(project.id, previewInput)
    // Kept in the line: it is on disk, it merely would not parse.
    expect(previewed.ok && previewed.plan.queue_position).toBe(2)
    expect(existsSync(events)).toBe(false)
    expect(treeFingerprint(repo)).toEqual(treeBefore)

    // Control: a real read of the very same queue does write into it.
    manager.list(project.id)
    expect(existsSync(events)).toBe(true)
  })

  test('three previews in a row still leave the warning owed, and the journals empty', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const notices: string[] = []
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      onNotice: (message: string) => notices.push(message),
    })
    const queued = [seedTask(repo, 'one'), seedTask(repo, 'two')]
    truncateQueue(repo)
    notices.length = 0

    for (let n = 0; n < 3; n++) {
      expect((await manager.preview(project.id, previewInput)).ok).toBe(true)
    }
    expect(notices).toEqual([])
    expect(queued.map((task) => readTaskEvents(repo, task.id).length)).toEqual([0, 0])

    manager.list(project.id)
    expect(queued.map((task) => readTaskEvents(repo, task.id).length)).toEqual([1, 1])
  })

  test('entries a dead session left behind hold no rank — and create agrees, exactly', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const manager = realManager()
    // Three tasks this workspace already shipped, still named by the
    // queue.json of the session that died. Raw, the file says three are
    // waiting; reconciled — which is what `create` meets — the line is empty.
    const shipped = ['one', 'two', 'three'].map((title) => {
      const record = seedTask(repo, title)
      record.status = 'shipped'
      saveTask(repo, record)
      return record
    })
    const running = holdSlot(project)
    writeJsonAtomic(queuePath(repo), {
      version: 1,
      entries: shipped.map((record) => ({
        id: record.id,
        enqueued_at: '2026-01-01T00:00:00.000Z',
      })),
    })

    const treeBefore = treeFingerprint(repo)
    const previewed = await manager.preview(project.id, previewInput)
    // 1, not 4: the task waits on the project's own slot and on nothing else.
    expect(previewed.ok && previewed.plan.queue_position).toBe(1)
    // And reading the stale line did not repair it either: reconciling in
    // MEMORY is what keeps the projection free of effects.
    expect(treeFingerprint(repo)).toEqual(treeBefore)
    expect(readQueue(repo).entries.map((entry) => entry.id)).toEqual(
      shipped.map((record) => record.id),
    )

    const created = await manager.create(project.id, previewInput)
    expect(created.ok).toBe(true)
    expect(created.ok ? (created.record.queue_position ?? null) : 'refused').toBe(
      previewed.ok ? previewed.plan.queue_position : 'no plan',
    )
    releaseActive(project.id, running.id)
  })

  test('a thousand entries no record backs is an EMPTY line, not a full one', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const manager = realManager()
    const running = holdSlot(project)
    writeJsonAtomic(queuePath(repo), {
      version: 1,
      entries: Array.from({ length: QUEUE_ENTRIES_MAX }, (_, n) => ({
        id: (n + 1).toString(16).padStart(12, '0'),
        enqueued_at: '2026-01-01T00:00:00.000Z',
      })),
    })

    // It used to be a 503 `resource_busy` here and a 201 one line below.
    const previewed = await manager.preview(project.id, previewInput)
    expect(previewed.ok).toBe(true)
    expect(previewed.ok && previewed.plan.queue_position).toBe(1)

    const created = await manager.create(project.id, previewInput)
    expect(created.ok).toBe(true)
    expect(created.ok ? (created.record.queue_position ?? null) : 'refused').toBe(
      previewed.ok ? previewed.plan.queue_position : 'no plan',
    )
    releaseActive(project.id, running.id)
  })

  test('a queued record the file never knew about is counted, exactly as create counts it', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const manager = realManager()
    const running = holdSlot(project)
    // One entry in the file, one 'queued' record it never knew about: the
    // rebuild appends the orphan at the END, so the newcomer lands third.
    const inFile = seedTask(repo, 'in the file')
    seedTask(repo, 'orphan the file never knew')
    writeJsonAtomic(queuePath(repo), {
      version: 1,
      entries: [{ id: inFile.id, enqueued_at: '2026-01-01T00:00:00.000Z' }],
    })

    const previewed = await manager.preview(project.id, previewInput)
    expect(previewed.ok && previewed.plan.queue_position).toBe(3)

    const created = await manager.create(project.id, previewInput)
    expect(created.ok && created.record.queue_position).toBe(3)
    releaseActive(project.id, running.id)
  })
})

describe('T2.6 POST /api/tasks/preview — transport posture and refusal parity', () => {
  test('the route carries the same guards as the creation it previews', async () => {
    const project = register(makeRepo())
    const repo = project.path
    execFileSync('git', ['branch', 'fix/x'], { cwd: repo })
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
    const started = await startServer(createSession(), {
      cwd: repo,
      port: 5271,
      taskManager: manager,
      currentProjectId: project.id,
    })
    try {
      const token = await tasksToken(started.port)
      const headers = { 'x-codesema-tasks-token': token }
      const body = JSON.stringify({
        project_id: project.id,
        title: 'Fix flaky cleanup',
        prompt: 'p',
      })

      // No token, wrong token: 403, and nothing is computed.
      expect(
        (await rawRequest(started.port, '/api/tasks/preview', { method: 'POST', body })).status,
      ).toBe(403)
      expect(
        (
          await rawRequest(started.port, '/api/tasks/preview', {
            method: 'POST',
            headers: { 'x-codesema-tasks-token': 'wrong' },
            body,
          })
        ).status,
      ).toBe(403)

      // Past the body cap: the read is cut short and the answer is a 400.
      // The padding is a field the schema IGNORES, on purpose: an oversized
      // `prompt` would 400 on its own length whatever the cap is, so it cannot
      // tell a cap that works from one that does not. Everything the schema
      // looks at here is valid — only the SIZE is not.
      const huge = JSON.stringify({
        project_id: project.id,
        title: 'Fix flaky cleanup',
        prompt: 'p',
        padding: 'x'.repeat(70 * 1024),
      })
      expect(
        (
          await rawRequest(started.port, '/api/tasks/preview', {
            method: 'POST',
            headers,
            body: huge,
          })
        ).status,
      ).toBe(400)
      // Same body under the cap: accepted, which is what makes the assertion
      // above about the CAP and not about the payload.
      expect(
        (
          await rawRequest(started.port, '/api/tasks/preview', {
            method: 'POST',
            headers,
            body: JSON.stringify({
              project_id: project.id,
              title: 'Fix flaky cleanup',
              prompt: 'p',
              padding: 'x'.repeat(1024),
            }),
          })
        ).status,
      ).toBe(200)

      // Invalid JSON, and a valid JSON with the wrong shape.
      expect(
        (
          await rawRequest(started.port, '/api/tasks/preview', {
            method: 'POST',
            headers,
            body: '{not json',
          })
        ).status,
      ).toBe(400)
      for (const bad of [
        { project_id: project.id, title: 42, prompt: 'p' },
        { project_id: project.id, title: 't', prompt: 'p', autoShip: 'yes' },
        { project_id: project.id, title: 't', prompt: 'p', base: 42 },
        { project_id: project.id, title: 't', prompt: 'p', branch: 42 },
        { project_id: project.id, title: 't', prompt: 'p', target: 42 },
        { project_id: project.id, title: 't', prompt: 'p', agent: 42 },
        { title: 't', prompt: 'p' },
      ]) {
        expect(
          (
            await rawRequest(started.port, '/api/tasks/preview', {
              method: 'POST',
              headers,
              body: JSON.stringify(bad),
            })
          ).status,
        ).toBe(400)
      }

      // A rebound host is refused before the route is even reached.
      expect(
        (
          await rawRequest(started.port, '/api/tasks/preview', {
            method: 'POST',
            headers: { ...headers, host: 'evil.example.com' },
            body,
          })
        ).status,
      ).toBe(403)

      // The nominal answer is a 200 (nothing was created) carrying the plan.
      const ok = await rawRequest(started.port, '/api/tasks/preview', {
        method: 'POST',
        headers,
        body,
      })
      expect(ok.status).toBe(200)
      expect(JSON.parse(ok.body)).toMatchObject({
        mode: 'fork',
        repo,
        branch: 'codesema/task-fix-flaky-cleanup',
        branch_certain: true,
        worktree_root: join(repo, '.codesema', 'worktrees'),
        base: 'main',
        target: 'main',
        isolation: 'policy',
        agent: 'claude -p',
        queue_position: null,
        issue: null,
      })
      expect(typeof (JSON.parse(ok.body) as { isolation_reason: string }).isolation_reason).toBe(
        'string',
      )
      // …and still nothing on disk.
      expect(manager.list(project.id)).toEqual([])

      // Every refusal reaches the client in exactly the shape and the words
      // the real creation would have used. Compared route against route, not
      // against a constant this file owns.
      const both = async (payload: unknown) => {
        const p = await rawRequest(started.port, '/api/tasks/preview', {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        })
        const c = await rawRequest(started.port, '/api/tasks', {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        })
        return { preview: p, create: c }
      }
      const ghost = await both({ project_id: 'ffffffff', title: 't', prompt: 'p' })
      expect(ghost.preview.status).toBe(404)
      expect(ghost.preview).toEqual(ghost.create)

      const noBranch = await both({
        project_id: project.id,
        title: 't',
        prompt: 'p',
        branch: 'ghost',
      })
      expect(noBranch.preview.status).toBe(400)
      expect(noBranch.preview).toEqual(noBranch.create)

      const bothModes = await both({
        project_id: project.id,
        title: 't',
        prompt: 'p',
        branch: 'fix/x',
        base: 'main',
      })
      expect(bothModes.preview.status).toBe(400)
      expect(bothModes.preview).toEqual(bothModes.create)

      // The main worktree holds 'main': a work-on preview of it is the 409
      // naming the worktree, identical on both routes.
      const busy = await both({ project_id: project.id, title: 't', prompt: 'p', branch: 'main' })
      expect(busy.preview.status).toBe(409)
      expect(busy.preview.body).toContain(repo)
      expect(busy.preview).toEqual(busy.create)

      expect(manager.list(project.id)).toEqual([])
    } finally {
      await started.stop()
    }
  })

  test('the 409 existing_task_id is reproduced in work-on mode and absent in fork mode', async () => {
    const project = register(makeRepo())
    const repo = project.path
    execFileSync('git', ['branch', 'fix/x'], { cwd: repo })
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
    const live = seedTask(repo, 'already on fix/x')
    live.status = 'running'
    live.branch = 'fix/x'
    live.work_on = true
    saveTask(repo, live)
    const started = await startServer(createSession(), {
      cwd: repo,
      port: 5272,
      taskManager: manager,
      currentProjectId: project.id,
    })
    try {
      const headers = { 'x-codesema-tasks-token': await tasksToken(started.port) }
      const conflict = await rawRequest(started.port, '/api/tasks/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({ project_id: project.id, title: 't', prompt: 'p', branch: 'fix/x' }),
      })
      expect(conflict.status).toBe(409)
      expect(JSON.parse(conflict.body)).toEqual({
        error: "a conversation is already active on branch 'fix/x'",
        existing_task_id: live.id,
      })

      // Fork mode is minted in a free namespace: the guard never applies there.
      const fork = await rawRequest(started.port, '/api/tasks/preview', {
        method: 'POST',
        headers,
        body: JSON.stringify({ project_id: project.id, title: 'fix x', prompt: 'p' }),
      })
      expect(fork.status).toBe(200)
      expect(JSON.parse(fork.body)).not.toHaveProperty('existing_task_id')
      // Only the record seeded by hand is there — the preview added none.
      expect(manager.list(project.id)?.map((r) => r.id)).toEqual([live.id])
    } finally {
      await started.stop()
    }
  })

  test('a container-configured project with no runtime is the same 409 on both routes', async () => {
    const repo = makeRepo()
    saveRepoConfig(repo, { isolation: 'container' })
    const project = register(repo)
    const manager = createTaskManager({
      ...managerOpts,
      ...fakeRunner(),
      isolation: {
        available: false,
        mode: 'policy',
        reason: 'no container runtime found (install docker or podman)',
        configured: 'container',
        runtime: null,
      },
    })
    const started = await startServer(createSession(), {
      cwd: repo,
      port: 5273,
      taskManager: manager,
      currentProjectId: project.id,
    })
    try {
      const headers = { 'x-codesema-tasks-token': await tasksToken(started.port) }
      const body = JSON.stringify({ project_id: project.id, title: 't', prompt: 'p' })
      const previewed = await rawRequest(started.port, '/api/tasks/preview', {
        method: 'POST',
        headers,
        body,
      })
      expect(previewed.status).toBe(409)
      expect(JSON.parse(previewed.body)).toMatchObject({ reason_code: 'resource_busy' })
      // No plan is announced at all: the refusal replaces it.
      expect(JSON.parse(previewed.body)).not.toHaveProperty('isolation')
      const created = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers,
        body,
      })
      expect(previewed).toEqual(created)
      expect(manager.list(project.id)).toEqual([])
    } finally {
      await started.stop()
    }
  })
})

describe('T2.6 preview ↔ launch coherence', () => {
  /** Same shape as the end-to-end suite's: an injected agent that says it is done. */
  const claudeStream = (response: string) =>
    `${[
      { type: 'system', subtype: 'init', session_id: 'sess-t26' },
      { type: 'result', result: response },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n')}\n`

  test('the branch, the base and the worktree the task really gets are the ones announced', async () => {
    const project = register(makeRepo())
    const repo = project.path
    // The name the title slugs to is already taken: the collision resolution
    // is the half most likely to drift between the two paths.
    execFileSync('git', ['branch', 'codesema/task-fix-flaky-cleanup'], { cwd: repo })
    const runAgentFn = (): Promise<string> => Promise.resolve(claudeStream('all done'))
    const manager = createTaskManager({ command: 'claude -p', timeoutMs: 5000, runAgentFn })
    const started = await startServer(createSession(), {
      cwd: repo,
      port: 5274,
      taskManager: manager,
      currentProjectId: project.id,
    })
    try {
      const headers = { 'x-codesema-tasks-token': await tasksToken(started.port) }
      const body = JSON.stringify({
        project_id: project.id,
        title: 'Fix flaky cleanup',
        prompt: 'work',
      })
      const previewed = await rawRequest(started.port, '/api/tasks/preview', {
        method: 'POST',
        headers,
        body,
      })
      expect(previewed.status).toBe(200)
      const plan = JSON.parse(previewed.body) as TaskPlan
      expect(plan.branch).toBe('codesema/task-fix-flaky-cleanup-2')

      const created = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers,
        body,
      })
      expect(created.status).toBe(201)
      const record = JSON.parse(created.body) as TaskRecord

      // The branch of a fork is minted at LAUNCH, so the comparison that
      // matters is against the materialized record, not the created one.
      await until(() => (loadTask(repo, record.id)?.branch ?? '') !== '')
      const launched = loadTask(repo, record.id)
      expect(launched?.branch).toBe(plan.branch)
      expect(launched?.base).toBe(plan.target)
      expect(launched?.worktree).toBe(join(plan.worktree_root, record.id))
      expect(launched?.isolation).toBe(plan.isolation)
      expect(launched?.agent).toBe(plan.agent)
      expect(launched?.title).toBe(plan.title)
    } finally {
      await started.stop()
    }
  })

  test('work-on: the branch, the MR target and the isolation announced are the ones recorded', async () => {
    const project = register(makeRepo())
    const repo = project.path
    const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    run(['branch', 'fix/x'])
    run(['branch', 'release'])
    const runAgentFn = (): Promise<string> => Promise.resolve(claudeStream('all done'))
    const manager = createTaskManager({ command: 'claude -p', timeoutMs: 5000, runAgentFn })
    const started = await startServer(createSession(), {
      cwd: repo,
      port: 5275,
      taskManager: manager,
      currentProjectId: project.id,
    })
    try {
      const headers = { 'x-codesema-tasks-token': await tasksToken(started.port) }
      const body = JSON.stringify({
        project_id: project.id,
        title: 'work on it',
        prompt: 'work',
        branch: 'fix/x',
        target: 'release',
      })
      const previewed = await rawRequest(started.port, '/api/tasks/preview', {
        method: 'POST',
        headers,
        body,
      })
      expect(previewed.status).toBe(200)
      const plan = JSON.parse(previewed.body) as TaskPlan
      expect(plan).toMatchObject({ mode: 'work_on', branch: 'fix/x', base: '', target: 'release' })

      const created = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers,
        body,
      })
      expect(created.status).toBe(201)
      const record = JSON.parse(created.body) as TaskRecord
      expect(record.branch).toBe(plan.branch)
      expect(record.base).toBe(plan.target)
      await until(() => (loadTask(repo, record.id)?.worktree ?? '') !== '')
      const launched = loadTask(repo, record.id)
      expect(launched?.worktree).toBe(join(plan.worktree_root, record.id))
      expect(launched?.base).toBe(plan.target)
    } finally {
      await started.stop()
    }
  })
})

// --- the bounded automatic fix loop (T3.3, D14) ---------------------------

describe('automatic fix loop (T3.3)', () => {
  const AC1 = {
    id: acceptanceCriterionId('WHEN it ships THE SYSTEM SHALL recap'),
    text: 'WHEN it ships THE SYSTEM SHALL recap',
  }
  const AC2 = {
    id: acceptanceCriterionId('WHEN checks fail THE SYSTEM SHALL block'),
    text: 'WHEN checks fail THE SYSTEM SHALL block',
  }
  const MAJOR: Finding = { file: 'a.ts', line: 3, severity: 'major', message: 'leaks a descriptor' }

  type ReviewSpec = {
    verdict?: Verdict
    findings?: Finding[]
    criteria?: CriterionVerdict[]
    /** What the reviewer settles the record on. Absent means a clean review_ok. */
    blocked?: { code: 'review_blocked' | 'criteria_unmet'; detail: string }
    /** A review that never produced an archive (agent crash, timeout). */
    crashed?: boolean
  }

  function turnIo(cwd: string, record: TaskRecord, written?: TaskStatus[]) {
    return {
      emit: (input: Parameters<typeof appendTaskEvent>[2]) =>
        appendTaskEvent(cwd, record.id, input),
      persist: () => {
        written?.push(record.status)
        saveTask(cwd, record)
      },
      text: () => {},
      signal: new AbortController().signal,
    }
  }

  /**
   * A reviewer stub that behaves like the real one where it matters here: it
   * ARCHIVES a review record and emits `review_done` before settling, which is
   * exactly what the loop reads to know it has something to work from.
   */
  function stubReviewer(cwd: string, plan: (n: number) => ReviewSpec) {
    let n = 0
    return async (record: TaskRecord, io: TaskTurnIo): Promise<void> => {
      const spec = plan(n)
      n += 1
      io.emit({ type: 'review_started', data: { turn: record.turns.length, mode: 'simple' } })
      if (spec.crashed) {
        io.emit({
          type: 'error',
          data: { message: 'review failed: the review agent died' },
          reason_code: 'review_blocked',
        })
        record.status = 'review_ko'
        record.reason = taskReason('review_blocked', 'review failed: the review agent died')
        io.persist()
        return
      }
      const verdict = spec.verdict ?? 'request_changes'
      const base = fakeReviewRecord(verdict, 'a summary')
      const review: ReviewRecord = {
        ...base,
        review: {
          ...base.review,
          findings: spec.findings ?? [],
          ...(spec.criteria ? { criteria: spec.criteria } : {}),
        },
      }
      record.review_ref = archiveRecord(review, cwd)
      io.emit({
        type: 'review_done',
        data: {
          verdict,
          findings_count: review.review.findings.length,
          ref: record.review_ref,
        },
      })
      if (spec.blocked) {
        record.status = 'review_ko'
        record.reason = taskReason(spec.blocked.code, spec.blocked.detail)
      } else {
        record.status = 'review_ok'
        delete record.reason
      }
      io.persist()
    }
  }

  type LoopRig = {
    project: Project
    record: TaskRecord
    rig: FakeRunnerRig
    written: TaskStatus[]
    /** Runs end-of-turn cycles until the loop stops asking for another one. */
    drive: (maxCycles?: number) => Promise<number>
  }

  function loopRig(opts: { plan: (n: number) => ReviewSpec; criteria?: (typeof AC1)[] }): LoopRig {
    const project = register(makeRepo())
    const rig = fakeRunner({ replyResult: { ok: true } })
    const manager = createTaskManager({
      ...managerOpts,
      createRunnerFn: rig.createRunnerFn,
      reviewTurnFn: stubReviewer(project.path, opts.plan),
    })
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const { record } = seedCommittedTask(project.path)
    if (opts.criteria) {
      record.criteria = opts.criteria
      saveTask(project.path, record)
    }
    const written: TaskStatus[] = []
    const io = turnIo(project.path, record, written)
    const drive = async (maxCycles = 8): Promise<number> => {
      let cycles = 0
      for (let i = 0; i < maxCycles; i++) {
        const before = rig.replies.length
        record.status = 'reviewing' as TaskStatus
        await rig.runnerOptions().onTurnDone!(record, io)
        cycles += 1
        if (rig.replies.length === before) {
          return cycles
        }
        // What the runner does with an accepted reply: it appends the turn and
        // emits `turn_started` when the turn actually begins.
        record.turns.push({
          prompt: String(rig.replies.at(-1)?.message ?? ''),
          response: null,
          question: null,
          started_at: new Date().toISOString(),
          ended_at: null,
        })
        appendTaskEvent(project.path, record.id, {
          type: 'turn_started',
          data: { turn: record.turns.length, prompt: 'fix' },
        })
      }
      throw new Error(`the loop never stopped: ${maxCycles} cycles and still going`)
    }
    return { project, record, rig, written, drive }
  }

  const blockedByFindings = {
    findings: [MAJOR],
    blocked: { code: 'review_blocked' as const, detail: 'a.ts:3 leaks a descriptor' },
  }

  const markers = (project: Project, record: TaskRecord) =>
    readTaskEvents(project.path, record.id).filter((e) => e.data.name === AUTO_FIX_ROUND_NAME)

  test('AC: review_ko + a major finding starts a fix turn WITHOUT a human click', async () => {
    const loop = loopRig({ plan: () => blockedByFindings })
    // Exactly one end-of-turn cycle, no gesture from anyone.
    const before = loop.rig.replies.length
    loop.record.status = 'reviewing' as TaskStatus
    await loop.rig.runnerOptions().onTurnDone!(loop.record, turnIo(loop.project.path, loop.record))
    expect(loop.rig.replies.length).toBe(before + 1)
    // ...and it is the FIX prompt, built from the review this turn archived.
    const message = String(loop.rig.replies.at(-1)?.message)
    expect(message).toContain('leaks a descriptor')
    expect(message).toContain('applying code review fixes')
    // The runner commits, never the agent: the prompt says so, unchanged.
    expect(message).toContain('Do NOT commit')
    // Said out loud, and numbered.
    const marker = markers(loop.project, loop.record).at(-1)
    expect(marker?.type).toBe('message')
    expect(marker?.data.round).toBe(1)
    expect(marker?.data.max).toBe(2)
    expect(String(marker?.data.text)).toContain('a.ts:3 leaks a descriptor')
  })

  test('AC: criteria unmet with a review_ok verdict ENTERS the loop too', async () => {
    const loop = loopRig({
      criteria: [AC1, AC2],
      plan: () => ({
        verdict: 'approve',
        criteria: [
          { criterion_id: AC1.id, status: 'met' },
          { criterion_id: AC2.id, status: 'unmet' },
        ],
        blocked: { code: 'criteria_unmet', detail: '1 of 2 acceptance criteria are not satisfied' },
      }),
    })
    loop.record.status = 'reviewing' as TaskStatus
    await loop.rig.runnerOptions().onTurnDone!(loop.record, turnIo(loop.project.path, loop.record))
    expect(loop.rig.replies).toHaveLength(1)
    const message = String(loop.rig.replies[0]?.message)
    // The criterion's own TEXT travels, not just its id: an id is a join key.
    expect(message).toContain(AC2.id)
    expect(message).toContain('WHEN checks fail THE SYSTEM SHALL block')
    // The satisfied one is not re-asked for.
    expect(message).not.toContain(AC1.id)
  })

  test('AC: two blocked rounds at the default bound, then the loop hands it back', async () => {
    const loop = loopRig({ plan: () => blockedByFindings })
    const cycles = await loop.drive()
    // Three end-of-turn cycles: the original turn plus TWO fix rounds.
    expect(cycles).toBe(3)
    expect(loop.rig.replies).toHaveLength(2)
    expect(markers(loop.project, loop.record).map((e) => e.data.round)).toEqual([1, 2])
    expect(loop.record.status).toBe('waiting_for_you')
    expect(loop.record.reason?.code).toBe('review_blocked')
    // The code is ADDED to what the reviewer said, never a replacement.
    expect(loop.record.reason?.detail).toContain('a.ts:3 leaks a descriptor')
    expect(loop.record.reason?.detail).toContain('automatic fix loop stopped after 2')
    expect(loadTask(loop.project.path, loop.record.id)?.status).toBe('waiting_for_you')
    // Journal + API, both (invariant n° 2).
    const said = readTaskEvents(loop.project.path, loop.record.id).find(
      (e) => e.data.name === AUTO_FIX_EXHAUSTED_NAME,
    )
    expect(said?.reason_code).toBe('review_blocked')
    expect(String(said?.data.text)).toContain('stopped after 2')
  })

  test('AC: an agent that fixes NOTHING still terminates — the bound is the whole guarantee', async () => {
    // The stub never changes its verdict, whatever the fix turn did: the only
    // thing that can stop this is the bound.
    const loop = loopRig({ plan: () => blockedByFindings })
    await expect(loop.drive(8)).resolves.toBe(3)
  })

  test('AC: a criteria-blocked exit carries criteria_unmet, not review_blocked', async () => {
    const loop = loopRig({
      criteria: [AC1, AC2],
      plan: () => ({
        verdict: 'approve',
        criteria: [
          { criterion_id: AC1.id, status: 'met' },
          { criterion_id: AC2.id, status: 'unmet' },
        ],
        blocked: { code: 'criteria_unmet', detail: '1 of 2 acceptance criteria are not satisfied' },
      }),
    })
    await loop.drive()
    expect(loop.record.status).toBe('waiting_for_you')
    expect(loop.record.reason?.code).toBe('criteria_unmet')
    expect(loop.record.reason?.detail).toContain('1 of 2 acceptance criteria')
  })

  test('D26: a judgment-only criteria block ships after JUDGMENT_ONLY_MAX_ROUNDS, never waiting_for_you', async () => {
    // Every round settles the SAME shape: AC1 met, AC2 a sincere unclear with
    // a question — never a real unmet, never unjudged. The archive this stub
    // writes is what task-server.ts's own `readReviewRef` reads to classify
    // the block as `judgment_open` (task-criteria-gate.ts), independent of
    // whatever the review pipeline itself would have decided.
    const loop = loopRig({
      criteria: [AC1, AC2],
      plan: () => ({
        verdict: 'approve',
        criteria: [
          { criterion_id: AC1.id, status: 'met' },
          {
            criterion_id: AC2.id,
            status: 'unclear',
            question: 'does this match the sibling helper?',
          },
        ],
        blocked: { code: 'criteria_unmet', detail: '1 of 2 acceptance criteria are not satisfied' },
      }),
    })
    const cycles = await loop.drive()
    // JUDGMENT_ONLY_MAX_ROUNDS fix rounds, then a THIRD cycle that ships
    // instead of asking for one more — whatever the configured `maxAutoFixRounds`
    // (2 here, same default the other tests in this block use) allows.
    expect(cycles).toBe(JUDGMENT_ONLY_MAX_ROUNDS + 1)
    expect(loop.rig.replies).toHaveLength(JUDGMENT_ONLY_MAX_ROUNDS)
    expect(loop.record.status).toBe('review_ok')
    expect(loop.record.reason).toBeUndefined()
    expect(loadTask(loop.project.path, loop.record.id)?.status).toBe('review_ok')
    const shipped = readTaskEvents(loop.project.path, loop.record.id).find(
      (e) => e.data.name === AUTO_FIX_SHIP_NAME,
    )
    expect(shipped).toBeDefined()
    expect(String(shipped?.data.text)).toContain('open judgment calls')
    // Never handed to a human, and never the exhausted-budget line either.
    expect(
      readTaskEvents(loop.project.path, loop.record.id).some(
        (e) => e.data.name === AUTO_FIX_EXHAUSTED_NAME,
      ),
    ).toBe(false)
  })

  test('the exit is written by the SINGLE owner: the disk never shows review_ko first', async () => {
    const loop = loopRig({ plan: () => blockedByFindings })
    // Only the last cycle's writes matter — the two retries legitimately
    // persist 'review_ko' before their fix turn is queued.
    await loop.drive()
    loop.written.length = 0
    loop.record.status = 'reviewing' as TaskStatus
    await loop.rig.runnerOptions().onTurnDone!(
      loop.record,
      turnIo(loop.project.path, loop.record, loop.written),
    )
    // The reviewer's own settle() and the hook's belt-and-braces write both
    // land on the FINAL status: the loop's decision is folded INTO the
    // transition, never applied as a second write after it.
    expect([...new Set(loop.written)]).toEqual(['waiting_for_you'])
  })

  test('the bound is configurable: 1 allows one round, 3 allows three', async () => {
    for (const [max, expected] of [
      [1, 1],
      [3, 3],
    ] as const) {
      const project = register(makeRepo())
      saveRepoConfig(project.path, { maxAutoFixRounds: max })
      const rig = fakeRunner({ replyResult: { ok: true } })
      const manager = createTaskManager({
        ...managerOpts,
        createRunnerFn: rig.createRunnerFn,
        reviewTurnFn: stubReviewer(project.path, () => blockedByFindings),
      })
      manager.checks(project.id, 'aaaaaaaaaaaa')
      const { record } = seedCommittedTask(project.path)
      const io = turnIo(project.path, record)
      for (let i = 0; i < expected + 2; i++) {
        const before = rig.replies.length
        record.status = 'reviewing'
        await rig.runnerOptions().onTurnDone!(record, io)
        if (rig.replies.length === before) {
          break
        }
        record.turns.push({
          prompt: 'fix',
          response: null,
          question: null,
          started_at: new Date().toISOString(),
          ended_at: null,
        })
        appendTaskEvent(project.path, record.id, {
          type: 'turn_started',
          data: { turn: record.turns.length },
        })
      }
      expect(rig.replies).toHaveLength(expected)
      expect(record.status).toBe('waiting_for_you')
    }
  })

  test('the count survives a restart: it is read off the journal, not off memory', async () => {
    const project = register(makeRepo())
    const { record } = seedCommittedTask(project.path)
    // A previous session already ran ONE automatic round and died. Nothing in
    // memory carries that over — only these two journal lines do.
    appendTaskEvent(project.path, record.id, {
      type: 'message',
      data: { text: 'starting automatic fix round 1 of 2', name: AUTO_FIX_ROUND_NAME },
    })
    appendTaskEvent(project.path, record.id, { type: 'turn_started', data: { turn: 2 } })

    // A brand-new manager, a brand-new runner: this process has never seen
    // this task before.
    const rig = fakeRunner({ replyResult: { ok: true } })
    const manager = createTaskManager({
      ...managerOpts,
      createRunnerFn: rig.createRunnerFn,
      reviewTurnFn: stubReviewer(project.path, () => blockedByFindings),
    })
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const io = turnIo(project.path, record)
    record.status = 'reviewing' as TaskStatus
    await rig.runnerOptions().onTurnDone!(record, io)
    // Round 2 of 2, not round 1: the previous session's round counted.
    expect(rig.replies).toHaveLength(1)
    expect(markers(project, record).at(-1)?.data.round).toBe(2)
    record.turns.push({
      prompt: 'fix',
      response: null,
      question: null,
      started_at: new Date().toISOString(),
      ended_at: null,
    })
    appendTaskEvent(project.path, record.id, { type: 'turn_started', data: { turn: 3 } })
    record.status = 'reviewing' as TaskStatus
    await rig.runnerOptions().onTurnDone!(record, io)
    expect(rig.replies).toHaveLength(1)
    expect(record.status).toBe('waiting_for_you')
  })

  test('a human reply renews the budget, so a task never loses the loop for good', async () => {
    const loop = loopRig({ plan: () => blockedByFindings })
    await loop.drive()
    expect(loop.record.status).toBe('waiting_for_you')
    // The human answers by hand: a turn with no marker in front of it.
    loop.record.turns.push({
      prompt: 'try the other approach',
      response: null,
      question: null,
      started_at: new Date().toISOString(),
      ended_at: null,
    })
    appendTaskEvent(loop.project.path, loop.record.id, {
      type: 'turn_started',
      data: { turn: loop.record.turns.length, prompt: 'try the other approach' },
    })
    const before = loop.rig.replies.length
    loop.record.status = 'reviewing' as TaskStatus
    await loop.rig.runnerOptions().onTurnDone!(loop.record, turnIo(loop.project.path, loop.record))
    expect(loop.rig.replies.length).toBe(before + 1)
    expect(markers(loop.project, loop.record).at(-1)?.data.round).toBe(1)
  })

  test('a broken review STAYS review_ko: no round spent, no capability taken away', async () => {
    // MAJOR 1. A review nobody could archive is not a review whose budget was
    // spent, and the two must not end in the same place. This ticket's own
    // spec says a review breakdown stays `review_ko` + an `error` event, and
    // `review_ko` is the status on which a human may still assume the KO and
    // ship — the exact capability parking the task would silently remove,
    // for a round that was never spent.
    const loop = loopRig({ plan: () => ({ crashed: true }) })
    const cycles = await loop.drive()
    expect(cycles).toBe(1)
    expect(loop.rig.replies).toHaveLength(0)
    expect(markers(loop.project, loop.record)).toHaveLength(0)
    expect(loop.record.status).toBe('review_ko')
    expect(loadTask(loop.project.path, loop.record.id)?.status).toBe('review_ko')
    expect(loop.record.reason?.code).toBe('review_blocked')
    // The honest sentence: nothing was tried, as opposed to "tried twice".
    expect(loop.record.reason?.detail).toContain('no automatic fix round was started')
    expect(loop.record.reason?.detail).not.toContain('stopped after')
    // The reviewer's own failure message is still there, in front of it.
    expect(loop.record.reason?.detail).toContain('the review agent died')
    // Said in the journal too, under its OWN name — "could not begin" and
    // "gave up after two rounds" are different facts on the timeline.
    const events = readTaskEvents(loop.project.path, loop.record.id)
    const stood = events.find((e) => e.data.name === AUTO_FIX_NOT_STARTED_NAME)
    expect(stood?.reason_code).toBe('review_blocked')
    expect(String(stood?.data.text)).toContain('no automatic fix round was started')
    expect(events.find((e) => e.data.name === AUTO_FIX_EXHAUSTED_NAME)).toBeUndefined()
    // The `error` event the spec requires of a review breakdown is untouched.
    expect(events.some((e) => e.type === 'error')).toBe(true)
  })

  test('a broken review can still be SHIPPED by a human assuming the KO', async () => {
    // The half of MAJOR 1 no status assertion can catch: `shipRefusal` lets a
    // `review_ko` through and refuses a `waiting_for_you`, so parking the task
    // deleted the force ship without a word. This is that capability, pinned.
    const project = register(makeRepo())
    const rig = fakeRunner({ replyResult: { ok: true } })
    const ship = shipStub({ pushed: true, mrUrl: 'https://github.com/o/r/pull/1', note: null })
    const manager = createTaskManager({
      ...managerOpts,
      createRunnerFn: rig.createRunnerFn,
      reviewTurnFn: stubReviewer(project.path, () => ({ crashed: true })),
      shipTaskFn: ship.fn,
    })
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const { record } = seedCommittedTask(project.path)
    record.status = 'reviewing' as TaskStatus
    await rig.runnerOptions().onTurnDone!(record, turnIo(project.path, record))
    expect(record.status).toBe('review_ko')
    // A branch is the ship's other precondition and has nothing to do with
    // the loop; give it one so the gate under test is the STATUS gate.
    record.branch = 'codesema/task-broken'
    saveTask(project.path, record)
    expect(await manager.ship(project.id, record.id)).toEqual({ ok: true })
    expect(ship.calls).toHaveLength(1)
  })

  test('the ship refusal of a HANDED-BACK task names the way out (DP1)', async () => {
    const project = register(makeRepo())
    const rig = fakeRunner({ replyResult: { ok: true } })
    const ship = shipStub({ pushed: true, mrUrl: null, note: null })
    const manager = createTaskManager({
      ...managerOpts,
      createRunnerFn: rig.createRunnerFn,
      reviewTurnFn: stubReviewer(project.path, () => blockedByFindings),
      shipTaskFn: ship.fn,
    })
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const { record } = seedCommittedTask(project.path)
    const io = turnIo(project.path, record)
    for (let i = 0; i < 3; i++) {
      record.status = 'reviewing' as TaskStatus
      await rig.runnerOptions().onTurnDone!(record, io)
      record.turns.push({
        prompt: 'fix',
        response: null,
        question: null,
        started_at: new Date().toISOString(),
        ended_at: null,
      })
      appendTaskEvent(project.path, record.id, {
        type: 'turn_started',
        data: { turn: record.turns.length },
      })
    }
    expect(record.status).toBe('waiting_for_you')
    const refused = await manager.ship(project.id, record.id)
    expect(refused).toMatchObject({ ok: false, code: 409, reason_code: 'review_blocked' })
    // `task is waiting_for_you` alone describes a task nobody asked anything
    // about and leaves the reader with no idea what unblocks the ship.
    const message = String((refused as { error: string }).error)
    expect(message).toContain('automatic fix loop')
    expect(message).toContain('Reply to it')
    expect(message).toContain('restarts the automatic fix budget')
    expect(ship.calls).toHaveLength(0)
  })

  test('a crashed review never sends the agent back at the PREVIOUS turn’s archive', async () => {
    // The discriminating shape: the task ALREADY has an archive on disk — the
    // first turn produced one — and `record.review_ref` still points at it.
    // The second turn's review then dies before archiving anything, so it
    // settles review_ko/review_blocked with a stale `review_ref` in place.
    // Reading that archive would produce a perfectly well-formed fix prompt
    // about findings from a turn that has already been worked on: a round
    // spent re-fixing what may be fixed, and a lie about which review it
    // answers. The loop must decline instead, on THIS turn's evidence.
    const loop = loopRig({ plan: (n) => (n === 0 ? blockedByFindings : { crashed: true }) })
    loop.record.status = 'reviewing' as TaskStatus
    await loop.rig.runnerOptions().onTurnDone!(loop.record, turnIo(loop.project.path, loop.record))
    expect(loop.rig.replies).toHaveLength(1)
    const staleRef = loop.record.review_ref
    expect(staleRef).toBeTruthy()
    // The fix turn the first round queued runs and finishes.
    loop.record.turns.push({
      prompt: String(loop.rig.replies.at(-1)?.message ?? ''),
      response: null,
      question: null,
      started_at: new Date().toISOString(),
      ended_at: null,
    })
    appendTaskEvent(loop.project.path, loop.record.id, {
      type: 'turn_started',
      data: { turn: loop.record.turns.length, prompt: 'fix' },
    })
    loop.record.status = 'reviewing' as TaskStatus
    await loop.rig.runnerOptions().onTurnDone!(loop.record, turnIo(loop.project.path, loop.record))
    // No second round: the crashed review left nothing to work from.
    expect(loop.rig.replies).toHaveLength(1)
    expect(markers(loop.project, loop.record).map((e) => e.data.round)).toEqual([1])
    // ...and the stale archive is still sitting there, unused — which is what
    // makes this an abstention rather than an absence.
    expect(loop.record.review_ref).toBe(staleRef)
    // Still `review_ko`: one round WAS spent here, but the loop's refusal to
    // spend a second is an abstention, not an exhausted budget.
    expect(loop.record.status).toBe('review_ko')
    expect(loop.record.reason?.code).toBe('review_blocked')
    expect(loop.record.reason?.detail).toContain('no automatic fix round was started')
    expect(loop.record.reason?.detail).not.toContain('stopped after')
    expect(loop.record.reason?.detail).toContain('the review agent died')
  })

  test('a round the runner refuses is said, and never charged to the next reply', async () => {
    const project = register(makeRepo())
    const rig = fakeRunner() // its reply() answers 409, like a drain would
    const manager = createTaskManager({
      ...managerOpts,
      createRunnerFn: rig.createRunnerFn,
      reviewTurnFn: stubReviewer(project.path, () => blockedByFindings),
    })
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const { record } = seedCommittedTask(project.path)
    record.status = 'reviewing' as TaskStatus
    await rig.runnerOptions().onTurnDone!(record, turnIo(project.path, record))
    const events = readTaskEvents(project.path, record.id)
    const refused = events.find((e) => e.data.name === AUTO_FIX_NOT_QUEUED_NAME)
    expect(refused?.type).toBe('error')
    expect(String(refused?.data.message)).toContain('could not be queued')
    // The announced round is retracted, so a later human reply keeps its two.
    expect(autoFixRoundsUsed(events)).toBe(0)
  })

  test('non-regression: a clean review is untouched — no round, no marker, no reply', async () => {
    const loop = loopRig({ plan: () => ({ verdict: 'approve' }) })
    const cycles = await loop.drive()
    expect(cycles).toBe(1)
    expect(loop.record.status).toBe('review_ok')
    expect(loop.record.reason).toBeUndefined()
    expect(loop.rig.replies).toHaveLength(0)
    expect(markers(loop.project, loop.record)).toHaveLength(0)
  })

  test('non-regression: a red checks run is NOT the loop’s business', async () => {
    const project = register(makeRepo())
    const rig = fakeRunner({ replyResult: { ok: true } })
    const manager = createTaskManager({
      ...managerOpts,
      createRunnerFn: rig.createRunnerFn,
      reviewTurnFn: stubReviewer(project.path, () => ({ verdict: 'approve' })),
      runChecksFn: () =>
        Promise.resolve(
          finishedChecks({
            status: 'failed',
            checks: [
              { command: 'bun test', status: 'failed', exit_code: 1, duration_ms: 5, tail: 'boom' },
            ],
          }),
        ),
    })
    manager.checks(project.id, 'aaaaaaaaaaaa')
    const { record } = seedCommittedTask(project.path)
    record.status = 'reviewing' as TaskStatus
    await rig.runnerOptions().onTurnDone!(record, turnIo(project.path, record))
    // T3.1's verdict stands, exactly as before: no fix turn is guessed at.
    expect(record.status).toBe('review_ko')
    expect(record.reason?.code).toBe('checks_failed')
    expect(rig.replies).toHaveLength(0)
  })

  test('an UNREADABLE journal grants no round at all, and never a full budget', async () => {
    // MAJOR 2, at the boundary the loop actually crosses. `readTaskJournal`
    // used to answer `[]` for "there is nothing" and for "I could not read
    // it" alike; the second read as a budget nobody had spent, so every turn
    // renewed it and the loop had no bound left. Here the journal EXISTS and
    // the reader refuses it (EACCES / EMFILE / EIO), and the discriminating
    // outcome is: no reply queued, and no marker written either.
    const loop = loopRig({ plan: () => blockedByFindings })
    setJournalReader(() => null)
    try {
      loop.record.status = 'reviewing' as TaskStatus
      await loop.rig.runnerOptions().onTurnDone!(
        loop.record,
        turnIo(loop.project.path, loop.record),
      )
    } finally {
      setJournalReader(null)
    }
    expect(loop.rig.replies).toHaveLength(0)
    expect(markers(loop.project, loop.record)).toHaveLength(0)
    // And no round is charged either: the task keeps the review_ko a human
    // can still act on, rather than being parked on a budget nobody counted.
    expect(loop.record.status).toBe('review_ko')
    expect(loop.record.reason?.code).toBe('review_blocked')
    expect(loop.record.reason?.detail).toContain('journal could not be read')
    // Invariant n° 2: a refused budget without a word is a silent degradation.
    const stood = readTaskEvents(loop.project.path, loop.record.id).find(
      (e) => e.data.name === AUTO_FIX_NOT_STARTED_NAME,
    )
    expect(String(stood?.data.text)).toContain('unknown budget is never a full one')
  })

  test('an ABSENT journal is not an unreadable one: the first round still runs', async () => {
    // The other half of the same distinction, and the one that would make the
    // fix a regression if it were wrong: a task with no journal file at all
    // has genuinely spent no round, and must still get its first.
    const loop = loopRig({ plan: () => blockedByFindings })
    setJournalReader(() => '')
    try {
      loop.record.status = 'reviewing' as TaskStatus
      await loop.rig.runnerOptions().onTurnDone!(
        loop.record,
        turnIo(loop.project.path, loop.record),
      )
    } finally {
      setJournalReader(null)
    }
    expect(loop.rig.replies).toHaveLength(1)
    expect(loop.record.status).toBe('review_ko')
  })

  test('a journal that LOST a line still counts, but never in silence', async () => {
    // The count is derived from journal lines, so a line that does not parse
    // moves the budget — bounded (the loop still stops at `max` from wherever
    // the count resumed), never fatal, but never silent either.
    const loop = loopRig({ plan: () => blockedByFindings })
    appendFileSync(join(taskDir(loop.project.path, loop.record.id), 'events.jsonl'), '{"seq":\n')
    loop.record.status = 'reviewing' as TaskStatus
    await loop.rig.runnerOptions().onTurnDone!(loop.record, turnIo(loop.project.path, loop.record))
    const damaged = readTaskEvents(loop.project.path, loop.record.id).find(
      (e) => e.data.name === AUTO_FIX_JOURNAL_DAMAGED_NAME,
    )
    expect(damaged?.type).toBe('error')
    expect(String(damaged?.data.message)).toContain('could not be read')
    expect(damaged?.data.dropped).toBe(1)
    // ...and the round it qualifies did happen: this names a degradation, it
    // does not cancel the loop.
    expect(loop.rig.replies).toHaveLength(1)
  })

  test('an intact journal says nothing about damage', async () => {
    const loop = loopRig({ plan: () => blockedByFindings })
    await loop.drive()
    expect(
      readTaskEvents(loop.project.path, loop.record.id).filter(
        (e) => e.data.name === AUTO_FIX_JOURNAL_DAMAGED_NAME,
      ),
    ).toHaveLength(0)
  })

  test('the record NEVER grows a field for the counter', async () => {
    const loop = loopRig({ plan: () => blockedByFindings })
    await loop.drive()
    const persisted = loadTask(loop.project.path, loop.record.id)
    expect(persisted).not.toBeNull()
    const keys = Object.keys(persisted as TaskRecord)
    expect(keys.filter((key) => /round|cycle|fix/i.test(key))).toEqual([])
    expect(persisted?.version).toBe(1)
  })
})

// --- the fix loop, end to end on the REAL runner (T3.3) -------------------

describe('automatic fix loop, end to end (T3.3)', () => {
  const MAJOR: Finding = { file: 'feature.txt', line: 1, severity: 'major', message: 'still wrong' }

  /** Fake claude that edits the worktree, so the RUNNER has something to commit. */
  function writingAgent(
    seen: { prompt: string; capOccupied: number }[],
    cap: ReturnType<typeof createLoadCap>,
  ) {
    let n = 0
    return (options: AgentRunOptions): Promise<string> => {
      n += 1
      seen.push({ prompt: options.prompt, capOccupied: cap.snapshot().occupied })
      writeFileSync(join(options.cwd, 'feature.txt'), `revision ${n}\n`)
      const raw = `${JSON.stringify({ type: 'result', result: `revision ${n}` })}\n`
      options.onText?.(raw)
      return Promise.resolve(raw)
    }
  }

  /**
   * The e2e's own bound on the loop under test — a COUNTER, never a delay.
   *
   * Every temporal guard in this file (`until`'s timeout, bun's
   * `--timeout`) is a macro-task, and a fix loop that has lost its bound
   * chains its turns in micro-tasks: it starves the timer queue and none of
   * those guards is ever served. A broken loop therefore HANGS the run
   * instead of reddening it, which on a merge queue is a stuck job rather
   * than a failure — the one shape of red that reports nothing.
   *
   * So the reviewer counts its own cycles and, past the cap, stops blocking:
   * the loop has nothing left to retry, the event loop breathes again, and
   * `assert()` turns the runaway into the same clean red the unit rig's
   * `drive()` produces. The cap is generously above the real bound (2 rounds
   * = 3 cycles), so it can only fire on a loop that has genuinely lost it.
   */
  function cycleCap(max = 6) {
    let cycles = 0
    return {
      /** Counts one review cycle; false once the cap is blown. */
      spend(): boolean {
        cycles += 1
        return cycles <= max
      },
      get runaway(): boolean {
        return cycles > max
      },
      assert(): void {
        if (cycles > max) {
          throw new Error(`the loop never stopped: ${max} review cycles and still going`)
        }
      },
    }
  }

  /**
   * A review that always blocks on the same major finding, archive included —
   * until the cycle cap says the loop has run away, at which point it approves
   * so the run can end and report.
   */
  function alwaysBlocks(
    cwd: string,
    guard: ReturnType<typeof cycleCap>,
    before?: () => Promise<void>,
  ) {
    return async (record: TaskRecord, io: TaskTurnIo): Promise<void> => {
      await before?.()
      const base = fakeReviewRecord('request_changes', 'still not there')
      record.review_ref = archiveRecord(
        { ...base, review: { ...base.review, findings: [MAJOR] } },
        cwd,
      )
      io.emit({
        type: 'review_done',
        data: { verdict: 'request_changes', findings_count: 1, ref: record.review_ref },
      })
      if (!guard.spend()) {
        // Past the cap: stop feeding the loop so the process can finish and
        // the assertion below can speak. This is not the behaviour under
        // test — reaching it IS the failure.
        record.status = 'review_ok'
        delete record.reason
        io.persist()
        return
      }
      record.status = 'review_ko'
      record.reason = taskReason('review_blocked', 'feature.txt:1 still wrong')
      io.persist()
    }
  }

  test('the fix turns really run: bounded, committed by the runner, under the machine cap', async () => {
    const project = register(makeRepo())
    const cap = createLoadCap(2)
    const seen: { prompt: string; capOccupied: number }[] = []
    const guard = cycleCap()
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      loadCap: cap,
      runAgentFn: writingAgent(seen, cap),
      reviewTurnFn: alwaysBlocks(project.path, guard),
    })
    const created = await manager.create(project.id, {
      title: 'looped',
      prompt: 'p',
      autoShip: false,
    })
    if (!created.ok) {
      throw new Error('task was not created')
    }
    const id = created.record.id
    // Shut the manager down on EVERY exit, assertion failures included: a real
    // runner left alive holds a queue, a load-cap subscription and an in-flight
    // promise, and the whole `bun test` process then hangs on them instead of
    // reporting the failure.
    try {
      // `guard.runaway` FIRST, and it is what makes this wait finite: a loop
      // that lost its bound never lets the timeout fire (see `cycleCap`), so
      // the only exit from a runaway is the counter the reviewer keeps.
      await until(
        () => guard.runaway || loadTask(project.path, id)?.status === 'waiting_for_you',
        15000,
      )
    } finally {
      await manager.shutdown()
    }
    guard.assert()

    // One human turn plus exactly TWO automatic rounds, then it stops.
    expect(seen).toHaveLength(3)
    expect(seen[0]?.prompt).toContain('p')
    for (const round of [1, 2]) {
      expect(seen[round]?.prompt).toContain('still wrong')
      expect(seen[round]?.prompt).toContain('applying code review fixes')
    }
    // Every turn — the automatic ones included — held a slot of the machine
    // cap while it ran. A fix turn wired around `launch()` would show 0 here.
    expect(seen.map((s) => s.capOccupied >= 1)).toEqual([true, true, true])

    const record = loadTask(project.path, id)
    expect(record?.status).toBe('waiting_for_you')
    expect(record?.reason?.code).toBe('review_blocked')
    expect(record?.turns).toHaveLength(3)
    const events = readTaskEvents(project.path, id)
    // The commit of each fix turn comes from the RUNNER at the end of turn —
    // the agent stub above never runs git at all.
    expect(events.filter((e) => e.type === 'commit')).toHaveLength(3)
    expect(events.filter((e) => e.type === 'turn_started')).toHaveLength(3)
    expect(autoFixRoundsUsed(events)).toBe(2)
    // Nothing leaked: every slot taken by a turn or a round came back.
    expect(cap.snapshot().occupied).toBe(0)
  })

  test('a BLIND journal bounds the loop instead of feeding it a fresh budget', async () => {
    // MAJOR 2, end to end on the real runner. The journal keeps being WRITTEN
    // — appends are untouched — but every read of it fails (EACCES, EMFILE
    // under a descriptor storm, EIO). The count the bound rests on is derived
    // from that journal, so a read that answers "nothing" instead of "I could
    // not tell" hands the loop a full budget on every single turn, and the
    // only thing left stopping it is whatever the test rig runs out of first.
    //
    // The discriminating number is the AGENT TURN COUNT: 1 here, 9-and-going
    // before the fix. The cycle cap is what makes the difference visible as a
    // red rather than as a hang.
    const project = register(makeRepo())
    const cap = createLoadCap(2)
    const seen: { prompt: string; capOccupied: number }[] = []
    const guard = cycleCap()
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      loadCap: cap,
      runAgentFn: writingAgent(seen, cap),
      reviewTurnFn: alwaysBlocks(project.path, guard),
    })
    const created = await manager.create(project.id, {
      title: 'blind',
      prompt: 'p',
      autoShip: false,
    })
    if (!created.ok) {
      throw new Error('task was not created')
    }
    const id = created.record.id
    try {
      // Blinded only AFTER the task exists, so the failure under test is the
      // journal read and not the creation.
      setJournalReader(() => null)
      await until(
        () => guard.runaway || (loadTask(project.path, id)?.turns.length ?? 0) >= 1,
        15000,
      )
      // Let any round the loop might still be chaining land.
      await until(() => guard.runaway || seen.length > 1, 1000).catch(() => {})
    } finally {
      setJournalReader(null)
      await manager.shutdown()
    }
    guard.assert()
    // The human's own turn ran; NO automatic round followed it, because the
    // budget could not be counted and an uncounted budget is never a full one.
    expect(seen).toHaveLength(1)
    const record = loadTask(project.path, id)
    // And the task is left where a human can still act on it — review_ko, not
    // parked: nothing was tried, so nothing was exhausted.
    expect(record?.status).toBe('review_ko')
    expect(record?.reason?.detail).toContain('journal could not be read')
  })

  test('a fix turn QUEUES for its machine slot — it never short-circuits the cap, and never deadlocks', async () => {
    const project = register(makeRepo())
    const cap = createLoadCap(1)
    const seen: { prompt: string; capOccupied: number }[] = []
    const guard = cycleCap()
    const slot: { release: (() => void) | null } = { release: null }
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      loadCap: cap,
      runAgentFn: writingAgent(seen, cap),
      // The FIRST review takes the machine's only slot and keeps it: the fix
      // round the loop is about to queue has nowhere to run yet.
      reviewTurnFn: alwaysBlocks(project.path, guard, async () => {
        slot.release ??= await cap.acquire('review')
      }),
    })
    const created = await manager.create(project.id, {
      title: 'starved',
      prompt: 'p',
      autoShip: false,
    })
    if (!created.ok) {
      throw new Error('task was not created')
    }
    const id = created.record.id

    try {
      // The end-of-turn hook RESOLVED even though the machine is full — it
      // never waits on the round it queued — and the round is parked, named.
      await until(
        () =>
          readTaskEvents(project.path, id).some(
            (e) => e.type === 'queue' && e.data.name === 'machine_busy',
          ),
        15000,
      )
      const waiting = loadTask(project.path, id)
      expect(waiting?.status).toBe('queued')
      expect(waiting?.reason?.code).toBe('resource_busy')
      // Nothing ran on the stolen slot: still just the first turn's agent.
      expect(seen).toHaveLength(1)

      // The slot comes back; the parked round starts on its own.
      slot.release?.()
      await until(
        () => guard.runaway || loadTask(project.path, id)?.status === 'waiting_for_you',
        15000,
      )
      guard.assert()
      expect(seen.length).toBeGreaterThanOrEqual(2)
      expect(seen[1]?.prompt).toContain('still wrong')
      expect(cap.snapshot().occupied).toBe(0)
    } finally {
      // Same reason as the test above — plus the held slot itself, which an
      // early failure would otherwise leave taken for the rest of the file.
      slot.release?.()
      await manager.shutdown()
    }
  })
})

// --- T3.7 × T3.6 × T3.5: the cycle mirrored onto the ticket ----------------
//
// These tests are about the WIRE, not the mechanisms: `syncCycleLabel`,
// `cycleLabelEvent` and `publishTaskRecap` are each proven in their own file,
// and all three used to have no production caller at all — deleting them from
// this module left every suite green. What is asserted here is therefore, in
// every case, an argv or a journal line that only the CALL SITE can produce.
describe('cycle labels and the recap, wired onto a real run', () => {
  const jsonl = (events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
  const claudeStream = (response: string) =>
    jsonl([
      { type: 'system', subtype: 'init', session_id: 'sess-cycle' },
      { type: 'result', result: response },
    ])

  const SET_LABELS = '--raw-field=labels[]='

  /**
   * One forge, stateful about the issue's labels, recording only the WRITES.
   * Reads are noise here (admission, snapshot reconciliation and every pose
   * spend one each); what the wiring is judged on is what it wrote, and in
   * which order.
   */
  function cycleForge(
    opts: {
      body: string
      labels?: string[]
      catalog?: string[]
      comments?: string[]
      failLabelWrite?: boolean
      /** Refuses the FIRST write of this label only; every later one lands. */
      failLabelWriteOnce?: string
      failClose?: boolean
    } = { body: '' },
  ) {
    /** Write operations, in the order the forge saw them. */
    const writes: string[] = []
    const refusedOnce = new Set<string>()
    const labels = [...(opts.labels ?? [])]
    const issueJson = () =>
      JSON.stringify({
        number: 42,
        title: 'Fix flaky worktree cleanup',
        body: opts.body,
        state: 'OPEN',
        labels: labels.map((name) => ({ name })),
        author: { id: 'u1', is_bot: false, login: 'octocat', name: 'The Octocat' },
        createdAt: '2026-07-20T09:00:00Z',
        updatedAt: '2026-07-28T10:00:00Z',
        url: 'https://github.com/acme/repo/issues/42',
      })
    const rig = forgeRig((call) => {
      const [verb, sub] = call.args
      if (verb === 'issue' && sub === 'view') {
        // `--json comments` is `listIssueComments`; anything else is `getIssue`
        // (the label pose's read, the admission's, the reconciliation's).
        if (call.args.includes('comments')) {
          return {
            kind: 'ok',
            stdout: JSON.stringify({
              comments: (opts.comments ?? []).map((body) => ({
                body,
                author: { login: 'octocat' },
                createdAt: '2026-08-01T09:00:00Z',
              })),
            }),
          }
        }
        return { kind: 'ok', stdout: issueJson() }
      }
      if (verb === 'label' && sub === 'list') {
        return {
          kind: 'ok',
          stdout: JSON.stringify((opts.catalog ?? []).map((name) => ({ name }))),
        }
      }
      if (verb === 'label' && sub === 'create') {
        writes.push(`label create ${String(call.args[2])}`)
        return { kind: 'ok', stdout: '' }
      }
      if (verb === 'api') {
        const next = call.args
          .filter((arg) => arg.startsWith(SET_LABELS))
          .map((arg) => arg.slice(SET_LABELS.length))
        writes.push(`labels ${next.join(',')}`)
        const once = opts.failLabelWriteOnce
        if (once !== undefined && next.includes(once) && !refusedOnce.has(once)) {
          refusedOnce.add(once)
          return { kind: 'error', message: 'gh: HTTP 502 Bad Gateway (labels)' }
        }
        if (opts.failLabelWrite) {
          return { kind: 'error', message: 'gh: HTTP 502 Bad Gateway (labels)' }
        }
        labels.splice(0, labels.length, ...next)
        return { kind: 'ok', stdout: '' }
      }
      if (verb === 'issue' && sub === 'comment') {
        writes.push('comment')
        return { kind: 'ok', stdout: '' }
      }
      if (verb === 'issue' && sub === 'close') {
        writes.push('close')
        return opts.failClose
          ? { kind: 'error', message: 'gh: HTTP 502 Bad Gateway (close)' }
          : { kind: 'ok', stdout: '' }
      }
      return { kind: 'error', message: `unexpected argv: ${call.args.join(' ')}` }
    })
    return { ...rig, writes, currentLabels: () => [...labels] }
  }

  /** Every cycle label this run wrote, in order — the pose trace on its own. */
  const posed = (writes: readonly string[]): string[] =>
    writes.filter((op) => op.startsWith('labels ')).map((op) => op.slice('labels '.length))

  type RunOpts = {
    /** The project's `.codesema/config.json` opt-in. Absent means never declared. */
    cycleLabels?: boolean
    /** What the merge step answers. Absent means the default `human` policy: no merge. */
    merged?: boolean
    /** Whether the ship writes a recap.json — the document `publishTaskRecap` reads. */
    recap?: boolean
    forge: ReturnType<typeof cycleForge>
    /** Skips `manager.create({issue})`: a task with no ticket at all. */
    ticketless?: boolean
  }

  /**
   * One whole nominal run — create, turn, review OK, auto-ship, merge step —
   * awaited to its end through `shutdown()`, which drains the poses started
   * from hooks that have nothing to await them with.
   */
  async function runCycle(opts: RunOpts) {
    const project = register(makeRepoWithRemote())
    if (opts.cycleLabels !== undefined) {
      saveRepoConfig(project.path, { forgeCycleLabels: opts.cycleLabels })
    }
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: (options: AgentRunOptions) => {
        const raw = claudeStream('all done')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
      reviewTurnFn: (record, io) => {
        record.status = 'review_ok'
        io.persist()
        return Promise.resolve()
      },
      shipTaskFn: (options: ShipTaskOptions) => {
        if (opts.recap) {
          // What the real ship leaves behind, and the only document
          // `publishTaskRecap` will agree to publish.
          writeTaskRecap(options.cwd, options.task.id, {
            version: 1,
            summary: 'Rewired the worktree cleanup.',
            changes: ['worktree: prune before delete'],
            decisions: [],
            files: ['src/task-worktree.ts'],
            tests: [{ command: 'bun test', status: 'passed' }],
            branch: options.task.branch,
          })
        }
        return Promise.resolve({
          pushed: true,
          mrUrl: 'https://github.com/acme/repo/pull/9',
          note: null,
        })
      },
      issueExecFn: opts.forge.execFn,
      ...(opts.merged
        ? {
            mergeSettings: {
              policy: 'auto' as const,
              deleteBranch: false,
              allowMergeWithoutChecks: false,
            },
            mergeTaskFn: () =>
              Promise.resolve({
                kind: 'merged' as const,
                cli: 'gh' as const,
                url: 'https://github.com/acme/repo/pull/9',
                readiness: { ready: true, conditions: [], blockers: [] },
                events: [{ type: 'merge' as const, data: { name: 'merged', cli: 'gh' } }],
              }),
          }
        : {}),
    })
    const created = await manager.create(project.id, {
      autoShip: true,
      ...(opts.ticketless
        ? { title: 'No ticket at all', prompt: 'do it' }
        : { issue: VALID_ISSUE_REF }),
    })
    if (!created.ok) {
      throw new Error(`create refused: ${created.error}`)
    }
    const id = created.record.id
    // Bounded on a COUNT of journal lines, never on a duration: the merge step
    // writes its own line unconditionally, so this is a wait for a fact the
    // run always produces — a regression turns into an assertion below, not
    // into a timeout that reads the same as a slow machine.
    await until(() => readTaskEvents(project.path, id).some((e) => e.type === 'merge'))
    // Drains the poses `onTask` / `create()` / `ship()` could not await: after
    // this, everything this run will ever write to the forge is written.
    await manager.shutdown()
    return { project, manager, id, events: () => readTaskEvents(project.path, id) }
  }

  test('a project that never opted in writes no cycle label at all — and still gets its recap', async () => {
    const forge = cycleForge({ body: conformingTicketBody(), catalog: [] })
    const run = await runCycle({ forge, merged: true, recap: true })

    // The opt-in half: not one label write, not even a catalog read, across
    // admission → running → reviewing → shipped → merged. `disabled` leaves
    // `syncCycleLabel` before a single forge argv is BUILT, and the wiring is
    // what has to preserve that.
    expect(posed(forge.writes)).toEqual([])
    expect(forge.calls.some((c) => c.args[0] === 'label')).toBe(false)
    expect(forge.calls.some((c) => c.args[0] === 'api')).toBe(false)
    // ...and the recap publication is NOT behind that opt-in: a merge that
    // landed still comments and still closes. The two are wired together and
    // gated apart, which is the whole point of asserting them in one test.
    expect(forge.writes).toEqual(['comment', 'close'])
    expect(run.events().some((e) => e.type === 'issue' && e.data.name === 'recap_posted')).toBe(
      true,
    )
    expect(run.events().some((e) => e.type === 'issue' && e.data.name === 'closed')).toBe(true)
  })

  test('an opted-in run poses one label per transition, then comment → codesema:merged → close', async () => {
    const forge = cycleForge({ body: conformingTicketBody(), catalog: [] })
    const run = await runCycle({ forge, cycleLabels: true, merged: true, recap: true })

    // ONE label per transition, and only where the label actually changes:
    // 'review_ok' and 'shipped' both mean `codesema:reviewing`, so the three
    // transitions that share it cost one write, not three.
    expect(posed(forge.writes)).toEqual([
      'codesema:queued',
      'codesema:in-progress',
      'codesema:reviewing',
      'codesema:merged',
    ])
    // Lazily created, once each, and only the ones this run actually needed:
    // `codesema:blocked` never appears in a repo whose tasks never block.
    expect(forge.writes.filter((op) => op.startsWith('label create'))).toEqual([
      'label create codesema:queued',
      'label create codesema:in-progress',
      'label create codesema:reviewing',
      'label create codesema:merged',
    ])
    // THE order T3.5's decision 3 fixes, asserted as an order and not as a
    // set: the recap comment, then the label, then the closure. Reversing any
    // two of them is what this reads.
    const at = (op: string) => forge.writes.indexOf(op)
    expect(at('comment')).toBeGreaterThanOrEqual(0)
    expect(at('comment')).toBeLessThan(at('labels codesema:merged'))
    expect(at('labels codesema:merged')).toBeLessThan(at('close'))
    // The issue is left carrying exactly one cycle label, and it is the one
    // no STATUS maps to.
    expect(forge.currentLabels()).toEqual(['codesema:merged'])
    // A landed merge moves no status (T3.6) and a pose is not news: no
    // 'label_not_posed' line on a run where everything landed.
    expect(loadTask(run.project.path, run.id)?.status).toBe('shipped')
    expect(loadTask(run.project.path, run.id)?.reason).toBeUndefined()
    expect(run.events().some((e) => e.data.name === 'label_not_posed')).toBe(false)
    // SIX issue reads for the whole run, and the exact figure is the point:
    // one for the admission, one for the pre-review snapshot reconciliation,
    // and ONE PER POSE — four, not six. `review_ok` and `shipped` are
    // transitions that say nothing new about the ticket, and the wiring
    // recognises that BEFORE spending a round trip on `syncCycleLabel`'s own
    // `unchanged`. It is the same guard that keeps a heartbeat — which lands
    // on `onTask` exactly like a transition does — from reading the issue
    // every thirty seconds for the length of a turn.
    expect(
      forge.calls.filter(
        (c) => c.args[0] === 'issue' && c.args[1] === 'view' && !c.args.includes('comments'),
      ).length,
    ).toBe(6)
  })

  test('a merge the gate refuses hands the task back AND says so on the ticket', async () => {
    const forge = cycleForge({ body: conformingTicketBody(), catalog: [] })
    const project = register(makeRepoWithRemote())
    saveRepoConfig(project.path, { forgeCycleLabels: true })
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: (options: AgentRunOptions) => {
        const raw = claudeStream('all done')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
      reviewTurnFn: (record, io) => {
        record.status = 'review_ok'
        io.persist()
        return Promise.resolve()
      },
      shipTaskFn: () => Promise.resolve({ pushed: true, mrUrl: null, note: null }),
      issueExecFn: forge.execFn,
      // The REAL gate under `auto`: no archived review, no criteria verdicts —
      // refused long before any merge command is built.
      mergeSettings: { policy: 'auto', deleteBranch: false, allowMergeWithoutChecks: false },
    })
    const created = await manager.create(project.id, { autoShip: true, issue: VALID_ISSUE_REF })
    if (!created.ok) {
      throw new Error(`create refused: ${created.error}`)
    }
    await until(() =>
      readTaskEvents(project.path, created.record.id).some(
        (e) => e.type === 'merge' && e.data.name === 'refused',
      ),
    )
    await manager.shutdown()

    expect(loadTask(project.path, created.record.id)?.status).toBe('waiting_for_you')
    // The hand-back is a transition like any other, and the ticket says it:
    // the four statuses that stop needing the machine and start needing a
    // person all read `codesema:blocked` from the outside.
    expect(posed(forge.writes)).toEqual([
      'codesema:queued',
      'codesema:in-progress',
      'codesema:reviewing',
      'codesema:blocked',
    ])
    // A refused merge is not a merge: no recap comment, no closure, and no
    // `codesema:merged` anywhere near this ticket.
    expect(forge.writes).not.toContain('comment')
    expect(forge.writes).not.toContain('close')
    expect(forge.currentLabels()).toEqual(['codesema:blocked'])
  })

  test('a HUMAN ship out of a review_ko moves the ticket off codesema:blocked', async () => {
    // The one transition that never reaches `onTask`: `ship()` persists and
    // broadcasts on its own, so this label is mirrored from the ship's own
    // call site or from nowhere. The auto-ship path cannot show it — `shipped`
    // shares `codesema:reviewing` with the `review_ok` it chains from — so the
    // discriminating input is a ship the human clicks on a KO review, where
    // the ticket really does move from `codesema:blocked`.
    const forge = cycleForge({ body: conformingTicketBody(), catalog: [] })
    const project = register(makeRepoWithRemote())
    saveRepoConfig(project.path, { forgeCycleLabels: true })
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: (options: AgentRunOptions) => {
        const raw = claudeStream('all done')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
      reviewTurnFn: (record, io) => {
        record.status = 'review_ko'
        io.persist()
        return Promise.resolve()
      },
      shipTaskFn: () => Promise.resolve({ pushed: true, mrUrl: null, note: null }),
      issueExecFn: forge.execFn,
    })
    const created = await manager.create(project.id, { autoShip: false, issue: VALID_ISSUE_REF })
    if (!created.ok) {
      throw new Error(`create refused: ${created.error}`)
    }
    await until(() => loadTask(project.path, created.record.id)?.status === 'review_ko')
    expect(await manager.ship(project.id, created.record.id)).toEqual({ ok: true })
    await manager.shutdown()

    expect(loadTask(project.path, created.record.id)?.status).toBe('shipped')
    expect(posed(forge.writes)).toEqual([
      'codesema:queued',
      'codesema:in-progress',
      'codesema:reviewing',
      'codesema:blocked',
      'codesema:reviewing',
    ])
    expect(forge.currentLabels()).toEqual(['codesema:reviewing'])
  })

  test('the turn does not end until the ticket has been written: no background publication', async () => {
    // TRAP N° 1 OF THIS BATCH, and the one no assertion on a finished run can
    // see: turning `await publishMergedOutcome(...)` into `void
    // publishMergedOutcome(...)` leaves every outcome of every other test in
    // this file identical, because a rig that answers instantly finishes the
    // publication before anyone looks. What the shortcut actually breaks is a
    // promise about TIME — the end of a turn releases the project's claim, and
    // a claim released with the comment still in flight lets the NEXT task of
    // that project start on a ticket this one has not finished writing (and,
    // on a Ctrl-C, lets the process drain out from under it).
    //
    // So the assertion is an ORDER between two independent facts: the issue is
    // closed, and the next task's agent starts. One forge answer is held open
    // to make the two separable at all.
    const log: string[] = []
    /** A holder, not a bare `let`: the assignment happens inside a callback. */
    const gate: { release: (() => void) | null } = { release: null }
    const forge = cycleForge({ body: conformingTicketBody(), catalog: [] })
    const project = register(makeRepoWithRemote())
    saveRepoConfig(project.path, { forgeCycleLabels: true })
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 10_000,
      runAgentFn: (options: AgentRunOptions) => {
        log.push(options.prompt.includes('wait your turn') ? 'agent:next' : 'agent:first')
        const raw = claudeStream('all done')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
      reviewTurnFn: (record, io) => {
        record.status = 'review_ok'
        io.persist()
        return Promise.resolve()
      },
      shipTaskFn: (options: ShipTaskOptions) => {
        writeTaskRecap(options.cwd, options.task.id, {
          version: 1,
          summary: 'Rewired the worktree cleanup.',
          changes: [],
          decisions: [],
          files: [],
          tests: [],
          branch: options.task.branch,
        })
        return Promise.resolve({ pushed: true, mrUrl: null, note: null })
      },
      issueExecFn: ((cli, args, cwd) => {
        if (args[0] === 'issue' && args[1] === 'comment') {
          log.push('comment-asked')
          // Held OPEN: the publication cannot finish until this is released.
          return new Promise((resolve) => {
            gate.release = () => {
              resolve(forge.execFn(cli, args, cwd))
            }
          })
        }
        if (args[0] === 'issue' && args[1] === 'close') {
          log.push('closed')
        }
        return forge.execFn(cli, args, cwd)
      }) as ForgeIssuesExecFn,
      mergeSettings: { policy: 'auto', deleteBranch: false, allowMergeWithoutChecks: false },
      mergeTaskFn: () =>
        Promise.resolve({
          kind: 'merged' as const,
          cli: 'gh' as const,
          url: null,
          readiness: { ready: true, conditions: [], blockers: [] },
          events: [{ type: 'merge' as const, data: { name: 'merged', cli: 'gh' } }],
        }),
    })
    const first = await manager.create(project.id, { autoShip: true, issue: VALID_ISSUE_REF })
    const second = await manager.create(project.id, {
      autoShip: false,
      title: 'next',
      prompt: 'wait your turn',
    })
    if (!first.ok || !second.ok) {
      throw new Error('create refused')
    }
    try {
      await until(() => log.includes('comment-asked'))
      // A COUNTER, never a clock: the answer is released as soon as the second
      // task's agent has started — which, if the publication is properly
      // awaited, never happens — and otherwise after a bounded number of
      // polls, so a correct build finishes instead of hanging on a promise
      // nobody will keep.
      for (let poll = 0; poll < 200 && !log.includes('agent:next'); poll += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      gate.release?.()
      await until(() => log.includes('closed') && log.includes('agent:next'), 10_000)
      // The whole assertion: the ticket was finished BEFORE the project moved on.
      expect(log.indexOf('closed')).toBeLessThan(log.indexOf('agent:next'))
    } finally {
      gate.release?.()
      await manager.shutdown()
    }
  })

  test('a pose that failed is retried by the next transition that wants the same label', async () => {
    // The discriminating input is the ONE case a run where everything fails
    // cannot show: a single refused write, followed by a LATER transition
    // asking for the SAME label. `reviewing`, `review_ok` and `shipped` all
    // mean `codesema:reviewing`, so the second of them is the retry — but only
    // if the failure was not remembered as a pose. Remember it and the ticket
    // stays on `codesema:in-progress` for good, silently, under a journal line
    // that promised a correction which never comes.
    const forge = cycleForge({
      body: conformingTicketBody(),
      catalog: [],
      failLabelWriteOnce: 'codesema:reviewing',
    })
    const project = register(makeRepoWithRemote())
    saveRepoConfig(project.path, { forgeCycleLabels: true })
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: (options: AgentRunOptions) => {
        const raw = claudeStream('all done')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
      reviewTurnFn: async (record, io) => {
        // Held until the 'reviewing' pose has actually FAILED and said so, so
        // the transition below is a later one and not a concurrent one — two
        // poses of the same label in flight together are meant to collapse
        // into one, which is a different rule and not the one under test.
        // A COUNTER, not a clock: a build that never journals the failure
        // falls out of the loop and fails the assertion below instead of
        // hanging on a condition that will not come.
        for (
          let poll = 0;
          poll < 300 &&
          !readTaskEvents(project.path, record.id).some((e) => e.data.name === 'label_not_posed');
          poll += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 5))
        }
        record.status = 'review_ok'
        io.persist()
      },
      shipTaskFn: () => Promise.resolve({ pushed: true, mrUrl: null, note: null }),
      issueExecFn: forge.execFn,
    })
    const created = await manager.create(project.id, { autoShip: true, issue: VALID_ISSUE_REF })
    if (!created.ok) {
      throw new Error(`create refused: ${created.error}`)
    }
    await until(() => loadTask(project.path, created.record.id)?.status === 'shipped', 10_000)
    await manager.shutdown()

    expect(posed(forge.writes)).toEqual([
      'codesema:queued',
      'codesema:in-progress',
      'codesema:reviewing',
      'codesema:reviewing',
    ])
    // The retry landed: the ticket ends up telling the truth.
    expect(forge.currentLabels()).toEqual(['codesema:reviewing'])
    // ...and the one failure was still named, exactly once.
    expect(
      readTaskEvents(project.path, created.record.id).filter(
        (e) => e.type === 'issue' && e.data.name === 'label_not_posed',
      ),
    ).toHaveLength(1)
  })

  test('every degradation of this wiring reaches the bus, not only the journal', async () => {
    // Invariant 2 has THREE legs — a readable reason, a journal line, and the
    // API surfacing that journal — and the third is the one a `readTaskEvents`
    // assertion cannot see: `publishTaskRecap` appends its own lines to disk,
    // so a caller that forgets to broadcast them leaves every on-disk
    // assertion green while no live workspace ever learns what happened.
    const envelopes: TaskEnvelope[] = []
    const forge = cycleForge({
      body: conformingTicketBody(),
      catalog: [],
      failLabelWrite: true,
      failClose: true,
    })
    const project = register(makeRepoWithRemote())
    saveRepoConfig(project.path, { forgeCycleLabels: true })
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: (options: AgentRunOptions) => {
        const raw = claudeStream('all done')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
      reviewTurnFn: (record, io) => {
        record.status = 'review_ok'
        io.persist()
        return Promise.resolve()
      },
      shipTaskFn: (options: ShipTaskOptions) => {
        writeTaskRecap(options.cwd, options.task.id, {
          version: 1,
          summary: 'Rewired the worktree cleanup.',
          changes: [],
          decisions: [],
          files: [],
          tests: [],
          branch: options.task.branch,
        })
        return Promise.resolve({ pushed: true, mrUrl: null, note: null })
      },
      issueExecFn: forge.execFn,
      mergeSettings: { policy: 'auto', deleteBranch: false, allowMergeWithoutChecks: false },
      mergeTaskFn: () =>
        Promise.resolve({
          kind: 'merged' as const,
          cli: 'gh' as const,
          url: null,
          readiness: { ready: true, conditions: [], blockers: [] },
          events: [{ type: 'merge' as const, data: { name: 'merged', cli: 'gh' } }],
        }),
    })
    manager.subscribe((envelope) => envelopes.push(envelope))
    const created = await manager.create(project.id, { autoShip: true, issue: VALID_ISSUE_REF })
    if (!created.ok) {
      throw new Error(`create refused: ${created.error}`)
    }
    await until(() =>
      readTaskEvents(project.path, created.record.id).some((e) => e.type === 'merge'),
    )
    await manager.shutdown()

    const broadcast = envelopes
      .filter((e) => e.event.name === 'task_event')
      .map((e) => e.event.data as TaskEvent)
      .filter((event) => event.type === 'issue')
      .map((event) => event.data.name)
    // T3.5's own lines, appended by `publishTaskRecap` and broadcast by its
    // caller...
    expect(broadcast).toContain('recap_posted')
    expect(broadcast).toContain('close_unreachable')
    // ...and T3.7's, appended and broadcast by the pose's call site.
    expect(broadcast).toContain('label_not_posed')
  })

  test('abandoning a merged task never walks the ticket back off codesema:merged', async () => {
    // `codesema:merged` is the one label NO status maps to, and 'shipped' is a
    // status the record keeps for good. An abandon — the ordinary way a human
    // reclaims a landed task's worktree — re-persists that very 'shipped',
    // which reaches `onTask` like any transition would. Mirroring it would
    // relabel the ticket `codesema:reviewing` and undo, on the forge, the one
    // thing the whole merge chain exists to say.
    const forge = cycleForge({ body: conformingTicketBody(), catalog: [] })
    const run = await runCycle({ forge, cycleLabels: true, merged: true, recap: true })
    expect(forge.currentLabels()).toEqual(['codesema:merged'])
    const before = forge.writes.length

    expect(await run.manager.abandon(run.project.id, run.id)).toMatchObject({ ok: true })
    await run.manager.shutdown()

    // Not one more forge write, and the ticket still says what happened.
    expect(forge.writes).toHaveLength(before)
    expect(forge.currentLabels()).toEqual(['codesema:merged'])
  })

  test('a task with no ticket asks the forge nothing, opt-in or not', async () => {
    const forge = cycleForge({ body: conformingTicketBody(), catalog: [] })
    await runCycle({ forge, cycleLabels: true, merged: true, recap: true, ticketless: true })
    expect(forge.calls).toEqual([])
  })

  test('a label write the forge refuses changes no status, and says so in the journal', async () => {
    const forge = cycleForge({ body: conformingTicketBody(), catalog: [], failLabelWrite: true })
    const run = await runCycle({ forge, cycleLabels: true, merged: true, recap: true })

    // 1. The status is IDENTICAL to the nominal run: a label is an effect of
    //    the transition, never a condition of it, and nothing in this module
    //    lets a forge failure reach `saveTask`.
    const record = loadTask(run.project.path, run.id)
    expect(record?.status).toBe('shipped')
    expect(record?.reason).toBeUndefined()
    // 2. The merge's own work still happened, in its order: a label that would
    //    not be written must not cost the ticket its recap or its closure.
    expect(forge.writes.filter((op) => !op.startsWith('label'))).toEqual(['comment', 'close'])
    // 3. And it is NOT silent: one readable line per failed pose, on the
    //    'issue' domain, with the D2 code ADDED beside the message.
    const failures = run
      .events()
      .filter((e) => e.type === 'issue' && e.data.name === 'label_not_posed')
    expect(failures.length).toBeGreaterThanOrEqual(4)
    expect(failures.map((e) => e.data.label)).toContain('codesema:merged')
    expect(failures.every((e) => e.reason_code === 'forge_unreachable')).toBe(true)
    expect(failures.every((e) => e.data.step === 'write')).toBe(true)
    expect(String(failures[0]?.data.message)).toContain("the task's status is unaffected")
  })

  test('a failed pose is retried at the next transition, never remembered as posed', async () => {
    const forge = cycleForge({ body: conformingTicketBody(), catalog: [], failLabelWrite: true })
    await runCycle({ forge, cycleLabels: true, merged: true, recap: true })
    // Every transition tried, none of them believed the ticket already said
    // what it never said: the claim staked before the round trip is dropped on
    // a failure, which is exactly what `cycleLabelEvent`'s own message
    // promises ("to be corrected at the next transition").
    expect(posed(forge.writes)).toEqual([
      'codesema:queued',
      'codesema:in-progress',
      'codesema:reviewing',
      'codesema:merged',
    ])
  })

  test('a merge whose recap never made it still poses codesema:merged, and never closes the issue', async () => {
    // No recap.json on disk: the publication is refused LOCALLY, the forge is
    // perfectly healthy, and the merge is still a fact about the branch.
    const forge = cycleForge({ body: conformingTicketBody(), catalog: [] })
    const run = await runCycle({ forge, cycleLabels: true, merged: true, recap: false })

    expect(forge.writes).not.toContain('comment')
    // An issue closed without its recap is a ticket closed without a trace.
    expect(forge.writes).not.toContain('close')
    expect(run.events().some((e) => e.type === 'issue' && e.data.name === 'recap_missing')).toBe(
      true,
    )
    // ...and the label is posed all the same, LAST, because the merge happened.
    expect(posed(forge.writes).at(-1)).toBe('codesema:merged')
  })

  test('a closure the forge refuses is named, and still leaves the label posed', async () => {
    const forge = cycleForge({ body: conformingTicketBody(), catalog: [], failClose: true })
    const run = await runCycle({ forge, cycleLabels: true, merged: true, recap: true })

    const closeFailed = run
      .events()
      .find((e) => e.type === 'issue' && e.data.name === 'close_unreachable')
    expect(closeFailed).toBeDefined()
    expect(closeFailed?.reason_code).toBe('forge_unreachable')
    expect(String(closeFailed?.data.message)).toContain('carries the recap but could not be closed')
    expect(forge.currentLabels()).toEqual(['codesema:merged'])
    // Still no status moved by any of it.
    expect(loadTask(run.project.path, run.id)?.status).toBe('shipped')
  })

  test('a recap already on the ticket is not sent twice, and the issue is still closed', async () => {
    const marker = `<!-- ${RECAP_MARKER_PREFIX}`
    const forge = cycleForge({ body: conformingTicketBody(), catalog: [] })
    const project = register(makeRepoWithRemote())
    saveRepoConfig(project.path, { forgeCycleLabels: true })
    // The idempotence guard needs the TASK's own id, which only exists once
    // the task does — so the marker is planted from the ship stub, on the very
    // task about to be published.
    const seen: string[] = []
    const manager = createTaskManager({
      command: 'claude -p',
      timeoutMs: 5000,
      runAgentFn: (options: AgentRunOptions) => {
        const raw = claudeStream('all done')
        options.onText?.(raw)
        return Promise.resolve(raw)
      },
      reviewTurnFn: (record, io) => {
        record.status = 'review_ok'
        io.persist()
        return Promise.resolve()
      },
      shipTaskFn: (options: ShipTaskOptions) => {
        seen.push(`${marker}${options.task.id} -->`)
        writeTaskRecap(options.cwd, options.task.id, {
          version: 1,
          summary: 'Rewired the worktree cleanup.',
          changes: [],
          decisions: [],
          files: [],
          tests: [],
          branch: options.task.branch,
        })
        return Promise.resolve({ pushed: true, mrUrl: null, note: null })
      },
      issueExecFn: ((cli, args, cwd) => {
        if (args[0] === 'issue' && args[1] === 'view' && args.includes('comments')) {
          return Promise.resolve({
            kind: 'ok' as const,
            stdout: JSON.stringify({
              comments: seen.map((body) => ({
                body,
                author: { login: 'octocat' },
                createdAt: '2026-08-01T09:00:00Z',
              })),
            }),
          })
        }
        return forge.execFn(cli, args, cwd)
      }) as ForgeIssuesExecFn,
      mergeSettings: { policy: 'auto', deleteBranch: false, allowMergeWithoutChecks: false },
      mergeTaskFn: () =>
        Promise.resolve({
          kind: 'merged' as const,
          cli: 'gh' as const,
          url: null,
          readiness: { ready: true, conditions: [], blockers: [] },
          events: [{ type: 'merge' as const, data: { name: 'merged', cli: 'gh' } }],
        }),
    })
    const created = await manager.create(project.id, { autoShip: true, issue: VALID_ISSUE_REF })
    if (!created.ok) {
      throw new Error(`create refused: ${created.error}`)
    }
    await until(() =>
      readTaskEvents(project.path, created.record.id).some((e) => e.type === 'merge'),
    )
    await manager.shutdown()

    const events = readTaskEvents(project.path, created.record.id)
    expect(events.some((e) => e.type === 'issue' && e.data.name === 'recap_already_posted')).toBe(
      true,
    )
    expect(forge.writes).not.toContain('comment')
    // Posted by an earlier run IS posted: the closure goes ahead, and the
    // label still sits between the two.
    const at = (op: string) => forge.writes.indexOf(op)
    expect(at('labels codesema:merged')).toBeGreaterThanOrEqual(0)
    expect(at('labels codesema:merged')).toBeLessThan(at('close'))
  })
})

// ── Conversations with no repository (the scratch project) ─────────────────

describe('scratch conversations over HTTP', () => {
  test('a workspace with no repo registered can still open a conversation', async () => {
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
    const started = await startServer(createSession(), {
      cwd: makeDir(),
      port: 5187,
      taskManager: manager,
      currentProjectId: null,
    })
    try {
      const token = await tasksToken(started.port)
      const scratch = scratchProject()

      const listed = await rawRequest(started.port, '/api/projects')
      expect(JSON.parse(listed.body).projects).toHaveLength(1)
      expect(JSON.parse(listed.body).projects[0]).toMatchObject({
        id: scratch.id,
        kind: 'scratch',
      })

      const created = await rawRequest(started.port, '/api/tasks', {
        method: 'POST',
        headers: { 'x-codesema-tasks-token': token },
        body: JSON.stringify({ project_id: scratch.id, title: 'just talking', prompt: 'hello' }),
      })
      expect(created.status).toBe(201)
      const id = JSON.parse(created.body).id as string

      const fetched = await rawRequest(started.port, `/api/tasks/${id}?project=${scratch.id}`)
      expect(fetched.status).toBe(200)
      expect(JSON.parse(fetched.body)).toMatchObject({ record: { id, branch: '', base: '' } })
    } finally {
      await started.stop()
    }
  })

  test('naming a branch or a base is refused: there is no repository to name one in', async () => {
    const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
    const started = await startServer(createSession(), {
      cwd: makeDir(),
      port: 5188,
      taskManager: manager,
      currentProjectId: null,
    })
    try {
      const token = await tasksToken(started.port)
      const scratch = scratchProject()
      for (const extra of [{ branch: 'feat/x' }, { base: 'main' }]) {
        const refused = await rawRequest(started.port, '/api/tasks', {
          method: 'POST',
          headers: { 'x-codesema-tasks-token': token },
          body: JSON.stringify({ project_id: scratch.id, title: 't', prompt: 'p', ...extra }),
        })
        expect(refused.status).toBe(400)
      }
    } finally {
      await started.stop()
    }
  })
})

// --- microvm wiring (lot C7) ------------------------------------------------

describe('microvm wiring (lot C7)', () => {
  const fakeDriver = { kind: 'fake' } as unknown as SandboxDriver
  const microvmConfigured = {
    available: true,
    mode: 'microvm' as const,
    reason: 'microsandbox is available',
    configured: 'microvm' as const,
    runtime: null,
  }
  const noopStepExecutor: StepExecutor = () =>
    Promise.resolve({ code: 0, stdout: '', stderr: '', timedOut: false, failure: null })

  function baseRunbook(overrides: Partial<RunbookConfig> = {}): RunbookConfig {
    return {
      version: 1,
      image: 'node:26',
      install: ['npm install'],
      services: { host_up: [], compose_file: null },
      healthchecks: [],
      tests: ['npm test'],
      egress: ['registry.npmjs.org'],
      depends_on_files: [],
      ...overrides,
    }
  }

  function seedMicrovmTask(
    cwd: string,
    title = 'vm task',
  ): { record: TaskRecord; worktree: string } {
    const worktree = makeRepo()
    const record = createTask(cwd, {
      title,
      prompt: 'do it',
      autoShip: false,
      base: '',
      branch: '',
      worktree,
      isolation: 'microvm',
    })
    record.worktree = worktree
    saveTask(cwd, record)
    return { record, worktree }
  }

  describe('resolveMicrovmFn (dev turn)', () => {
    test('resolves driver/runbook/image/snapshot from the task worktree, on a ready snapshot', async () => {
      const project = register(makeRepo())
      const { record } = seedMicrovmTask(project.path)
      const runbook = baseRunbook()
      const snapshotCalls: unknown[] = []
      const rig = fakeRunner()
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => runbook,
        resolveProjectSnapshotFn: (opts) => {
          snapshotCalls.push(opts)
          return Promise.resolve({
            kind: 'ready',
            name: 'codesema-p-hash',
            hash: 'hash',
          } as ProjectSnapshot)
        },
        createRunnerFn: rig.createRunnerFn,
      })
      // Cheap way to trigger context() (and so createRunnerFn) with no commit needed.
      manager.checks(project.id, record.id)

      const microvm = await rig.runnerOptions().resolveMicrovmFn?.(record)
      expect(microvm?.driver).toBe(fakeDriver)
      expect(microvm?.snapshotName).toBe('codesema-p-hash')
      expect(microvm?.image).toBe('node:26')
      expect(microvm?.runbook).toEqual(runbook)
      expect(snapshotCalls).toEqual([
        {
          driver: fakeDriver,
          projectId: project.id,
          worktree: record.worktree,
          runbook,
          agentId: 'claude',
        },
      ])
    })

    test('a missing snapshot triggers a build; a ready build feeds snapshotName', async () => {
      const project = register(makeRepo())
      const { record } = seedMicrovmTask(project.path)
      const runbook = baseRunbook()
      const buildCalls: unknown[] = []
      const rig = fakeRunner()
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => runbook,
        resolveProjectSnapshotFn: () =>
          Promise.resolve({
            kind: 'missing',
            name: 'codesema-p-hash',
            hash: 'hash',
          } as ProjectSnapshot),
        buildProjectSnapshotFn: (opts) => {
          buildCalls.push(opts)
          return Promise.resolve({
            kind: 'ready',
            name: 'codesema-p-hash',
            hash: 'hash',
          } as ProjectSnapshot)
        },
        createRunnerFn: rig.createRunnerFn,
      })
      manager.checks(project.id, record.id)

      const microvm = await rig.runnerOptions().resolveMicrovmFn?.(record)
      expect(microvm?.snapshotName).toBe('codesema-p-hash')
      expect(buildCalls).toHaveLength(1)
    })

    test('a cold snapshot (flat root disk) leaves snapshotName null, and never builds', async () => {
      const project = register(makeRepo())
      const { record } = seedMicrovmTask(project.path)
      const runbook = baseRunbook()
      let buildCalled = false
      const rig = fakeRunner()
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => runbook,
        resolveProjectSnapshotFn: () =>
          Promise.resolve({ kind: 'cold', reason: 'flat root disk' } as ProjectSnapshot),
        buildProjectSnapshotFn: () => {
          buildCalled = true
          return Promise.resolve({ kind: 'cold', reason: 'flat root disk' } as ProjectSnapshot)
        },
        createRunnerFn: rig.createRunnerFn,
      })
      manager.checks(project.id, record.id)

      const microvm = await rig.runnerOptions().resolveMicrovmFn?.(record)
      expect(microvm?.snapshotName).toBeNull()
      expect(buildCalled).toBe(false)
    })

    test('no runbook: cold image falls back to the resolved base image, snapshot is never resolved', async () => {
      const project = register(makeRepo())
      const { record } = seedMicrovmTask(project.path)
      let snapshotCalled = false
      const rig = fakeRunner()
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => null,
        resolveProjectSnapshotFn: () => {
          snapshotCalled = true
          return Promise.resolve({ kind: 'cold', reason: 'unused' } as ProjectSnapshot)
        },
        createRunnerFn: rig.createRunnerFn,
      })
      manager.checks(project.id, record.id)

      const microvm = await rig.runnerOptions().resolveMicrovmFn?.(record)
      expect(microvm?.runbook).toBeNull()
      expect(microvm?.snapshotName).toBeNull()
      expect(microvm?.image).toBe('node:26')
      expect(snapshotCalled).toBe(false)
    })

    test('secrets are built from CAGE_FORWARDED_ENV only, never from unrelated env vars', async () => {
      const project = register(makeRepo())
      const { record } = seedMicrovmTask(project.path)
      const rig = fakeRunner()
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => null,
        createRunnerFn: rig.createRunnerFn,
      })
      manager.checks(project.id, record.id)

      const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN
      const previousUnrelated = process.env.SOME_UNRELATED_TEST_VAR
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-secret'
      process.env.SOME_UNRELATED_TEST_VAR = 'never-forwarded'
      try {
        const microvm = await rig.runnerOptions().resolveMicrovmFn?.(record)
        expect(microvm?.secrets).toContainEqual({
          env: 'CLAUDE_CODE_OAUTH_TOKEN',
          value: 'tok-secret',
          allowedHosts: ['api.anthropic.com', 'platform.claude.com'],
        })
        expect(microvm?.secrets.some((s) => s.env === 'SOME_UNRELATED_TEST_VAR')).toBe(false)
      } finally {
        if (previous === undefined) {
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN
        } else {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = previous
        }
        if (previousUnrelated === undefined) {
          delete process.env.SOME_UNRELATED_TEST_VAR
        } else {
          process.env.SOME_UNRELATED_TEST_VAR = previousUnrelated
        }
      }
    })
  })

  describe('prepareChecks executor', () => {
    test("a 'microvm' task with a runbook runs checks through microvmStepExecutor", async () => {
      const project = register(makeRepo())
      const { record } = seedCommittedTask(project.path)
      record.isolation = 'microvm'
      saveTask(project.path, record)
      const runbook = baseRunbook({ egress: ['api.example.com'] })
      const seen: RunChecksOptions[] = []
      const rig = fakeRunner()
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => runbook,
        resolveProjectSnapshotFn: () =>
          Promise.resolve({ kind: 'ready', name: 'codesema-p-hash', hash: 'h' } as ProjectSnapshot),
        runChecksFn: (options) => {
          seen.push(options)
          return Promise.resolve(finishedChecks())
        },
        reviewTurnFn: async () => {},
        createRunnerFn: rig.createRunnerFn,
      })

      expect(manager.checks(project.id, record.id)).toEqual({ ok: true })
      await until(() => seen.length > 0)
      expect(seen[0]?.executor).toBeDefined()
      expect(typeof seen[0]?.executor).toBe('function')
    })

    test("a 'policy' task never gets an executor", async () => {
      const project = register(makeRepo())
      const { record } = seedCommittedTask(project.path)
      const seen: RunChecksOptions[] = []
      const manager = createTaskManager({
        ...managerOpts,
        runChecksFn: (options) => {
          seen.push(options)
          return Promise.resolve(finishedChecks())
        },
        reviewTurnFn: async () => {},
        ...fakeRunner(),
      })

      expect(manager.checks(project.id, record.id)).toEqual({ ok: true })
      await until(() => seen.length > 0)
      expect(seen[0]?.executor).toBeUndefined()
    })

    test('a microvm task with NO runbook still runs checks, cold, no executor egress override needed', async () => {
      const project = register(makeRepo())
      const { record } = seedCommittedTask(project.path)
      record.isolation = 'microvm'
      saveTask(project.path, record)
      const seen: RunChecksOptions[] = []
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => null,
        runChecksFn: (options) => {
          seen.push(options)
          return Promise.resolve(finishedChecks())
        },
        reviewTurnFn: async () => {},
        ...fakeRunner(),
      })

      expect(manager.checks(project.id, record.id)).toEqual({ ok: true })
      await until(() => seen.length > 0)
      expect(seen[0]?.executor).toBeDefined()
    })
  })

  describe('ship wiring', () => {
    test("a 'microvm' task ships with the driver and GH_TOKEN when the origin is a github remote", async () => {
      const project = register(makeRepoWithRemote('https://github.com/acme/repo.git'))
      const cwd = project.path
      const record = seedShippable(cwd)
      record.isolation = 'microvm'
      saveTask(cwd, record)
      const stub = shipStub({ pushed: true, mrUrl: 'https://github.com/o/r/pull/1', note: null })
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        shipTaskFn: stub.fn,
        ...fakeRunner(),
      })

      const previous = process.env.GH_TOKEN
      process.env.GH_TOKEN = 'gh-secret-token'
      try {
        expect(await manager.ship(project.id, record.id)).toEqual({ ok: true })
      } finally {
        if (previous === undefined) {
          delete process.env.GH_TOKEN
        } else {
          process.env.GH_TOKEN = previous
        }
      }
      expect(stub.calls).toHaveLength(1)
      expect(stub.calls[0]?.driver).toBe(fakeDriver)
      expect(stub.calls[0]?.forgeToken).toBe('gh-secret-token')
    })

    test("a 'container' task ships with no driver and no forge token at all", async () => {
      const project = register(makeRepo())
      const cwd = project.path
      const record = seedShippable(cwd)
      record.isolation = 'container'
      saveTask(cwd, record)
      const stub = shipStub({ pushed: true, mrUrl: 'https://github.com/o/r/pull/1', note: null })
      const manager = createTaskManager({ ...managerOpts, shipTaskFn: stub.fn, ...fakeRunner() })

      expect(await manager.ship(project.id, record.id)).toEqual({ ok: true })
      expect(stub.calls[0]?.driver).toBeUndefined()
      expect(stub.calls[0]?.forgeToken).toBeUndefined()
    })

    test('GITLAB_TOKEN is used when the origin is a gitlab remote', async () => {
      const project = register(makeRepoWithRemote('https://gitlab.com/o/r.git'))
      const cwd = project.path
      const record = seedShippable(cwd)
      record.isolation = 'microvm'
      saveTask(cwd, record)
      const stub = shipStub({
        pushed: true,
        mrUrl: 'https://gitlab.com/o/r/-/merge_requests/1',
        note: null,
      })
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        shipTaskFn: stub.fn,
        ...fakeRunner(),
      })

      const previousGh = process.env.GH_TOKEN
      const previousGitlab = process.env.GITLAB_TOKEN
      delete process.env.GH_TOKEN
      process.env.GITLAB_TOKEN = 'glab-secret'
      try {
        expect(await manager.ship(project.id, record.id)).toEqual({ ok: true })
      } finally {
        if (previousGh === undefined) {
          delete process.env.GH_TOKEN
        } else {
          process.env.GH_TOKEN = previousGh
        }
        if (previousGitlab === undefined) {
          delete process.env.GITLAB_TOKEN
        } else {
          process.env.GITLAB_TOKEN = previousGitlab
        }
      }
      expect(stub.calls[0]?.forgeToken).toBe('glab-secret')
    })

    test('a GH_TOKEN never rides along to a gitlab origin, even with no GITLAB_TOKEN set', async () => {
      const project = register(makeRepoWithRemote('https://gitlab.com/o/r.git'))
      const cwd = project.path
      const record = seedShippable(cwd)
      record.isolation = 'microvm'
      saveTask(cwd, record)
      const stub = shipStub({
        pushed: true,
        mrUrl: 'https://gitlab.com/o/r/-/merge_requests/1',
        note: null,
      })
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        shipTaskFn: stub.fn,
        ...fakeRunner(),
      })

      const previousGh = process.env.GH_TOKEN
      const previousGitlab = process.env.GITLAB_TOKEN
      process.env.GH_TOKEN = 'gh-secret-token'
      delete process.env.GITLAB_TOKEN
      try {
        expect(await manager.ship(project.id, record.id)).toEqual({ ok: true })
      } finally {
        if (previousGh === undefined) {
          delete process.env.GH_TOKEN
        } else {
          process.env.GH_TOKEN = previousGh
        }
        if (previousGitlab === undefined) {
          delete process.env.GITLAB_TOKEN
        } else {
          process.env.GITLAB_TOKEN = previousGitlab
        }
      }
      expect(stub.calls[0]?.forgeToken).toBeNull()
    })

    test('a GITLAB_TOKEN never rides along to a github origin, even with no GH_TOKEN set', async () => {
      const project = register(makeRepoWithRemote('https://github.com/acme/repo.git'))
      const cwd = project.path
      const record = seedShippable(cwd)
      record.isolation = 'microvm'
      saveTask(cwd, record)
      const stub = shipStub({ pushed: true, mrUrl: 'https://github.com/o/r/pull/1', note: null })
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        shipTaskFn: stub.fn,
        ...fakeRunner(),
      })

      const previousGh = process.env.GH_TOKEN
      const previousGitlab = process.env.GITLAB_TOKEN
      delete process.env.GH_TOKEN
      process.env.GITLAB_TOKEN = 'glab-secret'
      try {
        expect(await manager.ship(project.id, record.id)).toEqual({ ok: true })
      } finally {
        if (previousGh === undefined) {
          delete process.env.GH_TOKEN
        } else {
          process.env.GH_TOKEN = previousGh
        }
        if (previousGitlab === undefined) {
          delete process.env.GITLAB_TOKEN
        } else {
          process.env.GITLAB_TOKEN = previousGitlab
        }
      }
      expect(stub.calls[0]?.forgeToken).toBeNull()
    })
  })

  describe('review wiring', () => {
    test('a workspace configured for microvm hands the reviewer a driver, secrets, and a resolveReviewContext resolving the runbook and a ready snapshot', async () => {
      const project = register(makeRepo())
      const { record } = seedMicrovmTask(project.path)
      const runbook = baseRunbook()
      const seenOptions: CreateTaskReviewerOptions[] = []
      const manager = createTaskManager({
        ...managerOpts,
        isolation: microvmConfigured,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => runbook,
        resolveProjectSnapshotFn: () =>
          Promise.resolve({
            kind: 'ready',
            name: 'codesema-p-hash',
            hash: 'hash',
          } as ProjectSnapshot),
        createReviewerFn: (options) => {
          seenOptions.push(options)
          return async () => {}
        },
        ...fakeRunner(),
      })

      manager.checks(project.id, record.id)

      expect(seenOptions).toHaveLength(1)
      expect(seenOptions[0]?.driver).toBe(fakeDriver)
      expect(seenOptions[0]?.projectId).toBe(project.id)
      expect(typeof seenOptions[0]?.resolveReviewContext).toBe('function')
      // The snapshot/runbook/verification are per-task-turn facts, resolved
      // ONLY when the resolver is actually called with the reviewed record —
      // never frozen at construction time (this ticket's whole point).
      const ctx = await seenOptions[0]?.resolveReviewContext?.(record)
      expect(ctx?.runbook).toEqual(runbook)
      expect(ctx?.snapshotName).toBe('codesema-p-hash')
      // No verification.json was ever written for this task.
      expect(ctx?.verification).toBeNull()
    })

    test('a workspace NOT configured for microvm never builds the driver for its reviewer', async () => {
      const project = register(makeRepo())
      const record = seedTask(project.path)
      const seenOptions: CreateTaskReviewerOptions[] = []
      const manager = createTaskManager({
        ...managerOpts,
        createReviewerFn: (options) => {
          seenOptions.push(options)
          return async () => {}
        },
        ...fakeRunner(),
      })

      manager.checks(project.id, record.id)

      expect(seenOptions).toHaveLength(1)
      expect(seenOptions[0]?.driver).toBeUndefined()
      expect(seenOptions[0]?.resolveReviewContext).toBeUndefined()
    })

    test("resolveReviewContext resolves a MISSING snapshot to null and never triggers a build (that stays the dev turn's job)", async () => {
      const project = register(makeRepo())
      const { record } = seedMicrovmTask(project.path)
      const runbook = baseRunbook()
      let buildCalled = false
      const seenOptions: CreateTaskReviewerOptions[] = []
      const manager = createTaskManager({
        ...managerOpts,
        isolation: microvmConfigured,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => runbook,
        resolveProjectSnapshotFn: () =>
          Promise.resolve({
            kind: 'missing',
            name: 'codesema-p-hash',
            hash: 'hash',
          } as ProjectSnapshot),
        buildProjectSnapshotFn: () => {
          buildCalled = true
          return Promise.resolve({
            kind: 'ready',
            name: 'codesema-p-hash',
            hash: 'hash',
          } as ProjectSnapshot)
        },
        createReviewerFn: (options) => {
          seenOptions.push(options)
          return async () => {}
        },
        ...fakeRunner(),
      })

      manager.checks(project.id, record.id)

      const ctx = await seenOptions[0]?.resolveReviewContext?.(record)
      expect(ctx?.snapshotName).toBeNull()
      expect(buildCalled).toBe(false)
    })

    test("resolveReviewContext reads the REVIEWED task's own last mechanical verification", async () => {
      const project = register(makeRepo())
      const { record } = seedMicrovmTask(project.path)
      const runbook = baseRunbook()
      const verification: TaskVerification = {
        head_sha: 'deadbeef',
        runbook_sha: '0123456789abcdef',
        started_at: '2026-01-01T00:00:00.000Z',
        finished_at: '2026-01-01T00:05:00.000Z',
        status: 'passed',
        checks: [
          { command: 'npm test', status: 'passed', exit_code: 0, duration_ms: 10, tail: '' },
        ],
        integrity_ok: true,
        changed_dependency_files: [],
        error: null,
      }
      writeTaskVerification(project.path, record.id, verification)
      const seenOptions: CreateTaskReviewerOptions[] = []
      const manager = createTaskManager({
        ...managerOpts,
        isolation: microvmConfigured,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => runbook,
        resolveProjectSnapshotFn: () =>
          Promise.resolve({ kind: 'cold', reason: 'test' } as ProjectSnapshot),
        createReviewerFn: (options) => {
          seenOptions.push(options)
          return async () => {}
        },
        ...fakeRunner(),
      })

      manager.checks(project.id, record.id)

      const ctx = await seenOptions[0]?.resolveReviewContext?.(record)
      expect(ctx?.verification).toEqual(verification)
    })
  })

  describe('boot sweep wiring', () => {
    test('workspace.ts calls sweepOrphanedSandboxes at boot, alongside sweepOrphanedVolumes', () => {
      // Covered directly against the real function in workspace-boot.test.ts's
      // spread-the-real-manager rig (out of this lot's file ownership); this
      // asserts the manager-level contract the boot call depends on: a fresh
      // manager exposes both sweeps as real async functions.
      const manager = createTaskManager({ ...managerOpts, ...fakeRunner() })
      expect(typeof manager.sweepOrphanedVolumes).toBe('function')
      expect(typeof manager.sweepOrphanedSandboxes).toBe('function')
    })
  })

  describe('mechanical verification (onTurnDone)', () => {
    const jsonl = (events: unknown[]) => `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
    const claudeStream = (response: string) =>
      jsonl([
        { type: 'system', subtype: 'init', session_id: 'sess-verify' },
        { type: 'result', result: response },
      ])

    function seedInterruptedMicrovmTask(cwd: string): { record: TaskRecord; worktree: string } {
      const worktree = makeRepo()
      const record = createTask(cwd, {
        title: 'vm task',
        prompt: 'do it',
        autoShip: false,
        base: '',
        branch: '',
        worktree,
        isolation: 'microvm',
      })
      record.worktree = worktree
      record.status = 'interrupted'
      saveTask(cwd, record)
      return { record, worktree }
    }

    /**
     * A local validation record whose `runbook_sha` matches `runbook` by
     * default (the "valid, still current" case) — `readRunbookValidationFn`
     * mocks read this the same way the real `.codesema/runbook.validation.json`
     * would, written by the scan (runbook-runner.ts) at the project root.
     */
    function validRunbookValidation(
      runbook: RunbookConfig,
      overrides: Partial<RunbookValidation> = {},
    ): RunbookValidation {
      return {
        runbook_sha: computeRunbookSha(runbook),
        validated_sha: 'deadbeefdeadbeef',
        validated_at: '2026-01-01T00:00:00.000Z',
        status: 'valid',
        ...overrides,
      }
    }

    test('a passed verification stamps runbook_sha/runbook_integrity, writes verification.json, keeps review_ok', async () => {
      const project = register(makeRepo())
      const { record, worktree } = seedInterruptedMicrovmTask(project.path)
      const runbook = baseRunbook()
      const verification: TaskVerification = {
        head_sha: 'irrelevant-here',
        runbook_sha: '0123456789abcdef',
        started_at: '2026-01-01T00:00:00.000Z',
        finished_at: '2026-01-01T00:05:00.000Z',
        status: 'passed',
        checks: [
          { command: 'npm test', status: 'passed', exit_code: 0, duration_ms: 10, tail: '' },
        ],
        integrity_ok: true,
        changed_dependency_files: [],
        error: null,
      }
      const validation = validRunbookValidation(runbook)
      const verifyCalls: VerifyTaskOptions[] = []
      const envelopes: TaskEnvelope[] = []
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => runbook,
        readRunbookValidationFn: () => validation,
        resolveProjectSnapshotFn: () =>
          Promise.resolve({ kind: 'cold', reason: 'test' } as ProjectSnapshot),
        verifyTaskFn: (opts) => {
          verifyCalls.push(opts)
          return Promise.resolve(verification)
        },
        runChecksFn: () => Promise.resolve(finishedChecks()),
        reviewTurnFn: async (r, io) => {
          r.status = 'review_ok'
          io.persist()
        },
        runMicrovmTurnFn: (options: RunMicrovmTurnOptions) => {
          writeFileSync(join(options.worktree, 'feature.txt'), 'from the vm\n')
          const raw = claudeStream('all done')
          options.onText?.(raw)
          return Promise.resolve(raw)
        },
      })
      manager.subscribe((envelope) => envelopes.push(envelope))

      expect(manager.resume(project.id, record.id)).toEqual({ ok: true })
      await until(() => loadTask(project.path, record.id)?.status === 'review_ok')

      expect(verifyCalls).toHaveLength(1)
      expect(verifyCalls[0]?.worktree).toBe(worktree)
      expect(verifyCalls[0]?.runbook).toEqual(runbook)
      expect(verifyCalls[0]?.snapshotName).toBeNull()
      expect(verifyCalls[0]?.validatedSha).toBe(validation.validated_sha)

      const final = loadTask(project.path, record.id)
      expect(final?.runbook_sha).toBe('0123456789abcdef')
      expect(final?.runbook_integrity).toBe(true)
      expect(readTaskVerification(project.path, record.id)).toEqual(verification)
      expect(
        envelopes.some(
          (e) =>
            e.event.name === 'task_event' &&
            e.event.data.type === 'checks' &&
            e.event.data.data.status === 'passed',
        ),
      ).toBe(true)
    })

    test('a refused verification (runbook integrity drifted) sends the task back with checks_failed', async () => {
      const project = register(makeRepo())
      const { record, worktree } = seedInterruptedMicrovmTask(project.path)
      const runbook = baseRunbook({ depends_on_files: ['package.json'] })
      const verification: TaskVerification = {
        head_sha: 'irrelevant-here',
        runbook_sha: '0123456789abcdef',
        started_at: '2026-01-01T00:00:00.000Z',
        finished_at: '2026-01-01T00:05:00.000Z',
        status: 'refused',
        checks: [],
        integrity_ok: false,
        changed_dependency_files: ['package.json'],
        error: null,
      }
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => runbook,
        readRunbookValidationFn: () => validRunbookValidation(runbook),
        resolveProjectSnapshotFn: () =>
          Promise.resolve({ kind: 'cold', reason: 'test' } as ProjectSnapshot),
        verifyTaskFn: () => Promise.resolve(verification),
        runChecksFn: () => Promise.resolve(finishedChecks()),
        reviewTurnFn: async (r, io) => {
          r.status = 'review_ok'
          io.persist()
        },
        runMicrovmTurnFn: (options: RunMicrovmTurnOptions) => {
          writeFileSync(join(options.worktree, 'feature.txt'), 'from the vm\n')
          const raw = claudeStream('all done')
          options.onText?.(raw)
          return Promise.resolve(raw)
        },
      })

      expect(manager.resume(project.id, record.id)).toEqual({ ok: true })
      await until(() => loadTask(project.path, record.id)?.status === 'review_ko')

      const final = loadTask(project.path, record.id)
      expect(final?.runbook_integrity).toBe(false)
      expect(final?.reason?.code).toBe('checks_failed')
      expect(final?.reason?.detail).toContain('package.json')
      expect(readTaskVerification(project.path, record.id)?.status).toBe('refused')
      void worktree
    })

    test('a HEAD lookup that fails skips verification instead of crashing the turn settle', async () => {
      const project = register(makeRepo())
      const { record, worktree } = seedInterruptedMicrovmTask(project.path)
      const runbook = baseRunbook()
      let verifyCalled = false
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => runbook,
        readRunbookValidationFn: () => validRunbookValidation(runbook),
        resolveProjectSnapshotFn: () =>
          Promise.resolve({ kind: 'cold', reason: 'test' } as ProjectSnapshot),
        headShaFn: () => null,
        verifyTaskFn: () => {
          verifyCalled = true
          return Promise.resolve({
            head_sha: 'x',
            runbook_sha: '0123456789abcdef',
            started_at: 'x',
            finished_at: 'y',
            status: 'passed',
            checks: [],
            integrity_ok: true,
            changed_dependency_files: [],
            error: null,
          })
        },
        runChecksFn: () => Promise.resolve(finishedChecks()),
        reviewTurnFn: async (r, io) => {
          r.status = 'review_ok'
          io.persist()
        },
        runMicrovmTurnFn: (options: RunMicrovmTurnOptions) => {
          writeFileSync(join(options.worktree, 'feature.txt'), 'from the vm\n')
          const raw = claudeStream('all done')
          options.onText?.(raw)
          return Promise.resolve(raw)
        },
      })

      expect(manager.resume(project.id, record.id)).toEqual({ ok: true })
      await until(() => loadTask(project.path, record.id)?.status === 'review_ok')

      expect(verifyCalled).toBe(false)
      expect(loadTask(project.path, record.id)?.runbook_sha).toBeUndefined()
      expect(readTaskVerification(project.path, record.id)).toBeNull()
      void worktree
    })

    test('a task with no runbook settles normally: no verification attempted, no runbook_sha stamped', async () => {
      const project = register(makeRepo())
      const worktree = makeRepo()
      const record = createTask(project.path, {
        title: 'vm task',
        prompt: 'do it',
        autoShip: false,
        base: '',
        branch: '',
        worktree,
        isolation: 'microvm',
      })
      record.worktree = worktree
      record.status = 'interrupted'
      saveTask(project.path, record)
      let verifyCalled = false
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => null,
        verifyTaskFn: () => {
          verifyCalled = true
          return Promise.resolve({
            head_sha: 'x',
            runbook_sha: '0123456789abcdef',
            started_at: 'x',
            finished_at: 'y',
            status: 'passed',
            checks: [],
            integrity_ok: true,
            changed_dependency_files: [],
            error: null,
          })
        },
        runChecksFn: () => Promise.resolve(finishedChecks()),
        reviewTurnFn: async (r, io) => {
          r.status = 'review_ok'
          io.persist()
        },
        runMicrovmTurnFn: (options: RunMicrovmTurnOptions) => {
          writeFileSync(join(options.worktree, 'feature.txt'), 'from the vm\n')
          const raw = claudeStream('all done')
          options.onText?.(raw)
          return Promise.resolve(raw)
        },
      })

      expect(manager.resume(project.id, record.id)).toEqual({ ok: true })
      await until(() => loadTask(project.path, record.id)?.status === 'review_ok')

      expect(verifyCalled).toBe(false)
      expect(loadTask(project.path, record.id)?.runbook_sha).toBeUndefined()
      expect(readTaskVerification(project.path, record.id)).toBeNull()
    })

    test("a 'container' task never triggers verification, even with a runbook present", async () => {
      const project = register(makeRepo())
      const { record: cworktreeRecord, worktree } = seedCommittedTask(project.path)
      cworktreeRecord.isolation = 'container'
      cworktreeRecord.status = 'review_ok'
      saveTask(project.path, cworktreeRecord)
      let verifyCalled = false
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => baseRunbook(),
        verifyTaskFn: () => {
          verifyCalled = true
          return Promise.resolve({
            head_sha: 'x',
            runbook_sha: '0123456789abcdef',
            started_at: 'x',
            finished_at: 'y',
            status: 'passed',
            checks: [],
            integrity_ok: true,
            changed_dependency_files: [],
            error: null,
          })
        },
        runChecksFn: () => Promise.resolve(finishedChecks()),
        reviewTurnFn: async () => {},
        ...fakeRunner(),
      })

      expect(manager.checks(project.id, cworktreeRecord.id)).toEqual({ ok: true })
      await until(() => readTaskChecks(project.path, cworktreeRecord.id)?.status !== undefined)
      void worktree
      expect(verifyCalled).toBe(false)
    })

    test('D8: verifyAfterCommit reads the validated runbook from the PROJECT ROOT, never the task worktree, and hands it to verifyTask', async () => {
      const project = register(makeRepo())
      const { record, worktree } = seedInterruptedMicrovmTask(project.path)
      const rootRunbook = baseRunbook({ egress: ['from-project-root.example.com'] })
      const verification: TaskVerification = {
        head_sha: 'irrelevant-here',
        runbook_sha: '0123456789abcdef',
        started_at: '2026-01-01T00:00:00.000Z',
        finished_at: '2026-01-01T00:05:00.000Z',
        status: 'passed',
        checks: [
          { command: 'npm test', status: 'passed', exit_code: 0, duration_ms: 10, tail: '' },
        ],
        integrity_ok: true,
        changed_dependency_files: [],
        error: null,
      }
      const verifyCalls: VerifyTaskOptions[] = []
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        // A runbook only exists at the PROJECT root; a lookup rooted at the
        // task's own worktree (the pre-fix behaviour) answers null, exactly
        // like a real task worktree — `.codesema/runbook.json` is gitignored
        // and never checked out there.
        readRunbookConfigFn: (cwd) => (cwd === project.path ? rootRunbook : null),
        // Same doctrine for the local validation record: only a lookup
        // rooted at the project path finds it.
        readRunbookValidationFn: (cwd) =>
          cwd === project.path ? validRunbookValidation(rootRunbook) : null,
        resolveProjectSnapshotFn: () =>
          Promise.resolve({ kind: 'cold', reason: 'test' } as ProjectSnapshot),
        verifyTaskFn: (opts) => {
          verifyCalls.push(opts)
          return Promise.resolve(verification)
        },
        runChecksFn: () => Promise.resolve(finishedChecks()),
        reviewTurnFn: async (r, io) => {
          r.status = 'review_ok'
          io.persist()
        },
        runMicrovmTurnFn: (options: RunMicrovmTurnOptions) => {
          writeFileSync(join(options.worktree, 'feature.txt'), 'from the vm\n')
          const raw = claudeStream('all done')
          options.onText?.(raw)
          return Promise.resolve(raw)
        },
      })

      expect(manager.resume(project.id, record.id)).toEqual({ ok: true })
      await until(() => loadTask(project.path, record.id)?.status === 'review_ok')

      expect(verifyCalls).toHaveLength(1)
      expect(verifyCalls[0]?.runbook).toEqual(rootRunbook)
      void worktree
    })

    test('no local validation record: verification is skipped, no runbook_sha stamped', async () => {
      const project = register(makeRepo())
      const { record, worktree } = seedInterruptedMicrovmTask(project.path)
      const runbook = baseRunbook()
      let verifyCalled = false
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => runbook,
        readRunbookValidationFn: () => null,
        resolveProjectSnapshotFn: () =>
          Promise.resolve({ kind: 'cold', reason: 'test' } as ProjectSnapshot),
        verifyTaskFn: () => {
          verifyCalled = true
          return Promise.resolve({
            head_sha: 'x',
            runbook_sha: '0123456789abcdef',
            started_at: 'x',
            finished_at: 'y',
            status: 'passed',
            checks: [],
            integrity_ok: true,
            changed_dependency_files: [],
            error: null,
          })
        },
        runChecksFn: () => Promise.resolve(finishedChecks()),
        reviewTurnFn: async (r, io) => {
          r.status = 'review_ok'
          io.persist()
        },
        runMicrovmTurnFn: (options: RunMicrovmTurnOptions) => {
          writeFileSync(join(options.worktree, 'feature.txt'), 'from the vm\n')
          const raw = claudeStream('all done')
          options.onText?.(raw)
          return Promise.resolve(raw)
        },
      })

      expect(manager.resume(project.id, record.id)).toEqual({ ok: true })
      await until(() => loadTask(project.path, record.id)?.status === 'review_ok')

      expect(verifyCalled).toBe(false)
      expect(loadTask(project.path, record.id)?.runbook_sha).toBeUndefined()
      expect(readTaskVerification(project.path, record.id)).toBeNull()
      void worktree
    })

    test('a runbook whose sha no longer matches its own local validation is REFUSED with a clear message, verifyTask never runs', async () => {
      const project = register(makeRepo())
      const { record, worktree } = seedInterruptedMicrovmTask(project.path)
      const runbook = baseRunbook()
      // A validation record whose runbook_sha names a DIFFERENT runbook: the
      // one on disk has drifted (hand-edited, or a scan since superseded).
      const staleValidation = validRunbookValidation(runbook, {
        runbook_sha: 'fedcba9876543210',
      })
      let verifyCalled = false
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => runbook,
        readRunbookValidationFn: () => staleValidation,
        resolveProjectSnapshotFn: () =>
          Promise.resolve({ kind: 'cold', reason: 'test' } as ProjectSnapshot),
        verifyTaskFn: () => {
          verifyCalled = true
          return Promise.reject(new Error('verifyTask must never run on a stale runbook'))
        },
        runChecksFn: () => Promise.resolve(finishedChecks()),
        reviewTurnFn: async (r, io) => {
          r.status = 'review_ok'
          io.persist()
        },
        runMicrovmTurnFn: (options: RunMicrovmTurnOptions) => {
          writeFileSync(join(options.worktree, 'feature.txt'), 'from the vm\n')
          const raw = claudeStream('all done')
          options.onText?.(raw)
          return Promise.resolve(raw)
        },
      })

      expect(manager.resume(project.id, record.id)).toEqual({ ok: true })
      await until(() => loadTask(project.path, record.id)?.status === 'review_ko')

      expect(verifyCalled).toBe(false)
      const final = loadTask(project.path, record.id)
      expect(final?.runbook_integrity).toBe(false)
      expect(final?.reason?.code).toBe('checks_failed')
      expect(final?.reason?.detail).toBe(
        'runbook changed since its validation, rerun codesema runbook scan',
      )
      const stored = readTaskVerification(project.path, record.id)
      expect(stored?.status).toBe('refused')
      expect(stored?.changed_dependency_files).toEqual([])
      expect(stored?.error).toBe(
        'runbook changed since its validation, rerun codesema runbook scan',
      )
      void worktree
    })

    test('sha match: validatedSha handed to verifyTask is validation.validated_sha, never derived from git history', async () => {
      const project = register(makeRepo())
      const { record, worktree } = seedInterruptedMicrovmTask(project.path)
      const runbook = baseRunbook()
      const validation = validRunbookValidation(runbook, { validated_sha: 'abc1234abc1234ab' })
      const verifyCalls: VerifyTaskOptions[] = []
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => runbook,
        readRunbookValidationFn: () => validation,
        resolveProjectSnapshotFn: () =>
          Promise.resolve({ kind: 'cold', reason: 'test' } as ProjectSnapshot),
        verifyTaskFn: (opts) => {
          verifyCalls.push(opts)
          return Promise.resolve({
            head_sha: 'x',
            runbook_sha: computeRunbookSha(runbook),
            started_at: 'x',
            finished_at: 'y',
            status: 'passed' as const,
            checks: [],
            integrity_ok: true,
            changed_dependency_files: [],
            error: null,
          })
        },
        runChecksFn: () => Promise.resolve(finishedChecks()),
        reviewTurnFn: async (r, io) => {
          r.status = 'review_ok'
          io.persist()
        },
        runMicrovmTurnFn: (options: RunMicrovmTurnOptions) => {
          writeFileSync(join(options.worktree, 'feature.txt'), 'from the vm\n')
          const raw = claudeStream('all done')
          options.onText?.(raw)
          return Promise.resolve(raw)
        },
      })

      expect(manager.resume(project.id, record.id)).toEqual({ ok: true })
      await until(() => loadTask(project.path, record.id)?.status === 'review_ok')

      expect(verifyCalls).toHaveLength(1)
      expect(verifyCalls[0]?.validatedSha).toBe('abc1234abc1234ab')
      void worktree
    })
  })

  describe('D8: the validated runbook is read from the PROJECT root, never the task worktree', () => {
    // Every helper below writes the runbook `readRunbookConfigFn` sees ONLY
    // for the project root (`cwd === project.path`), and null for anything
    // else — including `record.worktree`, a SEPARATE git worktree
    // (`seedMicrovmTask`/`seedCommittedTask` both use `makeRepo()`). This is
    // exactly the real shape of the bug: a task worktree never carries a
    // copy of `.codesema/runbook.json` (gitignored, only ever written at the
    // project root by `codesema runbook scan`), so any lookup rooted at
    // `record.worktree` must answer null.

    test('(a) resolveMicrovmFn (dev turn) resolves the runbook and a ready snapshot from the project root', async () => {
      const project = register(makeRepo())
      const { record } = seedMicrovmTask(project.path)
      const runbook = baseRunbook()
      const rig = fakeRunner()
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: (cwd) => (cwd === project.path ? runbook : null),
        resolveProjectSnapshotFn: () =>
          Promise.resolve({
            kind: 'ready',
            name: 'codesema-p-hash',
            hash: 'hash',
          } as ProjectSnapshot),
        createRunnerFn: rig.createRunnerFn,
      })
      manager.checks(project.id, record.id)

      const microvm = await rig.runnerOptions().resolveMicrovmFn?.(record)
      expect(microvm?.runbook).toEqual(runbook)
      expect(microvm?.snapshotName).toBe('codesema-p-hash')
    })

    test('(b) the checks executor receives allowedDomains = runbook.egress, runbook read from the project root', async () => {
      const project = register(makeRepo())
      const { record } = seedCommittedTask(project.path)
      record.isolation = 'microvm'
      saveTask(project.path, record)
      const runbook = baseRunbook({ egress: ['registry.npmjs.org', 'from-root.example.com'] })
      const seenExecutorOptions: MicrovmStepExecutorOptions[] = []
      const rig = fakeRunner()
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: (cwd) => (cwd === project.path ? runbook : null),
        resolveProjectSnapshotFn: () =>
          Promise.resolve({ kind: 'ready', name: 'codesema-p-hash', hash: 'h' } as ProjectSnapshot),
        microvmStepExecutorFn: (options) => {
          seenExecutorOptions.push(options)
          return noopStepExecutor
        },
        runChecksFn: () => Promise.resolve(finishedChecks()),
        reviewTurnFn: async () => {},
        createRunnerFn: rig.createRunnerFn,
      })

      expect(manager.checks(project.id, record.id)).toEqual({ ok: true })
      await until(() => seenExecutorOptions.length > 0)
      expect(seenExecutorOptions[0]?.allowedDomains).toEqual([
        'registry.npmjs.org',
        'from-root.example.com',
      ])
      expect(seenExecutorOptions[0]?.snapshotName).toBe('codesema-p-hash')
    })

    test('(c) resolveReviewContext resolves the runbook and a ready snapshot from the project root', async () => {
      const project = register(makeRepo())
      const { record } = seedMicrovmTask(project.path)
      const runbook = baseRunbook()
      const seenOptions: CreateTaskReviewerOptions[] = []
      const manager = createTaskManager({
        ...managerOpts,
        isolation: microvmConfigured,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: (cwd) => (cwd === project.path ? runbook : null),
        resolveProjectSnapshotFn: () =>
          Promise.resolve({
            kind: 'ready',
            name: 'codesema-p-hash',
            hash: 'hash',
          } as ProjectSnapshot),
        createReviewerFn: (options) => {
          seenOptions.push(options)
          return async () => {}
        },
        ...fakeRunner(),
      })

      manager.checks(project.id, record.id)

      const ctx = await seenOptions[0]?.resolveReviewContext?.(record)
      expect(ctx?.runbook).toEqual(runbook)
      expect(ctx?.snapshotName).toBe('codesema-p-hash')
    })

    test('a project with NO runbook at its root still resolves everything to null/empty, exactly as before', async () => {
      const project = register(makeRepo())
      const { record } = seedMicrovmTask(project.path)
      const rig = fakeRunner()
      let snapshotCalled = false
      const manager = createTaskManager({
        ...managerOpts,
        sandboxDriverFn: () => fakeDriver,
        readRunbookConfigFn: () => null,
        resolveProjectSnapshotFn: () => {
          snapshotCalled = true
          return Promise.resolve({ kind: 'cold', reason: 'unused' } as ProjectSnapshot)
        },
        createRunnerFn: rig.createRunnerFn,
      })
      manager.checks(project.id, record.id)

      const microvm = await rig.runnerOptions().resolveMicrovmFn?.(record)
      expect(microvm?.runbook).toBeNull()
      expect(microvm?.snapshotName).toBeNull()
      expect(snapshotCalled).toBe(false)
    })
  })
})
