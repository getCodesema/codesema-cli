<script setup lang="ts">
// Dense, presentational card for one merge request: state badge, micro diff
// bar, +N/-N, file count, checks tally. Props in, nothing fetched, nothing
// owned: the caller supplies the ForgeMr and decides selection/click.
import { computed } from 'vue'
import { t, type MessageKey } from '../../i18n'
import type { ForgeMr } from '../../types'
import {
  aggregateCheckStatus,
  CHECK_BUCKETS,
  type CheckAggregateStatus,
  type CheckBucket,
} from './Checks'
import { diffBarBlocks } from './DiffBar'

const props = defineProps<{ mr: ForgeMr }>()

type BadgeVariant = 'open' | 'draft' | 'merged' | 'closed'

const badge = computed<{ variant: BadgeVariant; labelKey: MessageKey } | null>(() => {
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

type ChecksDisplay =
  | { kind: 'aggregate'; status: CheckAggregateStatus }
  | { kind: 'counts'; buckets: { bucket: CheckBucket; count: number }[] }

const checksDisplay = computed<ChecksDisplay | null>(() => {
  const rollup = checks.value
  if (rollup === null) {
    return null
  }
  if (rollup.truncated) {
    return { kind: 'aggregate', status: aggregateCheckStatus(rollup) }
  }
  const buckets = CHECK_BUCKETS.map((bucket) => ({ bucket, count: rollup[bucket] })).filter(
    (entry) => entry.count > 0,
  )
  return { kind: 'counts', buckets }
})

function formatUpdatedAt(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    )
  } catch {
    return iso
  }
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
  <div class="mrc-root">
    <div class="mrc-top">
      <span v-if="badge" class="mrc-badge" :class="`mrc-badge--${badge.variant}`">{{
        t(badge.labelKey)
      }}</span>
      <span class="mrc-number">{{ t('mrs.number', { n: mr.number }) }}</span>
      <span class="mrc-branch">{{ mr.sourceBranch }}</span>
    </div>

    <p class="mrc-title">{{ mr.title }}</p>

    <p class="mrc-meta">{{ mr.author }} · {{ formatUpdatedAt(mr.updatedAt) }}</p>

    <div
      v-if="
        diffBar ||
        additions !== null ||
        deletions !== null ||
        changedFiles !== null ||
        checksDisplay
      "
      class="mrc-stats"
    >
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
      <span v-if="additions !== null" class="mrc-add">+{{ additions }}</span>
      <span v-if="deletions !== null" class="mrc-del">−{{ deletions }}</span>
      <span v-if="changedFiles !== null" class="mrc-files">{{
        t('mrs.card.filesChanged', { n: changedFiles }, changedFiles)
      }}</span>
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
            >{{ t(CHECK_LABEL_KEYS[entry.bucket], { n: entry.count }, entry.count) }}</span
          >
        </template>
      </span>
    </div>
  </div>
</template>

<style scoped>
.mrc-root {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.mrc-top {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.mrc-badge {
  flex-shrink: 0;
  font-size: 9.5px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-radius: 999px;
  padding: 1.5px 7px;
}

.mrc-badge--open {
  color: var(--codesema-risk-med);
  background: var(--codesema-risk-med-soft);
}

.mrc-badge--draft {
  color: var(--codesema-ink-3);
  background: var(--codesema-line-2);
}

.mrc-badge--merged {
  color: var(--codesema-risk-low);
  background: var(--codesema-risk-low-soft);
}

.mrc-badge--closed {
  color: var(--codesema-risk-high);
  background: var(--codesema-risk-high-soft);
}

.mrc-number {
  flex-shrink: 0;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--codesema-accent);
}

.mrc-branch {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--codesema-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mrc-title {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--codesema-ink);
  line-height: 1.35;
}

.mrc-meta {
  margin: 0;
  font-size: 11px;
  color: var(--codesema-ink-3);
}

.mrc-stats {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 2px;
  font-size: 10.5px;
  font-family: var(--font-mono);
  color: var(--codesema-ink-3);
}

.mrc-diffbar {
  display: inline-flex;
  gap: 2px;
}

.mrc-diffblock {
  width: 6px;
  height: 6px;
  border-radius: 1.5px;
}

.mrc-diffblock--add {
  background: var(--codesema-risk-low);
}

.mrc-diffblock--del {
  background: var(--codesema-risk-high);
}

.mrc-diffblock--neutral {
  background: var(--codesema-line-idle);
}

.mrc-add {
  color: var(--codesema-risk-low);
}

.mrc-del {
  color: var(--codesema-risk-high);
}

.mrc-checks {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.mrc-check-entry--passed {
  color: var(--codesema-risk-low);
}

.mrc-check-entry--failed {
  color: var(--codesema-risk-high);
}

.mrc-check-entry--pending {
  color: var(--codesema-risk-med);
}

.mrc-check-entry--skipped {
  color: var(--codesema-ink-3);
}

.mrc-checks-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.mrc-checks-dot--passed {
  background: var(--codesema-risk-low);
}

.mrc-checks-dot--failed {
  background: var(--codesema-risk-high);
}

.mrc-checks-dot--pending {
  background: var(--codesema-risk-med);
}

.mrc-checks-dot--skipped,
.mrc-checks-dot--unknown {
  background: var(--codesema-dot-idle);
}
</style>
