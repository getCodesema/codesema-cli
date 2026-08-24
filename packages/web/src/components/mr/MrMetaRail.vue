<script setup lang="ts">
// Metadata rail of one merge request: labels, reviewers, assignees,
// milestone, mergeable, commits, auto-review. Presentational only, props in,
// nothing fetched. Every section but auto-review disappears when its field is
// `null` (unknown); auto-review is the one exception (see below).
import { computed } from 'vue'
import { t, type MessageKey } from '../../i18n'
import type { ForgeMr } from '../../types'
import { labelPillStyle } from '../forge/LabelColor'
import { aggregateCheckStatus, type CheckAggregateStatus, type CheckBucket } from './Checks'

const props = defineProps<{ mr: ForgeMr }>()

const labels = computed(() => props.mr.labels)
const reviewers = computed(() => props.mr.reviewers)
const assignees = computed(() => props.mr.assignees)
const milestone = computed(() => props.mr.milestone)
const mergeable = computed(() => props.mr.mergeable)
const commits = computed(() => props.mr.commits)
const checks = computed(() => props.mr.checks)

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
    <section v-if="labels !== null" class="mrr-section">
      <h3 class="mrr-heading">{{ t('mrs.rail.labels') }}</h3>
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

    <section v-if="reviewers !== null" class="mrr-section">
      <h3 class="mrr-heading">{{ t('mrs.rail.reviewers') }}</h3>
      <p v-if="reviewers.length === 0" class="mrr-empty">{{ t('mrs.rail.reviewersEmpty') }}</p>
      <ul v-else class="mrr-chips">
        <li v-for="name in reviewers" :key="name" class="mrr-chip">{{ name }}</li>
      </ul>
    </section>

    <section v-if="assignees !== null" class="mrr-section">
      <h3 class="mrr-heading">{{ t('mrs.rail.assignees') }}</h3>
      <p v-if="assignees.length === 0" class="mrr-empty">{{ t('mrs.rail.assigneesEmpty') }}</p>
      <ul v-else class="mrr-chips">
        <li v-for="name in assignees" :key="name" class="mrr-chip">{{ name }}</li>
      </ul>
    </section>

    <section v-if="milestone !== null" class="mrr-section">
      <h3 class="mrr-heading">{{ t('mrs.rail.milestone') }}</h3>
      <p class="mrr-value">{{ milestone }}</p>
    </section>

    <section v-if="mergeable !== null" class="mrr-section">
      <h3 class="mrr-heading">{{ t('mrs.rail.mergeable') }}</h3>
      <span class="mrr-mergeable" :class="`mrr-mergeable--${mergeable}`">{{
        t(MERGEABLE_LABEL_KEYS[mergeable])
      }}</span>
    </section>

    <section v-if="commits !== null" class="mrr-section">
      <h3 class="mrr-heading">{{ t('mrs.rail.commits') }}</h3>
      <p class="mrr-value">{{ t('mrs.rail.commitsCount', { n: commits }, commits) }}</p>
    </section>

    <section class="mrr-section">
      <h3 class="mrr-heading">{{ t('mrs.rail.autoReview') }}</h3>
      <p v-if="autoReview.kind === 'unavailable'" class="mrr-empty">
        {{ t('mrs.rail.autoReviewUnavailable') }}
      </p>
      <p v-else-if="autoReview.kind === 'none'" class="mrr-empty">
        {{ t('mrs.rail.autoReviewNone') }}
      </p>
      <div v-else-if="autoReview.kind === 'aggregate'" class="mrr-checks-aggregate">
        <span
          class="mrr-checks-dot"
          :class="`mrr-checks-dot--${autoReview.status}`"
          aria-hidden="true"
        />
        <span
          >{{ t(AGGREGATE_LABEL_KEYS[autoReview.status]) }} · {{ t('mrs.checks.partial') }}</span
        >
      </div>
      <div v-else class="mrr-checks-detailed">
        <span class="mrr-check-entry mrr-check-entry--passed">{{
          t('mrs.checks.passed', { n: autoReview.passed }, autoReview.passed)
        }}</span>
        <span
          v-for="entry in autoReview.rest"
          :key="entry.bucket"
          class="mrr-check-entry"
          :class="`mrr-check-entry--${entry.bucket}`"
          >{{ t(CHECK_LABEL_KEYS[entry.bucket], { n: entry.count }, entry.count) }}</span
        >
      </div>
    </section>
  </div>
</template>

<style scoped>
.mrr-root {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.mrr-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.mrr-heading {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--codesema-ink-3);
}

.mrr-empty {
  margin: 0;
  font-size: 12px;
  color: var(--codesema-ink-3);
}

.mrr-value {
  margin: 0;
  font-size: 13px;
  color: var(--codesema-ink);
}

.mrr-chips {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.mrr-chip {
  font-size: 11.5px;
  color: var(--codesema-ink-2);
  background: var(--codesema-panel);
  border: 1px solid var(--codesema-line-2);
  border-radius: 999px;
  padding: 3px 10px;
}

/* Non-interactive compact pill: same fill family as LabelChips' rest state
   (see LabelColor.ts), --cs-* tokens only. Kept apart from .mrr-chip above
   (reviewers, assignees), which never carries a forge color. */
.mrr-label-chip {
  --lp-rest-bg: var(--cs-line-2);

  font-size: 12px;
  font-weight: 500;
  color: var(--cs-text-2);
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--lp-rest-bg);
}

.mrr-mergeable {
  display: inline-flex;
  align-self: flex-start;
  font-size: 11.5px;
  font-weight: 600;
  border-radius: 7px;
  padding: 4px 10px;
  border: 1px solid transparent;
}

.mrr-mergeable--mergeable {
  color: var(--codesema-risk-low);
  background: var(--codesema-risk-low-soft);
  border-color: var(--codesema-risk-low);
}

.mrr-mergeable--conflicting {
  color: var(--codesema-risk-high);
  background: var(--codesema-risk-high-soft);
  border-color: var(--codesema-risk-high);
}

.mrr-mergeable--unknown {
  color: var(--codesema-risk-med);
  background: var(--codesema-risk-med-soft);
  border-color: var(--codesema-risk-med);
}

.mrr-checks-aggregate {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--codesema-ink-2);
}

.mrr-checks-dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.mrr-checks-dot--passed {
  background: var(--codesema-risk-low);
}

.mrr-checks-dot--failed {
  background: var(--codesema-risk-high);
}

.mrr-checks-dot--pending {
  background: var(--codesema-risk-med);
}

.mrr-checks-dot--skipped,
.mrr-checks-dot--unknown {
  background: var(--codesema-dot-idle);
}

.mrr-checks-detailed {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
  font-family: var(--font-mono);
}

.mrr-check-entry--passed {
  color: var(--codesema-risk-low);
}

.mrr-check-entry--failed {
  color: var(--codesema-risk-high);
}

.mrr-check-entry--pending {
  color: var(--codesema-risk-med);
}

.mrr-check-entry--skipped {
  color: var(--codesema-ink-3);
}
</style>
