<script setup lang="ts">
// Zone 2a of the 3-zone workspace layout: an adaptation of
// ConversationsColumn.vue for a rail slot the parent sizes (no own width,
// no splitter — see the root style below), with a total counter added next
// to the title and a primary create action instead of a discreet link.
// Search, grouping, and row rendering are otherwise unchanged: still
// groupConversationsByProject/searchRightPadding (ConversationsLogic.ts)
// and ConversationRow.vue, imported one directory over rather than
// reimplemented.
import { ChevronDown, Plus, Search, X } from '@lucide/vue'
import { computed, ref } from 'vue'
import { matchesQuery } from '../../composables/useTaskBoard'
import { taskKey, type TaskState } from '../../composables/useTasks'
import { t } from '../../i18n'
import ConversationRow from '../conversations/ConversationRow.vue'
import {
  groupConversationsByProject,
  searchRightPadding,
} from '../conversations/ConversationsLogic'

const props = defineProps<{
  states: TaskState[]
  projectNames: ReadonlyMap<string, string>
  /** taskKeys of every conversation currently open in the focus deck. Ours is
   *  a DECK, not a single selection: several conversations can be pinned side
   *  by side, so a row is highlighted when its key is in this list. */
  focusedKeys: readonly string[]
}>()

const emit = defineEmits<{
  select: [state: TaskState]
  create: []
}>()

const query = ref('')
const searchInput = ref<HTMLInputElement | null>(null)

/** Exposed for the shell's ⌘K, which focuses whichever list is up
 * rather than a search box of its own. */
defineExpose({ focusSearch: () => searchInput.value?.focus() })

const filteredStates = computed(() =>
  query.value.trim() === ''
    ? props.states
    : props.states.filter((s) => matchesQuery(s.record, query.value)),
)
const groups = computed(() => groupConversationsByProject(filteredStates.value, props.projectNames))

const isEmpty = computed(() => props.states.length === 0)
const isSearchEmpty = computed(() => props.states.length > 0 && filteredStates.value.length === 0)

// One trailing icon at most today (the clear button, only once a query is
// typed): the padding is still COMPUTED, never a fixed number.
const searchPaddingRight = computed(() => searchRightPadding(query.value !== '' ? 1 : 0))

// Collapsed project ids; absence = open (every group starts expanded).
const collapsedProjects = ref<ReadonlySet<string>>(new Set())
function isOpen(projectId: string): boolean {
  return !collapsedProjects.value.has(projectId)
}
function toggleGroup(projectId: string): void {
  const next = new Set(collapsedProjects.value)
  if (next.has(projectId)) {
    next.delete(projectId)
  } else {
    next.add(projectId)
  }
  collapsedProjects.value = next
}

function isSelected(state: TaskState): boolean {
  return props.focusedKeys.includes(taskKey(state.projectId, state.record.id))
}
</script>

<template>
  <section class="cvl-root" :aria-label="t('conversations.title')">
    <header class="cvl-header">
      <div class="cvl-heading">
        <h2 class="cvl-title">{{ t('conversations.title') }}</h2>
        <span class="cvl-count">{{ states.length }}</span>
      </div>
      <button type="button" class="cvl-action" @click="emit('create')">
        <Plus class="cvl-action-icon" aria-hidden="true" />
        <span class="cvl-action-label">{{ t('conversations.newAction') }}</span>
      </button>
    </header>

    <div class="cvl-search">
      <Search class="cvl-search-icon" aria-hidden="true" />
      <input
        ref="searchInput"
        v-model="query"
        type="text"
        class="cvl-search-input"
        :style="{ paddingRight: `${searchPaddingRight}px` }"
        :placeholder="t('conversations.searchPlaceholder')"
        :aria-label="t('conversations.searchPlaceholder')"
      />
      <button
        v-if="query !== ''"
        type="button"
        class="cvl-search-clear"
        :aria-label="t('conversations.searchClear')"
        @click="query = ''"
      >
        <X aria-hidden="true" />
      </button>
    </div>

    <div class="cvl-scroll">
      <p v-if="isEmpty" class="cvl-empty">{{ t('conversations.empty') }}</p>
      <p v-else-if="isSearchEmpty" class="cvl-empty">{{ t('conversations.searchEmpty') }}</p>

      <div v-for="group in groups" :key="group.projectId" class="cvl-group">
        <button
          type="button"
          class="cvl-group-head"
          :aria-expanded="isOpen(group.projectId)"
          :aria-controls="`cvl-body-${group.projectId}`"
          :aria-label="t('conversations.groupToggleAria', { project: group.projectName })"
          @click="toggleGroup(group.projectId)"
        >
          <ChevronDown
            class="cvl-group-chevron"
            :class="{ 'cvl-group-chevron--closed': !isOpen(group.projectId) }"
            aria-hidden="true"
          />
          <span class="cvl-group-name">{{ group.projectName }}</span>
          <span class="cvl-group-count">{{ group.states.length }}</span>
        </button>
        <div
          :id="`cvl-body-${group.projectId}`"
          class="cvl-group-body"
          :class="{ 'cvl-group-body--closed': !isOpen(group.projectId) }"
          :inert="!isOpen(group.projectId)"
        >
          <div class="cvl-group-body-inner">
            <button
              v-for="state in group.states"
              :key="taskKey(state.projectId, state.record.id)"
              type="button"
              class="cvl-row-btn"
              :class="{ 'cvl-row-btn--selected': isSelected(state) }"
              :aria-current="isSelected(state) ? 'true' : undefined"
              @click="emit('select', state)"
            >
              <ConversationRow
                :state="state"
                :project-name="group.projectName"
                :selected="isSelected(state)"
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* No own width/min-width/max-width any more: the parent slot (the rail's
   zone 2) gives this its size, exactly like it gives RepositoriesList.vue's
   root the same 100%, the two being swappable content for the same slot. */
.cvl-root {
  container-type: inline-size;
  container-name: cvl-shell;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 0;
  border-radius: 16px;
  border: 1px solid var(--cs-line-2);
  background: var(--cs-panel);
  box-shadow: var(--cs-shadow-panel);
  overflow: hidden;
}

.cvl-header {
  flex: none;
  height: 40px;
  padding: 0 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--cs-line);
}

.cvl-heading {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
}

.cvl-title {
  min-width: 0;
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--cs-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cvl-count {
  flex: none;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--cs-ghost);
}

/* Threshold 2: under 200px the heading (title + counter) goes, so the
   header never collides with the action button. Same threshold as the
   sheet ConversationsColumn.vue was built from, just scoped to cover the
   counter added alongside the title. */
@container cvl-shell (max-width: 200px) {
  .cvl-heading {
    display: none;
  }
}

.cvl-action {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  padding: 5px 10px;
  border: 1px solid var(--cs-green-ring);
  border-radius: 7px;
  background: var(--cs-green-soft);
  color: var(--cs-green-text);
  cursor: pointer;
}

.cvl-action:hover {
  background: var(--cs-green);
  color: var(--cs-on-green);
}

.cvl-action-icon {
  flex: none;
  width: 14px;
  height: 14px;
}

/* Threshold 1: under 256px the action keeps only its icon. */
@container cvl-shell (max-width: 256px) {
  .cvl-action-label {
    display: none;
  }
}

.cvl-search {
  flex: none;
  position: relative;
  padding: 8px 12px;
}

.cvl-search-icon {
  position: absolute;
  left: 19px;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
  color: var(--cs-ghost);
  pointer-events: none;
}

.cvl-search-input {
  width: 100%;
  font-family: inherit;
  font-size: 13px;
  padding: 7px 0 7px 28px;
  border: 1px solid var(--cs-line-2);
  border-radius: 8px;
  background: var(--cs-inset);
  color: var(--cs-text);
}

.cvl-search-input:focus-visible {
  outline: none;
  border-color: var(--cs-green-ring);
}

.cvl-search-clear {
  position: absolute;
  right: 20px;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--cs-ghost);
  cursor: pointer;
  padding: 0;
}

.cvl-search-clear svg {
  width: 100%;
  height: 100%;
}

.cvl-search-clear:hover {
  color: var(--cs-text-2);
}

.cvl-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 8px;
}

.cvl-empty {
  margin: 0;
  padding: 10px 6px;
  font-size: 12px;
  color: var(--cs-ghost);
}

.cvl-group {
  margin-top: 4px;
}

.cvl-group-head {
  display: flex;
  align-items: center;
  gap: 5px;
  width: 100%;
  text-align: left;
  font-family: inherit;
  padding: 6px 14px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--cs-text-2);
  cursor: pointer;
}

.cvl-group-head:hover {
  background: var(--cs-hover);
}

.cvl-group-chevron {
  flex: none;
  width: 14px;
  height: 14px;
  transition: transform 150ms ease;
}

.cvl-group-chevron--closed {
  transform: rotate(-90deg);
}

.cvl-group-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cvl-group-count {
  flex: none;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--cs-ghost);
}

/* The 1fr/0fr grid track: animates toward an unmeasured height, never a
   guessed pixel value. `inert` (bound in the template) drops the closed
   body from keyboard navigation for real. NEVER animation-fill-mode here
   (package-wide guard, style.test.ts). */
.cvl-group-body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 150ms ease;
}

.cvl-group-body--closed {
  grid-template-rows: 0fr;
  visibility: hidden;
}

.cvl-group-body-inner {
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* No gap between rows: each row's own padding carries the spacing. */
.cvl-row-btn {
  display: block;
  width: 100%;
  text-align: left;
  font-family: inherit;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}

.cvl-row-btn:hover:not(.cvl-row-btn--selected) {
  background: var(--cs-hover);
}

.cvl-row-btn:hover :deep(.cvr-title) {
  color: var(--cs-text);
}

.cvl-row-btn--selected {
  background: var(--cs-green-soft);
}

.cvl-row-btn--selected :deep(.cvr-title) {
  color: var(--cs-text);
  font-weight: 700;
}
</style>
