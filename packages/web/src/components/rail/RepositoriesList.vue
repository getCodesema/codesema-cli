<script setup lang="ts">
// Zone 2b of the 3-zone workspace layout: the repository registry lifted out
// of ProjectsNav.vue (its rows, its add-project form, its two-step removal),
// without the "All projects" entry and without the selected project's
// MR/branch tree — both belong elsewhere now. A local name search is added
// on top, visually identical to ConversationsList.vue's own search field.
import { Plus, Search, X } from '@lucide/vue'
import { computed, ref, watch } from 'vue'
import { nameColor, type ProjectActivity } from '../../composables/useProjects'
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

const dotStyle = (name: string): Record<string, string> => ({
  background: `hsl(${nameColor(name)} 55% 62%)`,
})

// ── Search: local name filter over the registered list only (never the
// detected candidates, which live behind the add form) ────────────────────
const query = ref('')

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
  <nav class="rpl-root" :aria-label="t('rail.repositoriesTitle')">
    <header class="rpl-header">
      <h2 class="rpl-title">{{ t('rail.repositoriesTitle') }}</h2>
      <span class="rpl-count">{{ projects.length }}</span>
    </header>

    <div class="rpl-search">
      <Search class="rpl-search-icon" aria-hidden="true" />
      <input
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
        <X aria-hidden="true" />
      </button>
    </div>

    <div class="rpl-scroll">
      <p v-if="isEmpty" class="rpl-empty">{{ t('rail.repositoriesEmpty') }}</p>
      <p v-else-if="isSearchEmpty" class="rpl-empty">{{ t('rail.repositoriesSearchEmpty') }}</p>

      <div class="rpl-list">
        <div v-for="project in filteredProjects" :key="project.id" class="rpl-row">
          <button
            type="button"
            class="rpl-project"
            :class="{ 'rpl-project--active': project.id === selected }"
            :title="project.path"
            :aria-pressed="project.id === selected"
            @click="emit('select', project.id)"
          >
            <span class="rpl-icon-slot">
              <span class="rpl-dot" :style="dotStyle(project.name)" aria-hidden="true" />
            </span>
            <span class="rpl-name">{{ project.name }}</span>
            <span class="rpl-badges">
              <!-- Strong amber: conversations blocked on the human. -->
              <span
                v-if="countsOf(project.id).waiting > 0"
                class="rpl-count-pill rpl-badge rpl-badge--waiting"
                :title="t('workspace.cardWaiting', { n: countsOf(project.id).waiting })"
              >
                ⚠ {{ countsOf(project.id).waiting }}
              </span>
              <!-- Plain amber count: agents at work, nothing asked of the human. -->
              <span
                v-if="countsOf(project.id).active > 0"
                class="rpl-count-pill rpl-badge rpl-badge--running"
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
            ✕
          </button>
        </div>
      </div>
    </div>

    <!-- Menu footer: the add-project control, set off by a hairline above. -->
    <div class="rpl-footer">
      <button v-if="!formOpen" type="button" class="rpl-add" @click="openForm">
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
          <button class="rpl-add-submit" type="submit" :disabled="addBusy || !pathDraft.trim()">
            {{ addBusy ? t('workspace.addProjectBusy') : t('workspace.addProjectSubmit') }}
          </button>
          <button class="rpl-add-cancel" type="button" @click="cancelForm">
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
/* Same swappable-slot doctrine as ConversationsList.vue's own root: no
   fixed width, the parent's zone gives it 100%. Same card treatment
   (radius/border/shadow) so the two read as one family when toggled. */
.rpl-root {
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

.rpl-header {
  flex: none;
  height: 40px;
  padding: 0 12px;
  display: flex;
  align-items: baseline;
  gap: 6px;
  border-bottom: 1px solid var(--cs-line);
}

.rpl-title {
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

.rpl-count {
  flex: none;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--cs-ghost);
}

.rpl-search {
  flex: none;
  position: relative;
  padding: 8px 12px;
}

.rpl-search-icon {
  position: absolute;
  left: 19px;
  top: 50%;
  transform: translateY(-50%);
  width: 14px;
  height: 14px;
  color: var(--cs-ghost);
  pointer-events: none;
}

.rpl-search-input {
  width: 100%;
  font-family: inherit;
  font-size: 13px;
  padding: 7px 0 7px 28px;
  border: 1px solid var(--cs-line-2);
  border-radius: 8px;
  background: var(--cs-inset);
  color: var(--cs-text);
}

.rpl-search-input:focus-visible {
  outline: none;
  border-color: var(--cs-green-ring);
}

.rpl-search-clear {
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

.rpl-search-clear svg {
  width: 100%;
  height: 100%;
}

.rpl-search-clear:hover {
  color: var(--cs-text-2);
}

.rpl-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 8px;
}

.rpl-empty {
  margin: 0;
  padding: 10px 6px;
  font-size: 12px;
  color: var(--cs-ghost);
}

.rpl-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
}

.rpl-row {
  display: flex;
  align-items: stretch;
  gap: 2px;
}

/* Exact anatomy of ProjectsNav.vue's own `.pn-project`: 36px, 8px/12px
   padding, 8px radius, 14px/500/20px text, 16px icon with a 10px gap. */
.rpl-project {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  text-align: left;
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  color: var(--cs-text-2);
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}

.rpl-project:hover {
  background: var(--cs-hover);
}

/* Active state: fill + text only, no border or side bar; the identity dot
   keeps its own color, which names the repo and is not a state to accent. */
.rpl-project--active {
  background: var(--cs-green-soft);
  color: var(--cs-text);
  font-weight: 600;
}

.rpl-icon-slot {
  flex: none;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.rpl-row-icon {
  flex: none;
  width: 16px;
  height: 16px;
}

.rpl-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 2px;
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
  align-items: center;
  gap: 6px;
}

.rpl-count-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 16px;
  padding: 0 6px;
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

/* Strong amber: the human blocks these conversations, the one pastille
   that carries a colored fill (color is a state). */
.rpl-badge--waiting {
  background: var(--cs-amber-soft);
  color: var(--cs-amber-text);
}

/* Plain amber count: the machine works, nothing is asked of the human. */
.rpl-badge--running {
  background: var(--cs-inset);
  color: var(--cs-amber);
}

/* Removal stays hidden until hover/focus; red only when armed. */
.rpl-remove {
  flex: none;
  align-self: center;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-family: inherit;
  color: var(--cs-ghost);
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  opacity: 0;
}

.rpl-row:hover .rpl-remove,
.rpl-remove:focus-visible,
.rpl-remove--armed {
  opacity: 1;
}

.rpl-remove:hover {
  color: var(--cs-red-text);
  background: var(--cs-hover);
}

/* Armed confirmation carries a state: red is doctrine here, not decoration. */
.rpl-remove--armed {
  color: var(--cs-red-text);
  background: var(--cs-red-soft);
}

.rpl-footer {
  margin-top: 6px;
  padding: 8px;
  border-top: 1px solid var(--cs-line);
}

.rpl-add {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 36px;
  text-align: left;
  font-family: inherit;
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
  color: var(--cs-ghost);
  padding: 8px 12px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}

.rpl-add:hover {
  background: var(--cs-hover);
  color: var(--cs-text-2);
}

.rpl-add-form {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.rpl-detected {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.rpl-detected-label {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--cs-ghost);
  padding: 2px 1px;
}

.rpl-detected-item {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  font-family: inherit;
  text-align: left;
  padding: 5px 8px;
  border-radius: 7px;
  border: 1px solid var(--cs-line);
  background: var(--cs-surface);
  color: var(--cs-text);
  cursor: pointer;
}

.rpl-detected-item:hover:not(:disabled) {
  border-color: var(--cs-line-3);
}

.rpl-detected-item:disabled {
  opacity: 0.45;
  cursor: default;
}

.rpl-detected-plus {
  color: var(--cs-ghost);
  font-weight: 600;
}

.rpl-detected-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rpl-add-input {
  border: 1px solid var(--cs-line-2);
  border-radius: 7px;
  background: var(--cs-surface);
  color: var(--cs-text);
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 7px 9px;
}

.rpl-add-input::placeholder {
  color: var(--cs-ghost);
  font-family: var(--font-sans);
}

.rpl-add-actions {
  display: flex;
  gap: 6px;
}

.rpl-add-submit {
  font-size: 12px;
  font-weight: 700;
  font-family: inherit;
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--cs-green);
  background: var(--cs-green);
  color: var(--cs-on-green);
  cursor: pointer;
}

.rpl-add-submit:not(:disabled):hover {
  background: var(--cs-green-hover);
  border-color: var(--cs-green-hover);
}

.rpl-add-submit:disabled {
  opacity: 0.45;
  cursor: default;
}

.rpl-add-cancel {
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid var(--cs-line-2);
  background: transparent;
  color: var(--cs-text-2);
  cursor: pointer;
}

.rpl-error {
  margin: 2px 0 0;
  padding: 0 2px;
  font-size: 11px;
  color: var(--cs-red-text);
  overflow-wrap: anywhere;
}
</style>
