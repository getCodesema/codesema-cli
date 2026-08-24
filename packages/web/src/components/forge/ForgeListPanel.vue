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
 * Loading skeleton geometry: five cards, each element inside a card staggers
 * further than the previous element, and each card staggers further than the
 * previous card, so the shimmer sweeps the list diagonally rather than
 * pulsing as one block.
 */
export const SKELETON_CARD_COUNT = 5
const SKELETON_STAGGER_STEP = 0.06
export const SKELETON_ELEMENT_OFFSETS = {
  icon: 0,
  number: 0.04,
  author: 0.08,
  age: 0.12,
  title: 0.16,
} as const

export function skeletonDelay(cardIndex: number, elementOffset: number): string {
  return `${(cardIndex * SKELETON_STAGGER_STEP + elementOffset).toFixed(2)}s`
}

/** Cycled (not repeated) across the five skeleton cards so the title bars
 * never all share the same width, which would read as a comb rather than
 * placeholder text. */
const SKELETON_TITLE_WIDTHS = ['88%', '70%', '80%'] as const

export function skeletonTitleWidth(cardIndex: number): string {
  return SKELETON_TITLE_WIDTHS[cardIndex % SKELETON_TITLE_WIDTHS.length] ?? '80%'
}
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
  forgeFilterMrsByState,
  forgeSort,
  type ForgeSelection,
  type ForgeSortKey,
  type MrStateFilter,
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
  mrsFilter: MrStateFilter
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

// Only labels can narrow the issues list (see forgeFilterMrsByState's own
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
const mrsStateFiltered = computed(() => forgeFilterMrsByState(props.mrs, props.mrsFilter))
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
  mrsTruncated.value ? t('forge.truncatedHint', { n: props.mrs.length }) : null,
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
        <svg class="flp-search-icon" aria-hidden="true" viewBox="0 0 16 16">
          <circle cx="6.7" cy="6.7" r="4.2" />
          <path d="M9.8 9.8L13 13" />
        </svg>
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
          <svg aria-hidden="true" viewBox="0 0 16 16"><path d="M3 3l8 8M11 3l-8 8" /></svg>
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
            <div class="flp-skel-head">
              <span
                class="flp-skel-bar flp-skel-icon"
                :style="{ animationDelay: skeletonDelay(i - 1, SKELETON_ELEMENT_OFFSETS.icon) }"
              />
              <span
                class="flp-skel-bar flp-skel-number"
                :style="{ animationDelay: skeletonDelay(i - 1, SKELETON_ELEMENT_OFFSETS.number) }"
              />
              <span
                class="flp-skel-bar flp-skel-author"
                :style="{ animationDelay: skeletonDelay(i - 1, SKELETON_ELEMENT_OFFSETS.author) }"
              />
              <span
                class="flp-skel-bar flp-skel-age"
                :style="{ animationDelay: skeletonDelay(i - 1, SKELETON_ELEMENT_OFFSETS.age) }"
              />
            </div>
            <span
              class="flp-skel-bar flp-skel-title"
              :style="{
                animationDelay: skeletonDelay(i - 1, SKELETON_ELEMENT_OFFSETS.title),
                width: skeletonTitleWidth(i - 1),
              }"
            />
            <span
              class="flp-skel-bar flp-skel-title flp-skel-title--second"
              :style="{ animationDelay: skeletonDelay(i - 1, SKELETON_ELEMENT_OFFSETS.title) }"
            />
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
          <svg aria-hidden="true" viewBox="0 0 16 16">
            <path d="M13 8A5 5 0 1 1 11.5 4.4" />
            <path d="M13 3.5v3.2h-3.2" />
          </svg>
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
  padding: 8px 16px 6px;
}

.flp-search-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--cs-line-2);
  border-radius: 12px;
  padding: 0 10px;
  background: var(--cs-inset);
}

.flp-search-pill:focus-within {
  border-color: var(--cs-green-ring);
}

.flp-search-icon {
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--cs-ghost);
}

.flp-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-family: inherit;
  font-size: 13px;
  padding: 10px 0;
  color: var(--cs-text);
}

.flp-search-input::placeholder {
  color: var(--cs-ghost);
}

.flp-search-clear {
  flex: none;
  width: 13px;
  height: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--cs-ghost);
  cursor: pointer;
  padding: 0;
}

.flp-search-clear:hover {
  color: var(--cs-text-2);
}

.flp-search-icon,
.flp-search-clear svg {
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
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
  gap: 8px;
  padding: 0 16px 8px;
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
  padding: 10px;
  border: 1px solid var(--cs-line-2);
  border-radius: 12px;
  background: var(--cs-surface);
  cursor: pointer;
}

.flp-item:hover {
  border-color: var(--cs-line-3);
  background: var(--cs-surface-2);
}

/* The selected item is a state: colored border, per the doctrine. The fill
   never changes on selection, only on hover -- selection and hover are two
   independent signals. */
.flp-item--on {
  border-color: var(--cs-green-ring);
}

.flp-footer {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 16px 16px;
  font-size: 12px;
  color: var(--cs-ghost);
}

.flp-footer-fresh {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.flp-footer-refresh {
  flex: none;
  width: 13px;
  height: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--cs-ghost);
  cursor: pointer;
  padding: 0;
}

.flp-footer-refresh svg {
  width: 100%;
  height: 100%;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.flp-footer-refresh:hover {
  color: var(--cs-text-2);
}

.flp-footer-refresh--spin {
  animation: flp-spin 0.9s linear infinite;
}

@keyframes flp-spin {
  to {
    transform: rotate(360deg);
  }
}

.flp-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.flp-skel-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  border: 1px solid var(--cs-line-2);
  border-radius: 12px;
  background: var(--cs-surface);
}

.flp-skel-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.flp-skel-bar {
  border-radius: 4px;
  background: linear-gradient(
    90deg,
    var(--cs-line-2) 25%,
    var(--cs-line-3) 37%,
    var(--cs-line-2) 63%
  );
  background-size: 400% 100%;
  animation: flp-shimmer 1.4s ease-in-out infinite;
}

.flp-skel-icon {
  width: 13px;
  height: 13px;
  border-radius: 50%;
}

.flp-skel-number {
  width: 30px;
  height: 11px;
}

.flp-skel-author {
  width: 56px;
  height: 11px;
}

.flp-skel-age {
  width: 40px;
  height: 11px;
  margin-left: auto;
}

.flp-skel-title {
  width: 100%;
  height: 13px;
  margin-top: 2px;
}

.flp-skel-title--second {
  width: 45%;
}

@keyframes flp-shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: 0 0;
  }
}
</style>
