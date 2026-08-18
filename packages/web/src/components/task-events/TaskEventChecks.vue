<script setup lang="ts">
// 'checks' journal line: the final verdict of a sandboxed checks run appended
// by the manager — "Checks — 3 passed" (go) / "Checks — 1 failed" (stop).
// Same compact shape as TaskEventLine; only the tone resolution differs (it
// comes from the event's status, not from the static per-type map).
import { computed } from 'vue'
import { checksEventLine } from '../../composables/useChecks'
import { clockTime } from '../../composables/useTaskBoard'
import type { TaskEventCtx } from '../../task-event-registry'
import type { TaskEvent, TaskRecord } from '../../types'

const props = defineProps<{ event: TaskEvent; task: TaskRecord; ctx: TaskEventCtx }>()

const TONE_COLOR = {
  go: 'var(--cs-green)',
  check: 'var(--cs-amber)',
  stop: 'var(--cs-red)',
  idle: 'var(--cs-dot-idle)',
} as const

const line = computed(() => checksEventLine(props.event.data))
const stamp = computed(() => clockTime(props.event.at))
</script>

<template>
  <div class="tvc-line">
    <span class="tvc-dot" :style="{ background: TONE_COLOR[line.tone] }" aria-hidden="true" />
    <span
      class="tvc-text"
      :class="{ 'tvc-text--go': line.tone === 'go', 'tvc-text--stop': line.tone === 'stop' }"
    >
      {{ line.text }}
    </span>
    <span class="tvc-time">{{ stamp }}</span>
  </div>
</template>

<style scoped>
.tvc-line {
  display: flex;
  align-items: baseline;
  gap: 9px;
  padding: 3px 0;
  font-size: 12.5px;
}

.tvc-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex: none;
  transform: translateY(-1px);
}

.tvc-text {
  color: var(--cs-text-2);
  min-width: 0;
  overflow-wrap: anywhere;
}

/* The verdict wears its semaphore color: readable at a glance in the thread. */
.tvc-text--go {
  color: var(--cs-green-text);
}

.tvc-text--stop {
  color: var(--cs-red-text);
}

.tvc-time {
  margin-left: auto;
  flex: none;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--cs-ghost);
  font-variant-numeric: tabular-nums;
}
</style>
