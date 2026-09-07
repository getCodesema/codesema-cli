<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import PilotView from './components/pilot/PilotView.vue'
import RepoSettings from './components/RepoSettings.vue'
import ReviewLive from './components/ReviewLive.vue'
import ReviewShell from './components/ReviewShell.vue'
import WorkspaceView from './components/WorkspaceView.vue'
import { usePilotPrefs } from './composables/usePilotPrefs'
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

// This instance is the switch's own source of truth: PilotView and
// WorkspaceView each read their own usePilotPrefs() (two independent refs,
// no shared reactivity), so the toggle travels as an event up to App rather
// than through the composable.
const { shell } = usePilotPrefs()

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
  <template v-if="workspaceMode && tasksToken">
    <PilotView v-if="shell === 'pilot'" :token="tasksToken" @switch-shell="shell = 'classic'" />
    <WorkspaceView v-else :token="tasksToken" @switch-shell="shell = 'pilot'" />
  </template>
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
  font-size: var(--fs);
  font-weight: 600;
  font-family: inherit;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--bg-raised);
  color: var(--fg-dim);
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.app-nav-btn:hover {
  border-color: var(--fg-dim);
}

.app-state {
  min-height: 60vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  font-size: var(--fs);
}

.app-error {
  color: var(--err);
  margin: 0;
}

.app-retry {
  font-size: var(--fs);
  font-weight: 600;
  font-family: inherit;
  padding: 7px 14px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--bg-raised);
  color: var(--fg-dim);
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.app-retry:hover {
  border-color: var(--fg-dim);
}

.app-spinner {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2.5px solid var(--line);
  border-top-color: var(--accent);
  animation: app-spin 0.8s linear infinite;
}

@keyframes app-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
