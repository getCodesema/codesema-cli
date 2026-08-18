<script setup lang="ts">
// Question card, maquette form: mono meta line, then an amber bubble — the
// state the semaphore doctrine reserves for "the human is the bottleneck".
// Opens BY ITSELF when it is the live question of a task in waiting_for_you
// (ctx.active). The reply field (and the quick-reply buttons) live in the
// conversation, which focuses the composer when the task waits.
import { computed } from 'vue'
import { firstString, splitInlineCode, timeAgo } from '../../composables/useTaskBoard'
import { t } from '../../i18n'
import type { TaskEventCtx } from '../../task-event-registry'
import type { TaskEvent, TaskRecord } from '../../types'

const props = defineProps<{ event: TaskEvent; task: TaskRecord; ctx: TaskEventCtx }>()

const question = computed(
  () => firstString(props.event.data, ['question', 'text', 'summary']) ?? t('workspace.evQuestion'),
)
const segments = computed(() => splitInlineCode(question.value))
const ago = computed(() => timeAgo(props.event.at, props.ctx.now))
</script>

<template>
  <div class="tvq-root">
    <p class="tvq-meta">
      <span
        >{{ t('workspace.agentLabel') }}<template v-if="ago"> · {{ ago }}</template></span
      >
      <span class="tvq-tag">{{ t('workspace.evQuestion') }}</span>
    </p>
    <p class="tvq-bubble" :class="{ 'tvq-bubble--active': ctx.active }">
      <template v-for="(segment, i) in segments" :key="i">
        <code v-if="segment.code" class="tvq-code">{{ segment.text }}</code>
        <template v-else>{{ segment.text }}</template>
      </template>
    </p>
    <p v-if="ctx.active" class="tvq-hint">{{ t('workspace.questionHint') }}</p>
  </div>
</template>

<style scoped>
.tvq-root {
  display: flex;
  flex-direction: column;
  gap: 7px;
  max-width: 85%;
  margin: 4px 0;
}

.tvq-meta {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--cs-ghost);
}

.tvq-tag {
  font-size: 8.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--cs-amber-text);
  background: var(--cs-amber-soft);
  padding: 2px 6px;
  border-radius: 4px;
}

/* Amber carries the state: this question blocks the task. */
.tvq-bubble {
  margin: 0;
  padding: 12px 14px;
  border: 1px solid var(--cs-amber-line);
  border-radius: 3px 10px 10px 10px;
  background: var(--cs-amber-card);
  font-size: 13px;
  line-height: 1.55;
  color: var(--cs-text);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-width: 0;
}

.tvq-bubble--active {
  box-shadow: 0 0 18px rgba(232, 196, 106, 0.07);
}

.tvq-code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--cs-amber-text);
  white-space: pre-wrap;
}

.tvq-hint {
  margin: 0;
  font-size: 12px;
  color: var(--cs-amber-text);
}
</style>
