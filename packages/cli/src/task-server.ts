// Task manager: the one object the HTTP server drives for the agentic
// workspace. Multi-project: it aggregates one tasks store + one task runner
// per REGISTERED project (global registry, projects.ts), instantiated lazily
// at first access, all sharing ONE global concurrency budget (a TaskSlotPool:
// maxParallel counts running tasks across every repo). Each repo keeps its
// own .codesema/ as the source of truth for its tasks; the manager only
// routes by project id. Everything that happens is multiplexed into a single
// pub/sub bus of {project_id, task_id, event} envelopes — the shape the
// global SSE stream (/api/tasks/events) forwards verbatim, so N conversations
// across N projects ride one EventSource.

import { existsSync } from 'node:fs'
import type { AgentRunOptions } from './agent.js'
import {
  createChecksSetupRunner,
  type ChecksSetupRunner,
  type ChecksSetupState,
} from './checks-setup.js'
import type { IsolationMode } from './config.js'
import {
  isActiveTaskStatus,
  TASK_BASE_MAX,
  TASK_TITLE_MAX,
  TASK_TURN_TEXT_MAX,
  type ReasonCode,
  type ReviewRecord,
  type TaskChecks,
  type TaskEvent,
  type TaskIsolation,
  type TaskRecord,
} from './contract.js'
import { tryGit } from './git.js'
import { t } from './i18n.js'
import { listProjects, type Project } from './projects.js'
import { readChecksConfig } from './repo-config.js'
import { runChecks } from './task-checks.js'
import {
  isolationDefaults,
  resolveTaskIsolation,
  UNPROBED_ISOLATION,
  type IsolationProbe,
} from './task-isolation.js'
import { createTaskReviewer, readTaskReview } from './task-review.js'
import {
  createTaskRunner,
  createTaskSlotPool,
  DEFAULT_MAX_PARALLEL_TASKS,
  type TaskActionResult,
  type TaskRunner,
  type TaskRunnerOptions,
  type TaskTurnReviewFn,
} from './task-runner.js'
import { shipTask, type ShipOutcome } from './task-ship.js'
import {
  branchCheckoutPath,
  detectTaskBase,
  resolveBranchRef,
  shortBranchName,
} from './task-worktree.js'
import {
  appendTaskEvent,
  createTask,
  listTasks,
  loadTask,
  readTaskChecks,
  readTaskEvents,
  saveTask,
  taskReason,
  writeTaskChecks,
} from './tasks-store.js'

/**
 * Everything a subscriber (the SSE stream) receives. 'task' carries the full
 * record on every state change (idempotent upserts client-side), 'task_event'
 * one journal line, 'task_text' live text of the current turn (SSE only,
 * never persisted — see the tasks store). project_id scopes the frame to the
 * repo the task lives in.
 *
 * A 'task_text' frame carrying `seq` is the agent's message of that index in
 * the running turn, cumulative within the message: the client APPENDS a new
 * seq as a new bubble and only rewrites the one it already has. Without
 * `seq` the frame is a bare progress line (the end-of-turn review) that
 * replaces the previous one.
 */
export type TaskEnvelope =
  | { project_id: string; task_id: string; event: { name: 'task'; data: TaskRecord } }
  | { project_id: string; task_id: string; event: { name: 'task_event'; data: TaskEvent } }
  | {
      project_id: string
      task_id: string
      event: { name: 'task_text'; data: { text: string; seq?: number } }
    }
  | { project_id: string; task_id: string; event: { name: 'task_meta'; data: { tokens: number } } }
  | { project_id: string; task_id: string; event: { name: 'task_checks'; data: TaskChecks } }
  // PROJECT-scoped, hence no task_id: the checks setup agent proposes a
  // configuration for the whole repo, not for one conversation.
  | { project_id: string; event: { name: 'checks_proposal'; data: ChecksSetupState } }

export type CreateTaskManagerInput = {
  title: string
  prompt: string
  autoShip: boolean
  /**
   * Optional LOCAL branch the task branches from (draft columns pick one from
   * the project tree). Absent or blank: the usual auto-detection at launch.
   * Exclusive with `branch`.
   */
  base?: string
  /**
   * Work-on mode: LOCAL branch the conversation works DIRECTLY on (no derived
   * codesema/task-* branch — the worktree is a checkout of the branch itself).
   * Exclusive with `base`.
   */
  branch?: string
  /**
   * Work-on mode only: the MR target branch (a click on an MR node passes its
   * targetBranch). Used as the record's base when it exists locally or on
   * origin; otherwise the base falls back to trunk auto-detection — an
   * unresolvable target is never a 400. Ignored without `branch`.
   */
  target?: string
}

export type TaskCreateResult =
  | { ok: true; record: TaskRecord }
  | {
      ok: false
      code: number
      error: string
      /** On the 409 of the one-active-conversation-per-branch guard: the conversation to open instead. */
      existing_task_id?: string
      /**
       * Names the refusal for a machine, next to (never instead of) the
       * readable `error`. Optional: a refusal the D2 vocabulary has no word
       * for carries its message alone rather than a code that misnames it.
       */
      reason_code?: ReasonCode
    }

/** Shared 404 for a project id absent from the registry (fits both result types). */
const unknownProject = { ok: false as const, code: 404, error: 'unknown project' }

export type TaskManager = {
  /** One project's tasks, most recently updated first; null on unknown project. */
  list: (projectId: string) => TaskRecord[] | null
  /** Every registered project with its tasks — the SSE initial replay. */
  listAll: () => { project: Project; records: TaskRecord[] }[]
  /** One task with its full journal; null on unknown project/task. */
  get: (projectId: string, id: string) => { record: TaskRecord; events: TaskEvent[] } | null
  /** Validates, persists and starts a new task in the project's repo. */
  create: (projectId: string, input: CreateTaskManagerInput) => TaskCreateResult
  reply: (projectId: string, id: string, message: string) => TaskActionResult
  /**
   * T8 (POST /api/tasks/:id/resume). Restarts the turn an 'interrupted' task
   * died on, with no new instruction from the human: same prompt, same turn,
   * resumed provider session when the record kept one. 409 on any other
   * status, on a task with no unfinished turn (only a reply moves that one),
   * and on a task whose worktree is gone.
   */
  resume: (projectId: string, id: string) => TaskActionResult
  interrupt: (projectId: string, id: string) => TaskActionResult
  /**
   * Push + MR creation (T5). Gated on a finished review: 'review_ok', or
   * 'review_ko' when the human ships an assumed KO anyway. A push failure
   * leaves the status unchanged (retryable); past the push the task is
   * 'shipped' even without an MR URL (no forge CLI = degraded ship, the
   * 'shipped' event's note says so).
   */
  ship: (projectId: string, id: string) => Promise<TaskActionResult>
  /** Discards the task's work: worktree AND branch deleted, status 'failed'. 409 while running. */
  abandon: (projectId: string, id: string) => TaskActionResult
  /**
   * Manual checks trigger (POST /api/tasks/:id/checks). Starts a background
   * containerized run of the repo's checks on the task worktree; 409 while a
   * run is already in flight or when the task has no turn commit to verify.
   * ok means STARTED — the outcome travels over SSE ('task_checks' frames)
   * and lands in checks.json.
   */
  checks: (projectId: string, id: string) => TaskActionResult
  /** Latest persisted checks run; null on unknown project/task or never-run. */
  getChecks: (projectId: string, id: string) => TaskChecks | null
  /**
   * The task's archived end-of-turn review (GET /api/tasks/:id/review).
   * `ref` — the archive path a review_done event carries — serves THAT turn's
   * review instead of the latest one, and is honored only inside the
   * project's .codesema/reviews. Null on unknown project/task, no review yet,
   * a pruned archive or an escaping ref: the route answers 404.
   */
  getReview: (projectId: string, id: string, ref?: string | null) => ReviewRecord | null
  /**
   * Asks the user's agent (READ-ONLY, no tools) to propose a checks
   * configuration for the project. ok means STARTED; the proposal lands on
   * the state below and on the SSE stream ('checks_proposal'). 501 without a
   * configured agent, 409 while a proposal is already being computed.
   */
  checksSetup: (projectId: string) => TaskActionResult
  /** Current proposal state of a project; null on unknown project. */
  checksSetupStatus: (projectId: string) => ChecksSetupState | null
  /**
   * Workspace-wide facts the UI needs before creating anything: whether the
   * container cage is usable here, and which isolation a new task would get.
   * Exposed on GET /api/projects.
   */
  workspaceInfo: () => {
    isolation_available: boolean
    isolation_default: TaskIsolation
    /** Why — always present, so a policy fallback is never silent in the UI either. */
    isolation_reason: string
    /**
     * What the config ASKED for. Lets the UI tell a deliberate 'policy' choice
     * apart from an 'auto' that fell back, and stop offering an upgrade the
     * user already declined.
     */
    isolation_configured: IsolationMode
  }
  /**
   * Writes the ready proposal to the project's .codesema/config.json — the
   * ONLY path from a proposal to disk. 409 when nothing is proposed.
   */
  checksApply: (projectId: string) => TaskActionResult
  /** Graceful exit: interrupts every active agent (all projects) and resolves once all turns persisted. */
  shutdown: () => Promise<void>
  subscribe: (listener: (envelope: TaskEnvelope) => void) => () => void
}

export type CreateTaskManagerOptions = {
  /** Raw configured agent command, shared by every project. */
  command: string
  timeoutMs: number
  /** GLOBAL cap of concurrently running tasks, all projects confounded. */
  maxParallel?: number
  /**
   * Result of the boot probe (workspace.ts): decides the isolation every new
   * task is created with. Absent means "nothing probed" — tasks are then
   * created as 'policy', which is what a plain server (tests, `codesema
   * review`) honestly offers.
   */
  isolation?: IsolationProbe
  /** Egress allowlist of the cage; the isolation module's default applies when absent. */
  allowedDomains?: readonly string[] | undefined
  runAgentFn?: (options: AgentRunOptions) => Promise<string>
  /** Test seam: lets tests observe/replace the runner without spawning agents. */
  createRunnerFn?: (options: TaskRunnerOptions) => TaskRunner
  /**
   * End-of-turn review override (test seam): the default reviewer
   * (createTaskReviewer) spawns a real review agent via runSimpleFlow — tests
   * driving a real runner must inject a stub here or keep worktrees diff-free
   * (the no-changes path never spawns anything).
   */
  reviewTurnFn?: TaskTurnReviewFn
  /** Test seam: the default pushes to origin and drives the real gh/glab. */
  shipTaskFn?: typeof shipTask
  /** Test seam: the default reads the global registry (projects.ts). */
  listProjectsFn?: () => Project[]
  /** Test seam: the default runs real containers (task-checks.ts). */
  runChecksFn?: typeof runChecks
  /**
   * Test seam for the checks SETUP agent (checks-setup.ts). Separate from
   * runAgentFn: the setup agent is a read-only text transformer, never the
   * task runner's working agent.
   */
  runSetupAgentFn?: (options: AgentRunOptions) => Promise<string>
}

/**
 * The status boot must rewrite a record to, or null to leave it alone. Two
 * rules:
 *
 * 1. A task left 'running' (or 'reviewing') while no runner holds it can only
 *    mean the previous codesema process died mid-turn: the agent process is
 *    gone, so the honest state is 'interrupted' — resumable, since the
 *    worktree and the unfinished turn are both still there.
 * 2. An 'interrupted' task whose MATERIALIZED worktree has vanished (deleted
 *    by hand, repo moved) is not resumable at all: its work is gone, and
 *    re-running the turn would fork a fresh branch and strand the commits.
 *    Same doctrine as abandon — a task without its worktree is 'failed' — so
 *    the UI never offers a Resume that would quietly lose work.
 */
function reconciledStatus(record: TaskRecord): 'interrupted' | 'failed' | null {
  const orphan = record.status === 'running' || record.status === 'reviewing'
  if (!orphan && record.status !== 'interrupted') {
    return null
  }
  // A worktree the record NAMES but disk no longer has. An empty path is a
  // task that never materialized one: nothing was lost.
  if (record.worktree !== '' && !existsSync(record.worktree)) {
    return 'failed'
  }
  return orphan ? 'interrupted' : null
}

/**
 * Applies reconciledStatus across a repo, journaling the WHY on each rewrite.
 * Called at boot for every registered project (and again when a project's
 * context is built — by then nothing of that project runs here yet), before
 * anything subscribes: no broadcast needed.
 */
function reconcileTasks(cwd: string): void {
  for (const record of listTasks(cwd)) {
    const status = reconciledStatus(record)
    if (status === null) {
      continue
    }
    const turn = record.turns.at(-1)
    if (turn && !turn.ended_at) {
      turn.ended_at = new Date().toISOString()
    }
    record.status = status
    record.updated_at = new Date().toISOString()
    saveTask(cwd, record)
    appendTaskEvent(
      cwd,
      record.id,
      status === 'failed'
        ? { type: 'error', data: { message: 'worktree is gone, the task cannot be resumed' } }
        : { type: 'interrupted', data: { message: 'process exited while the task was active' } },
    )
  }
}

/**
 * Ship gate: only a finished review ships — 'review_ok', or 'review_ko' when
 * the human assumes the KO. 'shipped' refuses again for idempotence (the
 * branch is on origin, the MR exists: a re-ship would duplicate it). Null
 * means the ship may proceed.
 */
function shipRefusal(record: TaskRecord): TaskActionResult | null {
  if (record.status === 'shipped') {
    return { ok: false, code: 409, error: 'task is already shipped' }
  }
  if (record.status !== 'review_ok' && record.status !== 'review_ko') {
    return { ok: false, code: 409, error: `task is ${record.status}` }
  }
  if (!record.branch) {
    return { ok: false, code: 409, error: 'task has no branch to ship' }
  }
  return null
}

/** Everything the manager holds per project, built lazily at first access. */
type ProjectContext = {
  project: Project
  runner: TaskRunner
  /** Tasks with a ship in flight (see ship below). */
  shipping: Set<string>
  /** Tasks with a checks run in flight (one run at a time per task). */
  checking: Set<string>
}

export function createTaskManager(opts: CreateTaskManagerOptions): TaskManager {
  const registered = opts.listProjectsFn ?? listProjects
  // Boot recovery across EVERY registered repo: the SSE replay (listAll) must
  // already show a dead process's tasks as 'interrupted', context or not.
  for (const project of registered()) {
    reconcileTasks(project.path)
  }

  const listeners = new Set<(envelope: TaskEnvelope) => void>()
  const emit = (envelope: TaskEnvelope): void => {
    for (const listener of listeners) {
      listener(envelope)
    }
  }

  // ONE pool for every runner: maxParallel is a global budget, a slot freed by
  // any project's task wakes every project's queue.
  const pool = createTaskSlotPool(opts.maxParallel ?? DEFAULT_MAX_PARALLEL_TASKS)
  const probe = opts.isolation ?? UNPROBED_ISOLATION
  const createRunner = opts.createRunnerFn ?? createTaskRunner
  const contexts = new Map<string, ProjectContext>()

  // Project-scoped, context-free: proposing a checks configuration needs no
  // runner, no store and no worktree — only the repo path and the agent.
  const checksSetup: ChecksSetupRunner = createChecksSetupRunner({
    command: opts.command,
    ...(opts.runSetupAgentFn ? { runAgentFn: opts.runSetupAgentFn } : {}),
    onState: (projectId, state) =>
      emit({ project_id: projectId, event: { name: 'checks_proposal', data: state } }),
  })
  /** Registry lookup shared by the project-scoped routes (no lazy context needed). */
  const findProject = (projectId: string): Project | null =>
    registered().find((candidate) => candidate.id === projectId) ?? null

  /**
   * T5. Never rejects: a push failure comes back as a plain error result with
   * an 'error' journal event, status untouched — the branch and worktree are
   * intact and the ship is retryable once the remote/auth problem is fixed.
   */
  const ship = async (ctx: ProjectContext, id: string): Promise<TaskActionResult> => {
    const cwd = ctx.project.path
    const projectId = ctx.project.id
    if (ctx.shipping.has(id)) {
      return { ok: false, code: 409, error: 'ship already in progress' }
    }
    const record = loadTask(cwd, id)
    if (!record) {
      return { ok: false, code: 404, error: 'task not found' }
    }
    const refusal = shipRefusal(record)
    if (refusal) {
      return refusal
    }
    ctx.shipping.add(id)
    try {
      const run = opts.shipTaskFn ?? shipTask
      let outcome: ShipOutcome
      try {
        outcome = await run({ cwd, task: record })
      } catch (err) {
        outcome = { pushed: false, error: err instanceof Error ? err.message : String(err) }
      }
      if (!outcome.pushed) {
        const event = appendTaskEvent(cwd, id, {
          type: 'error',
          data: { message: outcome.error },
        })
        emit({ project_id: projectId, task_id: id, event: { name: 'task_event', data: event } })
        // 502: the failure is on the remote/CLI side, not in the request.
        return { ok: false, code: 502, error: outcome.error }
      }
      const event = appendTaskEvent(cwd, id, {
        type: 'shipped',
        data: { mr_url: outcome.mrUrl, ...(outcome.note !== null ? { note: outcome.note } : {}) },
        // Added beside the note, which keeps saying the same thing in words.
        ...(outcome.reasonCode ? { reason_code: outcome.reasonCode } : {}),
      })
      emit({ project_id: projectId, task_id: id, event: { name: 'task_event', data: event } })
      // A ship that stopped short of an MR says so on the record too; a clean
      // one clears whatever reason an earlier degradation had left there.
      if (outcome.reasonCode) {
        record.reason = taskReason(outcome.reasonCode, outcome.note ?? undefined)
      } else {
        delete record.reason
      }
      record.status = 'shipped'
      record.updated_at = new Date().toISOString()
      saveTask(cwd, record)
      emit({ project_id: projectId, task_id: record.id, event: { name: 'task', data: record } })
      return { ok: true }
    } finally {
      ctx.shipping.delete(id)
    }
  }

  /**
   * Containerized checks (task-checks.ts) on the task's worktree, in the
   * background. Guards run synchronously (409 while in flight, 409 without a
   * turn commit); the run itself is fire-and-forget and BEST-EFFORT: every
   * outcome — missing container runtime included — lands in checks.json as a
   * status, and a checks problem never touches the task record.
   */
  const startChecks = (ctx: ProjectContext, id: string): TaskActionResult => {
    const cwd = ctx.project.path
    const projectId = ctx.project.id
    if (ctx.checking.has(id)) {
      return { ok: false, code: 409, error: 'checks already running' }
    }
    const record = loadTask(cwd, id)
    if (!record) {
      return { ok: false, code: 404, error: 'task not found' }
    }
    // Checks verify COMMITTED work: a task whose turns never committed (or
    // whose worktree is gone) has nothing to run against.
    const hasCommit = readTaskEvents(cwd, id).some((event) => event.type === 'commit')
    if (!hasCommit || !record.worktree || !existsSync(record.worktree)) {
      return { ok: false, code: 409, error: 'task has no commit to check' }
    }
    const headSha = tryGit(['rev-parse', 'HEAD'], record.worktree) ?? ''
    ctx.checking.add(id)
    const broadcast = (snapshot: TaskChecks): void => {
      // writeTaskChecks sanitizes and returns the persisted copy: SSE
      // subscribers always see exactly what a later GET will read.
      const clean = writeTaskChecks(cwd, id, snapshot)
      emit({ project_id: projectId, task_id: id, event: { name: 'task_checks', data: clean } })
    }
    // 'running' is on disk (and on the stream) before this returns: the POST
    // caller's immediate GET already sees the run.
    broadcast({
      head_sha: headSha,
      started_at: new Date().toISOString(),
      finished_at: null,
      status: 'running',
      checks: [],
      error: null,
    })
    const run = opts.runChecksFn ?? runChecks
    void (async () => {
      try {
        let final: TaskChecks
        try {
          final = await run({
            worktree: record.worktree,
            config: readChecksConfig(cwd),
            headSha,
            onUpdate: (snapshot) => broadcast(snapshot),
          })
        } catch (err) {
          // runChecks never rejects by contract; a bug there must not strand
          // the run on 'running' forever.
          final = {
            head_sha: headSha,
            started_at: new Date().toISOString(),
            finished_at: new Date().toISOString(),
            status: 'error',
            checks: [],
            error: err instanceof Error ? err.message : String(err),
          }
        }
        const clean = writeTaskChecks(cwd, id, final)
        emit({ project_id: projectId, task_id: id, event: { name: 'task_checks', data: clean } })
        const passed = clean.checks.filter((c) => c.status === 'passed').length
        const failed = clean.checks.filter(
          (c) => c.status === 'failed' || c.status === 'timeout',
        ).length
        const event = appendTaskEvent(cwd, id, {
          type: 'checks',
          data: { status: clean.status, passed, failed },
        })
        emit({ project_id: projectId, task_id: id, event: { name: 'task_event', data: event } })
      } catch {
        // Even persistence trouble stays best-effort: the task never breaks
        // because its checks could not be recorded.
      } finally {
        ctx.checking.delete(id)
      }
    })()
    return { ok: true }
  }

  /**
   * Auto-trigger after a turn COMMIT: fired from onTurnDone, in parallel with
   * the review and never awaited. Only when this very turn committed (the
   * runner appends its 'commit' event right before calling onTurnDone) — a
   * no-change turn re-checks nothing.
   */
  const startChecksAfterCommit = (ctx: ProjectContext, record: TaskRecord): void => {
    try {
      const commits = readTaskEvents(ctx.project.path, record.id).filter(
        (event) => event.type === 'commit',
      )
      if (commits.at(-1)?.data.turn !== record.turns.length) {
        return
      }
      // The result is deliberately dropped: a 409 (manual run already in
      // flight) or a missing-commit refusal must never disturb the turn.
      startChecks(ctx, record.id)
    } catch {
      // Best-effort by contract.
    }
  }

  /**
   * Lazy per-project assembly: store recovery, reviewer and runner are only
   * built once a project's tasks are actually touched, so a registry of ten
   * repos does not cost ten runners at boot. Null on an unregistered id — the
   * registry is re-read on every miss, so a project added at runtime through
   * POST /api/projects is picked up without a restart.
   */
  const context = (projectId: string): ProjectContext | null => {
    const cached = contexts.get(projectId)
    if (cached) {
      return cached
    }
    const project = registered().find((candidate) => candidate.id === projectId)
    if (!project) {
      return null
    }
    // A project registered after boot may carry orphans from an older run.
    reconcileTasks(project.path)
    const cwd = project.path
    // T4: every done turn flows through the automatic review before the human
    // sees a verdict; the reviewer shares the task agent command and timeout.
    const reviewTurn =
      opts.reviewTurnFn ??
      createTaskReviewer({ cwd, command: opts.command, timeoutMs: opts.timeoutMs })
    // T5: auto-ship chains on the review verdict, INSIDE the onTurnDone hook
    // so it only ever fires after the reviewer's final transition. Green
    // reviews only — an assumed-KO ship is always a human click. ship() never
    // rejects, so a failed auto-push cannot trip the runner's review_ko
    // fallback. `ctx` is assigned right below, before any turn can end.
    const onTurnDone: TaskTurnReviewFn = async (record, io) => {
      // Checks run in PARALLEL with the review, fire-and-forget: they never
      // delay the review nor the turn, and their failure (even a missing
      // container runtime) never blocks anything.
      startChecksAfterCommit(ctx, record)
      await reviewTurn(record, io)
      if (record.auto_ship && record.status === 'review_ok') {
        await ship(ctx, record.id)
      }
    }
    // The runner writes to the store first, then calls these hooks: a
    // subscriber reacting to an envelope always finds the disk state at least
    // as fresh.
    const runner = createRunner({
      cwd,
      command: opts.command,
      timeoutMs: opts.timeoutMs,
      slots: pool,
      onTurnDone,
      // Cage inputs, read from the project's own config: its checks image is
      // the base-image fallback, its allowlist bounds the egress proxy.
      checksConfig: readChecksConfig(cwd),
      ...(opts.allowedDomains ? { allowedDomains: opts.allowedDomains } : {}),
      ...(opts.runAgentFn ? { runAgentFn: opts.runAgentFn } : {}),
      onTask: (record) =>
        emit({ project_id: projectId, task_id: record.id, event: { name: 'task', data: record } }),
      onEvent: (taskId, event) =>
        emit({
          project_id: projectId,
          task_id: taskId,
          event: { name: 'task_event', data: event },
        }),
      onText: (taskId, text, seq) =>
        emit({
          project_id: projectId,
          task_id: taskId,
          // The index rides along only when there IS one: a frame without it
          // is a progress line, and the client must not turn it into a bubble.
          event: { name: 'task_text', data: { text, ...(seq === undefined ? {} : { seq }) } },
        }),
      onTokens: (taskId, tokens) =>
        emit({
          project_id: projectId,
          task_id: taskId,
          event: { name: 'task_meta', data: { tokens } },
        }),
    })
    const ctx: ProjectContext = { project, runner, shipping: new Set(), checking: new Set() }
    contexts.set(projectId, ctx)
    return ctx
  }

  return {
    list(projectId) {
      const project = registered().find((candidate) => candidate.id === projectId)
      return project ? listTasks(project.path) : null
    },

    listAll: () => registered().map((project) => ({ project, records: listTasks(project.path) })),

    get(projectId, id) {
      const project = registered().find((candidate) => candidate.id === projectId)
      if (!project) {
        return null
      }
      const record = loadTask(project.path, id)
      if (!record) {
        return null
      }
      return { record, events: readTaskEvents(project.path, id) }
    },

    create(projectId, input) {
      const ctx = context(projectId)
      if (!ctx) {
        return unknownProject
      }
      // Reject rather than truncate: a silently shortened title or prompt
      // would diverge from what the user thinks the agent was told.
      const title = input.title.trim()
      if (!title) {
        return { ok: false, code: 400, error: 'empty title' }
      }
      if (title.length > TASK_TITLE_MAX) {
        return { ok: false, code: 400, error: `title too long (max ${TASK_TITLE_MAX})` }
      }
      const prompt = input.prompt.trim()
      if (!prompt) {
        return { ok: false, code: 400, error: 'empty prompt' }
      }
      if (prompt.length > TASK_TURN_TEXT_MAX) {
        return { ok: false, code: 400, error: `prompt too long (max ${TASK_TURN_TEXT_MAX})` }
      }
      // Optional explicit base: must be an existing LOCAL branch, checked now
      // so the caller gets a synchronous 400 instead of a task that fails at
      // launch. Blank means absent (auto-detection at launch, as before).
      // 'origin/x' and 'x' are the SAME branch: identity is the short name.
      const base = shortBranchName((input.base ?? '').trim())
      const branch = shortBranchName((input.branch ?? '').trim())
      // `branch` (work-on) and `base` (fork) are two different creation modes:
      // both at once is a caller bug, not something to guess a priority for.
      if (branch && base) {
        return { ok: false, code: 400, error: "'branch' and 'base' are mutually exclusive" }
      }
      if (base) {
        if (base.length > TASK_BASE_MAX) {
          return { ok: false, code: 400, error: `base too long (max ${TASK_BASE_MAX})` }
        }
        if (base.startsWith('-')) {
          // Never let a branch name masquerade as a git option.
          return { ok: false, code: 400, error: `invalid base branch name '${base}'` }
        }
        if (resolveBranchRef(ctx.project.path, base) === null) {
          return { ok: false, code: 400, error: `base branch '${base}' does not exist` }
        }
      }
      // Work-on mode: the record's branch IS the existing branch, fixed at
      // creation. Every guard runs now, synchronously, so a refusal leaves
      // nothing behind — no record, no worktree, no ref.
      let recordBase = base
      if (branch) {
        if (branch.length > TASK_BASE_MAX) {
          return { ok: false, code: 400, error: `branch too long (max ${TASK_BASE_MAX})` }
        }
        if (branch.startsWith('-')) {
          return { ok: false, code: 400, error: `invalid branch name '${branch}'` }
        }
        if (resolveBranchRef(ctx.project.path, branch) === null) {
          return { ok: false, code: 400, error: `branch '${branch}' does not exist` }
        }
        // ONE active conversation per branch. Only work-on creations need the
        // guard: fork branches are minted at launch from the free refs/heads
        // namespace, and every active task's branch keeps a live ref, so a
        // fork can never collide with an active conversation's branch.
        const existing = listTasks(ctx.project.path).find(
          (task) => task.branch === branch && isActiveTaskStatus(task.status),
        )
        if (existing) {
          return {
            ok: false,
            code: 409,
            error: `a conversation is already active on branch '${branch}'`,
            existing_task_id: existing.id,
          }
        }
        // A branch checked out anywhere (the MAIN worktree counts) cannot be
        // checked out again: refuse now rather than failing the first turn.
        const takenBy = branchCheckoutPath(ctx.project.path, branch)
        if (takenBy) {
          return {
            ok: false,
            code: 409,
            error: `branch '${branch}' is already checked out in another worktree (${takenBy})`,
          }
        }
        // The record's base is the MR target: the caller's `target` when it
        // resolves (an MR target may only exist on origin), otherwise the same
        // trunk auto-detection as fork mode — an unresolvable target is never
        // a 400.
        const target = shortBranchName((input.target ?? '').trim())
        const targetResolves =
          target && !target.startsWith('-') && resolveBranchRef(ctx.project.path, target) !== null
        if (targetResolves) {
          recordBase = target
        } else {
          try {
            recordBase = detectTaskBase(ctx.project.path)
          } catch (err) {
            // No trunk anywhere: the MR target of a work-on conversation
            // cannot be determined, and unlike fork mode there is no later
            // launch step to surface it — refuse synchronously.
            return {
              ok: false,
              code: 400,
              error: err instanceof Error ? err.message : String(err),
            }
          }
        }
      }
      // branch/worktree stay empty here (fork mode): the runner creates the
      // worktree when the task actually launches (so a queued task costs
      // nothing). A non-empty base on a never-materialized record is the
      // runner's signal to branch from it instead of auto-detecting. A
      // work-on record instead carries its branch (and workOn) from day one.
      // Isolation is decided HERE, once, and stored on the record: the runner
      // reads it and never re-decides. A workspace configured 'container'
      // refuses the creation outright rather than quietly running the task on
      // the host under a weaker containment than the one that was asked for.
      const resolved = resolveTaskIsolation(probe)
      if (!resolved) {
        return {
          ok: false,
          code: 409,
          error: t('isolation.unavailable', { reason: probe.reason }),
          // The cage was ASKED for and is not there right now: an engine that
          // does not answer is a resource the machine currently lacks, so the
          // refusal is retryable — the readable error keeps saying why.
          reason_code: 'resource_busy',
        }
      }
      const record = createTask(ctx.project.path, {
        title,
        prompt,
        autoShip: input.autoShip,
        base: recordBase,
        branch,
        worktree: '',
        workOn: branch !== '',
        isolation: resolved.isolation,
      })
      // The WHY is journaled on the task itself: an 'auto' workspace that fell
      // back to policy must be able to say so, months later, from the record.
      const isolationEvent = appendTaskEvent(ctx.project.path, record.id, {
        type: 'isolation',
        data: { isolation: resolved.isolation, reason: resolved.reason },
      })
      emit({ project_id: projectId, task_id: record.id, event: { name: 'task', data: record } })
      emit({
        project_id: projectId,
        task_id: record.id,
        event: { name: 'task_event', data: isolationEvent },
      })
      // start() rereads the task.json written just above; on a fresh 'queued'
      // record it cannot legitimately refuse, but a refusal must not be
      // swallowed: the caller would wait forever on a task that never runs.
      const started = ctx.runner.start(record)
      if (!started.ok) {
        return started
      }
      return { ok: true, record }
    },

    // While a ship pushes, a reply would start a new turn (and a new commit)
    // under it, and an abandon would delete the very branch being pushed:
    // both wait until the ship settles. interrupt already 409s at the runner
    // (a shippable task is neither active nor queued).
    reply(projectId, id, message) {
      const ctx = context(projectId)
      if (!ctx) {
        return unknownProject
      }
      return ctx.shipping.has(id)
        ? { ok: false, code: 409, error: 'ship in progress' }
        : ctx.runner.reply(id, message)
    },

    // Same reason as reply: a resume starts a turn (and a commit) under a push
    // in flight, so it waits for the ship to settle.
    resume(projectId, id) {
      const ctx = context(projectId)
      if (!ctx) {
        return unknownProject
      }
      return ctx.shipping.has(id)
        ? { ok: false, code: 409, error: 'ship in progress' }
        : ctx.runner.resume(id)
    },

    interrupt(projectId, id) {
      const ctx = context(projectId)
      return ctx ? ctx.runner.interrupt(id) : unknownProject
    },

    ship(projectId, id) {
      const ctx = context(projectId)
      return ctx ? ship(ctx, id) : Promise.resolve(unknownProject)
    },

    abandon(projectId, id) {
      const ctx = context(projectId)
      if (!ctx) {
        return unknownProject
      }
      return ctx.shipping.has(id)
        ? { ok: false, code: 409, error: 'ship in progress' }
        : ctx.runner.abandon(id)
    },

    checks(projectId, id) {
      const ctx = context(projectId)
      return ctx ? startChecks(ctx, id) : unknownProject
    },

    getChecks(projectId, id) {
      const project = findProject(projectId)
      return project ? readTaskChecks(project.path, id) : null
    },

    getReview(projectId, id, ref) {
      const project = findProject(projectId)
      return project ? readTaskReview(project.path, id, ref) : null
    },

    checksSetup(projectId) {
      const project = findProject(projectId)
      return project ? checksSetup.start(project) : unknownProject
    },

    checksSetupStatus(projectId) {
      const project = findProject(projectId)
      return project ? checksSetup.status(project.id) : null
    },

    workspaceInfo: () => ({
      ...isolationDefaults(probe),
      isolation_reason: probe.reason,
      isolation_configured: probe.configured,
    }),

    checksApply(projectId) {
      const project = findProject(projectId)
      return project ? checksSetup.apply(project) : unknownProject
    },

    async shutdown() {
      await Promise.allSettled([...contexts.values()].map((ctx) => ctx.runner.shutdown()))
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
