<script setup lang="ts">
// tool_use / tool_result triptych: the compact line is always visible, the
// bounded data payload unfolds on demand (native <details>: keyboard-ready,
// no state to manage). The journal only ever carries summaries, so the
// expanded view is safe to render as-is.
import { computed } from 'vue'
import { clockTime, eventSummary } from '../../composables/useTaskBoard'
import { G } from '../../glyphs'
import { t } from '../../i18n'
import type { TaskEventCtx } from '../../task-event-registry'
import type { TaskEvent, TaskRecord } from '../../types'

const props = defineProps<{ event: TaskEvent; task: TaskRecord; ctx: TaskEventCtx }>()

const summary = computed(() => eventSummary(props.event))
const stamp = computed(() => clockTime(props.event.at))
const isCall = computed(() => props.event.type === 'tool_use')
const glyph = computed(() => (isCall.value ? G.gear : G.reply))

const detail = computed(() => {
  const lines = Object.entries(props.event.data)
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([key, value]) => `${key}: ${value as string}`)
  const text = lines.join('\n')
  // No expansion when the payload adds nothing over the compact line.
  return text && text.length > summary.value.length + 12 ? text : null
})
</script>

<template>
  <details v-if="detail" class="tvt-root">
    <summary class="tvt-summary tool">
      <span class="tvt-glyph g" :class="{ ret: !isCall }" aria-hidden="true">{{ glyph }}</span>
      <span class="tvt-text">{{ summary }}</span>
      <span class="tvt-hint">{{ t('workspace.details') }}</span>
      <span class="tvt-time d">{{ stamp }}</span>
    </summary>
    <pre class="tvt-detail log">{{ detail }}</pre>
  </details>
  <div v-else class="tvt-root tvt-plain tool">
    <span class="tvt-glyph g" :class="{ ret: !isCall }" aria-hidden="true">{{ glyph }}</span>
    <span class="tvt-text">{{ summary }}</span>
    <span class="tvt-time d">{{ stamp }}</span>
  </div>
</template>

<style scoped>
.tvt-summary {
  grid-template-columns: 2ch 1fr auto auto;
  cursor: pointer;
  list-style: none;
}

.tvt-summary::-webkit-details-marker {
  display: none;
}

.tvt-summary:hover .tvt-text {
  color: var(--fg);
}

.tvt-glyph {
  flex: none;
}

.tvt-text {
  font-size: 12px;
  color: var(--fg-dim);
  min-width: 0;
  overflow-wrap: anywhere;
}

.tvt-hint {
  flex: none;
  font-size: 12px;
  color: var(--fg-muted);
}

.tvt-time {
  flex: none;
  font-size: 12px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}

.tvt-detail {
  margin: calc(var(--row) / 2) 0 0 3ch;
  font-size: 12px;
  color: var(--fg-dim);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
