<script setup lang="ts">
// Agent message in the thread, maquette form: a mono meta line ("AGENT ·
// il y a X") over plain text; `inline code` spans render mono.
// This is what the agent SAID — body text, not a journal line.
import { computed } from 'vue'
import { eventSummary, firstString } from '../../composables/useTaskBoard'
import { t } from '../../i18n'
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
  <div class="tvm-root" :title="exact">
    <p class="tvm-meta">
      {{ t('workspace.agentLabel') }}<template v-if="ago"> · {{ ago }}</template>
    </p>
    <!-- eslint-disable-next-line vue/no-v-html — renderMarkdown escapes everything first -->
    <div class="tvm-bubble tvm-md md" v-html="html" />
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
  color: var(--fg);
  overflow-wrap: anywhere;
  min-width: 0;
}
</style>
