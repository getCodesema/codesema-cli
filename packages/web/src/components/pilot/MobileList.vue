<script lang="ts">
import { queueSectionOf } from '../../composables/useTaskBoard'
import type { TaskStatus } from '../../types'

export function needsHuman(status: TaskStatus): boolean {
  return queueSectionOf(status) === 'attention' || status === 'failed'
}
</script>

<script setup lang="ts">
import { computed } from 'vue'
import { eventSummary } from '../../composables/useTaskBoard'
import type { TaskState } from '../../composables/useTasks'
import { EXECUTION_STATUS } from '../../execution-status'
import { t } from '../../i18n'
import { formatRelativeAge } from '../../relative-time'
import type { TaskEvent } from '../../types'
import ChecksChip from '../conversations/ChecksChip.vue'
import { resolveChecksPill } from '../conversations/ConversationsLogic'
import { orderCards } from './PilotLogic'

const props = defineProps<{
  states: TaskState[]
}>()

const emit = defineEmits<{ open: [taskId: string] }>()

function lastEventText(events: readonly TaskEvent[]): string {
  const last = events.at(-1)
  return last ? eventSummary(last) : ''
}

const rows = computed(() => {
  const ordered = orderCards(props.states)
  const attention: TaskState[] = []
  const rest: TaskState[] = []
  for (const state of ordered) {
    if (needsHuman(state.record.status)) {
      attention.push(state)
    } else {
      rest.push(state)
    }
  }
  return [...attention, ...rest].map((state) => ({
    state,
    lastText: lastEventText(state.events),
    age: formatRelativeAge(state.record.updated_at),
    pill: resolveChecksPill(state),
  }))
})

const needsYouCount = computed(
  () => props.states.filter((state) => needsHuman(state.record.status)).length,
)
</script>

<template>
  <div class="mbl-root">
    <header class="mbl-head">
      <h2 class="mbl-title">{{ t('pilot.mobile.title') }}</h2>
      <span v-if="needsYouCount > 0" class="mbl-badge"
        >{{ needsYouCount }} {{ t('pilot.mobile.needsYou') }}</span
      >
    </header>
    <div class="mbl-list">
      <button
        v-for="row in rows"
        :key="row.state.record.id"
        class="mbl-row"
        type="button"
        @click="emit('open', row.state.record.id)"
      >
        <span
          class="mbl-dot"
          :style="{ background: EXECUTION_STATUS[row.state.record.status].color }"
          aria-hidden="true"
        />
        <span class="mbl-text">
          <span class="mbl-row-title">{{ row.state.record.title }}</span>
          <span v-if="row.lastText" class="mbl-row-last">{{ row.lastText }}</span>
        </span>
        <span class="mbl-meta">
          <span class="mbl-age">{{ row.age }}</span>
          <ChecksChip v-if="row.pill" :pill="row.pill" />
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.mbl-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--cs-bg);
}

.mbl-head {
  flex: none;
  height: 52px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border-bottom: 1px solid var(--cs-line);
  background: var(--cs-panel);
}

.mbl-title {
  margin: 0;
  flex: 1;
  font-size: 16px;
  font-weight: 600;
  color: var(--cs-text);
}

.mbl-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--cs-amber-text);
  background: var(--cs-amber-soft);
  border: 1px solid var(--cs-amber-line);
  border-radius: 999px;
  padding: 3px 10px;
  white-space: nowrap;
}

.mbl-list {
  flex: 1;
  overflow-y: auto;
}

.mbl-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  padding: 12px 14px;
  border: 0;
  border-bottom: 1px solid var(--cs-line);
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.mbl-row:hover {
  background: var(--cs-hover);
}

.mbl-dot {
  flex: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
}

.mbl-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.mbl-row-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--cs-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mbl-row-last {
  font-size: 12.5px;
  color: var(--cs-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mbl-meta {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 5px;
}

.mbl-age {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--cs-ghost);
  white-space: nowrap;
}
</style>
