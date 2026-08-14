<script setup lang="ts">
// Workspace shell: the project sidebar (multi-select list, nav, per-project
// conversation trees), the home board (composer + the three zones) merged
// over every selected project, the conversation view with the touched-files
// panel, and the full review view when a task's review record is loadable.
// Owns the single useTasks stream; every child stays presentational and
// derives from pure functions.
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import {
  buildProjectTree,
  deriveComposerProject,
  filterBySelection,
  persistComposerProject,
  readPersistedComposerProject,
  type ProjectTree,
} from '../composables/useProjects'
import { sectionOf, type HomeSection } from '../composables/useTaskBoard'
import { taskKey, useTasks, type CreateTaskInput, type TaskState } from '../composables/useTasks'
import { t } from '../i18n'
import type { ReviewRecord } from '../types'
import PreviewPanel from './PreviewPanel.vue'
import ReviewShell from './ReviewShell.vue'
import TaskCard from './TaskCard.vue'
import TaskComposer from './TaskComposer.vue'
import TaskConversation from './TaskConversation.vue'
import WorkspaceSidebar from './WorkspaceSidebar.vue'

const props = defineProps<{ token: string }>()

const {
  store,
  states,
  connected,
  connections,
  projects,
  selectedProjects,
  mrsByProject,
  start,
  stop,
  hydrate,
  create,
  reply,
  interrupt,
  ship,
  toggleProject,
  refreshMrs,
  addProject,
  removeProject,
  candidates,
  discoverCandidates,
} = useTasks(props.token)

onMounted(start)
onUnmounted(stop)

type View = { kind: 'home' } | { kind: 'task'; projectId: string; id: string } | { kind: 'review' }

const view = ref<View>({ kind: 'home' })
const reviewRecord = shallowRef<ReviewRecord | null>(null)

// ── Selection scoping: the board merges every selected project ────────────
const selectedList = computed(() =>
  projects.value.filter((project) => selectedProjects.value.has(project.id)),
)
const projectStates = computed(() => filterBySelection(states.value, selectedProjects.value))
/** Badge names only when the board actually mixes repos. */
const projectNameById = computed(() => {
  if (selectedProjects.value.size <= 1) {
    return null
  }
  return new Map(projects.value.map((project) => [project.id, project.name]))
})

// ── Sidebar trees: open MRs + active base branches per selected project ───
const trees = computed<ProjectTree[]>(() =>
  selectedList.value.map((project) => ({
    project,
    nodes: buildProjectTree(
      projectStates.value.filter((state) => state.projectId === project.id),
      mrsByProject.get(project.id) ?? [],
    ),
  })),
)

// ── Home board ────────────────────────────────────────────────────────────
const sections = computed(() => {
  const grouped: Record<HomeSection, TaskState[]> = { waiting: [], active: [], done: [] }
  for (const state of projectStates.value) {
    grouped[sectionOf(state.record.status)].push(state)
  }
  return grouped
})

const SECTION_ORDER: {
  key: HomeSection
  labelKey: 'workspace.sectionWaiting' | 'workspace.sectionActive' | 'workspace.sectionDone'
}[] = [
  { key: 'waiting', labelKey: 'workspace.sectionWaiting' },
  { key: 'active', labelKey: 'workspace.sectionActive' },
  { key: 'done', labelKey: 'workspace.sectionDone' },
]

// ── Create (into the composer's target project) ───────────────────────────
const composer = ref<InstanceType<typeof TaskComposer> | null>(null)
const creating = ref(false)
const createError = ref<string | null>(null)
// Last used target, persisted; re-derived whenever the selection moves so it
// always points at a selected project (or the first one).
const composeTarget = ref<string | null>(null)

watch(
  selectedList,
  (list) => {
    const ids = list.map((project) => project.id)
    composeTarget.value = deriveComposerProject(
      composeTarget.value ?? readPersistedComposerProject(),
      ids,
    )
  },
  { immediate: true },
)

async function onCreate(input: CreateTaskInput): Promise<void> {
  const projectId = composeTarget.value
  if (projectId === null) {
    return
  }
  creating.value = true
  createError.value = null
  const result = await create(projectId, input)
  creating.value = false
  if (!result.ok) {
    createError.value = result.error
    return
  }
  persistComposerProject(projectId)
  composer.value?.reset()
  openTask(projectId, result.record.id)
}

// ── Project registry actions (sidebar) ────────────────────────────────────
const addBusy = ref(false)
const addError = ref<string | null>(null)
const removeError = ref<string | null>(null)

async function onAddProject(path: string): Promise<void> {
  addBusy.value = true
  addError.value = null
  const result = await addProject(path)
  if (!result.ok) {
    addError.value = result.error
  }
  addBusy.value = false
}

async function onRemoveProject(id: string): Promise<void> {
  removeError.value = null
  const result = await removeProject(id)
  if (!result.ok) {
    removeError.value = result.error
    return
  }
  // The open conversation may belong to the removed project: home is safe.
  backHome()
}

// ── Navigation ────────────────────────────────────────────────────────────
function openTask(projectId: string, id: string): void {
  view.value = { kind: 'task', projectId, id }
  void hydrate(projectId, id)
}

function backHome(): void {
  view.value = { kind: 'home' }
  reviewRecord.value = null
}

function openReview(record: ReviewRecord): void {
  reviewRecord.value = record
  view.value = { kind: 'review' }
}

function backFromReview(): void {
  // The review is always entered from a conversation; return there.
  const task = currentTask.value
  view.value = task ? { kind: 'task', projectId: task.projectId, id: task.id } : { kind: 'home' }
}

const currentTask = ref<{ projectId: string; id: string } | null>(null)
watch(view, (v) => {
  if (v.kind === 'task') {
    currentTask.value = { projectId: v.projectId, id: v.id }
  } else if (v.kind === 'home') {
    currentTask.value = null
  }
})

const currentState = computed(() =>
  view.value.kind === 'task'
    ? (store.get(taskKey(view.value.projectId, view.value.id)) ?? null)
    : null,
)

const activeTask = computed(() =>
  view.value.kind === 'task' ? { projectId: view.value.projectId, id: view.value.id } : null,
)

// Events emitted while the stream was down are not replayed: re-hydrate the
// open conversation on every reconnect.
watch(connections, () => {
  if (view.value.kind === 'task') {
    void hydrate(view.value.projectId, view.value.id)
  }
})
</script>

<template>
  <div class="ws-root">
    <WorkspaceSidebar
      :projects="projects"
      :selected="selectedProjects"
      :trees="trees"
      :active-task="activeTask"
      :add-busy="addBusy"
      :add-error="addError"
      :remove-error="removeError"
      :candidates="candidates"
      @toggle="toggleProject"
      @add="onAddProject"
      @remove="onRemoveProject"
      @discover="() => void discoverCandidates()"
      @refresh-mrs="() => void refreshMrs()"
      @home="backHome"
      @open-task="(state) => openTask(state.projectId, state.record.id)"
    />

    <div class="ws-main">
      <p v-if="!connected" class="ws-offline" role="status">
        {{ t('workspace.connectionLost') }}
      </p>

      <!-- Review view: the existing guided review, themed by the workspace. -->
      <div v-if="view.kind === 'review' && reviewRecord" class="ws-review">
        <button class="ws-review-back" @click="backFromReview">{{ t('workspace.back') }}</button>
        <ReviewShell :record="reviewRecord" />
      </div>

      <!-- Conversation view: thread on the left, touched files on the right. -->
      <div v-else-if="view.kind === 'task' && currentState" class="ws-task">
        <div class="ws-task-main">
          <TaskConversation
            :state="currentState"
            :reply="(m) => reply(currentState!.projectId, currentState!.record.id, m)"
            :interrupt="() => interrupt(currentState!.projectId, currentState!.record.id)"
            :ship="() => ship(currentState!.projectId, currentState!.record.id)"
            @back="backHome"
            @open-review="openReview"
          />
        </div>
        <aside class="ws-task-side">
          <h2 class="ws-side-title">{{ t('workspace.filesTitle') }}</h2>
          <PreviewPanel
            v-if="currentState.record.branch"
            :source="{ kind: 'branch', name: currentState.record.branch }"
            :project="currentState.projectId"
          />
          <p v-else class="ws-side-empty">{{ t('workspace.noBranchYet') }}</p>
        </aside>
      </div>

      <!-- Home: composer on top, then the three zones in fixed order. -->
      <div v-else class="ws-home">
        <p v-if="projects.length === 0" class="ws-empty">{{ t('workspace.noProject') }}</p>
        <p v-else-if="selectedList.length === 0" class="ws-empty">
          {{ t('workspace.noProjectSelected') }}
        </p>
        <template v-else>
          <TaskComposer
            ref="composer"
            v-model:target="composeTarget"
            :creating="creating"
            :error="createError"
            :projects="selectedList"
            @create="onCreate"
          />

          <p v-if="projectStates.length === 0" class="ws-empty">{{ t('workspace.emptyBoard') }}</p>

          <template v-for="section in SECTION_ORDER" :key="section.key">
            <section v-if="sections[section.key].length" class="ws-section">
              <h2 class="ws-section-title">
                {{ t(section.labelKey) }}
                <span class="ws-section-count">{{
                  t('workspace.taskCount', { n: sections[section.key].length })
                }}</span>
              </h2>
              <div class="ws-section-list">
                <TaskCard
                  v-for="state in sections[section.key]"
                  :key="taskKey(state.projectId, state.record.id)"
                  :state="state"
                  :prominent="section.key === 'waiting'"
                  :show-activity="section.key === 'active'"
                  :project-name="projectNameById?.get(state.projectId) ?? null"
                  @select="openTask(state.projectId, state.record.id)"
                />
              </div>
            </section>
          </template>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ws-root {
  display: flex;
  align-items: stretch;
  min-height: 100vh;
  background: var(--sema-bg);
  color: var(--sema-ink);
}

.ws-main {
  flex: 1;
  min-width: 0;
}

.ws-offline {
  margin: 0;
  padding: 8px 26px;
  font-size: 12px;
  color: var(--sema-amber-text);
  background: var(--sema-amber-soft);
}

.ws-home {
  max-width: 860px;
  margin: 0 auto;
  padding: 28px 24px 80px;
  display: flex;
  flex-direction: column;
  gap: 26px;
}

.ws-empty {
  margin: 12px 0 0;
  text-align: center;
  font-size: 13px;
  color: var(--sema-ink-3);
}

.ws-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ws-section-title {
  margin: 0;
  font-size: 14.5px;
  font-weight: 700;
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.ws-section-count {
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-weight: 400;
  color: var(--sema-ink-3);
}

.ws-section-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.ws-task {
  display: flex;
  align-items: flex-start;
  gap: 22px;
  max-width: 1280px;
  margin: 0 auto;
  padding: 24px 24px 80px;
}

.ws-task-main {
  flex: 1;
  min-width: 0;
}

.ws-task-side {
  width: 380px;
  flex: none;
  position: sticky;
  top: 18px;
  max-height: calc(100vh - 40px);
  overflow-y: auto;
  padding: 14px 16px;
  border: 1px solid var(--sema-line-card);
  border-radius: 13px;
  background: var(--sema-card);
}

.ws-side-title {
  margin: 0 0 12px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--sema-ink-3);
}

.ws-side-empty {
  margin: 0;
  font-size: 12.5px;
  color: var(--sema-ink-3);
}

.ws-review {
  padding: 18px 24px 60px;
}

.ws-review-back {
  margin-bottom: 12px;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--sema-line-card);
  background: var(--sema-card);
  color: var(--sema-ink-2);
  cursor: pointer;
}

.ws-review-back:hover {
  border-color: var(--sema-ink-3);
}

@media (max-width: 980px) {
  .ws-task {
    flex-direction: column;
  }

  .ws-task-side {
    width: 100%;
    position: static;
    max-height: none;
  }
}
</style>
