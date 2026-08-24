<script setup lang="ts">
// The forge board's list panel: the actual functional issue/MR list
// (loading / transport error / forge unavailable / empty / filtered-empty /
// list states, sort, status filter, label chips), carried over from the old
// two-accordion ForgeBoard.vue body. The difference: only ONE section is
// shown at a time now (the active section picked in the controls panel),
// always fully expanded, since there is only one section on screen to fold.
// Clicking an item selects it (for the detail panel) instead of opening it
// in a new tab; the external "open in forge" link now lives on the detail
// panel.
import { computed } from 'vue'
import type { ProjectIssuesState } from '../../composables/useIssues'
import type { MrsLoadState } from '../../composables/useTasks'
import { t } from '../../i18n'
import type { ForgeMr } from '../../types'
import MrCard from '../mr/MrCard.vue'
import ForgeIssueCard from './ForgeIssueCard.vue'
import {
  forgeFilterByLabels,
  forgeFilterMrsByState,
  forgeLabelCounts,
  forgeSort,
  type ForgeSelection,
  type ForgeSortKey,
  type MrStateFilter,
} from './ForgeLogic'
import LabelChips from './LabelChips.vue'

const props = defineProps<{
  section: 'issues' | 'mrs'
  issuesState: ProjectIssuesState
  issuesSort: ForgeSortKey
  issuesLabels: string[]
  mrs: ForgeMr[]
  /** The fact behind the last GET /api/mrs of this project (useTasks.ts'
   * mrsLoadByProject): null while nothing was fetched yet, distinct from
   * both a loaded empty list and a forge that could not be reached. */
  mrsState: MrsLoadState | null
  mrsSort: ForgeSortKey
  mrsFilter: MrStateFilter
  mrsLabels: string[]
  selection: ForgeSelection | null
}>()

const emit = defineEmits<{
  'update:issuesSort': [sort: ForgeSortKey]
  'update:mrsSort': [sort: ForgeSortKey]
  'update:mrsFilter': [filter: MrStateFilter]
  'toggle-issue-label': [label: string]
  'toggle-mr-label': [label: string]
  'clear-issue-filters': []
  'clear-mr-filters': []
  'retry-issues': []
  select: [selection: ForgeSelection]
}>()

function isSelected(kind: ForgeSelection['kind'], number: number): boolean {
  return (
    props.selection !== null && props.selection.kind === kind && props.selection.number === number
  )
}

function onIssuesSortChange(event: Event): void {
  emit('update:issuesSort', (event.target as HTMLSelectElement).value as ForgeSortKey)
}

function onMrsSortChange(event: Event): void {
  emit('update:mrsSort', (event.target as HTMLSelectElement).value as ForgeSortKey)
}

// ── Issues: loading / transport error / forge unavailable / empty / list ──
const issuesResult = computed(() => props.issuesState.result)
const issuesLoaded = computed(() =>
  issuesResult.value !== null && issuesResult.value.available ? issuesResult.value.issues : null,
)
const issuesTruncated = computed(
  () => issuesResult.value !== null && issuesResult.value.available && issuesResult.value.truncated,
)
const issuesUnavailableReason = computed(() =>
  issuesResult.value !== null && !issuesResult.value.available ? issuesResult.value.reason : null,
)

const ISSUES_REASON_KEY = {
  'no-remote': 'forge.issuesReasonNoRemote',
  'no-cli': 'forge.issuesReasonNoCli',
  'cli-error': 'forge.issuesReasonCliError',
  'invalid-input': 'forge.issuesReasonInvalidInput',
  unsupported: 'forge.issuesReasonUnsupported',
} as const

// Only labels can narrow the issues list (see forgeFilterMrsByState's own
// doc: nothing else legitimately discriminates an OPEN-only corpus here).
const issuesFilterActive = computed(() => props.issuesLabels.length > 0)
const issuesLabelCounts = computed(() => forgeLabelCounts(issuesLoaded.value ?? []))
const issuesVisible = computed(() =>
  issuesLoaded.value === null
    ? []
    : forgeSort(forgeFilterByLabels(issuesLoaded.value, props.issuesLabels), props.issuesSort),
)
/**
 * The header badge: the whole corpus when nothing narrows it, "shown / total"
 * the moment a label selection is active, since a lone total would then
 * describe a list nobody is actually looking at any more. `null` (no badge at
 * all) stays reserved for the genuinely unknown count (loading, error, unavailable).
 */
const issuesCount = computed(() => {
  if (issuesLoaded.value === null) {
    return null
  }
  const total = issuesLoaded.value.length
  return issuesFilterActive.value
    ? t('forge.countFiltered', { shown: issuesVisible.value.length, total })
    : total
})
const issuesTruncatedHint = computed(() =>
  issuesTruncated.value && issuesLoaded.value
    ? t('forge.truncatedHint', { n: issuesLoaded.value.length })
    : null,
)

// ── Pull requests: transport error / forge unavailable / empty / list ─────
const MRS_REASON_KEY = {
  'no-remote': 'mrs.reasonNoRemote',
  'no-cli': 'mrs.reasonNoCli',
  'cli-error': 'mrs.reasonCliError',
} as const

const mrsErrorMessage = computed(() =>
  props.mrsState?.status === 'error'
    ? t('forge.transportError', { error: props.mrsState.error })
    : null,
)
const mrsUnavailableKey = computed(() =>
  props.mrsState?.status === 'unavailable' ? MRS_REASON_KEY[props.mrsState.reason] : null,
)
const mrsDegraded = computed(
  () => mrsErrorMessage.value !== null || mrsUnavailableKey.value !== null,
)
const mrsStateFiltered = computed(() => forgeFilterMrsByState(props.mrs, props.mrsFilter))
const mrsLabelCounts = computed(() => forgeLabelCounts(mrsStateFiltered.value))
const mrsVisible = computed(() =>
  forgeSort(forgeFilterByLabels(mrsStateFiltered.value, props.mrsLabels), props.mrsSort),
)
const mrsFilterActive = computed(() => props.mrsFilter !== 'all' || props.mrsLabels.length > 0)
/** Same doctrine as issuesCount above: a formatted "shown / total" the moment
 * the status filter or a label selection is active, null (no badge at all)
 * until a fetch actually resolved into a count. */
const mrsCount = computed(() => {
  if (props.mrsState?.status !== 'loaded') {
    return null
  }
  const total = props.mrs.length
  return mrsFilterActive.value
    ? t('forge.countFiltered', { shown: mrsVisible.value.length, total })
    : total
})
const mrsTruncatedHint = computed(() =>
  props.mrsState?.status === 'loaded' && props.mrsState.truncated
    ? t('forge.truncatedHint', { n: props.mrs.length })
    : null,
)
/**
 * Which filter(s) to name in the "your filter matches nothing" message:
 * distinct wording per dimension actually engaged, so the reader is told
 * exactly what to release rather than a generic "try something else".
 */
const mrsFilteredEmptyKey = computed(() => {
  const statusActive = props.mrsFilter !== 'all'
  const labelsActive = props.mrsLabels.length > 0
  if (statusActive && labelsActive) {
    return 'forge.mrsFilteredEmptyBoth'
  }
  return statusActive ? 'forge.mrsFilteredEmptyFilter' : 'forge.mrsFilteredEmptyLabels'
})

const MR_FILTERS: readonly MrStateFilter[] = ['all', 'draft', 'ready']
const MR_FILTER_LABEL_KEY = {
  all: 'forge.filterAll',
  draft: 'forge.filterDraft',
  ready: 'forge.filterReady',
} as const
</script>

<template>
  <div class="flp-root">
    <template v-if="section === 'issues'">
      <div class="flp-head">
        <span class="flp-heading">{{ t('forge.issuesTitle') }}</span>
        <span v-if="issuesCount !== null" class="flp-count">{{ issuesCount }}</span>
      </div>
      <p v-if="issuesTruncatedHint" class="flp-truncated">{{ issuesTruncatedHint }}</p>

      <div v-if="issuesLoaded && issuesLoaded.length > 0" class="flp-controls">
        <LabelChips
          :counts="issuesLabelCounts"
          :selected="issuesLabels"
          @toggle="(label) => emit('toggle-issue-label', label)"
        />
        <label class="flp-sort">
          <span class="flp-sort-label">{{ t('forge.sortLabel') }}</span>
          <select class="flp-sort-select" :value="issuesSort" @change="onIssuesSortChange">
            <option value="updated">{{ t('forge.sortUpdated') }}</option>
            <option value="title">{{ t('forge.sortTitle') }}</option>
          </select>
        </label>
      </div>

      <p v-if="issuesState.error !== null" class="flp-degraded">
        {{ t('forge.transportError', { error: issuesState.error }) }}
        <button class="flp-retry" type="button" @click="emit('retry-issues')">
          {{ t('forge.retry') }}
        </button>
      </p>
      <p v-else-if="issuesUnavailableReason !== null" class="flp-degraded">
        {{ t(ISSUES_REASON_KEY[issuesUnavailableReason]) }}
      </p>
      <p v-else-if="issuesLoaded === null" class="flp-loading">{{ t('forge.loading') }}</p>
      <p v-else-if="issuesLoaded.length === 0" class="flp-empty">{{ t('forge.issuesEmpty') }}</p>
      <!-- Distinct from the line above: the forge has issues, the LABEL
           filter is what leaves nothing on screen. -->
      <p v-else-if="issuesVisible.length === 0" class="flp-degraded">
        {{ t('forge.issuesFilteredEmpty') }}
        <button class="flp-retry" type="button" @click="emit('clear-issue-filters')">
          {{ t('forge.clearFilters') }}
        </button>
      </p>
      <button
        v-for="issue in issuesVisible"
        :key="issue.number"
        type="button"
        class="flp-item"
        :class="{ 'flp-item--on': isSelected('issue', issue.number) }"
        :aria-current="isSelected('issue', issue.number) ? 'true' : undefined"
        :aria-label="t('forge.selectItemAria', { title: issue.title })"
        @click="emit('select', { kind: 'issue', number: issue.number })"
      >
        <ForgeIssueCard :issue="issue" />
      </button>
    </template>

    <template v-else>
      <div class="flp-head">
        <span class="flp-heading">{{ t('forge.mrsTitle') }}</span>
        <span v-if="mrsCount !== null" class="flp-count">{{ mrsCount }}</span>
      </div>
      <p v-if="mrsTruncatedHint" class="flp-truncated">{{ mrsTruncatedHint }}</p>

      <div v-if="!mrsDegraded && mrs.length > 0" class="flp-controls">
        <div class="flp-filters" role="group" :aria-label="t('forge.filterAria')">
          <button
            v-for="filter in MR_FILTERS"
            :key="filter"
            type="button"
            class="flp-filter-chip"
            :class="{ 'flp-filter-chip--on': mrsFilter === filter }"
            :aria-pressed="mrsFilter === filter"
            @click="emit('update:mrsFilter', filter)"
          >
            {{ t(MR_FILTER_LABEL_KEY[filter]) }}
          </button>
        </div>
        <LabelChips
          :counts="mrsLabelCounts"
          :selected="mrsLabels"
          @toggle="(label) => emit('toggle-mr-label', label)"
        />
        <label class="flp-sort">
          <span class="flp-sort-label">{{ t('forge.sortLabel') }}</span>
          <select class="flp-sort-select" :value="mrsSort" @change="onMrsSortChange">
            <option value="updated">{{ t('forge.sortUpdated') }}</option>
            <option value="title">{{ t('forge.sortTitle') }}</option>
          </select>
        </label>
      </div>

      <p v-if="mrsErrorMessage !== null" class="flp-degraded">{{ mrsErrorMessage }}</p>
      <p v-else-if="mrsUnavailableKey !== null" class="flp-degraded">{{ t(mrsUnavailableKey) }}</p>
      <p v-else-if="mrs.length === 0" class="flp-empty">{{ t('forge.mrsEmpty') }}</p>
      <!-- Distinct from the line above: the forge has MRs, the status filter
           and/or a label selection is what leaves nothing on screen. -->
      <p v-else-if="mrsVisible.length === 0" class="flp-degraded">
        {{ t(mrsFilteredEmptyKey) }}
        <button class="flp-retry" type="button" @click="emit('clear-mr-filters')">
          {{ t('forge.clearFilters') }}
        </button>
      </p>
      <button
        v-for="mr in mrsVisible"
        :key="mr.number"
        type="button"
        class="flp-item"
        :class="{ 'flp-item--on': isSelected('mr', mr.number) }"
        :aria-current="isSelected('mr', mr.number) ? 'true' : undefined"
        :aria-label="t('forge.selectItemAria', { title: mr.title })"
        @click="emit('select', { kind: 'mr', number: mr.number })"
      >
        <MrCard :mr="mr" />
      </button>
    </template>
  </div>
</template>

<style scoped>
.flp-root {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 16px 24px;
}

.flp-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.flp-heading {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--cs-text);
}

.flp-count {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  color: var(--cs-ghost);
  font-variant-numeric: tabular-nums;
}

.flp-truncated {
  margin: 0;
  font-size: 11px;
  color: var(--cs-ghost);
}

.flp-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.flp-sort {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.flp-sort-label {
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--cs-ghost);
}

.flp-sort-select {
  font-family: inherit;
  font-size: 11.5px;
  color: var(--cs-text-2);
  background: var(--cs-surface);
  border: 1px solid var(--cs-line-2);
  border-radius: 6px;
  padding: 3px 7px;
}

.flp-filters {
  display: inline-flex;
  border: 1px solid var(--cs-line-2);
  border-radius: 8px;
  overflow: hidden;
  align-self: flex-start;
}

.flp-filter-chip {
  font-size: 11.5px;
  font-weight: 600;
  font-family: inherit;
  padding: 4px 10px;
  border: none;
  background: var(--cs-surface);
  color: var(--cs-muted);
  cursor: pointer;
}

.flp-filter-chip + .flp-filter-chip {
  border-left: 1px solid var(--cs-line-2);
}

/* The active filter is a state: colored, per the doctrine. */
.flp-filter-chip--on {
  background: var(--cs-green-soft);
  color: var(--cs-text);
}

.flp-degraded {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--cs-muted);
  background: var(--cs-inset);
  border-radius: 8px;
  padding: 10px 12px;
}

.flp-retry {
  flex: none;
  font-family: inherit;
  font-size: 11.5px;
  font-weight: 600;
  padding: 3px 10px;
  border: 1px solid var(--cs-line-2);
  border-radius: 6px;
  background: transparent;
  color: var(--cs-text-2);
  cursor: pointer;
}

.flp-retry:hover {
  border-color: var(--cs-line-3);
}

.flp-loading,
.flp-empty {
  margin: 0;
  font-size: 12px;
  color: var(--cs-ghost);
  padding: 4px 2px;
}

.flp-item {
  display: block;
  width: 100%;
  text-align: left;
  font-family: inherit;
  padding: 12px 13px;
  border: 1px solid var(--cs-line-2);
  border-radius: 10px;
  background: var(--cs-surface);
  cursor: pointer;
}

.flp-item:hover {
  border-color: var(--cs-line-3);
}

/* The selected item is a state: colored border, per the doctrine. */
.flp-item--on {
  border-color: var(--cs-green-ring);
  background: var(--cs-green-soft);
}
</style>
