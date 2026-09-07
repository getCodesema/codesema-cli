<script setup lang="ts">
// Metadata rail of one merge request: auto-review, reviewers, assignees,
// labels, milestone, branches, changes, dates. Presentational only, props in,
// nothing fetched. Every section but auto-review disappears when it has
// nothing to show; auto-review is the one exception (see below).
import {
  ChevronDown,
  CircleCheck,
  Clock,
  Eye,
  FileDiff,
  GitBranch,
  Milestone,
  ShieldCheck,
  Tag,
  UserRound,
} from '@lucide/vue'
import { computed, ref } from 'vue'
import { t, type MessageKey } from '../../i18n'
import { formatRelativeAge } from '../../relative-time'
import type { ForgeMr } from '../../types'
import { labelPillStyle } from '../forge/LabelColor'
import { aggregateCheckStatus, type CheckAggregateStatus, type CheckBucket } from './Checks'

const props = defineProps<{ mr: ForgeMr }>()

/** Rendered in place of a numeric metric this forge did not report: never a
 * zero, which would read as a measured value. Not an em dash (banned project
 * wide), an en dash instead. */
const UNKNOWN_METRIC = '–'

const labels = computed(() => props.mr.labels)
const reviewers = computed(() => props.mr.reviewers)
const assignees = computed(() => props.mr.assignees)
const milestone = computed(() => props.mr.milestone)
const mergeable = computed(() => props.mr.mergeable)
const checks = computed(() => props.mr.checks)

const hasChanges = computed(
  () =>
    props.mr.changedFiles !== null ||
    props.mr.additions !== null ||
    props.mr.deletions !== null ||
    props.mr.commits !== null ||
    mergeable.value !== null,
)

const updatedAge = computed(() => formatRelativeAge(props.mr.updatedAt))

type AutoReview =
  | { kind: 'unavailable' }
  | { kind: 'none' }
  | { kind: 'aggregate'; status: CheckAggregateStatus }
  | {
      kind: 'detailed'
      passed: number
      rest: { bucket: Exclude<CheckBucket, 'passed'>; count: number }[]
    }

/**
 * `checks === null` and "every bucket at zero" are TWO DIFFERENT facts,
 * "we don't know" versus "we know and it's nothing", so this section is the
 * one exception to the null-hides-the-section rule: it always renders one of
 * its four states rather than disappearing.
 */
const autoReview = computed<AutoReview>(() => {
  const rollup = checks.value
  if (rollup === null) {
    return { kind: 'unavailable' }
  }
  if (rollup.truncated) {
    return { kind: 'aggregate', status: aggregateCheckStatus(rollup) }
  }
  if (rollup.passed === 0 && rollup.failed === 0 && rollup.pending === 0 && rollup.skipped === 0) {
    return { kind: 'none' }
  }
  const rest = (['failed', 'pending', 'skipped'] as const)
    .map((bucket) => ({ bucket, count: rollup[bucket] }))
    .filter((entry) => entry.count > 0)
  return { kind: 'detailed', passed: rollup.passed, rest }
})

/** The passed count starts folded behind a disclosure button: failures and
 * pending checks need the reader's attention and are spelled out in full,
 * good news does not. Reset is not tracked across a prop change: switching
 * the selected MR remounts this component (see ForgeDetailPanel.vue). */
const passedOpen = ref(false)

const MERGEABLE_LABEL_KEYS: Record<NonNullable<ForgeMr['mergeable']>, MessageKey> = {
  mergeable: 'mrs.rail.mergeableStateOk',
  conflicting: 'mrs.rail.mergeableStateConflicting',
  unknown: 'mrs.rail.mergeableStateUnknown',
}

const CHECK_LABEL_KEYS: Record<CheckBucket, MessageKey> = {
  passed: 'mrs.checks.passed',
  failed: 'mrs.checks.failed',
  pending: 'mrs.checks.pending',
  skipped: 'mrs.checks.skipped',
}

/** The kit's own status vocabulary, so the aggregate dot is the same dot every
 * other running/done/failed signal uses. */
const CHECK_DOT_STATE: Record<CheckAggregateStatus, string> = {
  passed: 'done',
  failed: 'error',
  pending: 'running',
  skipped: 'idle',
  unknown: 'idle',
}

const AGGREGATE_LABEL_KEYS: Record<CheckAggregateStatus, MessageKey> = {
  passed: 'mrs.checks.aggregatePassed',
  failed: 'mrs.checks.aggregateFailed',
  pending: 'mrs.checks.aggregatePending',
  skipped: 'mrs.checks.aggregateSkipped',
  unknown: 'mrs.checks.aggregateUnknown',
}
</script>

<template>
  <div class="mrr-root">
    <section class="mrr-section">
      <h3 class="mrr-heading">
        <ShieldCheck class="mrr-heading-icon" aria-hidden="true" />
        <span>{{ t('mrs.rail.autoReview') }}</span>
      </h3>
      <p v-if="autoReview.kind === 'unavailable'" class="mrr-empty">
        {{ t('mrs.rail.autoReviewUnavailable') }}
      </p>
      <p v-else-if="autoReview.kind === 'none'" class="mrr-empty">
        {{ t('mrs.rail.autoReviewNone') }}
      </p>
      <div v-else-if="autoReview.kind === 'aggregate'" class="mrr-checks-aggregate">
        <span
          class="mrr-checks-dot status"
          :class="`mrr-checks-dot--${autoReview.status}`"
          :data-s="CHECK_DOT_STATE[autoReview.status]"
          aria-hidden="true"
        />
        <span
          >{{ t(AGGREGATE_LABEL_KEYS[autoReview.status]) }} · {{ t('mrs.checks.partial') }}</span
        >
      </div>
      <div v-else class="mrr-checks-detailed">
        <div v-if="autoReview.rest.length > 0" class="mrr-check-group">
          <h4 class="mrr-check-group-heading">{{ t('mrs.rail.autoReviewAttention') }}</h4>
          <div class="mrr-check-entries">
            <span
              v-for="entry in autoReview.rest"
              :key="entry.bucket"
              class="mrr-check-entry"
              :class="`mrr-check-entry--${entry.bucket}`"
              >{{ t(CHECK_LABEL_KEYS[entry.bucket], { n: entry.count }, entry.count) }}</span
            >
          </div>
        </div>
        <div class="mrr-check-group">
          <h4 class="mrr-check-group-heading">{{ t('mrs.rail.autoReviewPassedGroup') }}</h4>
          <button
            type="button"
            class="mrr-check-passed check-row"
            data-s="passed"
            :aria-expanded="passedOpen"
            :aria-label="t('mrs.checks.passed', { n: autoReview.passed }, autoReview.passed)"
            @click="passedOpen = !passedOpen"
          >
            <CircleCheck class="mrr-check-passed-icon" aria-hidden="true" />
            <span aria-hidden="true">{{
              passedOpen
                ? t('mrs.checks.passed', { n: autoReview.passed }, autoReview.passed)
                : String(autoReview.passed)
            }}</span>
            <ChevronDown
              class="mrr-chevron"
              :class="{ 'mrr-chevron--closed': !passedOpen }"
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
    </section>

    <section v-if="reviewers !== null" class="mrr-section">
      <h3 class="mrr-heading">
        <Eye class="mrr-heading-icon" aria-hidden="true" />
        <span>{{ t('mrs.rail.reviewers') }}</span>
      </h3>
      <p v-if="reviewers.length === 0" class="mrr-empty">{{ t('mrs.rail.reviewersEmpty') }}</p>
      <ul v-else class="mrr-chips">
        <li v-for="name in reviewers" :key="name" class="mrr-chip">{{ name }}</li>
      </ul>
    </section>

    <section v-if="assignees !== null" class="mrr-section">
      <h3 class="mrr-heading">
        <UserRound class="mrr-heading-icon" aria-hidden="true" />
        <span>{{ t('mrs.rail.assignees') }}</span>
      </h3>
      <p v-if="assignees.length === 0" class="mrr-empty">{{ t('mrs.rail.assigneesEmpty') }}</p>
      <ul v-else class="mrr-chips">
        <li v-for="name in assignees" :key="name" class="mrr-chip">{{ name }}</li>
      </ul>
    </section>

    <section v-if="labels !== null" class="mrr-section">
      <h3 class="mrr-heading">
        <Tag class="mrr-heading-icon" aria-hidden="true" />
        <span>{{ t('mrs.rail.labels') }}</span>
      </h3>
      <p v-if="labels.length === 0" class="mrr-empty">{{ t('mrs.rail.labelsEmpty') }}</p>
      <ul v-else class="mrr-chips">
        <li
          v-for="label in labels"
          :key="label.name"
          class="mrr-label-chip"
          :style="labelPillStyle(label.color)"
        >
          {{ label.name }}
        </li>
      </ul>
    </section>

    <section v-if="milestone !== null" class="mrr-section">
      <h3 class="mrr-heading">
        <Milestone class="mrr-heading-icon" aria-hidden="true" />
        <span>{{ t('mrs.rail.milestone') }}</span>
      </h3>
      <p class="mrr-value">{{ milestone }}</p>
    </section>

    <section class="mrr-section">
      <h3 class="mrr-heading">
        <GitBranch class="mrr-heading-icon" aria-hidden="true" />
        <span>{{ t('mrs.rail.branches') }}</span>
      </h3>
      <dl class="mrr-defs kvs">
        <dt>{{ t('mrs.detailSource') }}</dt>
        <dd class="mrr-branch">{{ mr.sourceBranch }}</dd>
        <dt>{{ t('mrs.detailTarget') }}</dt>
        <dd class="mrr-branch">{{ mr.targetBranch }}</dd>
      </dl>
    </section>

    <section v-if="hasChanges" class="mrr-section">
      <h3 class="mrr-heading">
        <FileDiff class="mrr-heading-icon" aria-hidden="true" />
        <span>{{ t('mrs.rail.changes') }}</span>
      </h3>
      <dl class="mrr-defs kvs">
        <dt>{{ t('mrs.rail.changesFiles') }}</dt>
        <dd>{{ mr.changedFiles ?? UNKNOWN_METRIC }}</dd>
        <dt>{{ t('mrs.rail.changesAdditions') }}</dt>
        <dd class="mrr-def-add">
          {{ mr.additions !== null ? `+${mr.additions}` : UNKNOWN_METRIC }}
        </dd>
        <dt>{{ t('mrs.rail.changesDeletions') }}</dt>
        <dd class="mrr-def-del">
          {{ mr.deletions !== null ? `−${mr.deletions}` : UNKNOWN_METRIC }}
        </dd>
        <dt>{{ t('mrs.rail.changesCommits') }}</dt>
        <dd>{{ mr.commits ?? UNKNOWN_METRIC }}</dd>
        <template v-if="mergeable !== null">
          <dt>{{ t('mrs.rail.changesMergeable') }}</dt>
          <dd class="mrr-mergeable-text" :class="`mrr-mergeable-text--${mergeable}`">
            {{ t(MERGEABLE_LABEL_KEYS[mergeable]) }}
          </dd>
        </template>
      </dl>
    </section>

    <section class="mrr-section">
      <h3 class="mrr-heading">
        <Clock class="mrr-heading-icon" aria-hidden="true" />
        <span>{{ t('mrs.rail.dates') }}</span>
      </h3>
      <p class="mrr-value">{{ t('mrs.rail.updatedAt', { age: updatedAge }) }}</p>
    </section>
  </div>
</template>

<style scoped>
.mrr-root {
  display: flex;
  flex-direction: column;
}

.mrr-section {
  padding-bottom: var(--row);
  margin-bottom: var(--row);
  border-bottom: 1px solid var(--line);
}

.mrr-section:last-child {
  padding-bottom: 0;
  margin-bottom: 0;
  border-bottom: none;
}

.mrr-heading {
  display: flex;
  align-items: center;
  gap: 1ch;
  margin: 0 0 calc(var(--row) / 2);
}

.mrr-heading-icon {
  flex: none;
  width: 14px;
  height: 14px;
}

.mrr-empty {
  margin: 0;
  color: var(--fg-dim);
}

.mrr-value {
  margin: 0;
  color: var(--fg);
}

.mrr-chips {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 1ch;
}

.mrr-chip {
  color: var(--fg-dim);
  background: var(--bg-raised);
  border: 1px solid var(--line);
  padding: 0 1ch;
}

/* Non-interactive compact pill: same fill family as LabelChips' rest state
   (see LabelColor.ts), theme tokens only. Kept apart from .mrr-chip above
   (reviewers, assignees), which never carries a forge color. */
.mrr-label-chip {
  --lp-rest-bg: var(--line);

  color: var(--fg-dim);
  padding: 0 1ch;
  border: 1px solid var(--line);
  background: var(--lp-rest-bg);
}

.mrr-defs dd {
  font-variant-numeric: tabular-nums;
  color: var(--fg);
  text-align: right;
}

.mrr-branch {
  overflow-wrap: anywhere;
}

.mrr-def-add {
  color: var(--ok);
}

.mrr-def-del {
  color: var(--err);
}

.mrr-mergeable-text--mergeable {
  color: var(--ok);
}

.mrr-mergeable-text--conflicting {
  color: var(--err);
}

.mrr-mergeable-text--unknown {
  color: var(--warn);
}

.mrr-checks-aggregate {
  display: flex;
  align-items: center;
  gap: 1ch;
  color: var(--fg-dim);
}

.mrr-checks-dot {
  flex-shrink: 0;
}

.mrr-checks-detailed {
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
}

.mrr-check-group-heading {
  margin: 0 0 2px;
  font-size: 12px;
  font-weight: 400;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-dim);
}

.mrr-check-entries {
  display: flex;
  flex-wrap: wrap;
  gap: 2ch;
}

.mrr-check-entry--failed {
  color: var(--err);
}

.mrr-check-entry--pending {
  color: var(--warn);
}

.mrr-check-entry--skipped {
  color: var(--fg-dim);
}

/* The kit check row, sized to its content: one passed tally, not a full
   width table row. */
.mrr-check-passed {
  display: inline-grid;
  grid-template-columns: repeat(3, auto);
  gap: 1ch;
  width: max-content;
  font: inherit;
  color: var(--ok);
  background: transparent;
  cursor: pointer;
}

.mrr-check-passed:hover {
  background: var(--bg-hover);
}

.mrr-check-passed-icon {
  flex: none;
  width: 14px;
  height: 14px;
}

.mrr-chevron {
  flex: none;
  width: 14px;
  height: 14px;
  transition: transform 150ms ease;
}

.mrr-chevron--closed {
  transform: rotate(-90deg);
}
</style>
