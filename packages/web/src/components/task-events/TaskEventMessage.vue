<script setup lang="ts">
// Agent message in the thread, maquette form: a mono meta line ("AGENT ·
// il y a X") over a discreet warm bubble; `inline code` spans render mono.
// This is what the agent SAID — body text, not a journal line.
import { computed } from 'vue'
import { eventSummary, firstString, splitInlineCode, timeAgo } from '../../composables/useTaskBoard'
import { t } from '../../i18n'
import type { TaskEventCtx } from '../../task-event-registry'
import type { TaskEvent, TaskRecord } from '../../types'

const props = defineProps<{ event: TaskEvent; task: TaskRecord; ctx: TaskEventCtx }>()

const text = computed(
  () =>
    firstString(props.event.data, ['text', 'preview', 'summary', 'message']) ??
    eventSummary(props.event),
)
const segments = computed(() => splitInlineCode(text.value))
const ago = computed(() => timeAgo(props.event.at, props.ctx.now))
</script>

<template>
  <div class="tvm-root">
    <p class="tvm-meta">
      {{ t('workspace.agentLabel') }}<template v-if="ago"> · {{ ago }}</template>
    </p>
    <p class="tvm-bubble">
      <template v-for="(segment, i) in segments" :key="i">
        <code v-if="segment.code" class="tvm-code">{{ segment.text }}</code>
        <template v-else>{{ segment.text }}</template>
      </template>
    </p>
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
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-width: 0;
}

.tvm-code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--cs-green-text);
  white-space: pre-wrap;
}
</style>
