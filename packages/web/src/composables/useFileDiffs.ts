// Client for GET /api/preview/diff, cached per file path: backs the inline
// diff that appears under a ChangedFileRow once it is expanded. Unlike
// useChangedFiles.ts (single target, one MR at a time), several files can be
// expanded at once (fiche 14 §6 explicitly plans for unfolding ten in a
// row), so this one keeps a real per-path cache, same shape as
// useIssues.ts's per-(project,state) cache.
//
// Reuses the /api/preview/diff contract PreviewPanel.vue already calls.

import { reactive } from 'vue'
import type { PreviewFileDiff } from '../types'

export type FileDiffState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'loaded'; diff: PreviewFileDiff }

export type FileDiffFetchOutcome =
  { ok: true; diff: PreviewFileDiff } | { ok: false; error: string }

/** Test seam: the real implementation is `fetchFileDiffOf` below. */
export type FileDiffFetchFn = (
  mrNumber: number,
  path: string,
  project: string | undefined,
) => Promise<FileDiffFetchOutcome>

async function errorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  return body?.error ?? `HTTP ${res.status}`
}

function previewQuery(mrNumber: number, project: string | undefined): string {
  const base = `source=mr&number=${mrNumber}`
  return project === undefined ? base : `${base}&project=${encodeURIComponent(project)}`
}

export async function fetchFileDiffOf(
  mrNumber: number,
  path: string,
  project: string | undefined,
): Promise<FileDiffFetchOutcome> {
  try {
    const res = await fetch(
      `/api/preview/diff?${previewQuery(mrNumber, project)}&path=${encodeURIComponent(path)}`,
    )
    if (!res.ok) {
      return { ok: false, error: await errorFrom(res) }
    }
    return { ok: true, diff: (await res.json()) as PreviewFileDiff }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Composite cache key: a diff is cached per MR, per project scope, AND per
 *  path, so switching the target MR must never serve a stale diff cached
 *  under the same path for a different merge request. */
function cacheKey(mrNumber: number, path: string, project: string | undefined): string {
  return `${project ?? '-'}::${mrNumber}::${path}`
}

export type FileDiffsStore = {
  /** The state for one path, or `null` when it was never requested. Reads
   *  the underlying reactive map, so a template call stays live. */
  stateOf: (mrNumber: number, path: string, project?: string) => FileDiffState | null
  /** Fetches once per (mrNumber, path, project). Already-loaded or in-flight
   *  for that same key: left untouched. A key that last ended in error: retried. */
  load: (mrNumber: number, path: string, project?: string) => void
}

/**
 * `fetchDiff` defaults to the real endpoint; tests inject a rigged one (see
 * useFileDiffs.test.ts).
 */
export function useFileDiffs(fetchDiff: FileDiffFetchFn = fetchFileDiffOf): FileDiffsStore {
  const diffs = reactive(new Map<string, FileDiffState>())

  function run(mrNumber: number, path: string, project: string | undefined): void {
    const key = cacheKey(mrNumber, path, project)
    diffs.set(key, { phase: 'loading' })
    void fetchDiff(mrNumber, path, project).then((outcome) => {
      diffs.set(
        key,
        outcome.ok
          ? { phase: 'loaded', diff: outcome.diff }
          : { phase: 'error', message: outcome.error },
      )
    })
  }

  return {
    stateOf: (mrNumber, path, project) => diffs.get(cacheKey(mrNumber, path, project)) ?? null,
    load: (mrNumber, path, project) => {
      const key = cacheKey(mrNumber, path, project)
      const existing = diffs.get(key)
      if (existing && existing.phase !== 'error') {
        return
      }
      run(mrNumber, path, project)
    },
  }
}
