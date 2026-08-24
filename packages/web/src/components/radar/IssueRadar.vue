<script setup lang="ts">
// Issue Radar: the two accordions (issues, pull requests) shown in the focus
// zone in place of the sober empty-state message once a project is selected.
// Pure presentational orchestration: all fetching lives upstream (useIssues
// for issues, useTasks' mrsByProject/mrsLoadByProject for MRs, already wired
// in WorkspaceView); this component only sorts, filters, counts and persists
// the UI prefs.
import { computed, ref, watch } from 'vue'
import type { ProjectIssuesState } from '../../composables/useIssues'
import type { MrsLoadState } from '../../composables/useTasks'
import { t } from '../../i18n'
import type { ForgeMr } from '../../types'
import MrCard from '../mr/MrCard.vue'
import IssueCard from './IssueCard.vue'
import LabelChips from './LabelChips.vue'
import RadarAccordion from './RadarAccordion.vue'
import {
  radarFilterByLabels,
  radarFilterMrsByState,
  radarLabelCounts,
  radarSort,
  type MrStateFilter,
  type RadarSortKey,
} from './RadarLogic'
import { readRadarPrefs, writeRadarPrefs } from './RadarPrefs'

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
const prefs = ref(readRadarPrefs())

watch(prefs, (next) => writeRadarPrefs(next), { deep: true })

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
  set: (v: RadarSortKey) => (prefs.value = { ...prefs.value, issuesSort: v }),
})
const mrsSort = computed({
  get: () => prefs.value.mrsSort,
  set: (v: RadarSortKey) => (prefs.value = { ...prefs.value, mrsSort: v }),
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
  'no-remote': 'radar.issuesReasonNoRemote',
  'no-cli': 'radar.issuesReasonNoCli',
  'cli-error': 'radar.issuesReasonCliError',
  'invalid-input': 'radar.issuesReasonInvalidInput',
  unsupported: 'radar.issuesReasonUnsupported',
} as const

// Only labels can narrow the issues list (see radarFilterMrsByState's own
// doc: nothing else legitimately discriminates an OPEN-only corpus here).
const issuesFilterActive = computed(() => prefs.value.issuesLabels.length > 0)
const issuesLabelCounts = computed(() => radarLabelCounts(issuesLoaded.value ?? []))
const issuesVisible = computed(() =>
  issuesLoaded.value === null
    ? []
    : radarSort(
        radarFilterByLabels(issuesLoaded.value, prefs.value.issuesLabels),
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
    ? t('radar.countFiltered', { shown: issuesVisible.value.length, total })
    : total
})
const issuesTruncatedHint = computed(() =>
  issuesTruncated.value && issuesLoaded.value
    ? t('radar.truncatedHint', { n: issuesLoaded.value.length })
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
    ? t('radar.transportError', { error: props.mrsState.error })
    : null,
)
const mrsUnavailableKey = computed(() =>
  props.mrsState?.status === 'unavailable' ? MRS_REASON_KEY[props.mrsState.reason] : null,
)
const mrsDegraded = computed(
  () => mrsErrorMessage.value !== null || mrsUnavailableKey.value !== null,
)
const mrsStateFiltered = computed(() => radarFilterMrsByState(props.mrs, mrsFilter.value))
const mrsLabelCounts = computed(() => radarLabelCounts(mrsStateFiltered.value))
const mrsVisible = computed(() =>
  radarSort(radarFilterByLabels(mrsStateFiltered.value, prefs.value.mrsLabels), mrsSort.value),
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
    ? t('radar.countFiltered', { shown: mrsVisible.value.length, total })
    : total
})
const mrsTruncatedHint = computed(() =>
  props.mrsState?.status === 'loaded' && props.mrsState.truncated
    ? t('radar.truncatedHint', { n: props.mrs.length })
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
    return 'radar.mrsFilteredEmptyBoth'
  }
  return statusActive ? 'radar.mrsFilteredEmptyFilter' : 'radar.mrsFilteredEmptyLabels'
})

const MR_FILTERS: readonly MrStateFilter[] = ['all', 'draft', 'ready']
const MR_FILTER_LABEL_KEY = {
  all: 'radar.filterAll',
  draft: 'radar.filterDraft',
  ready: 'radar.filterReady',
} as const
</script>

<template>
  <div class="ir-root">
    <!-- ── Issues ──────────────────────────────────────────────────────── -->
    <RadarAccordion
      v-model:open="issuesOpen"
      :label="t('radar.issuesTitle')"
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
        <label class="ir-sort">
          <span class="ir-sort-label">{{ t('radar.sortLabel') }}</span>
          <select v-model="issuesSort" class="ir-sort-select">
            <option value="updated">{{ t('radar.sortUpdated') }}</option>
            <option value="title">{{ t('radar.sortTitle') }}</option>
          </select>
        </label>
      </template>

      <p v-if="issuesState.error !== null" class="ir-degraded">
        {{ t('radar.transportError', { error: issuesState.error }) }}
        <button class="ir-retry" type="button" @click="emit('retry-issues')">
          {{ t('radar.retry') }}
        </button>
      </p>
      <p v-else-if="issuesUnavailableReason !== null" class="ir-degraded">
        {{ t(ISSUES_REASON_KEY[issuesUnavailableReason]) }}
      </p>
      <p v-else-if="issuesLoaded === null" class="ir-loading">{{ t('radar.loading') }}</p>
      <p v-else-if="issuesLoaded.length === 0" class="ir-empty">{{ t('radar.issuesEmpty') }}</p>
      <!-- Distinct from the line above: the forge has issues, the LABEL
           filter is what leaves nothing on screen. -->
      <p v-else-if="issuesVisible.length === 0" class="ir-degraded">
        {{ t('radar.issuesFilteredEmpty') }}
        <button class="ir-retry" type="button" @click="clearIssueFilters">
          {{ t('radar.clearFilters') }}
        </button>
      </p>
      <a
        v-for="issue in issuesVisible"
        :key="issue.number"
        class="ir-item"
        :href="issue.url"
        target="_blank"
        rel="noopener noreferrer"
        :aria-label="t('radar.openItemAria', { title: issue.title })"
      >
        <IssueCard :issue="issue" />
      </a>
    </RadarAccordion>

    <!-- ── Pull requests ───────────────────────────────────────────────── -->
    <RadarAccordion
      v-model:open="mrsOpen"
      :label="t('radar.mrsTitle')"
      :count="mrsCount"
      :truncated-hint="mrsTruncatedHint"
    >
      <template v-if="!mrsDegraded && mrs.length > 0" #labels>
        <LabelChips :counts="mrsLabelCounts" :selected="prefs.mrsLabels" @toggle="toggleMrLabel" />
      </template>
      <template v-if="!mrsDegraded && mrs.length > 0" #filters>
        <div class="ir-filters" role="group" :aria-label="t('radar.filterAria')">
          <button
            v-for="filter in MR_FILTERS"
            :key="filter"
            type="button"
            class="ir-filter-chip"
            :class="{ 'ir-filter-chip--on': mrsFilter === filter }"
            :aria-pressed="mrsFilter === filter"
            @click="mrsFilter = filter"
          >
            {{ t(MR_FILTER_LABEL_KEY[filter]) }}
          </button>
        </div>
        <label class="ir-sort">
          <span class="ir-sort-label">{{ t('radar.sortLabel') }}</span>
          <select v-model="mrsSort" class="ir-sort-select">
            <option value="updated">{{ t('radar.sortUpdated') }}</option>
            <option value="title">{{ t('radar.sortTitle') }}</option>
          </select>
        </label>
      </template>

      <p v-if="mrsErrorMessage !== null" class="ir-degraded">
        {{ mrsErrorMessage }}
      </p>
      <p v-else-if="mrsUnavailableKey !== null" class="ir-degraded">
        {{ t(mrsUnavailableKey) }}
      </p>
      <p v-else-if="mrs.length === 0" class="ir-empty">{{ t('radar.mrsEmpty') }}</p>
      <!-- Distinct from the line above: the forge has MRs, the status filter
           and/or a label selection is what leaves nothing on screen. -->
      <p v-else-if="mrsVisible.length === 0" class="ir-degraded">
        {{ t(mrsFilteredEmptyKey) }}
        <button class="ir-retry" type="button" @click="clearMrFilters">
          {{ t('radar.clearFilters') }}
        </button>
      </p>
      <a
        v-for="mr in mrsVisible"
        :key="mr.number"
        class="ir-item"
        :href="mr.url"
        target="_blank"
        rel="noopener noreferrer"
        :aria-label="t('radar.openItemAria', { title: mr.title })"
      >
        <MrCard :mr="mr" />
      </a>
    </RadarAccordion>
  </div>
</template>

<style scoped>
.ir-root {
  display: flex;
  flex-direction: column;
  gap: 22px;
  max-width: 720px;
  width: 100%;
  margin: 32px auto;
  padding: 0 24px 40px;
}

.ir-sort {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.ir-sort-label {
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--cs-ghost);
}

.ir-sort-select {
  font-family: inherit;
  font-size: 11.5px;
  color: var(--cs-text-2);
  background: var(--cs-surface);
  border: 1px solid var(--cs-line-2);
  border-radius: 6px;
  padding: 3px 7px;
}

.ir-filters {
  display: inline-flex;
  border: 1px solid var(--cs-line-2);
  border-radius: 8px;
  overflow: hidden;
}

.ir-filter-chip {
  font-size: 11.5px;
  font-weight: 600;
  font-family: inherit;
  padding: 4px 10px;
  border: none;
  background: var(--cs-surface);
  color: var(--cs-muted);
  cursor: pointer;
}

.ir-filter-chip + .ir-filter-chip {
  border-left: 1px solid var(--cs-line-2);
}

/* The active filter is a state: colored, per the doctrine. */
.ir-filter-chip--on {
  background: var(--cs-green-soft);
  color: var(--cs-text);
}

.ir-degraded {
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

.ir-retry {
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

.ir-retry:hover {
  border-color: var(--cs-line-3);
}

.ir-loading,
.ir-empty {
  margin: 0;
  font-size: 12px;
  color: var(--cs-ghost);
  padding: 4px 2px;
}

.ir-item {
  display: block;
  text-decoration: none;
  padding: 12px 13px;
  border: 1px solid var(--cs-line-2);
  border-radius: 10px;
  background: var(--cs-surface);
}

.ir-item:hover {
  border-color: var(--cs-line-3);
}
</style>
