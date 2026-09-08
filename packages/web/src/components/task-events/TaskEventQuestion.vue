<script setup lang="ts">
// Question card, maquette form: mono meta line, then an amber-railed block — the
// state the semaphore doctrine reserves for "the human is the bottleneck".
// Opens BY ITSELF when it is the live question of a task in waiting_for_you
// (ctx.active). The reply field (and the quick-reply buttons) live in the
// conversation, which focuses the composer when the task waits.
import { computed } from 'vue'
import { firstString, splitInlineCode } from '../../composables/useTaskBoard'
import { t } from '../../i18n'
import { formatExactStamp, formatRelativeAge } from '../../relative-time'
import type { TaskEventCtx } from '../../task-event-registry'
import type { TaskEvent, TaskRecord } from '../../types'

const props = defineProps<{ event: TaskEvent; task: TaskRecord; ctx: TaskEventCtx }>()

const question = computed(
  () => firstString(props.event.data, ['question', 'text', 'summary']) ?? t('workspace.evQuestion'),
)
const segments = computed(() => splitInlineCode(question.value))
const ago = computed(() => formatRelativeAge(props.event.at, props.ctx.now))
const exact = computed(() => formatExactStamp(props.event.at))
</script>

<template>
  <div class="tvq-root" :title="exact">
    <p class="tvq-meta">
      <span
        >{{ t('workspace.agentLabel') }}<template v-if="ago"> · {{ ago }}</template></span
      >
      <span class="tvq-tag badge" data-tone="warn">{{ t('workspace.evQuestion') }}</span>
    </p>
    <p class="tvq-bubble question" :class="{ 'tvq-bubble--active': ctx.active }">
      <span class="tvq-text q">
        <template v-for="(segment, i) in segments" :key="i">
          <code v-if="segment.code" class="tvq-code">{{ segment.text }}</code>
          <template v-else>{{ segment.text }}</template>
        </template>
      </span>
    </p>
    <p v-if="ctx.active" class="tvq-hint">{{ t('workspace.questionHint') }}</p>
  </div>
</template>

<style scoped>
.tvq-root {
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
  max-width: 85%;
}

.tvq-meta {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 1ch;
  font-size: 12px;
  text-transform: uppercase;
  color: var(--fg-muted);
}

/* Amber carries the state: this question blocks the task. The kit's boxed
   `.question` is flattened here to the left rail the thread reads by. */
.tvq-bubble {
  margin: 0;
  border: 0;
  border-left: 2px solid var(--warn);
  padding: 0 0 0 1ch;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  min-width: 0;
}

/* The live question — the one the composer is waiting on — thickens its rail;
   answered ones keep the thin one. */
.tvq-bubble--active {
  border-left-width: 3px;
}

.tvq-code {
  font-size: 12px;
  color: var(--warn);
  background: none;
  padding: 0;
  white-space: pre-wrap;
}

.tvq-hint {
  margin: 0;
  font-size: 12px;
  color: var(--warn);
}
</style>
