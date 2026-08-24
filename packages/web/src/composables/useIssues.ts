// Client for GET /api/issues (packages/cli/src/serve.ts): lazy per-project
// fetch of the forge issue list, mirrors the loadMrs() lazy-fetch policy in
// useTasks.ts, but with the loading/error states an Issue Radar screen needs
// to render a spinner or a retry rather than a silently empty list.

import { reactive } from 'vue'
import type { ForgeIssuesResult } from '../types'

/** One project's issues: at most one of `error` or a non-null `result` at a time. */
export type ProjectIssuesState = {
  result: ForgeIssuesResult | null
  loading: boolean
  /** A transport-level failure (bad HTTP status, network error). Never the forge's
   *  own unavailability, which travels inside `result` as `available: false`. */
  error: string | null
}

export const EMPTY_ISSUES_STATE: ProjectIssuesState = { result: null, loading: false, error: null }

export type IssuesFetchOutcome =
  { ok: true; result: ForgeIssuesResult } | { ok: false; status: number; error: string }

/** Test seam: the real implementation is `fetchIssuesOf` below. */
export type IssuesFetchFn = (projectId: string) => Promise<IssuesFetchOutcome>

async function errorFrom(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  return text || `HTTP ${res.status}`
}

async function fetchIssuesOf(projectId: string): Promise<IssuesFetchOutcome> {
  try {
    const res = await fetch(`/api/issues?project=${encodeURIComponent(projectId)}`)
    if (!res.ok) {
      return { ok: false, status: res.status, error: await errorFrom(res) }
    }
    return { ok: true, result: (await res.json()) as ForgeIssuesResult }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

export type IssuesStore = {
  /** The state to render for a project id; never mutated in place, so a template
   *  reading it stays reactive across a load/reload. */
  stateOf: (projectId: string) => ProjectIssuesState
  /** Fetches once per project. A project with a cached result (success or forge
   *  unavailability) or a fetch already in flight is left untouched; a project
   *  that last ended in a transport error is retried, since nothing durable was
   *  learned from it. */
  load: (projectId: string) => void
  /** Always refetches, keeping the previous result visible while it does. */
  reload: (projectId: string) => void
}

/**
 * `fetchIssues` defaults to the real endpoint; tests inject a rigged one (see
 * useIssues.test.ts), the same seam shape as `createPlanRequests`'s `PlanPreviewFn`.
 */
export function useIssues(fetchIssues: IssuesFetchFn = fetchIssuesOf): IssuesStore {
  const states = reactive(new Map<string, ProjectIssuesState>())

  const stateOf = (projectId: string): ProjectIssuesState =>
    states.get(projectId) ?? EMPTY_ISSUES_STATE

  function run(projectId: string): void {
    states.set(projectId, { result: stateOf(projectId).result, loading: true, error: null })
    void fetchIssues(projectId).then((outcome) => {
      states.set(
        projectId,
        outcome.ok
          ? { result: outcome.result, loading: false, error: null }
          : { result: null, loading: false, error: outcome.error },
      )
    })
  }

  return {
    stateOf,
    load: (projectId) => {
      const current = states.get(projectId)
      if (current && (current.loading || current.result !== null)) {
        return
      }
      run(projectId)
    },
    reload: (projectId) => run(projectId),
  }
}
