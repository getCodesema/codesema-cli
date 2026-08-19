// Task manager: the one object the HTTP server drives for the agentic
// workspace. Multi-project: it aggregates one tasks store + one task runner +
// one persisted queue per REGISTERED project (global registry, projects.ts),
// instantiated lazily at first access. Concurrency follows from ONE active
// task per project (T1.2): projects advance side by side, and a second task
// of the same repo waits in that repo's <repo>/.codesema/queue.json. Each repo
// keeps its own .codesema/ as the source of truth for its tasks; the manager
// only routes by project id. Everything that happens is multiplexed into a
// single pub/sub bus of {project_id, task_id, event} envelopes — the shape the
// global SSE stream (/api/tasks/events) forwards verbatim, so N conversations
// across N projects ride one EventSource.

import { existsSync } from 'node:fs'
import type { AgentRunOptions, WatchdogBudgets } from './agent.js'
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
  type TaskReason,
  type TaskRecord,
  type TaskStatus,
} from './contract.js'
import { refExists, tryGit } from './git.js'
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
import { createTaskQueue, type TaskQueue } from './task-queue.js'
import { createTaskReviewer, readTaskReview } from './task-review.js'
import {
  createTaskRunner,
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
  onStoreUnreadable,
  readTaskChecks,
  readTaskEvents,
  saveTask,
  taskReason,
  writeTaskChecks,
  type AppendTaskEventInput,
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
   * status and on a task with no unfinished turn (only a reply moves that
   * one). A worktree that vanished is rebuilt on the conversation's own
   * branch, never refused.
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
  abandon: (projectId: string, id: string) => Promise<TaskActionResult>
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
  /**
   * Picks the persisted queues back up — the ONE thing the boot recovery
   * deliberately does not do by itself. Building the manager only reconciles
   * records and queue files on disk; agents start here, and the caller is
   * expected to call this only once the HTTP server listens and the shutdown
   * handlers are installed, so a turn can never start in a process that cannot
   * yet be talked to nor stopped. Returns what it resumed, for the boot line.
   * Idempotent: a project already running is not restarted.
   */
  startPending: () => PendingQueue[]
  /** Graceful exit: interrupts every active agent (all projects) and resolves once all turns persisted. */
  shutdown: () => Promise<void>
  subscribe: (listener: (envelope: TaskEnvelope) => void) => () => void
}

export type CreateTaskManagerOptions = {
  /** Raw configured agent command, shared by every project. */
  command: string
  /** Last-resort absolute ceiling of a turn; the watchdog is what detects a dead one. */
  timeoutMs: number
  /** Watchdog budgets (D3), read from the config by resolveWatchdogBudgets. */
  watchdog?: WatchdogBudgets | undefined
  /**
   * INERT since T1.2: the number of active tasks follows from "one active
   * task per project", not from a global budget. Still accepted (and still
   * fed by the `maxParallelTasks` config key) so nothing breaks while T1.3
   * turns that key into the machine-load cap of D4, or retires it.
   */
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
  /**
   * Where the manager says out loud what it had to degrade — a queue file it
   * could not use, a project whose boot recovery blew up. Defaults to a
   * console line: a degradation whose only trace is a journal nobody has a
   * reason to open is a silent one (invariant 2). Tests collect instead.
   */
  onNotice?: (message: string) => void
}

/** One project whose persisted queue was resumed, for the boot announcement. */
export type PendingQueue = {
  project: Project
  /** Tasks in that project's line when the runner picked it back up. */
  queued: number
}

/**
 * The status boot must rewrite a record to, or null to leave it alone. Two
 * rules:
 *
 * 1. A task left 'running' (or 'reviewing') while no runner holds it can only
 *    mean the previous codesema process died mid-turn: the agent process is
 *    gone, so the honest state is 'interrupted' — resumable, since the
 *    worktree and the unfinished turn are both still there.
 * 2. A task whose MATERIALIZED worktree has vanished (deleted by hand, repo
 *    moved) is judged on its BRANCH, not on the checkout: the worktree is a
 *    view, the branch is where the commits live. As long as that branch is
 *    still there, ensureWorktree checks it back out in a fresh worktree — same
 *    branch, same anchor, nothing stranded — so the task stays 'interrupted'
 *    and Resume is honest. Only when the branch is gone TOO is the work
 *    unrecoverable, and only then does the task become 'failed'.
 *
 *    (Until this ticket the rule was "no worktree ⇒ failed", because a rebuild
 *    forked a NEW branch and left the earlier commits behind. That is exactly
 *    the behaviour the runner no longer has.)
 */
function reconciledStatus(cwd: string, record: TaskRecord): 'interrupted' | 'failed' | null {
  const orphan = record.status === 'running' || record.status === 'reviewing'
  if (!orphan && record.status !== 'interrupted') {
    return null
  }
  // A worktree the record NAMES but disk no longer has. An empty path is a
  // task that never materialized one: nothing was lost.
  if (
    record.worktree !== '' &&
    !existsSync(record.worktree) &&
    // `^{commit}`, not the bare ref: a ref whose object is missing resolves
    // perfectly well and carries no work at all (same trap as the runner's
    // adoption gate and the baseline validation).
    !(record.branch !== '' && refExists(`refs/heads/${record.branch}^{commit}`, cwd))
  ) {
    return 'failed'
  }
  // A recoverable one falls through to the ordinary rule: an already-interrupted
  // task is left exactly as it is, journal included — nothing happened to it.
  return orphan ? 'interrupted' : null
}

/**
 * What boot says to a `queued` record found in a repo that has NO queue.json.
 * There is no line for it to be in: the file this system writes on every
 * enqueue is simply not there, so the record is left over from a session that
 * died before queues existed (0.12) or was wiped by hand. It is an orphan, not
 * a task waiting its turn, and starting an agent on it unattended is not
 * something a boot gets to decide.
 */
const ORPHANED_QUEUED = 'orphaned by an earlier session: nothing was queued to start it'

export type ReconcileOutcome = {
  /** How many tasks the reconciled queue holds — i.e. would start on their own. */
  queued: number
  /** Readable reason when the queue file could not be used; null otherwise. */
  degraded: string | null
  /** Things the boot did that are worth saying without being failures. */
  notices: string[]
}

/** What the boot took out of a project's line, named so it is never silent. */
export function queueEntriesRetired(ids: readonly string[]): string {
  return `${ids.length} queued task${ids.length === 1 ? '' : 's'} left the queue at boot (finished, abandoned, or no longer on disk): ${ids.join(', ')}`
}

/**
 * Applies reconciledStatus across a repo, journaling the WHY on each rewrite,
 * then re-hydrates that repo's persisted queue and reconciles it with the
 * records it just settled. Called at boot for every registered project (and
 * again when a project's context is built — by then nothing of that project
 * runs here yet), before anything subscribes: no broadcast needed.
 */
function reconcileTasks(cwd: string, projectId: string): ReconcileOutcome {
  const records = listTasks(cwd)
  /** Facts worth a line on the terminal that are not, in themselves, failures. */
  const notices: string[] = []
  /**
   * `reason` travels WITH the status, always. A boot rewrite is a degradation
   * like any other (invariant 2) and the D2 vocabulary is the machine-readable
   * half of it: leaving `record.reason` empty here would make these the only
   * degradations of the store a client cannot read without parsing English.
   */
  const rewrite = (
    record: TaskRecord,
    status: TaskStatus,
    event: AppendTaskEventInput,
    reason: TaskReason,
  ): void => {
    const turn = record.turns.at(-1)
    if (turn && !turn.ended_at) {
      turn.ended_at = new Date().toISOString()
    }
    record.status = status
    record.reason = reason
    record.updated_at = new Date().toISOString()
    saveTask(cwd, record)
    appendTaskEvent(cwd, record.id, { ...event, reason_code: reason.code })
  }
  for (const record of records) {
    const status = reconciledStatus(cwd, record)
    if (status === null) {
      continue
    }
    if (status === 'failed') {
      const message = 'worktree and branch are both gone, the task cannot be resumed'
      // TERMINAL, and the code has to say so. `agent_error` claimed the exact
      // opposite of the message sitting next to it — that the agent had
      // failed, that the committed work was intact, and that running the turn
      // again was the recovery — so a consumer reading
      // `isTerminalReason(...) === false` would offer a retry the API then
      // refuses. Of the ten codes, `branch_diverged` is the one whose doctrine
      // fits: what carried the work cannot be used as it stands, and only an
      // action on the work changes that — never a delay.
      rewrite(
        record,
        status,
        { type: 'error', data: { message } },
        taskReason('branch_diverged', message),
      )
    } else {
      const message = 'process exited while the task was active'
      rewrite(
        record,
        status,
        { type: 'interrupted', data: { message } },
        taskReason('interrupted_by_user', message),
      )
    }
  }
  // The queue comes SECOND, on the statuses this pass just settled: an id it
  // moved off 'queued' must not survive in the file.
  const reconciled = createTaskQueue({ cwd, projectId }).reconcile(records)
  if (!reconciled.present) {
    // No queue.json at all: only a line THIS system wrote is ever resumed on
    // its own. Whatever sits on 'queued' here was orphaned by a session that
    // never got to run it — it becomes 'interrupted', which is exactly the
    // state a human Resume knows how to pick up, and no agent starts by
    // surprise on a boot the user did not ask anything of.
    for (const record of records) {
      if (record.status === 'queued') {
        rewrite(
          record,
          'interrupted',
          { type: 'interrupted', data: { message: ORPHANED_QUEUED } },
          // Nobody pressed anything, but this IS the human-gesture branch of
          // the vocabulary: the task stops and only a human restarts it. The
          // detail says which human absence caused it.
          taskReason('interrupted_by_user', ORPHANED_QUEUED),
        )
      }
    }
    return { queued: 0, degraded: null, notices }
  }
  if (reconciled.removed.length > 0) {
    // Dropping ids from the line is a real change to what this project was
    // going to run, and it used to happen without a word anywhere. It is rare
    // by construction — `launch` takes an id out of the file the moment it
    // starts, so a queued entry only goes terminal or vanishes when a process
    // died at exactly the wrong moment — which is precisely why it deserves a
    // line when it does happen. (Entries whose record merely could not be READ
    // are no longer part of this: they keep their place.)
    notices.push(queueEntriesRetired(reconciled.removed))
  }
  if (reconciled.degraded !== null) {
    // Never silent (invariant 2): the readable reason lands in the journal of
    // every task the rebuilt queue holds — the tasks the lost order actually
    // concerned — where GET /api/tasks/:id serves it back to the UI. The
    // caller ALSO surfaces it as a server notice, because a degradation whose
    // only trace is a journal nobody has a reason to open is a silent one.
    for (const id of reconciled.ids) {
      appendTaskEvent(cwd, id, { type: 'error', data: { message: reconciled.degraded } })
    }
  }
  return { queued: reconciled.ids.length, degraded: reconciled.degraded, notices }
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Ceiling on the number of rank-refresh frames one queue mutation may produce.
 * The badge is a courtesy on a card the human is looking at; the exact ranking
 * always comes back with GET /api/tasks. Fifty is far past any queue a person
 * reads and keeps a mutation's cost flat instead of proportional to the line.
 */
export const QUEUE_BROADCAST_MAX = 50

/**
 * The project's queue, for the read-time position view (no runner needed).
 *
 * `onDegraded` is not optional in practice: this builds a fresh queue on every
 * listing, and a read that finds the file unusable has to be able to say so
 * AND to repair it. Without a handler the listing route was the one place
 * where a broken queue.json produced nothing at all — no reason, no journal
 * line, no notice.
 */
const queueOf = (
  project: Project,
  onDegraded?: (reason: string, ids: readonly string[]) => void,
): TaskQueue =>
  createTaskQueue({
    cwd: project.path,
    projectId: project.id,
    ...(onDegraded ? { onDegraded } : {}),
  })

/**
 * Read-time view of a project's queue: every waiting record is handed back
 * with its 1-based `queue_position`. DERIVED, never persisted — the position
 * of a task is a fact about the queue at the moment it is read, so it is
 * computed on the listing routes rather than written into task.json where it
 * would go stale the instant the head starts.
 */
function withQueuePositions(queue: TaskQueue, records: TaskRecord[]): TaskRecord[] {
  const entries = queue.list()
  if (entries.length === 0) {
    return records
  }
  const positions = new Map(entries.map((entry, index) => [entry.id, index + 1]))
  return records.map((record) => {
    const position = positions.get(record.id)
    return position === undefined ? record : { ...record, queue_position: position }
  })
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
  const notice = opts.onNotice ?? ((message: string) => console.warn(message))
  /**
   * Boot recovery of ONE repo, fenced. A repo whose queue file is read-only,
   * whose disk is full, or whose store is unreadable degrades ON ITS OWN: the
   * workspace still starts, the other projects are untouched, and the reason
   * is said out loud. Losing every project because one of them is broken is
   * the failure mode this exists to prevent.
   */
  const recover = (project: Project): number => {
    try {
      const outcome = reconcileTasks(project.path, project.id)
      if (outcome.degraded !== null) {
        notice(`${project.name}: ${outcome.degraded}`)
      }
      for (const line of outcome.notices) {
        notice(`${project.name}: ${line}`)
      }
      return outcome.queued
    } catch (err) {
      notice(
        `${project.name}: boot recovery failed (${err instanceof Error ? err.message : String(err)}); its tasks are left exactly as they are on disk`,
      )
      return 0
    }
  }

  /**
   * A queue.json found UNUSABLE outside the boot — a listing, a pump, any read
   * at all. This is a REPORTING sink and deliberately nothing more.
   *
   * It used to repair here, and that was wrong in a way worth writing down: it
   * is called from inside `read()`, so a mutation that provoked it (an
   * enqueue, a remove) rewrote the file with its own pre-repair list the
   * instant this returned — undoing a perfect repair and silently dropping
   * every task the bad bytes had hidden, under a notice claiming the opposite.
   * The reconstruction now happens in the queue's own read, in memory, and is
   * persisted by the next write; all that is left to do here is to make the
   * degradation impossible to miss:
   *
   *  - the reason lands in the JOURNAL of every task the REBUILT queue holds
   *    (the ids this sink is handed), where GET /api/tasks/:id serves it back;
   *  - and it is said out loud as a server notice.
   *
   * Both happen once per distinct reason, process-wide.
   */
  const reportQueueDegradation = (
    project: Project,
    reason: string,
    ids: readonly string[],
  ): void => {
    notice(`${project.name}: ${reason}`)
    for (const id of ids) {
      try {
        appendTaskEvent(project.path, id, { type: 'error', data: { message: reason } })
      } catch {
        // A journal that cannot be written must not take a listing down with
        // it; the notice above already carries the fact.
      }
    }
  }

  /** The read-time queue view of a project, wired to the report above. */
  const queueFor = (project: Project): TaskQueue =>
    queueOf(project, (reason, ids) => reportQueueDegradation(project, reason, ids))

  // A tasks/ directory that will not LIST is tolerated (it yields no records
  // rather than throwing) — and until this line it was tolerated in total
  // silence, which is the half of the bargain invariant 2 forbids: the whole
  // store of a project reads as empty, the board shows nothing, and nobody is
  // told. It is also the exact moment the queue loses its ability to name what
  // it could not place. No journal here on purpose: the ids are precisely what
  // the failure denied us.
  onStoreUnreadable((cwd, reason) => {
    const project = registered().find((candidate) => candidate.path === cwd)
    notice(project ? `${project.name}: ${reason}` : reason)
  })

  // Boot recovery across EVERY registered repo: the SSE replay (listAll) must
  // already show a dead process's tasks as 'interrupted', context or not.
  // Projects that still have a queue at the end of it are noted here — but
  // NOTHING starts yet: startPending() is the explicit step for that, and the
  // workspace calls it only once it can be talked to and stopped.
  const pendingAtBoot: { projectId: string; queued: number }[] = []
  for (const project of registered()) {
    const queued = recover(project)
    if (queued > 0) {
      pendingAtBoot.push({ projectId: project.id, queued })
    }
  }

  const listeners = new Set<(envelope: TaskEnvelope) => void>()
  const emit = (envelope: TaskEnvelope): void => {
    for (const listener of listeners) {
      try {
        listener(envelope)
      } catch (err) {
        // Subscribers are observers: one that throws (a broken SSE client, a
        // bug downstream) must not silence the others, and must never travel
        // back up into the runner that produced the frame. Contained is not
        // hidden, though — a listener dropping frames is a degradation, and
        // invariant 2 forbids the silent kind.
        notice(
          `a workspace subscriber threw on a ${envelope.event.name} frame and was skipped: ${errorMessage(err)}`,
        )
      }
    }
  }

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
    // The mirror of the guard abandon() gets below: an abandon in flight is
    // deleting this very worktree and will write the record when it lands.
    // Pushing from a directory being removed is at best a broken push, and
    // whichever of the two wrote last would erase the other's outcome.
    if (ctx.runner.isAbandoning(id)) {
      return { ok: false, code: 409, error: 'task is being abandoned' }
    }
    const record = loadTask(cwd, id)
    if (!record) {
      return { ok: false, code: 404, error: 'task not found' }
    }
    const refusal = shipRefusal(record)
    if (refusal) {
      return refusal
    }
    // This `record` crosses the push (network, slow) before saveTask below —
    // one of the four snapshot-across-an-await sites listed in task-runner.ts.
    // It stays valid by EXCLUSION: `ctx.shipping` is claimed here, before any
    // await, and reply/resume/abandon all consult it, so nothing else writes
    // this record while the push is in flight.
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
    // A project registered after boot may carry orphans from an older run —
    // and a queue.json a previous process left behind, which this rebuilds
    // BEFORE the runner exists, so the runner's first pump sees it. Fenced
    // like the boot pass: a broken repo degrades, it does not 404 itself out
    // of the workspace.
    recover(project)
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
    /** Rank last broadcast per waiting id, so only real changes go on the wire. */
    const lastRanks = new Map<string, number>()
    // The runner writes to the store first, then calls these hooks: a
    // subscriber reacting to an envelope always finds the disk state at least
    // as fresh.
    const runner = createRunner({
      cwd,
      command: opts.command,
      timeoutMs: opts.timeoutMs,
      ...(opts.watchdog ? { watchdog: opts.watchdog } : {}),
      projectId,
      onTurnDone,
      // A degradation of queue.json met OUTSIDE the boot pass: journaled on
      // the tasks the rebuilt queue holds, and said out loud. The rebuild
      // itself is the queue's own doing, and persisting it is the next
      // write's — never this hook's.
      onQueueDegraded: (reason, ids) => reportQueueDegradation(project, reason, ids),
      // A Ctrl-C that waits is a Ctrl-C that says what it waits for.
      onDrainWait: (ids) => notice(t('workspace.shutdownWaiting', { n: ids.length })),
      // It gave up waiting: the process exits either way, but never quietly.
      onDrainTimeout: (ids) => notice(t('workspace.shutdownGaveUp', { n: ids.length })),
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
      // The head of the line left (or someone joined it): everyone still
      // waiting moved a rank, and no other frame would ever say so. Their
      // records go back out decorated with a FRESH position, which is the only
      // way a card in third place learns it is now second.
      onQueueChanged: () => {
        // Bounded on both axes, because this fires on EVERY queue mutation:
        //  - only the ranks that actually MOVED are re-sent (joining the tail
        //    of a line of fifty used to re-broadcast all fifty and re-read
        //    fifty task.json files, for fifty unchanged numbers);
        //  - and never more than QUEUE_BROADCAST_MAX of them, so one mutation
        //    costs a bounded number of frames and disk reads whatever the
        //    queue's length. Past that depth the badge simply waits for the
        //    next GET /api/tasks, which decorates the whole listing exactly.
        const seen = new Set<string>()
        let sent = 0
        for (const [index, entry] of queueFor(project).list().entries()) {
          const rank = index + 1
          seen.add(entry.id)
          if (lastRanks.get(entry.id) === rank) {
            continue
          }
          lastRanks.set(entry.id, rank)
          if (sent >= QUEUE_BROADCAST_MAX) {
            continue
          }
          const record = loadTask(cwd, entry.id)
          if (record) {
            sent += 1
            emit({
              project_id: projectId,
              task_id: record.id,
              event: { name: 'task', data: { ...record, queue_position: rank } },
            })
          }
        }
        // Whoever left the line keeps no memory of a rank: the frame that says
        // it started (or stopped) already carries no queue_position.
        for (const id of lastRanks.keys()) {
          if (!seen.has(id)) {
            lastRanks.delete(id)
          }
        }
      },
    })
    const ctx: ProjectContext = { project, runner, shipping: new Set(), checking: new Set() }
    contexts.set(projectId, ctx)
    return ctx
  }

  return {
    startPending() {
      const resumed: PendingQueue[] = []
      for (const pending of pendingAtBoot.splice(0)) {
        // Fenced per project, like the boot pass: one repo that cannot build
        // its runner must not stop the others from resuming theirs.
        try {
          // Building the context builds the runner, whose first pump starts
          // the head of the line. Everything downstream of that point is the
          // ordinary lifecycle — and the server is already listening.
          const ctx = context(pending.projectId)
          if (ctx) {
            resumed.push({ project: ctx.project, queued: pending.queued })
          }
        } catch (err) {
          notice(
            `${pending.projectId}: its queued tasks could not be resumed (${err instanceof Error ? err.message : String(err)})`,
          )
        }
      }
      return resumed
    },

    list(projectId) {
      const project = registered().find((candidate) => candidate.id === projectId)
      return project ? withQueuePositions(queueFor(project), listTasks(project.path)) : null
    },

    listAll: () =>
      registered().map((project) => ({
        project,
        records: withQueuePositions(queueFor(project), listTasks(project.path)),
      })),

    get(projectId, id) {
      const project = registered().find((candidate) => candidate.id === projectId)
      if (!project) {
        return null
      }
      const record = loadTask(project.path, id)
      if (!record) {
        return null
      }
      const position = queueFor(project).position(id)
      return {
        record: position === null ? record : { ...record, queue_position: position },
        events: readTaskEvents(project.path, id),
      }
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
        // The refusal (a full queue, 503) left a record on disk sitting on
        // 'queued' that NOTHING will ever start: it is not in queue.json, no
        // pump will ever see it, and neither reply nor resume accepts a
        // 'queued' task. A card promising an agent that is not coming is worse
        // than no card, so the task is settled here and now — 'failed', with
        // the refusal's own words and code — where the human can read it and
        // Abandon it like any other dead task.
        const failure = loadTask(ctx.project.path, record.id) ?? record
        failure.status = 'failed'
        failure.reason = taskReason(started.reason_code ?? 'agent_error', started.error)
        failure.updated_at = new Date().toISOString()
        saveTask(ctx.project.path, failure)
        const event = appendTaskEvent(ctx.project.path, failure.id, {
          type: 'error',
          data: { message: started.error },
          ...(started.reason_code ? { reason_code: started.reason_code } : {}),
        })
        emit({ project_id: projectId, task_id: failure.id, event: { name: 'task', data: failure } })
        emit({
          project_id: projectId,
          task_id: failure.id,
          event: { name: 'task_event', data: event },
        })
        return started
      }
      // The caller learns right away whether it got the repo (no position) or
      // a place in the line, without waiting for a listing: the UI renders the
      // new card from this very body. Null once it is running — as everywhere,
      // absence means "not waiting".
      const position = queueFor(ctx.project).position(record.id)
      return {
        ok: true,
        record: position === null ? record : { ...record, queue_position: position },
      }
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
        return Promise.resolve(unknownProject)
      }
      // Removing a worktree waits for the repo lock, so this one is async
      // where its siblings are not: the refusals stay immediate values.
      return ctx.shipping.has(id)
        ? Promise.resolve({ ok: false, code: 409, error: 'ship in progress' })
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
