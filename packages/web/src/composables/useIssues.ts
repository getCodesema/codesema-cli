// Client for GET /api/issues (packages/cli/src/serve.ts): lazy per-project,
// per-state fetch of the forge issue list, mirrors the loadMrs() lazy-fetch
// policy in useTasks.ts, but with the loading/error states a forge board
// screen needs to render a spinner or a retry rather than a silently empty
// list.

import { reactive } from 'vue'
import type { ForgeIssuesResult, ForgeIssueStateFilter } from '../types'

/** The state a caller gets when it asks for none: mirrors the CLI probe's own default. */
const DEFAULT_STATE: ForgeIssueStateFilter = 'open'

/** One project's issues, for ONE requested state: at most one of `error` or a
 *  non-null `result` at a time. */
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
export type IssuesFetchFn = (
  projectId: string,
  state: ForgeIssueStateFilter,
) => Promise<IssuesFetchOutcome>

async function errorFrom(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  return text || `HTTP ${res.status}`
}

async function fetchIssuesOf(
  projectId: string,
  state: ForgeIssueStateFilter,
): Promise<IssuesFetchOutcome> {
  try {
    const res = await fetch(
      `/api/issues?project=${encodeURIComponent(projectId)}&state=${encodeURIComponent(state)}`,
    )
    if (!res.ok) {
      return { ok: false, status: res.status, error: await errorFrom(res) }
    }
    return { ok: true, result: (await res.json()) as ForgeIssuesResult }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Composite cache key: issues are cached per project AND per requested state,
 *  so asking for closed issues must never evict, or be served, an
 *  already-loaded open list, and switching back to open must not re-fetch it. */
function cacheKey(projectId: string, state: ForgeIssueStateFilter): string {
  return projectId + '::' + state
}

export type IssuesStore = {
  /** The state to render for a project id and requested state (default 'open',
   *  the historical single-state behavior); never mutated in place, so a
   *  template reading it stays reactive across a load/reload. */
  stateOf: (projectId: string, state?: ForgeIssueStateFilter) => ProjectIssuesState
  /** Fetches once per (project, state). A project/state pair with a cached
   *  result (success or forge unavailability) or a fetch already in flight is
   *  left untouched; a pair that last ended in a transport error is retried,
   *  since nothing durable was learned from it. */
  load: (projectId: string, state?: ForgeIssueStateFilter) => void
  /** Always refetches that (project, state) pair, keeping the previous result
   *  visible while it does. */
  reload: (projectId: string, state?: ForgeIssueStateFilter) => void
}

/**
 * `fetchIssues` defaults to the real endpoint; tests inject a rigged one (see
 * useIssues.test.ts), the same seam shape as `createPlanRequests`'s `PlanPreviewFn`.
 */
export function useIssues(fetchIssues: IssuesFetchFn = fetchIssuesOf): IssuesStore {
  const states = reactive(new Map<string, ProjectIssuesState>())

  const stateOf = (
    projectId: string,
    state: ForgeIssueStateFilter = DEFAULT_STATE,
  ): ProjectIssuesState => states.get(cacheKey(projectId, state)) ?? EMPTY_ISSUES_STATE

  function run(projectId: string, state: ForgeIssueStateFilter): void {
    const key = cacheKey(projectId, state)
    states.set(key, { result: stateOf(projectId, state).result, loading: true, error: null })
    void fetchIssues(projectId, state).then((outcome) => {
      states.set(
        key,
        outcome.ok
          ? { result: outcome.result, loading: false, error: null }
          : { result: null, loading: false, error: outcome.error },
      )
    })
  }

  return {
    stateOf,
    load: (projectId, state = DEFAULT_STATE) => {
      const current = states.get(cacheKey(projectId, state))
      if (current && (current.loading || current.result !== null)) {
        return
      }
      run(projectId, state)
    },
    reload: (projectId, state = DEFAULT_STATE) => run(projectId, state),
  }
}
