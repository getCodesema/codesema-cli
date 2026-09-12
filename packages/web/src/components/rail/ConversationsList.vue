<script setup lang="ts">
// Left column of the 2-zone workspace: agent sessions (search, flat list,
// + new). Theme picker and settings live in the footer so the old category
// rail is not required. One existing task/VM session = one agent row.
// Ordering and row rendering stay on orderConversations/searchRightPadding
// and ConversationRow.vue.
import { computed, ref } from 'vue'
import { matchesQuery, queueSectionOf } from '../../composables/useTaskBoard'
import { taskKey, type TaskState } from '../../composables/useTasks'
import { G } from '../../glyphs'
import { t } from '../../i18n'
import ConversationRow from '../conversations/ConversationRow.vue'
import { orderConversations, searchRightPadding } from '../conversations/ConversationsLogic'
import ThemePicker from '../ThemePicker.vue'

const props = defineProps<{
  states: TaskState[]
  /** taskKeys of every conversation currently open in the focus deck. Ours is
   *  a DECK, not a single selection: several conversations can be pinned side
   *  by side, so a row is highlighted when its key is in this list. */
  focusedKeys: readonly string[]
  /** Display names by project id — role identity for each agent row. */
  projectNames: ReadonlyMap<string, string>
}>()

const emit = defineEmits<{
  select: [state: TaskState]
  create: []
  settings: []
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
const orderedStates = computed(() => orderConversations(filteredStates.value))

const isEmpty = computed(() => props.states.length === 0)
const isSearchEmpty = computed(() => props.states.length > 0 && filteredStates.value.length === 0)

// One trailing icon at most today (the clear button, only once a query is
// typed): the padding is still COMPUTED, never a fixed number. The + action
// sits in the same pill, so count it as a trailing slot when the clear is out.
const searchPaddingRight = computed(() => searchRightPadding((query.value !== '' ? 1 : 0) + 1))

const firstFinishedKey = computed(() => {
  const first = orderedStates.value.find((s) => queueSectionOf(s.record.status) === 'done')
  return first ? taskKey(first.projectId, first.record.id) : null
})

function isSelected(state: TaskState): boolean {
  return props.focusedKeys.includes(taskKey(state.projectId, state.record.id))
}

function projectNameOf(state: TaskState): string {
  return props.projectNames.get(state.projectId) ?? state.projectId
}
</script>

<template>
  <section class="cvl-root rail" :aria-label="t('conversations.title')">
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
      <button
        type="button"
        class="cvl-action"
        :aria-label="t('conversations.newAction')"
        :title="t('conversations.newAction')"
        @click="emit('create')"
      >
        +
      </button>
    </label>

    <div class="cvl-scroll">
      <p v-if="isEmpty" class="cvl-empty empty">{{ t('conversations.empty') }}</p>
      <p v-else-if="isSearchEmpty" class="cvl-empty empty">
        {{ t('conversations.searchEmpty') }}
      </p>

      <div v-else class="cvl-list">
        <button
          v-for="state in orderedStates"
          :key="taskKey(state.projectId, state.record.id)"
          type="button"
          class="cvl-row-btn"
          :class="{
            'cvl-row-btn--selected': isSelected(state),
            'cvl-row-btn--finished-start':
              taskKey(state.projectId, state.record.id) === firstFinishedKey,
          }"
          :aria-current="isSelected(state) ? 'true' : undefined"
          @click="emit('select', state)"
        >
          <ConversationRow :state="state" :project-name="projectNameOf(state)" />
        </button>
      </div>
    </div>

    <div class="cvl-footer">
      <div class="cvl-theme">
        <ThemePicker compact />
      </div>
      <button
        type="button"
        class="cvl-settings"
        :title="t('nav.settings')"
        :aria-label="t('nav.settings')"
        @click="emit('settings')"
      >
        <span class="cvl-settings-glyph" aria-hidden="true">{{ G.gear }}</span>
      </button>
    </div>
  </section>
</template>

<style scoped>
/* Fills the left column the desk gives it; no fixed width of its own. */
.cvl-root {
  container-type: inline-size;
  container-name: cvl-shell;
  width: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--bg);
  border: 0;
}

/* Capsule search: gray pill, + quiet on the right — no shouting title. */
.cvl-search {
  flex: none;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  gap: 0.75rem;
  margin: 0.75rem 0.85rem 0.5rem;
  padding: 0.55rem 0.75rem;
  border: 0;
  border-radius: var(--radius-pill);
  background: var(--bg-search);
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

.cvl-action {
  flex: none;
  font: inherit;
  background: none;
  border: 0;
  padding: 0 0.25rem;
  color: var(--fg-dim);
  cursor: pointer;
  line-height: 1;
}

.cvl-action:hover {
  color: var(--fg);
}

.cvl-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.cvl-empty {
  margin: calc(var(--row) / 2) 1rem;
}

.cvl-list {
  display: flex;
  flex-direction: column;
  padding: 0.35rem 0.5rem;
  gap: 0.15rem;
}

/* Threshold 1: under 256px each line drops its age column. */
@container cvl-shell (max-width: 256px) {
  .cvl-row-btn :deep(.cvr-age) {
    display: none;
  }
}

.cvl-row-btn {
  display: flex;
  align-items: flex-start;
  width: 100%;
  margin: 0;
  text-align: left;
  font: inherit;
  padding: 0.65rem 0.75rem;
  border: none;
  border-radius: var(--radius-bubble);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.cvl-row-btn--finished-start {
  margin-top: 0.5rem;
}

.cvl-row-btn:hover {
  background: var(--bg-hover);
}

.cvl-row-btn--selected {
  background: var(--bg-raised);
}

.cvl-footer {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem 0.75rem;
  border-top: 0;
}

.cvl-theme {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  opacity: 0.7;
}

.cvl-theme :deep(.tp-select),
.cvl-theme :deep(.tp-contrast button) {
  font-size: 12px;
  padding: 0 0.4rem;
  min-width: 0;
}

.cvl-settings {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font: inherit;
  color: var(--fg-dim);
  border: none;
  background: transparent;
  padding: 0.35rem 0.5rem;
  cursor: pointer;
  border-radius: var(--radius-pill);
}

.cvl-settings:hover {
  color: var(--fg);
  background: var(--bg-hover);
}

.cvl-settings-glyph {
  color: var(--fg-muted);
}
</style>
