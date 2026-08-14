<script setup lang="ts">
// Workspace sidebar, Codesema dashboard grammar: the project list on top —
// every registered repo with its selection checkbox, plus add/remove — then
// the nav, then one tree per selected project: its open MRs and active base
// branches as expandable nodes, conversations underneath with their status
// glyph from the shared execution-status table. Technical codesema/task-*
// branches never appear as nodes: the conversation carries them (the tree is
// built by buildProjectTree, pure and tested). All data comes from props, all
// mutations go up as events: the sidebar holds only its own disclosure state
// (add form open, pending removal confirmation, folded/unfolded nodes).
import { computed, ref, watch } from 'vue'
import {
  nodeHasActiveConversation,
  type ConversationNode,
  type ProjectTree,
} from '../composables/useProjects'
import type { TaskState } from '../composables/useTasks'
import { EXECUTION_STATUS } from '../execution-status'
import { t } from '../i18n'
import type { Project, ProjectCandidate } from '../types'

const props = defineProps<{
  projects: Project[]
  /** Ids of the selected projects (checkboxes). */
  selected: ReadonlySet<string>
  /** One tree per selected project, in registry order (see buildProjectTree). */
  trees: ProjectTree[]
  /** Open conversation, to highlight it in the trees. */
  activeTask: { projectId: string; id: string } | null
  addBusy: boolean
  addError: string | null
  removeError: string | null
  /** Git repos detected around the launch directory (see the discover event). */
  candidates: ProjectCandidate[]
}>()

const emit = defineEmits<{
  toggle: [id: string]
  add: [path: string]
  remove: [id: string]
  home: []
  'open-task': [state: TaskState]
  /** Asks the parent to (re)fetch detection; fired when the add form opens. */
  discover: []
  /** Asks the parent to re-fetch the open MRs of the selected projects. */
  'refresh-mrs': []
}>()

// ── Project list disclosure ───────────────────────────────────────────────
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
    emit('remove', id)
  } else {
    confirmRemoveId.value = id
  }
}

// ── Trees: folded/unfolded per node ───────────────────────────────────────
// Nodes carrying an active conversation start unfolded; the map only stores
// the user's explicit overrides, so fresh nodes keep the sensible default.
const folded = ref(new Map<string, boolean>())

function nodeKey(projectId: string, node: ConversationNode): string {
  return node.kind === 'mr' ? `${projectId}:mr:${node.mr.number}` : `${projectId}:br:${node.name}`
}

function isOpen(projectId: string, node: ConversationNode): boolean {
  return !(folded.value.get(nodeKey(projectId, node)) ?? !nodeHasActiveConversation(node))
}

function toggleNode(projectId: string, node: ConversationNode): void {
  const next = new Map(folded.value)
  next.set(nodeKey(projectId, node), isOpen(projectId, node))
  folded.value = next
}

function nodeLabel(node: ConversationNode): string {
  return node.kind === 'mr' ? `!${node.mr.number} ${node.mr.title}` : node.name
}

function isActiveState(state: TaskState): boolean {
  return (
    props.activeTask !== null &&
    state.projectId === props.activeTask.projectId &&
    state.record.id === props.activeTask.id
  )
}

const hasConversations = computed(() => props.trees.some((tree) => tree.nodes.length > 0))
</script>

<template>
  <aside class="sb-root">
    <div class="sb-brand-row">
      <span class="sb-brand">codesema</span>
      <span class="sb-brand-sub">{{ t('workspace.title') }}</span>
    </div>

    <!-- Project list: one checkbox per registered repo, add/remove inline. -->
    <div class="sb-project">
      <span class="sb-label">{{ t('workspace.projectLabel') }}</span>

      <!-- No project: the CTA is the whole block. -->
      <button v-if="projects.length === 0 && !formOpen" class="sb-add-cta" @click="openForm">
        {{ t('workspace.addProject') }}
      </button>

      <template v-else>
        <div v-for="project in projects" :key="project.id" class="sb-proj-row">
          <label class="sb-proj-check" :title="project.path">
            <input
              type="checkbox"
              class="sb-check"
              :checked="selected.has(project.id)"
              @change="emit('toggle', project.id)"
            />
            <span class="sb-proj-name">{{ project.name }}</span>
          </label>
          <button
            class="sb-proj-remove"
            :class="{ 'sb-proj-remove--armed': confirmRemoveId === project.id }"
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
        <button v-if="!formOpen" class="sb-add-inline" @click="openForm">
          + {{ t('workspace.addProject') }}
        </button>
      </template>

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

    <!-- Trees: open MRs + active base branches of each selected project. -->
    <div v-if="trees.length > 0" class="sb-trees">
      <div class="sb-trees-head">
        <span class="sb-label sb-label--inline">{{ t('workspace.conversations') }}</span>
        <button
          class="sb-icon-btn"
          :title="t('workspace.refreshMrs')"
          :aria-label="t('workspace.refreshMrs')"
          @click="emit('refresh-mrs')"
        >
          ↻
        </button>
      </div>

      <p v-if="!hasConversations" class="sb-tree-empty">
        {{ t('workspace.treeEmpty') }}
      </p>

      <div v-for="tree in trees" :key="tree.project.id" class="sb-tree">
        <span v-if="trees.length > 1" class="sb-tree-project" :title="tree.project.path">
          {{ tree.project.name }}
        </span>
        <div v-for="node in tree.nodes" :key="nodeKey(tree.project.id, node)" class="sb-node">
          <button
            class="sb-node-btn"
            :aria-expanded="isOpen(tree.project.id, node)"
            :title="node.kind === 'mr' ? node.mr.title : node.name"
            @click="toggleNode(tree.project.id, node)"
          >
            <span class="sb-node-chevron" aria-hidden="true">
              {{ isOpen(tree.project.id, node) ? '▾' : '▸' }}
            </span>
            <span class="sb-node-glyph" aria-hidden="true">
              {{ node.kind === 'mr' ? '⇄' : '⎇' }}
            </span>
            <span class="sb-node-label">{{ nodeLabel(node) }}</span>
          </button>
          <template v-if="isOpen(tree.project.id, node)">
            <button
              v-for="state in node.states"
              :key="state.record.id"
              class="sb-conv"
              :class="{ 'sb-conv--active': isActiveState(state) }"
              @click="emit('open-task', state)"
            >
              <span
                class="sb-conv-glyph"
                :style="{ color: EXECUTION_STATUS[state.record.status].text }"
                :title="t(EXECUTION_STATUS[state.record.status].labelKey)"
                aria-hidden="true"
              >
                {{ EXECUTION_STATUS[state.record.status].icon }}
              </span>
              <span class="sb-conv-title">{{ state.record.title }}</span>
            </button>
          </template>
        </div>
      </div>
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

.sb-label--inline {
  margin-bottom: 0;
}

/* ── Project list ─────────────────────────────────────────────────────── */
.sb-project {
  display: flex;
  flex-direction: column;
  gap: 2px;
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

.sb-proj-row {
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 8px;
  padding: 2px 4px;
}

.sb-proj-row:hover {
  background: var(--sema-hover);
}

.sb-proj-check {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  cursor: pointer;
}

.sb-check {
  flex: none;
  accent-color: var(--sema-accent);
}

.sb-proj-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--sema-ink);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Removal stays discreet until armed; red then carries the state. */
.sb-proj-remove {
  flex: none;
  font-size: 10.5px;
  font-family: inherit;
  color: var(--sema-ink-ghost);
  padding: 4px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  white-space: nowrap;
  opacity: 0;
}

.sb-proj-row:hover .sb-proj-remove,
.sb-proj-remove:focus-visible,
.sb-proj-remove--armed {
  opacity: 1;
}

.sb-proj-remove:hover {
  color: var(--sema-red-text);
  background: var(--sema-hover);
}

/* Armed confirmation carries a state: red is doctrine here, not decoration. */
.sb-proj-remove--armed {
  color: var(--sema-red-text);
  background: var(--sema-red-soft);
}

.sb-add-inline {
  margin-top: 4px;
  text-align: left;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  color: var(--sema-ink-3);
  padding: 5px 8px;
  border: none;
  border-radius: 7px;
  background: transparent;
  cursor: pointer;
}

.sb-add-inline:hover {
  background: var(--sema-hover);
  color: var(--sema-ink);
}

.sb-icon-btn {
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
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

/* ── Trees ────────────────────────────────────────────────────────────── */
.sb-trees {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow-y: auto;
}

.sb-trees-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.sb-tree {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.sb-tree-project {
  font-size: 11px;
  font-weight: 700;
  color: var(--sema-ink-2);
  padding: 2px 4px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sb-tree-empty {
  margin: 0;
  padding: 0 4px;
  font-size: 12px;
  color: var(--sema-ink-ghost);
}

.sb-node {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* Node rows stay neutral: the color lives in the conversation glyphs. */
.sb-node-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  text-align: left;
  font-family: inherit;
  padding: 5px 6px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}

.sb-node-btn:hover {
  background: var(--sema-hover);
}

.sb-node-chevron {
  flex: none;
  width: 10px;
  font-size: 9px;
  color: var(--sema-ink-ghost);
}

.sb-node-glyph {
  flex: none;
  width: 14px;
  text-align: center;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--sema-ink-3);
}

.sb-node-label {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--sema-ink-2);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sb-conv {
  display: flex;
  align-items: center;
  gap: 8px;
  text-align: left;
  font-family: inherit;
  margin-left: 16px;
  padding: 5px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}

.sb-conv:hover {
  background: var(--sema-hover);
}

.sb-conv--active {
  background: var(--sema-active);
}

/* The glyph is the colored carrier of the execution state (shared table). */
.sb-conv-glyph {
  flex: none;
  width: 14px;
  text-align: center;
  font-size: 11px;
  font-family: var(--font-mono);
}

.sb-conv-title {
  font-size: 12.5px;
  color: var(--sema-ink-2);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
