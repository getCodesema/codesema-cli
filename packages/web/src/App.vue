<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import BranchSidebar from './components/BranchSidebar.vue'
import MrDetailPanel, { type DetailSource } from './components/MrDetailPanel.vue'
import MrSidebar from './components/MrSidebar.vue'
import RepoSettings from './components/RepoSettings.vue'
import ReviewLive from './components/ReviewLive.vue'
import ReviewShell from './components/ReviewShell.vue'
import type {
  ForgeMr,
  JudgeLive,
  LiveStatus,
  LocalBranch,
  MrReviewMode,
  MrReviewStatus,
  PartialReview,
  ReviewRecord,
  ReviewSource,
} from './types'

const view = ref<'review' | 'settings' | 'detail'>('review')
const selectedDetail = shallowRef<DetailSource | null>(null)

function selectMr(mr: ForgeMr) {
  selectedDetail.value = { kind: 'mr', mr }
  view.value = 'detail'
}

function selectBranch(branch: LocalBranch) {
  selectedDetail.value = { kind: 'branch', branch }
  view.value = 'detail'
}

function backFromDetail() {
  view.value = 'review'
}

// shallowRef: the record is written once then never mutated; deep reactivity over
// its diff + findings would only add proxy overhead on every read during render.
const record = shallowRef<ReviewRecord | null>(null)
const status = ref<LiveStatus | null>(null)
const partial = ref<PartialReview | null>(null)
const partialB = ref<PartialReview | null>(null)
const judge = ref<JudgeLive | null>(null)
const error = ref<string | null>(null)
let events: EventSource | null = null

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

function openEvents() {
  events = new EventSource('/api/events')
  events.addEventListener('status', (e) => {
    status.value = JSON.parse((e as MessageEvent).data) as LiveStatus
  })
  events.addEventListener('partial', (e) => {
    partial.value = JSON.parse((e as MessageEvent).data) as PartialReview
  })
  events.addEventListener('partial_b', (e) => {
    partialB.value = JSON.parse((e as MessageEvent).data) as PartialReview
  })
  events.addEventListener('judge', (e) => {
    judge.value = JSON.parse((e as MessageEvent).data) as JudgeLive
  })
  events.addEventListener('done', async () => {
    closeEvents()
    try {
      await loadRecord()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
    }
  })
  // Server stopped (Ctrl+C): keep the last state shown, EventSource retries on its own.
}

async function load() {
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
const mrReviewRunningNumber = computed(() =>
  runningSource.value?.kind === 'mr' ? runningSource.value.number : null,
)
const branchReviewRunningName = computed(() =>
  runningSource.value?.kind === 'branch' ? runningSource.value.name : null,
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
    mrReviewPollTimer = setInterval(() => void refreshMrReviewStatus(), 1500)
  }
}

async function refreshMrReviewStatus(): Promise<void> {
  try {
    const res = await fetch('/api/mrs/review/status')
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

async function runReview(source: ReviewSource, mode: MrReviewMode) {
  if (!mrReviewToken || mrReviewRunning.value) {
    return
  }
  mrReviewStartError.value = null
  try {
    const res = await fetch('/api/mrs/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-codesema-mrreview-token': mrReviewToken },
      body: JSON.stringify({ source, mode }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      mrReviewStartError.value = body?.error ?? `HTTP ${res.status}`
      return
    }
    await refreshMrReviewStatus()
    startMrReviewPolling()
    view.value = 'review'
    record.value = null
    status.value = null
    error.value = null
    await load()
  } catch (err) {
    mrReviewStartError.value = err instanceof Error ? err.message : String(err)
  }
}

onMounted(load)
onMounted(() => void refreshMrReviewStatus())
onUnmounted(closeEvents)
onUnmounted(stopMrReviewPolling)
</script>

<template>
  <div class="app-layout">
    <aside class="app-sidebar">
      <MrSidebar
        :selected-number="
          view === 'detail' && selectedDetail?.kind === 'mr' ? selectedDetail.mr.number : null
        "
        :running-number="mrReviewRunningNumber"
        @select="selectMr"
      />
      <div class="app-sidebar-divider" />
      <BranchSidebar
        :selected-name="
          view === 'detail' && selectedDetail?.kind === 'branch' ? selectedDetail.branch.name : null
        "
        :running-name="branchReviewRunningName"
        @select="selectBranch"
      />
    </aside>

    <div class="app-main">
      <nav class="app-nav">
        <button class="app-nav-btn" @click="view = view === 'settings' ? 'review' : 'settings'">
          {{ view === 'settings' ? $t('nav.backToReview') : $t('nav.settings') }}
        </button>
      </nav>

      <MrDetailPanel
        v-if="view === 'detail' && selectedDetail"
        :source="selectedDetail"
        :running="mrReviewRunning"
        :run-error="mrReviewStartError"
        @back="backFromDetail"
        @run="
          (mode) =>
            runReview(
              selectedDetail!.kind === 'mr'
                ? { kind: 'mr', number: selectedDetail!.mr.number }
                : { kind: 'branch', name: selectedDetail!.branch.name },
              mode,
            )
        "
      />
      <RepoSettings v-else-if="view === 'settings'" />
      <template v-else>
        <ReviewShell v-if="record" :record="record" />
        <ReviewLive
          v-else-if="status && !error"
          :status="status"
          :partial="partial"
          :partial-b="partialB"
          :judge="judge"
        />
        <div v-else class="app-state">
          <template v-if="error">
            <p class="app-error">{{ $t('app.loadError') }} ({{ error }})</p>
            <button class="app-retry" @click="load">{{ $t('app.retry') }}</button>
          </template>
          <template v-else>
            <span class="app-spinner" aria-hidden="true" />
            <p class="codesema-muted">{{ $t('app.loading') }}</p>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.app-layout {
  display: flex;
  align-items: stretch;
  min-height: 100vh;
}

.app-sidebar {
  width: 280px;
  flex-shrink: 0;
  border-right: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.app-sidebar-divider {
  height: 1px;
  background: var(--codesema-line);
  margin: 0 12px;
}

.app-main {
  flex: 1;
  min-width: 0;
}

.app-nav {
  display: flex;
  justify-content: flex-end;
  padding: 14px 20px 0;
}

.app-nav-btn {
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  color: var(--codesema-ink-2);
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.app-nav-btn:hover {
  border-color: var(--codesema-ink-3);
}

.app-state {
  min-height: 60vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  font-size: 14px;
}

.app-error {
  color: var(--codesema-risk-high);
  margin: 0;
}

.app-retry {
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  padding: 7px 14px;
  border-radius: 8px;
  border: 1px solid var(--codesema-line);
  background: var(--codesema-panel);
  color: var(--codesema-ink-2);
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.app-retry:hover {
  border-color: var(--codesema-ink-3);
}

.app-spinner {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2.5px solid var(--codesema-line);
  border-top-color: var(--codesema-accent);
  animation: app-spin 0.8s linear infinite;
}

@keyframes app-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
