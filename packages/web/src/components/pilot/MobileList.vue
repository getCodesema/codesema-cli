<script lang="ts">
import { queueSectionOf } from '../../composables/useTaskBoard'
import type { TaskStatus } from '../../types'

export function needsHuman(status: TaskStatus): boolean {
  return queueSectionOf(status) === 'attention' || status === 'failed'
}
</script>

<script setup lang="ts">
import { computed } from 'vue'
import { activityPhraseKey, eventSummary } from '../../composables/useTaskBoard'
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

/** The activity phase phrase takes over the row's preview line when present,
 * same precedence as AgentCard's header phrase over the plain status one. */
function previewText(state: TaskState): string {
  const key = activityPhraseKey(state.record)
  return key ? t(key) : lastEventText(state.events)
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
    lastText: previewText(state),
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
    <header class="mbl-head queue-h">
      <h2 class="mbl-title">{{ t('pilot.mobile.title') }}</h2>
      <span v-if="needsYouCount > 0" class="mbl-badge badge" data-tone="warn"
        >{{ needsYouCount }} {{ t('pilot.mobile.needsYou') }}</span
      >
    </header>
    <div class="mbl-list">
      <button
        v-for="row in rows"
        :key="row.state.record.id"
        class="mbl-row card"
        :data-s="row.state.record.status"
        type="button"
        @click="emit('open', row.state.record.id)"
      >
        <span
          class="mbl-dot status"
          :data-tone="EXECUTION_STATUS[row.state.record.status].tone"
          aria-hidden="true"
        />
        <span class="mbl-text">
          <span class="mbl-row-title title">{{ row.state.record.title }}</span>
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
  background: var(--bg);
}

.mbl-head {
  flex: none;
  align-items: center;
  gap: 2ch;
  padding: calc(var(--row) / 2) 1ch;
  border-bottom: 1px solid var(--line);
  background: var(--bg-raised);
}

.mbl-title {
  margin: 0;
  flex: 1;
  color: var(--fg);
}

.mbl-badge {
  color: var(--warn);
  white-space: nowrap;
}

.mbl-list {
  flex: 1;
  overflow-y: auto;
}

.mbl-row {
  display: flex;
  align-items: center;
  gap: 1ch;
  width: 100%;
  padding: calc(var(--row) / 2) 1ch;
  border: 0;
  border-bottom: 1px solid var(--line);
  border-left: 3px solid var(--c);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.mbl-row:hover {
  background: var(--bg-hover);
}

.mbl-dot {
  flex: none;
}

.mbl-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.mbl-row-title {
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mbl-row-last {
  color: var(--fg-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mbl-meta {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

.mbl-age {
  font-size: 12px;
  color: var(--fg-muted);
  white-space: nowrap;
}
</style>
