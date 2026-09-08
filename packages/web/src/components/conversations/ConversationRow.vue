<script setup lang="ts">
// One conversation = ONE line of the rail, on the kit's `.sub` grammar: the
// label over at most two lines, the timestamp on the first one. Pure
// presentational, props in, nothing owned. The caller
// (rail/ConversationsList.vue) wraps this in the clickable element and
// decides what a click does.
import { computed } from 'vue'
import { queueSectionOf } from '../../composables/useTaskBoard'
import type { TaskState } from '../../composables/useTasks'
import { conversationLabel } from '../../conversation-label'
import { EXECUTION_STATUS } from '../../execution-status'
import { formatConversationTimestamp } from './ConversationsLogic'

const props = defineProps<{
  state: TaskState
}>()

const visual = computed(() => EXECUTION_STATUS[props.state.record.status])
const finished = computed(() => queueSectionOf(props.state.record.status) === 'done')
const label = computed(() => conversationLabel(props.state.record))
const age = computed(() => formatConversationTimestamp(props.state.record.updated_at))
</script>

<template>
  <span class="cvr-root" :data-tone="visual.tone" :data-finished="finished">
    <span class="cvr-title" :title="state.record.title">{{ label }}</span>
    <span class="cvr-age">{{ age }}</span>
  </span>
</template>

<style scoped>
.cvr-root {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 1ch;
  align-items: baseline;
  min-width: 0;
  width: 100%;
}

/* Two lines at most: the label wraps once, then cuts. The timestamp keeps
   the first line's baseline, so it never drifts down with the second one. */
.cvr-title {
  min-width: 0;
  color: var(--fg);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.cvr-root[data-finished='true'] .cvr-title {
  color: var(--fg-dim);
}

.cvr-age {
  color: var(--fg-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
