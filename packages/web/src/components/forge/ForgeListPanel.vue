<script lang="ts">
// Pure predicate, exported for direct unit testing: the local search box
// narrows whichever section is currently on screen by title or number,
// independent of the sort/label-filter/status-filter narrowing ForgeLogic.ts
// already owns.
export function matchesForgeSearch(title: string, itemNumber: number, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') {
    return true
  }
  const numberQuery = q.startsWith('#') ? q.slice(1) : q
  return title.toLowerCase().includes(q) || String(itemNumber).includes(numberQuery)
}

/**
 * Loading placeholder geometry: five card-shaped rows, each a muted line, so
 * the list keeps its height while the fetch resolves. No motion: the row is a
 * static placeholder, not an animated shimmer.
 */
export const SKELETON_CARD_COUNT = 5
</script>

<script setup lang="ts">
// The forge board's list panel: the actual functional issue/MR list
// (loading / transport error / forge unavailable / empty / filtered-empty /
// list states), carried over from the old two-accordion ForgeBoard.vue body.
// Sort / status filter / label chips are rendered by ForgeControlsPanel.vue
// now; this panel only reads the current sort/filter/label SELECTION (still
// needed to compute what is actually visible), applies its own local text
// search on top, and renders the result. Only ONE section is shown at a time
// (the active section picked in the controls panel), always fully expanded,
// since there is only one section on screen to fold. Clicking an item selects
// it (for the detail panel) instead of opening it in a new tab; the external
// "open in forge" link lives on the detail panel.
import { RefreshCw, Search, X } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import type { ProjectIssuesState } from '../../composables/useIssues'
import type { MrsLoadState } from '../../composables/useTasks'
import { t } from '../../i18n'
import { formatRelativeAge } from '../../relative-time'
import type { ForgeMr } from '../../types'
import MrCard from '../mr/MrCard.vue'
import ForgeIssueCard from './ForgeIssueCard.vue'
import {
  forgeFilterByLabels,
  forgeFilterMrsByDraft,
  forgeSort,
  type ForgeSelection,
  type ForgeSortKey,
} from './ForgeLogic'

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
  mrsDraftOnly: boolean
  mrsLabels: string[]
  selection: ForgeSelection | null
}>()

const emit = defineEmits<{
  'clear-issue-filters': []
  'clear-mr-filters': []
  'retry-issues': []
  'refresh-mrs': []
  select: [selection: ForgeSelection]
}>()

function isSelected(kind: ForgeSelection['kind'], number: number): boolean {
  return (
    props.selection !== null && props.selection.kind === kind && props.selection.number === number
  )
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

// Only labels can narrow the issues list (see forgeFilterMrsByDraft's own
// doc: nothing else legitimately discriminates an OPEN-only corpus here).
const issuesFilterActive = computed(() => props.issuesLabels.length > 0)
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
const mrsTruncated = computed(() => props.mrsState?.status === 'loaded' && props.mrsState.truncated)
const mrsStateFiltered = computed(() => forgeFilterMrsByDraft(props.mrs, props.mrsDraftOnly))
const mrsVisible = computed(() =>
  forgeSort(forgeFilterByLabels(mrsStateFiltered.value, props.mrsLabels), props.mrsSort),
)
const mrsFilterActive = computed(() => props.mrsDraftOnly || props.mrsLabels.length > 0)
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
  mrsTruncated.value ? t('forge.truncatedHint', { n: props.mrs.length }) : null,
)
/**
 * Which filter(s) to name in the "your filter matches nothing" message:
 * distinct wording per dimension actually engaged, so the reader is told
 * exactly what to release rather than a generic "try something else".
 */
const mrsFilteredEmptyKey = computed(() => {
  const statusActive = props.mrsDraftOnly
  const labelsActive = props.mrsLabels.length > 0
  if (statusActive && labelsActive) {
    return 'forge.mrsFilteredEmptyBoth'
  }
  return statusActive ? 'forge.mrsFilteredEmptyFilter' : 'forge.mrsFilteredEmptyLabels'
})

// ── Local text search: a further narrowing pass on top of sort/label/status
// filtering above, scoped to whichever section is currently on screen ──
const searchQuery = ref('')
const issuesSearched = computed(() =>
  issuesVisible.value.filter((issue) =>
    matchesForgeSearch(issue.title, issue.number, searchQuery.value),
  ),
)
const mrsSearched = computed(() =>
  mrsVisible.value.filter((mr) => matchesForgeSearch(mr.title, mr.number, searchQuery.value)),
)

// ── Footer: what actually landed on screen, and when it last changed. Two
// independent timestamps (one per section) so switching sections never
// borrows the other section's freshness. ──
const issuesUpdatedAt = ref(new Date().toISOString())
const mrsUpdatedAt = ref(new Date().toISOString())
watch(
  () => props.issuesState.result,
  () => {
    issuesUpdatedAt.value = new Date().toISOString()
  },
)
watch(
  () => props.mrsState,
  () => {
    mrsUpdatedAt.value = new Date().toISOString()
  },
)

/** Never claims the cap as a total: a truncated corpus says so explicitly,
 * the same wording the truncation hint above already uses. */
const footerCountText = computed(() => {
  if (props.section === 'issues') {
    if (issuesTruncated.value && issuesLoaded.value !== null) {
      return t('forge.truncatedHint', { n: issuesLoaded.value.length })
    }
    const n = issuesSearched.value.length
    return t('forge.listFooterCountIssues', { n }, n)
  }
  if (mrsTruncated.value) {
    return t('forge.truncatedHint', { n: props.mrs.length })
  }
  const n = mrsSearched.value.length
  return t('forge.listFooterCountMrs', { n }, n)
})

const footerFreshnessText = computed(() => {
  const iso = props.section === 'issues' ? issuesUpdatedAt.value : mrsUpdatedAt.value
  return t('forge.listFooterFreshness', { age: formatRelativeAge(iso) })
})

/** MRs carry no distinct loading status today (see MrsLoadState): the button
 * still refreshes them, it just never visibly spins. */
const footerRefreshSpinning = computed(
  () => props.section === 'issues' && props.issuesState.loading,
)

function onFooterRefresh(): void {
  if (props.section === 'issues') {
    emit('retry-issues')
  } else {
    emit('refresh-mrs')
  }
}
</script>

<template>
  <div class="flp-root">
    <div class="flp-search">
      <div class="flp-search-pill">
        <Search class="flp-search-icon" aria-hidden="true" />
        <input
          v-model="searchQuery"
          type="text"
          class="flp-search-input"
          :placeholder="t('forge.listSearchPlaceholder')"
          :aria-label="t('forge.listSearchPlaceholder')"
        />
        <button
          v-if="searchQuery !== ''"
          type="button"
          class="flp-search-clear"
          :aria-label="t('forge.listSearchClear')"
          @click="searchQuery = ''"
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </div>

    <div class="flp-scroll">
      <template v-if="section === 'issues'">
        <div class="flp-head">
          <span class="flp-heading">{{ t('forge.issuesTitle') }}</span>
          <span v-if="issuesCount !== null" class="flp-count">{{ issuesCount }}</span>
        </div>
        <p v-if="issuesTruncatedHint" class="flp-truncated">{{ issuesTruncatedHint }}</p>

        <p v-if="issuesState.error !== null" class="flp-degraded">
          {{ t('forge.transportError', { error: issuesState.error }) }}
          <button class="flp-retry" type="button" @click="emit('retry-issues')">
            {{ t('forge.retry') }}
          </button>
        </p>
        <p v-else-if="issuesUnavailableReason !== null" class="flp-degraded">
          {{ t(ISSUES_REASON_KEY[issuesUnavailableReason]) }}
        </p>
        <div
          v-else-if="issuesLoaded === null"
          class="flp-skeleton"
          role="status"
          :aria-label="t('forge.loading')"
        >
          <div v-for="i in SKELETON_CARD_COUNT" :key="i" class="flp-skel-card">
            <span class="flp-skel-line muted" />
            <span class="flp-skel-line flp-skel-line--short muted" />
          </div>
        </div>
        <p v-else-if="issuesLoaded.length === 0" class="flp-empty">{{ t('forge.issuesEmpty') }}</p>
        <!-- Distinct from the line above: the forge has issues, the LABEL
             filter is what leaves nothing on screen. -->
        <p v-else-if="issuesVisible.length === 0" class="flp-degraded">
          {{ t('forge.issuesFilteredEmpty') }}
          <button class="flp-retry" type="button" @click="emit('clear-issue-filters')">
            {{ t('forge.clearFilters') }}
          </button>
        </p>
        <!-- Distinct again: labels matched, the local text search is what
             leaves nothing on screen. -->
        <p v-else-if="issuesSearched.length === 0" class="flp-degraded">
          {{ t('forge.listSearchEmpty') }}
          <button class="flp-retry" type="button" @click="searchQuery = ''">
            {{ t('forge.listSearchClear') }}
          </button>
        </p>
        <button
          v-for="issue in issuesSearched"
          :key="issue.number"
          type="button"
          class="flp-item card"
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

        <p v-if="mrsErrorMessage !== null" class="flp-degraded">{{ mrsErrorMessage }}</p>
        <p v-else-if="mrsUnavailableKey !== null" class="flp-degraded">
          {{ t(mrsUnavailableKey) }}
        </p>
        <p v-else-if="mrs.length === 0" class="flp-empty">{{ t('forge.mrsEmpty') }}</p>
        <!-- Distinct from the line above: the forge has MRs, the status filter
             and/or a label selection is what leaves nothing on screen. -->
        <p v-else-if="mrsVisible.length === 0" class="flp-degraded">
          {{ t(mrsFilteredEmptyKey) }}
          <button class="flp-retry" type="button" @click="emit('clear-mr-filters')">
            {{ t('forge.clearFilters') }}
          </button>
        </p>
        <!-- Distinct again: the status filter and labels matched, the local
             text search is what leaves nothing on screen. -->
        <p v-else-if="mrsSearched.length === 0" class="flp-degraded">
          {{ t('forge.listSearchEmpty') }}
          <button class="flp-retry" type="button" @click="searchQuery = ''">
            {{ t('forge.listSearchClear') }}
          </button>
        </p>
        <button
          v-for="mr in mrsSearched"
          :key="mr.number"
          type="button"
          class="flp-item card"
          :class="{ 'flp-item--on': isSelected('mr', mr.number) }"
          :aria-current="isSelected('mr', mr.number) ? 'true' : undefined"
          :aria-label="t('forge.selectItemAria', { title: mr.title })"
          @click="emit('select', { kind: 'mr', number: mr.number })"
        >
          <MrCard :mr="mr" />
        </button>
      </template>
    </div>

    <div class="flp-footer">
      <span class="flp-footer-count">{{ footerCountText }}</span>
      <span class="flp-footer-fresh">
        {{ footerFreshnessText }}
        <button
          type="button"
          class="flp-footer-refresh"
          :class="{ 'flp-footer-refresh--spin': footerRefreshSpinning }"
          :aria-label="t('forge.listFooterRefresh')"
          @click="onFooterRefresh"
        >
          <RefreshCw aria-hidden="true" />
        </button>
      </span>
    </div>
  </div>
</template>

<style scoped>
.flp-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.flp-search {
  flex: none;
  padding: calc(var(--row) / 2) 2ch;
}

.flp-search-pill {
  display: flex;
  align-items: center;
  gap: 1ch;
  border: 1px solid var(--line);
  padding: 0 1ch;
  background: var(--bg-raised);
}

.flp-search-pill:focus-within {
  border-color: var(--accent);
}

.flp-search-icon {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--fg-muted);
}

.flp-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font: inherit;
  padding: 2px 0;
  color: var(--fg);
}

.flp-search-input::placeholder {
  color: var(--fg-dim);
}

.flp-search-clear {
  flex: none;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  padding: 0;
}

.flp-search-clear:hover {
  color: var(--fg);
}

.flp-search-clear svg {
  width: 100%;
  height: 100%;
}

.flp-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
  padding: 0 2ch calc(var(--row) / 2);
}

.flp-head {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  border-bottom: 1px solid var(--line);
  padding-bottom: 2px;
}

.flp-heading {
  font-weight: 700;
  color: var(--fg);
}

.flp-count {
  font-size: 12px;
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}

.flp-truncated {
  margin: 0;
  font-size: 12px;
  color: var(--fg-dim);
}

.flp-degraded {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 2ch;
  color: var(--warn);
  border-left: 3px solid var(--warn);
  padding: 2px 1ch;
}

.flp-retry {
  flex: none;
  font: inherit;
  padding: 0 1ch;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--fg);
  cursor: pointer;
}

.flp-retry:hover {
  background: var(--bg-hover);
}

.flp-empty {
  margin: 0;
  color: var(--fg-dim);
  padding: calc(var(--row) / 2) 0;
}

.flp-item {
  width: 100%;
  text-align: left;
  font: inherit;
  color: var(--fg);
}

/* The selected item is a state: colored border, per the doctrine. The fill
   never changes on selection, only on hover -- selection and hover are two
   independent signals. */
.flp-item--on {
  --c: var(--ok);
  border-color: var(--ok);
}

.flp-footer {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2ch;
  padding: calc(var(--row) / 2) 2ch;
  font-size: 12px;
  color: var(--fg-dim);
  border-top: 1px solid var(--line);
}

.flp-footer-fresh {
  display: inline-flex;
  align-items: center;
  gap: 1ch;
}

.flp-footer-refresh {
  flex: none;
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  padding: 0;
}

.flp-footer-refresh svg {
  width: 100%;
  height: 100%;
}

.flp-footer-refresh:hover {
  color: var(--fg);
}

/* Same running signal as .status[data-s='running']: the shared blink, never a
   spin of its own. */
.flp-footer-refresh--spin {
  color: var(--info);
  animation: blink 1.2s steps(2) infinite;
}

.flp-skeleton {
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
}

.flp-skel-card {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: calc(var(--row) / 2) 1ch;
  border: 1px solid var(--line);
  border-left-width: 3px;
}

.flp-skel-line {
  height: 2px;
  width: 100%;
  background: var(--line);
}

.flp-skel-line--short {
  width: 45%;
}
</style>
