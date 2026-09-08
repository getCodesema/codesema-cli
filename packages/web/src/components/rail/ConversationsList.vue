<script setup lang="ts">
// Zone 2a of the 3-zone workspace layout: the kit's project rail
// (`.rail/.rail-h/.proj/.sub`) fed by our conversations. A header line, one
// `.proj` row per project, and under it one plain tree line per
// conversation. The parent slot sizes it (no own width, no splitter).
// Search, grouping and row rendering stay on
// groupConversationsByProject/searchRightPadding (ConversationsLogic.ts) and
// ConversationRow.vue, imported one directory over rather than
// reimplemented.
import { computed, ref } from 'vue'
import { matchesQuery } from '../../composables/useTaskBoard'
import { taskKey, type TaskState } from '../../composables/useTasks'
import { EXECUTION_STATUS } from '../../execution-status'
import { G } from '../../glyphs'
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

/** Exposed for the shell's Cmd/Ctrl+K, which focuses whichever list is up
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

function waitingCount(states: readonly TaskState[]): number {
  return states.filter((s) => EXECUTION_STATUS[s.record.status].attention).length
}

function runningCount(states: readonly TaskState[]): number {
  return states.filter((s) => EXECUTION_STATUS[s.record.status].pulse).length
}

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
  <section class="cvl-root rail" :aria-label="t('conversations.title')">
    <header class="cvl-header rail-h">
      <span class="cvl-title">{{ t('conversations.title') }}</span>
      <button
        type="button"
        class="cvl-action"
        :aria-label="t('conversations.newAction')"
        :title="t('conversations.newAction')"
        @click="emit('create')"
      >
        +
      </button>
    </header>

    <label class="cvl-search">
      <span class="cvl-search-glyph" aria-hidden="true">{{ G.search }}</span>
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
        {{ G.ko }}
      </button>
    </label>

    <div class="cvl-scroll">
      <p v-if="isEmpty" class="cvl-empty empty">{{ t('conversations.empty') }}</p>
      <p v-else-if="isSearchEmpty" class="cvl-empty empty">
        {{ t('conversations.searchEmpty') }}
      </p>

      <div v-for="group in groups" :key="group.projectId" class="cvl-group">
        <button
          type="button"
          class="cvl-group-head proj"
          :aria-expanded="isOpen(group.projectId)"
          :aria-controls="`cvl-body-${group.projectId}`"
          :aria-label="t('conversations.groupToggleAria', { project: group.projectName })"
          @click="toggleGroup(group.projectId)"
        >
          <span
            class="cvl-group-dot dot"
            :class="{ on: runningCount(group.states) > 0 }"
            aria-hidden="true"
            >{{ runningCount(group.states) > 0 ? G.dot : G.pending }}</span
          >
          <span class="cvl-group-name name">{{ group.projectName }}</span>
          <span class="cvl-group-count cnt">
            <b v-if="waitingCount(group.states) > 0">{{ waitingCount(group.states) }}</b>
            <template v-if="waitingCount(group.states) > 0 && runningCount(group.states) > 0">
              {{ G.sep }}
            </template>
            <template v-if="runningCount(group.states) > 0">{{
              runningCount(group.states)
            }}</template>
            <template v-if="waitingCount(group.states) === 0 && runningCount(group.states) === 0">{{
              G.minus
            }}</template>
          </span>
        </button>
        <div
          :id="`cvl-body-${group.projectId}`"
          class="cvl-group-body"
          :class="{ 'cvl-group-body--closed': !isOpen(group.projectId) }"
          :inert="!isOpen(group.projectId)"
        >
          <div class="cvl-group-body-inner sub">
            <button
              v-for="state in group.states"
              :key="taskKey(state.projectId, state.record.id)"
              type="button"
              class="cvl-row-btn"
              :class="{ 'cvl-row-btn--selected': isSelected(state) }"
              :aria-current="isSelected(state) ? 'true' : undefined"
              @click="emit('select', state)"
            >
              <ConversationRow :state="state" />
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
  width: 100%;
  min-height: 0;
  overflow: hidden;
}

.cvl-header {
  flex: none;
  gap: 1ch;
}

.cvl-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cvl-action {
  flex: none;
  font: inherit;
  background: none;
  border: 0;
  padding: 0 1ch;
  color: var(--accent);
  cursor: pointer;
}

.cvl-action:hover {
  color: var(--fg);
}

/* The kit's borderless appbar search, on its own line under the header. */
.cvl-search {
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 1ch;
  padding: 2px 1ch 2px 2ch;
  border-bottom: 1px solid var(--line);
  color: var(--fg-dim);
}

.cvl-search-glyph {
  flex: none;
  color: var(--fg-muted);
}

.cvl-search-input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  padding: 0;
  color: var(--fg);
}

.cvl-search-input:focus {
  outline: none;
}

.cvl-search-clear {
  flex: none;
  font: inherit;
  border: none;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  padding: 0;
}

.cvl-search-clear:hover {
  color: var(--fg);
}

.cvl-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.cvl-empty {
  margin: calc(var(--row) / 2) 2ch;
}

.cvl-group {
  margin-top: var(--row);
}

.cvl-group-head {
  width: 100%;
  text-align: left;
  font: inherit;
  border: 0;
  background: transparent;
  color: var(--fg-dim);
}

.cvl-group-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Threshold 1: under 256px each line drops its age column. */
@container cvl-shell (max-width: 256px) {
  .cvl-row-btn :deep(.cvr-age) {
    display: none;
  }
}

/* Threshold 2: under 200px the project counters go too, so the project name
   never collides with them. */
@container cvl-shell (max-width: 200px) {
  .cvl-group-count {
    display: none;
  }
}

/* The 1fr/0fr grid track: animates toward an unmeasured height, never a
   guessed pixel value. `inert` (bound in the template) drops the closed
   body from keyboard navigation for real. NEVER animation-fill-mode here
   (package-wide guard, styles.test.ts). */
.cvl-group-body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 150ms ease;
}

.cvl-group-body--closed {
  grid-template-rows: 0fr;
  visibility: hidden;
}

/* The kit's `.sub` indent is redrawn per line instead of on the block, so a
   hovered or selected line fills the rail edge to edge. */
.cvl-group-body-inner {
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 0;
}

.cvl-row-btn {
  display: flex;
  align-items: baseline;
  width: calc(100% - 2ch);
  margin: 0 1ch;
  text-align: left;
  font: inherit;
  padding: calc(var(--row) / 2) 1ch;
  border: none;
  border-top: 1px solid var(--line);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.cvl-row-btn:last-child {
  border-bottom: 1px solid var(--line);
}

.cvl-row-btn:hover {
  background: var(--bg-hover);
}

.cvl-row-btn--selected {
  background: var(--bg-hover);
}
</style>
