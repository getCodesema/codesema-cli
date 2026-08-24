<script setup lang="ts">
// The two accordions (issues, pull requests) shown in the focus zone in
// place of the sober empty-state message once a project is selected. Pure
// presentational orchestration: all fetching lives upstream (useIssues for
// issues, useTasks' mrsByProject/mrsLoadByProject for MRs, already wired in
// WorkspaceView); this component only sorts, filters, counts and persists
// the UI prefs.
import { computed, ref, watch } from 'vue'
import type { ProjectIssuesState } from '../../composables/useIssues'
import type { MrsLoadState } from '../../composables/useTasks'
import { t } from '../../i18n'
import type { ForgeMr } from '../../types'
import MrCard from '../mr/MrCard.vue'
import ForgeAccordion from './ForgeAccordion.vue'
import ForgeIssueCard from './ForgeIssueCard.vue'
import {
  forgeFilterByLabels,
  forgeFilterMrsByState,
  forgeLabelCounts,
  forgeSort,
  type ForgeSortKey,
  type MrStateFilter,
} from './ForgeLogic'
import { readForgePrefs, writeForgePrefs } from './ForgePrefs'
import LabelChips from './LabelChips.vue'

const props = defineProps<{
  issuesState: ProjectIssuesState
  mrs: ForgeMr[]
  /** The fact behind the last GET /api/mrs of this project (useTasks.ts'
   * mrsLoadByProject): null while nothing was fetched yet, distinct from
   * both a loaded empty list and a forge that could not be reached. */
  mrsState: MrsLoadState | null
}>()

const emit = defineEmits<{ 'retry-issues': [] }>()

// ── Preferences: one JSON blob, loaded once, persisted on every change ────
const prefs = ref(readForgePrefs())

watch(prefs, (next) => writeForgePrefs(next), { deep: true })

const issuesOpen = computed({
  get: () => prefs.value.issuesOpen,
  set: (v) => (prefs.value = { ...prefs.value, issuesOpen: v }),
})
const mrsOpen = computed({
  get: () => prefs.value.mrsOpen,
  set: (v) => (prefs.value = { ...prefs.value, mrsOpen: v }),
})
const issuesSort = computed({
  get: () => prefs.value.issuesSort,
  set: (v: ForgeSortKey) => (prefs.value = { ...prefs.value, issuesSort: v }),
})
const mrsSort = computed({
  get: () => prefs.value.mrsSort,
  set: (v: ForgeSortKey) => (prefs.value = { ...prefs.value, mrsSort: v }),
})
const mrsFilter = computed({
  get: () => prefs.value.mrsFilter,
  set: (v: MrStateFilter) => (prefs.value = { ...prefs.value, mrsFilter: v }),
})

function toggleIssueLabel(label: string): void {
  const current = prefs.value.issuesLabels
  const next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label]
  prefs.value = { ...prefs.value, issuesLabels: next }
}

function toggleMrLabel(label: string): void {
  const current = prefs.value.mrsLabels
  const next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label]
  prefs.value = { ...prefs.value, mrsLabels: next }
}

/** Releases the only filter dimension issues have (labels): the fix offered
 * on the "your filter matches nothing" state below. */
function clearIssueFilters(): void {
  prefs.value = { ...prefs.value, issuesLabels: [] }
}

/** Releases both MR filter dimensions at once (status filter and labels):
 * the fix offered on the "your filter matches nothing" state below. */
function clearMrFilters(): void {
  prefs.value = { ...prefs.value, mrsFilter: 'all', mrsLabels: [] }
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
const issuesFilterActive = computed(() => prefs.value.issuesLabels.length > 0)
const issuesLabelCounts = computed(() => forgeLabelCounts(issuesLoaded.value ?? []))
const issuesVisible = computed(() =>
  issuesLoaded.value === null
    ? []
    : forgeSort(
        forgeFilterByLabels(issuesLoaded.value, prefs.value.issuesLabels),
        issuesSort.value,
      ),
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
const mrsStateFiltered = computed(() => forgeFilterMrsByState(props.mrs, mrsFilter.value))
const mrsLabelCounts = computed(() => forgeLabelCounts(mrsStateFiltered.value))
const mrsVisible = computed(() =>
  forgeSort(forgeFilterByLabels(mrsStateFiltered.value, prefs.value.mrsLabels), mrsSort.value),
)
const mrsFilterActive = computed(
  () => mrsFilter.value !== 'all' || prefs.value.mrsLabels.length > 0,
)
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
  const statusActive = mrsFilter.value !== 'all'
  const labelsActive = prefs.value.mrsLabels.length > 0
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
  <div class="fb-root">
    <!-- ── Issues ──────────────────────────────────────────────────────── -->
    <ForgeAccordion
      v-model:open="issuesOpen"
      :label="t('forge.issuesTitle')"
      :count="issuesCount"
      :truncated-hint="issuesTruncatedHint"
    >
      <template v-if="issuesLoaded && issuesLoaded.length > 0" #labels>
        <LabelChips
          :counts="issuesLabelCounts"
          :selected="prefs.issuesLabels"
          @toggle="toggleIssueLabel"
        />
      </template>
      <template v-if="issuesLoaded && issuesLoaded.length > 0" #filters>
        <label class="fb-sort">
          <span class="fb-sort-label">{{ t('forge.sortLabel') }}</span>
          <select v-model="issuesSort" class="fb-sort-select">
            <option value="updated">{{ t('forge.sortUpdated') }}</option>
            <option value="title">{{ t('forge.sortTitle') }}</option>
          </select>
        </label>
      </template>

      <p v-if="issuesState.error !== null" class="fb-degraded">
        {{ t('forge.transportError', { error: issuesState.error }) }}
        <button class="fb-retry" type="button" @click="emit('retry-issues')">
          {{ t('forge.retry') }}
        </button>
      </p>
      <p v-else-if="issuesUnavailableReason !== null" class="fb-degraded">
        {{ t(ISSUES_REASON_KEY[issuesUnavailableReason]) }}
      </p>
      <p v-else-if="issuesLoaded === null" class="fb-loading">{{ t('forge.loading') }}</p>
      <p v-else-if="issuesLoaded.length === 0" class="fb-empty">{{ t('forge.issuesEmpty') }}</p>
      <!-- Distinct from the line above: the forge has issues, the LABEL
           filter is what leaves nothing on screen. -->
      <p v-else-if="issuesVisible.length === 0" class="fb-degraded">
        {{ t('forge.issuesFilteredEmpty') }}
        <button class="fb-retry" type="button" @click="clearIssueFilters">
          {{ t('forge.clearFilters') }}
        </button>
      </p>
      <a
        v-for="issue in issuesVisible"
        :key="issue.number"
        class="fb-item"
        :href="issue.url"
        target="_blank"
        rel="noopener noreferrer"
        :aria-label="t('forge.openItemAria', { title: issue.title })"
      >
        <ForgeIssueCard :issue="issue" />
      </a>
    </ForgeAccordion>

    <!-- ── Pull requests ───────────────────────────────────────────────── -->
    <ForgeAccordion
      v-model:open="mrsOpen"
      :label="t('forge.mrsTitle')"
      :count="mrsCount"
      :truncated-hint="mrsTruncatedHint"
    >
      <template v-if="!mrsDegraded && mrs.length > 0" #labels>
        <LabelChips :counts="mrsLabelCounts" :selected="prefs.mrsLabels" @toggle="toggleMrLabel" />
      </template>
      <template v-if="!mrsDegraded && mrs.length > 0" #filters>
        <div class="fb-filters" role="group" :aria-label="t('forge.filterAria')">
          <button
            v-for="filter in MR_FILTERS"
            :key="filter"
            type="button"
            class="fb-filter-chip"
            :class="{ 'fb-filter-chip--on': mrsFilter === filter }"
            :aria-pressed="mrsFilter === filter"
            @click="mrsFilter = filter"
          >
            {{ t(MR_FILTER_LABEL_KEY[filter]) }}
          </button>
        </div>
        <label class="fb-sort">
          <span class="fb-sort-label">{{ t('forge.sortLabel') }}</span>
          <select v-model="mrsSort" class="fb-sort-select">
            <option value="updated">{{ t('forge.sortUpdated') }}</option>
            <option value="title">{{ t('forge.sortTitle') }}</option>
          </select>
        </label>
      </template>

      <p v-if="mrsErrorMessage !== null" class="fb-degraded">
        {{ mrsErrorMessage }}
      </p>
      <p v-else-if="mrsUnavailableKey !== null" class="fb-degraded">
        {{ t(mrsUnavailableKey) }}
      </p>
      <p v-else-if="mrs.length === 0" class="fb-empty">{{ t('forge.mrsEmpty') }}</p>
      <!-- Distinct from the line above: the forge has MRs, the status filter
           and/or a label selection is what leaves nothing on screen. -->
      <p v-else-if="mrsVisible.length === 0" class="fb-degraded">
        {{ t(mrsFilteredEmptyKey) }}
        <button class="fb-retry" type="button" @click="clearMrFilters">
          {{ t('forge.clearFilters') }}
        </button>
      </p>
      <a
        v-for="mr in mrsVisible"
        :key="mr.number"
        class="fb-item"
        :href="mr.url"
        target="_blank"
        rel="noopener noreferrer"
        :aria-label="t('forge.openItemAria', { title: mr.title })"
      >
        <MrCard :mr="mr" />
      </a>
    </ForgeAccordion>
  </div>
</template>

<style scoped>
.fb-root {
  display: flex;
  flex-direction: column;
  gap: 22px;
  max-width: 720px;
  width: 100%;
  margin: 32px auto;
  padding: 0 24px 40px;
}

.fb-sort {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.fb-sort-label {
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--cs-ghost);
}

.fb-sort-select {
  font-family: inherit;
  font-size: 11.5px;
  color: var(--cs-text-2);
  background: var(--cs-surface);
  border: 1px solid var(--cs-line-2);
  border-radius: 6px;
  padding: 3px 7px;
}

.fb-filters {
  display: inline-flex;
  border: 1px solid var(--cs-line-2);
  border-radius: 8px;
  overflow: hidden;
}

.fb-filter-chip {
  font-size: 11.5px;
  font-weight: 600;
  font-family: inherit;
  padding: 4px 10px;
  border: none;
  background: var(--cs-surface);
  color: var(--cs-muted);
  cursor: pointer;
}

.fb-filter-chip + .fb-filter-chip {
  border-left: 1px solid var(--cs-line-2);
}

/* The active filter is a state: colored, per the doctrine. */
.fb-filter-chip--on {
  background: var(--cs-green-soft);
  color: var(--cs-text);
}

.fb-degraded {
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

.fb-retry {
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

.fb-retry:hover {
  border-color: var(--cs-line-3);
}

.fb-loading,
.fb-empty {
  margin: 0;
  font-size: 12px;
  color: var(--cs-ghost);
  padding: 4px 2px;
}

.fb-item {
  display: block;
  text-decoration: none;
  padding: 12px 13px;
  border: 1px solid var(--cs-line-2);
  border-radius: 10px;
  background: var(--cs-surface);
}

.fb-item:hover {
  border-color: var(--cs-line-3);
}
</style>
