// The decision half of creating a task, split from its effects (T2.6).
//
// `TaskManager.create` used to mix three things in one function: validating
// the caller's input, DECIDING what the conversation will be (branch, base,
// worktree, isolation, agent, rank in the line) and WRITING that decision to
// disk. The dry-run preview needs the first two and must not touch the third,
// and it must reach exactly the same verdict as the real creation — otherwise
// the plan a human validates is a different plan from the one that runs.
//
// So the decision lives here, is called by BOTH paths, and touches nothing:
// every function in this module READS (git refs, the queue file, the
// isolation probe) and creates no branch, no worktree, no record, no journal
// line and no queue entry. `create` consumes the same resolution it returns —
// which is what makes "same input, same branch" a property of construction
// rather than two implementations that happen to agree today.
//
// The plan is INDICATIVE and deliberately not a reservation (design.md D-c):
// a lock taken by a preview would itself be a side effect. Between the
// preview and the human's click, another task can be admitted and a branch
// can appear; `create` re-decides, and its late refusal is the same refusal,
// word for word, because it comes from this file.

import type { IsolationMode } from './config.js'
import {
  isActiveTaskStatus,
  TASK_AGENT_MAX,
  TASK_BASE_MAX,
  type ReasonCode,
  type TaskIsolation,
  type TaskIssueRef,
  type TaskRecord,
} from './contract.js'
import { t } from './i18n.js'
import {
  cageableCommand,
  overlayIsolationProbe,
  resolveTaskIsolation,
  type IsolationProbe,
} from './task-isolation.js'
import type { QueueProjection } from './task-queue.js'
import {
  branchCheckoutPath,
  detectTaskBase,
  plannedTaskBranch,
  resolveBranchRef,
  resolveForkBase,
  shortBranchName,
  taskWorktreesDir,
} from './task-worktree.js'
import { resolveKnownAgentCommand } from './wizard.js'

/**
 * Everything the decision reads, injected rather than reached for: the tests
 * of this module never touch a runner, a manager or a container (§ 0.4), and
 * the preview route can hand it the very same values `create` uses.
 */
export type TaskPlanDeps = {
  /** The PROJECT's repo root — never the repo the workspace was launched from. */
  cwd: string
  /**
   * Fresh per-project runtime snapshot (T1.4): the agent command a new task
   * runs when it does not name its own, and the project's configured
   * isolation mode. Passing the launch repo's here is the exact bug T1.4
   * closed, which is why this is a parameter and not a module-level read.
   */
  runtime: { command: string; isolationMode: IsolationMode }
  /** Machine-wide isolation probe, re-bound to this project below. */
  probe: IsolationProbe
  /** The project's records: the one-active-conversation-per-branch guard reads them. */
  tasks: () => readonly TaskRecord[]
  /** Read-only queue projection — never enqueues, never claims (task-queue.ts). */
  admission: () => QueueProjection
}

/** The caller's request, after the title/prompt-or-issue origin has been settled. */
export type TaskPlanInput = {
  /** The task's title — a fork's branch name is slugged from it. */
  title: string
  autoShip: boolean
  base?: string
  branch?: string
  target?: string
  agent?: string
  /** T2.4: the validated reference, READ for the plan and never frozen here (D-d). */
  issue?: TaskIssueRef | null
}

/**
 * What a conversation WOULD be. Wire-visible: served verbatim by
 * `POST /api/tasks/preview` and mirrored by hand in `packages/web/src/types.ts`.
 * Nothing here is ever persisted, so it carries no `version` and needs no
 * read-back sanitizer — the client's own tolerant parse is where invariant 1
 * applies for it.
 */
export type TaskPlan = {
  /** 'fork': a new codesema/task-* branch. 'work_on': the caller's own branch. */
  mode: 'fork' | 'work_on'
  /** Repo root the conversation would run in — the PROJECT's, not the launch repo's. */
  repo: string
  /** Title the task would carry (the issue's own title when created from a ticket). */
  title: string
  /** Branch the conversation would run on. */
  branch: string
  /**
   * False when `branch` could NOT be predicted: every `-2`…`-99` suffix is
   * taken, so the real creation appends the task's own id — an id that does
   * not exist yet. `branch` is then the family the branch will belong to, and
   * saying so is the difference between a safe default and a false claim.
   */
  branch_certain: boolean
  /**
   * Directory the worktree would be created under: the checkout itself lands
   * in `<worktree_root>/<task id>`, and that id is minted by `createTask`. A
   * preview that invented one would either have to write it down or announce
   * a path the task never takes.
   */
  worktree_root: string
  /**
   * Branch a fork would start from. Empty in work-on mode, where the
   * conversation continues its OWN branch and nothing is branched — the same
   * emptiness `createWorkOnWorktree` returns for that field.
   */
  base: string
  /** Branch the eventual MR would target: the record's `base`, in both modes. */
  target: string
  /**
   * Set when `base`/`target` could not be auto-detected (no trunk anywhere).
   * A fork is NOT refused for it — `create` does not refuse either, it defers
   * to the launch — so the plan states the gap instead of hiding it behind an
   * empty string (invariant 2).
   */
  base_note?: string
  /** Isolation the task would actually get — never stronger than what the probe proves. */
  isolation: TaskIsolation
  /** Why that isolation, in the workspace's own words: a degradation is never silent. */
  isolation_reason: string
  /** Agent command resolved FOR THIS PROJECT (or the caller's own `agent`). */
  agent: string
  /**
   * Rank the task would wait at, `null` when it would start at once — the
   * same convention `create` answers with. Indicative: the queue can move
   * between this read and the creation (design.md D-c). Also null when the
   * queue would refuse the task outright, a case whose only caller (the
   * preview) answers 503 and never serves this plan.
   */
  queue_position: number | null
  /** Issue the conversation would be bound to. Read, never frozen (D-d). */
  issue: TaskIssueRef | null
  auto_ship: boolean
}

/**
 * What `POST /api/tasks/preview` answers. A refusal here is byte-identical to
 * the one `create` would give for the same input — same code, same message,
 * same `existing_task_id`/`reason_code` — because both come out of
 * `resolveTaskPlan`.
 */
export type TaskPreviewResult = { ok: true; plan: TaskPlan } | TaskPlanRefusal

/** A refusal, shaped so `TaskCreateResult` can return it unchanged. */
export type TaskPlanRefusal = {
  ok: false
  code: number
  error: string
  existing_task_id?: string
  reason_code?: ReasonCode
}

/**
 * What `create` writes on the record, derived from the SAME decisions the
 * plan announces. Kept next to the plan rather than recomputed by the caller:
 * a second derivation is a second chance to drift.
 */
export type TaskPlanRecordFields = {
  /**
   * The record's `branch` at creation: the work-on branch, or '' for a fork —
   * whose name is minted at launch by `freeBranchName`, from the very
   * `plannedTaskBranch` this plan announced.
   */
  branch: string
  /**
   * The record's `base` at creation. Work-on: the MR target. Fork: the
   * caller's EXPLICIT base only (blank stays blank on purpose — a non-empty
   * base on a never-materialized record is the runner's signal to branch from
   * it instead of auto-detecting).
   */
  base: string
  workOn: boolean
  isolation: TaskIsolation
  isolationReason: string
  agent: string
}

export type TaskPlanResolution =
  | {
      ok: true
      plan: TaskPlan
      record: TaskPlanRecordFields
      /**
       * The queue's read-only verdict, handed back rather than acted on here.
       * `create` deliberately ignores it: it writes the record first and lets
       * `runner.start()` refuse, so a task the line will not take is SETTLED
       * on disk with its reason instead of vanishing. The preview has no
       * record to settle, so it turns a refusal into the same 503 — same
       * words, since both come from `enqueue`'s own `QUEUE_FULL`.
       */
      admission: QueueProjection
    }
  | TaskPlanRefusal

/**
 * Everything the branch/base half of the decision settles, for BOTH modes.
 * One value rather than six mutable locals: the fields a fork leaves empty
 * (`planBase` in work-on mode, `branch` in fork mode) are empty on purpose,
 * and a shape that names all of them is what keeps the two modes from quietly
 * filling in each other's blanks.
 */
type TaskPlanTargets = {
  ok: true
  /** The record's `branch`: the work-on branch, '' for a fork. */
  branch: string
  /** The record's `base`. */
  recordBase: string
  /** The plan's `base` — what a fork branches FROM, empty in work-on mode. */
  planBase: string
  /** The plan's `target` — the eventual MR target, in both modes. */
  planTarget: string
  /** The plan's `branch`: the announced name, in both modes. */
  planBranch: string
  branchCertain: boolean
  baseNote: string | null
}

/** The explicit `base`'s own guards, in `create`'s order. */
function refuseExplicitBase(cwd: string, base: string): TaskPlanRefusal | null {
  if (base.length > TASK_BASE_MAX) {
    return { ok: false, code: 400, error: `base too long (max ${TASK_BASE_MAX})` }
  }
  if (base.startsWith('-')) {
    // Never let a branch name masquerade as a git option.
    return { ok: false, code: 400, error: `invalid base branch name '${base}'` }
  }
  if (resolveBranchRef(cwd, base) === null) {
    return { ok: false, code: 400, error: `base branch '${base}' does not exist` }
  }
  return null
}

/**
 * The record's base for a work-on conversation, i.e. the MR target: the
 * caller's `target` when it resolves (an MR target may only exist on origin),
 * otherwise the same trunk auto-detection as fork mode — an unresolvable
 * target is never a 400.
 */
function resolveMrTarget(cwd: string, raw: string): { ok: true; base: string } | TaskPlanRefusal {
  const target = shortBranchName(raw.trim())
  if (target && !target.startsWith('-') && resolveBranchRef(cwd, target) !== null) {
    return { ok: true, base: target }
  }
  try {
    return { ok: true, base: detectTaskBase(cwd) }
  } catch (err) {
    // No trunk anywhere: the MR target of a work-on conversation cannot be
    // determined, and unlike fork mode there is no later launch step to
    // surface it — refuse synchronously.
    return { ok: false, code: 400, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Work-on mode: the caller's own branch, with the two 409s that guard it. */
function resolveWorkOnTargets(
  deps: TaskPlanDeps,
  branch: string,
  input: TaskPlanInput,
): TaskPlanTargets | TaskPlanRefusal {
  const { cwd } = deps
  if (branch.length > TASK_BASE_MAX) {
    return { ok: false, code: 400, error: `branch too long (max ${TASK_BASE_MAX})` }
  }
  if (branch.startsWith('-')) {
    return { ok: false, code: 400, error: `invalid branch name '${branch}'` }
  }
  if (resolveBranchRef(cwd, branch) === null) {
    return { ok: false, code: 400, error: `branch '${branch}' does not exist` }
  }
  // ONE active conversation per branch. Only work-on creations need the
  // guard: fork branches are minted at launch from the free refs/heads
  // namespace, and every active task's branch keeps a live ref, so a fork
  // can never collide with an active conversation's branch.
  const existing = deps
    .tasks()
    .find((task) => task.branch === branch && isActiveTaskStatus(task.status))
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
  const takenBy = branchCheckoutPath(cwd, branch)
  if (takenBy) {
    return {
      ok: false,
      code: 409,
      error: `branch '${branch}' is already checked out in another worktree (${takenBy})`,
    }
  }
  const target = resolveMrTarget(cwd, input.target ?? '')
  if (!target.ok) {
    return target
  }
  return {
    ok: true,
    branch,
    recordBase: target.base,
    // A work-on conversation branches from nothing: it continues its own
    // branch, which is exactly the empty `base` the worktree layer returns.
    planBase: '',
    planTarget: target.base,
    planBranch: branch,
    branchCertain: true,
    baseNote: null,
  }
}

/** Fork mode: a fresh codesema/task-* branch, off the base the launch will use. */
function resolveForkTargets(cwd: string, base: string, title: string): TaskPlanTargets {
  let planBase = ''
  let baseNote: string | null = null
  // `resolveForkBase` is the SAME call the materialization makes, so the base
  // announced here is the base the worktree will start from — including its
  // REFUSALS. Re-deriving it from `detectTaskBase` alone would look identical
  // on a healthy repo and diverge on exactly the ones that matter:
  // `detectTaskBase` answers with any revision that happens to bear a
  // candidate name (a TAG called 'develop', say), and only `resolveForkBase`
  // insists on a branch a worktree can actually be started from.
  try {
    planBase = resolveForkBase(cwd, base || undefined).base
  } catch (err) {
    // No usable base and none given: `create` does NOT refuse for this (the
    // launch does), so neither does the plan — it says it could not find one,
    // which is a different statement from "there is none".
    baseNote = err instanceof Error ? err.message : String(err)
  }
  const planned = plannedTaskBranch(cwd, title)
  return {
    ok: true,
    branch: '',
    // Fork: the caller's EXPLICIT base only (blank stays blank on purpose — a
    // non-empty base on a never-materialized record is the runner's signal to
    // branch from it instead of auto-detecting).
    recordBase: base,
    planBase,
    planTarget: planBase,
    planBranch: planned.branch,
    branchCertain: !planned.collisions_exhausted,
    baseNote,
  }
}

/** The two creation modes, told apart and settled — in `create`'s own order. */
function resolveTargets(
  deps: TaskPlanDeps,
  input: TaskPlanInput,
): TaskPlanTargets | TaskPlanRefusal {
  // Blank means absent. 'origin/x' and 'x' are the SAME branch: identity is
  // the short name.
  const base = shortBranchName((input.base ?? '').trim())
  const branch = shortBranchName((input.branch ?? '').trim())
  // `branch` (work-on) and `base` (fork) are two different creation modes:
  // both at once is a caller bug, not something to guess a priority for.
  if (branch && base) {
    return { ok: false, code: 400, error: "'branch' and 'base' are mutually exclusive" }
  }
  if (base) {
    const refusal = refuseExplicitBase(deps.cwd, base)
    if (refusal) {
      return refusal
    }
  }
  return branch
    ? resolveWorkOnTargets(deps, branch, input)
    : resolveForkTargets(deps.cwd, base, input.title)
}

/**
 * The command the task runs: its own (POST `agent`, validated) or a FRESH
 * per-project snapshot — never the runner's frozen boot command — so a
 * per-task pick, and a session-default PUT, cage the CLI that will actually
 * run.
 */
function resolveAgentCommand(
  fallback: string,
  agent: string | undefined,
): { ok: true; command: string } | TaskPlanRefusal {
  if (agent === undefined) {
    return { ok: true, command: fallback }
  }
  const trimmed = agent.trim()
  // BEFORE `resolveKnownAgentCommand`, and NOT redundant with it: that
  // function hands a command whose binary it knows back VERBATIM, however
  // long it is. Without this line a 518-character `claude -p --model xxx…` is
  // accepted, and lands both on the plan and on the record.
  if (trimmed.length > TASK_AGENT_MAX) {
    return { ok: false, code: 400, error: `agent too long (max ${TASK_AGENT_MAX})` }
  }
  const resolved = resolveKnownAgentCommand(trimmed)
  if (!resolved) {
    return { ok: false, code: 400, error: `unknown agent '${trimmed}'` }
  }
  return { ok: true, command: resolved }
}

/** The containment the task would really get — never stronger than the probe proves. */
function resolveIsolationFor(
  deps: TaskPlanDeps,
  command: string,
): { ok: true; isolation: TaskIsolation; reason: string } | TaskPlanRefusal {
  const projectProbe = overlayIsolationProbe(deps.probe, {
    configured: deps.runtime.isolationMode,
    command,
  })
  const resolved = resolveTaskIsolation(projectProbe, command)
  if (resolved) {
    return { ok: true, isolation: resolved.isolation, reason: resolved.reason }
  }
  // 400: config will never succeed by waiting — a non-cageable agent, or
  // opencode under policy (a host run is unsafe). 409: a cageable agent
  // blocked by a missing/unreachable runtime (claude AND opencode).
  const configRefusal = !cageableCommand(command) || projectProbe.configured === 'policy'
  return {
    ok: false,
    code: configRefusal ? 400 : 409,
    error: t('isolation.unavailable', { reason: projectProbe.reason }),
    ...(configRefusal ? {} : { reason_code: 'resource_busy' as const }),
  }
}

/**
 * The whole decision, in `create`'s own order — base/branch first, then the
 * work-on uniqueness and checkout guards, then the agent, then isolation,
 * then the queue. The order is not cosmetic: it is what makes every refusal
 * synchronous and effect-free, and reordering it would change which refusal a
 * caller sees when two of them apply at once.
 *
 * Reads only. The one thing it cannot do is invent the task id, which is why
 * the worktree is announced by its parent directory.
 */
export function resolveTaskPlan(deps: TaskPlanDeps, input: TaskPlanInput): TaskPlanResolution {
  const { cwd } = deps
  const targets = resolveTargets(deps, input)
  if (!targets.ok) {
    return targets
  }
  const agent = resolveAgentCommand(deps.runtime.command, input.agent)
  if (!agent.ok) {
    return agent
  }
  const isolation = resolveIsolationFor(deps, agent.command)
  if (!isolation.ok) {
    return isolation
  }

  // Last, exactly where `create` meets it: the queue is consulted only once
  // every other guard has passed. Read-only — nothing is enqueued or claimed.
  const admission = deps.admission()

  return {
    ok: true,
    admission,
    plan: {
      mode: targets.branch ? 'work_on' : 'fork',
      repo: cwd,
      title: input.title,
      branch: targets.planBranch,
      branch_certain: targets.branchCertain,
      worktree_root: taskWorktreesDir(cwd),
      base: targets.planBase,
      target: targets.planTarget,
      ...(targets.baseNote !== null ? { base_note: targets.baseNote } : {}),
      isolation: isolation.isolation,
      isolation_reason: isolation.reason,
      agent: agent.command,
      queue_position: admission.admissible ? admission.position : null,
      issue: input.issue ?? null,
      auto_ship: input.autoShip,
    },
    record: {
      branch: targets.branch,
      base: targets.recordBase,
      workOn: targets.branch !== '',
      isolation: isolation.isolation,
      isolationReason: isolation.reason,
      agent: agent.command,
    },
  }
}
