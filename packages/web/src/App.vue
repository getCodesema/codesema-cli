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
        <button class="btn ghost" @click="view = view === 'settings' ? 'review' : 'settings'">
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
            <button class="btn" @click="load">{{ $t('app.retry') }}</button>
          </template>
          <p v-else class="status muted" data-s="running">{{ $t('app.loading') }}</p>
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
  padding: var(--row) 2ch 0;
}

.app-state {
  min-height: 60vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--row);
}

.app-error {
  color: var(--err);
}
</style>
