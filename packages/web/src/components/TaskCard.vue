<script setup lang="ts">
// One task on the home board. The card border stays neutral except in the
// "waiting for you" zone: there the task carries a state (the human blocks
// it), so the amber border is doctrine, not decoration. Work and wait chronos
// are shown side by side, never summed.
import { computed } from 'vue'
import { formatDuration, lastActivity } from '../composables/useTaskBoard'
import type { TaskState } from '../composables/useTasks'
import { EXECUTION_STATUS } from '../execution-status'
import { t } from '../i18n'

const props = defineProps<{
  state: TaskState
  prominent?: boolean
  showActivity?: boolean
  /** Repo name badge, shown when the board merges several projects. */
  projectName?: string | null
}>()

const emit = defineEmits<{ select: [] }>()

const visual = computed(() => EXECUTION_STATUS[props.state.record.status])
const activity = computed(() =>
  props.showActivity ? lastActivity(props.state.events, props.state.liveText) : null,
)
const work = computed(() => formatDuration(props.state.record.work_ms))
const wait = computed(() =>
  props.state.record.wait_ms > 0 ? formatDuration(props.state.record.wait_ms) : null,
)
</script>

<template>
  <button class="tk-card" :class="{ 'tk-card--attention': prominent }" @click="emit('select')">
    <span
      class="tk-dot"
      :class="{ 'tk-dot--pulse': visual.pulse }"
      :style="{ background: visual.color }"
      aria-hidden="true"
    />
    <span class="tk-body">
      <span class="tk-title-row">
        <span v-if="projectName" class="tk-project">{{ projectName }}</span>
        <span class="tk-title">{{ state.record.title }}</span>
      </span>
      <span v-if="activity" class="tk-activity">{{ activity }}</span>
    </span>
    <span class="tk-meta">
      <span class="tk-status" :style="{ color: visual.text, background: visual.soft }">
        {{ visual.icon }} {{ t(visual.labelKey) }}
      </span>
      <span class="tk-chrono">
        <span class="tk-work">{{ t('workspace.workTime', { t: work }) }}</span>
        <span v-if="wait" class="tk-wait">{{ t('workspace.waitTime', { t: wait }) }}</span>
      </span>
    </span>
  </button>
</template>

<style scoped>
.tk-card {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  text-align: left;
  padding: 12px 14px;
  border: 1px solid var(--sema-line-card);
  border-radius: 11px;
  background: var(--sema-card);
  font-family: inherit;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    box-shadow 0.25s ease;
}

.tk-card:hover {
  border-color: var(--sema-ink-3);
}

/* State-carrying border: this task is blocked on the human. */
.tk-card--attention {
  border-color: var(--sema-amber);
  box-shadow: var(--sema-shadow-card);
}

.tk-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex: none;
}

/* Glow reserved for the live signal: the agent works right now. */
.tk-dot--pulse {
  animation: tk-pulse 1.6s ease-in-out infinite;
}

@keyframes tk-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 var(--sema-amber-soft);
  }
  50% {
    box-shadow: 0 0 8px 2px var(--sema-amber-soft);
  }
}

.tk-body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}

.tk-title-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

/* Neutral chip: the project is context, never a state. */
.tk-project {
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  color: var(--sema-ink-3);
  background: var(--sema-panel-2);
  border-radius: 5px;
  padding: 1px 6px;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tk-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--sema-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tk-activity {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--sema-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tk-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex: none;
}

.tk-status {
  font-size: 11px;
  font-weight: 600;
  border-radius: 999px;
  padding: 2px 10px;
  white-space: nowrap;
}

.tk-chrono {
  display: flex;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

.tk-work {
  color: var(--sema-ink-3);
}

/* Wait time is shown apart and dimmed: it is never work. */
.tk-wait {
  color: var(--sema-ink-ghost);
}
</style>
