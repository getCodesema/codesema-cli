// The review session's data: the archived-or-live record the legacy review
// UI renders, plus the local MR-review runner (status polling + launcher).
// Lifted out of App.vue so the workspace can reach the same logic.
//
// This is a factory, not a singleton — same doctrine as useForgePrefs.ts: one
// call, one blob of state. App.vue and WorkspaceView.vue are never mounted
// together, so two independent calls are enough; the two UIs share the CODE,
// never a runtime instance, and neither imports the other's.

import { computed, ref, shallowRef, type ComputedRef, type Ref } from 'vue'
import type {
  JudgeLive,
  LiveStatus,
  MrReviewMode,
  MrReviewStatus,
  PartialReview,
  ReviewRecord,
  ReviewSource,
} from '../types'

const MR_REVIEW_POLL_INTERVAL_MS = 1500

/**
 * Every listener the review stream installs, as plain functions of an
 * `Event` — mirrors `taskStreamHandlers` in useTasks.ts: nothing here
 * touches `EventSource`, so a test drives them with a `{ data }` object.
 */
export function reviewStreamHandlers(
  status: Ref<LiveStatus | null>,
  partial: Ref<PartialReview | null>,
  partialB: Ref<PartialReview | null>,
  judge: Ref<JudgeLive | null>,
  onDone: () => void,
): Record<string, (e: Event) => void> {
  return {
    status: (e) => {
      status.value = JSON.parse((e as MessageEvent).data) as LiveStatus
    },
    partial: (e) => {
      partial.value = JSON.parse((e as MessageEvent).data) as PartialReview
    },
    partial_b: (e) => {
      partialB.value = JSON.parse((e as MessageEvent).data) as PartialReview
    },
    judge: (e) => {
      judge.value = JSON.parse((e as MessageEvent).data) as JudgeLive
    },
    done: () => {
      onDone()
    },
  }
}

export type ReviewSessionApi = {
  record: Ref<ReviewRecord | null>
  status: Ref<LiveStatus | null>
  partial: Ref<PartialReview | null>
  partialB: Ref<PartialReview | null>
  judge: Ref<JudgeLive | null>
  /** Set by a failed record load, never by a failed MR-review launch. */
  error: Ref<string | null>
  mrReviewStatus: Ref<MrReviewStatus | null>
  mrReviewStartError: Ref<string | null>
  mrReviewRunning: ComputedRef<boolean>
  runningSource: ComputedRef<ReviewSource | null>
  /** Loads the archived record, or opens the live SSE stream when none
   *  exists yet (HTTP 202). Safe to call again, e.g. from a retry button. */
  load: () => Promise<void>
  /** Mount-time entry point: the current onMounted body (load + an initial
   *  runner status fetch). Gating on workspace mode stays the caller's job. */
  start: () => void
  /** Unmount-time cleanup: closes the SSE connection and the status-poll
   *  timer. Skipping this leaks an open SSE connection for the session. */
  stop: () => void
  /** Resolves `true` only when the run actually launched, so a caller can
   *  decide whether to switch back to the review pane. A refusal (missing
   *  token, already running, a non-2xx response, a network failure) never
   *  throws: it lands in `mrReviewStartError` and resolves `false`. */
  runReview: (source: ReviewSource, mode: MrReviewMode) => Promise<boolean>
  /** Multi-repo workspace targeting (server-side `?project=` support is
   *  landing in parallel). `null` — the default — means no query param, i.e.
   *  today's single-repo behavior. Only the MR-review launch and its status
   *  poll are project-scoped; the record load and its SSE stream are not. */
  setProjectId: (projectId: string | null) => void
}

export function useReviewSession(): ReviewSessionApi {
  // shallowRef: the record is written once then never mutated; deep reactivity
  // over its diff + findings would only add proxy overhead on every read
  // during render.
  const record = shallowRef<ReviewRecord | null>(null)
  const status = ref<LiveStatus | null>(null)
  const partial = ref<PartialReview | null>(null)
  const partialB = ref<PartialReview | null>(null)
  const judge = ref<JudgeLive | null>(null)
  const error = ref<string | null>(null)
  let events: EventSource | null = null

  let projectId: string | null = null

  function setProjectId(next: string | null): void {
    projectId = next
  }

  function withProject(path: string): string {
    return projectId ? `${path}?project=${encodeURIComponent(projectId)}` : path
  }

  async function loadRecord(): Promise<boolean> {
    const res = await fetch('/api/review')
    if (res.status === 202) {
      return false
    }
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    record.value = (await res.json()) as ReviewRecord
    return true
  }

  function closeEvents() {
    events?.close()
    events = null
  }

  async function handleDone(): Promise<void> {
    closeEvents()
    try {
      await loadRecord()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  function openEvents() {
    events = new EventSource('/api/events')
    for (const [name, handler] of Object.entries(
      reviewStreamHandlers(status, partial, partialB, judge, () => void handleDone()),
    )) {
      events.addEventListener(name, handler)
    }
    // Server stopped (Ctrl+C): keep the last state shown, EventSource retries on its own.
  }

  async function load(): Promise<void> {
    error.value = null
    try {
      if (await loadRecord()) {
        return
      }
      openEvents()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  }

  // ── Run a review on an open MR through the local CLI server ───
  const isClient = typeof window !== 'undefined'
  const mrReviewToken = isClient
    ? (window as { __CODESEMA_MRREVIEW_TOKEN__?: string }).__CODESEMA_MRREVIEW_TOKEN__
    : undefined

  const mrReviewStatus = ref<MrReviewStatus | null>(null)
  const mrReviewStartError = ref<string | null>(null)
  let mrReviewPollTimer: ReturnType<typeof setInterval> | undefined

  const runningSource = computed<ReviewSource | null>(() =>
    mrReviewStatus.value?.available && mrReviewStatus.value.phase === 'running'
      ? mrReviewStatus.value.source
      : null,
  )
  const mrReviewRunning = computed(() => runningSource.value !== null)

  function stopMrReviewPolling() {
    if (!mrReviewPollTimer) {
      return
    }
    clearInterval(mrReviewPollTimer)
    mrReviewPollTimer = undefined
  }

  function startMrReviewPolling() {
    if (!mrReviewPollTimer) {
      mrReviewPollTimer = setInterval(
        () => void refreshMrReviewStatus(),
        MR_REVIEW_POLL_INTERVAL_MS,
      )
    }
  }

  async function refreshMrReviewStatus(): Promise<void> {
    try {
      const res = await fetch(withProject('/api/mrs/review/status'))
      if (!res.ok) {
        return
      }
      const next = (await res.json()) as MrReviewStatus
      mrReviewStatus.value = next
      if (next.available && next.phase === 'running') {
        startMrReviewPolling()
      } else {
        stopMrReviewPolling()
      }
    } catch {
      // local server stopped (Ctrl+C): keep the last known state
    }
  }

  async function runReview(source: ReviewSource, mode: MrReviewMode): Promise<boolean> {
    if (!mrReviewToken || mrReviewRunning.value) {
      return false
    }
    mrReviewStartError.value = null
    try {
      const res = await fetch(withProject('/api/mrs/review'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-codesema-mrreview-token': mrReviewToken },
        body: JSON.stringify({ source, mode }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        mrReviewStartError.value = body?.error ?? `HTTP ${res.status}`
        return false
      }
      await refreshMrReviewStatus()
      startMrReviewPolling()
      record.value = null
      status.value = null
      error.value = null
      await load()
      return true
    } catch (err) {
      mrReviewStartError.value = err instanceof Error ? err.message : String(err)
      return false
    }
  }

  function start(): void {
    void load()
    void refreshMrReviewStatus()
  }

  function stop(): void {
    closeEvents()
    stopMrReviewPolling()
  }

  return {
    record,
    status,
    partial,
    partialB,
    judge,
    error,
    mrReviewStatus,
    mrReviewStartError,
    mrReviewRunning,
    runningSource,
    load,
    start,
    stop,
    runReview,
    setProjectId,
  }
}
