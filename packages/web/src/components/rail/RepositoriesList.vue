<script setup lang="ts">
// Zone 2b of the 3-zone workspace layout: the repository registry lifted out
// of ProjectsNav.vue (its rows, its add-project form, its two-step removal),
// without the "All projects" entry and without the selected project's
// MR/branch tree — both belong elsewhere now. A local name search is added
// on top, visually identical to ConversationsList.vue's own search field.
import { Plus } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import type { ProjectActivity } from '../../composables/useProjects'
import { G } from '../../glyphs'
import { t } from '../../i18n'
import type { Project, ProjectCandidate } from '../../types'
import { searchRightPadding } from '../conversations/ConversationsLogic'

const props = defineProps<{
  projects: Project[]
  /** The selected project id, or null when none is. No "All projects" row
   * exists here to ever select null itself — see `select` below. */
  selected: string | null
  /** Per-project live counters (waiting on the human / agents at work). */
  activity: ReadonlyMap<string, ProjectActivity>
  addBusy: boolean
  addError: string | null
  removeError: string | null
  /** Git repos detected around the launch directory (discover event). */
  candidates: ProjectCandidate[]
}>()

const emit = defineEmits<{
  select: [id: string]
  add: [path: string]
  remove: [id: string]
  /** Asks the parent to (re)fetch detection; fired when the add form opens. */
  discover: []
}>()

const countsOf = (id: string): ProjectActivity =>
  props.activity.get(id) ?? { waiting: 0, active: 0 }

/** A project is "live" when at least one agent works on it or waits for the
 * human: the dot is that binary fact, never a decorative identity hue. */
const isLive = (id: string): boolean => {
  const counts = countsOf(id)
  return counts.waiting > 0 || counts.active > 0
}

// ── Search: local name filter over the registered list only (never the
// detected candidates, which live behind the add form) ────────────────────
const query = ref('')
const searchInput = ref<HTMLInputElement | null>(null)

/** Exposed for the shell's Cmd/Ctrl+K, which focuses whichever list is up
 * rather than a search box of its own. */
defineExpose({ focusSearch: () => searchInput.value?.focus() })

const filteredProjects = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return needle === ''
    ? props.projects
    : props.projects.filter((project) => project.name.toLowerCase().includes(needle))
})

const isEmpty = computed(() => props.projects.length === 0)
const isSearchEmpty = computed(
  () => props.projects.length > 0 && filteredProjects.value.length === 0,
)

const searchPaddingRight = computed(() => searchRightPadding(query.value !== '' ? 1 : 0))

// ── Registry disclosure ───────────────────────────────────────────────────
const formOpen = ref(false)
const pathDraft = ref('')
// Two-step removal: the first click arms the confirmation, the second fires.
const confirmRemoveId = ref<string | null>(null)

function openForm(): void {
  formOpen.value = true
  confirmRemoveId.value = null
  // Refresh detection on every open: repos appear/disappear between visits.
  emit('discover')
}

/** Detected repos still offerable: not yet in the registry. */
const offerable = computed(() => props.candidates.filter((candidate) => !candidate.registered))

function addCandidate(candidate: ProjectCandidate): void {
  if (!props.addBusy) {
    emit('add', candidate.path)
  }
}

function cancelForm(): void {
  formOpen.value = false
  pathDraft.value = ''
}

function submitAdd(): void {
  const path = pathDraft.value.trim()
  if (path && !props.addBusy) {
    emit('add', path)
  }
}

// The parent owns the POST: when it settles without error, the form closes.
watch(
  () => props.addBusy,
  (busy, wasBusy) => {
    if (wasBusy && !busy && props.addError === null) {
      cancelForm()
    }
  },
)

function requestRemove(id: string): void {
  if (confirmRemoveId.value === id) {
    confirmRemoveId.value = null
    emit('remove', id)
  } else {
    confirmRemoveId.value = id
  }
}
</script>

<template>
  <nav class="rpl-root rail" :aria-label="t('rail.repositoriesTitle')">
    <header class="rpl-header rail-h">
      <h2 class="rpl-title">{{ t('rail.repositoriesTitle') }}</h2>
      <span class="rpl-count">{{ projects.length }}</span>
    </header>

    <label class="rpl-search">
      <span class="rpl-search-glyph" aria-hidden="true">{{ G.search }}</span>
      <input
        ref="searchInput"
        v-model="query"
        type="text"
        class="rpl-search-input"
        :style="{ paddingRight: `${searchPaddingRight}px` }"
        :placeholder="t('rail.repositoriesSearchPlaceholder')"
        :aria-label="t('rail.repositoriesSearchPlaceholder')"
      />
      <button
        v-if="query !== ''"
        type="button"
        class="rpl-search-clear"
        :aria-label="t('conversations.searchClear')"
        @click="query = ''"
      >
        {{ G.ko }}
      </button>
    </label>

    <div class="rpl-scroll">
      <p v-if="isEmpty" class="rpl-empty empty">{{ t('rail.repositoriesEmpty') }}</p>
      <p v-else-if="isSearchEmpty" class="rpl-empty empty">
        {{ t('rail.repositoriesSearchEmpty') }}
      </p>

      <div class="rpl-list">
        <div v-for="project in filteredProjects" :key="project.id" class="rpl-row">
          <button
            type="button"
            class="rpl-project proj"
            :class="{ 'rpl-project--active': project.id === selected }"
            :title="project.path"
            :aria-current="project.id === selected"
            :aria-pressed="project.id === selected"
            @click="emit('select', project.id)"
          >
            <span class="rpl-icon-slot">
              <span class="rpl-dot dot" :class="{ on: isLive(project.id) }" aria-hidden="true">{{
                isLive(project.id) ? G.dot : G.pending
              }}</span>
            </span>
            <span class="rpl-name name">{{ project.name }}</span>
            <span class="rpl-badges cnt">
              <!-- Strong amber: conversations blocked on the human. -->
              <span
                v-if="countsOf(project.id).waiting > 0"
                class="rpl-badge rpl-badge--waiting"
                :title="t('workspace.cardWaiting', { n: countsOf(project.id).waiting })"
              >
                <span aria-hidden="true">{{ G.attention }}</span>
                <b>{{ countsOf(project.id).waiting }}</b>
              </span>
              <!-- Plain amber count: agents at work, nothing asked of the human. -->
              <span
                v-if="countsOf(project.id).active > 0"
                class="rpl-badge rpl-badge--running"
                :title="t('workspace.cardActive', { n: countsOf(project.id).active })"
              >
                {{ countsOf(project.id).active }}
              </span>
            </span>
          </button>
          <button
            type="button"
            class="rpl-remove"
            :class="{ 'rpl-remove--armed': confirmRemoveId === project.id }"
            :title="
              confirmRemoveId === project.id
                ? t('workspace.removeProjectConfirm')
                : t('workspace.removeProjectHint')
            "
            :aria-label="
              confirmRemoveId === project.id
                ? t('workspace.removeProjectConfirm')
                : t('workspace.removeProject')
            "
            @click="requestRemove(project.id)"
          >
            {{ G.ko }}
          </button>
        </div>
      </div>
    </div>

    <!-- Menu footer: the add-project control, set off by a hairline above. -->
    <div class="rpl-footer">
      <button v-if="!formOpen" type="button" class="rpl-add proj" @click="openForm">
        <span class="rpl-icon-slot">
          <Plus class="rpl-row-icon" aria-hidden="true" />
        </span>
        <span>{{ t('workspace.addProject') }}</span>
      </button>

      <!-- Add form: detected repos first (one click), manual path as fallback. -->
      <form v-if="formOpen" class="rpl-add-form" @submit.prevent="submitAdd">
        <div v-if="offerable.length > 0" class="rpl-detected">
          <span class="rpl-detected-label">{{ t('workspace.detectedProjects') }}</span>
          <button
            v-for="candidate in offerable"
            :key="candidate.path"
            class="rpl-detected-item"
            type="button"
            :title="candidate.path"
            :disabled="addBusy"
            @click="addCandidate(candidate)"
          >
            <span class="rpl-detected-plus" aria-hidden="true">+</span>
            <span class="rpl-detected-name">{{ candidate.name }}</span>
          </button>
        </div>
        <input
          v-model="pathDraft"
          class="rpl-add-input"
          type="text"
          :placeholder="t('workspace.addProjectPath')"
          spellcheck="false"
        />
        <div class="rpl-add-actions">
          <button
            class="rpl-add-submit btn primary"
            type="submit"
            :disabled="addBusy || !pathDraft.trim()"
          >
            {{ addBusy ? t('workspace.addProjectBusy') : t('workspace.addProjectSubmit') }}
          </button>
          <button class="rpl-add-cancel btn ghost" type="button" @click="cancelForm">
            {{ t('workspace.addProjectCancel') }}
          </button>
        </div>
        <p v-if="addError" class="rpl-error">
          {{ t('workspace.addProjectError') }} ({{ addError }})
        </p>
      </form>
    </div>

    <p v-if="removeError" class="rpl-error">
      {{ t('workspace.removeProjectError') }} ({{ removeError }})
    </p>
  </nav>
</template>

<style scoped>
/* Same swappable-slot doctrine as ConversationsList.vue's own root: no fixed
   width, the parent's zone gives it 100%. */
.rpl-root {
  width: 100%;
  min-height: 0;
  overflow: hidden;
}

.rpl-header {
  flex: none;
  align-items: baseline;
  gap: 1ch;
}

.rpl-title {
  flex: 1;
  min-width: 0;
  font-size: var(--fs);
  font-weight: 400;
  color: inherit;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rpl-count {
  flex: none;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--fg-muted);
}

/* The kit's borderless appbar search, on its own line under the header and
   on the same band height, exactly as ConversationsList.vue draws it. */
.rpl-search {
  flex: none;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  height: calc(var(--row) + 4px);
  gap: 1ch;
  padding: 2px 1ch 2px 2ch;
  border-bottom: 1px solid var(--line);
  color: var(--fg-dim);
}

.rpl-search-glyph {
  flex: none;
  color: var(--fg-muted);
}

.rpl-search-input {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  padding: 0;
  color: var(--fg);
}

.rpl-search-input:focus {
  outline: none;
}

.rpl-search-clear {
  flex: none;
  font: inherit;
  border: none;
  background: transparent;
  color: var(--fg-muted);
  cursor: pointer;
  padding: 0;
}

.rpl-search-clear:hover {
  color: var(--fg);
}

.rpl-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.rpl-empty {
  margin: 1ch;
}

.rpl-list {
  display: flex;
  flex-direction: column;
}

.rpl-row {
  display: flex;
  align-items: stretch;
}

.rpl-row:hover {
  background: var(--bg-hover);
}

.rpl-project {
  flex: 1;
  min-width: 0;
  text-align: left;
  font: inherit;
  color: var(--fg-dim);
  border: none;
  background: transparent;
}

.rpl-icon-slot {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.rpl-row-icon {
  flex: none;
  width: 14px;
  height: 14px;
}

.rpl-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rpl-badges {
  margin-left: auto;
  flex: none;
  display: flex;
  align-items: baseline;
  gap: 1ch;
}

/* Amber: the human blocks these conversations (colour is a state). */
.rpl-badge--waiting {
  color: var(--warn);
}

/* The machine works, nothing is asked of the human. */
.rpl-badge--running {
  color: var(--fg-dim);
  font-variant-numeric: tabular-nums;
}

/* Removal stays hidden until hover/focus; red only when armed. */
.rpl-remove {
  flex: none;
  align-self: center;
  padding: 0 1ch;
  font: inherit;
  color: var(--fg-muted);
  border: none;
  background: transparent;
  cursor: pointer;
  visibility: hidden;
}

.rpl-row:hover .rpl-remove,
.rpl-remove:focus-visible,
.rpl-remove--armed {
  visibility: visible;
}

.rpl-remove:hover {
  color: var(--err);
}

/* Armed confirmation carries a state: red is doctrine here, not decoration. */
.rpl-remove--armed {
  color: var(--err);
  border: 1px solid var(--err);
}

.rpl-footer {
  flex: none;
  border-top: 1px solid var(--line);
}

.rpl-add {
  grid-template-columns: 2ch 1fr;
  align-items: center;
  width: 100%;
  text-align: left;
  font: inherit;
  color: var(--fg-dim);
  border: none;
  background: transparent;
}

.rpl-add-form {
  display: flex;
  flex-direction: column;
  gap: calc(var(--row) / 2);
  padding: calc(var(--row) / 2) 1ch;
}

.rpl-detected {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.rpl-detected-label {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--fg-dim);
}

.rpl-detected-item {
  display: flex;
  align-items: baseline;
  gap: 1ch;
  font: inherit;
  text-align: left;
  padding: 2px 1ch;
  border: none;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
}

.rpl-detected-item:hover:not(:disabled) {
  background: var(--bg-hover);
}

.rpl-detected-item:disabled {
  color: var(--fg-muted);
  cursor: default;
}

.rpl-detected-plus {
  color: var(--fg-muted);
}

.rpl-detected-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rpl-add-input {
  width: 100%;
  min-width: 0;
}

.rpl-add-actions {
  display: flex;
  gap: 1ch;
}

.rpl-error {
  margin: 2px 0 0;
  padding: 0 1ch;
  color: var(--err);
  overflow-wrap: anywhere;
}
</style>
