<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import BranchSidebar from './components/BranchSidebar.vue'
import MrDetailPanel, { type DetailSource } from './components/MrDetailPanel.vue'
import MrSidebar from './components/MrSidebar.vue'
import RepoSettings from './components/RepoSettings.vue'
import ReviewLive from './components/ReviewLive.vue'
import ReviewShell from './components/ReviewShell.vue'
import WorkspaceView from './components/WorkspaceView.vue'
import { useReviewSession } from './composables/useReviewSession'
import type { ForgeMr, LocalBranch, MrReviewMode, ReviewSource } from './types'

// The tasks token doubles as the mode detector: the server only injects it
// when a TaskManager runs (codesema workspace), so its presence flips the UI
// to the agent workspace. Without it, the review experience is unchanged.
const tasksToken =
  typeof window !== 'undefined'
    ? (window as { __CODESEMA_TASKS_TOKEN__?: string }).__CODESEMA_TASKS_TOKEN__
    : undefined
const workspaceMode = typeof tasksToken === 'string' && tasksToken.length > 0

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

const {
  record,
  status,
  partial,
  partialB,
  judge,
  error,
  mrReviewRunning,
  mrReviewStartError,
  runningSource,
  load,
  start,
  stop,
  runReview,
} = useReviewSession()

const mrReviewRunningNumber = computed(() =>
  runningSource.value?.kind === 'mr' ? runningSource.value.number : null,
)
const branchReviewRunningName = computed(() =>
  runningSource.value?.kind === 'branch' ? runningSource.value.name : null,
)

async function handleRun(mode: MrReviewMode) {
  if (!selectedDetail.value) {
    return
  }
  const source: ReviewSource =
    selectedDetail.value.kind === 'mr'
      ? { kind: 'mr', number: selectedDetail.value.mr.number }
      : { kind: 'branch', name: selectedDetail.value.branch.name }
  const launched = await runReview(source, mode)
  if (launched) {
    view.value = 'review'
  }
}

// In workspace mode the review session endpoints stay idle: WorkspaceView
// owns its own stream, nothing to load or poll here.
onMounted(() => {
  if (!workspaceMode) {
    start()
  }
})
onUnmounted(stop)
</script>

<template>
  <WorkspaceView v-if="workspaceMode && tasksToken" :token="tasksToken" />
  <div v-else class="app-layout">
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
        @run="handleRun"
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
