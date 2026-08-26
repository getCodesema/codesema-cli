// Client for GET /api/preview, scoped to one merge request: the changes
// panel's file list. Mirrors composables/useIssues.ts's shape (injectable
// fetch function, states a caller can render a spinner or a retry from) but
// single-slot rather than a per-project cache: this panel only ever shows
// ONE merge request's files at a time, so there is nothing to keep warm for
// a second target the way the forge board keeps several projects' issue
// lists warm at once.
//
// Reuses the /api/preview HTTP contract PreviewPanel.vue already calls
// (same query shape, same PreviewResult body) rather than a route of its
// own: the changes panel and the review-source preview are the same data
// under two different presentations. PreviewPanel.vue itself is out of
// scope for this component (read-only) and is not imported: only the
// endpoint contract and the PreviewResult type are shared.

import { readonly, ref, type Ref } from 'vue'
import type { PreviewResult } from '../types'

export type ChangedFilesState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'loaded'; preview: PreviewResult }

export const IDLE_CHANGED_FILES_STATE: ChangedFilesState = { phase: 'idle' }

export type ChangedFilesFetchOutcome =
  { ok: true; preview: PreviewResult } | { ok: false; error: string }

/** Test seam: the real implementation is `fetchChangedFilesOf` below. */
export type ChangedFilesFetchFn = (
  mrNumber: number,
  project: string | undefined,
) => Promise<ChangedFilesFetchOutcome>

async function errorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  return body?.error ?? `HTTP ${res.status}`
}

function previewQuery(mrNumber: number, project: string | undefined): string {
  const base = `source=mr&number=${mrNumber}`
  return project === undefined ? base : `${base}&project=${encodeURIComponent(project)}`
}

export async function fetchChangedFilesOf(
  mrNumber: number,
  project: string | undefined,
): Promise<ChangedFilesFetchOutcome> {
  try {
    const res = await fetch(`/api/preview?${previewQuery(mrNumber, project)}`)
    if (!res.ok) {
      return { ok: false, error: await errorFrom(res) }
    }
    return { ok: true, preview: (await res.json()) as PreviewResult }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function cacheKey(mrNumber: number, project: string | undefined): string {
  return project === undefined ? String(mrNumber) : `${project}::${mrNumber}`
}

export type ChangedFilesStore = {
  /** The state to render for the last requested target. Reactive: a
   * template reading it stays live across a load/reload. */
  state: Readonly<Ref<ChangedFilesState>>
  /** Fetches once per (mrNumber, project). Already-loaded or in-flight for
   * that same target: left untouched. A different target (or a target that
   * last ended in error): fetched. */
  load: (mrNumber: number, project?: string) => void
  /** Always refetches the given target, keeping the previous result visible
   * while it does. */
  reload: (mrNumber: number, project?: string) => void
}

/**
 * `fetchFiles` defaults to the real endpoint; tests inject a rigged one (see
 * useChangedFiles.test.ts), the same seam shape as useIssues.ts's
 * `IssuesFetchFn`.
 */
export function useChangedFiles(
  fetchFiles: ChangedFilesFetchFn = fetchChangedFilesOf,
): ChangedFilesStore {
  let currentKey: string | null = null
  const current = ref<ChangedFilesState>(IDLE_CHANGED_FILES_STATE)

  function run(mrNumber: number, project: string | undefined): void {
    const key = cacheKey(mrNumber, project)
    currentKey = key
    current.value = { phase: 'loading' }
    void fetchFiles(mrNumber, project).then((outcome) => {
      if (currentKey !== key) {
        return // superseded by a newer target while this fetch was in flight
      }
      current.value = outcome.ok
        ? { phase: 'loaded', preview: outcome.preview }
        : { phase: 'error', message: outcome.error }
    })
  }

  return {
    state: readonly(current) as Readonly<Ref<ChangedFilesState>>,
    load: (mrNumber, project) => {
      const key = cacheKey(mrNumber, project)
      if (key === currentKey && current.value.phase !== 'idle' && current.value.phase !== 'error') {
        return
      }
      run(mrNumber, project)
    },
    reload: (mrNumber, project) => run(mrNumber, project),
  }
}
