<script setup lang="ts">
// Agent message in the thread, maquette form: a mono meta line ("AGENT ·
// il y a X") over a discreet warm bubble; `inline code` spans render mono.
// This is what the agent SAID — body text, not a journal line.
import { computed } from 'vue'
import { eventSummary, firstString, timeAgo } from '../../composables/useTaskBoard'
import { t } from '../../i18n'
import { renderMarkdown } from '../../markdown'
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
const ago = computed(() => timeAgo(props.event.at, props.ctx.now))
</script>

<template>
  <div class="tvm-root">
    <p class="tvm-meta">
      {{ t('workspace.agentLabel') }}<template v-if="ago"> · {{ ago }}</template>
    </p>
    <!-- eslint-disable-next-line vue/no-v-html — renderMarkdown escapes everything first -->
    <div class="tvm-bubble tvm-md" v-html="html" />
  </div>
</template>

<style scoped>
.tvm-root {
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
  max-width: 85%;
}

.tvm-meta {
  margin: 0;
  font-size: 12px;
  text-transform: uppercase;
  color: var(--fg-muted);
}

.tvm-bubble {
  margin: 0;
  padding: calc(var(--row) / 2) 1ch;
  border: 1px solid var(--line);
  background: var(--bg-raised);
  color: var(--fg);
  overflow-wrap: anywhere;
  min-width: 0;
}

/* Rendered markdown: quiet document rhythm inside a chat bubble. */
.tvm-md :deep(p),
.tvm-md :deep(ul),
.tvm-md :deep(ol),
.tvm-md :deep(pre) {
  margin: 0 0 calc(var(--row) / 2);
}

.tvm-md :deep(:last-child) {
  margin-bottom: 0;
}

.tvm-md :deep(h2),
.tvm-md :deep(h3) {
  margin: var(--row) 0 calc(var(--row) / 2);
  font-size: var(--fs);
  font-weight: 700;
  color: var(--fg);
}

.tvm-md :deep(h2:first-child),
.tvm-md :deep(h3:first-child) {
  margin-top: 0;
}

.tvm-md :deep(ul),
.tvm-md :deep(ol) {
  padding-left: 3ch;
}

.tvm-md :deep(li) {
  margin: 2px 0;
}

.tvm-md :deep(code) {
  font-size: 12px;
  color: var(--ok);
  background: none;
  padding: 0;
  white-space: pre-wrap;
}

.tvm-md :deep(pre) {
  padding: calc(var(--row) / 2) 1ch;
  border: 1px solid var(--line);
  background: var(--bg-raised);
  overflow-x: auto;
}

.tvm-md :deep(pre code) {
  color: var(--fg);
}

.tvm-md :deep(a) {
  color: var(--accent);
}
</style>
