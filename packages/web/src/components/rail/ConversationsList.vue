<script setup lang="ts">
// Zone 2a of the 3-zone workspace layout: the kit's rail (`.rail/.rail-h`)
// fed by our conversations. A conversation is NOT a child of a project: this
// is one flat list of lines, and a conversation with no project is listed
// like any other. The project of the open conversation is shown by its
// thread header, never here. Ordering and row rendering stay on
// orderConversations/searchRightPadding (ConversationsLogic.ts) and
// ConversationRow.vue, imported one directory over rather than
// reimplemented.
import { computed, ref } from 'vue'
import { matchesQuery, queueSectionOf } from '../../composables/useTaskBoard'
import { taskKey, type TaskState } from '../../composables/useTasks'
import { G } from '../../glyphs'
import { t } from '../../i18n'
import ConversationRow from '../conversations/ConversationRow.vue'
import { orderConversations, searchRightPadding } from '../conversations/ConversationsLogic'

const props = defineProps<{
  states: TaskState[]
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
const orderedStates = computed(() => orderConversations(filteredStates.value))

const isEmpty = computed(() => props.states.length === 0)
const isSearchEmpty = computed(() => props.states.length > 0 && filteredStates.value.length === 0)

// One trailing icon at most today (the clear button, only once a query is
// typed): the padding is still COMPUTED, never a fixed number.
const searchPaddingRight = computed(() => searchRightPadding(query.value !== '' ? 1 : 0))

const firstFinishedKey = computed(() => {
  const first = orderedStates.value.find((s) => queueSectionOf(s.record.status) === 'done')
  return first ? taskKey(first.projectId, first.record.id) : null
})

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
          <ConversationRow :state="state" />
        </button>
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

.cvl-list {
  display: flex;
  flex-direction: column;
  padding: calc(var(--row) / 2) 0;
}

/* Threshold 1: under 256px each line drops its age column. */
@container cvl-shell (max-width: 256px) {
  .cvl-row-btn :deep(.cvr-age) {
    display: none;
  }
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

/* The only break in the flat list: one blank half-line before the finished
   pile, the hairline already on the row doing the separating. */
.cvl-row-btn--finished-start {
  margin-top: calc(var(--row) / 2);
}

.cvl-row-btn:hover {
  background: var(--bg-hover);
}

.cvl-row-btn--selected {
  background: var(--bg-hover);
}
</style>
