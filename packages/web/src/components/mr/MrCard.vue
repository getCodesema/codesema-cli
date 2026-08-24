<script setup lang="ts">
// Dense, presentational card for one merge request: state, number, author,
// age, title, files/diff/checks stats. Props in, nothing fetched, nothing
// owned: the caller supplies the ForgeMr and decides selection/click.
import { computed } from 'vue'
import { t, type MessageKey } from '../../i18n'
import { formatRelativeAge } from '../../relative-time'
import type { ForgeMr } from '../../types'
import { aggregateCheckStatus, type CheckAggregateStatus, type CheckBucket } from './Checks'
import { diffBarBlocks } from './DiffBar'

const props = defineProps<{ mr: ForgeMr }>()

type StateVariant = 'open' | 'draft' | 'merged' | 'closed'

const mrState = computed<{ variant: StateVariant; labelKey: MessageKey } | null>(() => {
  const { state, isDraft } = props.mr
  if (state === null) {
    return null
  }
  if (state === 'open' && isDraft === true) {
    return { variant: 'draft', labelKey: 'mrs.card.stateDraft' }
  }
  if (state === 'open') {
    return { variant: 'open', labelKey: 'mrs.card.stateOpen' }
  }
  if (state === 'merged') {
    return { variant: 'merged', labelKey: 'mrs.card.stateMerged' }
  }
  return { variant: 'closed', labelKey: 'mrs.card.stateClosed' }
})

const age = computed(() => formatRelativeAge(props.mr.updatedAt))
const additions = computed(() => props.mr.additions)
const deletions = computed(() => props.mr.deletions)
const changedFiles = computed(() => props.mr.changedFiles)
const checks = computed(() => props.mr.checks)

const diffBar = computed(() => {
  if (additions.value === null || deletions.value === null) {
    return null
  }
  return diffBarBlocks(additions.value, deletions.value)
})

const hasStats = computed(
  () =>
    diffBar.value !== null ||
    additions.value !== null ||
    deletions.value !== null ||
    changedFiles.value !== null ||
    checks.value !== null,
)

type ChecksDisplay =
  | { kind: 'aggregate'; status: CheckAggregateStatus }
  | { kind: 'counts'; buckets: { bucket: CheckBucket; count: number }[] }

/** Failed first, then in-progress, then success, then everything else: the
 * reader's attention should land on what needs it, not on an alphabetical or
 * schema-field order. Local to this card, not CHECK_BUCKETS' own order (used
 * elsewhere for a different, non-urgency-ranked purpose). */
const CHECK_RENDER_ORDER: readonly CheckBucket[] = ['failed', 'pending', 'passed', 'skipped']

const checksDisplay = computed<ChecksDisplay | null>(() => {
  const rollup = checks.value
  if (rollup === null) {
    return null
  }
  if (rollup.truncated) {
    return { kind: 'aggregate', status: aggregateCheckStatus(rollup) }
  }
  const buckets = CHECK_RENDER_ORDER.map((bucket) => ({ bucket, count: rollup[bucket] })).filter(
    (entry) => entry.count > 0,
  )
  return { kind: 'counts', buckets }
})

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
  <div class="mrc-root">
    <div class="mrc-head">
      <span
        v-if="mrState"
        class="mrc-state"
        :class="`mrc-state--${mrState.variant}`"
        role="img"
        :aria-label="t(mrState.labelKey)"
      >
        <svg v-if="mrState.variant === 'open'" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="5.5" />
          <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
        </svg>
        <svg v-else-if="mrState.variant === 'draft'" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="5.5" stroke-dasharray="2 2" />
        </svg>
        <svg v-else-if="mrState.variant === 'merged'" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="5" cy="4" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="5" cy="12" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="11" cy="8" r="1.3" fill="currentColor" stroke="none" />
          <path d="M5 5.3v5" />
          <path d="M5 8c3 0 4.5-1 6-1.5" />
        </svg>
        <svg v-else viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="5.5" />
          <path d="M6 6l4 4M10 6l-4 4" />
        </svg>
      </span>
      <span class="mrc-number">{{ t('mrs.number', { n: mr.number }) }}</span>
      <span class="mrc-author">{{ mr.author }}</span>
      <span class="mrc-age">{{ age }}</span>
    </div>

    <p class="mrc-title">{{ mr.title }}</p>

    <div v-if="hasStats" class="mrc-stats">
      <span v-if="changedFiles !== null" class="mrc-files">
        <svg class="mrc-file-icon" aria-hidden="true" viewBox="0 0 16 16">
          <path d="M4 2.2h5.2L11.8 5v8.8H4z" />
          <path d="M9.2 2.2V5h2.6" />
        </svg>
        {{ t('mrs.card.filesChanged', { n: changedFiles }, changedFiles) }}
      </span>
      <span
        v-if="diffBar"
        class="mrc-diffbar"
        role="img"
        :aria-label="t('mrs.card.diffBarLabel', { additions, deletions })"
      >
        <span
          v-for="(block, i) in diffBar"
          :key="i"
          class="mrc-diffblock"
          :class="`mrc-diffblock--${block}`"
        />
      </span>
      <span v-if="additions !== null || deletions !== null" class="mrc-diffcounts">
        <span v-if="additions !== null" class="mrc-add">+{{ additions }}</span>
        <span v-if="deletions !== null" class="mrc-del">−{{ deletions }}</span>
      </span>
      <span v-if="checksDisplay" class="mrc-checks">
        <template v-if="checksDisplay.kind === 'aggregate'">
          <span
            class="mrc-checks-dot"
            :class="`mrc-checks-dot--${checksDisplay.status}`"
            aria-hidden="true"
          />
          <span
            >{{ t(AGGREGATE_LABEL_KEYS[checksDisplay.status]) }} ({{
              t('mrs.checks.partial')
            }})</span
          >
        </template>
        <template v-else>
          <span
            v-for="entry in checksDisplay.buckets"
            :key="entry.bucket"
            class="mrc-check-entry"
            :class="`mrc-check-entry--${entry.bucket}`"
            :aria-label="t(CHECK_LABEL_KEYS[entry.bucket], { n: entry.count }, entry.count)"
          >
            <span aria-hidden="true">{{ entry.count }}</span>
            <svg class="mrc-check-icon" aria-hidden="true" viewBox="0 0 16 16">
              <path v-if="entry.bucket === 'failed'" d="M4 4l8 8M12 4l-8 8" />
              <template v-else-if="entry.bucket === 'pending'">
                <circle cx="8" cy="8" r="5.5" />
                <path d="M8 4.5V8l2.2 1.3" />
              </template>
              <path v-else-if="entry.bucket === 'passed'" d="M4.5 8.5l2.5 2.5 4.5-5" />
              <template v-else>
                <circle cx="8" cy="8" r="5.5" />
                <path d="M6 8h4" />
              </template>
            </svg>
          </span>
        </template>
      </span>
    </div>
  </div>
</template>

<style scoped>
.mrc-root {
  display: flex;
  flex-direction: column;
  width: 100%;
}

.mrc-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 4px;
  font-size: 12px;
  color: var(--cs-ghost);
}

.mrc-state {
  flex: none;
  width: 13px;
  height: 13px;
  display: inline-flex;
}

.mrc-state svg {
  width: 100%;
  height: 100%;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.mrc-state--open {
  color: var(--cs-amber-text);
}

.mrc-state--draft {
  color: var(--cs-ghost);
}

.mrc-state--merged {
  color: var(--cs-green-text);
}

.mrc-state--closed {
  color: var(--cs-red-text);
}

.mrc-number {
  flex: none;
  font-weight: 700;
  color: var(--cs-green-text);
}

.mrc-author {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mrc-author::before {
  content: '·';
  margin-right: 6px;
}

.mrc-age {
  flex: none;
  margin-left: auto;
}

.mrc-title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--cs-text);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
}

.mrc-stats {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  font-family: var(--font-mono);
  color: var(--cs-ghost);
}

.mrc-files {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.mrc-file-icon {
  flex: none;
  width: 11px;
  height: 11px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.mrc-diffbar {
  display: inline-flex;
  gap: 2px;
}

.mrc-diffblock {
  width: 6px;
  height: 6px;
  border-radius: 1px;
}

.mrc-diffblock--add {
  background: var(--cs-green-text);
}

.mrc-diffblock--del {
  background: var(--cs-red-text);
}

.mrc-diffcounts {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.mrc-add {
  color: var(--cs-green-text);
}

.mrc-del {
  color: var(--cs-red-text);
}

.mrc-checks {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.mrc-check-entry {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.mrc-check-icon {
  flex: none;
  width: 12px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.mrc-check-entry--passed {
  color: var(--cs-green-text);
}

.mrc-check-entry--failed {
  color: var(--cs-red-text);
}

.mrc-check-entry--pending {
  color: var(--cs-amber-text);
}

.mrc-check-entry--skipped {
  color: var(--cs-ghost);
}

.mrc-checks-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.mrc-checks-dot--passed {
  background: var(--cs-green-text);
}

.mrc-checks-dot--failed {
  background: var(--cs-red-text);
}

.mrc-checks-dot--pending {
  background: var(--cs-amber-text);
}

.mrc-checks-dot--skipped,
.mrc-checks-dot--unknown {
  background: var(--cs-dot-idle);
}
</style>
