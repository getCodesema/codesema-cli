<script setup lang="ts">
// Generic compact journal line (the "Inspector" third of the triptych) for
// event types that need no expansion: turn_started, commit, review_started,
// shipped, error, interrupted. All registry components share the same props
// contract so the conversation can render them through <component :is>.
import { computed } from 'vue'
import { clockTime, eventSummary, eventTone } from '../../composables/useTaskBoard'
import type { TaskEventCtx } from '../../task-event-registry'
import type { TaskEvent, TaskRecord } from '../../types'

const props = defineProps<{ event: TaskEvent; task: TaskRecord; ctx: TaskEventCtx }>()

const TONE_COLOR = {
  go: 'var(--ok)',
  check: 'var(--warn)',
  stop: 'var(--err)',
  idle: 'var(--fg-muted)',
} as const

const dotColor = computed(() => TONE_COLOR[eventTone(props.event)])
const summary = computed(() => eventSummary(props.event))
const stamp = computed(() => clockTime(props.event.at))
</script>

<template>
  <div class="tev-line">
    <span class="tev-dot" :style="{ background: dotColor }" aria-hidden="true" />
    <span class="tev-text" :class="{ 'tev-text--error': event.type === 'error' }">{{
      summary
    }}</span>
    <span class="tev-time">{{ stamp }}</span>
  </div>
</template>

<style scoped>
.tev-line {
  display: flex;
  align-items: baseline;
  gap: 9px;
  padding: 3px 0;
  font-size: var(--fs);
}

.tev-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  transform: translateY(-1px);
}

.tev-text {
  color: var(--fg-dim);
  min-width: 0;
  overflow-wrap: anywhere;
}

.tev-text--error {
  color: var(--err);
  font-family: var(--font);
  font-size: 12px;
}

.tev-time {
  margin-left: auto;
  flex: none;
  font-family: var(--font);
  font-size: 12px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
</style>
