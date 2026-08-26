// Turns a brain ticket (a ticket the local brain owns and this arm claimed)
// into a queued task: the symmetric twin of task-issue.ts's
// resolveIssueOrigin/admitIssue, but for a ticket the brain already resolved
// and validated rather than a forge issue read live over the network.
//
// No forge round trip here: an ArmTicket arrives already sanitized
// (sanitizeArmTicket, contract/brain.ts) by whoever claimed it from the
// brain, so admission is a pure, synchronous lint: lintTicketBody (T2.3),
// the SAME gate task-issue.ts's admitIssue runs on a forge issue's body.
//
// Criteria are frozen on the record AT CREATION, atomically with the title
// and prompt (task-server.ts folds `resolveBrainTicketOrigin`'s `criteria`
// straight into `createTask`'s input), never posed afterwards through
// applyTaskCriteria's own POST /api/tasks/:id/criteria mechanics. A
// brain-ticket task's very first turn already reads `taskCriteria(record)`
// (task-runner.ts) to build its prompt; criteria landing even one write
// later would race that read, and the task would draft-and-wait for a human
// validation nobody is coming to give: the brain validated them already.

import {
  formatTicketProblems,
  lintTicketBody,
  TASK_TITLE_MAX,
  TASK_TURN_TEXT_MAX,
  type AcceptanceCriterion,
  type ArmTicket,
} from './contract.js'
import type { TaskCreateResult, TaskManager } from './task-server.js'

/**
 * What `resolveBrainTicketOrigin` hands back: the same shape task-server.ts's
 * own (unexported) `TaskOrigin` accepts on its `ok: true` branch: title,
 * prompt, no forge issue (a brain ticket is not reconciled against a live
 * forge issue the way T2.4's own origin is; `brainTicket.url` is a plain
 * pointer, not a reconciliation anchor), and the two brain-only fields
 * (`brainTicket`, `criteria`) `task-server.ts`'s `create()` folds onto the
 * record. The refusal is wrapped in `refusal`, matching
 * `resolveIssueOrigin`/`resolveTitlePromptOrigin`'s own shape exactly, so
 * `create()`'s `if (!origin.ok) return origin.refusal` reads it unchanged.
 */
export type BrainTicketOrigin =
  | {
      ok: true
      title: string
      prompt: string
      issue: null
      issueSnapshot: null
      coverageGap: false
      brainTicket: { id: string; title: string; url?: string }
      criteria: AcceptanceCriterion[]
    }
  | { ok: false; refusal: { ok: false; code: 400; error: string } }

/**
 * Validates a brain ticket and derives the task it would become. `cwd` is
 * taken for symmetry with `resolveIssueOrigin(cwd, ref, execFn)`, whose
 * caller (`task-server.ts`) reaches this the same way; nothing here touches
 * disk or the network, so nothing here reads it.
 *
 * Refusals, in order: an empty or over-long title (same bound and same
 * wording as `resolveTitlePromptOrigin`'s own guard), then T2.3's lint on
 * the body: a ticket the brain itself would not have been able to publish
 * without passing this same gate, but re-checked here rather than trusted,
 * since a ticket that failed to lint must never become a task with no
 * criteria to judge it against.
 *
 * `cwd` (unused: nothing here touches disk or the network) is kept for
 * call-shape symmetry with `resolveIssueOrigin(cwd, ref, execFn)`: both are
 * called from the same three-way ternary in `task-server.ts`'s `create()`.
 */
export function resolveBrainTicketOrigin(_cwd: string, ticket: ArmTicket): BrainTicketOrigin {
  const title = ticket.title.trim()
  if (!title) {
    return { ok: false, refusal: { ok: false, code: 400, error: 'empty title' } }
  }
  if (title.length > TASK_TITLE_MAX) {
    return {
      ok: false,
      refusal: { ok: false, code: 400, error: `title too long (max ${TASK_TITLE_MAX})` },
    }
  }
  const lint = lintTicketBody(ticket.body)
  if (!lint.ok) {
    return {
      ok: false,
      refusal: { ok: false, code: 400, error: formatTicketProblems(lint.problems) },
    }
  }
  // Same choice as admitIssue's own prompt (task-issue.ts): the RAW body,
  // post-lint, pre-reconstruction, never silently truncated, since dropping
  // the tail would silently drop instructions.
  const prompt = ticket.body.trim()
  if (prompt.length > TASK_TURN_TEXT_MAX) {
    return {
      ok: false,
      refusal: {
        ok: false,
        code: 400,
        error: `ticket body too long to use as the initial prompt (max ${TASK_TURN_TEXT_MAX} chars)`,
      },
    }
  }
  const url = ticket.mr_url ?? ticket.issue?.url
  return {
    ok: true,
    title,
    prompt,
    issue: null,
    issueSnapshot: null,
    coverageGap: false,
    brainTicket: { id: ticket.id, title, ...(url ? { url } : {}) },
    criteria: lint.body.acceptance_criteria,
  }
}

/**
 * Creates a task from a brain ticket. Resolves `cwd` to its registered
 * project the same way `task-server.ts`'s own `context()` does
 * (`listAll()`, matched on `project.path`) and calls `manager.create()` with
 * the ticket as the task's origin: `task-server.ts` resolves it through
 * `resolveBrainTicketOrigin` above, so a ticket that fails T2.3's lint never
 * reaches `createTask`, and the caller learns why from the very same
 * `TaskCreateResult` shape any other origin refuses with.
 *
 * `autoShip: true`: a brain-ticket task runs unattended end to end (code,
 * ship, review, merge), which is exactly what `record.auto_ship` already
 * gates (`task-server.ts`'s `auto_ship && status === 'review_ok'`); this
 * simply opts every brain-ticket task into it, the same way a human ticking
 * "auto-ship" in the UI would for a task they created by hand.
 */
export async function createBrainTicketTask(
  manager: TaskManager,
  cwd: string,
  ticket: ArmTicket,
): Promise<TaskCreateResult> {
  const project = manager.listAll().find((entry) => entry.project.path === cwd)?.project
  if (!project) {
    return { ok: false, code: 404, error: 'unknown project' }
  }
  return manager.create(project.id, { brainTicket: ticket, autoShip: true })
}
