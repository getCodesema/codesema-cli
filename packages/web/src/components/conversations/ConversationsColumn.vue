<script setup lang="ts">
// The conversations column: header (title + a single "new conversation"
// action, both degrading as the panel narrows), a search field, and
// conversations grouped by project (our "folder", see ConversationsLogic.ts)
// each collapsible via a 1fr/0fr grid track, following sections 1 to 4 and
// 10.2 of the internal measurement notes.
//
// Two things the sheet's own source has that are deliberately NOT here, both
// left for whoever assembles this into the real shell:
// - the resize handle: the panel only declares its own 260/180/1400 width
//   bounds (below); dragging it is a PARENT-level concern, exactly like
//   ForgeBoard.vue already does with ForgeSplitter.vue as a SIBLING rather
//   than something a panel owns itself.
// - the header's three-dot menu and split action button: we have exactly one
//   action (start a conversation), not several to pick between, so this is a
//   single button, not a dropdown. Its label still degrades per the sheet.
import { ChevronDown, Plus, Search, X } from '@lucide/vue'
import { computed, ref } from 'vue'
import { matchesQuery } from '../../composables/useTaskBoard'
import { taskKey, type TaskState } from '../../composables/useTasks'
import { t } from '../../i18n'
import ConversationRow from './ConversationRow.vue'
import { groupConversationsByProject, searchRightPadding } from './ConversationsLogic'

const props = defineProps<{
  states: TaskState[]
  projectNames: ReadonlyMap<string, string>
  /** taskKey of the conversation currently open elsewhere; null = none. */
  selectedKey: string | null
}>()

const emit = defineEmits<{
  select: [state: TaskState]
  create: []
}>()

const query = ref('')

const filteredStates = computed(() =>
  query.value.trim() === ''
    ? props.states
    : props.states.filter((s) => matchesQuery(s.record, query.value)),
)
const groups = computed(() => groupConversationsByProject(filteredStates.value, props.projectNames))

const isEmpty = computed(() => props.states.length === 0)
const isSearchEmpty = computed(() => props.states.length > 0 && filteredStates.value.length === 0)

// One trailing icon at most today (the clear button, only once a query is
// typed): the padding is still COMPUTED, never a fixed number, so a future
// second icon only has to report its own presence here.
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
  return (
    props.selectedKey !== null && props.selectedKey === taskKey(state.projectId, state.record.id)
  )
}
</script>

<template>
  <section class="cvc-root" :aria-label="t('conversations.title')">
    <header class="cvc-header">
      <h2 class="cvc-title">{{ t('conversations.title') }}</h2>
      <button type="button" class="cvc-action" @click="emit('create')">
        <Plus class="cvc-action-icon" aria-hidden="true" />
        <span class="cvc-action-label">{{ t('conversations.newAction') }}</span>
      </button>
    </header>

    <div class="cvc-search">
      <Search class="cvc-search-icon" aria-hidden="true" />
      <input
        v-model="query"
        type="text"
        class="cvc-search-input"
        :style="{ paddingRight: `${searchPaddingRight}px` }"
        :placeholder="t('conversations.searchPlaceholder')"
        :aria-label="t('conversations.searchPlaceholder')"
      />
      <button
        v-if="query !== ''"
        type="button"
        class="cvc-search-clear"
        :aria-label="t('conversations.searchClear')"
        @click="query = ''"
      >
        <X aria-hidden="true" />
      </button>
    </div>

    <div class="cvc-scroll">
      <p v-if="isEmpty" class="cvc-empty">{{ t('conversations.empty') }}</p>
      <p v-else-if="isSearchEmpty" class="cvc-empty">{{ t('conversations.searchEmpty') }}</p>

      <div v-for="group in groups" :key="group.projectId" class="cvc-group">
        <button
          type="button"
          class="cvc-group-head"
          :aria-expanded="isOpen(group.projectId)"
          :aria-controls="`cvc-body-${group.projectId}`"
          :aria-label="t('conversations.groupToggleAria', { project: group.projectName })"
          @click="toggleGroup(group.projectId)"
        >
          <ChevronDown
            class="cvc-group-chevron"
            :class="{ 'cvc-group-chevron--closed': !isOpen(group.projectId) }"
            aria-hidden="true"
          />
          <span class="cvc-group-name">{{ group.projectName }}</span>
          <span class="cvc-group-count">{{ group.states.length }}</span>
        </button>
        <div
          :id="`cvc-body-${group.projectId}`"
          class="cvc-group-body"
          :class="{ 'cvc-group-body--closed': !isOpen(group.projectId) }"
          :inert="!isOpen(group.projectId)"
        >
          <div class="cvc-group-body-inner">
            <button
              v-for="state in group.states"
              :key="taskKey(state.projectId, state.record.id)"
              type="button"
              class="cvc-row-btn"
              :class="{ 'cvc-row-btn--selected': isSelected(state) }"
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
.cvc-root {
  container-type: inline-size;
  container-name: cvc-shell;
  display: flex;
  flex-direction: column;
  width: 260px;
  min-width: 180px;
  max-width: 1400px;
  min-height: 0;
  border-radius: 16px;
  border: 1px solid var(--cs-line-2);
  background: var(--cs-panel);
  box-shadow: var(--cs-shadow-panel);
  overflow: hidden;
}

.cvc-header {
  flex: none;
  height: 40px;
  padding: 0 8px;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid var(--cs-line);
}

.cvc-title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 13px;
  font-weight: 700;
  color: var(--cs-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Threshold 2 (sheet §1): under 200px the title itself goes, so the header
   never collides with the action button. */
@container cvc-shell (max-width: 200px) {
  .cvc-title {
    display: none;
  }
}

.cvc-action {
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
  margin-left: auto;
}

.cvc-action:hover {
  background: var(--cs-green);
  color: var(--cs-on-green);
}

.cvc-action-icon {
  flex: none;
  width: 14px;
  height: 14px;
}

/* Threshold 1 (sheet §1): under 256px the action keeps only its icon. */
@container cvc-shell (max-width: 256px) {
  .cvc-action-label {
    display: none;
  }
}

.cvc-search {
  flex: none;
  position: relative;
  padding: 8px 12px;
}

.cvc-search-icon {
  position: absolute;
  left: 19px;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
  color: var(--cs-ghost);
  pointer-events: none;
}

.cvc-search-input {
  width: 100%;
  font-family: inherit;
  font-size: 13px;
  padding: 7px 0 7px 28px;
  border: 1px solid var(--cs-line-2);
  border-radius: 8px;
  background: var(--cs-inset);
  color: var(--cs-text);
}

.cvc-search-input:focus-visible {
  outline: none;
  border-color: var(--cs-green-ring);
}

.cvc-search-clear {
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

.cvc-search-clear svg {
  width: 100%;
  height: 100%;
}

.cvc-search-clear:hover {
  color: var(--cs-text-2);
}

.cvc-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 8px;
}

.cvc-empty {
  margin: 0;
  padding: 10px 6px;
  font-size: 12px;
  color: var(--cs-ghost);
}

.cvc-group {
  margin-top: 4px;
}

/* Sheet §3's folder head, our "project" (§10.2): 14/6 padding, radius 8,
   14px glyph, 5px gap, 13px semi-bold name, 11px muted tabular count as
   plain text, never a pill. */
.cvc-group-head {
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

.cvc-group-head:hover {
  background: var(--cs-hover);
}

.cvc-group-chevron {
  flex: none;
  width: 14px;
  height: 14px;
  transition: transform 150ms ease;
}

.cvc-group-chevron--closed {
  transform: rotate(-90deg);
}

.cvc-group-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cvc-group-count {
  flex: none;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--cs-ghost);
}

/* The 1fr/0fr grid track (sheet §3): animates toward an unmeasured height,
   never toward a guessed pixel value. `inert` (bound in the template) drops
   the closed body from keyboard navigation for real, which visibility alone
   would not. NEVER animation-fill-mode here (package-wide guard, style.test.ts). */
.cvc-group-body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 150ms ease;
}

.cvc-group-body--closed {
  grid-template-rows: 0fr;
  visibility: hidden;
}

.cvc-group-body-inner {
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* No gap between rows: each row's own padding carries the spacing (sheet §4). */
.cvc-row-btn {
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

/* Sheet §6's row states: transparent/muted at rest, the hover fill brings
   the title to full color, selection is a soft accent fill with reinforced
   text and NEVER a border. */
.cvc-row-btn:hover:not(.cvc-row-btn--selected) {
  background: var(--cs-hover);
}

.cvc-row-btn:hover :deep(.cvr-title) {
  color: var(--cs-text);
}

.cvc-row-btn--selected {
  background: var(--cs-green-soft);
}

.cvc-row-btn--selected :deep(.cvr-title) {
  color: var(--cs-text);
  font-weight: 700;
}
</style>
