// Persistence of human-validated acceptance criteria. POST /api/tasks/:id/criteria
// is the ONLY path from a proposal to disk (same doctrine as checksApply).
// The agent draft at turn 1 is in-memory only; this module never reads it.

import { formatTicketProblems, lintCriteria, type AcceptanceCriterion } from './contract.js'
import { appendTaskEvent, loadTask, saveTask } from './tasks-store.js'

export type ApplyTaskCriteriaResult =
  { ok: true; criteria: AcceptanceCriterion[] } | { ok: false; code: 400 | 404; error: string }

const EMPTY_LIST_ERROR = 'a criteria list must not be empty'
const MISSING_LIST_ERROR = 'the request must carry a criteria list'
const UNKNOWN_TASK_ERROR = 'unknown task'
const VALIDATED_MESSAGE = 'acceptance criteria validated'

/**
 * Validates `body.criteria` against the T2.3 lint and, on success, writes the
 * list onto `task.json` via saveTask (tmp+rename) and journals the validation.
 * Refusals name their reason and persist nothing.
 */
export function applyTaskCriteria(cwd: string, id: string, body: unknown): ApplyTaskCriteriaResult {
  const record = loadTask(cwd, id)
  if (!record) {
    return { ok: false, code: 404, error: UNKNOWN_TASK_ERROR }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, code: 400, error: MISSING_LIST_ERROR }
  }
  const raw = (body as { criteria?: unknown }).criteria
  if (raw === undefined) {
    return { ok: false, code: 400, error: MISSING_LIST_ERROR }
  }
  if (Array.isArray(raw) && raw.length === 0) {
    return { ok: false, code: 400, error: EMPTY_LIST_ERROR }
  }
  const lint = lintCriteria(raw)
  if (!lint.ok) {
    return { ok: false, code: 400, error: formatTicketProblems(lint.problems) }
  }
  record.criteria = lint.criteria
  record.updated_at = new Date().toISOString()
  saveTask(cwd, record)
  appendTaskEvent(cwd, id, {
    type: 'criteria',
    data: {
      name: 'validated',
      message: VALIDATED_MESSAGE,
      count: lint.criteria.length,
    },
  })
  return { ok: true, criteria: lint.criteria }
}
