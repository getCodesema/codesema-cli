<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import RepoSettings from './components/RepoSettings.vue'
import ReviewLive from './components/ReviewLive.vue'
import ReviewShell from './components/ReviewShell.vue'
import WorkspaceView from './components/WorkspaceView.vue'
import { useReviewSession } from './composables/useReviewSession'

// The tasks token doubles as the mode detector: the server only injects it
// when a TaskManager runs (codesema workspace), so its presence flips the UI
// to the agent workspace. Without it, this reads the ONE review this process
// is serving — what `codesema review` opens, and what CI keeps. Browsing
// merge requests and starting a review live in the workspace now.
const tasksToken =
  typeof window !== 'undefined'
    ? (window as { __CODESEMA_TASKS_TOKEN__?: string }).__CODESEMA_TASKS_TOKEN__
    : undefined
const workspaceMode = typeof tasksToken === 'string' && tasksToken.length > 0

const view = ref<'review' | 'settings'>('review')

const { record, status, partial, partialB, judge, error, load, start, stop } = useReviewSession()

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
    <div class="app-main">
      <nav class="app-nav">
        <button class="app-nav-btn" @click="view = view === 'settings' ? 'review' : 'settings'">
          {{ view === 'settings' ? $t('nav.backToReview') : $t('nav.settings') }}
        </button>
      </nav>

      <RepoSettings v-if="view === 'settings'" />
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
