<script setup lang="ts">
// Workspace sidebar, Codesema dashboard grammar: the project selector on top
// (one project: its bare name; several: a dropdown; none: an "add" CTA), then
// the nav and the recent conversations of the CURRENT project, each with its
// status glyph from the shared execution-status table. All data comes from
// props, all mutations go up as events: the sidebar holds only its own
// disclosure state (menu open, add form open, pending removal confirmation).
import { computed, ref, watch } from 'vue'
import type { TaskState } from '../composables/useTasks'
import { EXECUTION_STATUS } from '../execution-status'
import { t } from '../i18n'
import type { Project, ProjectCandidate } from '../types'

const props = defineProps<{
  projects: Project[]
  currentId: string | null
  recents: TaskState[]
  /** Task id of the open conversation, to highlight it in the recents. */
  activeTaskId: string | null
  addBusy: boolean
  addError: string | null
  removeError: string | null
  /** Git repos detected around the launch directory (see the discover event). */
  candidates: ProjectCandidate[]
}>()

const emit = defineEmits<{
  select: [id: string]
  add: [path: string]
  remove: [id: string]
  home: []
  'open-task': [state: TaskState]
  /** Asks the parent to (re)fetch detection; fired when the add form opens. */
  discover: []
}>()

const current = computed(
  () => props.projects.find((project) => project.id === props.currentId) ?? null,
)

// ── Selector disclosure ───────────────────────────────────────────────────
const menuOpen = ref(false)
const formOpen = ref(false)
const pathDraft = ref('')
// Two-step removal: the first click arms the confirmation, the second fires.
const confirmRemoveId = ref<string | null>(null)

function toggleMenu(): void {
  menuOpen.value = !menuOpen.value
  confirmRemoveId.value = null
}

function selectProject(id: string): void {
  menuOpen.value = false
  confirmRemoveId.value = null
  emit('select', id)
}

function openForm(): void {
  formOpen.value = true
  menuOpen.value = false
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
  if (!path || props.addBusy) {
    return
  }
  emit('add', path)
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
    menuOpen.value = false
    emit('remove', id)
  } else {
    confirmRemoveId.value = id
  }
}
</script>

<template>
  <aside class="sb-root">
    <div class="sb-brand-row">
      <span class="sb-brand">codesema</span>
      <span class="sb-brand-sub">{{ t('workspace.title') }}</span>
    </div>

    <!-- Project selector -->
    <div class="sb-project">
      <span class="sb-label">{{ t('workspace.projectLabel') }}</span>

      <!-- No project: the CTA is the whole selector. -->
      <button v-if="projects.length === 0 && !formOpen" class="sb-add-cta" @click="openForm">
        {{ t('workspace.addProject') }}
      </button>

      <!-- One project: its bare name, plus a discreet add action. -->
      <div v-else-if="projects.length === 1" class="sb-single">
        <span class="sb-single-name" :title="current?.path">{{ current?.name }}</span>
        <button
          class="sb-icon-btn"
          :title="t('workspace.addProject')"
          :aria-label="t('workspace.addProject')"
          @click="openForm"
        >
          +
        </button>
      </div>

      <!-- Several projects: dropdown with switch, discreet removal and add. -->
      <div v-else-if="projects.length > 1" class="sb-menu-wrap">
        <button
          class="sb-menu-btn"
          :aria-expanded="menuOpen"
          :title="t('workspace.switchProject')"
          @click="toggleMenu"
        >
          <span class="sb-menu-name">{{ current?.name ?? '—' }}</span>
          <span class="sb-menu-chevron" aria-hidden="true">{{ menuOpen ? '▴' : '▾' }}</span>
        </button>
        <div v-if="menuOpen" class="sb-menu">
          <div v-for="project in projects" :key="project.id" class="sb-menu-row">
            <button
              class="sb-menu-item"
              :class="{ 'sb-menu-item--current': project.id === currentId }"
              :title="project.path"
              @click="selectProject(project.id)"
            >
              {{ project.name }}
            </button>
            <button
              class="sb-menu-remove"
              :class="{ 'sb-menu-remove--armed': confirmRemoveId === project.id }"
              :title="t('workspace.removeProjectHint')"
              @click="requestRemove(project.id)"
            >
              {{
                confirmRemoveId === project.id
                  ? t('workspace.removeProjectConfirm')
                  : t('workspace.removeProject')
              }}
            </button>
          </div>
          <button class="sb-menu-add" @click="openForm">+ {{ t('workspace.addProject') }}</button>
        </div>
      </div>

      <!-- Add form: detected repos first (one click), manual path as fallback. -->
      <form v-if="formOpen" class="sb-add-form" @submit.prevent="submitAdd">
        <div v-if="offerable.length > 0" class="sb-detected">
          <span class="sb-detected-label">{{ t('workspace.detectedProjects') }}</span>
          <button
            v-for="candidate in offerable"
            :key="candidate.path"
            class="sb-detected-item"
            type="button"
            :title="candidate.path"
            :disabled="addBusy"
            @click="addCandidate(candidate)"
          >
            <span class="sb-detected-plus" aria-hidden="true">+</span>
            <span class="sb-detected-name">{{ candidate.name }}</span>
          </button>
        </div>
        <input
          v-model="pathDraft"
          class="sb-add-input"
          type="text"
          :placeholder="t('workspace.addProjectPath')"
          spellcheck="false"
        />
        <div class="sb-add-actions">
          <button class="sb-add-submit" type="submit" :disabled="addBusy || !pathDraft.trim()">
            {{ addBusy ? t('workspace.addProjectBusy') : t('workspace.addProjectSubmit') }}
          </button>
          <button class="sb-add-cancel" type="button" @click="cancelForm">
            {{ t('workspace.addProjectCancel') }}
          </button>
        </div>
        <p v-if="addError" class="sb-error">
          {{ t('workspace.addProjectError') }} ({{ addError }})
        </p>
      </form>

      <p v-if="removeError" class="sb-error">
        {{ t('workspace.removeProjectError') }} ({{ removeError }})
      </p>
    </div>

    <!-- Nav -->
    <nav class="sb-nav">
      <button class="sb-nav-item" @click="emit('home')">{{ t('workspace.navHome') }}</button>
    </nav>

    <!-- Recents, scoped to the current project by the parent. -->
    <div class="sb-recents">
      <span class="sb-label">{{ t('workspace.recents') }}</span>
      <p v-if="recents.length === 0" class="sb-recents-empty">
        {{ t('workspace.recentsEmpty') }}
      </p>
      <button
        v-for="state in recents"
        :key="state.record.id"
        class="sb-recent"
        :class="{ 'sb-recent--active': state.record.id === activeTaskId }"
        @click="emit('open-task', state)"
      >
        <span
          class="sb-recent-glyph"
          :style="{ color: EXECUTION_STATUS[state.record.status].text }"
          :title="t(EXECUTION_STATUS[state.record.status].labelKey)"
          aria-hidden="true"
        >
          {{ EXECUTION_STATUS[state.record.status].icon }}
        </span>
        <span class="sb-recent-title">{{ state.record.title }}</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
.sb-root {
  display: flex;
  flex-direction: column;
  gap: 18px;
  width: 264px;
  flex: none;
  min-height: 100vh;
  padding: 16px 14px;
  border-right: 1px solid var(--sema-line);
  background: var(--sema-raised);
}

.sb-brand-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 4px;
}

.sb-brand {
  font-size: 15px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--sema-ink);
}

.sb-brand-sub {
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--sema-ink-3);
}

.sb-label {
  display: block;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--sema-ink-3);
  padding: 0 4px;
  margin-bottom: 6px;
}

/* ── Project selector ─────────────────────────────────────────────────── */
.sb-project {
  display: flex;
  flex-direction: column;
}

.sb-add-cta {
  font-size: 12.5px;
  font-weight: 600;
  font-family: inherit;
  text-align: left;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px dashed var(--sema-line-card);
  background: var(--sema-card);
  color: var(--sema-ink-2);
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.sb-add-cta:hover {
  border-color: var(--sema-ink-3);
}

.sb-single {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px;
}

.sb-single-name {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--sema-ink);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sb-icon-btn {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-family: inherit;
  line-height: 1;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--sema-ink-3);
  cursor: pointer;
}

.sb-icon-btn:hover {
  border-color: var(--sema-line-card);
  background: var(--sema-hover);
}

.sb-menu-wrap {
  position: relative;
}

.sb-menu-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  font-family: inherit;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid var(--sema-line-card);
  background: var(--sema-card);
  cursor: pointer;
  transition: border-color 0.12s ease;
}

.sb-menu-btn:hover {
  border-color: var(--sema-ink-3);
}

.sb-menu-name {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--sema-ink);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sb-menu-chevron {
  margin-left: auto;
  font-size: 10px;
  color: var(--sema-ink-3);
}

.sb-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  padding: 4px;
  border: 1px solid var(--sema-line-card);
  border-radius: 10px;
  background: var(--sema-card);
  box-shadow: var(--sema-shadow-panel);
}

.sb-menu-row {
  display: flex;
  align-items: center;
  gap: 4px;
}

.sb-menu-item {
  flex: 1;
  min-width: 0;
  text-align: left;
  font-size: 12.5px;
  font-family: inherit;
  color: var(--sema-ink-2);
  padding: 7px 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sb-menu-item:hover {
  background: var(--sema-hover);
}

.sb-menu-item--current {
  font-weight: 700;
  color: var(--sema-ink);
}

.sb-menu-remove {
  flex: none;
  font-size: 10.5px;
  font-family: inherit;
  color: var(--sema-ink-ghost);
  padding: 5px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  white-space: nowrap;
}

.sb-menu-remove:hover {
  color: var(--sema-red-text);
  background: var(--sema-hover);
}

/* Armed confirmation carries a state: red is doctrine here, not decoration. */
.sb-menu-remove--armed {
  color: var(--sema-red-text);
  background: var(--sema-red-soft);
}

.sb-menu-add {
  margin-top: 2px;
  text-align: left;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  color: var(--sema-ink-3);
  padding: 7px 8px;
  border: none;
  border-top: 1px solid var(--sema-line-soft);
  border-radius: 0 0 7px 7px;
  background: transparent;
  cursor: pointer;
}

.sb-menu-add:hover {
  background: var(--sema-hover);
  color: var(--sema-ink);
}

.sb-add-form {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 8px;
}

.sb-detected {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.sb-detected-label {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--sema-ink-ghost);
  padding: 2px 1px;
}

.sb-detected-item {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  font-family: inherit;
  text-align: left;
  padding: 5px 8px;
  border-radius: 7px;
  border: 1px solid var(--sema-line-soft);
  background: var(--sema-card);
  color: var(--sema-ink);
  cursor: pointer;
}

.sb-detected-item:hover:not(:disabled) {
  background: var(--sema-hover);
}

.sb-detected-item:disabled {
  opacity: 0.45;
  cursor: default;
}

.sb-detected-plus {
  color: var(--sema-ink-ghost);
  font-weight: 600;
}

.sb-detected-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sb-add-input {
  border: 1px solid var(--sema-line-soft);
  border-radius: 8px;
  background: var(--sema-card);
  color: var(--sema-ink);
  font-family: var(--font-mono);
  font-size: 11.5px;
  padding: 7px 9px;
}

.sb-add-input::placeholder {
  color: var(--sema-ink-ghost);
  font-family: var(--font-sans);
}

.sb-add-actions {
  display: flex;
  gap: 6px;
}

.sb-add-submit {
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  padding: 5px 12px;
  border-radius: 7px;
  border: 1px solid var(--sema-accent);
  background: var(--sema-accent);
  color: var(--sema-on-accent);
  cursor: pointer;
}

.sb-add-submit:disabled {
  opacity: 0.45;
  cursor: default;
}

.sb-add-cancel {
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  padding: 5px 10px;
  border-radius: 7px;
  border: 1px solid var(--sema-line-card);
  background: var(--sema-card);
  color: var(--sema-ink-2);
  cursor: pointer;
}

.sb-error {
  margin: 2px 0 0;
  font-size: 11.5px;
  color: var(--sema-red-text);
  overflow-wrap: anywhere;
}

/* ── Nav ──────────────────────────────────────────────────────────────── */
.sb-nav {
  display: flex;
  flex-direction: column;
}

.sb-nav-item {
  text-align: left;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  color: var(--sema-ink-2);
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}

.sb-nav-item:hover {
  background: var(--sema-hover);
  color: var(--sema-ink);
}

/* ── Recents ──────────────────────────────────────────────────────────── */
.sb-recents {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 0;
  overflow-y: auto;
}

.sb-recents-empty {
  margin: 0;
  padding: 0 4px;
  font-size: 12px;
  color: var(--sema-ink-ghost);
}

.sb-recent {
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  font-family: inherit;
  padding: 6px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}

.sb-recent:hover {
  background: var(--sema-hover);
}

.sb-recent--active {
  background: var(--sema-active);
}

/* The glyph is the colored carrier of the execution state (shared table). */
.sb-recent-glyph {
  flex: none;
  width: 14px;
  text-align: center;
  font-size: 11px;
  font-family: var(--font-mono);
}

.sb-recent-title {
  font-size: 12.5px;
  color: var(--sema-ink-2);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
