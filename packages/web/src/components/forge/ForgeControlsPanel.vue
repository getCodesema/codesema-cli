<script setup lang="ts">
// The forge board's controls panel: two accordion sections (issues, pull
// requests) that ARE the section switch (opening one closes the other and
// picks what the neighboring list panel shows, see `activeSection`), each
// carrying its own sort / status filter / label search, moved here from
// ForgeListPanel.vue so the list panel stays a pure list renderer. Own
// collapse toggle too.
//
// Collapsed: not just a bare toggle button. The whole 48px band shows the
// project name in vertical, top-to-bottom writing mode, truncated to the
// band's height, and the ENTIRE band is the reopen control (not a small
// icon tucked in a corner). Below the shell's own 640px width (the same
// breakpoint the three panels stack at, reused here rather than a separate
// one), the band flips to a short horizontal bar at the top, text no longer
// rotated.
import {
  ArrowUpDown,
  ChevronDown,
  ChevronsLeft,
  CircleDot,
  Clock,
  GitPullRequest,
  List,
  ListFilter,
  Search,
  Tag,
  X,
} from '@lucide/vue'
import { computed, nextTick, ref } from 'vue'
import type { ProjectIssuesState } from '../../composables/useIssues'
import type { MrsLoadState } from '../../composables/useTasks'
import { t } from '../../i18n'
import type { ForgeMr } from '../../types'
import {
  filterLabelCounts,
  forgeFilterMrsByState,
  forgeLabelCounts,
  type ForgeSortKey,
  type MrStateFilter,
} from './ForgeLogic'
import type { ForgeSection } from './ForgePrefs'
import LabelChips from './LabelChips.vue'

const props = defineProps<{
  /** Whether a board is up. The rail itself is PERMANENT: it carries the
   * project menu at all times, and only grows its filter sections when
   * there is a list for them to filter. Sections that filtered nothing
   * would be controls that do not control anything. */
  hasBoard: boolean
  activeSection: ForgeSection
  collapsed: boolean
  projectName: string
  issuesState: ProjectIssuesState
  issuesSort: ForgeSortKey
  issuesLabels: string[]
  mrs: ForgeMr[]
  mrsState: MrsLoadState | null
  mrsSort: ForgeSortKey
  mrsFilter: MrStateFilter
  mrsLabels: string[]
}>()

const emit = defineEmits<{
  'update:activeSection': [section: ForgeSection]
  'update:collapsed': [collapsed: boolean]
  'update:issuesSort': [sort: ForgeSortKey]
  'update:mrsSort': [sort: ForgeSortKey]
  'update:mrsFilter': [filter: MrStateFilter]
  'toggle-issue-label': [label: string]
  'toggle-mr-label': [label: string]
}>()

function openSection(section: ForgeSection): void {
  emit('update:activeSection', section)
}

// ── Issues: label counts, gated on there actually being loaded items to
// control (mirrors ForgeListPanel's own former gate on its controls row) ──
const issuesLoaded = computed(() => {
  const result = props.issuesState.result
  return result !== null && result.available ? result.issues : null
})
const issuesHasData = computed(() => (issuesLoaded.value?.length ?? 0) > 0)
const issuesLabelCounts = computed(() => forgeLabelCounts(issuesLoaded.value ?? []))

// ── Pull requests: same gate as ForgeListPanel's former `!mrsDegraded && mrs.length > 0` ──
const mrsDegraded = computed(
  () => props.mrsState?.status === 'error' || props.mrsState?.status === 'unavailable',
)
const mrsHasData = computed(() => !mrsDegraded.value && props.mrs.length > 0)
const mrsStateFiltered = computed(() => forgeFilterMrsByState(props.mrs, props.mrsFilter))
const mrsLabelCounts = computed(() => forgeLabelCounts(mrsStateFiltered.value))
const mrsFilterActive = computed(() => props.mrsFilter !== 'all')

// ── Sort rows: same two criteria on both sections (see ForgeLogic.ts's own doc) ──
type SortOption = { value: ForgeSortKey; labelKey: string }
const SORT_OPTIONS: readonly SortOption[] = [
  { value: 'updated', labelKey: 'forge.sortUpdated' },
  { value: 'title', labelKey: 'forge.sortTitle' },
]

// ── Status filter rows (MRs only): mutually exclusive states above the
// separator, cumulable toggles below. Only `draft`/`ready` are backed by
// data today (an OPEN-only corpus can't honor `open`/`merged`/`closed`, see
// matchesMrStateFilter's own doc) and no cumulable toggle exists yet, so
// that second group starts empty and the separator stays hidden until it
// gains an entry -- extending either group is one more object in its array,
// never a rewrite of this list or of the template that renders it.
type MrFilterEntry = { value: MrStateFilter; labelKey: string }
const MR_EXCLUSIVE_FILTERS: readonly MrFilterEntry[] = [
  { value: 'draft', labelKey: 'forge.filterDraft' },
  { value: 'ready', labelKey: 'forge.filterReady' },
]
const MR_TOGGLE_FILTERS: readonly MrFilterEntry[] = []
const showMrFilterSeparator = MR_EXCLUSIVE_FILTERS.length > 0 && MR_TOGGLE_FILTERS.length > 0

function selectMrFilter(value: MrStateFilter): void {
  emit('update:mrsFilter', value)
}
function resetMrFilter(): void {
  emit('update:mrsFilter', 'all')
}

// ── Label search: closed by default, opened by the magnifier in each
// section's own "labels" block header. Focuses on open; closing always
// clears the query, never leaves a stale filter active but invisible. ──
const issuesLabelSearchOpen = ref(false)
const issuesLabelQuery = ref('')
const issuesLabelSearchInput = ref<HTMLInputElement | null>(null)
const mrsLabelSearchOpen = ref(false)
const mrsLabelQuery = ref('')
const mrsLabelSearchInput = ref<HTMLInputElement | null>(null)

async function openIssuesLabelSearch(): Promise<void> {
  issuesLabelSearchOpen.value = true
  await nextTick()
  issuesLabelSearchInput.value?.focus()
}
function closeIssuesLabelSearch(): void {
  issuesLabelSearchOpen.value = false
  issuesLabelQuery.value = ''
}
async function openMrsLabelSearch(): Promise<void> {
  mrsLabelSearchOpen.value = true
  await nextTick()
  mrsLabelSearchInput.value?.focus()
}
function closeMrsLabelSearch(): void {
  mrsLabelSearchOpen.value = false
  mrsLabelQuery.value = ''
}

const issuesLabelCountsFiltered = computed(() =>
  filterLabelCounts(issuesLabelCounts.value, issuesLabelQuery.value),
)
const mrsLabelCountsFiltered = computed(() =>
  filterLabelCounts(mrsLabelCounts.value, mrsLabelQuery.value),
)
</script>

<template>
  <div class="fcp-root" :class="{ 'fcp-root--collapsed': collapsed }">
    <!-- Collapsed: the whole band is the reopen control, carrying the
         project name, no separate small toggle button. -->
    <button
      v-if="collapsed"
      type="button"
      class="fcp-band"
      :aria-label="t('forge.controlsExpand')"
      :aria-expanded="false"
      :title="projectName"
      @click="emit('update:collapsed', false)"
    >
      <span class="fcp-band-name">{{ projectName }}</span>
    </button>

    <template v-else>
      <button
        type="button"
        class="fcp-collapse"
        :aria-label="t('forge.controlsCollapse')"
        :aria-expanded="true"
        @click="emit('update:collapsed', true)"
      >
        <ChevronsLeft aria-hidden="true" />
      </button>

      <!-- The rail's head: whatever the shell puts above the sections. The
           board fills it with the project menu, so that navigation and
           controls are ONE column instead of two (the reference interface
           has three columns, not four: its left rail carries its filter
           accordions). Empty when nothing is passed, which is why the
           wrapper collapses to nothing rather than reserving space. -->
      <div class="fcp-top">
        <slot name="top" />
      </div>

      <div v-if="hasBoard" class="fcp-sections" :aria-label="t('forge.sectionNavAria')">
        <!-- Issues section -->
        <section class="fcp-section">
          <button
            type="button"
            class="fcp-acc-head"
            :aria-expanded="activeSection === 'issues'"
            aria-controls="fcp-body-issues"
            @click="openSection('issues')"
          >
            <CircleDot class="fcp-acc-icon" aria-hidden="true" />
            <span class="fcp-acc-label">{{ t('forge.issuesTitle') }}</span>
            <ChevronDown
              class="fcp-acc-chevron"
              :class="{ 'fcp-acc-chevron--closed': activeSection !== 'issues' }"
              aria-hidden="true"
            />
          </button>
          <div v-if="activeSection === 'issues'" id="fcp-body-issues" class="fcp-acc-body">
            <template v-if="issuesHasData">
              <div class="fcp-block">
                <h3 class="fcp-block-title">
                  <span class="fcp-block-title-text">
                    <ArrowUpDown class="fcp-block-icon" aria-hidden="true" />
                    {{ t('forge.sortLabel') }}
                  </span>
                </h3>
                <div class="fcp-row-list" role="radiogroup" :aria-label="t('forge.sortLabel')">
                  <button
                    v-for="opt in SORT_OPTIONS"
                    :key="opt.value"
                    type="button"
                    class="fcp-row"
                    :class="{ 'fcp-row--on': issuesSort === opt.value }"
                    role="radio"
                    :aria-checked="issuesSort === opt.value"
                    @click="emit('update:issuesSort', opt.value)"
                  >
                    <Clock v-if="opt.value === 'updated'" class="fcp-row-icon" aria-hidden="true" />
                    <List v-else class="fcp-row-icon" aria-hidden="true" />
                    {{ t(opt.labelKey) }}
                  </button>
                </div>
              </div>

              <div class="fcp-block">
                <h3 class="fcp-block-title">
                  <span class="fcp-block-title-text">
                    <Tag class="fcp-block-icon" aria-hidden="true" />
                    {{ t('forge.controlsLabelsHeading') }}
                  </span>
                  <button
                    type="button"
                    class="fcp-search-toggle"
                    :class="{ 'fcp-search-toggle--on': issuesLabelSearchOpen }"
                    :aria-label="
                      issuesLabelSearchOpen
                        ? t('forge.controlsLabelSearchClose')
                        : t('forge.controlsLabelSearchOpen')
                    "
                    :aria-expanded="issuesLabelSearchOpen"
                    @click="
                      issuesLabelSearchOpen ? closeIssuesLabelSearch() : openIssuesLabelSearch()
                    "
                  >
                    <Search aria-hidden="true" />
                  </button>
                </h3>
                <div v-if="issuesLabelSearchOpen" class="fcp-label-search">
                  <input
                    ref="issuesLabelSearchInput"
                    v-model="issuesLabelQuery"
                    type="text"
                    class="fcp-label-search-input"
                    :placeholder="t('forge.controlsLabelSearchPlaceholder')"
                    :aria-label="t('forge.controlsLabelSearchPlaceholder')"
                  />
                  <button
                    type="button"
                    class="fcp-label-search-close"
                    :aria-label="t('forge.controlsLabelSearchClose')"
                    @click="closeIssuesLabelSearch"
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
                <LabelChips
                  :counts="issuesLabelCountsFiltered"
                  :selected="issuesLabels"
                  @toggle="(label) => emit('toggle-issue-label', label)"
                />
              </div>
            </template>
          </div>
        </section>

        <!-- Pull requests section -->
        <section class="fcp-section">
          <button
            type="button"
            class="fcp-acc-head"
            :aria-expanded="activeSection === 'mrs'"
            aria-controls="fcp-body-mrs"
            @click="openSection('mrs')"
          >
            <GitPullRequest class="fcp-acc-icon" aria-hidden="true" />
            <span class="fcp-acc-label">{{ t('forge.mrsTitle') }}</span>
            <ChevronDown
              class="fcp-acc-chevron"
              :class="{ 'fcp-acc-chevron--closed': activeSection !== 'mrs' }"
              aria-hidden="true"
            />
          </button>
          <div v-if="activeSection === 'mrs'" id="fcp-body-mrs" class="fcp-acc-body">
            <template v-if="mrsHasData">
              <div class="fcp-block">
                <h3 class="fcp-block-title">
                  <span class="fcp-block-title-text">
                    <ArrowUpDown class="fcp-block-icon" aria-hidden="true" />
                    {{ t('forge.sortLabel') }}
                  </span>
                </h3>
                <div class="fcp-row-list" role="radiogroup" :aria-label="t('forge.sortLabel')">
                  <button
                    v-for="opt in SORT_OPTIONS"
                    :key="opt.value"
                    type="button"
                    class="fcp-row"
                    :class="{ 'fcp-row--on': mrsSort === opt.value }"
                    role="radio"
                    :aria-checked="mrsSort === opt.value"
                    @click="emit('update:mrsSort', opt.value)"
                  >
                    <Clock v-if="opt.value === 'updated'" class="fcp-row-icon" aria-hidden="true" />
                    <List v-else class="fcp-row-icon" aria-hidden="true" />
                    {{ t(opt.labelKey) }}
                  </button>
                </div>
              </div>

              <div class="fcp-block">
                <h3 class="fcp-block-title">
                  <span class="fcp-block-title-text">
                    <ListFilter class="fcp-block-icon" aria-hidden="true" />
                    {{ t('forge.controlsFiltersHeading') }}
                  </span>
                  <button
                    v-if="mrsFilterActive"
                    type="button"
                    class="fcp-reset"
                    @click="resetMrFilter"
                  >
                    <X aria-hidden="true" />
                    {{ t('forge.controlsFiltersReset') }}
                  </button>
                </h3>
                <div class="fcp-row-list" role="radiogroup" :aria-label="t('forge.filterAria')">
                  <button
                    v-for="f in MR_EXCLUSIVE_FILTERS"
                    :key="f.value"
                    type="button"
                    class="fcp-row"
                    :class="{ 'fcp-row--on': mrsFilter === f.value }"
                    role="radio"
                    :aria-checked="mrsFilter === f.value"
                    @click="selectMrFilter(f.value)"
                  >
                    {{ t(f.labelKey) }}
                  </button>
                  <div v-if="showMrFilterSeparator" class="fcp-filter-sep" role="none" />
                  <button
                    v-for="f in MR_TOGGLE_FILTERS"
                    :key="f.value"
                    type="button"
                    class="fcp-row"
                    :class="{ 'fcp-row--on': mrsFilter === f.value }"
                    role="radio"
                    :aria-checked="mrsFilter === f.value"
                    @click="selectMrFilter(f.value)"
                  >
                    {{ t(f.labelKey) }}
                  </button>
                </div>
              </div>

              <div class="fcp-block">
                <h3 class="fcp-block-title">
                  <span class="fcp-block-title-text">
                    <Tag class="fcp-block-icon" aria-hidden="true" />
                    {{ t('forge.controlsLabelsHeading') }}
                  </span>
                  <button
                    type="button"
                    class="fcp-search-toggle"
                    :class="{ 'fcp-search-toggle--on': mrsLabelSearchOpen }"
                    :aria-label="
                      mrsLabelSearchOpen
                        ? t('forge.controlsLabelSearchClose')
                        : t('forge.controlsLabelSearchOpen')
                    "
                    :aria-expanded="mrsLabelSearchOpen"
                    @click="mrsLabelSearchOpen ? closeMrsLabelSearch() : openMrsLabelSearch()"
                  >
                    <Search aria-hidden="true" />
                  </button>
                </h3>
                <div v-if="mrsLabelSearchOpen" class="fcp-label-search">
                  <input
                    ref="mrsLabelSearchInput"
                    v-model="mrsLabelQuery"
                    type="text"
                    class="fcp-label-search-input"
                    :placeholder="t('forge.controlsLabelSearchPlaceholder')"
                    :aria-label="t('forge.controlsLabelSearchPlaceholder')"
                  />
                  <button
                    type="button"
                    class="fcp-label-search-close"
                    :aria-label="t('forge.controlsLabelSearchClose')"
                    @click="closeMrsLabelSearch"
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
                <LabelChips
                  :counts="mrsLabelCountsFiltered"
                  :selected="mrsLabels"
                  @toggle="(label) => emit('toggle-mr-label', label)"
                />
              </div>
            </template>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.fcp-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 0 0;
}

.fcp-root--collapsed {
  padding: 0;
}

.fcp-collapse {
  align-self: flex-end;
  flex: none;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: inherit;
  border: 1px solid var(--cs-line-2);
  border-radius: 7px;
  background: var(--cs-surface);
  color: var(--cs-muted);
  cursor: pointer;
  margin: 0 8px 8px 0;
}

.fcp-collapse svg {
  width: 12px;
  height: 12px;
}

.fcp-collapse:hover {
  border-color: var(--cs-line-3);
  color: var(--cs-text-2);
}

/* Collapsed band: the whole 48px-wide strip is the reopen control, no
   separate small button. Text runs vertically, top-to-bottom, truncated to
   whatever height the band actually gets. */
.fcp-band {
  flex: 1;
  width: 100%;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px 0;
  border: none;
  background: transparent;
  color: var(--cs-muted);
  cursor: pointer;
}

.fcp-band:hover {
  background: var(--cs-hover);
  color: var(--cs-text-2);
}

.fcp-band-name {
  writing-mode: vertical-rl;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-height: 100%;
  font-size: 12.5px;
  font-weight: 600;
}

/* Below the shell's own 640px (the panels' own stacking breakpoint, see
   ForgeBoard.vue): the band becomes a short horizontal bar at the top,
   the name no longer rotated. */
@container fb-shell (max-width: 640px) {
  .fcp-band {
    width: 100%;
    height: 48px;
    padding: 0 14px;
    justify-content: flex-start;
  }

  .fcp-band-name {
    writing-mode: horizontal-tb;
    max-height: none;
    max-width: 100%;
  }
}

/* The rail's head. `flex: none` and an empty box when the slot is unused:
   an unfilled head must cost zero height, not an empty gap above the
   sections. */
.fcp-top {
  flex: none;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* Adapts the project menu to living INSIDE the rail rather than being its
   own column. Three overrides, all of them undoing "I am a standalone
   column" so it becomes "I am a block in a column that scrolls":
   the fixed 236px track gives way to the rail's own width, and neither the
   track nor its card scrolls or stretches on its own, since `.fcp-root` is
   the one scrolling. Scoped here rather than changed in ProjectsNav.vue,
   which still IS a standalone column everywhere the board is not shown. */
.fcp-top :deep(.pn-root) {
  width: 100%;
  flex: none;
  overflow-y: visible;
}

.fcp-top :deep(.pn-card) {
  flex: none;
  overflow-y: visible;
}

.fcp-sections {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* Section container: 8px external margin, 16px radius, 1px neutral border,
   elevated surface, discrete shadow. */
.fcp-section {
  margin: 8px;
  border: 1px solid var(--cs-line-2);
  border-radius: 16px;
  background: var(--cs-surface-2);
  box-shadow: var(--cs-shadow-card);
  overflow: hidden;
}

.fcp-acc-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  text-align: left;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 10px 12px;
  border: none;
  background: transparent;
  color: var(--cs-muted);
  cursor: pointer;
}

.fcp-acc-head:hover {
  color: var(--cs-text);
}

.fcp-acc-icon {
  flex: none;
  width: 13px;
  height: 13px;
}

.fcp-acc-chevron {
  flex: none;
  width: 14px;
  height: 14px;
  margin-left: auto;
  transition: transform 150ms ease;
}

.fcp-acc-chevron--closed {
  transform: rotate(-90deg);
}

.fcp-acc-body {
  padding-bottom: 12px;
}

.fcp-block {
  padding: 0 12px;
}

.fcp-block-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin: 20px 0 6px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--cs-ghost);
}

.fcp-block-title-text {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.fcp-block-icon {
  flex: none;
  width: 12px;
  height: 12px;
}

.fcp-row-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.fcp-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  text-align: left;
  font-family: inherit;
  font-size: 13px;
  color: var(--cs-muted);
  padding: 6px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}

.fcp-row:hover {
  background: var(--cs-hover);
}

/* Selected: an accent-weak fill and a heavier weight, per the doctrine.
   Never a border -- a row's identity comes from its content and fill. */
.fcp-row--on {
  background: var(--cs-green-soft);
  color: var(--cs-text);
  font-weight: 500;
}

.fcp-row-icon {
  flex: none;
  width: 14px;
  height: 14px;
}

/* Between the mutually exclusive states and the cumulable toggles. */
.fcp-filter-sep {
  height: 1px;
  margin: 4px 0;
  background: var(--cs-line-2);
}

.fcp-reset {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  text-transform: none;
  letter-spacing: normal;
  color: var(--cs-ghost);
  background: transparent;
  border: none;
  cursor: pointer;
}

.fcp-reset:hover {
  color: var(--cs-text-2);
}

.fcp-reset svg {
  width: 11px;
  height: 11px;
}

.fcp-search-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--cs-ghost);
  cursor: pointer;
}

.fcp-search-toggle svg {
  width: 13px;
  height: 13px;
}

.fcp-search-toggle:hover {
  color: var(--cs-text-2);
}

.fcp-search-toggle--on {
  color: var(--cs-green-text);
}

.fcp-label-search {
  position: relative;
  margin: 0 0 8px;
}

.fcp-label-search-input {
  width: 100%;
  font-family: inherit;
  font-size: 13px;
  padding: 6px 28px 6px 12px;
  border: 1px solid var(--cs-line-2);
  border-radius: 8px;
  background: var(--cs-inset);
  color: var(--cs-text);
}

.fcp-label-search-close {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--cs-ghost);
  cursor: pointer;
}

.fcp-label-search-close svg {
  width: 11px;
  height: 11px;
}

.fcp-label-search-close:hover {
  color: var(--cs-text-2);
}
</style>
