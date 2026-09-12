<script setup lang="ts">
// Agent message in the thread: plain text on its own row, no card and no
// who-gutter chrome. `inline code` spans render mono via base.css.
// This is what the agent SAID — body text, not a journal line.
import { computed } from 'vue'
import { eventSummary, firstString } from '../../composables/useTaskBoard'
import { renderMarkdown } from '../../markdown'
import { formatExactStamp, formatRelativeAge } from '../../relative-time'
import type { TaskEventCtx } from '../../task-event-registry'
import type { TaskEvent, TaskRecord } from '../../types'

const props = defineProps<{ event: TaskEvent; task: TaskRecord; ctx: TaskEventCtx }>()

// The full turn response when the record carries it (the journal payload is a
// bounded preview that can end mid-sentence), else the preview.
const text = computed(
  () =>
    props.ctx.fullText ??
    firstString(props.event.data, ['text', 'preview', 'summary', 'message']) ??
    eventSummary(props.event),
)
// renderMarkdown escapes ALL input before transforming: safe for v-html.
const html = computed(() => renderMarkdown(text.value))
const ago = computed(() => formatRelativeAge(props.event.at, props.ctx.now))
const exact = computed(() => formatExactStamp(props.event.at))
</script>

<template>
  <div class="tvm-root msg" :title="exact || ago || undefined">
    <!-- eslint-disable-next-line vue/no-v-html — renderMarkdown escapes everything first -->
    <div class="tvm-bubble tvm-md md body" v-html="html" />
  </div>
</template>

<style scoped>
.tvm-root {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  max-width: 72ch;
  /* Agent: plain text on its own row — no card, no frame. */
  background: transparent;
  border: 0;
  padding: 0;
}

.tvm-bubble {
  margin: 0;
  color: var(--fg);
  overflow-wrap: anywhere;
  min-width: 0;
  background: transparent;
  border: 0;
}
</style>
