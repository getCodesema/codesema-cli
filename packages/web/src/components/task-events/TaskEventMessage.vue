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
  gap: 7px;
  max-width: 85%;
  margin: 4px 0;
}

.tvm-meta {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--cs-ghost);
}

.tvm-bubble {
  margin: 0;
  padding: 11px 13px;
  border: 1px solid var(--cs-line-2);
  border-radius: 3px 10px 10px 10px;
  background: var(--cs-surface);
  font-size: 13px;
  line-height: 1.55;
  color: var(--cs-text);
  overflow-wrap: anywhere;
  min-width: 0;
}

/* Rendered markdown: quiet document rhythm inside a chat bubble. */
.tvm-md :deep(p),
.tvm-md :deep(ul),
.tvm-md :deep(ol),
.tvm-md :deep(pre) {
  margin: 0 0 8px;
}

.tvm-md :deep(:last-child) {
  margin-bottom: 0;
}

.tvm-md :deep(h2),
.tvm-md :deep(h3) {
  margin: 12px 0 6px;
  font-size: 13.5px;
  font-weight: 700;
  color: var(--cs-text);
}

.tvm-md :deep(h2:first-child),
.tvm-md :deep(h3:first-child) {
  margin-top: 0;
}

.tvm-md :deep(h3) {
  font-size: 12.5px;
}

.tvm-md :deep(ul),
.tvm-md :deep(ol) {
  padding-left: 20px;
}

.tvm-md :deep(li) {
  margin: 2px 0;
}

.tvm-md :deep(code) {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--cs-green-text);
  white-space: pre-wrap;
}

.tvm-md :deep(pre) {
  padding: 9px 11px;
  border: 1px solid var(--cs-line-2);
  border-radius: 8px;
  background: var(--cs-inset);
  overflow-x: auto;
}

.tvm-md :deep(pre code) {
  color: var(--cs-text);
}

.tvm-md :deep(a) {
  color: var(--cs-green-hover);
}
</style>
