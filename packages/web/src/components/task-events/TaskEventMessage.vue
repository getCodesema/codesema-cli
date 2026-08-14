<script setup lang="ts">
// Agent message in the thread: rendered as body text (the "Render" third of
// the triptych), not as a journal line — this is what the agent said.
import { computed } from 'vue'
import { clockTime, eventSummary, firstString } from '../../composables/useTaskBoard'
import type { TaskEventCtx } from '../../task-event-registry'
import type { TaskEvent, TaskRecord } from '../../types'

const props = defineProps<{ event: TaskEvent; task: TaskRecord; ctx: TaskEventCtx }>()

const text = computed(
  () =>
    firstString(props.event.data, ['text', 'preview', 'summary', 'message']) ??
    eventSummary(props.event),
)
const stamp = computed(() => clockTime(props.event.at))
</script>

<template>
  <div class="tvm-root">
    <p class="tvm-text">{{ text }}</p>
    <span class="tvm-time">{{ stamp }}</span>
  </div>
</template>

<style scoped>
.tvm-root {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 4px 0;
}

.tvm-text {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--sema-ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-width: 0;
}

.tvm-time {
  margin-left: auto;
  flex: none;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--sema-ink-ghost);
  font-variant-numeric: tabular-nums;
}
</style>
