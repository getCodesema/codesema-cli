<script setup lang="ts">
// Forge board: the two panels shown in the focus zone once a project is
// selected. List (the active section's real issue/MR list) and detail (the
// item picked in the list, always present with its own clean empty state
// while nothing is selected).
//
// The CONTROLS are not here. They live in the desk's permanent left rail,
// under the project menu (see WorkspaceView.vue). That rail exists whether
// or not a board is up, which is the whole point: a menu that moved or
// resized the moment a project was picked made the screen jump under the
// pointer. So this component owns the list/detail split and the selection,
// and reads the shared preferences its caller hands it.
//
// Below 640px of ITS OWN width (a container query, not the viewport, since
// this shell sits behind the rail, so the viewport can stay wide while this
// box is narrow) the two panels stack vertically and the whole shell scrolls
// as one block instead of each panel scrolling on its own.
import { computed, ref } from 'vue'
import type { ProjectIssuesState } from '../../composables/useIssues'
import type { MrsLoadState } from '../../composables/useTasks'
import { t } from '../../i18n'
import type { ForgeMr } from '../../types'
import ForgeDetailPanel from './ForgeDetailPanel.vue'
import ForgeListPanel from './ForgeListPanel.vue'
import { resolveForgeSelection, type ForgeSelection, type ForgeSortKey } from './ForgeLogic'
import {
  FORGE_LIST_WIDTH_DEFAULT,
  FORGE_LIST_WIDTH_MAX,
  FORGE_LIST_WIDTH_MIN,
  type ForgeSection,
} from './ForgePrefs'
import ForgeSplitter from './ForgeSplitter.vue'

const props = defineProps<{
  section: ForgeSection
  issuesState: ProjectIssuesState
  issuesSort: ForgeSortKey
  issuesLabels: string[]
  mrs: ForgeMr[]
  mrsState: MrsLoadState | null
  mrsSort: ForgeSortKey
  mrsDraftOnly: boolean
  mrsLabels: string[]
  listWidth: number
  /** Seeds the initial selection (which item the detail panel opens on).
   * Uncontrolled after mount, like a form field's `defaultValue`:
   * WorkspaceView never sets it today (a fresh board opens with nothing
   * selected, see the `:key` on the caller, which remounts this board on
   * project switch); it exists for a future deep link and for tests that
   * need a seeded selection without simulating a click. */
  initialSelection?: ForgeSelection | null
}>()

const emit = defineEmits<{
  'retry-issues': []
  'clear-issue-filters': []
  'clear-mr-filters': []
  'update:listWidth': [width: number]
}>()

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
</script>

<template>
  <div class="fb-shell">
    <div class="fb-panel fb-panel--list" :style="{ '--fb-list-w': `${listWidth}px` }">
      <ForgeListPanel
        :section="section"
        :issues-state="issuesState"
        :issues-sort="issuesSort"
        :issues-labels="issuesLabels"
        :mrs="mrs"
        :mrs-state="mrsState"
        :mrs-sort="mrsSort"
        :mrs-draft-only="mrsDraftOnly"
        :mrs-labels="mrsLabels"
        :selection="selection"
        @clear-issue-filters="emit('clear-issue-filters')"
        @clear-mr-filters="emit('clear-mr-filters')"
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
      @update:model-value="(v) => emit('update:listWidth', v)"
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

  .fb-panel--list {
    flex: none;
    width: 100%;
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
