<script setup lang="ts">
// tool_use / tool_result triptych: the compact line is always visible, the
// bounded data payload unfolds on demand (native <details>: keyboard-ready,
// no state to manage). The journal only ever carries summaries, so the
// expanded view is safe to render as-is.
import { computed } from 'vue'
import { clockTime, eventSummary } from '../../composables/useTaskBoard'
import { t } from '../../i18n'
import type { TaskEventCtx } from '../../task-event-registry'
import type { TaskEvent, TaskRecord } from '../../types'

const props = defineProps<{ event: TaskEvent; task: TaskRecord; ctx: TaskEventCtx }>()

const summary = computed(() => eventSummary(props.event))
const stamp = computed(() => clockTime(props.event.at))

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
    <summary class="tvt-summary">
      <span class="tvt-glyph" aria-hidden="true">{{ event.type === 'tool_use' ? '⚙' : '↩' }}</span>
      <span class="tvt-text">{{ summary }}</span>
      <span class="tvt-hint">{{ t('workspace.details') }}</span>
      <span class="tvt-time">{{ stamp }}</span>
    </summary>
    <pre class="tvt-detail">{{ detail }}</pre>
  </details>
  <div v-else class="tvt-root tvt-plain">
    <span class="tvt-glyph" aria-hidden="true">{{ event.type === 'tool_use' ? '⚙' : '↩' }}</span>
    <span class="tvt-text">{{ summary }}</span>
    <span class="tvt-time">{{ stamp }}</span>
  </div>
</template>

<style scoped>
.tvt-root {
  font-size: var(--fs);
  padding: 3px 0;
}

.tvt-plain,
.tvt-summary {
  display: flex;
  align-items: baseline;
  gap: 9px;
}

.tvt-summary {
  cursor: pointer;
  list-style: none;
  border-radius: 6px;
}

.tvt-summary::-webkit-details-marker {
  display: none;
}

.tvt-summary:hover .tvt-text {
  color: var(--fg);
}

.tvt-glyph {
  flex: none;
  font-size: 12px;
  color: var(--fg-muted);
  transform: translateY(-1px);
}

.tvt-text {
  font-family: var(--font);
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
  margin-left: auto;
  flex: none;
  font-family: var(--font);
  font-size: 12px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}

.tvt-detail {
  margin: 6px 0 4px 20px;
  padding: 9px 12px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--bg-hover);
  font-family: var(--font);
  font-size: 12px;
  line-height: 1.55;
  color: var(--fg-dim);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
