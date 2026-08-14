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
  go: 'var(--sema-green)',
  check: 'var(--sema-amber)',
  stop: 'var(--sema-red)',
  idle: 'var(--sema-dot-idle)',
} as const

const dotColor = computed(() => TONE_COLOR[eventTone(props.event.type)])
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
  font-size: 12.5px;
}

.tev-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  transform: translateY(-1px);
}

.tev-text {
  color: var(--sema-ink-2);
  min-width: 0;
  overflow-wrap: anywhere;
}

.tev-text--error {
  color: var(--sema-red-text);
  font-family: var(--font-mono);
  font-size: 12px;
}

.tev-time {
  margin-left: auto;
  flex: none;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--sema-ink-ghost);
  font-variant-numeric: tabular-nums;
}
</style>
