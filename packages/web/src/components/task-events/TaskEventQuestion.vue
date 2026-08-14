<script setup lang="ts">
// Question card. Opens BY ITSELF when it is the live question of a task in
// waiting_for_you (ctx.active): amber border + wash, the state the semaphore
// doctrine reserves for "the human is the bottleneck". The reply field itself
// lives in the conversation's composer, which focuses when the task waits.
import { computed } from 'vue'
import { clockTime, firstString } from '../../composables/useTaskBoard'
import { t } from '../../i18n'
import type { TaskEventCtx } from '../../task-event-registry'
import type { TaskEvent, TaskRecord } from '../../types'

const props = defineProps<{ event: TaskEvent; task: TaskRecord; ctx: TaskEventCtx }>()

const question = computed(
  () => firstString(props.event.data, ['question', 'text', 'summary']) ?? t('workspace.evQuestion'),
)
const stamp = computed(() => clockTime(props.event.at))
</script>

<template>
  <div class="tvq-root" :class="{ 'tvq-root--active': ctx.active }">
    <div class="tvq-head">
      <span class="tvq-tag">{{ t('workspace.evQuestion') }}</span>
      <span class="tvq-time">{{ stamp }}</span>
    </div>
    <p class="tvq-text">{{ question }}</p>
    <p v-if="ctx.active" class="tvq-hint">{{ t('workspace.questionHint') }}</p>
  </div>
</template>

<style scoped>
.tvq-root {
  margin: 6px 0;
  padding: 12px 14px;
  border: 1px solid var(--sema-line-card);
  border-radius: 11px;
  background: var(--sema-card);
}

/* Colored border = the element carries a state: this question blocks the task. */
.tvq-root--active {
  border-color: var(--sema-amber);
  background: var(--sema-amber-soft);
}

.tvq-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}

.tvq-tag {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--sema-amber-text);
}

.tvq-time {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--sema-ink-ghost);
  font-variant-numeric: tabular-nums;
}

.tvq-text {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.6;
  color: var(--sema-ink);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.tvq-hint {
  margin: 8px 0 0;
  font-size: 12px;
  color: var(--sema-amber-text);
}
</style>
