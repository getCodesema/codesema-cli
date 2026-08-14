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

import type { AgentRunOptions } from './agent.js'
import { TASK_TITLE_MAX, TASK_TURN_TEXT_MAX, type TaskEvent, type TaskRecord } from './contract.js'
import { listProjects, type Project } from './projects.js'
import { createTaskReviewer } from './task-review.js'
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
  appendTaskEvent,
  createTask,
  listTasks,
  loadTask,
  readTaskEvents,
  saveTask,
} from './tasks-store.js'

/**
 * Everything a subscriber (the SSE stream) receives. 'task' carries the full
 * record on every state change (idempotent upserts client-side), 'task_event'
 * one journal line, 'task_text' the cumulative streamed text of the current
 * turn (SSE only, never persisted — see the tasks store). project_id scopes
 * the frame to the repo the task lives in.
 */
export type TaskEnvelope =
  | { project_id: string; task_id: string; event: { name: 'task'; data: TaskRecord } }
  | { project_id: string; task_id: string; event: { name: 'task_event'; data: TaskEvent } }
  | { project_id: string; task_id: string; event: { name: 'task_text'; data: { text: string } } }

export type CreateTaskManagerInput = {
  title: string
  prompt: string
  autoShip: boolean
}

export type TaskCreateResult =
  { ok: true; record: TaskRecord } | { ok: false; code: number; error: string }

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
}

/**
 * A task left 'running' (or 'reviewing') on disk while no runner holds it can
 * only mean the previous codesema process died mid-turn: the agent process is
 * gone, so the honest state is 'interrupted' (T8 adds the resume offer).
 * Called at boot for every registered project (and again when a project's
 * context is built — by then nothing of that project runs here yet), before
 * anything subscribes: no broadcast needed.
 */
function recoverOrphans(cwd: string): void {
  for (const record of listTasks(cwd)) {
    if (record.status !== 'running' && record.status !== 'reviewing') {
      continue
    }
    const turn = record.turns.at(-1)
    if (turn && !turn.ended_at) {
      turn.ended_at = new Date().toISOString()
    }
    record.status = 'interrupted'
    record.updated_at = new Date().toISOString()
    saveTask(cwd, record)
    appendTaskEvent(cwd, record.id, {
      type: 'interrupted',
      data: { message: 'process exited while the task was active' },
    })
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
}

export function createTaskManager(opts: CreateTaskManagerOptions): TaskManager {
  const registered = opts.listProjectsFn ?? listProjects
  // Boot recovery across EVERY registered repo: the SSE replay (listAll) must
  // already show a dead process's tasks as 'interrupted', context or not.
  for (const project of registered()) {
    recoverOrphans(project.path)
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
  const createRunner = opts.createRunnerFn ?? createTaskRunner
  const contexts = new Map<string, ProjectContext>()

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
      })
      emit({ project_id: projectId, task_id: id, event: { name: 'task_event', data: event } })
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
    recoverOrphans(project.path)
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
      ...(opts.runAgentFn ? { runAgentFn: opts.runAgentFn } : {}),
      onTask: (record) =>
        emit({ project_id: projectId, task_id: record.id, event: { name: 'task', data: record } }),
      onEvent: (taskId, event) =>
        emit({
          project_id: projectId,
          task_id: taskId,
          event: { name: 'task_event', data: event },
        }),
      onText: (taskId, text) =>
        emit({
          project_id: projectId,
          task_id: taskId,
          event: { name: 'task_text', data: { text } },
        }),
    })
    const ctx: ProjectContext = { project, runner, shipping: new Set() }
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
      // base/branch/worktree stay empty here: the runner creates the worktree
      // when the task actually launches (so a queued task costs nothing).
      const record = createTask(ctx.project.path, {
        title,
        prompt,
        autoShip: input.autoShip,
        base: '',
        branch: '',
        worktree: '',
      })
      emit({ project_id: projectId, task_id: record.id, event: { name: 'task', data: record } })
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

    async shutdown() {
      await Promise.allSettled([...contexts.values()].map((ctx) => ctx.runner.shutdown()))
    },

    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
