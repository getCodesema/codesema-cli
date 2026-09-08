<script setup lang="ts">
// Generic compact journal line (the "Inspector" third of the triptych) for
// event types that need no expansion: turn_started, commit, review_started,
// shipped, error, interrupted. All registry components share the same props
// contract so the conversation can render them through <component :is>.
import { computed } from 'vue'
import { clockTime, eventSummary, eventTone } from '../../composables/useTaskBoard'
import { G } from '../../glyphs'
import { formatExactStamp } from '../../relative-time'
import type { TaskEventCtx } from '../../task-event-registry'
import type { TaskEvent, TaskRecord } from '../../types'

const props = defineProps<{ event: TaskEvent; task: TaskRecord; ctx: TaskEventCtx }>()

const EVENT_DATA_TONE = {
  go: 'ok',
  check: 'warn',
  stop: 'err',
  busy: 'info',
  idle: 'idle',
} as const

const dataTone = computed(() => EVENT_DATA_TONE[eventTone(props.event)])
const summary = computed(() => eventSummary(props.event))
const stamp = computed(() => clockTime(props.event.at))
const exact = computed(() => formatExactStamp(props.event.at))
</script>

<template>
  <div class="tev-line" :data-tone="dataTone" :title="exact">
    <span class="tev-dot" aria-hidden="true">{{ G.dot }}</span>
    <span class="tev-text" :class="{ 'tev-text--error': event.type === 'error' }">{{
      summary
    }}</span>
    <span v-if="ctx.showTime && stamp" class="tev-time">{{ stamp }}</span>
  </div>
</template>

<style scoped>
.tev-line {
  display: flex;
  align-items: baseline;
  gap: 1ch;
}

.tev-dot {
  flex: none;
  color: var(--tone);
}

.tev-text {
  color: var(--fg-dim);
  min-width: 0;
  overflow-wrap: anywhere;
}

.tev-text--error {
  color: var(--err);
}

/* Right after the text, never a column of its own: the stamp is an aside. */
.tev-time {
  flex: none;
  font-size: 12px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}
</style>
