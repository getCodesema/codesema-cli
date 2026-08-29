// T2.6 — the composer's plan: what a conversation WOULD be, fetched from
// POST /api/tasks/preview before anything is created, and correctable.
//
// Everything here is testable with bun:test and NOTHING here touches the DOM:
// the request body a draft produces, the correction that moves the plan, the
// tolerant parse of the answer, the lines the panel renders — and the
// per-draft request machinery at the bottom, which is here rather than in
// WorkspaceView.vue precisely because the view cannot be mounted in a test
// (its setup builds `useTasks`) and the one rule that machinery exists to
// keep — a slow answer never overwrites a newer one — was therefore pinned by
// nothing but a `toContain` on the source. The fetch itself still lives in
// useTasks.ts with the rest of the client.
//
// Three rules this file exists to keep:
//
//  1. The correction reuses the EXISTING draft model (`forkDraft` /
//     `workonDraft`): correcting the branch swaps the draft in place, exactly
//     as the fork/work-on toggle already does. A second draft model would be
//     a second source of truth for what the draft is targeting.
//  2. Nothing the server says is rendered raw when it has a label of its own,
//     and nothing the server did not say is invented. A plan that could not
//     name a base says so; a branch the server refused to promise is never
//     shown as final.
//  3. A draft shows the plan of what it is targeting NOW. Answers arrive out
//     of order, the composer is remounted by a correction, and a plan is only
//     ever replaced by a fresher one — never by a staler one that took longer.

import { reactive } from 'vue'
import { t } from '../i18n'
import type { TaskIssueRef, TaskPlan } from '../types'
import { draftBranch, forkDraft, workonDraft, type DraftTarget } from './useWorkspaceNav'

/** What the composer contributes: it owns the prompt, the agent and auto-ship. */
export type PlanComposerInput = {
  title: string
  prompt: string
  autoShip: boolean
  /** Full agent command; absent = the project's own runtime command. */
  agent?: string
}

/**
 * The preview request body for a draft — the SAME mapping `onDraftCreate`
 * uses for the creation (fork sends `base`, work-on sends `branch` and its
 * optional `target`, scratch sends neither), so the plan describes the very
 * request the Launch button will send.
 */
export function planRequestBody(
  projectId: string,
  draft: DraftTarget,
  input: PlanComposerInput,
): Record<string, unknown> {
  return {
    project_id: projectId,
    title: input.title,
    prompt: input.prompt,
    autoShip: input.autoShip,
    ...(input.agent ? { agent: input.agent } : {}),
    ...planTargetFields(draft),
  }
}

/** A scratch draft names no repository: naming a base or a branch on one is
 * a 400, not a silently ignored field. */
function planTargetFields(draft: DraftTarget): Record<string, unknown> {
  switch (draft.mode) {
    case 'scratch':
      return {}
    case 'fork':
      return { base: draft.base }
    case 'workon':
      return { branch: draft.branch, ...(draft.target !== null ? { target: draft.target } : {}) }
  }
}

/**
 * The draft a correction produces. Fork mode corrects the BASE it will branch
 * from; work-on mode corrects the branch the conversation runs on (and keeps
 * the MR target it was opened with). A fork's own branch NAME is not
 * correctable — `POST /api/tasks` has no input for it, the name being minted
 * at launch from the title — so the composer offers no control for it rather
 * than a field that silently does nothing.
 */
export function retargetDraft(draft: DraftTarget, branch: string): DraftTarget {
  const next = branch.trim()
  if (draft.mode === 'scratch' || !next || next === draftBranch(draft)) {
    return draft
  }
  return draft.mode === 'fork' ? forkDraft(next) : workonDraft(next, draft.target)
}

/** Label of the correctable field, which names two different things per mode. */
export function retargetLabel(draft: DraftTarget): string {
  return draft.mode === 'fork' ? t('workspace.planBaseLabel') : t('workspace.planBranchLabel')
}

const str = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.slice(0, max) : ''

const PLAN_BRANCH_MAX = 200
const PLAN_PATH_MAX = 500
const PLAN_REASON_MAX = 2000

function parseIssue(raw: unknown): TaskIssueRef | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const o = raw as Record<string, unknown>
  if ((o.forge !== 'github' && o.forge !== 'gitlab') || typeof o.iid !== 'number') {
    return null
  }
  return {
    forge: o.forge,
    project: str(o.project, PLAN_BRANCH_MAX),
    iid: o.iid,
    url: str(o.url, PLAN_PATH_MAX),
  }
}

/**
 * Whitelist-and-truncate, never throw (invariant 1 on the reading side). The
 * server is local and ours, but the panel must degrade rather than blow up on
 * an older CLI that answers a narrower plan — and a plan with no `branch` at
 * all is not a plan, so that one is the only fatal gap.
 */
export function parseTaskPlan(raw: unknown): TaskPlan | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const p = raw as Record<string, unknown>
  const branch = str(p.branch, PLAN_BRANCH_MAX)
  if (!branch) {
    return null
  }
  const baseNote = str(p.base_note, PLAN_REASON_MAX)
  return {
    mode: p.mode === 'work_on' ? 'work_on' : 'fork',
    repo: str(p.repo, PLAN_PATH_MAX),
    title: str(p.title, PLAN_BRANCH_MAX),
    branch,
    // Absent = NOT certain: a plan that does not say the name is final must
    // never be rendered as if it had.
    branch_certain: p.branch_certain === true,
    worktree_root: str(p.worktree_root, PLAN_PATH_MAX),
    base: str(p.base, PLAN_BRANCH_MAX),
    target: str(p.target, PLAN_BRANCH_MAX),
    ...(baseNote ? { base_note: baseNote } : {}),
    // 'policy' is the honest default here for the same reason it is on
    // TaskRecord: a plan must never claim a stronger containment than the one
    // it can prove.
    isolation:
      p.isolation === 'container' ? 'container' : p.isolation === 'microvm' ? 'microvm' : 'policy',
    isolation_reason: str(p.isolation_reason, PLAN_REASON_MAX),
    agent: str(p.agent, PLAN_PATH_MAX),
    queue_position:
      typeof p.queue_position === 'number' && Number.isFinite(p.queue_position)
        ? p.queue_position
        : null,
    issue: parseIssue(p.issue),
    auto_ship: p.auto_ship === true,
  }
}

/** The branch line, with the caveat when the server would not promise the name. */
export function planBranchLine(plan: TaskPlan): string {
  return plan.branch_certain
    ? plan.branch
    : t('workspace.planBranchUncertain', { branch: plan.branch })
}

/** Where the checkout will live: the root plus the id the task does not have yet. */
export function planWorktreeLine(plan: TaskPlan): string {
  return t('workspace.planWorktreeValue', { root: plan.worktree_root })
}

/** The base a fork starts from — or why the server could not name one. */
export function planBaseLine(plan: TaskPlan): string {
  if (plan.base_note) {
    return t('workspace.planBaseUnknown', { reason: plan.base_note })
  }
  return plan.base || t('workspace.planNone')
}

/** "starts at once" vs "waits at rank n": absence means NOT waiting. */
export function planQueueLine(plan: TaskPlan): string {
  return plan.queue_position === null
    ? t('workspace.planQueueNow')
    : t('workspace.planQueueAt', { n: plan.queue_position })
}

/**
 * The isolation, translated, with the server's own reason beside it. The
 * reason is a sentence the CLI already produced in the workspace's locale —
 * it is not re-translated here, and it is never dropped: an isolation without
 * its why is the silent degradation invariant 2 forbids.
 */
export function planIsolationLine(plan: TaskPlan): string {
  const label =
    plan.isolation === 'container'
      ? t('workspace.planIsolationContainer')
      : plan.isolation === 'microvm'
        ? t('workspace.planIsolationMicrovm')
        : t('workspace.planIsolationPolicy')
  return plan.isolation_reason ? `${label} — ${plan.isolation_reason}` : label
}

/** The bound ticket, or a plain "none" rather than an empty row. */
export function planIssueLine(plan: TaskPlan): string {
  return plan.issue ? `${plan.issue.project}#${plan.issue.iid}` : t('workspace.planNone')
}

// ── The per-draft request machinery ───────────────────────────────────────

/** What one draft renders: a plan, a refusal, or a request in flight. */
export type DraftPlan = { plan: TaskPlan | null; error: string | null; pending: boolean }

/** No plan, no refusal, nothing in flight — the state a draft starts in. */
export const EMPTY_PLAN: DraftPlan = { plan: null, error: null, pending: false }

/** Only the shape of `useTasks().preview` this needs; the real fetch is injected. */
export type PlanPreviewFn = (
  body: Record<string, unknown>,
) => Promise<{ ok: true; plan: TaskPlan } | { ok: false; status: number; error: string }>

/** The composer emits on every keystroke; the server is not asked that often. */
export const PLAN_DEBOUNCE_MS = 250

/** What the panel shows once an answer lands: the plan, or the server's words. */
const settled = (result: Awaited<ReturnType<PlanPreviewFn>>): DraftPlan =>
  result.ok
    ? { plan: result.plan, error: null, pending: false }
    : { plan: null, error: result.error, pending: false }

export type PlanRequests = {
  /** The state to render for a draft key. */
  planOf: (key: string) => DraftPlan
  /** The prompt a draft should mount with — carried across a correction. */
  promptOf: (key: string) => string
  /**
   * Ask what this draft would create. Debounced, and NEVER a
   * creation: the route it calls writes nothing at all, so a human typing in
   * the composer costs reads and nothing else.
   */
  request: (key: string, body: Record<string, unknown>, prompt: string) => void
  /** Hand a prompt to a draft that is about to mount under a new key. */
  carry: (key: string, prompt: string) => void
  /** The draft is gone (closed, corrected, promoted): drop everything it owned. */
  forget: (key: string) => void
}

/**
 * Per-draft plan requests, with the two guards that make them safe to fire
 * from a keystroke:
 *
 *  - a DEBOUNCE, so a sentence is one request rather than forty;
 *  - a monotonic RUN TOKEN per key, so the answer that lands is only ever
 *    written down if it is still the answer to the last question asked. The
 *    server is local but not instant, and a preview for 'develop' issued
 *    before a correction to 'release' can perfectly well answer after it.
 *    Without the token that stale plan wins, and the panel then describes a
 *    branch the draft is no longer targeting.
 *
 * `forget` bumps the token too: an answer for a draft that has since been
 * closed, corrected or promoted belongs to nobody.
 */
export function createPlanRequests(
  preview: PlanPreviewFn,
  debounceMs: number = PLAN_DEBOUNCE_MS,
): PlanRequests {
  const plans = reactive(new Map<string, DraftPlan>())
  const prompts = reactive(new Map<string, string>())
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const runs = new Map<string, number>()

  const planOf = (key: string): DraftPlan => plans.get(key) ?? EMPTY_PLAN
  /** Invalidates whatever is in flight for `key`, and returns the new token. */
  const bump = (key: string): number => {
    const next = (runs.get(key) ?? 0) + 1
    runs.set(key, next)
    return next
  }
  const cancelTimer = (key: string): void => {
    const timer = timers.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(key)
    }
  }

  return {
    planOf,
    promptOf: (key) => prompts.get(key) ?? '',
    carry: (key, prompt) => {
      prompts.set(key, prompt)
    },
    forget: (key) => {
      cancelTimer(key)
      bump(key)
      plans.delete(key)
      prompts.delete(key)
    },
    request: (key, body, prompt) => {
      prompts.set(key, prompt)
      cancelTimer(key)
      // Nothing to plan yet: an empty prompt is a 400 on the creation route
      // too, and an error about nothing is worse than no panel.
      if (!prompt) {
        bump(key)
        plans.set(key, EMPTY_PLAN)
        return
      }
      plans.set(key, { ...planOf(key), pending: true })
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key)
          const run = bump(key)
          void preview(body).then((result) => {
            if (runs.get(key) !== run) {
              return
            }
            plans.set(key, settled(result))
          })
        }, debounceMs),
      )
    },
  }
}
