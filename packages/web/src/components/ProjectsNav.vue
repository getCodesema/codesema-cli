<script setup lang="ts">
// Left projects column, 236px track (see the inner "card" wrapper below):
// "All projects" on top (total counter, green pill when active), then one
// row per registered repo: identity dot whose hue derives from the name
// (nameColor, pure), amber counters (⚠ waiting for the human, N agents at
// work), then the add-project form (manual path + detected repos), set off
// as the menu's footer. Selecting a row filters the whole UI; "All" clears
// the filter. The active project's MR/branch tree and its "Branches (N)"
// disclosure live here too, compact, under the list. All data comes from
// props, all mutations go up as events.
import { computed, ref, watch } from 'vue'
import {
  nameColor,
  nodeHasActiveConversation,
  type ConversationNode,
  type ProjectActivity,
} from '../composables/useProjects'
import { taskKey, type TaskState } from '../composables/useTasks'
import { EXECUTION_STATUS } from '../execution-status'
import { t } from '../i18n'
import type { ForgeMr, Project, ProjectCandidate } from '../types'

const props = defineProps<{
  projects: Project[]
  /** The selected filter: a project id, or null for "All projects". */
  selected: string | null
  /** Per-project live counters (waiting on the human / agents at work). */
  activity: ReadonlyMap<string, ProjectActivity>
  /** The selected project's tree (open MRs + active base branches). */
  tree: ConversationNode[]
  /** Local branches the tree does not show (see otherBranches), draft bases. */
  extraBranches: string[]
  /** Keys (taskKey) of the conversations open in the focus deck. */
  focusedKeys: readonly string[]
  addBusy: boolean
  addError: string | null
  removeError: string | null
  /** Git repos detected around the launch directory (discover event). */
  candidates: ProjectCandidate[]
}>()

const emit = defineEmits<{
  /** null selects "All projects" (no filter). */
  select: [id: string | null]
  add: [path: string]
  remove: [id: string]
  'open-task': [state: TaskState]
  /** A branch was clicked (tree node, MR node, or the branches disclosure):
   * the parent routes it through resolveBranchClick. */
  'branch-click': [payload: { projectId: string; branch: string; mr: ForgeMr | null }]
  /** Asks the parent to (re)fetch detection; fired when the add form opens. */
  discover: []
  /** Asks the parent to re-fetch the selected project's open MRs. */
  'refresh-mrs': []
}>()

const countsOf = (id: string): ProjectActivity =>
  props.activity.get(id) ?? { waiting: 0, active: 0 }

/** "All projects" counter: every live conversation across every repo. */
const total = computed(() => {
  let sum = 0
  for (const counts of props.activity.values()) {
    sum += counts.waiting + counts.active
  }
  return sum
})

const dotStyle = (name: string): Record<string, string> => ({
  background: `hsl(${nameColor(name)} 55% 62%)`,
})

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

// ── Tree: folded/unfolded per node ────────────────────────────────────────
// Nodes carrying an active conversation start unfolded; the map only stores
// the user's explicit overrides (keyed per project, so switching projects
// keeps each project's fold state).
const folded = ref(new Map<string, boolean>())

function nodeKey(node: ConversationNode): string {
  const scope = props.selected ?? ''
  return node.kind === 'mr' ? `${scope}:mr:${node.mr.number}` : `${scope}:br:${node.name}`
}

function isOpen(node: ConversationNode): boolean {
  return !(folded.value.get(nodeKey(node)) ?? !nodeHasActiveConversation(node))
}

function toggleNode(node: ConversationNode): void {
  const next = new Map(folded.value)
  next.set(nodeKey(node), isOpen(node))
  folded.value = next
}

function nodeLabel(node: ConversationNode): string {
  return node.kind === 'mr' ? `!${node.mr.number} ${node.mr.title}` : node.name
}

// ── Branch clicks (amendment 4: the conversation IS its branch) ───────────
function clickBranch(branch: string, mr: ForgeMr | null): void {
  if (props.selected !== null) {
    emit('branch-click', { projectId: props.selected, branch, mr })
  }
}

function onNodeClick(node: ConversationNode): void {
  clickBranch(
    node.kind === 'mr' ? node.mr.sourceBranch : node.name,
    node.kind === 'mr' ? node.mr : null,
  )
}

/** The chevron button: folds a node with conversations; on an empty node it
 * behaves like the label (there is nothing to fold). */
function onChevronClick(node: ConversationNode): void {
  if (node.states.length > 0) {
    toggleNode(node)
  } else {
    onNodeClick(node)
  }
}

// The folded "Branches (N)" disclosure under the tree; refolds on switch.
const othersOpen = ref(false)

watch(
  () => props.selected,
  () => {
    othersOpen.value = false
  },
)
</script>

<template>
  <nav class="pn-root" :aria-label="t('workspace.projectLabel')">
    <!-- Inner card: the raised surface (8px inset, 16px radius, hairline,
         elevated ground, subtle shadow). `.pn-root` is only the 236px track
         it floats in. -->
    <div class="pn-card">
      <!-- All projects: no filter. Active = accent fill (ready-to-scan state). -->
      <button
        class="pn-all"
        :class="{ 'pn-all--active': selected === null }"
        :aria-pressed="selected === null"
        @click="emit('select', null)"
      >
        {{ t('workspace.allProjects') }}
        <span class="pn-count-pill pn-all-count">{{ total }}</span>
      </button>

      <span class="pn-label">{{ t('workspace.projectLabel') }}</span>

      <div class="pn-list">
        <div v-for="project in projects" :key="project.id" class="pn-row">
          <button
            class="pn-project"
            :class="{ 'pn-project--active': project.id === selected }"
            :title="project.path"
            :aria-pressed="project.id === selected"
            @click="emit('select', project.id)"
          >
            <span class="pn-icon-slot">
              <span class="pn-dot" :style="dotStyle(project.name)" aria-hidden="true" />
            </span>
            <span class="pn-name">{{ project.name }}</span>
            <span class="pn-badges">
              <!-- Strong amber: conversations blocked on the human. -->
              <span
                v-if="countsOf(project.id).waiting > 0"
                class="pn-count-pill pn-badge pn-badge--waiting"
                :title="t('workspace.cardWaiting', { n: countsOf(project.id).waiting })"
              >
                ⚠ {{ countsOf(project.id).waiting }}
              </span>
              <!-- Plain amber count: agents at work, nothing asked of the human. -->
              <span
                v-if="countsOf(project.id).active > 0"
                class="pn-count-pill pn-badge pn-badge--running"
                :title="t('workspace.cardActive', { n: countsOf(project.id).active })"
              >
                {{ countsOf(project.id).active }}
              </span>
            </span>
          </button>
          <button
            class="pn-remove"
            :class="{ 'pn-remove--armed': confirmRemoveId === project.id }"
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

      <!-- Menu footer: the add-project control, set off by a hairline above. -->
      <div class="pn-footer">
        <button v-if="!formOpen" class="pn-add" @click="openForm">
          + {{ t('workspace.addProject') }}
        </button>

        <!-- Add form: detected repos first (one click), manual path as fallback. -->
        <form v-if="formOpen" class="pn-add-form" @submit.prevent="submitAdd">
          <div v-if="offerable.length > 0" class="pn-detected">
            <span class="pn-detected-label">{{ t('workspace.detectedProjects') }}</span>
            <button
              v-for="candidate in offerable"
              :key="candidate.path"
              class="pn-detected-item"
              type="button"
              :title="candidate.path"
              :disabled="addBusy"
              @click="addCandidate(candidate)"
            >
              <span class="pn-detected-plus" aria-hidden="true">+</span>
              <span class="pn-detected-name">{{ candidate.name }}</span>
            </button>
          </div>
          <input
            v-model="pathDraft"
            class="pn-add-input"
            type="text"
            :placeholder="t('workspace.addProjectPath')"
            spellcheck="false"
          />
          <div class="pn-add-actions">
            <button class="pn-add-submit" type="submit" :disabled="addBusy || !pathDraft.trim()">
              {{ addBusy ? t('workspace.addProjectBusy') : t('workspace.addProjectSubmit') }}
            </button>
            <button class="pn-add-cancel" type="button" @click="cancelForm">
              {{ t('workspace.addProjectCancel') }}
            </button>
          </div>
          <p v-if="addError" class="pn-error">
            {{ t('workspace.addProjectError') }} ({{ addError }})
          </p>
        </form>
      </div>

      <p v-if="removeError" class="pn-error">
        {{ t('workspace.removeProjectError') }} ({{ removeError }})
      </p>

      <!-- Compact tree of the selected project: open MRs + active branches. -->
      <div v-if="selected !== null" class="pn-tree">
        <div class="pn-tree-head">
          <span class="pn-label pn-label--inline">{{ t('workspace.conversations') }}</span>
          <button
            class="pn-icon-btn"
            :title="t('workspace.refreshMrs')"
            :aria-label="t('workspace.refreshMrs')"
            @click="emit('refresh-mrs')"
          >
            ↻
          </button>
        </div>

        <p v-if="tree.length === 0" class="pn-tree-empty">{{ t('workspace.treeEmpty') }}</p>

        <div v-for="node in tree" :key="nodeKey(node)" class="pn-node">
          <div class="pn-node-row">
            <button
              class="pn-node-toggle"
              :aria-expanded="node.states.length > 0 ? isOpen(node) : undefined"
              :aria-label="
                node.states.length > 0
                  ? t('workspace.toggleConversations')
                  : t('workspace.startOnBranch')
              "
              @click="onChevronClick(node)"
            >
              <span class="pn-node-chevron" aria-hidden="true">
                {{ node.states.length === 0 ? '+' : isOpen(node) ? '▾' : '▸' }}
              </span>
            </button>
            <!-- The label is the branch itself: open its conversation or draft. -->
            <button
              class="pn-node-btn"
              :title="
                node.states.length === 0
                  ? t('workspace.startOnBranch')
                  : node.kind === 'mr'
                    ? node.mr.title
                    : node.name
              "
              @click="onNodeClick(node)"
            >
              <span class="pn-node-glyph" aria-hidden="true">
                {{ node.kind === 'mr' ? '⇄' : '⎇' }}
              </span>
              <span class="pn-node-label">{{ nodeLabel(node) }}</span>
            </button>
          </div>
          <template v-if="isOpen(node)">
            <button
              v-for="state in node.states"
              :key="state.record.id"
              class="pn-conv"
              :class="{
                'pn-conv--open': focusedKeys.includes(taskKey(state.projectId, state.record.id)),
              }"
              @click="emit('open-task', state)"
            >
              <span
                class="pn-conv-glyph"
                :style="{ color: EXECUTION_STATUS[state.record.status].text }"
                :title="t(EXECUTION_STATUS[state.record.status].labelKey)"
                aria-hidden="true"
              >
                {{ EXECUTION_STATUS[state.record.status].icon }}
              </span>
              <span class="pn-conv-title">{{ state.record.title }}</span>
            </button>
          </template>
        </div>

        <!-- The remaining local branches, folded: each entry starts a draft. -->
        <div v-if="extraBranches.length > 0" class="pn-node pn-others">
          <button class="pn-node-btn" :aria-expanded="othersOpen" @click="othersOpen = !othersOpen">
            <span class="pn-node-chevron" aria-hidden="true">{{ othersOpen ? '▾' : '▸' }}</span>
            <span class="pn-node-label pn-others-label">
              {{ t('workspace.otherBranches', { n: extraBranches.length }) }}
            </span>
          </button>
          <template v-if="othersOpen">
            <button
              v-for="name in extraBranches"
              :key="name"
              class="pn-conv"
              :title="t('workspace.startOnBranch')"
              @click="clickBranch(name, null)"
            >
              <span class="pn-conv-glyph" aria-hidden="true">⎇</span>
              <span class="pn-conv-title">{{ name }}</span>
            </button>
          </template>
        </div>
      </div>
    </div>
  </nav>
</template>

<style scoped>
/* The 236px track the card floats in: bare ground, not a bordered/filled
   rail (the card below carries its own surface, hairline and shadow). A
   74px collapsed state is not built: no toggle exists yet to drive it. */
.pn-root {
  display: flex;
  flex-direction: column;
  width: 236px;
  flex: none;
  min-height: 0;
  overflow-y: auto;
  background: var(--cs-bg);
}

/* The inner card: 8px inset all round, 16px radius, 1px hairline, elevated
   surface, discreet shadow. */
.pn-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-height: 0;
  margin: 8px;
  padding: 12px 8px;
  border: 1px solid var(--cs-line-2);
  border-radius: 16px;
  background: var(--cs-surface);
  box-shadow: var(--cs-shadow-panel);
  overflow-y: auto;
}

/* "All projects": neutral row; active state is fill + text only, no border
   or side bar. */
.pn-all {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 36px;
  text-align: left;
  font-family: inherit;
  font-size: 12.5px;
  color: var(--cs-text-2);
  padding: 8px 12px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}

.pn-all:hover {
  background: var(--cs-hover);
}

.pn-all--active {
  background: var(--cs-green-soft);
  color: var(--cs-text);
  font-weight: 600;
}

/* Shared "count pastille" anatomy: min-width 18px, height 16px, full pill,
   12px bold text. Color/background per variant below: neutral pill
   baseline, a filled color only where the count already carries state
   (waiting = strong amber, the one asking for the human). */
.pn-count-pill {
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

.pn-all-count {
  margin-left: auto;
  background: var(--cs-green-soft);
  color: var(--cs-green-text);
}

/* Group subheader: normal case, not the tracked mono caps this used to be. */
.pn-label {
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 500;
  color: var(--cs-muted);
  padding: 12px 8px 8px;
}

.pn-label--inline {
  padding: 0 4px;
}

/* The repeating project rows: 2px apart from each other, a rhythm distinct
   from the card's own looser gap between sections. */
.pn-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.pn-row {
  display: flex;
  align-items: stretch;
  gap: 2px;
}

.pn-project {
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
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
}

.pn-project:hover {
  background: var(--cs-hover);
}

/* Active state: fill + text only, no border or side bar. */
.pn-project--active {
  background: var(--cs-active);
  color: var(--cs-text);
  font-weight: 600;
}

/* The icon slot every nav row reserves before its label: 16px, with a 10px
   gap to the label (the row's own `gap: 10px` above). The identity dot
   itself stays a small color swatch, centered in that slot. */
.pn-icon-slot {
  flex: none;
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* Identity dot: stable hue from the project name (nameColor). */
.pn-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 2px;
}

.pn-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pn-badges {
  margin-left: auto;
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Strong amber: the human blocks these conversations, the one pastille
   that carries a colored fill, per the doctrine (color is a state). */
.pn-badge--waiting {
  background: var(--cs-amber-soft);
  color: var(--cs-amber-text);
}

/* Plain amber count: the machine works, nothing is asked of the human;
   neutral pill, amber text only. */
.pn-badge--running {
  background: var(--cs-inset);
  color: var(--cs-amber);
}

/* Removal stays hidden until hover/focus; red only when armed. */
.pn-remove {
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

.pn-row:hover .pn-remove,
.pn-remove:focus-visible,
.pn-remove--armed {
  opacity: 1;
}

.pn-remove:hover {
  color: var(--cs-red-text);
  background: var(--cs-hover);
}

/* Armed confirmation carries a state: red is doctrine here, not decoration. */
.pn-remove--armed {
  color: var(--cs-red-text);
  background: var(--cs-red-soft);
}

/* Menu footer: set off from the project list by a hairline above it,
   regardless of which of its two states (the button, or the open form) is
   currently showing. */
.pn-footer {
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--cs-line);
}

.pn-add {
  text-align: left;
  font-size: 12px;
  font-family: inherit;
  color: var(--cs-ghost);
  padding: 7px 10px;
  border: none;
  border-radius: 7px;
  background: transparent;
  cursor: pointer;
}

.pn-add:hover {
  background: var(--cs-hover);
  color: var(--cs-text-2);
}

.pn-add-form {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 6px;
  padding: 0 2px;
}

.pn-detected {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.pn-detected-label {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--cs-ghost);
  padding: 2px 1px;
}

.pn-detected-item {
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

.pn-detected-item:hover:not(:disabled) {
  border-color: var(--cs-line-3);
}

.pn-detected-item:disabled {
  opacity: 0.45;
  cursor: default;
}

.pn-detected-plus {
  color: var(--cs-ghost);
  font-weight: 600;
}

.pn-detected-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pn-add-input {
  border: 1px solid var(--cs-line-2);
  border-radius: 7px;
  background: var(--cs-surface);
  color: var(--cs-text);
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 7px 9px;
}

.pn-add-input::placeholder {
  color: var(--cs-ghost);
  font-family: var(--font-sans);
}

.pn-add-actions {
  display: flex;
  gap: 6px;
}

.pn-add-submit {
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

.pn-add-submit:not(:disabled):hover {
  background: var(--cs-green-hover);
  border-color: var(--cs-green-hover);
}

.pn-add-submit:disabled {
  opacity: 0.45;
  cursor: default;
}

.pn-add-cancel {
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

.pn-error {
  margin: 2px 0 0;
  padding: 0 2px;
  font-size: 11px;
  color: var(--cs-red-text);
  overflow-wrap: anywhere;
}

/* ── Compact tree of the selected project ─────────────────────────────── */
.pn-tree {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--cs-line);
  min-height: 0;
}

.pn-tree-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 0 4px 4px;
}

.pn-icon-btn {
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
  color: var(--cs-muted);
  cursor: pointer;
}

.pn-icon-btn:hover {
  border-color: var(--cs-line-2);
  background: var(--cs-hover);
}

.pn-tree-empty {
  margin: 0;
  padding: 0 4px;
  font-size: 11.5px;
  color: var(--cs-ghost);
}

.pn-node {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* A tree node row: the fold chevron and the branch label are SEPARATE
   buttons — the label click routes to the branch's conversation or draft. */
.pn-node-row {
  display: flex;
  align-items: stretch;
}

.pn-node-toggle {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}

.pn-node-toggle:hover {
  background: var(--cs-hover);
}

.pn-node-btn {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  text-align: left;
  font-family: inherit;
  padding: 4px 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}

.pn-node-btn:hover {
  background: var(--cs-hover);
}

.pn-node-chevron {
  flex: none;
  width: 10px;
  font-size: 9px;
  color: var(--cs-ghost);
}

.pn-node-glyph {
  flex: none;
  width: 13px;
  text-align: center;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--cs-muted);
}

.pn-node-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--cs-text-2);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pn-conv {
  display: flex;
  align-items: center;
  gap: 7px;
  text-align: left;
  font-family: inherit;
  margin-left: 14px;
  padding: 4px 7px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
}

.pn-conv:hover {
  background: var(--cs-hover);
}

/* Marked: this conversation is the one currently in focus. */
.pn-conv--open {
  background: var(--cs-active);
}

/* The glyph is the colored carrier of the execution state (shared table). */
.pn-conv-glyph {
  flex: none;
  width: 13px;
  text-align: center;
  font-size: 11px;
  font-family: var(--font-mono);
}

.pn-conv-title {
  font-size: 12px;
  color: var(--cs-text-2);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The folded rest-of-branches disclosure stays quieter than real nodes. */
.pn-others {
  margin-top: 4px;
}

.pn-others-label {
  font-weight: 500;
  color: var(--cs-muted);
}
</style>
