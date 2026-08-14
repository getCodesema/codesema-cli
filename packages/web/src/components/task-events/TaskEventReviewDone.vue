<script setup lang="ts">
// review_done card: verdict + findings count. When the archived record is
// loadable through the current server session, links to the full review view;
// otherwise offers "fix the findings", which prefills the (editable) reply
// composer of the conversation.
import { computed } from 'vue'
import {
  clockTime,
  findingsCount,
  firstString,
  verdictLabelKey,
} from '../../composables/useTaskBoard'
import { t } from '../../i18n'
import type { TaskEventCtx } from '../../task-event-registry'
import type { TaskEvent, TaskRecord } from '../../types'

const props = defineProps<{ event: TaskEvent; task: TaskRecord; ctx: TaskEventCtx }>()

const emit = defineEmits<{ 'open-review': []; fix: [] }>()

const verdictKey = computed(() => verdictLabelKey(props.event.data.verdict))
const verdictRaw = computed(() => firstString(props.event.data, ['verdict']))
const count = computed(() => findingsCount(props.event.data))
const stamp = computed(() => clockTime(props.event.at))

// The verdict chip follows the semaphore: pass green, block red, comment amber.
const verdictClass = computed(() => {
  if (props.event.data.verdict === 'approve') {
    return 'tvr-verdict--go'
  }
  if (props.event.data.verdict === 'request_changes') {
    return 'tvr-verdict--stop'
  }
  return 'tvr-verdict--check'
})

const showFix = computed(() => (count.value ?? 0) > 0 || props.task.status === 'review_ko')
</script>

<template>
  <div class="tvr-root">
    <div class="tvr-head">
      <span class="tvr-tag">{{ t('workspace.evReviewDone') }}</span>
      <span v-if="verdictKey || verdictRaw" class="tvr-verdict" :class="verdictClass">
        {{ verdictKey ? t(verdictKey) : verdictRaw }}
      </span>
      <span class="tvr-time">{{ stamp }}</span>
    </div>
    <p v-if="count !== null" class="tvr-count">
      {{ t('workspace.findingsCount', { n: count }, count) }}
    </p>
    <div v-if="ctx.reviewAvailable || showFix" class="tvr-actions">
      <button v-if="ctx.reviewAvailable" class="tvr-btn" @click="emit('open-review')">
        {{ t('workspace.openReview') }}
      </button>
      <button v-if="showFix" class="tvr-btn" @click="emit('fix')">
        {{ t('workspace.fixFindings') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.tvr-root {
  margin: 6px 0;
  padding: 12px 14px;
  border: 1px solid var(--cs-line-2);
  border-radius: 11px;
  background: var(--cs-surface);
}

.tvr-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.tvr-tag {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--cs-muted);
}

.tvr-verdict {
  font-size: 11px;
  font-weight: 600;
  border-radius: 999px;
  padding: 2px 10px;
}

.tvr-verdict--go {
  color: var(--cs-green-text);
  background: var(--cs-green-soft);
}

.tvr-verdict--stop {
  color: var(--cs-red-text);
  background: var(--cs-red-soft);
}

.tvr-verdict--check {
  color: var(--cs-amber-text);
  background: var(--cs-amber-soft);
}

.tvr-time {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--cs-ghost);
  font-variant-numeric: tabular-nums;
}

.tvr-count {
  margin: 7px 0 0;
  font-size: 12.5px;
  color: var(--cs-text-2);
}

.tvr-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.tvr-btn {
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  padding: 5px 11px;
  border-radius: 8px;
  border: 1px solid var(--cs-line-2);
  background: var(--cs-surface);
  color: var(--cs-text-2);
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.tvr-btn:hover {
  border-color: var(--cs-muted);
}
</style>
