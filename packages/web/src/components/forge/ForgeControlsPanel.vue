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
import { G } from '../../glyphs'
import { t } from '../../i18n'
import type { ForgeMr, ForgeMrStateFilter } from '../../types'
import {
  filterLabelCounts,
  forgeFilterMrsByDraft,
  forgeLabelCounts,
  type ForgeSortKey,
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
  /** The exclusive, server-side state. Not to be confused with `mrsState`
   * just above, which is the LOAD state of the list. */
  mrsStateFilter: ForgeMrStateFilter
  mrsDraftOnly: boolean
  mrsLabels: string[]
}>()

const emit = defineEmits<{
  'update:activeSection': [section: ForgeSection]
  'update:collapsed': [collapsed: boolean]
  'update:issuesSort': [sort: ForgeSortKey]
  'update:mrsSort': [sort: ForgeSortKey]
  'update:mrsStateFilter': [state: ForgeMrStateFilter]
  'update:mrsDraftOnly': [draftOnly: boolean]
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
const mrsStateFiltered = computed(() => forgeFilterMrsByDraft(props.mrs, props.mrsDraftOnly))
const mrsLabelCounts = computed(() => forgeLabelCounts(mrsStateFiltered.value))

// ── Sort rows: same two criteria on both sections (see ForgeLogic.ts's own doc) ──
type SortOption = { value: ForgeSortKey; labelKey: string }
const SORT_OPTIONS: readonly SortOption[] = [
  { value: 'updated', labelKey: 'forge.sortUpdated' },
  { value: 'title', labelKey: 'forge.sortTitle' },
]

// ── Filter rows (MRs only). Two groups, separated by a hairline, and the
// separator is the whole point: above it the STATE, exclusive and fetched
// from the forge; below it the DRAFT toggle, cumulative and applied to the
// list already fetched. They used to be one exclusive group, which offered
// `draft`/`ready` as if they were states and left the real state filter
// unreachable even though the route, the cache and the loader all support it.
type MrStateEntry = { value: ForgeMrStateFilter; labelKey: string }
const MR_STATES: readonly MrStateEntry[] = [
  { value: 'open', labelKey: 'forge.stateOpen' },
  { value: 'merged', labelKey: 'forge.stateMerged' },
  { value: 'closed', labelKey: 'forge.stateClosed' },
  { value: 'all', labelKey: 'forge.stateAll' },
]

function selectMrState(value: ForgeMrStateFilter): void {
  emit('update:mrsStateFilter', value)
}
function toggleMrDraftOnly(): void {
  emit('update:mrsDraftOnly', !props.mrsDraftOnly)
}
/** Anything other than the widest state, or an active toggle, counts as
 * filtered: the reset link has to offer to release both. */
const mrFiltersActive = computed(() => props.mrsStateFilter !== 'all' || props.mrsDraftOnly)
function resetMrFilter(): void {
  emit('update:mrsStateFilter', 'all')
  emit('update:mrsDraftOnly', false)
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
            <span
              class="fcp-acc-chevron"
              :class="{ 'fcp-acc-chevron--closed': activeSection !== 'issues' }"
              aria-hidden="true"
              >{{ activeSection === 'issues' ? G.expand : G.collapse }}</span
            >
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
                <div class="fcp-row-list seg" role="radiogroup" :aria-label="t('forge.sortLabel')">
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
            <span
              class="fcp-acc-chevron"
              :class="{ 'fcp-acc-chevron--closed': activeSection !== 'mrs' }"
              aria-hidden="true"
              >{{ activeSection === 'mrs' ? G.expand : G.collapse }}</span
            >
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
                <div class="fcp-row-list seg" role="radiogroup" :aria-label="t('forge.sortLabel')">
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
                    v-if="mrFiltersActive"
                    type="button"
                    class="fcp-reset"
                    @click="resetMrFilter"
                  >
                    <X aria-hidden="true" />
                    {{ t('forge.controlsFiltersReset') }}
                  </button>
                </h3>
                <div class="fcp-row-list">
                  <div
                    role="radiogroup"
                    :aria-label="t('forge.stateAria')"
                    class="fcp-row-group seg"
                  >
                    <button
                      v-for="s in MR_STATES"
                      :key="s.value"
                      type="button"
                      class="fcp-row"
                      :class="{ 'fcp-row--on': mrsStateFilter === s.value }"
                      role="radio"
                      :aria-checked="mrsStateFilter === s.value"
                      @click="selectMrState(s.value)"
                    >
                      {{ t(s.labelKey) }}
                    </button>
                  </div>
                  <div class="fcp-filter-sep" role="none" />
                  <!-- Cumulative: a checkbox, never a radio, because it
                       combines with whichever state is selected above. -->
                  <div class="fcp-row-group seg">
                    <button
                      type="button"
                      class="fcp-row"
                      :class="{ 'fcp-row--on': mrsDraftOnly }"
                      role="checkbox"
                      :aria-checked="mrsDraftOnly"
                      @click="toggleMrDraftOnly"
                    >
                      {{ t('forge.filterDraftOnly') }}
                    </button>
                  </div>
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
  padding: calc(var(--row) / 2) 0 0;
}

.fcp-root--collapsed {
  padding: 0;
}

.fcp-collapse {
  align-self: flex-end;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: inherit;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--fg-dim);
  cursor: pointer;
  padding: 2px 1ch;
  margin: 0 1ch calc(var(--row) / 2) 0;
}

.fcp-collapse svg {
  width: 14px;
  height: 14px;
}

.fcp-collapse:hover {
  border-color: var(--accent);
  color: var(--fg);
}

/* Collapsed band: the whole strip is the reopen control, no separate small
   button. Text runs vertically, top-to-bottom, truncated to whatever height
   the band actually gets. */
.fcp-band {
  flex: 1;
  width: 100%;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--row) 0;
  border: none;
  background: transparent;
  font: inherit;
  color: var(--fg-dim);
  cursor: pointer;
}

.fcp-band:hover {
  background: var(--bg-hover);
  color: var(--fg);
}

.fcp-band-name {
  writing-mode: vertical-rl;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-height: 100%;
  font-weight: 700;
}

/* Below the shell's own 640px (the panels' own stacking breakpoint, see
   ForgeBoard.vue): the band becomes a short horizontal bar at the top,
   the name no longer rotated. */
@container fb-shell (max-width: 640px) {
  .fcp-band {
    width: 100%;
    height: 48px;
    padding: 0 2ch;
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
   the fixed track gives way to the rail's own width, and neither the
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

.fcp-section {
  margin: 0;
  border-top: 1px solid var(--line);
}

.fcp-section:first-child {
  border-top: none;
}

.fcp-acc-head {
  display: flex;
  align-items: center;
  gap: 1ch;
  width: 100%;
  text-align: left;
  font: inherit;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  padding: calc(var(--row) / 2) 1ch 2px;
  border: none;
  background: transparent;
  color: var(--fg-dim);
  cursor: pointer;
}

.fcp-acc-head:hover {
  color: var(--fg);
}

.fcp-acc-icon {
  flex: none;
  width: 14px;
  height: 14px;
}

.fcp-acc-chevron {
  flex: none;
  margin-left: auto;
  color: var(--fg-muted);
}

.fcp-acc-body {
  padding-bottom: calc(var(--row) / 2);
}

.fcp-block {
  padding: 0 1ch;
}

.fcp-block + .fcp-block {
  border-top: 1px solid var(--line);
}

.fcp-block-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1ch;
  margin: var(--row) 0 calc(var(--row) / 2);
  font-size: 12px;
}

.fcp-block-title-text {
  display: inline-flex;
  align-items: center;
  gap: 1ch;
}

.fcp-block-icon {
  flex: none;
  width: 14px;
  height: 14px;
}

.fcp-row-list {
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
}

/* One hairline grid, the kit's segmented control, stacked instead of inline:
   the rail is a column, the options are full width. */
.fcp-row-list.seg,
.fcp-row-group.seg {
  display: grid;
  grid-auto-flow: row;
  gap: 1px;
}

.fcp-row {
  display: flex;
  align-items: center;
  gap: 1ch;
  width: 100%;
  text-align: left;
  font: inherit;
  color: var(--fg-dim);
  padding: 2px 1ch;
  border: none;
  background: var(--bg);
  cursor: pointer;
}

.fcp-row:hover {
  background: var(--bg-hover);
}

/* Selected reads like every other kit segment: inverted, never a border of
   its own -- the segmented control already draws the hairlines. */
.fcp-row--on {
  background: var(--fg);
  color: var(--bg);
  font-weight: 700;
}

.fcp-row-icon {
  flex: none;
  width: 14px;
  height: 14px;
}

/* Between the mutually exclusive states and the cumulable toggles. */
.fcp-filter-sep {
  height: 1px;
  margin: 0;
  background: var(--line);
}

.fcp-reset {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 1ch;
  font: inherit;
  font-size: 12px;
  text-transform: none;
  letter-spacing: normal;
  color: var(--fg-dim);
  background: transparent;
  border: none;
  cursor: pointer;
}

.fcp-reset:hover {
  color: var(--fg);
}

.fcp-reset svg {
  width: 14px;
  height: 14px;
}

.fcp-search-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  padding: 0 1ch;
}

.fcp-search-toggle svg {
  width: 14px;
  height: 14px;
}

.fcp-search-toggle:hover {
  color: var(--fg);
}

.fcp-search-toggle--on {
  color: var(--ok);
}

.fcp-label-search {
  position: relative;
  margin: 0 0 calc(var(--row) / 2);
}

.fcp-label-search-input {
  width: 100%;
  min-width: 0;
  font: inherit;
  padding: 2px 4ch 2px 1ch;
  border: 1px solid var(--line);
  background: var(--bg-raised);
  color: var(--fg);
}

.fcp-label-search-close {
  position: absolute;
  right: 1ch;
  top: 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  padding: 0;
}

.fcp-label-search-close svg {
  width: 14px;
  height: 14px;
}

.fcp-label-search-close:hover {
  color: var(--fg);
}
</style>
