<script setup lang="ts">
// review_done card: what the review of THIS turn actually said — verdict,
// findings count, the summary line and the severity spread it carries. "Open
// the review" opens that turn's own archive (the ref in the payload), and
// "fix the findings" prefills the (editable) reply composer of the
// conversation.
import { computed } from 'vue'
import {
  clockTime,
  findingsCount,
  firstString,
  reviewRefOf,
  severityBreakdown,
  verdictLabelKey,
} from '../../composables/useTaskBoard'
import { t } from '../../i18n'
import type { TaskEventCtx } from '../../task-event-registry'
import type { TaskEvent, TaskRecord } from '../../types'

const props = defineProps<{ event: TaskEvent; task: TaskRecord; ctx: TaskEventCtx }>()

/** The archive to open, or null: the conversation then falls back to the
 * task's current review_ref. */
const emit = defineEmits<{ 'open-review': [ref: string | null]; fix: [] }>()

const verdictKey = computed(() => verdictLabelKey(props.event.data.verdict))
const verdictRaw = computed(() => firstString(props.event.data, ['verdict']))
const count = computed(() => findingsCount(props.event.data))
const stamp = computed(() => clockTime(props.event.at))
const summary = computed(() => firstString(props.event.data, ['summary']))
const severities = computed(() => severityBreakdown(props.event.data))
const reviewRef = computed(() => reviewRefOf(props.event.data))

/** Same labels as the review view's notes: one vocabulary for one severity. */
const SEVERITY_KEY = {
  critical: 'diffView.sevCritical',
  major: 'diffView.sevMajor',
  minor: 'diffView.sevMinor',
  info: 'diffView.sevInfo',
} as const

// The verdict chip follows the semaphore: pass green, block red, comment amber.
const verdictValue = computed(() => {
  if (props.event.data.verdict === 'approve') {
    return 'go'
  }
  if (props.event.data.verdict === 'request_changes') {
    return 'stop'
  }
  return 'check'
})

const showFix = computed(() => (count.value ?? 0) > 0 || props.task.status === 'review_ko')
</script>

<template>
  <div class="tvr-root" :data-v="verdictValue">
    <div class="tvr-head">
      <span class="tvr-tag">{{ t('workspace.evReviewDone') }}</span>
      <span v-if="verdictKey || verdictRaw" class="tvr-verdict verdict" :data-v="verdictValue">
        {{ verdictKey ? t(verdictKey) : verdictRaw }}
      </span>
      <span class="tvr-time">{{ stamp }}</span>
    </div>
    <!-- What the review actually said, before any click. -->
    <p v-if="summary" class="tvr-summary">{{ summary }}</p>
    <p v-if="count !== null" class="tvr-count">
      {{ t('workspace.findingsCount', { n: count }, count) }}
    </p>
    <ul v-if="severities.length > 0" class="tvr-sev">
      <li
        v-for="entry in severities"
        :key="entry.severity"
        class="tvr-sev-item sev"
        :data-v="entry.severity"
      >
        {{ entry.n }} {{ t(SEVERITY_KEY[entry.severity]) }}
      </li>
    </ul>
    <div v-if="ctx.reviewAvailable || showFix" class="tvr-actions">
      <button
        v-if="ctx.reviewAvailable"
        class="tvr-btn btn"
        @click="emit('open-review', reviewRef)"
      >
        {{ t('workspace.openReview') }}
      </button>
      <button v-if="showFix" class="tvr-btn btn" @click="emit('fix')">
        {{ t('workspace.fixFindings') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Not a box: the verdict's own colour on a left rail, like every other block
   of the thread. */
.tvr-root {
  padding-left: 1ch;
  border-left: 2px solid var(--line);
}

.tvr-root[data-v='go'] {
  border-left-color: var(--ok);
}

.tvr-root[data-v='check'] {
  border-left-color: var(--warn);
}

.tvr-root[data-v='stop'] {
  border-left-color: var(--err);
}

.tvr-head {
  display: flex;
  align-items: baseline;
  gap: 2ch;
}

.tvr-tag {
  font-size: 12px;
  text-transform: uppercase;
  color: var(--fg-dim);
}

.tvr-time {
  margin-left: auto;
  font-size: 12px;
  color: var(--fg-muted);
  font-variant-numeric: tabular-nums;
}

/* The review's own words: two lines max, the full text lives in the review. */
.tvr-summary {
  margin: calc(var(--row) / 2) 0 0;
  color: var(--fg);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}

.tvr-count {
  margin: calc(var(--row) / 2) 0 0;
  color: var(--fg-dim);
}

/* Severity spread: counts only, the semaphore carries the weight. */
.tvr-sev {
  display: flex;
  flex-wrap: wrap;
  gap: 2ch;
  list-style: none;
  margin: calc(var(--row) / 2) 0 0;
  padding: 0;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.tvr-actions {
  display: flex;
  gap: 1ch;
  margin-top: calc(var(--row) / 2);
}

.tvr-btn {
  font-size: 12px;
  color: var(--fg-dim);
}

.tvr-btn:hover {
  color: var(--fg);
}
</style>
