<script setup lang="ts">
// Forge board shell: three panels shown in the focus zone in place of the
// sober empty-state once a project is selected. Controls (section nav,
// collapsible), list (the active section's real issue/MR list), detail (the
// item picked in the list, always present with its own clean empty state
// while nothing is selected). This component owns the layout, the
// resize/collapse/persist behavior and the selection; the panels' own
// detailed content is either carried over as-is (the list, previously the
// accordion bodies) or a deliberately minimal stub for a later lot to fill
// in (controls nav aside, detail).
//
// Below 640px of ITS OWN width (a container query, not the viewport, since
// this shell sits behind two other columns, so the viewport can stay wide
// while this box is narrow) the three panels stack vertically and the whole
// shell scrolls as one block instead of each panel scrolling on its own.
import { computed, ref, watch } from 'vue'
import type { ProjectIssuesState } from '../../composables/useIssues'
import type { MrsLoadState } from '../../composables/useTasks'
import { t } from '../../i18n'
import type { ForgeMr } from '../../types'
import ForgeControlsPanel from './ForgeControlsPanel.vue'
import ForgeDetailPanel from './ForgeDetailPanel.vue'
import ForgeListPanel from './ForgeListPanel.vue'
import {
  resolveForgeSelection,
  type ForgeSelection,
  type ForgeSortKey,
  type MrStateFilter,
} from './ForgeLogic'
import {
  FORGE_CONTROLS_COLLAPSED_WIDTH,
  FORGE_CONTROLS_WIDTH_DEFAULT,
  FORGE_CONTROLS_WIDTH_MAX,
  FORGE_CONTROLS_WIDTH_MIN,
  FORGE_LIST_WIDTH_DEFAULT,
  FORGE_LIST_WIDTH_MAX,
  FORGE_LIST_WIDTH_MIN,
  readForgePrefs,
  writeForgePrefs,
} from './ForgePrefs'
import ForgeSplitter from './ForgeSplitter.vue'

const props = defineProps<{
  /** The selected project's display name: the only thing the collapsed
   * controls panel shows (see ForgeControlsPanel.vue's vertical band). */
  projectName: string
  issuesState: ProjectIssuesState
  mrs: ForgeMr[]
  mrsState: MrsLoadState | null
  /** Seeds the initial selection (which item the detail panel opens on).
   * Uncontrolled after mount, like a form field's `defaultValue`:
   * WorkspaceView never sets it today (a fresh board opens with nothing
   * selected, see the `:key` on the caller, which remounts this board on
   * project switch); it exists for a future deep link and for tests that
   * need a seeded selection without simulating a click. */
  initialSelection?: ForgeSelection | null
}>()

const emit = defineEmits<{ 'retry-issues': [] }>()

// ── Preferences: one JSON blob, loaded once, persisted on every change ────
const prefs = ref(readForgePrefs())

watch(prefs, (next) => writeForgePrefs(next), { deep: true })

const activeSection = computed({
  get: () => prefs.value.activeSection,
  set: (v: 'issues' | 'mrs') => (prefs.value = { ...prefs.value, activeSection: v }),
})
const controlsWidth = computed({
  get: () => prefs.value.controlsWidth,
  set: (v: number) => (prefs.value = { ...prefs.value, controlsWidth: v }),
})
const controlsCollapsed = computed({
  get: () => prefs.value.controlsCollapsed,
  set: (v: boolean) => (prefs.value = { ...prefs.value, controlsCollapsed: v }),
})
const listWidth = computed({
  get: () => prefs.value.listWidth,
  set: (v: number) => (prefs.value = { ...prefs.value, listWidth: v }),
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
 * on the "your filter matches nothing" state. */
function clearIssueFilters(): void {
  prefs.value = { ...prefs.value, issuesLabels: [] }
}

/** Releases both MR filter dimensions at once (status filter and labels):
 * the fix offered on the "your filter matches nothing" state. */
function clearMrFilters(): void {
  prefs.value = { ...prefs.value, mrsFilter: 'all', mrsLabels: [] }
}

// ── Selection: which item (if any) the detail panel shows ─────────────────
const selection = ref<ForgeSelection | null>(props.initialSelection ?? null)

function closeDetail(): void {
  selection.value = null
}

const issuesLoaded = computed(() => {
  const result = props.issuesState.result
  return result !== null && result.available ? result.issues : null
})

const detailItem = computed(() =>
  resolveForgeSelection(selection.value, issuesLoaded.value, props.mrs),
)

// The controls panel's effective width: fixed to the collapsed rail width
// while collapsed (never the persisted `controlsWidth`, which is the width
// to RESTORE on expand), the persisted width otherwise.
const controlsPanelWidth = computed(() =>
  controlsCollapsed.value ? FORGE_CONTROLS_COLLAPSED_WIDTH : controlsWidth.value,
)
</script>

<template>
  <div class="fb-shell">
    <div
      class="fb-panel fb-panel--controls"
      :style="{ '--fb-controls-w': `${controlsPanelWidth}px` }"
    >
      <ForgeControlsPanel
        :active-section="activeSection"
        :collapsed="controlsCollapsed"
        :project-name="projectName"
        @update:active-section="(v) => (activeSection = v)"
        @update:collapsed="(v) => (controlsCollapsed = v)"
      />
    </div>

    <ForgeSplitter
      v-if="!controlsCollapsed"
      :model-value="controlsWidth"
      :min="FORGE_CONTROLS_WIDTH_MIN"
      :max="FORGE_CONTROLS_WIDTH_MAX"
      :default-width="FORGE_CONTROLS_WIDTH_DEFAULT"
      :ariaLabel="t('forge.resizeControlsAria')"
      @update:model-value="(v) => (controlsWidth = v)"
    />

    <div class="fb-panel fb-panel--list" :style="{ '--fb-list-w': `${listWidth}px` }">
      <ForgeListPanel
        :section="activeSection"
        :issues-state="issuesState"
        :issues-sort="issuesSort"
        :issues-labels="prefs.issuesLabels"
        :mrs="mrs"
        :mrs-state="mrsState"
        :mrs-sort="mrsSort"
        :mrs-filter="mrsFilter"
        :mrs-labels="prefs.mrsLabels"
        :selection="selection"
        @update:issues-sort="(v) => (issuesSort = v)"
        @update:mrs-sort="(v) => (mrsSort = v)"
        @update:mrs-filter="(v) => (mrsFilter = v)"
        @toggle-issue-label="toggleIssueLabel"
        @toggle-mr-label="toggleMrLabel"
        @clear-issue-filters="clearIssueFilters"
        @clear-mr-filters="clearMrFilters"
        @retry-issues="emit('retry-issues')"
        @select="(sel) => (selection = sel)"
      />
    </div>

    <ForgeSplitter
      :model-value="listWidth"
      :min="FORGE_LIST_WIDTH_MIN"
      :max="FORGE_LIST_WIDTH_MAX"
      :default-width="FORGE_LIST_WIDTH_DEFAULT"
      :ariaLabel="t('forge.resizeListAria')"
      @update:model-value="(v) => (listWidth = v)"
    />
    <div class="fb-panel fb-panel--detail">
      <ForgeDetailPanel :item="detailItem" @close="closeDetail" />
    </div>
  </div>
</template>

<style scoped>
.fb-shell {
  container-type: inline-size;
  container-name: fb-shell;
  display: flex;
  flex-direction: row;
  align-items: stretch;
  height: 100%;
  min-height: 0;
  width: 100%;
}

.fb-panel {
  min-height: 0;
}

.fb-panel--controls {
  flex: 0 0 var(--fb-controls-w);
  width: var(--fb-controls-w);
  border-right: 1px solid var(--cs-line-2);
}

.fb-panel--list {
  flex: 0 0 var(--fb-list-w);
  width: var(--fb-list-w);
}

.fb-panel--detail {
  flex: 1 1 auto;
  min-width: 0;
  border-left: 1px solid var(--cs-line-2);
}

/* Below 640px of the shell's OWN width: stack the panels and let the whole
   shell scroll as one block instead of each panel scrolling on its own. */
@container fb-shell (max-width: 640px) {
  .fb-shell {
    flex-direction: column;
    height: auto;
    min-height: 100%;
  }

  .fb-panel--controls,
  .fb-panel--list {
    flex: none;
    width: 100%;
    border-right: none;
  }

  .fb-panel--detail {
    border-left: none;
    border-top: 1px solid var(--cs-line-2);
  }

  /* Dragging a divider between stacked, full-width panels makes no sense:
     hide it (still in the DOM, just out of the tab order via display:none). */
  :deep(.fs-handle) {
    display: none;
  }
}
</style>
