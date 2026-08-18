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
    <!-- What the review actually said, before any click. -->
    <p v-if="summary" class="tvr-summary">{{ summary }}</p>
    <p v-if="count !== null" class="tvr-count">
      {{ t('workspace.findingsCount', { n: count }, count) }}
    </p>
    <ul v-if="severities.length > 0" class="tvr-sev">
      <li v-for="entry in severities" :key="entry.severity" :class="`tvr-sev--${entry.severity}`">
        {{ entry.n }} {{ t(SEVERITY_KEY[entry.severity]) }}
      </li>
    </ul>
    <div v-if="ctx.reviewAvailable || showFix" class="tvr-actions">
      <button v-if="ctx.reviewAvailable" class="tvr-btn" @click="emit('open-review', reviewRef)">
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

/* The review's own words: two lines max, the full text lives in the review. */
.tvr-summary {
  margin: 8px 0 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--cs-text);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}

.tvr-count {
  margin: 7px 0 0;
  font-size: 12.5px;
  color: var(--cs-text-2);
}

/* Severity spread: counts only, the semaphore carries the weight. */
.tvr-sev {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  list-style: none;
  margin: 7px 0 0;
  padding: 0;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.tvr-sev li {
  border-radius: 999px;
  padding: 2px 9px;
  color: var(--cs-muted);
  background: var(--cs-panel);
  border: 1px solid var(--cs-line-2);
}

/* Doubled specificity so the tone wins over the neutral chip above. */
.tvr-sev li.tvr-sev--critical,
.tvr-sev li.tvr-sev--major {
  color: var(--cs-red-text);
  border-color: var(--cs-red-line);
  background: var(--cs-red-soft);
}

.tvr-sev li.tvr-sev--minor {
  color: var(--cs-amber-text);
  border-color: var(--cs-amber-line);
  background: var(--cs-amber-soft);
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
