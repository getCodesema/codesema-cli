<script setup lang="ts">
// 'checks' journal line: the final verdict of a sandboxed checks run appended
// by the manager — "Checks — 3 passed" (go) / "Checks — 1 failed" (stop).
// Same compact shape as TaskEventLine; only the tone resolution differs (it
// comes from the event's status, not from the static per-type map).
import { computed } from 'vue'
import { checksEventLine } from '../../composables/useChecks'
import { clockTime } from '../../composables/useTaskBoard'
import { G } from '../../glyphs'
import type { TaskEventCtx } from '../../task-event-registry'
import type { TaskEvent, TaskRecord } from '../../types'

const props = defineProps<{ event: TaskEvent; task: TaskRecord; ctx: TaskEventCtx }>()

const ROW_STATUS = {
  go: 'passed',
  check: 'passed',
  stop: 'failed',
  idle: 'skipped',
} as const

const ROW_GLYPH = {
  go: G.ok,
  check: G.ok,
  stop: G.ko,
  idle: G.minus,
} as const

const line = computed(() => checksEventLine(props.event.data))
const rowStatus = computed(() => ROW_STATUS[line.value.tone])
const glyph = computed(() => ROW_GLYPH[line.value.tone])
const stamp = computed(() => clockTime(props.event.at))
</script>

<template>
  <div class="checks">
    <div class="tvc-line check-row" :data-s="rowStatus">
      <span class="tvc-dot g" aria-hidden="true">{{ glyph }}</span>
      <span
        class="tvc-text"
        :class="{ 'tvc-text--go': line.tone === 'go', 'tvc-text--stop': line.tone === 'stop' }"
      >
        {{ line.text }}
      </span>
      <span class="tvc-time r">{{ stamp }}</span>
    </div>
  </div>
</template>

<style scoped>
.tvc-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

/* The verdict wears its semaphore color: readable at a glance in the thread. */
.tvc-text--go {
  color: var(--ok);
}

.tvc-text--stop {
  color: var(--err);
}

.tvc-time {
  font-size: 12px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
</style>
