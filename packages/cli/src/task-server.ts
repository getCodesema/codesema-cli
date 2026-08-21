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
import { knownAgent, type AgentRunOptions, type WatchdogBudgets } from './agent.js'
import {
  createChecksSetupRunner,
  type ChecksSetupRunner,
  type ChecksSetupState,
} from './checks-setup.js'
import {
  resolveProjectAgentCommand,
  resolveProjectConfig,
  resolveWatchdogBudgets,
  type IsolationMode,
  type ProjectConfigFlags,
} from './config.js'
import {
  isActiveTaskStatus,
  TASK_TITLE_MAX,
  TASK_TURN_TEXT_MAX,
  type ReasonCode,
  type ReviewRecord,
  type TaskChecks,
  type TaskEvent,
  type TaskIsolation,
  type TaskIssueRef,
  type TaskIssueSnapshot,
  type TaskReason,
  type TaskRecord,
  type TaskStatus,
} from './contract.js'
import type { ForgeIssuesExecFn } from './forge-issues.js'
import { refExists, tryGit, tryGitAsync } from './git.js'
import { t } from './i18n.js'
import { createLoadCap, type LoadCap, type LoadCapSnapshot } from './load-cap.js'
import { listProjects, listProjectsDetailed, type Project } from './projects.js'
import { readChecksConfig } from './repo-config.js'
import { runChecks } from './task-checks.js'
import {
  agentHomeVolume,
  isolationDefaults,
  isolationDomainsFor,
  overlayIsolationProbe,
  releaseAgentHome,
  sweepOrphanedHomeVolumes,
  UNPROBED_ISOLATION,
  type HomeVolumeSweepOutcome,
  type IsolationProbe,
  type ReleaseAgentHomeResult,
} from './task-isolation.js'
import {
  admitIssue,
  issueBoundEvent,
  issueCoverageGapEvent,
  issueReconcileEvent,
  issueSnapshotUnreadableEvent,
  reconcileIssueSnapshot,
  validateIssueRef,
  type IssueReconcile,
} from './task-issue.js'
import { resolveTaskPlan, type TaskPlanDeps, type TaskPreviewResult } from './task-plan.js'
import { createTaskQueue, type TaskQueue } from './task-queue.js'
import {
  applyTaskRetention,
  DEFAULT_TASK_RETENTION,
  type TaskRetentionOutcome,
} from './task-retention.js'
import {
  applyChecksGate,
  createTaskReviewer,
  readTaskReview,
  terminalChecksResult,
  type CreateTaskReviewerOptions,
} from './task-review.js'
import {
  commandForTask,
  createTaskRunner,
  pendingResumeTurn,
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
  onStoreUnreadable,
  readTaskChecks,
  readTaskEvents,
  removeTaskChecks,
  saveTask,
  taskIdsOnDisk,
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
  | {
      project_id: string
      task_id: string
      event: {
        name: 'task_meta'
        data: {
          tokens: number
          /**
           * Occupation of the machine-wide load cap (T1.3, D4) at the instant
           * this frame was emitted — so the UI can render "waiting for a
           * machine slot" instead of an undifferentiated "waiting". OPTIONAL
           * and its honest default is ABSENCE (invariant § 0.3 n°1): a frame
           * this field predates (an ordinary token-meter tick) carries none,
           * and a client that does not know the field simply ignores it.
           */
          load_cap?: LoadCapSnapshot
          /**
           * Whether THIS frame reports "still waiting for a slot" (true) or
           * "just obtained one" (false) — adversarial review fix: two frames
           * carrying the identical `load_cap` snapshot are otherwise
           * byte-for-byte indistinguishable, and the whole point of shipping
           * `load_cap` was to let the UI say "waiting for a machine slot"
           * rather than a mute "waiting". Present only alongside `load_cap`.
           */
          waiting_for_slot?: boolean
        }
      }
    }
  /**
   * The task's whole checks.json after a transition — or `null`, which is
   * the ONLY way to say "there is no checks result any more" (T1.3 round 4,
   * MAJEUR 1: a 'running' snapshot written for a run that never started must
   * be taken BACK, and no `TaskChecks` value expresses "never ran" — the
   * absence of the file is that state). A client assigns the payload as-is;
   * `TaskState.checks` was already nullable for exactly the same reason.
   */
  | { project_id: string; task_id: string; event: { name: 'task_checks'; data: TaskChecks | null } }
  // PROJECT-scoped, hence no task_id: the checks setup agent proposes a
  // configuration for the whole repo, not for one conversation.
  | { project_id: string; event: { name: 'checks_proposal'; data: ChecksSetupState } }

/**
 * T2.4: the raw issue reference as it arrives from the wire — everything
 * `unknown` on purpose, since `validateIssueRef` (task-issue.ts) is the one
 * place that decides whether it names anything usable.
 */
export type CreateTaskManagerIssueInput = {
  forge: unknown
  project: unknown
  iid: unknown
  url: unknown
}

export type CreateTaskManagerInput = {
  /**
   * Required UNLESS `issue` is given: the ordinary path takes the title
   * verbatim from the caller. With `issue`, the issue's own title is used
   * instead and this is ignored — see D7/T2.4.
   */
  title?: string
  /** Required unless `issue` is given — see `title`. */
  prompt?: string
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
  /**
   * T2.4/D7: creates the task FROM this forge issue instead of a bare
   * title+prompt. When given, `title`/`prompt` above are ignored: the issue's
   * own title and (linted) body take their place, and the task's record
   * carries `issue` + `issue_snapshot`. Mutually exclusive in effect with the
   * title+prompt path, though nothing refuses both being present — `issue`
   * simply wins.
   */
  issue?: CreateTaskManagerIssueInput
  /**
   * Per-task agent CLI (id or full known command). Validated with
   * `resolveKnownAgentCommand`; unknown/custom is a 400. Absent: the
   * project's current runtime command is used and stored on the record.
   */
  agent?: string
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
  /**
   * Validates, persists and starts a new task in the project's repo. ASYNC
   * since T2.4: creating a task FROM an issue reads the issue off the forge
   * (T2.1) before anything is written — the ordinary title+prompt path never
   * awaits anything and settles on the very tick it is called, so its
   * observable ordering relative to sibling calls is unchanged.
   */
  /**
   * T2.6 dry-run (`POST /api/tasks/preview`): the plan a `create` with this
   * very input WOULD produce — branch, worktree location, base/target,
   * isolation and its reason, agent, rank in the line, ticket — and the
   * refusal it would give instead, verbatim.
   *
   * Writes NOTHING: no record, no journal line, no branch, no worktree, no
   * queue entry, no frozen `issue_snapshot`. Async for the same reason
   * `create` is: previewing from an issue reads that issue off the forge.
   *
   * The plan is INDICATIVE (design.md D-c). Reserving anything would itself be
   * a side effect, so the queue can move and a branch can appear between the
   * preview and the click; `create` decides again, and refuses in the same
   * words when it now must.
   */
  preview: (projectId: string, input: CreateTaskManagerInput) => Promise<TaskPreviewResult>
  create: (projectId: string, input: CreateTaskManagerInput) => Promise<TaskCreateResult>
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
   * Isolation facts for the UI. When `projectId` is given, overlaid with that
   * project's resolved mode and agent (T1.4); otherwise with the process-wide
   * fallback (global config + flags). Exposed on GET /api/projects.
   */
  workspaceInfo: (projectId?: string | null) => {
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
    /** Resolved agent command a NEW unspecified task of this project would run. */
    agent: string
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
   * Idempotent: a project already running is not restarted. Async (T2.4,
   * adversarial review): awaits the boot ticket-reconciliation pass first, so
   * a queued task's stale ticket is never pumped into a live agent turn
   * before anyone compared it to the forge.
   */
  startPending: () => Promise<PendingQueue[]>
  /**
   * T1.9. Removes every HOME volume (`codesema-home-<id>`) whose id no
   * record of NO registered project claims — the backstop for whatever a
   * ship/abandon release could not do in the moment (runtime unreachable,
   * daemon busy). Explicit step, same reason as startPending: called once
   * the workspace is up, never inside the constructor. NEVER through the
   * task journal (DP9) — reported entirely through the notice channel.
   * Never rejects; a sweep this pass could not even attempt (a project's
   * store unreadable, so the claimed-id inventory is incomplete) is a named
   * notice, not a wider sweep (Risk 1 of design.md).
   */
  sweepOrphanedVolumes: () => Promise<void>
  /**
   * T1.9. Purges terminated tasks past the retention window, project by
   * project (applyTaskRetention). Same explicit-step reasoning as
   * startPending/sweepOrphanedVolumes; never rejects.
   */
  applyRetention: () => Promise<void>
  /** Graceful exit: interrupts every active agent (all projects) and resolves once all turns persisted. */
  shutdown: () => Promise<void>
  subscribe: (listener: (envelope: TaskEnvelope) => void) => () => void
  /** Session-default agent command (fallback for projects without their own). */
  defaultCommand: () => string
  /**
   * Updates the in-memory session default used by `projectRuntime` for
   * projects that do not set `agent`. Does not rebuild existing runners.
   */
  setDefaultCommand: (command: string) => void
}

export type CreateTaskManagerOptions = {
  /**
   * Fallback agent command (T1.4): used when a project does not set `agent`
   * in its own config. Per-project resolution in `context()` overrides this.
   */
  command: string
  /**
   * Fallback last-resort turn ceiling, in ms (T1.4): used when a project
   * does not set `timeout`. Per-project resolution in `context()` overrides
   * this with that repo's (or the global) timeout.
   */
  timeoutMs: number
  /**
   * Process-wide CLI flags (T1.4). They win over both config files for every
   * registered project. Absent means "no flag", not "empty override".
   */
  flags?: ProjectConfigFlags | undefined
  /**
   * Repo paths whose "global-only key ignored" warnings were already printed
   * at boot (the launch repo). context() skips repeating them (T1.4 review).
   * Named for what it actually holds since `taskRetentionCount` joined the
   * stripped keys (T1.4 review A2) — it was never only about the load cap.
   */
  globalOnlyNoticeShown?: readonly string[] | undefined
  /**
   * Launch-repo path whose TOFU / custom-agent warnings were already printed
   * at boot. context() skips repeating them for that path (T1.4 review C/D).
   */
  launchRepoPath?: string | undefined
  /** Watchdog budgets (D3), read from the config by resolveWatchdogBudgets. */
  watchdog?: WatchdogBudgets | undefined
  /**
   * INERT since T1.2, and STILL inert after T1.3: the number of active tasks
   * follows from "one active task per project", not from a global budget.
   * Still accepted (and still fed by the deprecated `maxParallelTasks` config
   * key) so that key keeps a value to round-trip; the REAL machine-wide
   * budget is `maxConcurrentAgents` below.
   */
  maxParallel?: number
  /**
   * Machine-wide load cap (T1.3, D4): sizes the DEFAULT `loadCap` instance
   * (undefined applies DEFAULT_MAX_CONCURRENT_AGENTS). Ignored when `loadCap`
   * is injected directly — the workspace resolves this from config via
   * `resolveMaxConcurrentAgents` (workspace.ts).
   */
  maxConcurrentAgents?: number | undefined
  /**
   * Machine-wide load cap (T1.3, D4), injectable (§ 0.4): the default builds
   * ONE fresh `createLoadCap(maxConcurrentAgents)` shared by every project's
   * runner and by the review/checks call sites in this file. Tests inject a
   * tiny cap (or share one instance across two managers/runners) to exercise
   * cross-project contention without spawning real agents.
   */
  loadCap?: LoadCap
  /**
   * Aborted when the workspace is shutting down (workspace.ts's `draining`).
   * Threaded into the checks runner's own load-cap wait (adversarial review
   * fix): a checks run has no queue of its own like a turn does, and without
   * this its `acquire('checks')` could sit parked on a saturated cap for the
   * whole DRAIN_TIMEOUT_MS with nothing able to wake it — the same failure
   * mode the reviewer's `io.signal` fixes for reviews. OPTIONAL: a caller
   * that never wires it up keeps today's behavior (an unattended checks run
   * outlives the process either way; only the WAIT becomes interruptible
   * when this is given).
   *
   * T2.4 wires the SAME controller for a second, disjoint consumer: the boot
   * issue-reconciliation pass cancels its outstanding remote probes on it and
   * refuses to write a record once it has fired — a pass that finished
   * computing an outcome mid-shutdown must not persist it after the fact. One
   * field, one cable, two readers: an AbortSignal with N listeners is the
   * nominal case, and the two never overlap in time.
   */
  shutdownSignal?: AbortSignal
  /**
   * Result of the boot RUNTIME probe (workspace.ts, T1.4): whether a
   * container engine is reachable on this machine. Per-project isolation
   * mode and agent are overlaid at task creation (`overlayIsolationProbe`).
   * Absent means "nothing probed" — tasks are then created as 'policy',
   * which is what a plain server (tests, `codesema review`) honestly offers.
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
  /**
   * Test seam on the reviewer's CONSTRUCTION, not on its behaviour (T1.3
   * round 4, MAJEUR 3). `reviewTurnFn` above replaces the reviewer wholesale,
   * which is exactly why it could never prove what the DEFAULT one is built
   * with: dropping `loadCap` from the `createTaskReviewer({…})` call below
   * left the whole suite green, and that call is the ticket's central
   * requirement — without it the end-of-turn review goes back to running
   * OUTSIDE the machine-wide cap, the very state T1.3 exists to remove. This
   * seam lets a test capture the options the manager actually hands the
   * reviewer factory and assert the cap instance is among them.
   */
  createReviewerFn?: (options: CreateTaskReviewerOptions) => TaskTurnReviewFn
  /** Test seam: the default pushes to origin and drives the real gh/glab. */
  shipTaskFn?: typeof shipTask
  /** Test seam: the default reads the global registry (projects.ts). */
  listProjectsFn?: () => Project[]
  /** Test seam: the default runs real containers (task-checks.ts). */
  runChecksFn?: typeof runChecks
  /**
   * T1.9: HOME volume release at termination (ship, and — via the runner —
   * abandon). Test seam; the default drives the real IsolationExecFn seam.
   */
  releaseAgentHomeFn?: (opts: { taskId: string }) => Promise<ReleaseAgentHomeResult>
  /** T1.9: boot sweep of orphaned HOME volumes. Test seam; default drives the real runtime. */
  sweepOrphanedVolumesFn?: typeof sweepOrphanedHomeVolumes
  /** T1.9 review round 1: the default reads the global registry WITH its completeness flag. Test seam. */
  listProjectsDetailedFn?: typeof listProjectsDetailed
  /** T1.9: retention pass of one project. Test seam; default is the real applyTaskRetention. */
  applyTaskRetentionFn?: typeof applyTaskRetention
  /**
   * T1.9: how many of the most-recently-updated terminated tasks PER PROJECT
   * survive `applyRetention()` untouched. Absent means DEFAULT_TASK_RETENTION
   * — same "workspace-wide until T1.4" caveat as maxParallel above.
   */
  taskRetention?: number
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
  /**
   * T2.4 test seam: the forge issue client's own `execFn` (forge-issues.ts),
   * threaded through both issue admission and issue reconciliation. No test
   * of this module ever spawns gh/glab or touches the network — the default
   * drives the real CLI.
   */
  issueExecFn?: ForgeIssuesExecFn
  /**
   * Test seam: overrides the boot issue-reconciliation pass's wall-clock
   * deadline (default 45s, see `BOOT_ISSUE_RECONCILE_DEADLINE_MS`'s own
   * doc). Never meant for production config — the default is chosen once,
   * generously, for every workspace.
   */
  bootIssueReconcileDeadlineMs?: number
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
  /**
   * Agent command baked into `runner` at construction. Isolation at create()
   * uses the *task's* command (POST `agent`, else a fresh `projectRuntime`
   * snapshot). This fallback is what turns of a record without `agent` run.
   */
  command: string
}

/**
 * What `create` derives its title, prompt and (optional) ticket from, before
 * any of its OTHER guards (base/branch, isolation) run. Factored out of
 * `create` itself so the two origins — a bare title+prompt, or a forge issue
 * (T2.4) — read as two independent, individually testable decisions instead
 * of inflating one function's branching.
 */
type TaskOrigin =
  | {
      ok: true
      title: string
      prompt: string
      issue: TaskIssueRef | null
      issueSnapshot: TaskIssueSnapshot | null
      /** T2.4/DP13: true when the issue's raw body carries content the edit-detector cannot see. Always false off the title+prompt path. */
      coverageGap: boolean
    }
  | { ok: false; refusal: Extract<TaskCreateResult, { ok: false }> }

/** The ordinary path: title+prompt verbatim, no ticket. Synchronous — never touches the forge. */
function resolveTitlePromptOrigin(input: CreateTaskManagerInput): TaskOrigin {
  // Reject rather than truncate: a silently shortened title or prompt would
  // diverge from what the user thinks the agent was told.
  const title = (input.title ?? '').trim()
  if (!title) {
    return { ok: false, refusal: { ok: false, code: 400, error: 'empty title' } }
  }
  if (title.length > TASK_TITLE_MAX) {
    return {
      ok: false,
      refusal: { ok: false, code: 400, error: `title too long (max ${TASK_TITLE_MAX})` },
    }
  }
  const prompt = (input.prompt ?? '').trim()
  if (!prompt) {
    return { ok: false, refusal: { ok: false, code: 400, error: 'empty prompt' } }
  }
  if (prompt.length > TASK_TURN_TEXT_MAX) {
    return {
      ok: false,
      refusal: { ok: false, code: 400, error: `prompt too long (max ${TASK_TURN_TEXT_MAX})` },
    }
  }
  return { ok: true, title, prompt, issue: null, issueSnapshot: null, coverageGap: false }
}

/**
 * T2.4/D7: creates from a forge issue. Decision 5 of design.md's order — the
 * ONE network round trip admission makes, before any effect: validate the
 * reference's shape first (a malformed iid never reaches the forge), then
 * read the issue, then lint its body. A refusal at any step leaves nothing
 * behind, exactly like every guard in `create` that runs after this one.
 */
async function resolveIssueOrigin(
  cwd: string,
  raw: CreateTaskManagerIssueInput,
  execFn: ForgeIssuesExecFn | undefined,
): Promise<TaskOrigin> {
  const validated = validateIssueRef(raw)
  if (!validated.ok) {
    return { ok: false, refusal: { ok: false, code: 400, error: validated.error } }
  }
  const admitted = await admitIssue({ cwd, ref: validated.ref, ...(execFn ? { execFn } : {}) })
  if (!admitted.ok) {
    return {
      ok: false,
      refusal: {
        ok: false,
        code: admitted.code,
        error: admitted.error,
        ...(admitted.reason_code ? { reason_code: admitted.reason_code } : {}),
      },
    }
  }
  return {
    ok: true,
    title: admitted.title,
    prompt: admitted.prompt,
    issue: validated.ref,
    issueSnapshot: admitted.snapshot,
    coverageGap: admitted.coverage_gap,
  }
}

/**
 * Applies one `IssueReconcile` outcome to a record IN PLACE (status and/or
 * reason) and returns the journal event to append — `event: null` when
 * nothing is worth SAYING (`'unchanged'`'s own silence), independent of
 * `mutated`, which tells the caller whether the record itself changed and is
 * worth a `saveTask`/`persist`. Shared by both recomparison points (boot,
 * pre-review) so the status/journal doctrine can never diverge between them.
 * `'cosmetic'` journals a line but by itself touches nothing on the record
 * (DP13: no status change, no reason_code).
 *
 * DP14 (adversarial review, "a reason code must be erasable the moment the
 * task moves on, or it becomes a lie about the present"): a `forge_unreachable`
 * left by an EARLIER reconciliation is a claim about that past attempt, not
 * about now. The moment the forge answers again — any outcome but another
 * 'unreachable' proves exactly that — the stale reason is cleared, even on
 * 'unchanged', which otherwise stays silent: the silence is about the
 * JOURNAL, not about whether the record needed fixing.
 *
 * Round-2 adversarial review, majeur 1 (the POSE side of DP14, not just the
 * erasure side): `'unreachable'` used to overwrite `record.reason`
 * unconditionally, so a genuine, unrelated reason another mechanism had
 * already posed (an orphan `interrupted_by_user`, a queue's `resource_busy`,
 * a review's `checks_failed`…) was silently replaced by `forge_unreachable`
 * on the FIRST boot the forge happened to be unreachable — and then, on the
 * NEXT boot once the forge answered again, the erasure logic above cleared
 * what was BY THEN a `forge_unreachable` it had itself posed, destroying the
 * real reason for good. The fix: only ever POSE `forge_unreachable` onto an
 * ABSENT reason or one that already IS `forge_unreachable` (this attempt
 * refreshing the previous one's detail). Every other reason is left alone —
 * the event still carries `reason_code: 'forge_unreachable'` for THIS
 * attempt regardless, since that is a true statement about what just
 * happened; only the record's own persisted `reason` is protected.
 *
 * `midFlight` (round-2, majeur 4): a record that is `'interrupted'` with an
 * unfinished turn (`pendingResumeTurn(record) !== null`) is NOT a boundary —
 * its turn is still, in the only sense that matters to a human, "in
 * progress": Resume exists specifically to pick it back up. Moving such a
 * record to `'waiting_for_you'` on 'edited'/'not_ticket' would silently
 * destroy that affordance (`pendingResumeTurn` requires `status ===
 * 'interrupted'`) — the divergence is still journaled, but the status is
 * left exactly where Resume can still find it.
 */
function applyIssueReconcile(
  record: TaskRecord,
  outcome: IssueReconcile,
  opts: { midFlight?: boolean } = {},
): { event: AppendTaskEventInput | null; mutated: boolean } | null {
  const clearsStaleForgeReason =
    record.reason?.code === 'forge_unreachable' && outcome.kind !== 'unreachable'
  if (clearsStaleForgeReason) {
    delete record.reason
  }
  switch (outcome.kind) {
    case 'unchanged':
      return clearsStaleForgeReason ? { event: null, mutated: true } : null
    case 'cosmetic':
      return { event: issueReconcileEvent(outcome), mutated: clearsStaleForgeReason }
    case 'edited':
    case 'not_ticket': {
      const midFlight = opts.midFlight ?? false
      if (!midFlight) {
        record.status = 'waiting_for_you'
      }
      return { event: issueReconcileEvent(outcome), mutated: !midFlight || clearsStaleForgeReason }
    }
    case 'unreachable': {
      // Majeur 1: never overwrite a reason this attempt did not cause.
      const canPoseReason = !record.reason || record.reason.code === 'forge_unreachable'
      if (canPoseReason) {
        record.reason = outcome.reason
      }
      // DP15/DP9: 'issue', like every other outcome here — a forge this
      // session could not read is a fact about the bound TICKET, and the task
      // carries on unmodified. `error` would paint it red (the cry-wolf DP9
      // refuses) and, worse, would serve its English sentence verbatim into a
      // French journal. The `reason_code` below is unchanged: it rides the
      // event whatever its type.
      return { event: issueReconcileEvent(outcome), mutated: canPoseReason }
    }
  }
}

/**
 * At most this many forge round trips run at once across the WHOLE boot
 * pass (every project, every ticketed task combined) — a workspace with ten
 * registered repos and a dozen ticketed tasks each must not open a hundred
 * subprocesses on the same tick (adversarial review, majeur 3). Bounded
 * concurrency also bounds the wait `startPending` blocks on below: worst
 * case is `ceil(tasks / BOOT_ISSUE_RECONCILE_CONCURRENCY)` batches of
 * `FORGE_ISSUE_TIMEOUT_MS`, never one unbounded fan-out. Exported so a test
 * can assert the observed peak against the real cap rather than a copy of
 * the literal.
 */
export const BOOT_ISSUE_RECONCILE_CONCURRENCY = 6

/**
 * The hard wall-clock ceiling on the WHOLE boot reconciliation pass, in ms —
 * the published "45 s" of the CHANGELOG. See its use site below for WHY it is
 * a deadline rather than a budget derived from the ladder's cost. Exported so
 * a test can pin the shipped value: every other test overrides it through the
 * `bootIssueReconcileDeadlineMs` seam, so without this pin the wall could be
 * moved to infinity with every test still green.
 */
export const DEFAULT_BOOT_ISSUE_RECONCILE_DEADLINE_MS = 45_000

/**
 * Runs `worker` over `items`, at most `limit` of them in flight at once.
 * `Promise.allSettled`, not `Promise.all` (round-2 adversarial review,
 * mineur): `worker` is expected to swallow its own errors, but this
 * function's OWN guarantee — every item gets a chance to run — must not
 * depend on that discipline holding forever. `Promise.all` rejects on the
 * FIRST lane to throw while the others keep running unobserved: the
 * "reconciliation lands before the first pump" property this function backs
 * would then silently stop holding for whichever items were still in
 * flight, and an unhandled rejection would surface outside `workspace()`'s
 * own try/catch. `allSettled` never rejects: this function still resolves
 * once every lane is done, whatever any one of them did.
 */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  async function lane(): Promise<void> {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      if (item !== undefined) {
        await worker(item)
      }
    }
  }
  await Promise.allSettled(Array.from({ length: Math.min(limit, items.length) }, () => lane()))
}

export function createTaskManager(opts: CreateTaskManagerOptions): TaskManager {
  const registered = opts.listProjectsFn ?? listProjects
  const notice = opts.onNotice ?? ((message: string) => console.warn(message))
  /**
   * Machine-wide load cap (T1.3, D4): ONE instance for the whole manager,
   * shared by every project's runner AND by the review/checks call sites
   * below — the cap is explicitly cross-project, unlike the per-project
   * queue. Injectable (§ 0.4: tests share a tiny cap across several
   * projects); `maxConcurrentAgents` sizes the default instance.
   */
  const loadCap = opts.loadCap ?? createLoadCap(opts.maxConcurrentAgents)
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
  // T1.9: whether ANY project's tasks/ failed to list, at least once since
  // the flag was last cleared. sweepOrphanedVolumes() reads this right after
  // rebuilding its claimed-id inventory — Risk 1 of design.md: an inventory
  // this process could not read COMPLETELY must forbid the sweep rather than
  // let it run on a narrower list, which would declare another project's
  // still-live volumes orphaned.
  let storeReadFailed = false
  onStoreUnreadable((cwd, reason) => {
    storeReadFailed = true
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

  /**
   * Every task id claimed by a registered project, by DIRECTORY NAME only
   * (`taskIdsOnDisk`, never `listTasks`/`loadTask`): a `task.json` this
   * process cannot currently PARSE — truncated by a crash mid-write, a
   * transient EACCES, a torn read during a burst of open descriptors — still
   * names a directory that exists, and a claimed id must never depend on
   * that file being readable AT THIS INSTANT (T1.9 review round 1, Critique
   * 1). `taskIdsOnDisk`'s own doc comment says why, for the queue
   * reconciliation this borrows the rule from: "the set the queue must not
   * treat as gone".
   *
   * `complete` is false whenever EITHER the project registry itself could
   * not be read completely (`listProjectsDetailed`, an entry dropped or the
   * file unparsable) OR any registered project's tasks/ directory failed to
   * list (`storeReadFailed`, sticky) — either one narrows the inventory in
   * exactly the way Risk 1 (design.md) forbids: a project or a task this
   * process merely failed to SEE must never be read as "does not claim
   * anything".
   */
  const projectClaimedIds = (): {
    ids: ReadonlySet<string>
    complete: boolean
    projectCount: number
  } => {
    const listDetailed = opts.listProjectsDetailedFn ?? listProjectsDetailed
    const registry = listDetailed()
    const ids = new Set<string>()
    // T1.9 review round 3, CRITIQUE (ceinture): a REGISTERED project whose
    // path no longer resolves (renamed, unmounted, the repo moved) is not a
    // project that happens to have zero tasks — it is one this process
    // cannot currently read. `taskIdsOnDisk` on an unresolvable path already
    // degrades to [] (via `taskDirEntries`'s own ENOENT handling, harmless on
    // its own), but folding that silently into "claims nothing" is exactly
    // the narrowing Risk 1 (design.md) forbids: every HOME volume that
    // project's still-existing tasks claim would read as orphaned. A path
    // that will not resolve forbids the WHOLE sweep, same as an unparsable
    // registry or a tasks/ that will not list.
    let pathUnresolved = false
    for (const project of registry.projects) {
      if (!existsSync(project.path)) {
        pathUnresolved = true
        continue
      }
      for (const id of taskIdsOnDisk(project.path)) {
        ids.add(id)
      }
    }
    return {
      ids,
      complete: registry.complete && !storeReadFailed && !pathUnresolved,
      projectCount: registry.projects.length,
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
  /**
   * T2.4 round-4 adversarial review, majeur 3 — "never start a turn on a
   * ticketed task THIS SESSION has never compared to its forge".
   *
   * The boot pass below closes that door for every project registered when the
   * manager was built, because `startPending()` awaits it before its first
   * `context()` call. It leaves a SECOND door wide open: a project registered
   * mid-session (POST /api/projects, or a workspace that discovers a repo
   * later) reaches `context()` without ever having been reconciled, and
   * `context()` rebuilds its queue from `queue.json` BEFORE the runner exists,
   * whose very first `pump()` is synchronous — so a task queued by a previous
   * session, whose issue was edited since, starts a full agent turn on a stale
   * ticket, deterministically. That turn's work is then thrown away without a
   * review ('edited' skips it), which is worse than the delay it saves.
   *
   * The rule these three collections enforce: a project's QUEUED TICKETED
   * tasks are lifted out of `queue.json` until this session's reconciliation
   * pass for that project has run once, then put back AT THEIR ORIGINAL
   * RANKS. Non-ticketed tasks of the same project are never held — nothing
   * about them is stale.
   */
  /** Project paths whose reconciliation pass has completed in this session. */
  const issueReconciled = new Set<string>()
  /** Project paths a pass is already running (or about to run) for: never two. */
  const issueReconcileClaimed = new Set<string>()
  /**
   * Project path → the queue's FULL id order as it stood when its ticketed
   * tasks were lifted out. Full, not just the held ids: putting them back at
   * their rank needs to know what they were interleaved with.
   */
  const heldTicketedOrder = new Map<string, string[]>()

  const contexts = new Map<string, ProjectContext>()
  const globalOnlyNoticeShown = new Set(opts.globalOnlyNoticeShown ?? [])

  /**
   * Session-default agent command: the fallback `projectRuntime` uses for
   * projects that do not set `agent`. Mutated by `setDefaultCommand` so a
   * PUT /api/config/agent takes effect without a reboot.
   */
  let sessionCommand = opts.command

  /**
   * Fresh per-project snapshot (T1.4): isolation mode, timeout, allowlist and
   * the command a NEW task would run when it does not name its own agent.
   * Isolation at create() uses the *task's* command (POST `agent`, else this
   * snapshot) — a disk agent edit applies to unspecified new tasks.
   */
  const projectRuntime = (cwd: string) => {
    const { config, warnings } = resolveProjectConfig(cwd, opts.flags ?? {})
    const agent = resolveProjectAgentCommand(cwd, opts.flags ?? {}, sessionCommand)
    const pinned = config.isolationAllowedDomains
    return {
      command: agent.command,
      timeoutMs: config.timeout !== undefined ? config.timeout * 1000 : opts.timeoutMs,
      watchdog:
        config.watchdogInactivitySeconds !== undefined ||
        config.watchdogToolBudgetSeconds !== undefined ||
        config.watchdogHeartbeatSeconds !== undefined
          ? resolveWatchdogBudgets(config)
          : opts.watchdog,
      allowedDomains: pinned ?? isolationDomainsFor(agent.command),
      pinAllowedDomains: pinned !== undefined,
      isolationMode: config.isolation ?? probe.configured,
      warnings,
      agentWarning: agent.warning,
    }
  }

  /**
   * Everything `resolveTaskPlan` (T2.6) reads, for one project. Built here so
   * the real creation and the dry-run preview cannot be handed different
   * inputs — in particular the per-project runtime snapshot (T1.4), never the
   * launch repo's, and a queue view that only ever READS.
   */
  const planDeps = (project: Project): TaskPlanDeps => {
    const runtime = projectRuntime(project.path)
    return {
      cwd: project.path,
      runtime: { command: runtime.command, isolationMode: runtime.isolationMode },
      probe,
      tasks: () => listTasks(project.path),
      admission: () => queueFor(project).projectedAdmission(),
    }
  }

  const customAgentNoticeShown = new Set<string>()
  const noticeProjectConfig = (cwd: string, runtime: ReturnType<typeof projectRuntime>): void => {
    if (!globalOnlyNoticeShown.has(cwd)) {
      for (const warning of runtime.warnings) {
        notice(warning)
      }
      globalOnlyNoticeShown.add(cwd)
    }
    const bootAlreadySaid = opts.launchRepoPath !== undefined && cwd === opts.launchRepoPath
    if (runtime.agentWarning && !bootAlreadySaid) {
      notice(runtime.agentWarning)
    }
    if (knownAgent(runtime.command) === null && !customAgentNoticeShown.has(cwd)) {
      customAgentNoticeShown.add(cwd)
      if (!bootAlreadySaid) {
        notice(t('workspace.customAgentWarning', { command: runtime.command }))
      }
    }
  }

  // Project-scoped: proposing a checks configuration needs no runner, no store
  // and no worktree — only the repo path and THAT project's agent (T1.4).
  const checksSetup: ChecksSetupRunner = createChecksSetupRunner({
    command: sessionCommand,
    resolveCommand: (projectPath) =>
      resolveProjectAgentCommand(projectPath, opts.flags ?? {}, sessionCommand).command,
    ...(opts.runSetupAgentFn ? { runAgentFn: opts.runSetupAgentFn } : {}),
    onState: (projectId, state) =>
      emit({ project_id: projectId, event: { name: 'checks_proposal', data: state } }),
  })
  /** Registry lookup shared by the project-scoped routes (no lazy context needed). */
  const findProject = (projectId: string): Project | null =>
    registered().find((candidate) => candidate.id === projectId) ?? null

  /**
   * T1.9: releases a task's HOME volume once its ship has durably landed.
   * Same doctrine as the runner's own releaseTaskHome (task-runner.ts): the
   * IsolationExecFn seam, never a runtime binary named here, a NEUTRAL
   * 'resource' journal line (no D2 code — DP9/DP10), and never a reason to
   * turn ship's own ok:true into anything else.
   */
  const releaseShippedTaskHome = async (
    cwd: string,
    projectId: string,
    id: string,
  ): Promise<void> => {
    const release = opts.releaseAgentHomeFn ?? releaseAgentHome
    const outcome = await release({ taskId: id })
    const volume = agentHomeVolume(id)
    const input = outcome.released
      ? {
          type: 'resource' as const,
          data: { name: 'home_volume_released', message: `HOME volume ${volume} released` },
        }
      : outcome.reason === 'no-runtime'
        ? {
            type: 'resource' as const,
            data: {
              name: 'container_runtime_absent',
              message: `no container runtime detected — HOME volume ${volume} could not be released`,
            },
          }
        : {
            type: 'resource' as const,
            data: {
              name: 'home_volume_not_released',
              message: `HOME volume ${volume} could not be released: ${outcome.detail}`,
            },
          }
    const event = appendTaskEvent(cwd, id, input)
    emit({ project_id: projectId, task_id: id, event: { name: 'task_event', data: event } })
  }

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
    if (ctx.checking.has(id)) {
      return {
        ok: false,
        code: 409,
        error: 'checks are still running',
        reason_code: 'resource_busy',
      }
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
      // T1.9: nothing was ever created for a 'policy' task, so nothing is
      // attempted for one either — same gate as the runner's abandon path.
      if (record.isolation === 'container') {
        await releaseShippedTaskHome(cwd, projectId, id)
      }
      return { ok: true }
    } finally {
      ctx.shipping.delete(id)
    }
  }

  /**
   * Same wording as the runner's machine-cap wait (task-runner.ts
   * `MACHINE_LOAD_DETAIL`). Copied: T3.1 must not edit that file. The web
   * discriminates the two `resource_busy` motifs on this exact string.
   */
  const LOAD_CAP_WAIT_DETAIL =
    'the machine-wide load cap (maxConcurrentAgents) has no free slot for a turn, a review or a checks run'

  type PreparedChecks =
    { ok: false; result: TaskActionResult } | { ok: true; job: () => Promise<TaskChecks | null> }

  /**
   * Containerized checks (task-checks.ts) on the task's worktree. Guards run
   * synchronously (409 while in flight, 409 without a turn commit). The job
   * itself is BEST-EFFORT: every outcome — missing container runtime included
   * — lands in checks.json as a status. The HTTP POST stays fire-and-forget
   * (`startChecks` does not await the job); the end-of-turn path awaits it so
   * the reviewer can consume the result. The job never writes `review_ok` /
   * `review_ko` — that stays the reviewer's persist.
   */
  const prepareChecks = (ctx: ProjectContext, id: string): PreparedChecks => {
    const cwd = ctx.project.path
    const projectId = ctx.project.id
    if (ctx.checking.has(id)) {
      return { ok: false, result: { ok: false, code: 409, error: 'checks already running' } }
    }
    const record = loadTask(cwd, id)
    if (!record) {
      return { ok: false, result: { ok: false, code: 404, error: 'task not found' } }
    }
    // Checks verify COMMITTED work: a task whose turns never committed (or
    // whose worktree is gone) has nothing to run against.
    const hasCommit = readTaskEvents(cwd, id).some((event) => event.type === 'commit')
    if (!hasCommit || !record.worktree || !existsSync(record.worktree)) {
      return { ok: false, result: { ok: false, code: 409, error: 'task has no commit to check' } }
    }
    // Adversarial review round 3, MAJEUR 2: a shutdown that beat this call to
    // the start line is NOT a checks failure — no container was ever going to
    // run. The previous round threw into the generic catch below, which wrote
    // checks.json 'error' (a red line, in English, with a fabricated
    // 'started_at') for a run that never started. Settled the same way a
    // reviewer caught by the same race settles (task-review.ts's
    // `settleInterrupted`): one 'interrupted' journal line, no checks.json
    // write at all — never broadcast 'running' for work about to be abandoned.
    if (opts.shutdownSignal?.aborted) {
      const event = appendTaskEvent(cwd, id, {
        type: 'interrupted',
        data: { reason: 'shutdown' },
        reason_code: 'interrupted_by_user',
      })
      emit({ project_id: projectId, task_id: id, event: { name: 'task_event', data: event } })
      return { ok: true, job: () => Promise.resolve(null) }
    }
    const headSha = tryGit(['rev-parse', 'HEAD'], record.worktree) ?? ''
    ctx.checking.add(id)
    const broadcast = (snapshot: TaskChecks): void => {
      // writeTaskChecks sanitizes and returns the persisted copy: SSE
      // subscribers always see exactly what a later GET will read.
      const clean = writeTaskChecks(cwd, id, snapshot)
      emit({ project_id: projectId, task_id: id, event: { name: 'task_checks', data: clean } })
    }
    // Whatever checks.json said BEFORE this call overwrote it with 'running'
    // — null on a task that never ran any (T1.3 round 4, MAJEUR 1). Captured
    // here, one line above the overwrite, because the run may still turn out
    // never to start (the load-cap wait below can be abandoned by a
    // shutdown), and a 'running' left behind is not a cosmetic residue: the
    // UI derives `checksRunning` from it, `canRunChecks` from that, and the
    // "Re-run checks" button's `:disabled` from that — so the conversation
    // would keep a permanently greyed button, across restarts, for a run
    // nothing is doing. The round-3 note calling this "sans conséquence
    // visible" was wrong.
    const checksBefore = readTaskChecks(cwd, id)
    /**
     * Puts checks.json back exactly where `checksBefore` found it and says so
     * on the stream. `null` means there was no file: it is DELETED rather
     * than overwritten, because no TaskChecks value can mean "never ran" —
     * and the frame carries that same null, the wire's only way to say it.
     */
    const undoRunning = (): void => {
      if (checksBefore) {
        broadcast(checksBefore)
        return
      }
      removeTaskChecks(cwd, id)
      emit({ project_id: projectId, task_id: id, event: { name: 'task_checks', data: null } })
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
    const job = async (): Promise<TaskChecks | null> => {
      try {
        let final: TaskChecks
        // T1.3 (D4): a checks run is a heavy consumer of the machine load
        // cap like a turn or a review — acquired tightly around the actual
        // call, released whether it resolves or "fails" (runChecks never
        // REJECTS by contract, but the catch below is the belt to this
        // module's braces). `opts.shutdownSignal` makes the WAIT itself
        // interruptible (adversarial review fix): a checks run has no
        // project queue of its own, so without it a parked acquire() had no
        // way to be woken by a shutdown at all.
        //
        // T3.1: a saturated cap is SAID (journal + API), never a silent hang
        // and never confused with a checks `error`. The slot is released in
        // `finally` on EVERY path — passed/failed/error/unconfigured, and
        // the shutdown-abandoned wait — BEFORE the reviewer asks for its own.
        const capSnap = loadCap.snapshot()
        if (capSnap.occupied >= capSnap.max) {
          const waiting = appendTaskEvent(cwd, id, {
            type: 'queue',
            data: { name: 'machine_busy', message: LOAD_CAP_WAIT_DETAIL },
            reason_code: 'resource_busy',
          })
          emit({
            project_id: projectId,
            task_id: id,
            event: { name: 'task_event', data: waiting },
          })
        }
        const release = await loadCap.acquire('checks', opts.shutdownSignal)
        try {
          if (opts.shutdownSignal?.aborted) {
            // The wait was abandoned, not granted (a no-op Release): the run
            // itself never started. Adversarial review round 3, MAJEUR 2:
            // this used to throw into the catch below, which wrote
            // checks.json 'error' — a red line for a run nothing broke. No
            // fabricated verdict is written here either; instead the
            // 'running' this call broadcast before the wait is UNDONE (round
            // 4, MAJEUR 1), because leaving it would outlive the process and
            // disable the UI's re-run button for good. The journal gets the
            // same 'interrupted' line the entry guard above emits, never
            // 'checks'/'error'.
            undoRunning()
            const event = appendTaskEvent(cwd, id, {
              type: 'interrupted',
              data: { reason: 'shutdown' },
              reason_code: 'interrupted_by_user',
            })
            emit({ project_id: projectId, task_id: id, event: { name: 'task_event', data: event } })
            return null
          }
          final = await run({
            worktree: record.worktree,
            config: readChecksConfig(cwd),
            projectId,
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
        } finally {
          release()
        }
        const clean = writeTaskChecks(cwd, id, final)
        emit({ project_id: projectId, task_id: id, event: { name: 'task_checks', data: clean } })
        const passed = clean.checks.filter((c) => c.status === 'passed').length
        const failed = clean.checks.filter(
          (c) => c.status === 'failed' || c.status === 'timeout',
        ).length
        const blocking =
          clean.status === 'failed' || clean.checks.some((c) => c.status === 'timeout')
        const event = appendTaskEvent(cwd, id, {
          type: 'checks',
          data: {
            status: clean.status,
            passed,
            failed,
            ...(clean.error ? { error: clean.error } : {}),
          },
          ...(blocking ? { reason_code: 'checks_failed' as const } : {}),
        })
        emit({ project_id: projectId, task_id: id, event: { name: 'task_event', data: event } })
        return clean
      } catch {
        // Even persistence trouble stays best-effort: the task never breaks
        // because its checks could not be recorded.
        return null
      } finally {
        ctx.checking.delete(id)
      }
    }
    return { ok: true, job }
  }

  /**
   * Manual POST /api/tasks/:id/checks: 202 fire-and-forget for the HTTP
   * caller. The job is the same one the end-of-turn path awaits.
   */
  const startChecks = (ctx: ProjectContext, id: string): TaskActionResult => {
    const prepared = prepareChecks(ctx, id)
    if (!prepared.ok) {
      return prepared.result
    }
    void prepared.job()
    return { ok: true }
  }

  /**
   * Auto-trigger after a turn COMMIT: awaited from onTurnDone so the reviewer
   * can consume the result. Only when this very turn committed (the runner
   * appends its 'commit' event right before calling onTurnDone) — a no-change
   * turn re-checks nothing and does not delay the decision. A synchronous
   * 409 (run already in flight, no commit) returns null immediately so the
   * end of turn still completes.
   */
  const startChecksAfterCommit = async (
    ctx: ProjectContext,
    record: TaskRecord,
  ): Promise<TaskChecks | null> => {
    try {
      const commits = readTaskEvents(ctx.project.path, record.id).filter(
        (event) => event.type === 'commit',
      )
      if (commits.at(-1)?.data.turn !== record.turns.length) {
        return null
      }
      const prepared = prepareChecks(ctx, record.id)
      if (!prepared.ok) {
        return null
      }
      return await prepared.job()
    } catch {
      return null
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
    // ...and THAT is exactly why the hold below sits here, between the queue's
    // rebuild and the runner's construction (whose first pump is synchronous):
    // majeur 3 of the round-4 review. A project this session has never
    // reconciled hands its runner a queue with no ticketed task in it.
    const gated = !issueReconciled.has(project.path)
    if (gated) {
      holdTicketedTasks(project)
    }
    const cwd = project.path
    const runtime = projectRuntime(cwd)
    noticeProjectConfig(cwd, runtime)
    const { command, timeoutMs, watchdog, allowedDomains, pinAllowedDomains } = runtime
    // T4: every done turn flows through the automatic review before the human
    // sees a verdict. The reviewer is built with the project's command as a
    // fallback; resolveCommand picks the task's own CLI (`record.agent`) so
    // an opencode task in a claude project is reviewed by OpenCode.
    // `loadCap` is NOT optional garnish here: it is what makes the end-of-turn
    // review a citizen of the machine-wide budget (T1.3, D4) instead of a
    // fourth heavy process running beside it. Round 4, MAJEUR 3: dropping it
    // used to be invisible — `createReviewerFn` above exists so a test sees
    // this exact argument list.
    const reviewTurn =
      opts.reviewTurnFn ??
      (opts.createReviewerFn ?? createTaskReviewer)({
        cwd,
        command,
        resolveCommand: (record) => commandForTask(record, command),
        timeoutMs,
        loadCap,
      })
    // T5: auto-ship chains on the review verdict, INSIDE the onTurnDone hook
    // so it only ever fires after the reviewer's final transition. Green
    // reviews only — an assumed-KO ship is always a human click. ship() never
    // rejects, so a failed auto-push cannot trip the runner's review_ko
    // fallback. `ctx` is assigned right below, before any turn can end.
    const onTurnDone: TaskTurnReviewFn = async (record, io) => {
      // T3.1: wait for THIS turn's checks (if it committed) BEFORE the
      // review. The checks slot is acquired and released inside the job, so
      // it is never held while the reviewer asks for its own — the T1.3
      // deadlock the design forbids. A 409 (already running / no commit)
      // returns null immediately and does not stall the turn.
      const thisTurnChecks = await startChecksAfterCommit(ctx, record)
      const gateChecks =
        terminalChecksResult(thisTurnChecks) ?? terminalChecksResult(readTaskChecks(cwd, record.id))
      // The persist the reviewer (or a test stub) calls is THE unique write
      // of the final status: the gate mutates the in-memory record first, so
      // a settle OK never lands on disk only to be overwritten.
      const gatedIo = {
        ...io,
        persist: () => {
          applyChecksGate(record, gateChecks)
          io.persist()
        },
      }
      // T2.4/D7, second of the two recomparison points: BEFORE the turn's
      // review, never mid-turn. An edit moves the task straight to
      // 'waiting_for_you' and skips the review outright — the turn that just
      // finished is not re-judged against criteria that may no longer be
      // current, and no turn is ever restarted from here. A forge that cannot
      // be reached is the opposite: the task keeps going on its snapshot, so
      // the review below still runs.
      if (record.issue && record.issue_snapshot) {
        const reconciled = await reconcileIssueSnapshot({
          cwd,
          issue: record.issue,
          snapshot: record.issue_snapshot,
          ...(opts.issueExecFn ? { execFn: opts.issueExecFn } : {}),
        })
        const applied = applyIssueReconcile(record, reconciled)
        if (applied) {
          if (applied.event) {
            io.emit(applied.event)
          }
          if (applied.mutated) {
            io.persist()
          }
        }
        // 'edited' and 'not_ticket' both need a human, and the turn that just
        // finished is not re-judged by a review that may compare it against
        // criteria that are no longer current: skip the review outright,
        // never restart it. 'cosmetic' and 'unreachable' fall through — the
        // task continues on its snapshot exactly as before.
        if (reconciled.kind === 'edited' || reconciled.kind === 'not_ticket') {
          applyChecksGate(record, gateChecks)
          io.persist()
          return
        }
      }
      await reviewTurn(record, gatedIo)
      // Stubs that set status without persist, and the no-review path, still
      // fold the gate in: idempotent if the wrapped persist already did.
      applyChecksGate(record, gateChecks)
      io.persist()
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
      command,
      timeoutMs,
      ...(watchdog ? { watchdog } : {}),
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
      // Cage inputs, re-read from the project's own config at each turn so a
      // checks-apply is picked up without restarting the workspace (T1.4).
      getChecksConfig: () => readChecksConfig(cwd),
      ...(allowedDomains ? { allowedDomains } : {}),
      ...(pinAllowedDomains ? { pinAllowedDomains } : {}),
      ...(opts.runAgentFn ? { runAgentFn: opts.runAgentFn } : {}),
      ...(opts.releaseAgentHomeFn ? { releaseAgentHomeFn: opts.releaseAgentHomeFn } : {}),
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
      // Machine-wide load cap (T1.3, D4): ONE instance shared by every
      // project's runner and by the review/checks call sites below.
      loadCap,
      // A turn's admission just entered — or left — a wait on the machine
      // cap. `tokens: 0` is literally true here (no turn has produced any
      // yet), not a filler: this frame's news is `load_cap` PLUS
      // `waiting_for_slot`, which is what actually tells the two transitions
      // apart (adversarial review fix: the snapshot alone is byte-identical
      // on both).
      onLoadCapWait: (taskId, snapshot, waiting) =>
        emit({
          project_id: projectId,
          task_id: taskId,
          event: {
            name: 'task_meta',
            data: { tokens: 0, load_cap: snapshot, waiting_for_slot: waiting },
          },
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
    const ctx: ProjectContext = {
      project,
      runner,
      shipping: new Set(),
      checking: new Set(),
      command,
    }
    contexts.set(projectId, ctx)
    // A project the boot pass never enumerated gets its OWN pass now, on the
    // same code path, and its held tasks back when it lands. `claimed` (set
    // synchronously for every boot project before the boot pass's first
    // `await`) is what keeps this from running a second, concurrent pass over
    // a project the boot is already handling — that one's own `finally`
    // releases the hold.
    if (gated && !issueReconcileClaimed.has(project.path)) {
      issueReconcileClaimed.add(project.path)
      void reconcileIssuesFor([project])
        .catch((err) => {
          notice(`${project.name}: issue reconciliation failed unexpectedly (${errorMessage(err)})`)
        })
        .finally(() => releaseTicketedTasks(project))
    }
    return ctx
  }

  /**
   * Lifts this project's QUEUED TICKETED tasks out of `queue.json` and
   * remembers the order they were lifted from, so `releaseTicketedTasks` can
   * put them back where they were. Says it out loud (invariant 2): a queue
   * that visibly stops advancing without a word reads as broken.
   *
   * Deliberately NOT a status change: the tasks stay `queued`, which is what
   * they are — they are waiting, and this is one more thing they wait for.
   * Their record is untouched, so nothing here can be persisted wrong or
   * survive the process.
   */
  function holdTicketedTasks(project: Project): void {
    let order: string[]
    try {
      order = queueFor(project)
        .list()
        .map((entry) => entry.id)
    } catch {
      // A queue that will not even list is already degraded and already
      // reported by its own sink; there is nothing to hold.
      return
    }
    const ticketed = order.filter((id) => {
      const record = loadTask(project.path, id)
      return record?.status === 'queued' && record.issue !== undefined
    })
    if (ticketed.length === 0) {
      return
    }
    try {
      queueFor(project).removeMany(ticketed)
    } catch (err) {
      // Refusing to hold is the honest degradation: better a stale-ticket turn
      // that is NAMED than a queue this could not rewrite and pretended it had.
      notice(
        `${project.name}: its queued ticketed tasks could not be held out of the queue while this session compares them to the forge (${errorMessage(err)}); they may start on a snapshot nobody re-read`,
      )
      return
    }
    heldTicketedOrder.set(project.path, order)
    notice(
      `${project.name}: ${ticketed.length} queued ticketed task${ticketed.length === 1 ? '' : 's'} held out of the queue until this session has compared ${ticketed.length === 1 ? 'it' : 'them'} to its forge — no agent turn starts on a ticket this session never re-read`,
    )
  }

  /**
   * Marks the project reconciled for this session and puts back whatever
   * `holdTicketedTasks` lifted — AT ITS ORIGINAL RANK, which is why the whole
   * pre-hold order is what gets remembered: re-enqueueing only the held ids
   * would append them behind tasks they were ahead of.
   *
   * The rebuild is a remove-all + enqueue-in-order, with the LAST id handed to
   * `runner.start()` instead of the queue. That is not a flourish: `start()`
   * is the only public gesture that both enqueues (at the tail — exactly the
   * place this rebuild left free) AND pumps, and without a pump the tasks just
   * put back would sit there until some unrelated human gesture happened by.
   */
  function releaseTicketedTasks(project: Project): void {
    issueReconciled.add(project.path)
    const order = heldTicketedOrder.get(project.path)
    if (!order) {
      return
    }
    heldTicketedOrder.delete(project.path)
    const queue = queueFor(project)
    let current: string[]
    try {
      current = queue.list().map((entry) => entry.id)
    } catch {
      return
    }
    const merged = [...order, ...current.filter((id) => !order.includes(id))]
    const wanted = merged.filter(
      (id, index) =>
        merged.indexOf(id) === index && loadTask(project.path, id)?.status === 'queued',
    )
    try {
      queue.removeMany(current)
      for (const id of wanted.slice(0, -1)) {
        queue.enqueue(id)
      }
    } catch (err) {
      notice(
        `${project.name}: its held ticketed tasks could not be put back in the queue (${errorMessage(err)}); a Start on them still works`,
      )
      return
    }
    const last = wanted.at(-1)
    if (last === undefined) {
      return
    }
    const record = loadTask(project.path, last)
    const runner = contexts.get(project.id)?.runner
    if (record && runner) {
      runner.start(record)
      return
    }
    try {
      queue.enqueue(last)
    } catch (err) {
      notice(
        `${project.name}: task ${last} could not be put back in the queue (${errorMessage(err)}); a Start on it still works`,
      )
    }
  }

  /**
   * Applies a synthesized 'unreachable' outcome to one target — the shared
   * exit for every degradation path below (no remote, deadline exceeded, an
   * aborted shutdown), so all three read the record the SAME way as a real
   * `reconcileIssueSnapshot` timeout would: `applyIssueReconcile`, the reload
   * guard, the queue removal rule, the two broadcasts. Returns quietly if the
   * shutdown signal has fired since — nothing is written after the process
   * has started draining.
   */
  function applyUnreachableAt(project: Project, record: TaskRecord, reason: TaskReason): void {
    if (opts.shutdownSignal?.aborted) {
      return
    }
    const fresh = loadTask(project.path, record.id)
    if (
      !fresh ||
      !isActiveTaskStatus(fresh.status) ||
      fresh.status === 'running' ||
      fresh.status === 'reviewing'
    ) {
      return
    }
    const midFlight = fresh.status === 'interrupted' && pendingResumeTurn(fresh) !== null
    const applied = applyIssueReconcile(fresh, { kind: 'unreachable', reason }, { midFlight })
    if (!applied) {
      return
    }
    if (applied.mutated) {
      fresh.updated_at = new Date().toISOString()
      saveTask(project.path, fresh)
    }
    if (applied.event) {
      const appended = appendTaskEvent(project.path, fresh.id, applied.event)
      emit({
        project_id: project.id,
        task_id: fresh.id,
        event: { name: 'task_event', data: appended },
      })
    }
    if (applied.mutated) {
      emit({ project_id: project.id, task_id: fresh.id, event: { name: 'task', data: fresh } })
    }
  }

  /**
   * Hard wall-clock ceiling on the WHOLE boot reconciliation pass (round-2
   * adversarial review, majeur 5). The doc this replaced claimed
   * `ceil(tasks / BOOT_ISSUE_RECONCILE_CONCURRENCY)` batches of
   * `FORGE_ISSUE_TIMEOUT_MS` — wrong on a self-hosted remote, where the read
   * ladder tries `gh` THEN `glab` on any error, doubling the per-task cost to
   * up to `2 × FORGE_ISSUE_TIMEOUT_MS`. Rather than chase that number through
   * every future change to the ladder, this is a DEADLINE, not a budget
   * derived from one: every task's own reconciliation races it individually
   * and degrades to `forge_unreachable` — never blocking the pump longer
   * than this, whatever the ladder costs on any one call.
   *
   * The DEFAULT lives at module scope, exported, for the same reason
   * `BOOT_ISSUE_RECONCILE_CONCURRENCY` does: every test overrides it through
   * the `bootIssueReconcileDeadlineMs` seam, so nothing else would notice a
   * refactor pushing the wall to infinity while the CHANGELOG keeps
   * publishing "45 s".
   */
  const BOOT_ISSUE_RECONCILE_DEADLINE_MS =
    opts.bootIssueReconcileDeadlineMs ?? DEFAULT_BOOT_ISSUE_RECONCILE_DEADLINE_MS

  /**
   * Says, once per boot pass, that a task naming a forge issue has no readable
   * frozen snapshot to compare against — a journal line on the task itself and
   * a workspace notice (invariant 2's two reachable legs; the third, the API,
   * is the journal the task detail route already serves back).
   *
   * No `reason_code` and no status change, on purpose: DP10 keeps the D2 table
   * at ten codes until T3.6, and DP14's first condition fails outright —
   * nothing is stopped or refused here. The task runs exactly as it would have;
   * what retired is the EDIT DETECTOR, and that is what the line says.
   */
  function reportSnapshotUnreadable(project: Project, record: TaskRecord): void {
    if (opts.shutdownSignal?.aborted) {
      return
    }
    notice(
      `${project.name}: task ${record.id} names a forge issue but its frozen ticket snapshot could not be read back — it is excluded from edit detection until it is re-bound`,
    )
    try {
      const appended = appendTaskEvent(project.path, record.id, issueSnapshotUnreadableEvent())
      emit({
        project_id: project.id,
        task_id: record.id,
        event: { name: 'task_event', data: appended },
      })
    } catch {
      // A journal that will not take the line must not take the boot pass down
      // with it: the notice above already carries the fact.
    }
  }

  /**
   * T2.4/D7, first of the two recomparison points: for every non-terminal task
   * carrying an `issue` in the GIVEN projects. Called with every registered
   * project at boot, and with a single project by `context()` when that
   * project was registered after the boot pass had already enumerated its
   * targets (round-4 review, majeur 3).
   *
   * Deliberately NOT folded into the synchronous `recover`/`reconcileTasks`
   * pass above: that pass runs for EVERY registered project before this
   * function even returns, and folding a network round trip into IT would
   * make every other kind of boot recovery (worktree checks, queue repair)
   * wait on the forge too. This pass is its own, concurrency-bounded fan-out
   * instead, and — CRITICAL, per adversarial review — the caller MUST await
   * the returned promise before anything is allowed to start: `startPending`
   * below does exactly that, before its first `context()` call, because that
   * call's first `pump()` is synchronous and would otherwise always win the
   * race against this async pass's very first `await` (a queued task's
   * stale-ticket edit would then start a full agent turn before anyone ever
   * compared hashes — not a narrow race, a deterministic one). The workspace
   * still answers SSE/GET before this resolves; only the PUMP is gated.
   *
   * Round-2 adversarial review, majeur 5, three more fixes:
   *
   * 1. `git remote get-url origin` used to be resolved SYNCHRONOUSLY, once
   *    per TASK, twice over (`forge-issues.ts`'s own ladder calls it, and so
   *    does `detectForgeHint` inside it) — a sync `execFileSync` blocks the
   *    WHOLE process, so `BOOT_ISSUE_RECONCILE_CONCURRENCY` "lanes" were
   *    largely serializing back into a straight line through that call
   *    alone, and a repo whose working tree sits on a dead network mount
   *    could freeze the process outright. It is now resolved ONCE per
   *    PROJECT, asynchronously (`tryGitAsync`, itself bounded by
   *    `PROBE_TIMEOUT_MS` and never blocking the event loop) — a project
   *    with no readable remote skips the forge entirely for every one of its
   *    ticketed tasks, at once, rather than paying for that discovery once
   *    per task. This does not reach INTO `forge-issues.ts`'s own per-task
   *    calls for a project that DOES have a remote (out of scope: that
   *    module is merged and this pass does not touch its internals) — a
   *    documented residual, now individually bounded by the deadline above
   *    rather than by nothing.
   * 2. A console notice is printed before the wait, and again if the
   *    deadline was hit: a workspace that stays silent while queued tasks
   *    visibly do not start reads as broken, not busy.
   * 3. `opts.shutdownSignal` (the SAME controller `workspace.ts` aborts on
   *    the first Ctrl-C) cancels the async remote probes and gates every
   *    write: a boot pass that only finishes computing after the process
   *    has started draining must not persist anything.
   */
  async function reconcileIssuesFor(projects: readonly Project[]): Promise<void> {
    const targets: { project: Project; record: TaskRecord }[] = []
    const projectsSeen = new Map<string, Project>()
    const unreadable: { project: Project; record: TaskRecord }[] = []
    for (const project of projects) {
      for (const record of listTasks(project.path)) {
        if (!record.issue || !isActiveTaskStatus(record.status)) {
          continue
        }
        if (!record.issue_snapshot) {
          // Round-4 adversarial review, majeur 2: `issue` WITHOUT
          // `issue_snapshot` is not "no ticket" — it is a ticket whose frozen
          // snapshot the sanitizer threw away (a `body_hash` tagged for a
          // scheme this build no longer produces, a malformed record). Both
          // recomparison points guard on `!record.issue_snapshot`, so such a
          // task is excluded from edit detection FOREVER, and the first
          // rewrite of its record erases the snapshot from disk — silently,
          // while `TaskRecord.issue` keeps claiming the task carries a ticket.
          // Invariant 2 forbids exactly that silence.
          unreadable.push({ project, record })
          continue
        }
        targets.push({ project, record })
        projectsSeen.set(project.path, project)
      }
    }
    for (const target of unreadable) {
      reportSnapshotUnreadable(target.project, target.record)
    }
    if (targets.length === 0) {
      return
    }
    notice(
      `reconciling ${targets.length} ticketed task${targets.length === 1 ? '' : 's'} against their forge issue${targets.length === 1 ? '' : 's'} before resuming the queue…`,
    )

    // Once per PROJECT, asynchronously, never blocking the event loop.
    const remoteByProject = new Map<string, boolean>()
    await Promise.allSettled(
      [...projectsSeen.values()].map(async (project) => {
        const remote = await tryGitAsync(
          ['remote', 'get-url', 'origin'],
          project.path,
          opts.shutdownSignal,
        )
        remoteByProject.set(project.path, remote !== null)
      }),
    )

    const deadlineAt = Date.now() + BOOT_ISSUE_RECONCILE_DEADLINE_MS
    let deadlineHit = false
    const runnable: typeof targets = []
    for (const target of targets) {
      if (remoteByProject.get(target.project.path) === false) {
        applyUnreachableAt(
          target.project,
          target.record,
          taskReason('forge_unreachable', 'no-remote'),
        )
        continue
      }
      runnable.push(target)
    }

    await runWithConcurrency(
      runnable,
      BOOT_ISSUE_RECONCILE_CONCURRENCY,
      async ({ project, record }) => {
        const issue = record.issue
        const snapshot = record.issue_snapshot
        if (!issue || !snapshot) {
          return
        }
        if (opts.shutdownSignal?.aborted) {
          return
        }
        try {
          const remaining = deadlineAt - Date.now()
          if (remaining <= 0) {
            deadlineHit = true
            applyUnreachableAt(
              project,
              record,
              taskReason(
                'forge_unreachable',
                `boot reconciliation deadline (${BOOT_ISSUE_RECONCILE_DEADLINE_MS / 1000}s) exceeded`,
              ),
            )
            return
          }
          const outcome = await Promise.race([
            reconcileIssueSnapshot({
              cwd: project.path,
              issue,
              snapshot,
              ...(opts.issueExecFn ? { execFn: opts.issueExecFn } : {}),
            }),
            new Promise<IssueReconcile>((resolve) => {
              const timer = setTimeout(() => {
                deadlineHit = true
                resolve({
                  kind: 'unreachable',
                  reason: taskReason(
                    'forge_unreachable',
                    `boot reconciliation deadline (${BOOT_ISSUE_RECONCILE_DEADLINE_MS / 1000}s) exceeded`,
                  ),
                })
              }, remaining)
              timer.unref?.()
            }),
          ])
          if (opts.shutdownSignal?.aborted) {
            return
          }
          // Reload: the closed-over record can be stale by the time the forge
          // answers (many ticketed tasks, a slow forge) — a task that shipped
          // or failed in the meantime must not be reopened, and one a human (or
          // this very boot's own pump, once it is allowed to run) started in
          // the meantime must not have its mid-turn status overwritten: this
          // pass only ever applies at a BOUNDARY, never mid-flight.
          const fresh = loadTask(project.path, record.id)
          if (
            !fresh ||
            !isActiveTaskStatus(fresh.status) ||
            fresh.status === 'running' ||
            fresh.status === 'reviewing'
          ) {
            return
          }
          const wasQueued = fresh.status === 'queued'
          // Majeur 4: an 'interrupted' record with an unfinished turn is a
          // Resume affordance, not a boundary — moving it to
          // 'waiting_for_you' would make that turn unreachable forever
          // (pendingResumeTurn requires status === 'interrupted').
          const midFlight = fresh.status === 'interrupted' && pendingResumeTurn(fresh) !== null
          const applied = applyIssueReconcile(fresh, outcome, { midFlight })
          if (!applied) {
            return
          }
          if (applied.mutated) {
            // A divergence that moved the task off 'queued' must leave the
            // queue file agreeing with it — the same rule `reconcileTasks`'s
            // own `rewrite` follows for every other boot status change.
            if (wasQueued && fresh.status !== 'queued') {
              queueFor(project).remove(fresh.id)
            }
            fresh.updated_at = new Date().toISOString()
            saveTask(project.path, fresh)
          }
          if (applied.event) {
            const appended = appendTaskEvent(project.path, fresh.id, applied.event)
            emit({
              project_id: project.id,
              task_id: fresh.id,
              event: { name: 'task_event', data: appended },
            })
          }
          if (applied.mutated) {
            emit({
              project_id: project.id,
              task_id: fresh.id,
              event: { name: 'task', data: fresh },
            })
          }
        } catch (err) {
          // Best-effort, like every other background pass in this module: a
          // bug here must not crash a boot that has already returned.
          notice(
            `${project.name}: issue reconciliation of task ${record.id} failed unexpectedly (${errorMessage(err)})`,
          )
        }
      },
    )
    if (deadlineHit) {
      notice(
        `issue reconciliation deadline exceeded for some tasks — they continue on their existing snapshot, marked forge_unreachable, and will be re-checked before their next review`,
      )
    }
  }
  /**
   * Claimed SYNCHRONOUSLY, before the pass's first `await`: a `context()` that
   * lands during the boot window must know these projects already have a pass
   * in flight and not open a second one — it still HOLDS their ticketed tasks
   * (the boot pass has not landed yet), and the `finally` below is what puts
   * them back.
   */
  const bootIssueProjects = registered()
  for (const project of bootIssueProjects) {
    issueReconcileClaimed.add(project.path)
  }
  const bootIssueReconciliation = reconcileIssuesFor(bootIssueProjects)
    .catch((err) => {
      // Inert net: `runWithConcurrency`'s own `allSettled` and every worker's
      // try/catch mean this should never fire, but this promise otherwise has
      // no handler at all until `startPending`'s `await` — which may run long
      // after `startServer`, per the boot sequence in workspace.ts.
      notice(`boot issue reconciliation failed unexpectedly (${errorMessage(err)})`)
    })
    .finally(() => {
      // Whatever the pass did, these projects have now been compared once in
      // this session: mark them, and put back anything a mid-boot `context()`
      // held out of their queues.
      for (const project of bootIssueProjects) {
        releaseTicketedTasks(project)
      }
    })

  return {
    async startPending() {
      // CRITICAL (adversarial review): must land before the first pump, not
      // race it. Bounded above by BOOT_ISSUE_RECONCILE_CONCURRENCY batches of
      // FORGE_ISSUE_TIMEOUT_MS — the same "bounded wait beats an unbounded
      // head start" argument as the semantic watchdog (decision D3).
      await bootIssueReconciliation
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

    // T1.9 review round 1, Mineur 3, accepted rather than reworked: this runs
    // ONCE per boot (workspace.ts), never on a timer or a retry loop. A
    // volume this workspace orphaned while it was down is only ever caught
    // at the NEXT boot — routine, and the whole point of the sweep. But if
    // THAT boot's registry or store read is itself incomplete (a transient
    // I/O error, a 0.12 store mid-migration), the guard above correctly
    // refuses to run rather than narrow the inventory, which pushes the
    // catch-up to the boot AFTER — a second restart, not the first. This is
    // a real, if narrow, latency window (an orphaned volume can survive up
    // to two boots instead of one), left as documented rather than given a
    // background retry: the sweep already runs unattended and destructively
    // enough that "wait for a clean boot" is the safer failure mode than
    // "poll until the registry looks readable and then delete things".
    async sweepOrphanedVolumes() {
      const first = projectClaimedIds()
      if (!first.complete || first.projectCount === 0) {
        notice(
          "orphaned HOME volume sweep skipped: the project registry or a project's task store could not be read completely",
        )
        return
      }
      const sweep = opts.sweepOrphanedVolumesFn ?? sweepOrphanedHomeVolumes
      let outcome: HomeVolumeSweepOutcome
      try {
        outcome = await sweep({
          claimedIds: first.ids,
          // Re-verified immediately before EACH removal (T1.9 review round
          // 1, Critique 3): claimedIds above is a snapshot taken BEFORE the
          // slow `volume ls`/`volume rm` round trips, so a task created (or a
          // project registered) during that window must never lose a volume
          // it never had the chance to appear in the snapshot for.
          recheckClaimedIds: () => {
            const fresh = projectClaimedIds()
            return fresh.complete && fresh.projectCount > 0 ? fresh.ids : null
          },
        })
      } catch (err) {
        notice(`orphaned HOME volume sweep failed: ${errorMessage(err)}`)
        return
      }
      for (const line of outcome.notices) {
        notice(line)
      }
    },

    async applyRetention() {
      const keep = opts.taskRetention ?? DEFAULT_TASK_RETENTION
      const run = opts.applyTaskRetentionFn ?? applyTaskRetention
      for (const project of registered()) {
        let outcome: TaskRetentionOutcome
        try {
          outcome = await run({ cwd: project.path, keep })
        } catch (err) {
          notice(`${project.name}: retention failed (${errorMessage(err)})`)
          continue
        }
        for (const line of outcome.notices) {
          notice(`${project.name}: ${line}`)
        }
        // T1.9 review round 3, Mineur 8: `purged` was returned by
        // applyTaskRetention and read by NOTHING in production — every
        // consumer only ever forwarded `notices`. A per-project count, once
        // per boot, is the one summary line a human skimming startup output
        // can use without adding up how many "task directory removed" lines
        // scrolled past; the per-task detail stays exactly where it was, on
        // `outcome.notices` above.
        if (outcome.purged.length > 0) {
          notice(`${project.name}: retention purged ${outcome.purged.length} task(s)`)
        }
      }
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

    async preview(projectId, input) {
      // Deliberately NOT `context(projectId)`: building a project context
      // reconciles its store, rebuilds `queue.json` and constructs a runner —
      // every one of them a write, and every one of them forbidden here. The
      // registry lookup is the same one `list`/`get` make, and it produces the
      // same 404.
      const project = registered().find((candidate) => candidate.id === projectId)
      if (!project) {
        return unknownProject
      }
      // Reads the issue exactly as `create` does — `admitIssue` never writes —
      // and then throws the snapshot away: D-d, previewing is not launching, so
      // nothing dates the ticket of a task that does not exist.
      const origin = input.issue
        ? await resolveIssueOrigin(project.path, input.issue, opts.issueExecFn)
        : resolveTitlePromptOrigin(input)
      if (!origin.ok) {
        return origin.refusal
      }
      const resolution = resolveTaskPlan(planDeps(project), {
        title: origin.title,
        autoShip: input.autoShip,
        ...(input.base !== undefined ? { base: input.base } : {}),
        ...(input.branch !== undefined ? { branch: input.branch } : {}),
        ...(input.target !== undefined ? { target: input.target } : {}),
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        issue: origin.issue,
      })
      if (!resolution.ok) {
        return resolution
      }
      if (!resolution.admission.admissible) {
        // The refusal `create` ends up returning from `runner.start()` — same
        // 503, same `resource_busy`, same words, since both read them off
        // `enqueue`'s own QUEUE_FULL. There is no record to settle here: a
        // preview never wrote one.
        return {
          ok: false,
          code: 503,
          error: resolution.admission.reason,
          reason_code: 'resource_busy',
        }
      }
      return { ok: true, plan: resolution.plan }
    },

    async create(projectId, input) {
      const ctx = context(projectId)
      if (!ctx) {
        return unknownProject
      }
      // Both given together or neither: `issue` is what freezes the ticket,
      // and a task's record must never carry one without the other (T2.4).
      const origin = input.issue
        ? await resolveIssueOrigin(ctx.project.path, input.issue, opts.issueExecFn)
        : resolveTitlePromptOrigin(input)
      if (!origin.ok) {
        return origin.refusal
      }
      const { title, prompt, issue: issueRef, issueSnapshot, coverageGap } = origin
      // Every guard below — base/branch exclusivity and shape, the work-on
      // uniqueness and checked-out-elsewhere 409s, the agent, the isolation
      // refusal — and every DECISION the record carries now live in
      // `resolveTaskPlan` (T2.6), which reads and creates nothing. The dry-run
      // preview calls the very same function, so "same input, same branch, same
      // refusal" is a property of construction rather than two implementations
      // that happen to agree today.
      //
      // branch/worktree stay empty here (fork mode): the runner creates the
      // worktree when the task actually launches (so a queued task costs
      // nothing). A non-empty base on a never-materialized record is the
      // runner's signal to branch from it instead of auto-detecting. A
      // work-on record instead carries its branch (and workOn) from day one.
      // Isolation is decided HERE, once, and stored on the record: the runner
      // reads it and never re-decides. A workspace configured 'container'
      // refuses the creation outright rather than quietly running the task on
      // the host under a weaker containment than the one that was asked for.
      // The command is the task's own (POST `agent`, validated) or a FRESH
      // projectRuntime snapshot — not the runner's frozen boot command — so
      // a per-task pick, and a session-default PUT, cage the CLI that will
      // actually run. Stored on the record so later turns keep the same CLI.
      const resolution = resolveTaskPlan(planDeps(ctx.project), {
        title,
        autoShip: input.autoShip,
        ...(input.base !== undefined ? { base: input.base } : {}),
        ...(input.branch !== undefined ? { branch: input.branch } : {}),
        ...(input.target !== undefined ? { target: input.target } : {}),
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
        issue: issueRef,
      })
      if (!resolution.ok) {
        return resolution
      }
      // The queue's read-only verdict is deliberately NOT acted on here: a
      // creation the line refuses must still leave a settled record behind
      // (the 503 below, from `runner.start()`), never nothing at all.
      const planned = resolution.record
      const record = createTask(ctx.project.path, {
        title,
        prompt,
        autoShip: input.autoShip,
        base: planned.base,
        branch: planned.branch,
        worktree: '',
        workOn: planned.workOn,
        isolation: planned.isolation,
        agent: planned.agent,
        // Always given together (TaskOrigin pairs them by construction, see
        // resolveIssueOrigin/resolveTitlePromptOrigin) — one guard, not two,
        // so a future drift here cannot silently split the pair.
        ...(issueRef && issueSnapshot ? { issue: issueRef, issueSnapshot } : {}),
      })
      // The WHY is journaled on the task itself: an 'auto' workspace that fell
      // back to policy must be able to say so, months later, from the record.
      const isolationEvent = appendTaskEvent(ctx.project.path, record.id, {
        type: 'isolation',
        data: { isolation: planned.isolation, reason: planned.isolationReason },
      })
      emit({ project_id: projectId, task_id: record.id, event: { name: 'task', data: record } })
      emit({
        project_id: projectId,
        task_id: record.id,
        event: { name: 'task_event', data: isolationEvent },
      })
      // T2.4/DP13: the admission-time half of the 'issue' domain journal — the
      // frozen hashes (forensic raw digest included), and, only when the
      // heuristic actually trips, the one-time disclosure that some of the raw
      // body sits outside what the edit-detector reads.
      if (issueSnapshot) {
        const boundEvent = appendTaskEvent(
          ctx.project.path,
          record.id,
          issueBoundEvent(issueSnapshot),
        )
        emit({
          project_id: projectId,
          task_id: record.id,
          event: { name: 'task_event', data: boundEvent },
        })
        if (coverageGap) {
          const gapEvent = appendTaskEvent(ctx.project.path, record.id, issueCoverageGapEvent())
          emit({
            project_id: projectId,
            task_id: record.id,
            event: { name: 'task_event', data: gapEvent },
          })
        }
      }
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

    workspaceInfo: (projectId) => {
      const project = projectId ? findProject(projectId) : null
      const runtime = project ? projectRuntime(project.path) : null
      // Mode and command both come from disk (and the mutable session
      // default): edits apply to new tasks, matching create().
      const agent =
        runtime?.command ??
        resolveProjectAgentCommand(null, opts.flags ?? {}, sessionCommand).command
      const overlaid = overlayIsolationProbe(probe, {
        configured:
          runtime?.isolationMode ??
          resolveProjectConfig(null, opts.flags ?? {}).config.isolation ??
          probe.configured,
        command: agent,
      })
      return {
        ...isolationDefaults(overlaid),
        isolation_reason: overlaid.reason,
        isolation_configured: overlaid.configured,
        agent,
      }
    },

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

    defaultCommand: () => sessionCommand,

    setDefaultCommand(command) {
      sessionCommand = command
    },
  }
}
