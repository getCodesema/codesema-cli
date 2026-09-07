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
  font-family: var(--font);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--fg-muted);
}

.tvm-bubble {
  margin: 0;
  padding: 11px 13px;
  border: 1px solid var(--line);
  border-radius: 3px 10px 10px 10px;
  background: var(--bg-raised);
  font-size: var(--fs);
  line-height: 1.55;
  color: var(--fg);
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
  font-size: var(--fs);
  font-weight: 700;
  color: var(--fg);
}

.tvm-md :deep(h2:first-child),
.tvm-md :deep(h3:first-child) {
  margin-top: 0;
}

.tvm-md :deep(h3) {
  font-size: var(--fs);
}

.tvm-md :deep(ul),
.tvm-md :deep(ol) {
  padding-left: 20px;
}

.tvm-md :deep(li) {
  margin: 2px 0;
}

.tvm-md :deep(code) {
  font-family: var(--font);
  font-size: 12px;
  color: var(--ok);
  white-space: pre-wrap;
}

.tvm-md :deep(pre) {
  padding: 9px 11px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--bg-raised);
  overflow-x: auto;
}

.tvm-md :deep(pre code) {
  color: var(--fg);
}

.tvm-md :deep(a) {
  color: var(--ok);
}
</style>
