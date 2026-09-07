import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  acceptanceCriterionId,
  RUNBOOK_VERSION,
  type AcceptanceCriterion,
  type CriterionVerdict,
  type Finding,
  type ProofReview,
  type ReviewRecord,
  type RunbookConfig,
  type TaskChecks,
  type TaskReason,
  type TaskRecord,
  type TaskStatus,
  type TaskVerification,
  type Verdict,
} from './contract.js'
import { createLoadCap } from './load-cap.js'
import type {
  SandboxDriver,
  SandboxExecResult,
  SandboxHandle,
  SandboxSpec,
} from './microsandbox-driver.js'
import { AGENT_INSTALL_DOMAINS } from './microvm-bootstrap.js'
import { prep } from './prep.js'
import { archiveRecord, findPreviousReview } from './record.js'
import {
  buildFullReviewPrompt,
  type DualOutcome,
  type runDualFlow,
  type runSimpleFlow,
  type SimpleOutcome,
} from './review.js'
import { readTaskEvidence, writeTaskEvidence } from './task-evidence.js'
import { DEFAULT_ISOLATION_ALLOWED_DOMAINS } from './task-isolation.js'
import {
  actionableFindingIds,
  applyChecksGate,
  blockingFindingsDetail,
  buildAutoFixTurnPrompt,
  buildFixTurnPrompt,
  buildRunbookVerificationChapter,
  checksBlockReady,
  checksFailedDetail,
  createTaskReviewer,
  hasBlockingFindings,
  hubSettleTransition,
  readTaskReview,
  runMicrovmReview,
  taskReviewVerdict,
  terminalChecksResult,
  type CreateTaskReviewerOptions,
} from './task-review.js'
import { createTaskRunner, type TaskTurnIo } from './task-runner.js'
import { createTaskWorktree } from './task-worktree.js'
import {
  createTask,
  loadTask,
  readTaskEvents,
  saveTask,
  writeTaskChecks,
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
async function makeTaskWithWorktree(repo: string, title: string): Promise<TaskRecord> {
  const record = createTask(repo, {
    title,
    prompt: 'do work',
    autoShip: false,
    base: '',
    branch: '',
    worktree: '',
  })
  const wt = await createTaskWorktree(repo, record.id, title)
  record.base = wt.base
  record.branch = wt.branch
  record.worktree = wt.worktree
  // Exactly what the runner records: the review measures from the baseline.
  record.baseline_sha = wt.baseline
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
  /** The shutdown's cut-off, so a test can fire it mid-review. */
  abort: AbortController
}

function fakeIo(record: TaskRecord): IoRig {
  const rig: IoRig = {
    events: [],
    persisted: [],
    texts: [],
    abort: new AbortController(),
    io: null as unknown as TaskTurnIo,
  }
  rig.io = {
    emit: (input) => rig.events.push(input),
    persist: () => rig.persisted.push(record.status),
    text: (text) => rig.texts.push(text),
    signal: rig.abort.signal,
  }
  return rig
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

function runbookOf(over: Partial<RunbookConfig> = {}): RunbookConfig {
  return {
    version: RUNBOOK_VERSION,
    image: 'node:26',
    install: ['npm ci'],
    services: { host_up: [], compose_file: null },
    healthchecks: [],
    tests: ['bun test'],
    egress: [],
    depends_on_files: ['package.json'],
    ...over,
  }
}

function verificationOf(over: Partial<TaskVerification> = {}): TaskVerification {
  return {
    head_sha: 'a'.repeat(40),
    runbook_sha: '0'.repeat(16),
    started_at: '2026-08-28T10:00:00.000Z',
    finished_at: '2026-08-28T10:01:00.000Z',
    status: 'passed',
    checks: [{ command: 'bun test', status: 'passed', exit_code: 0, duration_ms: 10, tail: '' }],
    integrity_ok: true,
    changed_dependency_files: [],
    error: null,
    ...over,
  }
}

/** Writes the repo's `.codesema/config.json` with a `proof.url`, the D17 target readProofConfig needs to return non-null. */
function writeProofConfig(repo: string): void {
  mkdirSync(join(repo, '.codesema'), { recursive: true })
  writeFileSync(
    join(repo, '.codesema', 'config.json'),
    JSON.stringify({ proof: { url: 'http://localhost:3000' } }),
  )
}

/**
 * Lot C1 (a parallel lot) has not implemented `FakeSandboxDriver` yet: a
 * minimal fake of the same `SandboxDriver` interface, local to this test
 * file only.
 */
function fakeMicrovmDriver(
  opts: {
    exec?: SandboxExecResult
    chmodExitCode?: number
    destroyError?: Error
    /** Makes the guest PATH probe (`command -v <agentId>`) answer "missing" for this one agent id. */
    probeMissingFor?: string
  } = {},
): {
  driver: SandboxDriver
  calls: { method: string; args: unknown[] }[]
  specs: SandboxSpec[]
} {
  const calls: { method: string; args: unknown[] }[] = []
  const specs: SandboxSpec[] = []
  const execResult: SandboxExecResult = opts.exec ?? {
    code: 0,
    stdout: '{"verdict":"approve","summary":"ok","findings":[]}',
    stderr: '',
    timedOut: false,
  }
  const chmodExitCode = opts.chmodExitCode ?? 0
  const handle: SandboxHandle = {
    name: 'fake',
    exec: async (command, args, execOpts) => {
      calls.push({ method: 'exec', args: [command, args, execOpts] })
      return execResult
    },
    shell: async (script, execOpts) => {
      calls.push({ method: 'shell', args: [script, execOpts] })
      if (script.startsWith('chmod')) {
        return {
          code: chmodExitCode,
          stdout: '',
          stderr: chmodExitCode === 0 ? '' : 'permission denied',
          timedOut: false,
        }
      }
      // The guest PATH probe (microvm-bootstrap.ts's `ensureAgentInstalled`):
      // always answers "already installed" so a test's `opts.exec` override
      // (a bad agent turn, a timeout) never gets misread as a missing agent —
      // except for `probeMissingFor`, which the bootstrap tests use instead.
      if (script.startsWith('command -v ')) {
        const missing = opts.probeMissingFor && script === `command -v ${opts.probeMissingFor}`
        return missing
          ? { code: 1, stdout: '', stderr: 'not found', timedOut: false }
          : { code: 0, stdout: '', stderr: '', timedOut: false }
      }
      if (script.includes('npm install -g')) {
        return { code: 0, stdout: '', stderr: '', timedOut: false }
      }
      return execResult
    },
    copyFromHost: async (hostPath, guestPath) => {
      calls.push({ method: 'copyFromHost', args: [hostPath, guestPath] })
    },
    copyToHost: async (guestPath, hostPath) => {
      calls.push({ method: 'copyToHost', args: [guestPath, hostPath] })
    },
    writeFile: async (guestPath, content) => {
      calls.push({ method: 'writeFile', args: [guestPath, content] })
    },
    readFile: async (guestPath) => {
      calls.push({ method: 'readFile', args: [guestPath] })
      return ''
    },
    metrics: async () => ({ memoryHostResidentBytes: null, memoryBytes: null, cpuPercent: null }),
    stop: async () => {
      calls.push({ method: 'stop', args: [] })
    },
  }
  const driver: SandboxDriver = {
    kind: 'fake',
    probe: async () => ({ available: true, reason: null, version: '0.0.0' }),
    create: async (spec) => {
      calls.push({ method: 'create', args: [spec] })
      specs.push(spec)
      return handle
    },
    snapshot: async (sbName, snapName) => {
      calls.push({ method: 'snapshot', args: [sbName, snapName] })
      return { name: snapName, sizeBytes: null }
    },
    listSandboxes: async () => [],
    listSnapshots: async () => [],
    destroy: async (name) => {
      calls.push({ method: 'destroy', args: [name] })
      if (opts.destroyError) {
        throw opts.destroyError
      }
    },
    removeSnapshot: async () => {},
    ensureVolume: async () => {},
    removeVolume: async () => {},
  }
  return { driver, calls, specs }
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

// --- checks gate (T3.1) ---------------------------------------------------

function checksOf(over: Partial<TaskChecks> = {}): TaskChecks {
  return {
    head_sha: 'abc',
    started_at: '2026-08-14T10:00:00.000Z',
    finished_at: '2026-08-14T10:01:00.000Z',
    status: 'passed',
    checks: [{ command: 'bun test', status: 'passed', exit_code: 0, duration_ms: 5, tail: '' }],
    error: null,
    ...over,
  }
}

function recordAt(status: TaskStatus): TaskRecord {
  return {
    version: 1,
    id: 'a1b2c3d4e5f6',
    title: 't',
    status,
    base: 'main',
    branch: 'codesema/task-t',
    worktree: '/tmp/w',
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: false,
    work_on: false,
    isolation: 'policy',
    created_at: '2026-08-14T10:00:00.000Z',
    updated_at: '2026-08-14T10:00:00.000Z',
  }
}

describe('checksBlockReady / applyChecksGate (T3.1)', () => {
  test('failed blocks; a timeout check blocks even if the run is not labelled failed', () => {
    expect(checksBlockReady(checksOf({ status: 'failed' }))).toBe(true)
    expect(
      checksBlockReady(
        checksOf({
          status: 'passed',
          checks: [
            { command: 'bun test', status: 'timeout', exit_code: null, duration_ms: 5, tail: '' },
          ],
        }),
      ),
    ).toBe(true)
  })

  test('passed, unconfigured, error, running and absence never block', () => {
    expect(checksBlockReady(checksOf({ status: 'passed' }))).toBe(false)
    expect(checksBlockReady(checksOf({ status: 'unconfigured', checks: [] }))).toBe(false)
    expect(checksBlockReady(checksOf({ status: 'error', checks: [], error: 'no runtime' }))).toBe(
      false,
    )
    expect(checksBlockReady(checksOf({ status: 'running', finished_at: null }))).toBe(false)
    expect(checksBlockReady(null)).toBe(false)
    expect(checksBlockReady(undefined)).toBe(false)
  })

  test('error is not a failed run even when a check happened to fail', () => {
    expect(
      checksBlockReady(
        checksOf({
          status: 'error',
          error: 'docker vanished',
          checks: [
            { command: 'bun test', status: 'failed', exit_code: 1, duration_ms: 5, tail: '' },
          ],
        }),
      ),
    ).toBe(false)
  })

  test('applyChecksGate: review_ok + red checks → review_ko with checks_failed, message kept', () => {
    const record = recordAt('review_ok')
    const red = checksOf({
      status: 'failed',
      checks: [
        { command: 'bun test', status: 'failed', exit_code: 1, duration_ms: 5, tail: 'boom' },
      ],
    })
    applyChecksGate(record, red)
    expect(record.status).toBe('review_ko')
    expect(record.reason).toEqual({
      code: 'checks_failed',
      detail: checksFailedDetail(red),
    })
    expect(record.reason?.detail).toContain('bun test')
    expect(record.checks_status).toBe('failed')
  })

  test('applyChecksGate: review_ok + passed keeps review_ok and stamps passed', () => {
    const record = recordAt('review_ok')
    applyChecksGate(record, checksOf({ status: 'passed' }))
    expect(record.status).toBe('review_ok')
    expect(record.reason).toBeUndefined()
    expect(record.checks_status).toBe('passed')
  })

  test('applyChecksGate: unconfigured and error stamp the record but do not block', () => {
    const unconfigured = recordAt('review_ok')
    applyChecksGate(unconfigured, checksOf({ status: 'unconfigured', checks: [] }))
    expect(unconfigured.status).toBe('review_ok')
    expect(unconfigured.checks_status).toBe('unconfigured')
    expect(unconfigured.reason).toBeUndefined()

    const errored = recordAt('review_ok')
    applyChecksGate(errored, checksOf({ status: 'error', checks: [], error: 'no docker' }))
    expect(errored.status).toBe('review_ok')
    expect(errored.checks_status).toBe('error')
    expect(errored.reason).toBeUndefined()
  })

  test('applyChecksGate never overrides interrupted or review_ko', () => {
    const interrupted = recordAt('interrupted')
    applyChecksGate(interrupted, checksOf({ status: 'failed' }))
    expect(interrupted.status).toBe('interrupted')
    expect(interrupted.checks_status).toBe('failed')

    const ko = recordAt('review_ko')
    ko.reason = { code: 'review_blocked', detail: 'findings' }
    applyChecksGate(ko, checksOf({ status: 'failed' }))
    expect(ko.status).toBe('review_ko')
    expect(ko.reason?.code).toBe('review_blocked')

    // T3.2: the criteria gate settles BEFORE the wrapped persist runs the
    // checks gate, so a criteria KO must keep its own code — while still
    // getting the checks status stamped on the record.
    const blockedByCriteria = recordAt('review_ko')
    blockedByCriteria.reason = { code: 'criteria_unmet', detail: '1 of 3 …' }
    applyChecksGate(blockedByCriteria, checksOf({ status: 'failed' }))
    expect(blockedByCriteria.reason?.code).toBe('criteria_unmet')
    expect(blockedByCriteria.checks_status).toBe('failed')
  })

  test('terminalChecksResult drops running and keeps every finished status', () => {
    expect(terminalChecksResult(checksOf({ status: 'running', finished_at: null }))).toBeNull()
    expect(terminalChecksResult(null)).toBeNull()
    expect(terminalChecksResult(checksOf({ status: 'unconfigured', checks: [] }))?.status).toBe(
      'unconfigured',
    )
  })
})

// --- createTaskReviewer ---------------------------------------------------

describe('createTaskReviewer', () => {
  test('no diff vs base: review_ok without ever spawning a review', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'idle task')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: false, failure: 'run', message: 'must not be called' })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(flow.calls).toHaveLength(0)
    expect(record.status).toBe('review_ok')
    expect(record.review_ref).toBeNull()
    expect(rig.persisted).toEqual(['review_ok'])
    expect(rig.events).toEqual([{ type: 'message', data: { text: 'no changes' } }])
  })

  // T1.2 re-review round 4, MINOR 7: the signal was read before prep and after
  // the flow, but not BETWEEN them — so a Ctrl-C landing during prep still let
  // the flow start and spawn a review agent (two, in dual mode) purely to kill
  // it on the next tick.
  test('an abort during the prep stops BEFORE any review agent is spawned', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'aborted mid-prep')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: false, failure: 'run', message: 'must not be called' })

    await reviewer(repo, {
      runSimpleFlowFn: flow.fn,
      // The shutdown lands while prep is still working.
      prepFn: async (options) => {
        const input = await prep(options)
        rig.abort.abort()
        return input
      },
    })(record, rig.io)

    // No agent was ever spawned…
    expect(flow.calls).toHaveLength(0)
    // …and the task settles as interrupted, never on a verdict.
    expect(record.status).toBe('interrupted')
    expect(record.reason?.code).toBe('interrupted_by_user')
    expect(rig.events.at(-1)).toEqual({
      type: 'interrupted',
      data: { reason: 'shutdown' },
      reason_code: 'interrupted_by_user',
    })
  })

  // T1.2 re-review round 9: this test USED to pass with the entry guard
  // deleted — the post-prep checkpoint settled the task the same way, so the
  // assertions below could not tell the two apart. What separates them is how
  // far the reviewer got: the entry guard means prep never ran and no
  // 'review_started' was ever emitted. Four checkpoints read the same signal
  // for four different reasons; a test that cannot say WHICH one fired is not
  // holding any of them.
  test('an abort BEFORE the review even starts spawns nothing at all', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'aborted at the gate')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: false, failure: 'run', message: 'must not be called' })
    let prepCalls = 0
    rig.abort.abort()

    await reviewer(repo, {
      runSimpleFlowFn: flow.fn,
      prepFn: (options) => {
        prepCalls += 1
        return prep(options)
      },
    })(record, rig.io)

    expect(flow.calls).toHaveLength(0)
    expect(record.status).toBe('interrupted')
    // The discriminator: the gate turned it away before ANY work — no prep on
    // a worktree, and not one event announcing a review that will not happen.
    expect(prepCalls).toBe(0)
    expect(rig.events.map((event) => event.type)).toEqual(['interrupted'])
  })

  // T1.3 (D4): the review agent is a heavy consumer of the machine load cap.
  test('the review agent holds a load-cap slot only around the actual flow call, EXCLUSIVELY', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'load-capped review')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const cap = createLoadCap(1)
    let sawItHeldExclusively = false
    const flow = fakeSimpleFlow(() => {
      // At the moment the agent would actually run, the slot must already be
      // held — and held EXCLUSIVELY: a fresh tryAcquire on the same cap fails.
      sawItHeldExclusively = cap.tryAcquire('turn') === null
      return { ok: true, record: fakeReview('approve'), reportLines: [] }
    })

    await reviewer(repo, { runSimpleFlowFn: flow.fn, loadCap: cap })(record, rig.io)

    expect(sawItHeldExclusively).toBe(true)
    expect(record.status).toBe('review_ok')
    // Released once the flow (and the settle that follows it) is done.
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
  })

  test('resolveCommand runs the task CLI, not the reviewer fallback', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'opencode review')
    record.agent = 'opencode run'
    saveTask(repo, record)
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, {
      command: 'claude -p',
      resolveCommand: (task) => (task.agent === 'opencode run' ? 'opencode run' : 'claude -p'),
      runSimpleFlowFn: flow.fn,
    })(record, rig.io)

    expect(flow.calls[0]?.agentCommand).toBe('opencode run')
    expect(record.status).toBe('review_ok')
  })

  test('the load-cap slot is released even when the review flow throws', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'failing review')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const cap = createLoadCap(1)
    const flow = fakeSimpleFlow(() => {
      throw new Error('agent crashed')
    })

    await reviewer(repo, { runSimpleFlowFn: flow.fn, loadCap: cap })(record, rig.io)

    expect(record.status).toBe('review_ko')
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
  })

  // CRITIQUE (adversarial review, T1.3): a review parked on a saturated cap
  // must react to Ctrl-C immediately, not sit until DRAIN_TIMEOUT_MS gives up
  // — the reproduction was exactly this: cap=1, review queued behind an
  // unrelated holder, io.signal fires, and nothing ever woke the wait.
  test('a review queued on a saturated cap is interrupted the instant io.signal fires, never spawning', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'parked on the cap')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const cap = createLoadCap(1)
    // An unrelated consumer holds the only slot: the review's acquire() must
    // join the FIFO instead of running immediately.
    const holderRelease = cap.tryAcquire('turn')
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    const done = reviewer(repo, { runSimpleFlowFn: flow.fn, loadCap: cap })(record, rig.io)
    // A real prep() runs first (actual git/filesystem work) before the hook
    // ever reaches its acquire() call — a fixed microtask count is not
    // enough to reach it, so poll instead.
    await until(() => cap.snapshot().queued === 1)
    // Still parked: the flow was never called, and the slot is still held by
    // the unrelated holder.
    expect(flow.calls).toHaveLength(0)

    rig.abort.abort()
    await done

    expect(flow.calls).toHaveLength(0)
    expect(record.status).toBe('interrupted')
    // The wait was abandoned, not granted: the FIFO must be empty (no waiter
    // left to leak a slot to later) and the unrelated holder's slot is
    // exactly what it was before — never taken, never double-freed.
    expect(cap.snapshot().queued).toBe(0)
    holderRelease?.()
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
  })

  test('a review parked on a saturated cap journals a named wait, never an error', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'named wait')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const cap = createLoadCap(1)
    const holderRelease = cap.tryAcquire('turn')
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    const done = reviewer(repo, { runSimpleFlowFn: flow.fn, loadCap: cap })(record, rig.io)
    await until(() => cap.snapshot().queued === 1)
    expect(rig.events.some((e) => e.type === 'queue' && e.data.name === 'machine_busy')).toBe(true)
    expect(rig.events.some((e) => e.type === 'error')).toBe(false)
    expect(rig.events.find((e) => e.type === 'queue')?.reason_code).toBe('resource_busy')
    holderRelease?.()
    await done
    expect(record.status).toBe('review_ok')
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
  })

  // Same fix, the other order: the signal is ALREADY up before the review
  // even reaches its acquire() call (a shutdown that landed during prep).
  test('a review with io.signal already aborted before acquiring never joins the FIFO, never spawns', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'already aborted')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const cap = createLoadCap(1)
    const holderRelease = cap.tryAcquire('turn')
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    // Aborted mid-prep, i.e. after the earlier gate but before this hook's
    // own acquire() call — the existing prep-time check in task-review.ts is
    // the one that would normally catch this; here we confirm the acquire
    // path is ALSO safe (belt and braces) should that ordering ever change.
    rig.abort.abort()
    await reviewer(repo, { runSimpleFlowFn: flow.fn, loadCap: cap })(record, rig.io)

    expect(flow.calls).toHaveLength(0)
    expect(record.status).toBe('interrupted')
    expect(cap.snapshot().queued).toBe(0)
    holderRelease?.()
    expect(cap.snapshot()).toEqual({ occupied: 0, max: 1, queued: 0 })
  })

  // T1.2 re-review round 9: the third checkpoint. The flow came back with a
  // perfectly formed verdict, but the agent that produced it was killed
  // mid-run by the shutdown — a half-run is not an opinion.
  test('an abort DURING the flow never lets its verdict through', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'aborted mid-flow')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    // Aborts while "running", then answers anyway — exactly what a killed
    // agent whose partial output still parses looks like from here.
    const flow = fakeSimpleFlow(() => {
      rig.abort.abort()
      return { ok: true, record: fakeReview('approve'), reportLines: [] }
    })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(flow.calls).toHaveLength(1)
    // NOT review_ok: the verdict is discarded, the shutdown is named.
    expect(record.status).toBe('interrupted')
    expect(record.reason?.code).toBe('interrupted_by_user')
    expect(rig.events.map((event) => event.type)).not.toContain('review_done')
    expect(rig.events.at(-1)?.type).toBe('interrupted')
  })

  // T1.2 re-review round 9: the fourth checkpoint, and the one whose loss is
  // worst. A killed agent surfaces as a REJECTION here; without this guard the
  // task lands on review_ko with reason_code 'review_blocked' — blaming the
  // reviewer for a Ctrl-C, on a terminal status the runner's own net does not
  // walk back.
  test('an abort that surfaces as a THROW is the shutdown, never a blocked review', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'aborted by rejection')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const flow = {
      calls: 0,
      fn: (): Promise<never> => {
        flow.calls += 1
        rig.abort.abort()
        return Promise.reject(new Error('agent killed'))
      },
    }

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(flow.calls).toBe(1)
    expect(record.status).toBe('interrupted')
    expect(record.reason?.code).toBe('interrupted_by_user')
    // Not one word accusing the review: no error event, no review_blocked.
    expect(rig.events.map((event) => event.type)).not.toContain('error')
    expect(rig.events.some((event) => event.reason_code === 'review_blocked')).toBe(false)
  })

  test('approve verdict: review_ok, archive in the MAIN repo, review_done event', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'green task')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(record.status).toBe('review_ok')
    // Real prep ran on the worktree: the flow saw the task's cumulative diff.
    expect(flow.calls[0]?.input.repo_root).toBe(record.worktree)
    expect(flow.calls[0]?.input.diff).toContain('feature.txt')
    expect(flow.calls[0]?.input.branch).toBe(record.branch)
    // And the shutdown's cut-off travelled INTO the flow — that forwarding is
    // what makes a Ctrl-C during a review immediate instead of a wait on the
    // reviewer's own 15-minute budget. Asserting it on the runner's seam only
    // proved the signal reached this module, never that it left it.
    expect(flow.calls[0]?.signal).toBe(rig.abort.signal)
    // Archived under <main repo>/.codesema/reviews, never in the worktree.
    expect(record.review_ref).toStartWith(join(repo, '.codesema', 'reviews'))
    expect(record.review_ref?.startsWith(record.worktree)).toBe(false)
    expect(existsSync(record.review_ref ?? '')).toBe(true)
    expect(rig.events.map((e) => e.type)).toEqual(['review_started', 'review_done'])
    // The event carries everything the card renders, archive included.
    expect(rig.events[1]?.data).toEqual({
      verdict: 'approve',
      findings_count: 0,
      ref: record.review_ref,
      summary: 'summary',
    })
  })

  test('review_done carries the archive ref, the summary and the severity spread', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'spread task')
    commitChange(record.worktree, 'work.txt')
    const rig = fakeIo(record)
    // D24: kind 'design' is exempt from the repro rule (a judgment call, not
    // a reproducible-behavior claim) — keeps this test's severities exactly
    // as the model reported them, isolated from verifyFindingRepros.
    const findings: Finding[] = [
      { file: 'work.txt', severity: 'critical', message: 'boom' },
      { file: 'work.txt', severity: 'major', kind: 'design', message: 'meh' },
      { file: 'work.txt', severity: 'major', kind: 'design', message: 'also meh' },
      { file: 'work.txt', severity: 'info', message: 'nit' },
    ]
    const flow = fakeSimpleFlow({
      ok: true,
      record: fakeReview('request_changes', findings),
      reportLines: [],
    })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(rig.events[1]?.data).toEqual({
      verdict: 'request_changes',
      findings_count: 4,
      ref: record.review_ref,
      summary: 'summary',
      severity_critical: 1,
      severity_major: 2,
      severity_info: 1,
    })
    // Empty severities are omitted, not sent as zeros.
    expect(rig.events[1]?.data).not.toHaveProperty('severity_minor')
    // The ref is the archive that was just written: the route can serve it.
    expect(readTaskReview(repo, record.id, String(rig.events[1]?.data.ref))?.review.verdict).toBe(
      'request_changes',
    )
  })

  test('request_changes verdict lands on review_ko with the findings count', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'red task')
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
    expect(rig.events[1]?.data).toMatchObject({
      verdict: 'request_changes',
      findings_count: 1,
      severity_critical: 1,
    })
  })

  test('a failed review is review_ko with an error event, never a throw', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'flaky review')
    commitChange(record.worktree, 'work.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: false, failure: 'run', message: 'agent timed out' })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(record.status).toBe('review_ko')
    expect(record.review_ref).toBeNull()
    expect(rig.events.map((e) => e.type)).toEqual(['review_started', 'error'])
    expect(rig.events[1]?.data.message).toBe('review failed: agent timed out')
  })

  test('a failed review names its degradation: review_blocked, message untouched', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'named failure')
    commitChange(record.worktree, 'work.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: false, failure: 'run', message: 'agent timed out' })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    // The code is added BESIDE the message, in its own field: the payload the
    // journal always carried is unchanged.
    expect(rig.events[1]?.reason_code).toBe('review_blocked')
    expect(rig.events[1]?.data).toEqual({ message: 'review failed: agent timed out' })
    // And the record restates the whole thing, message included.
    expect(record.reason).toEqual({
      code: 'review_blocked',
      detail: 'review failed: agent timed out',
    })
  })

  test('a request_changes verdict is a review_blocked record too, with no invented detail', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'blocked by findings')
    commitChange(record.worktree, 'work.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({
      ok: true,
      record: fakeReview('request_changes', [
        { file: 'work.txt', severity: 'critical', message: 'boom' },
      ]),
      reportLines: [],
    })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(record.status).toBe('review_ko')
    expect(record.reason).toEqual({ code: 'review_blocked' })
  })

  test('a review that passes clears the reason an earlier degradation left behind', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'recovered')
    commitChange(record.worktree, 'work.txt')
    record.reason = { code: 'review_blocked', detail: 'review failed: agent timed out' }
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(record.status).toBe('review_ok')
    expect('reason' in record).toBe(false)
  })

  test('a prep crash follows the same review_ko path', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'bad prep')
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
    const record = await makeTaskWithWorktree(repo, 'streamed review')
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
    const record = await makeTaskWithWorktree(repo, 'dual task')
    commitChange(record.worktree, 'work.txt')
    const rig = fakeIo(record)
    const simple = fakeSimpleFlow({ ok: false, failure: 'run', message: 'wrong flow' })
    let dualCalls = 0
    let dualSignal: AbortSignal | undefined

    await reviewer(repo, {
      mode: 'dual',
      runSimpleFlowFn: simple.fn,
      runDualFlowFn: (options) => {
        dualCalls++
        dualSignal = options.signal
        return Promise.resolve({ ok: true, record: fakeReview('approve'), reportLines: [] })
      },
    })(record, rig.io)

    expect(simple.calls).toHaveLength(0)
    expect(dualCalls).toBe(1)
    // The cut-off reaches THIS flow too: the two branches forward the signal
    // separately, so proving one says nothing about the other.
    expect(dualSignal).toBe(rig.abort.signal)
    expect(record.status).toBe('review_ok')
    expect(rig.events[0]).toMatchObject({ type: 'review_started', data: { mode: 'dual' } })
  })
})

// --- the baseline the review measures from --------------------------------

/** A work-on conversation: the branch already carries commits, the base is the MR target. */
async function makeWorkOnTask(repo: string): Promise<TaskRecord> {
  const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  run(['checkout', '-b', 'feature'])
  writeFileSync(join(repo, 'earlier.txt'), 'written before the conversation\n')
  run(['add', '-A'])
  run(['commit', '-m', 'feat: earlier work'])
  run(['checkout', 'main'])

  const record = createTask(repo, {
    title: 'work on feature',
    prompt: 'continue',
    autoShip: false,
    base: 'main',
    branch: 'feature',
    worktree: '',
    workOn: true,
  })
  const wt = await createTaskWorktree(repo, record.id, record.title, { branch: 'feature' })
  record.worktree = wt.worktree
  record.baseline_sha = wt.baseline
  record.status = 'reviewing'
  saveTask(repo, record)
  return record
}

describe('createTaskReviewer (baseline anchoring)', () => {
  test('work-on: the review measures from the baseline, not from the MR target', async () => {
    const repo = makeRepo()
    const record = await makeWorkOnTask(repo)
    commitChange(record.worktree, 'turn.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    // The baseline is the branch tip the conversation started from — NOT 'main'.
    expect(record.baseline_sha).not.toBe(
      execFileSync('git', ['rev-parse', 'main'], { cwd: repo }).toString().trim(),
    )
    // IDENTITY stays the branch this work is headed for; only the SCOPE moved.
    expect(flow.calls[0]?.input.target).toBe('main')
    expect(flow.calls[0]?.input.baseline).toBe(record.baseline_sha)
    // Only this conversation's work is reviewed: the commit that predates it is
    // behind the baseline and never reaches the reviewer.
    expect(flow.calls[0]?.input.files.map((f) => f.path)).toEqual(['turn.txt'])
    expect(flow.calls[0]?.input.diff).toContain('turn.txt')
    expect(flow.calls[0]?.input.diff).not.toContain('earlier.txt')
    // Nothing was said about a fallback, because none happened.
    expect(rig.events.map((e) => e.type)).toEqual(['review_started', 'review_done'])
  })

  test('a 0.12 record with no baseline falls back on base...HEAD, and SAYS so', async () => {
    const repo = makeRepo()
    const record = await makeWorkOnTask(repo)
    // Exactly what a record written before the baseline capture existed looks like.
    delete record.baseline_sha
    commitChange(record.worktree, 'turn.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    // The old behaviour, unchanged: the whole branch↔target gap, earlier
    // commits included.
    expect(flow.calls[0]?.input.target).toBe('main')
    expect(flow.calls[0]?.input.files.map((f) => f.path).toSorted()).toEqual([
      'earlier.txt',
      'turn.txt',
    ])
    // …and the degradation is stated in the journal rather than swallowed.
    expect(rig.events[0]?.type).toBe('message')
    expect(String(rig.events[0]?.data.text)).toContain('no baseline')
    expect(String(rig.events[0]?.data.text)).toContain('main...HEAD')
    expect(record.status).toBe('review_ok')
  })

  test('a baseline this worktree cannot resolve falls back the same way, and names it', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'orphaned anchor')
    // A sha that is a valid object name and names nothing here (a pruned
    // object, a branch rebuilt elsewhere): anchoring on it would fail the whole
    // review instead of measuring it.
    record.baseline_sha = 'dead'.repeat(10)
    commitChange(record.worktree, 'work.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(String(rig.events[0]?.data.text)).toContain('not reachable')
    expect(String(rig.events[0]?.data.text)).toContain('deaddeaddead')
    expect(flow.calls[0]?.input.target).toBe('main')
    expect(record.status).toBe('review_ok')
  })

  test('a baseline no longer behind HEAD falls back too: a rebased anchor measures nothing', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'rebased anchor')
    commitChange(record.worktree, 'work.txt')
    // A real commit of this repo, but on another line of history: `baseline..HEAD`
    // would diff against something HEAD never descended from.
    const sibling = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: record.worktree })
      .toString()
      .trim()
    execFileSync('git', ['checkout', '-q', '--detach', 'main'], { cwd: record.worktree })
    writeFileSync(join(record.worktree, 'other.txt'), 'other line\n')
    execFileSync('git', ['add', '-A'], { cwd: record.worktree })
    execFileSync('git', ['commit', '-q', '-m', 'other history'], { cwd: record.worktree })
    execFileSync('git', ['checkout', '-q', record.branch], { cwd: record.worktree })
    record.baseline_sha = execFileSync('git', ['rev-parse', 'HEAD@{1}'], { cwd: record.worktree })
      .toString()
      .trim()
    expect(record.baseline_sha).not.toBe(sibling)
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(String(rig.events[0]?.data.text)).toContain('no longer an ancestor')
    expect(flow.calls[0]?.input.target).toBe('main')
    expect(flow.calls[0]?.input.baseline).toBeUndefined()
    expect(record.status).toBe('review_ok')
  })

  test('the review is keyed by BRANCH and TARGET, never by a sha: re-reviews stay incremental', async () => {
    const repo = makeRepo()
    const record = await makeWorkOnTask(repo)
    commitChange(record.worktree, 'turn.txt')
    const rig = fakeIo(record)
    // The real flow builds its record's meta from the prep input (record.ts's
    // buildRecord): mirror that, since the archive key is what is under test.
    const flow = fakeSimpleFlow((options) => ({
      ok: true,
      record: {
        ...fakeReview('approve'),
        meta: {
          ...fakeReview('approve').meta,
          branch: options.input.branch,
          target: options.input.target,
          head_sha: options.input.head_sha,
        },
      },
      reportLines: [],
    }))

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    // What the header, the export and the prompt show is the branch and its
    // target — a raw sha there would be unreadable, and it would change the
    // archive key findPreviousReview matches on, silently killing incremental
    // re-review.
    const input = flow.calls[0]?.input
    expect(input?.branch).toBe('feature')
    expect(input?.target).toBe('main')
    expect(input?.target).not.toMatch(/^[0-9a-f]{40}$/)
    // Same for the prompt the reviewing agent is handed: it names the branch
    // and its target, never the anchor's sha.
    expect(flow.calls[0]?.prompt).toContain('main')
    expect(flow.calls[0]?.prompt).not.toContain(String(record.baseline_sha))
    // The next turn's incremental lookup finds this turn's archive.
    expect(findPreviousReview(repo, 'feature', 'main')?.meta.head_sha).toBe(String(input?.head_sha))
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

// --- readTaskReview -------------------------------------------------------

describe('readTaskReview', () => {
  /** A persisted task whose review_ref points at a real archive. */
  function reviewedTask(repo: string, verdict: Verdict = 'approve'): TaskRecord {
    const record = createTask(repo, {
      title: 'reviewed',
      prompt: 'do work',
      autoShip: false,
      base: 'main',
      branch: 'codesema/task-x',
      worktree: join(repo, 'wt'),
    })
    record.review_ref = archiveRecord(fakeReview(verdict), repo)
    saveTask(repo, record)
    return record
  }

  test('serves the task review_ref by default', () => {
    const repo = makeRepo()
    const task = reviewedTask(repo, 'request_changes')
    expect(readTaskReview(repo, task.id)?.review.verdict).toBe('request_changes')
  })

  test('an explicit ref serves THAT archive, so old turns keep their review', () => {
    const repo = makeRepo()
    const task = reviewedTask(repo, 'approve')
    // Another turn's archive (a distinct branch keeps it a distinct file:
    // archive names are stamped to the second). The task points at its own,
    // the ref opens the one the caller asked for.
    const other = fakeReview('request_changes')
    other.meta.branch = 'codesema/task-y'
    const otherRef = archiveRecord(other, repo)
    expect(readTaskReview(repo, task.id, otherRef)?.review.verdict).toBe('request_changes')
    expect(readTaskReview(repo, task.id)?.review.verdict).toBe('approve')
  })

  test('a ref outside .codesema/reviews is refused, absolute or traversing', () => {
    const repo = makeRepo()
    const task = reviewedTask(repo)
    const outside = join(repo, 'secret.json')
    writeFileSync(outside, JSON.stringify(fakeReview('approve')))
    expect(readTaskReview(repo, task.id, outside)).toBeNull()
    expect(readTaskReview(repo, task.id, '../../secret.json')).toBeNull()
    expect(readTaskReview(repo, task.id, '../tasks')).toBeNull()
    // The directory itself is not an archive either.
    expect(readTaskReview(repo, task.id, join(repo, '.codesema', 'reviews'))).toBeNull()
  })

  test('null on an unknown task, a task without a review and a corrupt archive', () => {
    const repo = makeRepo()
    expect(readTaskReview(repo, 'aaaaaaaaaaaa')).toBeNull()
    expect(readTaskReview(repo, 'not-an-id')).toBeNull()
    const bare = createTask(repo, {
      title: 'never reviewed',
      prompt: 'p',
      autoShip: false,
      base: 'main',
      branch: 'b',
      worktree: '',
    })
    expect(readTaskReview(repo, bare.id)).toBeNull()
    // Archived path kept, file gone or unreadable: a miss, never a throw.
    const task = reviewedTask(repo)
    writeFileSync(task.review_ref ?? '', '{not json')
    expect(readTaskReview(repo, task.id)).toBeNull()
    expect(readTaskReview(repo, task.id, join('reviews', 'nope.json'))).toBeNull()
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

// --- T3.2: the acceptance-criteria gate ------------------------------------

function criterionOf(text: string): AcceptanceCriterion {
  return { id: acceptanceCriterionId(text), text }
}

const GC1 = criterionOf('WHEN a task ships THE SYSTEM SHALL write a recap')
const GC2 = criterionOf('WHEN checks fail THE SYSTEM SHALL block the merge')
const GC3 = criterionOf('WHEN a criterion is unclear THE SYSTEM SHALL refuse to merge')

/** A diff whose `feature.txt` hunk really starts at new-file line 1. */
const GATE_DIFF = [
  'diff --git a/feature.txt b/feature.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/feature.txt',
  '@@ -0,0 +1,2 @@',
  '+content of feature.txt',
  '+second line',
].join('\n')

const ANCHOR = 'feature.txt:1 — the feature lands here'

/** The review record a flow would produce, carrying a real diff to ground against. */
function fakeReviewWithCriteria(
  verdict: Verdict,
  criteria: CriterionVerdict[] | undefined,
): ReviewRecord {
  const base = fakeReview(verdict)
  return {
    ...base,
    diff: GATE_DIFF,
    review: { ...base.review, ...(criteria ? { criteria } : {}) },
  }
}

/** A task whose acceptance criteria were validated by a human (T2.5). */
async function makeTaskWithCriteria(repo: string, title: string): Promise<TaskRecord> {
  const record = await makeTaskWithWorktree(repo, title)
  record.criteria = [GC1, GC2, GC3]
  saveTask(repo, record)
  return record
}

type DualFlowOptions = Parameters<typeof runDualFlow>[0]

function fakeDualFlow(outcome: DualOutcome) {
  const calls: DualFlowOptions[] = []
  const fn = (options: DualFlowOptions): Promise<DualOutcome> => {
    calls.push(options)
    return Promise.resolve(outcome)
  }
  return { calls, fn }
}

describe('createTaskReviewer: the criteria chapter (T3.2)', () => {
  test('a task with criteria gets a chapter naming every stable id, one per line', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithCriteria(repo, 'ticketed task')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({
      ok: true,
      record: fakeReviewWithCriteria('approve', [
        { criterion_id: GC1.id, status: 'met', evidence: ANCHOR },
        { criterion_id: GC2.id, status: 'met', evidence: ANCHOR },
        { criterion_id: GC3.id, status: 'met', evidence: ANCHOR },
      ]),
      reportLines: [],
    })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    const prompt = flow.calls[0]?.prompt ?? ''
    for (const criterion of [GC1, GC2, GC3]) {
      const lines = prompt.split('\n').filter((line) => line.includes(criterion.id))
      expect(lines).toHaveLength(1)
    }
  })

  test('a task with NO criteria gets a prompt byte-identical to the one without the chapter', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'plain task')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    const prompt = flow.calls[0]?.prompt ?? ''
    expect(prompt).not.toContain('Acceptance criteria — MANDATORY chapter')
    expect(prompt).toBe(buildFullReviewPrompt(flow.calls[0]?.input as never))
    expect(record.status).toBe('review_ok')
    expect(rig.events.some((event) => event.type === 'criteria')).toBe(false)
  })

  test('an empty diff short-circuits BEFORE any chapter is built and any model is called', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithCriteria(repo, 'idle ticketed task')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: false, failure: 'run', message: 'must not be called' })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(flow.calls).toHaveLength(0)
    expect(record.status).toBe('review_ok')
    expect(rig.events).toEqual([{ type: 'message', data: { text: 'no changes' } }])
  })

  test('criteria frozen from a forge issue drive the chapter too, not just a validated list', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'issue-driven task')
    // T2.4's frozen snapshot, with NO top-level list: the precedence lives in
    // taskCriteria(), and reading record.criteria alone would judge nothing.
    record.issue_snapshot = {
      body_hash: 'sha256:t2:abc',
      criteria: [GC1, GC2, GC3],
      taken_at: '2026-08-20T09:00:00.000Z',
    }
    saveTask(repo, record)
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({
      ok: true,
      record: fakeReviewWithCriteria('approve', undefined),
      reportLines: [],
    })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    for (const criterion of [GC1, GC2, GC3]) {
      expect(flow.calls[0]?.prompt).toContain(criterion.id)
    }
    expect(record.status).toBe('review_ko')
    expect(record.reason?.code).toBe('criteria_unmet')
  })

  test('the chapter is judged on the baseline range, like the rest of the review', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithCriteria(repo, 'anchored ticketed task')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({
      ok: true,
      record: fakeReviewWithCriteria('approve', undefined),
      reportLines: [],
    })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(flow.calls[0]?.input.baseline).toBe(String(record.baseline_sha))
  })
})

// --- D16: the checks chapter -----------------------------------------------

function checksAt(over: Partial<TaskChecks> = {}): TaskChecks {
  return {
    head_sha: 'whatever',
    started_at: '2026-08-26T10:00:00.000Z',
    finished_at: '2026-08-26T10:01:00.000Z',
    status: 'passed',
    error: null,
    checks: [],
    ...over,
  }
}

describe('createTaskReviewer: the checks chapter (D16)', () => {
  test('a red checks run reaches the review prompt as its own MANDATORY chapter', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'checked task')
    commitChange(record.worktree, 'feature.txt')
    writeTaskChecks(
      repo,
      record.id,
      checksAt({
        status: 'failed',
        source: 'scripts',
        checks: [
          {
            command: 'bun test',
            status: 'failed',
            exit_code: 1,
            duration_ms: 5,
            tail: 'FAIL feature.test.ts',
          },
        ],
      }),
    )
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    const prompt = flow.calls[0]?.prompt ?? ''
    expect(prompt).toContain('Repository checks, MANDATORY chapter')
    expect(prompt).toContain('- bun test: failed')
    expect(prompt).toContain('FAIL feature.test.ts')
  })

  test('a task with no checks.json at all gets no checks chapter', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'unchecked task')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(flow.calls[0]?.prompt ?? '').not.toContain('Repository checks')
  })

  test('a still-RUNNING checks snapshot is not a result yet: no chapter either', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'running-checks task')
    commitChange(record.worktree, 'feature.txt')
    writeTaskChecks(repo, record.id, checksAt({ status: 'running', finished_at: null }))
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(flow.calls[0]?.prompt ?? '').not.toContain('Repository checks')
  })
})

// --- D17: the visual proof chapter -----------------------------------------

function fakeReviewWithProof(
  verdict: Verdict,
  findings: Finding[],
  proofReview: ProofReview,
): ReviewRecord {
  const base = fakeReview(verdict, findings)
  return { ...base, review: { ...base.review, proof_review: proofReview } }
}

describe('createTaskReviewer: the visual proof chapter (D17)', () => {
  test('no proof configured: no chapter, and no evidence.json is ever touched', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'unconfigured proof task')
    record.isolation = 'microvm'
    saveTask(repo, record)
    commitChange(record.worktree, 'App.vue')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(flow.calls[0]?.prompt ?? '').not.toContain('Visual proof')
    expect(readTaskEvidence(repo, record.id)).toBeNull()
  })

  test('a non-microvm task never gets the chapter, even with proof configured', async () => {
    const repo = makeRepo()
    writeProofConfig(repo)
    const record = await makeTaskWithWorktree(repo, 'policy-isolated task')
    commitChange(record.worktree, 'App.vue')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(flow.calls[0]?.prompt ?? '').not.toContain('Visual proof')
  })

  test('a microvm task with proof configured gets the chapter, naming the UI files and the grid', async () => {
    const repo = makeRepo()
    writeProofConfig(repo)
    const record = await makeTaskWithWorktree(repo, 'proof-eligible task')
    record.isolation = 'microvm'
    saveTask(repo, record)
    commitChange(record.worktree, 'App.vue')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    const prompt = flow.calls[0]?.prompt ?? ''
    expect(prompt).toContain('Visual proof (MANDATORY chapter)')
    expect(prompt).toContain('UI files touched by this diff: App.vue')
    expect(prompt).toContain('"proof_review"')
    expect(prompt).toContain('declaration: the agent did not declare a proof this turn')
    expect(prompt).toContain('proof produced: no proof for this commit')
  })

  test('evidence from a DIFFERENT head_sha than the reviewed record is never read', async () => {
    const repo = makeRepo()
    writeProofConfig(repo)
    const record = await makeTaskWithWorktree(repo, 'stale evidence task')
    record.isolation = 'microvm'
    record.head_sha = 'a'.repeat(40)
    saveTask(repo, record)
    commitChange(record.worktree, 'App.vue')
    writeTaskEvidence(repo, record.id, {
      version: 1,
      status: 'passed',
      reason: null,
      head_sha: 'b'.repeat(40),
      items: [
        {
          kind: 'screenshot',
          path: 'x.png',
          bytes: 10,
          turn: 1,
          created_at: new Date().toISOString(),
        },
      ],
    })
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    const prompt = flow.calls[0]?.prompt ?? ''
    expect(prompt).toContain('proof produced: no proof for this commit')
    expect(prompt).not.toContain('x.png')
  })

  test('an incoherent proof_review with a design/major finding blocks the task via hasBlockingFindings, and evidence.json records the verdict for the matching head_sha', async () => {
    const repo = makeRepo()
    writeProofConfig(repo)
    const record = await makeTaskWithWorktree(repo, 'incoherent proof task')
    record.isolation = 'microvm'
    record.head_sha = 'c'.repeat(40)
    saveTask(repo, record)
    commitChange(record.worktree, 'App.vue')
    writeTaskEvidence(repo, record.id, {
      version: 1,
      status: 'skipped',
      reason: 'undeclared, defaulted to none',
      head_sha: 'c'.repeat(40),
      items: [],
    })
    const rig = fakeIo(record)
    const finding: Finding = {
      file: 'App.vue',
      line: 1,
      severity: 'major',
      kind: 'design',
      message: 'the interface changed but no proof was captured for it',
    }
    const proofReview: ProofReview = {
      expected: 'screenshot',
      coherent: false,
      reason: 'the diff shows a visible UI change with no captured proof',
    }
    const flow = fakeSimpleFlow({
      ok: true,
      record: fakeReviewWithProof('approve', [finding], proofReview),
      reportLines: [],
    })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(record.status).toBe('review_ko')
    const evidence = readTaskEvidence(repo, record.id)
    expect(evidence?.review).toEqual(proofReview)
  })

  test('a coherent proof_review with no finding never blocks, and still records the verdict', async () => {
    const repo = makeRepo()
    writeProofConfig(repo)
    const record = await makeTaskWithWorktree(repo, 'coherent proof task')
    record.isolation = 'microvm'
    record.head_sha = 'd'.repeat(40)
    saveTask(repo, record)
    commitChange(record.worktree, 'App.vue')
    writeTaskEvidence(repo, record.id, {
      version: 1,
      status: 'skipped',
      reason: 'no visible effect',
      head_sha: 'd'.repeat(40),
      items: [],
    })
    const rig = fakeIo(record)
    const proofReview: ProofReview = {
      expected: 'none',
      coherent: true,
      reason: 'a pure refactor with no rendered difference',
    }
    const flow = fakeSimpleFlow({
      ok: true,
      record: fakeReviewWithProof('approve', [], proofReview),
      reportLines: [],
    })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(record.status).toBe('review_ok')
    const evidence = readTaskEvidence(repo, record.id)
    expect(evidence?.review).toEqual(proofReview)
  })

  test('the chapter was injected but the reviewer JSON carries no proof_review: journaled, never invented', async () => {
    const repo = makeRepo()
    writeProofConfig(repo)
    const record = await makeTaskWithWorktree(repo, 'silent proof task')
    record.isolation = 'microvm'
    record.head_sha = 'e'.repeat(40)
    saveTask(repo, record)
    commitChange(record.worktree, 'App.vue')
    writeTaskEvidence(repo, record.id, {
      version: 1,
      status: 'skipped',
      reason: 'no visible effect',
      head_sha: 'e'.repeat(40),
      items: [],
    })
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    const proofEvents = rig.events.filter((event) => event.type === 'proof')
    expect(proofEvents).toHaveLength(1)
    expect(proofEvents[0]?.data).toMatchObject({ name: 'review_missing' })
    expect(readTaskEvidence(repo, record.id)?.review).toBeUndefined()
  })

  test('no chapter was injected: a missing proof_review is never journaled', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'no chapter, no proof event task')
    commitChange(record.worktree, 'App.vue')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(rig.events.some((event) => event.type === 'proof')).toBe(false)
  })
})

// --- D17: mechanical criteria decided without the reviewer ------------------

describe('createTaskReviewer: mechanical criteria (D17)', () => {
  test('a [proof:command] criterion is decided from the turn checks, never sent to the model', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'mechanical task')
    const mechanicalCriterion = criterionOf(
      'WHEN the suite runs THE SYSTEM SHALL pass it [proof:command bun test]',
    )
    const judgedCriterion = criterionOf('WHEN reviewed THE SYSTEM SHALL be judged by a human')
    record.criteria = [mechanicalCriterion, judgedCriterion]
    saveTask(repo, record)
    commitChange(record.worktree, 'feature.txt')
    writeTaskChecks(
      repo,
      record.id,
      checksAt({
        checks: [{ command: 'bun test', status: 'passed', exit_code: 0, duration_ms: 5, tail: '' }],
      }),
    )
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({
      ok: true,
      record: fakeReviewWithCriteria('approve', [
        { criterion_id: judgedCriterion.id, status: 'met', evidence: ANCHOR },
      ]),
      reportLines: [],
    })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    // The mechanical criterion never reached the model's own prompt...
    const prompt = flow.calls[0]?.prompt ?? ''
    expect(prompt).not.toContain(mechanicalCriterion.id)
    expect(prompt).toContain(judgedCriterion.id)
    // ...yet the final gate still carries a verdict for it, decided from the
    // checks that already ran, and the task is not blocked on it.
    expect(record.status).toBe('review_ok')
    const gateEvents = rig.events.filter((e) => e.type === 'criteria')
    expect(gateEvents).toHaveLength(1)
    expect(gateEvents[0]?.data).toMatchObject({ name: 'gate_passed', met: 2, unmet: 0, unclear: 0 })
  })

  test('a [proof:command] criterion whose command FAILED in the turn checks blocks the gate', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'mechanical failing task')
    const mechanicalCriterion = criterionOf(
      'WHEN the suite runs THE SYSTEM SHALL pass it [proof:command bun test]',
    )
    record.criteria = [mechanicalCriterion]
    saveTask(repo, record)
    commitChange(record.worktree, 'feature.txt')
    writeTaskChecks(
      repo,
      record.id,
      checksAt({
        status: 'failed',
        checks: [{ command: 'bun test', status: 'failed', exit_code: 1, duration_ms: 5, tail: '' }],
      }),
    )
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({
      ok: true,
      record: fakeReviewWithCriteria('approve', undefined),
      reportLines: [],
    })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    // review_ko for TWO independent reasons here (the checks gate AND the
    // criteria gate); either is a correct block, what matters is it is one.
    expect(record.status).toBe('review_ko')
    const gateEvent = rig.events.find((e) => e.type === 'criteria')
    expect(gateEvent?.data).toMatchObject({ unmet: 1 })
  })
})

describe('createTaskReviewer: the hard gate (T3.2)', () => {
  const allMet: CriterionVerdict[] = [
    { criterion_id: GC1.id, status: 'met', evidence: ANCHOR },
    { criterion_id: GC2.id, status: 'met', evidence: 'feature.txt:2 — and here' },
    { criterion_id: GC3.id, status: 'met', evidence: ANCHOR },
  ]

  async function runGate(
    criteria: CriterionVerdict[] | undefined,
    verdict: Verdict = 'approve',
  ): Promise<{ record: TaskRecord; rig: IoRig; repo: string }> {
    const repo = makeRepo()
    const record = await makeTaskWithCriteria(repo, 'gated task')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({
      ok: true,
      record: fakeReviewWithCriteria(verdict, criteria),
      reportLines: [],
    })
    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)
    return { record, rig, repo }
  }

  test('every criterion met and anchored: the gate does not block', async () => {
    const { record, rig } = await runGate(allMet)
    expect(record.status).toBe('review_ok')
    expect(record.reason).toBeUndefined()
    const gate = rig.events.find((event) => event.type === 'criteria')
    // No `unknown_ids`, no `diff_unreadable`: those keys appear only when the
    // thing they name actually happened.
    expect(gate?.data).toEqual({ name: 'gate_passed', met: 3, unmet: 0, unclear: 0 })
    expect(gate?.reason_code).toBeUndefined()
  })

  test('a single unmet blocks with criteria_unmet, message and journal line', async () => {
    const { record, rig } = await runGate([
      { criterion_id: GC1.id, status: 'met', evidence: ANCHOR },
      { criterion_id: GC2.id, status: 'unmet' },
      { criterion_id: GC3.id, status: 'met', evidence: ANCHOR },
    ])
    expect(record.status).toBe('review_ko')
    expect(record.reason?.code).toBe('criteria_unmet')
    expect(record.reason?.detail).toContain(GC2.id)
    expect(record.reason?.detail).toContain('unmet')
    const gate = rig.events.find((event) => event.type === 'criteria')
    expect(gate?.data.name).toBe('gate_blocked')
    expect(gate?.reason_code).toBe('criteria_unmet')
    // Never an 'error': the review itself worked, the WORK is what falls short.
    expect(rig.events.some((event) => event.type === 'error')).toBe(false)
  })

  test('a sincere unclear is LIFTED by the settled OK review, out loud (D18)', async () => {
    const { record, rig } = await runGate([
      { criterion_id: GC1.id, status: 'met', evidence: ANCHOR },
      { criterion_id: GC2.id, status: 'met', evidence: ANCHOR },
      { criterion_id: GC3.id, status: 'unclear' },
    ])
    expect(record.status).toBe('review_ok')
    expect(record.reason).toBeUndefined()
    expect(rig.events.find((event) => event.type === 'criteria')?.data).toEqual({
      name: 'gate_waived',
      met: 2,
      unmet: 0,
      unclear: 1,
    })
    const waived = rig.events.find(
      (event) => event.type === 'message' && event.data.name === 'criteria_unclear_waived',
    )
    expect(waived?.data.text).toContain('1')
  })

  test('a criterion the model skipped blocks: silence is never a pass', async () => {
    const { record } = await runGate([
      { criterion_id: GC1.id, status: 'met', evidence: ANCHOR },
      { criterion_id: GC2.id, status: 'met', evidence: ANCHOR },
    ])
    expect(record.status).toBe('review_ko')
    expect(record.reason?.detail).toContain(GC3.id)
  })

  test('a model that says nothing at all about criteria blocks all of them', async () => {
    const { record, rig } = await runGate(undefined)
    expect(record.status).toBe('review_ko')
    // Round 2, majeur 1(b): `unjudged` rides on the SAME line as the counts.
    // Without it this payload was byte-identical to the one a reviewer that
    // weighed the work and doubted produces (the test just below), and the
    // journal claimed "the reviewer is unsure" where the truth was "nothing
    // usable came back at all".
    expect(rig.events.find((event) => event.type === 'criteria')?.data).toEqual({
      name: 'gate_blocked',
      met: 0,
      unmet: 0,
      unclear: 3,
      unjudged: 3,
    })
    expect(record.reason?.detail).toContain('no verdict back from the reviewer')
  })

  test('…and a reviewer that judged all three and doubted is waived, unlike silence (D18)', async () => {
    // The discriminator for the line above: identical tally, different fact,
    // different outcome. Silence (unjudged) blocks; a sincere doubt on every
    // criterion rides the settled OK verdict, and the gate line says which.
    const { record, rig } = await runGate([
      { criterion_id: GC1.id, status: 'unclear' },
      { criterion_id: GC2.id, status: 'unclear' },
      { criterion_id: GC3.id, status: 'unclear' },
    ])
    expect(record.status).toBe('review_ok')
    expect(rig.events.find((event) => event.type === 'criteria')?.data).toEqual({
      name: 'gate_waived',
      met: 0,
      unmet: 0,
      unclear: 3,
    })
  })

  test('the waiver outranks the raw verdict label: request_changes with no finding still ships (D26)', async () => {
    // The exact incident shape: the model's OWN doubt about a criterion leaked
    // into its top-level verdict, with nothing findings-wise behind it. D18's
    // waiver used to require verdict === 'review_ok' and would never even be
    // considered here; D26 drops that requirement.
    const { record, rig } = await runGate(
      [
        { criterion_id: GC1.id, status: 'met', evidence: ANCHOR },
        { criterion_id: GC2.id, status: 'met', evidence: ANCHOR },
        {
          criterion_id: GC3.id,
          status: 'unclear',
          question: 'is this the same pattern as the sibling helper?',
        },
      ],
      'request_changes',
    )
    expect(record.status).toBe('review_ok')
    expect(record.reason).toBeUndefined()
    expect(rig.events.find((event) => event.type === 'criteria')?.data.name).toBe('gate_waived')
  })

  test('a request_changes carrying an actual blocking finding still blocks (D26 non-regression)', async () => {
    // The waiver's own condition — no blocking finding — is unaffected: a
    // genuine major/critical finding still wins whatever the criteria gate
    // would otherwise waive.
    const repo = makeRepo()
    const record = await makeTaskWithCriteria(repo, 'gated task')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const base = fakeReview('request_changes', [
      { file: 'src/a.ts', line: 1, severity: 'major', kind: 'design', title: 'x', message: 'y' },
    ])
    const flow = fakeSimpleFlow({
      ok: true,
      record: {
        ...base,
        diff: GATE_DIFF,
        review: {
          ...base.review,
          criteria: [
            { criterion_id: GC1.id, status: 'met', evidence: ANCHOR },
            { criterion_id: GC2.id, status: 'met', evidence: ANCHOR },
            {
              criterion_id: GC3.id,
              status: 'unclear',
              question: 'what should happen on empty input?',
            },
          ],
        },
      },
      reportLines: [],
    })
    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)
    expect(record.status).toBe('review_ko')
  })

  test('an evidence the diff cannot carry is journaled as such, not as a doubt', async () => {
    const { record, rig } = await runGate([
      { criterion_id: GC1.id, status: 'met', evidence: 'src/ghost.ts:9 — not in this diff' },
      { criterion_id: GC2.id, status: 'met', evidence: ANCHOR },
      { criterion_id: GC3.id, status: 'met', evidence: ANCHOR },
    ])
    expect(record.status).toBe('review_ko')
    expect(rig.events.find((event) => event.type === 'criteria')?.data).toEqual({
      name: 'gate_blocked',
      met: 2,
      unmet: 0,
      unclear: 1,
      dropped_evidence: 1,
      demoted: 1,
    })
    expect(record.reason?.detail).toContain('pointed at a line this diff does not carry')
  })

  test('a proof the model wrapped in backticks satisfies the gate exactly like a bare one', async () => {
    // Round 2, majeur 1(a), end to end: the SAME criteria with the SAME proofs,
    // decorated. This used to settle `review_ko` with three `unclear`.
    const { record, rig } = await runGate([
      { criterion_id: GC1.id, status: 'met', evidence: `\`${ANCHOR}\`` },
      { criterion_id: GC2.id, status: 'met', evidence: `\`${ANCHOR}\`` },
      { criterion_id: GC3.id, status: 'met', evidence: `\`${ANCHOR}\`` },
    ])
    expect(record.status).toBe('review_ok')
    expect(rig.events.find((event) => event.type === 'criteria')?.data).toEqual({
      name: 'gate_passed',
      met: 3,
      unmet: 0,
      unclear: 0,
    })
  })

  test('an approve whose criteria are met and anchored is NOT downgraded', async () => {
    // The discriminator against "the gate blocks whenever it runs": same
    // reviewer verdict, same task, only the statuses differ.
    const { record } = await runGate(allMet)
    expect(record.status).toBe('review_ok')
  })

  test('a met whose evidence points outside the diff does not survive the gate', async () => {
    const { record } = await runGate([
      { criterion_id: GC1.id, status: 'met', evidence: 'src/ghost.ts:9 — not in this diff' },
      { criterion_id: GC2.id, status: 'met', evidence: ANCHOR },
      { criterion_id: GC3.id, status: 'met', evidence: ANCHOR },
    ])
    expect(record.status).toBe('review_ko')
    expect(record.reason?.detail).toContain(`${GC1.id}: unclear`)
  })

  test('an id the model invented is discarded and cannot fill a criterion', async () => {
    const invented = acceptanceCriterionId('WHEN nothing THE SYSTEM SHALL nothing')
    const { record, rig } = await runGate([
      { criterion_id: GC1.id, status: 'met', evidence: ANCHOR },
      { criterion_id: GC2.id, status: 'met', evidence: ANCHOR },
      { criterion_id: invented, status: 'met', evidence: ANCHOR },
    ])
    expect(record.status).toBe('review_ko')
    expect(record.reason?.detail).toContain(`${GC3.id}: unclear`)
    expect(record.reason?.detail).not.toContain(invented)
    // …and the drift is SAID: the entry was discarded, not absorbed.
    expect(rig.events.find((event) => event.type === 'criteria')?.data.unknown_ids).toBe(1)
  })

  test('a review that already blocks keeps ITS reason: criteria never relabel a KO', async () => {
    const { record } = await runGate(
      [
        { criterion_id: GC1.id, status: 'unmet' },
        { criterion_id: GC2.id, status: 'unmet' },
        { criterion_id: GC3.id, status: 'unmet' },
      ],
      'request_changes',
    )
    expect(record.status).toBe('review_ko')
    expect(record.reason?.code).toBe('review_blocked')
  })

  test('the normalized statuses land in the ARCHIVE, readable at a later boot', async () => {
    const { record, repo } = await runGate([
      { criterion_id: GC1.id, status: 'met', evidence: ANCHOR },
      { criterion_id: GC2.id, status: 'unmet' },
    ])
    saveTask(repo, record)
    // What the API serves is the PERSISTED record, not the in-memory one the
    // reviewer mutated: `criteria_unmet` has to survive the round-trip.
    expect(loadTask(repo, record.id)?.reason?.code).toBe('criteria_unmet')
    expect(loadTask(repo, record.id)?.reason?.detail).toContain(GC2.id)
    // Read back exactly the way T3.6 will: off disk, through sanitizeRecord's
    // strict whitelist, in a process that knows nothing of this review.
    const archived = readTaskReview(repo, record.id)
    expect(archived?.review.criteria).toEqual([
      { criterion_id: GC1.id, status: 'met', evidence: ANCHOR },
      { criterion_id: GC2.id, status: 'unmet' },
      { criterion_id: GC3.id, status: 'unclear' },
    ])
  })

  test('a diff the grounding cannot index blocks AND says it could not check anything', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithCriteria(repo, 'blind gate')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const blind = fakeReviewWithCriteria('approve', [
      { criterion_id: GC1.id, status: 'met', evidence: ANCHOR },
      { criterion_id: GC2.id, status: 'met', evidence: ANCHOR },
      { criterion_id: GC3.id, status: 'met', evidence: ANCHOR },
    ])
    const flow = fakeSimpleFlow({
      ok: true,
      record: { ...blind, diff: 'this is not a unified diff' },
      reportLines: [],
    })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(record.status).toBe('review_ko')
    expect(record.reason?.code).toBe('criteria_unmet')
    // The tally alone ("3 unclear") would read as "the reviewer was unsure",
    // which is not what happened: nothing could be checked at all.
    expect(record.reason?.detail).toContain('could not be indexed')
    expect(rig.events.find((event) => event.type === 'criteria')?.data.diff_unreadable).toBe(true)
  })

  test('a review failure on a ticketed task is still review_ko + error, never a failed task', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithCriteria(repo, 'broken review')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: false, failure: 'run', message: 'agent crashed' })

    await expect(
      reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io),
    ).resolves.toBeUndefined()

    expect(record.status).toBe('review_ko')
    expect(record.reason?.code).toBe('review_blocked')
    expect(rig.events.some((event) => event.type === 'error')).toBe(true)
    // No criteria line at all: nothing was judged, so nothing is claimed.
    expect(rig.events.some((event) => event.type === 'criteria')).toBe(false)
  })
})

describe('createTaskReviewer: explicit review mode (T3.2)', () => {
  test("mode 'simple' runs the simple flow and never the dual one", async () => {
    const repo = makeRepo()
    const record = await makeTaskWithCriteria(repo, 'simple mode')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const simple = fakeSimpleFlow({
      ok: true,
      record: fakeReviewWithCriteria('approve', undefined),
      reportLines: [],
    })
    const dual = fakeDualFlow({ ok: false, failure: 'run', message: 'must not be called' })

    await reviewer(repo, {
      mode: 'simple',
      runSimpleFlowFn: simple.fn,
      runDualFlowFn: dual.fn,
    })(record, rig.io)

    expect(simple.calls).toHaveLength(1)
    expect(dual.calls).toHaveLength(0)
    expect(rig.events.find((event) => event.type === 'review_started')?.data.mode).toBe('simple')
  })

  test("mode 'dual' runs the dual flow, chapter included, and never the simple one", async () => {
    const repo = makeRepo()
    const record = await makeTaskWithCriteria(repo, 'dual mode')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const simple = fakeSimpleFlow({ ok: false, failure: 'run', message: 'must not be called' })
    const dual = fakeDualFlow({
      ok: true,
      record: fakeReviewWithCriteria('approve', [
        { criterion_id: GC1.id, status: 'met', evidence: ANCHOR },
        { criterion_id: GC2.id, status: 'met', evidence: ANCHOR },
        { criterion_id: GC3.id, status: 'met', evidence: ANCHOR },
      ]),
      reportLines: [],
    })

    await reviewer(repo, {
      mode: 'dual',
      runSimpleFlowFn: simple.fn,
      runDualFlowFn: dual.fn,
    })(record, rig.io)

    expect(simple.calls).toHaveLength(0)
    expect(dual.calls).toHaveLength(1)
    // The chapter reaches BOTH lanes' prompts through this one argument: a
    // dual review that never saw the criteria would judge none and block the
    // task forever.
    const chapter = dual.calls[0]?.criteriaChapter ?? ''
    for (const criterion of [GC1, GC2, GC3]) {
      expect(chapter).toContain(criterion.id)
    }
    expect(rig.events.find((event) => event.type === 'review_started')?.data.mode).toBe('dual')
    expect(record.status).toBe('review_ok')
  })

  test('a task without criteria hands the dual flow no chapter at all', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'dual, no ticket')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const dual = fakeDualFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { mode: 'dual', runDualFlowFn: dual.fn })(record, rig.io)

    expect(dual.calls[0]?.criteriaChapter).toBeUndefined()
  })
})

// --- the deterministic guard-rail (T3.3) ----------------------------------

describe('hasBlockingFindings', () => {
  const critical: Finding = { file: 'a.ts', severity: 'critical', message: 'auth bypass' }
  const major: Finding = { file: 'a.ts', severity: 'major', message: 'leaks a descriptor' }
  const minor: Finding = { file: 'a.ts', severity: 'minor', message: 'rename this' }
  const info: Finding = { file: 'a.ts', severity: 'info', message: 'nit' }
  const praised: Finding = { file: 'a.ts', severity: 'critical', kind: 'praise', message: 'nice' }
  const why: Finding = { file: 'a.ts', severity: 'major', kind: 'why', message: 'context' }

  test('critical and major block, whatever the model concluded', () => {
    for (const verdict of ['approve', 'comment', 'request_changes'] as Verdict[]) {
      expect(hasBlockingFindings(fakeReview(verdict, [critical]))).toBe(true)
      expect(hasBlockingFindings(fakeReview(verdict, [major]))).toBe(true)
    }
  })

  test('minor, info, praise and why do not', () => {
    expect(hasBlockingFindings(fakeReview('approve', []))).toBe(false)
    expect(hasBlockingFindings(fakeReview('approve', [minor, info]))).toBe(false)
    // Severity alone is not the bar: a praise or a "why" note never asks for a
    // change, so it never blocks however loudly it is graded.
    expect(hasBlockingFindings(fakeReview('approve', [praised, why]))).toBe(false)
  })

  test('the detail names the exact tally, so a human knows what is left', () => {
    const detail = blockingFindingsDetail(fakeReview('approve', [critical, major, major, info]))
    expect(detail).toContain('1 critical')
    expect(detail).toContain('2 major')
    expect(detail).toContain("verdict was 'approve'")
  })

  test('actionableFindingIds is the set the fix prompt is asked for', () => {
    const review = fakeReview('comment', [praised, major, info, minor])
    expect(actionableFindingIds(review)).toEqual([1, 3])
  })
})

describe('createTaskReviewer: an approve never releases a blocking finding (T3.3)', () => {
  async function runVerdict(
    verdict: Verdict,
    findings: Finding[],
  ): Promise<{ record: TaskRecord; rig: IoRig; repo: string }> {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'guarded task')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({
      ok: true,
      record: fakeReview(verdict, findings),
      reportLines: [],
    })
    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)
    return { record, rig, repo }
  }

  test('approve + an unresolved MAJOR finding: the task stays blocked', async () => {
    // `groundReview` escalates approve+critical, never approve+major: this is
    // the gap the CLI-side guard-rail closes.
    // D24: kind 'design' is exempt from the repro rule, so this finding is
    // never touched by verifyFindingRepros — this test is about T3.3's
    // guard-rail, not about D24's demotion (covered on its own elsewhere).
    const { record, rig } = await runVerdict('approve', [
      { file: 'feature.txt', severity: 'major', kind: 'design', message: 'leaks a descriptor' },
    ])
    expect(record.status).toBe('review_ko')
    expect(record.reason?.code).toBe('review_blocked')
    expect(record.reason?.detail).toContain('1 major')
    // Said out loud, beside the review_done line that still quotes the model's
    // own 'approve': without it the journal would show an approval next to a
    // blocked task and nothing bridging the two.
    const said = rig.events.find((event) => event.data.name === 'review_verdict_overridden')
    expect(said?.type).toBe('message')
    expect(said?.reason_code).toBe('review_blocked')
    expect(String(said?.data.text)).toContain('1 major')
    // The model's own verdict is still reported untouched.
    expect(rig.events.find((event) => event.type === 'review_done')?.data.verdict).toBe('approve')
  })

  test('approve + a CRITICAL the grounding could not escalate: still blocked', async () => {
    // An empty/unindexable diff makes groundReview a no-op, so the escalation
    // it normally performs never runs — and the record still must not ship.
    const { record } = await runVerdict('approve', [
      { file: 'feature.txt', severity: 'critical', message: 'auth bypass' },
    ])
    expect(record.status).toBe('review_ko')
    expect(record.reason?.detail).toContain('1 critical')
  })

  test('non-regression: an approve with only info/praise findings still releases', async () => {
    const { record, rig } = await runVerdict('approve', [
      { file: 'feature.txt', severity: 'info', message: 'nit' },
      { file: 'feature.txt', severity: 'critical', kind: 'praise', message: 'nice' },
    ])
    expect(record.status).toBe('review_ok')
    expect(record.reason).toBeUndefined()
    expect(rig.events.some((event) => event.data.name === 'review_verdict_overridden')).toBe(false)
  })

  test('a plain approve with no finding at all is untouched', async () => {
    const { record } = await runVerdict('approve', [])
    expect(record.status).toBe('review_ok')
  })
})

describe('createTaskReviewer: D24 repro verification and inter-turn memory', () => {
  test('a major finding with no repro is demoted before the guard-rail reads it: the verdict is released', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'unproven major')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    // Behavior-asserting (kind undefined, severity major), no `repro`: before
    // D24 this alone forced review_ko through hasBlockingFindings (T3.3),
    // exactly the fixture the T3.3 describe block above uses with `kind:
    // 'design'` to stay OUT of this rule.
    const unproven: Finding = { file: 'feature.txt', severity: 'major', message: 'looks risky' }
    const flow = fakeSimpleFlow({
      ok: true,
      record: fakeReview('approve', [unproven]),
      reportLines: [],
    })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(record.status).toBe('review_ok')
    expect(record.reason).toBeUndefined()
    const done = rig.events.find((e) => e.type === 'review_done')
    expect(done?.data).toMatchObject({ repro_demoted: 1, severity_minor: 1 })
    expect(done?.data.severity_major).toBeUndefined()
    // T3.3's own guard-rail message never fires: nothing blocking survived.
    expect(rig.events.some((e) => e.data.name === 'review_verdict_overridden')).toBe(false)
  })

  test('a second turn on the SAME head (nothing committed since the last review) gets the repeat prompt', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'repeat turn')
    commitChange(record.worktree, 'feature.txt')
    const rig1 = fakeIo(record)
    // The real flow builds its record's meta from the prep input (record.ts's
    // buildRecord): mirrored here, since it is what findPreviousReview later
    // matches on (same pattern as the baseline-anchoring incremental test).
    const flow1 = fakeSimpleFlow((options) => ({
      ok: true,
      record: {
        ...fakeReview('request_changes', [
          { file: 'feature.txt', severity: 'major', kind: 'design', message: 'first pass' },
        ]),
        meta: {
          ...fakeReview('approve').meta,
          branch: options.input.branch,
          target: options.input.target,
          head_sha: options.input.head_sha,
        },
      },
      reportLines: [],
    }))

    await reviewer(repo, { runSimpleFlowFn: flow1.fn })(record, rig1.io)
    expect(record.status).toBe('review_ko')

    // Turn 2: NO new commit — the worktree HEAD is exactly what turn 1 just
    // archived. `record.status` is left as turn 1 settled it: the hook is
    // called directly here (bypassing the runner), and never reads the
    // incoming status itself — only the runner uses it as a precondition.
    const rig2 = fakeIo(record)
    const flow2 = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow2.fn })(record, rig2.io)

    expect(flow2.calls).toHaveLength(1)
    expect(flow2.calls[0]?.incremental).toBe(true)
    expect(flow2.calls[0]?.prompt).toContain('EXACT SAME commit')
    expect(flow2.calls[0]?.prompt).toContain('Previous review verdict: request_changes')
    expect(flow2.calls[0]?.prompt).toContain('<previous_review>')
    expect(record.status).toBe('review_ok')
  })

  test('dual mode never receives a repeat/incremental prompt, even with a previous review at the same head', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'dual unaffected')
    commitChange(record.worktree, 'feature.txt')
    const rig1 = fakeIo(record)
    const simpleFlow1 = fakeSimpleFlow((options) => ({
      ok: true,
      record: {
        ...fakeReview('approve'),
        meta: {
          ...fakeReview('approve').meta,
          branch: options.input.branch,
          target: options.input.target,
          head_sha: options.input.head_sha,
        },
      },
      reportLines: [],
    }))
    // Turn 1 in SIMPLE mode plants a previous archive at the current head.
    await reviewer(repo, { runSimpleFlowFn: simpleFlow1.fn })(record, rig1.io)
    expect(record.status).toBe('review_ok')

    // Turn 2 in DUAL mode, same head, no new commit: task-review.ts's D24
    // wiring only ever computes a prebuiltPrompt for SIMPLE mode (the
    // `mode === 'simple'` guard), so runSimpleFlow must never even be called.
    const rig2 = fakeIo(record)
    const simpleFlow2 = fakeSimpleFlow({
      ok: false,
      failure: 'run',
      message: 'must not be called in dual mode',
    })
    const dual = fakeDualFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, {
      mode: 'dual',
      runSimpleFlowFn: simpleFlow2.fn,
      runDualFlowFn: dual.fn,
    })(record, rig2.io)

    expect(simpleFlow2.calls).toHaveLength(0)
    expect(dual.calls).toHaveLength(1)
    expect(record.status).toBe('review_ok')
  })
})

describe('buildAutoFixTurnPrompt (T3.3)', () => {
  test('asks for every actionable finding, and never for the notes', () => {
    const repo = makeRepo()
    const saved = archiveRecord(
      fakeReview('request_changes', [
        { file: 'a.ts', severity: 'info', message: 'a nit nobody must chase' },
        { file: 'a.ts', line: 3, severity: 'major', message: 'off by one' },
      ]),
      repo,
    )
    const prompt = buildAutoFixTurnPrompt(
      { review_ref: saved, turns: [] } as unknown as TaskRecord,
      null,
    )
    expect(prompt).toContain('off by one')
    expect(prompt).not.toContain('a nit nobody must chase')
    // It IS the manual path's prompt: same builder, same rules.
    expect(prompt).toContain('applying code review fixes')
    // The agent is told not to commit — the runner commits at the end of turn.
    expect(prompt).toContain('Do NOT commit')
  })

  test('a review that approved the code still gets a prompt when criteria block', () => {
    const repo = makeRepo()
    const saved = archiveRecord(
      {
        ...fakeReview('approve', []),
        review: {
          ...fakeReview('approve', []).review,
          criteria: [
            { criterion_id: GC1.id, status: 'met' as const, evidence: ANCHOR },
            { criterion_id: GC2.id, status: 'unmet' as const },
            { criterion_id: GC3.id, status: 'unclear' as const },
          ],
        },
      },
      repo,
    )
    const prompt = buildAutoFixTurnPrompt(
      {
        review_ref: saved,
        criteria: [GC1, GC2, GC3],
        turns: [],
      } as unknown as TaskRecord,
      null,
    )
    expect(prompt).toContain(GC2.id)
    expect(prompt).toContain('WHEN checks fail')
    expect(prompt).toContain(GC3.id)
    // The satisfied one is not re-asked for.
    expect(prompt).not.toContain(GC1.id)
  })

  test('null when there is nothing concrete to ask for: no findings, no criteria, no blocking checks', () => {
    const repo = makeRepo()
    // An archive with no actionable finding and no criteria: a round spent on
    // this would name no work at all.
    const empty = archiveRecord(
      fakeReview('comment', [{ file: 'a.ts', severity: 'info', message: 'nit' }]),
      repo,
    )
    expect(
      buildAutoFixTurnPrompt({ review_ref: empty, turns: [] } as unknown as TaskRecord, null),
    ).toBe(null)
    expect(
      buildAutoFixTurnPrompt({ review_ref: null, turns: [] } as unknown as TaskRecord, null),
    ).toBe(null)
    expect(
      buildAutoFixTurnPrompt(
        { review_ref: join(repo, 'gone.json'), turns: [] } as unknown as TaskRecord,
        null,
      ),
    ).toBe(null)
    // A GREEN checks run blocks nothing either: still null.
    expect(
      buildAutoFixTurnPrompt(
        { review_ref: empty, turns: [] } as unknown as TaskRecord,
        checksOf({ status: 'passed' }),
      ),
    ).toBe(null)
  })

  test('a RED checks run earns its own chapter, even with nothing else to ask for', () => {
    const repo = makeRepo()
    const empty = archiveRecord(
      fakeReview('comment', [{ file: 'a.ts', severity: 'info', message: 'nit' }]),
      repo,
    )
    const failing = checksOf({
      status: 'failed',
      checks: [
        {
          command: 'bun test',
          status: 'failed',
          exit_code: 1,
          duration_ms: 5,
          tail: 'FAIL a.test.ts',
        },
      ],
    })
    const prompt = buildAutoFixTurnPrompt(
      { review_ref: empty, turns: [] } as unknown as TaskRecord,
      failing,
    )
    expect(prompt).toContain('What must still pass')
    expect(prompt).toContain('bun test')
    expect(prompt).toContain('FAIL a.test.ts')
  })

  test('non-regression: the MANUAL path still honours the human’s own selection', () => {
    const repo = makeRepo()
    const saved = archiveRecord(
      fakeReview('request_changes', [
        { file: 'a.ts', severity: 'major', message: 'first one' },
        { file: 'b.ts', severity: 'major', message: 'second one' },
      ]),
      repo,
    )
    const task = { review_ref: saved, turns: [] } as unknown as TaskRecord
    const manual = buildFixTurnPrompt(task, [1])
    expect(manual).toContain('second one')
    expect(manual).not.toContain('first one')
    // ...while the automatic one takes both, because both block.
    const auto = buildAutoFixTurnPrompt(task, null)
    expect(auto).toContain('first one')
    expect(auto).toContain('second one')
  })
})

describe('hubSettleTransition', () => {
  test('review_ok with no reviewOutcome (the empty-diff short-circuit): an approve, no findings_total', () => {
    const transition = hubSettleTransition({ status: 'review_ok' })
    expect(transition).toEqual({ type: 'review_result', verdict: 'approve' })
  })

  test('review_ok with a reviewOutcome: an approve, carrying findings_total', () => {
    const transition = hubSettleTransition({
      status: 'review_ok',
      reviewOutcome: fakeReview('approve', [{ file: 'a.ts', severity: 'minor', message: 'nit' }]),
    })
    expect(transition).toEqual({ type: 'review_result', verdict: 'approve', findings_total: 1 })
  })

  test('review_ko with a reviewOutcome (a verdict was produced, possibly overridden): request_changes', () => {
    const transition = hubSettleTransition({
      status: 'review_ko',
      reviewOutcome: fakeReview('request_changes', [
        { file: 'a.ts', severity: 'major', message: 'bug' },
      ]),
    })
    expect(transition).toEqual({
      type: 'review_result',
      verdict: 'request_changes',
      findings_total: 1,
    })
  })

  test('review_ko with NO reviewOutcome (a flow failure, or an exception): failed, not review_result', () => {
    // No reviewer ever produced a verdict here: reporting review_result would
    // be indistinguishable from a reviewer that looked at the work and
    // rejected it.
    const transition = hubSettleTransition({ status: 'review_ko' })
    expect(transition).toEqual({ type: 'failed' })
  })

  test('review_ko with no reviewOutcome and a reason: failed, carrying the reason as error_message', () => {
    const reason: TaskReason = { code: 'review_blocked', detail: 'review failed: agent crashed' }
    const transition = hubSettleTransition({ status: 'review_ko', reason })
    expect(transition).toEqual({
      type: 'failed',
      error_message: 'review failed: agent crashed',
    })
  })

  test('a reason with no detail adds no error_message', () => {
    const reason: TaskReason = { code: 'review_blocked' }
    const transition = hubSettleTransition({ status: 'review_ko', reason })
    expect(transition).toEqual({ type: 'failed' })
  })

  test('costTicks rides along on a review_result, omitted entirely when absent', () => {
    const withCost = hubSettleTransition({ status: 'review_ok', costTicks: 42 })
    expect(withCost).toEqual({ type: 'review_result', verdict: 'approve', cost_ticks: 42 })
    const withoutCost = hubSettleTransition({ status: 'review_ok' })
    expect('cost_ticks' in withoutCost).toBe(false)
  })
})

// --- buildRunbookVerificationChapter (lot C8) ------------------------------

describe('buildRunbookVerificationChapter', () => {
  test('null when neither runbook nor verification is supplied', () => {
    expect(buildRunbookVerificationChapter(null, null)).toBeNull()
    expect(buildRunbookVerificationChapter(undefined, undefined)).toBeNull()
  })

  test('runbook alone: image and tests, no verification section', () => {
    const chapter = buildRunbookVerificationChapter(runbookOf(), null)
    expect(chapter).toContain('Runbook and mechanical verification, MANDATORY chapter:')
    expect(chapter).toContain('runbook image: node:26')
    expect(chapter).toContain('runbook tests: bun test')
    expect(chapter).not.toContain('last verification')
  })

  test('verification alone: status, per-check summary, integrity, changed files', () => {
    const chapter = buildRunbookVerificationChapter(
      null,
      verificationOf({
        status: 'failed',
        checks: [
          { command: 'bun test', status: 'failed', exit_code: 1, duration_ms: 5, tail: 'boom' },
        ],
        integrity_ok: false,
        changed_dependency_files: ['package.json', 'bun.lock'],
      }),
    )
    expect(chapter).toContain('last verification: failed')
    expect(chapter).toContain('bun test: failed')
    expect(chapter).toContain('boom')
    expect(chapter).toContain('runbook integrity: DRIFTED')
    expect(chapter).toContain('changed dependency files since validation: package.json, bun.lock')
  })

  test('a passed check carries no tail; a failed one does', () => {
    const chapter = buildRunbookVerificationChapter(
      null,
      verificationOf({
        checks: [
          {
            command: 'bun test',
            status: 'passed',
            exit_code: 0,
            duration_ms: 5,
            tail: 'should not appear',
          },
          {
            command: 'bun lint',
            status: 'failed',
            exit_code: 1,
            duration_ms: 5,
            tail: 'lint broke',
          },
        ],
      }),
    )
    expect(chapter).not.toContain('should not appear')
    expect(chapter).toContain('lint broke')
  })

  test('intact integrity and no changed files: no "changed dependency files" line', () => {
    const chapter = buildRunbookVerificationChapter(null, verificationOf())
    expect(chapter).toContain('runbook integrity: intact')
    expect(chapter).not.toContain('changed dependency files')
  })

  test('a verification error is said', () => {
    const chapter = buildRunbookVerificationChapter(
      null,
      verificationOf({ status: 'error', checks: [], error: 'VM boot failed' }),
    )
    expect(chapter).toContain('verification error: VM boot failed')
  })

  test('both present: both sections appear', () => {
    const chapter = buildRunbookVerificationChapter(runbookOf(), verificationOf()) ?? ''
    expect(chapter).toContain('runbook image')
    expect(chapter).toContain('last verification')
  })
})

// --- runMicrovmReview (lot C8) ---------------------------------------------

describe('runMicrovmReview', () => {
  test('names the sandbox codesema-review-<taskId>, boots the given image, opens only the reviewer allowlist', async () => {
    const repo = makeRepo()
    const fake = fakeMicrovmDriver()

    const stdout = await runMicrovmReview({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
      driver: fake.driver,
      worktree: repo,
      projectId: 'proj-1',
      snapshotName: null,
      image: 'node:26',
      command: 'claude -p',
      prompt: 'REVIEW THIS',
      timeoutMs: 5000,
      taskId: 'task-abc',
    })

    expect(stdout).toBe('{"verdict":"approve","summary":"ok","findings":[]}')
    expect(fake.specs).toHaveLength(1)
    expect(fake.specs[0]?.name).toMatch(/^codesema-review-task-abc-[0-9a-f]{8}$/)
    expect(fake.specs[0]?.image).toBe('node:26')
    expect(fake.specs[0]?.fromSnapshot).toBeUndefined()
    // Cold boot (no snapshot): the reviewer install domain joins the default
    // allowlist so `ensureAgentInstalled` can npm-install a missing agent.
    expect(fake.specs[0]?.network).toEqual({
      allowedDomains: [...DEFAULT_ISOLATION_ALLOWED_DOMAINS, ...AGENT_INSTALL_DOMAINS],
    })
  })

  test('never sets a boot workdir on the sandbox spec: the SDK refuses one that does not already exist in the image', async () => {
    const repo = makeRepo()
    const fake = fakeMicrovmDriver()

    await runMicrovmReview({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
      driver: fake.driver,
      worktree: repo,
      projectId: 'proj-1',
      snapshotName: null,
      image: 'node:26',
      command: 'claude -p',
      prompt: 'p',
      timeoutMs: 5000,
      taskId: 'task-abc',
    })

    expect(fake.specs[0]?.workdir).toBeUndefined()
  })

  test('a snapshot name restores from the snapshot instead of booting the image cold', async () => {
    const repo = makeRepo()
    const fake = fakeMicrovmDriver()

    await runMicrovmReview({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
      driver: fake.driver,
      worktree: repo,
      projectId: 'proj-1',
      snapshotName: 'codesema-project-proj-1',
      image: 'node:26',
      command: 'claude -p',
      prompt: 'p',
      timeoutMs: 5000,
      taskId: 'task-abc',
    })

    expect(fake.specs[0]?.fromSnapshot).toBe('codesema-project-proj-1')
    expect(fake.specs[0]?.image).toBeUndefined()
  })

  test('a snapshot restore does not open the agent install domain', async () => {
    const repo = makeRepo()
    const fake = fakeMicrovmDriver()

    await runMicrovmReview({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
      driver: fake.driver,
      worktree: repo,
      projectId: 'proj-1',
      snapshotName: 'codesema-project-proj-1',
      image: 'node:26',
      command: 'claude -p',
      prompt: 'p',
      timeoutMs: 5000,
      taskId: 'task-abc',
    })

    expect(fake.specs[0]?.network).toEqual({ allowedDomains: DEFAULT_ISOLATION_ALLOWED_DOMAINS })
  })

  test('a custom allowedDomains list wins over the default', async () => {
    const repo = makeRepo()
    const fake = fakeMicrovmDriver()

    await runMicrovmReview({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
      driver: fake.driver,
      worktree: repo,
      projectId: 'proj-1',
      snapshotName: null,
      image: 'node:26',
      command: 'claude -p',
      prompt: 'p',
      timeoutMs: 5000,
      allowedDomains: ['forge.example.com'],
    })

    expect(fake.specs[0]?.network).toEqual({
      allowedDomains: ['forge.example.com', ...AGENT_INSTALL_DOMAINS],
    })
  })

  test('secrets, when supplied, are declared on the sandbox spec', async () => {
    const repo = makeRepo()
    const fake = fakeMicrovmDriver()

    await runMicrovmReview({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
      driver: fake.driver,
      worktree: repo,
      projectId: 'proj-1',
      snapshotName: null,
      image: 'node:26',
      command: 'claude -p',
      prompt: 'p',
      timeoutMs: 5000,
      secrets: [
        {
          env: 'CLAUDE_CODE_OAUTH_TOKEN',
          value: 'real-token',
          allowedHosts: ['api.anthropic.com'],
        },
      ],
    })

    expect(fake.specs[0]?.secrets).toEqual([
      { env: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'real-token', allowedHosts: ['api.anthropic.com'] },
    ])
  })

  test('no taskId: a random suffix names the sandbox, distinct across calls', async () => {
    const repo = makeRepo()
    const fake1 = fakeMicrovmDriver()
    const fake2 = fakeMicrovmDriver()

    await runMicrovmReview({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
      driver: fake1.driver,
      worktree: repo,
      projectId: 'proj-1',
      snapshotName: null,
      image: 'node:26',
      command: 'claude -p',
      prompt: 'p',
      timeoutMs: 5000,
    })
    await runMicrovmReview({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
      driver: fake2.driver,
      worktree: repo,
      projectId: 'proj-1',
      snapshotName: null,
      image: 'node:26',
      command: 'claude -p',
      prompt: 'p',
      timeoutMs: 5000,
    })

    const name1 = fake1.specs[0]?.name ?? ''
    const name2 = fake2.specs[0]?.name ?? ''
    expect(name1.startsWith('codesema-review-')).toBe(true)
    expect(name2.startsWith('codesema-review-')).toBe(true)
    expect(name1).not.toBe(name2)
  })

  test('worktree copied then made read-only before the agent runs, in that order', async () => {
    const repo = makeRepo()
    const fake = fakeMicrovmDriver()

    await runMicrovmReview({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
      driver: fake.driver,
      worktree: repo,
      projectId: 'proj-1',
      snapshotName: null,
      image: 'node:26',
      command: 'claude -p',
      prompt: 'p',
      timeoutMs: 5000,
      taskId: 'task-abc',
    })

    // Bootstrap (useradd, agent-PATH probe) runs before the worktree is even
    // copied in: create, shell(useradd), shell(probe), copyFromHost,
    // shell(chmod), shell(agent), destroy.
    const methods = fake.calls.map((c) => c.method)
    expect(methods).toEqual([
      'create',
      'shell',
      'shell',
      'copyFromHost',
      'shell',
      'shell',
      'destroy',
    ])
    const copyCall = fake.calls[3]
    expect(copyCall?.args[0]).toBe(repo)
    expect(copyCall?.args[1]).toBe('/work')
    const chmodCall = fake.calls[4]
    expect(String(chmodCall?.args[0])).toBe('chmod -R a-w /work')
  })

  test('the guest command is the stream-json-injected, non-root claude invocation, with the prompt on stdin', async () => {
    const repo = makeRepo()
    const fake = fakeMicrovmDriver()

    await runMicrovmReview({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
      driver: fake.driver,
      worktree: repo,
      projectId: 'proj-1',
      snapshotName: null,
      image: 'node:26',
      command: 'claude -p',
      prompt: 'REVIEW THIS DIFF',
      timeoutMs: 5000,
      taskId: 'task-abc',
    })

    // create, shell(useradd), shell(probe), copyFromHost, shell(chmod), shell(agent)
    const agentCall = fake.calls[5]
    expect(agentCall?.method).toBe('shell')
    expect(agentCall?.args[0]).toBe(
      'claude -p --dangerously-skip-permissions --output-format stream-json --include-partial-messages --verbose',
    )
    const execOpts = agentCall?.args[1] as { user?: string; cwd?: string; input?: string }
    expect(execOpts.user).toBe('agent')
    expect(execOpts.cwd).toBe('/work')
    expect(execOpts.input).toBe('REVIEW THIS DIFF')
  })

  test('the sandbox is destroyed even when the chmod fails', async () => {
    const repo = makeRepo()
    const fake = fakeMicrovmDriver({ chmodExitCode: 1 })

    await expect(
      runMicrovmReview({
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
        driver: fake.driver,
        worktree: repo,
        projectId: 'proj-1',
        snapshotName: null,
        image: 'node:26',
        command: 'claude -p',
        prompt: 'p',
        timeoutMs: 5000,
        taskId: 'task-abc',
      }),
    ).rejects.toThrow(/read-only/)

    expect(fake.calls.map((c) => c.method)).toEqual([
      'create',
      'shell',
      'shell',
      'copyFromHost',
      'shell',
      'destroy',
    ])
  })

  test('the sandbox is destroyed even when the agent command times out', async () => {
    const repo = makeRepo()
    const fake = fakeMicrovmDriver({
      exec: { code: null, stdout: '', stderr: '', timedOut: true },
    })

    const stdout = await runMicrovmReview({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
      driver: fake.driver,
      worktree: repo,
      projectId: 'proj-1',
      snapshotName: null,
      image: 'node:26',
      command: 'claude -p',
      prompt: 'p',
      timeoutMs: 5000,
      taskId: 'task-abc',
    })

    // A timeout is not thrown here (the caller reads the timedOut flag from
    // the raw stdout contract, same as runMicrovmTurn's own doc comment) —
    // what THIS test guards is that destroy still runs.
    expect(stdout).toBe('')
    expect(fake.calls.map((c) => c.method)).toContain('destroy')
  })

  test("the same taskId used concurrently (dual mode's two lanes) still names each sandbox uniquely, each destroyed on its own name", async () => {
    const repo = makeRepo()
    const fake = fakeMicrovmDriver()

    await Promise.all([
      runMicrovmReview({
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
        driver: fake.driver,
        worktree: repo,
        projectId: 'proj-1',
        snapshotName: null,
        image: 'node:26',
        command: 'claude -p',
        prompt: 'lane a prompt',
        timeoutMs: 5000,
        taskId: 'task-shared',
      }),
      runMicrovmReview({
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
        driver: fake.driver,
        worktree: repo,
        projectId: 'proj-1',
        snapshotName: null,
        image: 'node:26',
        command: 'claude -p',
        prompt: 'lane b prompt',
        timeoutMs: 5000,
        taskId: 'task-shared',
      }),
    ])

    const names = fake.specs.map((s) => s.name)
    expect(names).toHaveLength(2)
    expect(new Set(names).size).toBe(2)
    for (const name of names) {
      expect(name.startsWith('codesema-review-task-shared-')).toBe(true)
    }
    const destroyNames = fake.calls.filter((c) => c.method === 'destroy').map((c) => c.args[0])
    expect(destroyNames.toSorted()).toEqual(names.toSorted())
  })

  test('maxDurationSeconds carries the same headroom buffer as microvmStepExecutor, for copyFromHost + chmod ahead of the timed command', async () => {
    const repo = makeRepo()
    const fake = fakeMicrovmDriver()

    await runMicrovmReview({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
      driver: fake.driver,
      worktree: repo,
      projectId: 'proj-1',
      snapshotName: null,
      image: 'node:26',
      command: 'claude -p',
      prompt: 'p',
      timeoutMs: 5000,
      taskId: 'task-abc',
    })

    expect(fake.specs[0]?.maxDurationSeconds).toBe(Math.ceil(5000 / 1000) + 60)
  })

  test('a destroy failure after a successful run does not mask the review result', async () => {
    const repo = makeRepo()
    const fake = fakeMicrovmDriver({ destroyError: new Error('sandbox already gone') })

    const stdout = await runMicrovmReview({
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
      driver: fake.driver,
      worktree: repo,
      projectId: 'proj-1',
      snapshotName: null,
      image: 'node:26',
      command: 'claude -p',
      prompt: 'p',
      timeoutMs: 5000,
      taskId: 'task-abc',
    })

    expect(stdout).toBe('{"verdict":"approve","summary":"ok","findings":[]}')
  })

  test('a destroy failure after a chmod failure does not replace the read-only error', async () => {
    const repo = makeRepo()
    const fake = fakeMicrovmDriver({
      chmodExitCode: 1,
      destroyError: new Error('sandbox already gone'),
    })

    await expect(
      runMicrovmReview({
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
        driver: fake.driver,
        worktree: repo,
        projectId: 'proj-1',
        snapshotName: null,
        image: 'node:26',
        command: 'claude -p',
        prompt: 'p',
        timeoutMs: 5000,
        taskId: 'task-abc',
      }),
    ).rejects.toThrow(/read-only/)
  })

  describe('agent bootstrap', () => {
    test('a cold boot npm-installs the agent derived from the command when the guest PATH probe finds it missing', async () => {
      const repo = makeRepo()
      const fake = fakeMicrovmDriver({ probeMissingFor: 'opencode' })

      await runMicrovmReview({
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
        driver: fake.driver,
        worktree: repo,
        projectId: 'proj-1',
        snapshotName: null,
        image: 'node:26',
        command: 'opencode run --model x',
        prompt: 'p',
        timeoutMs: 5000,
        taskId: 'task-abc',
      })

      const install = fake.calls.find(
        (c) => c.method === 'shell' && String(c.args[0]).includes('npm install -g'),
      )
      expect(String(install?.args[0])).toContain('opencode-ai')
      expect((install?.args[1] as { user?: string } | undefined)?.user).toBe('root')
    })

    test('a snapshot boot never installs, and rejects with a readable error when the agent is missing', async () => {
      const repo = makeRepo()
      const fake = fakeMicrovmDriver({ probeMissingFor: 'claude' })

      await expect(
        runMicrovmReview({
          env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
          driver: fake.driver,
          worktree: repo,
          projectId: 'proj-1',
          snapshotName: 'codesema-project-proj-1',
          image: 'node:26',
          command: 'claude -p',
          prompt: 'p',
          timeoutMs: 5000,
          taskId: 'task-abc',
        }),
      ).rejects.toThrow(/not installed in this microVM/)

      expect(fake.calls.some((c) => String(c.args[0]).includes('npm install -g'))).toBe(false)
    })
  })

  describe('agent credentials', () => {
    function makeCredentialsFile(content = '{"token":"secret-token-value"}'): string {
      const dir = mkdtempSync(join(tmpdir(), 'codesema-review-creds-'))
      cleanups.push(dir)
      writeFileSync(join(dir, 'credentials.json'), content)
      return join(dir, 'credentials.json')
    }

    test('no oauth token, credentials file present: written into the review VM, chmod 600, chowned, never in a shell command', async () => {
      const repo = makeRepo()
      const fake = fakeMicrovmDriver()
      const credentialsPath = makeCredentialsFile('{"token":"secret-token-value"}')

      await runMicrovmReview({
        env: {},
        credentialsPath,
        driver: fake.driver,
        worktree: repo,
        projectId: 'proj-1',
        snapshotName: null,
        image: 'node:26',
        command: 'claude -p',
        prompt: 'p',
        timeoutMs: 5000,
        taskId: 'task-abc',
      })

      const write = fake.calls.find((c) => c.method === 'writeFile')
      expect(write?.args).toEqual([
        '/home/agent/.claude/.credentials.json',
        '{"token":"secret-token-value"}',
      ])
      const chmodChown = fake.calls.find(
        (c) => c.method === 'shell' && String(c.args[0]).includes('chmod 600'),
      )
      expect(chmodChown?.args[0]).toBe(
        'chmod 600 /home/agent/.claude/.credentials.json && chown -R agent:agent /home/agent/.claude',
      )
      expect((chmodChown?.args[1] as { user?: string } | undefined)?.user).toBe('root')
      for (const call of fake.calls) {
        if (call.method === 'shell') {
          expect(String(call.args[0])).not.toContain('secret-token-value')
        }
      }
    })

    test('CLAUDE_CODE_OAUTH_TOKEN present: nothing is copied into the review VM', async () => {
      const repo = makeRepo()
      const fake = fakeMicrovmDriver()
      const credentialsPath = makeCredentialsFile()

      await runMicrovmReview({
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
        credentialsPath,
        driver: fake.driver,
        worktree: repo,
        projectId: 'proj-1',
        snapshotName: null,
        image: 'node:26',
        command: 'claude -p',
        prompt: 'p',
        timeoutMs: 5000,
        taskId: 'task-abc',
      })

      expect(fake.calls.some((c) => c.method === 'writeFile')).toBe(false)
    })

    test('no credentials file on the host: no write, no error', async () => {
      const missingDir = mkdtempSync(join(tmpdir(), 'codesema-review-creds-'))
      cleanups.push(missingDir)
      const missingPath = join(missingDir, 'nope.json')
      const repo = makeRepo()
      const fake = fakeMicrovmDriver()

      const stdout = await runMicrovmReview({
        env: {},
        credentialsPath: missingPath,
        driver: fake.driver,
        worktree: repo,
        projectId: 'proj-1',
        snapshotName: null,
        image: 'node:26',
        command: 'claude -p',
        prompt: 'p',
        timeoutMs: 5000,
        taskId: 'task-abc',
      })

      expect(stdout).toBe('{"verdict":"approve","summary":"ok","findings":[]}')
      expect(fake.calls.some((c) => c.method === 'writeFile')).toBe(false)
    })
  })
})

// --- createTaskReviewer: microvm wiring (lot C8) ---------------------------

describe('createTaskReviewer: microvm wiring', () => {
  test('no driver: the flow receives no runAgentInVm, host path unchanged', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'host review')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    expect(flow.calls).toHaveLength(1)
    expect(flow.calls[0]?.runAgentInVm).toBeUndefined()
    expect(record.status).toBe('review_ok')
  })

  test('driver set: the flow receives a runAgentInVm wired to runMicrovmReview', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'vm review')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const fake = fakeMicrovmDriver()
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, {
      runSimpleFlowFn: flow.fn,
      driver: fake.driver,
      projectId: 'proj-1',
      resolveReviewContext: () =>
        Promise.resolve({ snapshotName: null, runbook: null, verification: null }),
    })(record, rig.io)

    expect(flow.calls).toHaveLength(1)
    const runAgentInVm = flow.calls[0]?.runAgentInVm
    expect(typeof runAgentInVm).toBe('function')

    // Calling it drives the fake driver exactly as `runMicrovmReview` alone
    // does — the wiring built by `createTaskReviewer`, exercised end to end.
    // This call site (task-review.ts's own runAgentInVm closure) has no env
    // seam, so it falls through to the real process.env: pinned here so
    // ensureAgentCredentials never touches this machine's real credentials.
    const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-secret'
    let raw: string | undefined
    try {
      raw = await runAgentInVm?.('hand-built prompt')
    } finally {
      if (previousToken === undefined) {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      } else {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken
      }
    }
    expect(raw).toBe('{"verdict":"approve","summary":"ok","findings":[]}')
    expect(fake.specs[0]?.name).toMatch(new RegExp(`^codesema-review-${record.id}-[0-9a-f]{8}$`))
    expect(fake.calls.map((c) => c.method)).toEqual([
      'create',
      'shell',
      'shell',
      'copyFromHost',
      'shell',
      'shell',
      'destroy',
    ])
  })

  test('dual mode: both lanes calling the SAME runAgentInVm closure concurrently get distinct sandboxes, each destroying only its own', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'vm review dual')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const fake = fakeMicrovmDriver()
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, {
      runSimpleFlowFn: flow.fn,
      driver: fake.driver,
      projectId: 'proj-1',
      resolveReviewContext: () =>
        Promise.resolve({ snapshotName: null, runbook: null, verification: null }),
    })(record, rig.io)

    const runAgentInVm = flow.calls[0]?.runAgentInVm
    // Both `laneRun('a', ...)` and `laneRun('b', ...)` in `runDualFlow` invoke
    // this SAME closure: the race F12 was about.
    await Promise.all([runAgentInVm?.('lane a prompt'), runAgentInVm?.('lane b prompt')])

    const names = fake.specs.map((s) => s.name)
    expect(names).toHaveLength(2)
    expect(new Set(names).size).toBe(2)
    for (const name of names) {
      expect(name).toMatch(new RegExp(`^codesema-review-${record.id}-[0-9a-f]{8}$`))
    }
    const destroyNames = fake.calls.filter((c) => c.method === 'destroy').map((c) => c.args[0])
    expect(destroyNames.toSorted()).toEqual(names.toSorted())
  })

  test('driver set but no runbook: the image falls back to DEFAULT_BASE_IMAGE', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'vm review no runbook')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const fake = fakeMicrovmDriver()
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn, driver: fake.driver })(record, rig.io)

    await flow.calls[0]?.runAgentInVm?.('p')
    expect(fake.specs[0]?.image).toBe('node:26')
  })

  test('driver set with a runbook: the review VM boots the runbook image', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'vm review with runbook')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const fake = fakeMicrovmDriver()
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, {
      runSimpleFlowFn: flow.fn,
      driver: fake.driver,
      resolveReviewContext: () =>
        Promise.resolve({
          snapshotName: null,
          runbook: runbookOf({ image: 'custom/runbook-image:1' }),
          verification: null,
        }),
    })(record, rig.io)

    await flow.calls[0]?.runAgentInVm?.('p')
    expect(fake.specs[0]?.image).toBe('custom/runbook-image:1')
  })

  test('runbook and verification, when supplied, reach the reviewer prompt as a mandatory chapter', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'runbook chapter')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, {
      runSimpleFlowFn: flow.fn,
      resolveReviewContext: () =>
        Promise.resolve({
          snapshotName: null,
          runbook: runbookOf(),
          verification: verificationOf({ status: 'passed' }),
        }),
    })(record, rig.io)

    const prompt = flow.calls[0]?.prompt ?? ''
    expect(prompt).toContain('Runbook and mechanical verification')
    expect(prompt).toContain('node:26')
    expect(prompt).toContain('bun test')
    expect(prompt).toContain('last verification: passed')
  })

  test('neither runbook nor verification: no chapter added, prompt unchanged from before this ticket', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'no runbook chapter')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })

    await reviewer(repo, { runSimpleFlowFn: flow.fn })(record, rig.io)

    const prompt = flow.calls[0]?.prompt ?? ''
    expect(prompt).not.toContain('Runbook and mechanical verification')
  })

  // This ticket: the three used to be frozen once at reviewer-construction
  // time (once per PROJECT); now a resolver is called once per REVIEW, with
  // the exact record being reviewed, and its answer is what actually drives
  // both the prompt chapter and the VM the agent runs in.
  test('resolveReviewContext is called ONCE, with the reviewed record, and its snapshot feeds fromSnapshot', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'per-task snapshot')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const fake = fakeMicrovmDriver()
    const flow = fakeSimpleFlow({ ok: true, record: fakeReview('approve'), reportLines: [] })
    const calls: TaskRecord[] = []

    await reviewer(repo, {
      runSimpleFlowFn: flow.fn,
      driver: fake.driver,
      resolveReviewContext: (r) => {
        calls.push(r)
        return Promise.resolve({
          snapshotName: 'codesema-warm-snapshot',
          runbook: runbookOf({ image: 'should-never-be-used:1' }),
          verification: verificationOf({ status: 'passed' }),
        })
      },
    })(record, rig.io)

    expect(calls).toEqual([record])
    expect(flow.calls[0]?.prompt).toContain('last verification: passed')
    await flow.calls[0]?.runAgentInVm?.('p')
    expect(fake.specs[0]?.fromSnapshot).toBe('codesema-warm-snapshot')
    expect(fake.specs[0]?.image).toBeUndefined()
  })

  test('driver set: a major finding with a repro is verified through the SAME microvm driver, never docker', async () => {
    const repo = makeRepo()
    const record = await makeTaskWithWorktree(repo, 'vm repro')
    commitChange(record.worktree, 'feature.txt')
    const rig = fakeIo(record)
    const fake = fakeMicrovmDriver()
    const finding: Finding = {
      file: 'feature.txt',
      severity: 'major',
      message: 'bug',
      repro: { command: 'exit 1', expected: 'the bug fires' },
    }
    const flow = fakeSimpleFlow({
      ok: true,
      record: fakeReview('request_changes', [finding]),
      reportLines: [],
    })

    await reviewer(repo, {
      runSimpleFlowFn: flow.fn,
      driver: fake.driver,
      projectId: 'proj-1',
    })(record, rig.io)

    // The fake simple flow never calls the review agent's own runAgentInVm
    // (other tests in this file exercise that wiring separately), so the
    // ONLY sandbox this review creates is the finding's repro ad hoc check —
    // through the SAME fake driver, its command run verbatim, never a
    // docker/podman fallback.
    expect(fake.calls.filter((c) => c.method === 'create')).toHaveLength(1)
    expect(fake.calls.filter((c) => c.method === 'destroy')).toHaveLength(1)
    const shellCall = fake.calls.find((c) => c.method === 'shell')
    expect(String(shellCall?.args[0])).toContain('exit 1')
  })
})
