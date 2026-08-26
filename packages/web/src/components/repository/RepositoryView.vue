<script setup lang="ts">
// The repository focus view: a tab bar (Branches / Issues / Merge requests)
// over the content of whichever is active. Branches is a pure shell around
// its caller's content — the table lives elsewhere and arrives through the
// #branches slot — because that tab has nothing to filter (the table carries
// its own toolbar), unlike Issues/Merge requests, which mount the forge
// controls rail alongside the board exactly as WorkspaceView used to wire
// them in its own permanent rail.
import { computed } from 'vue'
import type { ProjectIssuesState } from '../../composables/useIssues'
import type { MrsLoadState } from '../../composables/useTasks'
import type { RepoTab } from '../../composables/useWorkspaceNav'
import { t } from '../../i18n'
import type { ForgeMr, ForgeMrStateFilter } from '../../types'
import ForgeBoard from '../forge/ForgeBoard.vue'
import ForgeControlsPanel from '../forge/ForgeControlsPanel.vue'
import type { ForgeSortKey } from '../forge/ForgeLogic'
import {
  FORGE_CONTROLS_COLLAPSED_WIDTH,
  FORGE_CONTROLS_WIDTH_DEFAULT,
  FORGE_CONTROLS_WIDTH_MAX,
  FORGE_CONTROLS_WIDTH_MIN,
  type ForgeSection,
} from '../forge/ForgePrefs'
import ForgeSplitter from '../forge/ForgeSplitter.vue'

const props = defineProps<{
  projectName: string
  tab: RepoTab
  /** Collapse state of the inner forge controls rail. */
  controlsCollapsed: boolean
  /** Open width of that rail, restored when it expands. */
  controlsWidth: number
  issuesState: ProjectIssuesState
  issuesSort: ForgeSortKey
  issuesLabels: string[]
  mrs: ForgeMr[]
  mrsState: MrsLoadState | null
  mrsSort: ForgeSortKey
  mrsStateFilter: ForgeMrStateFilter
  mrsDraftOnly: boolean
  mrsLabels: string[]
  listWidth: number
}>()

const emit = defineEmits<{
  'update:tab': [tab: RepoTab]
  'update:controlsCollapsed': [collapsed: boolean]
  'update:controlsWidth': [width: number]
  'update:issuesSort': [sort: ForgeSortKey]
  'update:mrsSort': [sort: ForgeSortKey]
  'update:mrsStateFilter': [state: ForgeMrStateFilter]
  'update:mrsDraftOnly': [draftOnly: boolean]
  'update:listWidth': [width: number]
  'toggle-issue-label': [label: string]
  'toggle-mr-label': [label: string]
  'retry-issues': []
  'clear-issue-filters': []
  'clear-mr-filters': []
}>()

const TABS: readonly { value: RepoTab; labelKey: string }[] = [
  { value: 'branches', labelKey: 'repository.tabBranches' },
  { value: 'issues', labelKey: 'repository.tabIssues' },
  { value: 'mrs', labelKey: 'repository.tabMrs' },
]

function tabId(tab: RepoTab): string {
  return `rv-tab-${tab}`
}

function panelId(tab: RepoTab): string {
  return `rv-panel-${tab}`
}

/** 'branches' has no ForgeSection counterpart (the rail is never mounted
 * under that tab), so this direction alone needs a real fallback; the
 * reverse (ForgeControlsPanel's @update:active-section) assigns straight
 * into update:tab, since every ForgeSection value already spells a valid
 * RepoTab. */
const activeSection = computed<ForgeSection>(() => (props.tab === 'mrs' ? 'mrs' : 'issues'))

const railWidth = computed(() =>
  props.controlsCollapsed ? FORGE_CONTROLS_COLLAPSED_WIDTH : props.controlsWidth,
)
</script>

<template>
  <div class="rv-root">
    <header class="rv-header">
      <h1 class="rv-title">{{ projectName }}</h1>
      <div class="rv-tabs" role="tablist">
        <button
          v-for="entry in TABS"
          :key="entry.value"
          :id="tabId(entry.value)"
          type="button"
          role="tab"
          class="rv-tab"
          :class="{ 'rv-tab--active': tab === entry.value }"
          :aria-selected="tab === entry.value"
          :aria-controls="panelId(entry.value)"
          @click="emit('update:tab', entry.value)"
        >
          {{ t(entry.labelKey) }}
        </button>
      </div>
    </header>

    <div class="rv-body">
      <div
        v-if="tab === 'branches'"
        :id="panelId('branches')"
        role="tabpanel"
        :aria-labelledby="tabId('branches')"
        class="rv-panel rv-panel--branches"
      >
        <slot name="branches" />
      </div>
      <div
        v-else
        :id="panelId(tab)"
        role="tabpanel"
        :aria-labelledby="tabId(tab)"
        class="rv-panel rv-panel--forge"
      >
        <aside class="rv-forge-rail" :style="{ '--rv-rail-w': `${railWidth}px` }">
          <ForgeControlsPanel
            :has-board="true"
            :active-section="activeSection"
            :collapsed="controlsCollapsed"
            :project-name="projectName"
            :issues-state="issuesState"
            :issues-sort="issuesSort"
            :issues-labels="issuesLabels"
            :mrs="mrs"
            :mrs-state="mrsState"
            :mrs-sort="mrsSort"
            :mrs-state-filter="mrsStateFilter"
            :mrs-draft-only="mrsDraftOnly"
            :mrs-labels="mrsLabels"
            @update:active-section="(section) => emit('update:tab', section)"
            @update:collapsed="(v) => emit('update:controlsCollapsed', v)"
            @update:issues-sort="(v) => emit('update:issuesSort', v)"
            @update:mrs-sort="(v) => emit('update:mrsSort', v)"
            @update:mrs-state-filter="(v) => emit('update:mrsStateFilter', v)"
            @update:mrs-draft-only="(v) => emit('update:mrsDraftOnly', v)"
            @toggle-issue-label="(label) => emit('toggle-issue-label', label)"
            @toggle-mr-label="(label) => emit('toggle-mr-label', label)"
          />
        </aside>
        <ForgeSplitter
          v-if="!controlsCollapsed"
          :model-value="controlsWidth"
          :min="FORGE_CONTROLS_WIDTH_MIN"
          :max="FORGE_CONTROLS_WIDTH_MAX"
          :default-width="FORGE_CONTROLS_WIDTH_DEFAULT"
          :ariaLabel="t('forge.resizeControlsAria')"
          @update:model-value="(v: number) => emit('update:controlsWidth', v)"
        />
        <div class="rv-forge-board">
          <ForgeBoard
            :section="activeSection"
            :issues-state="issuesState"
            :issues-sort="issuesSort"
            :issues-labels="issuesLabels"
            :mrs="mrs"
            :mrs-state="mrsState"
            :mrs-sort="mrsSort"
            :mrs-draft-only="mrsDraftOnly"
            :mrs-labels="mrsLabels"
            :list-width="listWidth"
            @retry-issues="emit('retry-issues')"
            @clear-issue-filters="emit('clear-issue-filters')"
            @clear-mr-filters="emit('clear-mr-filters')"
            @update:list-width="(v) => emit('update:listWidth', v)"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rv-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.rv-header {
  flex: none;
  padding: 18px 20px 0;
  border-bottom: 1px solid var(--cs-line-2);
}

.rv-title {
  margin: 0 0 14px;
  font-size: 16px;
  font-weight: 600;
  color: var(--cs-text);
}

.rv-tabs {
  display: flex;
  gap: 4px;
}

.rv-tab {
  display: inline-flex;
  align-items: center;
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  color: var(--cs-muted);
  padding: 8px 14px;
  border: none;
  border-radius: 8px 8px 0 0;
  background: transparent;
  cursor: pointer;
}

.rv-tab:hover {
  color: var(--cs-text-2);
}

/* Selected: an accent-weak fill and a heavier weight, per the doctrine.
   Never a border -- a tab's identity comes from its content and fill. */
.rv-tab--active {
  background: var(--cs-green-soft);
  color: var(--cs-text);
  font-weight: 600;
}

.rv-tab:focus-visible {
  outline: 2px solid var(--cs-focus-ring);
  outline-offset: -2px;
}

.rv-body {
  flex: 1;
  min-height: 0;
}

.rv-panel {
  height: 100%;
  min-height: 0;
}

.rv-panel--forge {
  display: flex;
  flex-direction: row;
  align-items: stretch;
}

.rv-forge-rail {
  flex: 0 0 var(--rv-rail-w);
  width: var(--rv-rail-w);
  min-height: 0;
  border-right: 1px solid var(--cs-line-2);
  transition:
    flex-basis var(--cs-duration-base) var(--cs-ease-in),
    width var(--cs-duration-base) var(--cs-ease-in);
}

.rv-forge-board {
  flex: 1;
  min-width: 0;
  min-height: 0;
}
</style>
