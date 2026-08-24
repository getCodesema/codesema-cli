<script setup lang="ts">
// Workspace shell, T4 layout: a global 52px header (search, attention bell,
// agents counter), the projects column on the left (filter + the selected
// project's MR/branch tree), the work queue in the center-left (composer +
// status sections), and the focus zone on the right — a DECK of columns
// (useFocusDeck, pure): one conversation by default, pinned conversations
// side by side (max 3), fork/work-on drafts keeping their own column; the
// full-screen review view covers the focus zone only. Owns the single
// useTasks stream; every child stays presentational and derives from pure
// functions.
import { computed, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from 'vue'
import {
  columnKey,
  draftBranch,
  draftColumnKey,
  forkDraft,
  workonDraft,
  type DraftTarget,
} from '../composables/useColumns'
import {
  deckCloseDraft,
  deckCloseProject,
  deckOpenDraft,
  deckOpenTask,
  deckPromoteDraft,
  deckSwapDraft,
  deckTogglePin,
  EMPTY_DECK,
  isPinned,
  type FocusDeck,
} from '../composables/useFocusDeck'
import { useIssues } from '../composables/useIssues'
import {
  buildProjectTree,
  countProjectActivity,
  isolationForProject,
  isTrunkBranch,
  otherBranches,
  resolveBranchClick,
  type ConversationNode,
} from '../composables/useProjects'
import { agentCounts, matchesQuery, oldestWaiting } from '../composables/useTaskBoard'
import {
  createPlanRequests,
  planRequestBody,
  retargetDraft,
  type DraftPlan,
  type PlanComposerInput,
} from '../composables/useTaskPlan'
import { taskKey, useTasks, type CreateTaskInput, type TaskState } from '../composables/useTasks'
import { t } from '../i18n'
import type { AgentOption, ForgeMr, ReviewRecord } from '../types'
import ForgeBoard from './forge/ForgeBoard.vue'
import ProjectsNav from './ProjectsNav.vue'
import RepoSettings from './RepoSettings.vue'
import ReviewShell from './ReviewShell.vue'
import TaskComposer from './TaskComposer.vue'
import TaskConversation from './TaskConversation.vue'
import WorkQueue from './WorkQueue.vue'
import WorkspaceHeader from './WorkspaceHeader.vue'

const props = defineProps<{ token: string }>()

const {
  store,
  states,
  connected,
  connections,
  projects,
  mrsByProject,
  mrsLoadByProject,
  branchesByProject,
  start,
  stop,
  hydrate,
  create,
  reply,
  interrupt,
  resume,
  ship,
  abandon,
  hydrateChecks,
  runChecks,
  checksSetup,
  loadChecksSetup,
  runChecksSetup,
  applyChecksProposal,
  dismissChecksProposal,
  selectProject,
  refreshMrs,
  addProject,
  removeProject,
  candidates,
  discoverCandidates,
  workspace,
  loadProjects,
  preview,
} = useTasks(props.token)

// Forge board (C3): lazy per-project issue fetch, same trigger as the MR/branch
// lazy-fetch policy above, see selectFilter.
const issues = useIssues()

const agents = ref<AgentOption[]>([])
const currentAgent = ref('')

function isAgentOption(value: unknown): value is AgentOption {
  if (!value || typeof value !== 'object') {
    return false
  }
  const o = value as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.label === 'string' &&
    typeof o.bin === 'string' &&
    typeof o.command === 'string' &&
    typeof o.detected === 'boolean'
  )
}

async function loadAgentConfig(): Promise<void> {
  try {
    const res = await fetch('/api/config')
    if (!res.ok) {
      return
    }
    const body = (await res.json()) as { agent?: unknown; agents?: unknown }
    if (typeof body.agent === 'string') {
      currentAgent.value = body.agent
    }
    if (Array.isArray(body.agents)) {
      agents.value = body.agents.filter(isAgentOption)
    }
  } catch {
    // Older CLIs omit these fields; the picker stays hidden.
  }
}

const showSettings = ref(false)

async function closeSettings(): Promise<void> {
  showSettings.value = false
  await Promise.all([loadAgentConfig(), loadProjects()])
}

function toggleSettings(): void {
  if (showSettings.value) {
    void closeSettings()
  } else {
    showSettings.value = true
  }
}

onMounted(() => {
  start()
  void loadAgentConfig()
})
onUnmounted(stop)

const projectNameById = computed(
  () => new Map(projects.value.map((project) => [project.id, project.name])),
)

// ── Project filter: a project id, or null for "All projects" ──────────────
// Selecting a project also makes it the registry's active card, which lazily
// loads its MRs/branches for the tree; "All" only clears the filter.
const filter = ref<string | null>(null)

function selectFilter(id: string | null): void {
  filter.value = id
  if (id !== null) {
    selectProject(id)
    issues.load(id)
  }
}

/** States scoped to the filter — the queue's and the header's world. */
const scopedStates = computed(() =>
  filter.value === null
    ? states.value
    : states.value.filter((state) => state.projectId === filter.value),
)

// ── Header: search + live counters over the scoped states ─────────────────
const query = ref('')
const counters = computed(() => agentCounts(scopedStates.value))

/**
 * The workspace facts of the world the header describes — the filtered
 * project's own, or the process-wide blob under "All projects". Follows the
 * filter for the same reason the isolation badge follows the compose target:
 * `no-remote` is a fact about ONE repo, and reading it off the launch repo
 * would hide a degraded sibling behind a healthy blob.
 */
const headerWorkspace = computed(() =>
  isolationForProject(filter.value, projects.value, workspace.value),
)

/** The queue additionally filters by the header search (title or branch). */
const queueStates = computed(() =>
  scopedStates.value.filter((state) => matchesQuery(state.record, query.value)),
)

// Attention cards show the agent's question without being opened: hydrate
// each conversation once when it enters the attention zone (the stream only
// carries events emitted after connect, the question may predate it).
const hydratedForQuestion = new Set<string>()
// Ready cards wear a checks mini-badge: fetch the persisted result once when
// a conversation reaches the ready zone ('task_checks' frames keep it live).
const hydratedForChecks = new Set<string>()

watch(
  states,
  (all) => {
    for (const state of all) {
      const key = taskKey(state.projectId, state.record.id)
      if (
        (state.record.status === 'waiting_for_you' || state.record.status === 'review_ko') &&
        !hydratedForQuestion.has(key)
      ) {
        hydratedForQuestion.add(key)
        void hydrate(state.projectId, state.record.id)
      }
      if (state.record.status === 'review_ok' && !hydratedForChecks.has(key)) {
        hydratedForChecks.add(key)
        void hydrateChecks(state.projectId, state.record.id)
      }
    }
  },
  { immediate: true },
)

/** Bell click: open the conversation that has waited the longest. */
function openOldestWaiting(): void {
  const state = oldestWaiting(scopedStates.value)
  if (state) {
    openConversation(state.projectId, state.record.id)
  }
}

// ── Focus deck: one conversation, pinned ones side by side, drafts kept ───
const deck = ref<FocusDeck>(EMPTY_DECK)

const focusedKeys = computed(() => deck.value.cols.columns.map(columnKey))

/** What each deck slot renders: the task column with its live state (a stale
 * id renders nothing and falls out without disturbing the other slots), or
 * the draft composer. Flattened here so the template stays cast-free. */
type DeckEntry =
  | { kind: 'task'; key: string; projectId: string; taskId: string; state: TaskState }
  | { kind: 'draft'; key: string; projectId: string; draft: DraftTarget }

const deckEntries = computed<DeckEntry[]>(() => {
  const entries: DeckEntry[] = []
  for (const column of deck.value.cols.columns) {
    const key = columnKey(column)
    if (column.ref.kind === 'task') {
      const state = store.get(taskKey(column.projectId, column.ref.taskId))
      if (state) {
        entries.push({
          kind: 'task',
          key,
          projectId: column.projectId,
          taskId: column.ref.taskId,
          state,
        })
      }
    } else {
      entries.push({ kind: 'draft', key, projectId: column.projectId, draft: column.ref })
    }
  }
  return entries
})

function openConversation(projectId: string, taskId: string): void {
  deck.value = deckOpenTask(deck.value, projectId, taskId)
  reviewRecord.value = null
  void hydrate(projectId, taskId)
}

function togglePin(key: string): void {
  deck.value = deckTogglePin(deck.value, key)
}

// Events emitted while the stream was down are not replayed: re-hydrate every
// open conversation on each reconnect (drafts have nothing to fetch).
watch(connections, () => {
  for (const column of deck.value.cols.columns) {
    if (column.ref.kind === 'task') {
      void hydrate(column.projectId, column.ref.taskId)
    }
  }
})

// ── Draft columns: an empty composer in fork or work-on mode ──────────────
type DraftRun = { creating: boolean; error: string | null }

/** Per-column create state, keyed by the draft column's identity. */
const draftRuns = reactive(new Map<string, DraftRun>())

function runOf(projectId: string, draft: DraftTarget): DraftRun {
  return draftRuns.get(draftColumnKey(projectId, draft)) ?? { creating: false, error: null }
}

// ── T2.6: the plan of what a draft WOULD create ───────────────────────────
//
// The machinery (debounce, per-column run token, the states themselves) lives
// in useTaskPlan.ts: this component cannot be mounted in a test — its setup
// builds `useTasks` — so a rule kept HERE is a rule nothing exercises. All
// that is left in the view is the mapping from a column to its key.
const planRequests = createPlanRequests((body) => preview(body))

function planOf(projectId: string, draft: DraftTarget): DraftPlan {
  return planRequests.planOf(draftColumnKey(projectId, draft))
}

/**
 * Asks the server what this draft would create. NEVER a creation: the route
 * it calls writes nothing at all, so a human typing in the composer costs
 * reads and nothing else.
 */
function onPlanInput(projectId: string, draft: DraftTarget, input: PlanComposerInput): void {
  planRequests.request(
    draftColumnKey(projectId, draft),
    planRequestBody(projectId, draft, input),
    input.prompt,
  )
}

/**
 * The plan made correctable: the target branch is the DRAFT itself, so a
 * correction swaps that draft in place (same slot, same FIFO age) exactly as
 * the fork/work-on toggle does. No task is created, and the composer's prompt
 * is carried over since the new column key remounts it.
 */
function onDraftRetarget(
  projectId: string,
  draft: DraftTarget,
  branch: string,
  prompt: string,
): void {
  const next = retargetDraft(draft, branch)
  if (next === draft) {
    return
  }
  const from = draftColumnKey(projectId, draft)
  planRequests.forget(from)
  draftRuns.delete(from)
  deck.value = deckSwapDraft(deck.value, projectId, draft, next)
  planRequests.carry(draftColumnKey(projectId, next), prompt)
}

function openDraft(projectId: string, draft: DraftTarget): void {
  deck.value = deckOpenDraft(deck.value, projectId, draft)
  reviewRecord.value = null
  draftRuns.delete(draftColumnKey(projectId, draft))
  planRequests.forget(draftColumnKey(projectId, draft))
}

/** The draft's mode switch: work-on <-> fork-from, same column slot. When
 * flipping to work-on, an open MR of the branch contributes its target. */
function toggleDraftMode(projectId: string, draft: DraftTarget): void {
  const branch = draftBranch(draft)
  const other =
    draft.mode === 'fork'
      ? workonDraft(
          branch,
          (mrsByProject.get(projectId) ?? []).find((m) => m.sourceBranch === branch)
            ?.targetBranch ?? null,
        )
      : forkDraft(branch)
  deck.value = deckSwapDraft(deck.value, projectId, draft, other)
  draftRuns.delete(draftColumnKey(projectId, draft))
  planRequests.forget(draftColumnKey(projectId, draft))
}

function closeDraft(projectId: string, draft: DraftTarget): void {
  deck.value = deckCloseDraft(deck.value, projectId, draft)
  draftRuns.delete(draftColumnKey(projectId, draft))
  planRequests.forget(draftColumnKey(projectId, draft))
}

/** Every branch/MR click of the projects column routes through the pure
 * resolveBranchClick: open the branch's active conversation, or draft. */
function onBranchClick(projectId: string, branch: string, mr: ForgeMr | null): void {
  const projectStates = states.value.filter((state) => state.projectId === projectId)
  const resolution = resolveBranchClick(branch, mr, projectStates)
  if (resolution.kind === 'open') {
    openConversation(projectId, resolution.taskId)
  } else if (resolution.kind === 'draft-fork') {
    openDraft(projectId, forkDraft(resolution.base))
  } else {
    openDraft(projectId, workonDraft(resolution.branch, resolution.target))
  }
}

/** Launches the real conversation from the draft: the POST carries base
 * (fork) or branch+target (work-on); on success — or on the 409 "already has
 * a conversation" — the column becomes that conversation IN PLACE. */
async function onDraftCreate(
  projectId: string,
  draft: DraftTarget,
  input: CreateTaskInput,
): Promise<void> {
  const key = draftColumnKey(projectId, draft)
  if (draftRuns.get(key)?.creating) {
    return
  }
  draftRuns.set(key, { creating: true, error: null })
  const payload: CreateTaskInput =
    draft.mode === 'fork'
      ? { ...input, base: draft.base }
      : { ...input, branch: draft.branch, ...(draft.target !== null && { target: draft.target }) }
  const result = await create(projectId, payload)
  if (!result.ok) {
    if (result.existingTaskId !== null) {
      // 409 uniqueness guard: the branch's ACTIVE conversation takes the slot.
      draftRuns.delete(key)
      deck.value = deckPromoteDraft(deck.value, projectId, draft, result.existingTaskId)
      void hydrate(projectId, result.existingTaskId)
      return
    }
    // A readable 400/409 (unknown branch, worktree busy…) or a network
    // error: shown in the draft panel.
    draftRuns.set(key, { creating: false, error: result.error })
    return
  }
  draftRuns.delete(key)
  planRequests.forget(key)
  deck.value = deckPromoteDraft(deck.value, projectId, draft, result.record.id)
  void hydrate(projectId, result.record.id)
}

// ── Review view: full screen over the focus zone only ─────────────────────
const reviewRecord = shallowRef<ReviewRecord | null>(null)

function openReview(record: ReviewRecord): void {
  reviewRecord.value = record
}

function backFromReview(): void {
  // The deck was never touched: the conversations are still where they were.
  reviewRecord.value = null
}

// ── Projects column: counters + the selected project's tree ───────────────
const activity = computed(() => countProjectActivity(states.value))

const tree = computed<ConversationNode[]>(() => {
  const projectId = filter.value
  if (projectId === null) {
    return []
  }
  return buildProjectTree(
    states.value.filter((state) => state.projectId === projectId),
    mrsByProject.get(projectId) ?? [],
  )
})

/** Local branches of the selected project the tree does not already show:
 * the "Branches (N)" disclosure, each entry a draft target. */
const extraBranches = computed<string[]>(() => {
  const projectId = filter.value
  if (projectId === null) {
    return []
  }
  return otherBranches(
    branchesByProject.get(projectId) ?? [],
    tree.value,
    mrsByProject.get(projectId) ?? [],
  )
})

// ── Create (queue composer) ───────────────────────────────────────────────
const creating = ref(false)
const createError = ref<string | null>(null)

async function onCreate(projectId: string, input: CreateTaskInput): Promise<void> {
  creating.value = true
  createError.value = null
  const result = await create(projectId, input)
  creating.value = false
  if (!result.ok) {
    if (result.existingTaskId !== null) {
      // 409 uniqueness guard: open the branch's existing conversation.
      openConversation(projectId, result.existingTaskId)
      return
    }
    createError.value = result.error
    return
  }
  openConversation(projectId, result.record.id)
}

/** [Ship] on a ready card: the existing ship action, with the conversation
 * brought into focus so the outcome is visible. */
function onQueueShip(state: TaskState): void {
  openConversation(state.projectId, state.record.id)
  void ship(state.projectId, state.record.id)
}

/** [Resume] on a stopped card (T8): same shape as [Ship] — the conversation
 * opens, so the restarted turn is watched live instead of guessed at. */
function onQueueResume(state: TaskState): void {
  openConversation(state.projectId, state.record.id)
  void resume(state.projectId, state.record.id)
}

// ── Project registry actions ──────────────────────────────────────────────
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
  // Its store states are gone: drop its filter and columns too.
  if (filter.value === id) {
    filter.value = null
  }
  deck.value = deckCloseProject(deck.value, id)
}
</script>

<template>
  <div class="ws-root">
    <WorkspaceHeader
      v-model:query="query"
      :needs-you="counters.needsYou"
      :agents="counters.agents"
      :settings-open="showSettings"
      :workspace="headerWorkspace"
      @open-oldest-waiting="openOldestWaiting"
      @settings="toggleSettings"
    />

    <p v-if="!connected" class="ws-offline" role="status">
      {{ t('workspace.connectionLost') }}
    </p>

    <div v-if="showSettings" class="ws-settings">
      <RepoSettings />
    </div>
    <div v-else class="ws-body">
      <ProjectsNav
        :projects="projects"
        :selected="filter"
        :activity="activity"
        :tree="tree"
        :extra-branches="extraBranches"
        :focused-keys="focusedKeys"
        :add-busy="addBusy"
        :add-error="addError"
        :remove-error="removeError"
        :candidates="candidates"
        @select="selectFilter"
        @add="onAddProject"
        @remove="onRemoveProject"
        @discover="() => void discoverCandidates()"
        @refresh-mrs="() => void refreshMrs()"
        @open-task="(state) => openConversation(state.projectId, state.record.id)"
        @branch-click="({ projectId, branch, mr }) => onBranchClick(projectId, branch, mr)"
      />

      <WorkQueue
        :states="queueStates"
        :project-names="projectNameById"
        :focused-keys="focusedKeys"
        :projects="projects"
        :filter="filter"
        :creating="creating"
        :create-error="createError"
        :workspace="workspace"
        :agents="agents"
        :current-agent="currentAgent"
        @open="(state) => openConversation(state.projectId, state.record.id)"
        @ship="onQueueShip"
        @resume="onQueueResume"
        @create="onCreate"
      />

      <main class="ws-focus">
        <!-- Review view: the existing guided review, over the focus zone. -->
        <div v-if="reviewRecord" class="ws-review">
          <button class="ws-review-back" @click="backFromReview">{{ t('workspace.back') }}</button>
          <ReviewShell :record="reviewRecord" />
        </div>

        <!-- The deck: conversations (pinned side by side) and draft columns. -->
        <div v-else-if="deckEntries.length > 0" class="ws-deck">
          <div v-for="entry in deckEntries" :key="entry.key" class="ws-col">
            <TaskConversation
              v-if="entry.kind === 'task'"
              :state="entry.state"
              :project-name="projectNameById.get(entry.projectId) ?? entry.projectId"
              :pinned="isPinned(deck, entry.key)"
              :reply="(m) => reply(entry.projectId, entry.taskId, m)"
              :interrupt="() => interrupt(entry.projectId, entry.taskId)"
              :resume="() => resume(entry.projectId, entry.taskId)"
              :ship="() => ship(entry.projectId, entry.taskId)"
              :abandon="() => abandon(entry.projectId, entry.taskId)"
              :run-checks="() => runChecks(entry.projectId, entry.taskId)"
              :load-checks="() => hydrateChecks(entry.projectId, entry.taskId)"
              :checks-setup="checksSetup.get(entry.projectId)"
              :load-checks-setup="() => loadChecksSetup(entry.projectId)"
              :run-checks-setup="() => runChecksSetup(entry.projectId)"
              :apply-checks-proposal="() => applyChecksProposal(entry.projectId)"
              :dismiss-checks-proposal="() => dismissChecksProposal(entry.projectId)"
              @open-review="openReview"
              @toggle-pin="togglePin(entry.key)"
            />

            <!-- Draft column: a composer in fork mode (new branch from a
                 base) or work-on mode (directly on an existing branch); the
                 create turns this column into the real conversation. -->
            <div v-else class="ws-draft-wrap">
              <div class="ws-draft">
                <header class="ws-draft-head">
                  <h2 class="ws-draft-title">
                    {{
                      entry.draft.mode === 'fork'
                        ? t('workspace.draftForkTitle', { base: entry.draft.base })
                        : t('workspace.draftWorkonTitle', { branch: entry.draft.branch })
                    }}
                  </h2>
                  <span class="ws-draft-project">
                    {{ projectNameById.get(entry.projectId) ?? entry.projectId }}
                  </span>
                  <button
                    class="ws-draft-close"
                    :aria-label="t('workspace.addProjectCancel')"
                    :title="t('workspace.addProjectCancel')"
                    @click="closeDraft(entry.projectId, entry.draft)"
                  >
                    ✕
                  </button>
                </header>
                <div
                  class="ws-draft-modes"
                  role="group"
                  :aria-label="t('workspace.draftModeLabel')"
                >
                  <button
                    class="ws-draft-mode"
                    :class="{ 'ws-draft-mode--on': entry.draft.mode === 'workon' }"
                    type="button"
                    @click="
                      entry.draft.mode === 'fork' && toggleDraftMode(entry.projectId, entry.draft)
                    "
                  >
                    {{ t('workspace.draftModeWorkon') }}
                  </button>
                  <button
                    class="ws-draft-mode"
                    :class="{ 'ws-draft-mode--on': entry.draft.mode === 'fork' }"
                    type="button"
                    @click="
                      entry.draft.mode === 'workon' && toggleDraftMode(entry.projectId, entry.draft)
                    "
                  >
                    {{ t('workspace.draftModeFork') }}
                  </button>
                </div>
                <p
                  v-if="entry.draft.mode === 'workon' && isTrunkBranch(draftBranch(entry.draft))"
                  class="ws-draft-warning"
                >
                  {{ t('workspace.draftTrunkWarning', { branch: draftBranch(entry.draft) }) }}
                </p>
                <div class="ws-draft-chips">
                  <span
                    class="ws-draft-chip"
                    :title="
                      entry.draft.mode === 'fork'
                        ? t('workspace.draftBaseHint', { branch: entry.draft.base })
                        : t('workspace.draftWorkonHint', { branch: entry.draft.branch })
                    "
                  >
                    <span aria-hidden="true">⎇</span> {{ draftBranch(entry.draft) }}
                  </span>
                  <!-- Work-on from an MR node: the merge target rides along. -->
                  <span
                    v-if="entry.draft.mode === 'workon' && entry.draft.target !== null"
                    class="ws-draft-chip"
                    :title="t('workspace.draftTargetHint', { target: entry.draft.target })"
                  >
                    <span aria-hidden="true">→</span> {{ entry.draft.target }}
                  </span>
                </div>
                <TaskComposer
                  compact
                  :creating="runOf(entry.projectId, entry.draft).creating"
                  :error="runOf(entry.projectId, entry.draft).error"
                  :agents="agents"
                  :current-agent="
                    isolationForProject(entry.projectId, projects, workspace)?.agent ?? currentAgent
                  "
                  :isolation="
                    isolationForProject(entry.projectId, projects, workspace)?.isolation_default ??
                    null
                  "
                  :draft="entry.draft"
                  :plan="planOf(entry.projectId, entry.draft).plan"
                  :plan-error="planOf(entry.projectId, entry.draft).error"
                  :plan-pending="planOf(entry.projectId, entry.draft).pending"
                  :initial-prompt="planRequests.promptOf(entry.key)"
                  @create="(input) => onDraftCreate(entry.projectId, entry.draft, input)"
                  @plan-input="(input) => onPlanInput(entry.projectId, entry.draft, input)"
                  @retarget="
                    (branch, prompt) =>
                      onDraftRetarget(entry.projectId, entry.draft, branch, prompt)
                  "
                />
              </div>
            </div>
          </div>
        </div>

        <!-- Forge board: the selected project's open issues/MRs, in place of
             the sober empty-state once a project is actually chosen. -->
        <div v-else-if="filter !== null && projects.length > 0" class="ws-forge-board">
          <ForgeBoard
            :issues-state="issues.stateOf(filter)"
            :mrs="mrsByProject.get(filter) ?? []"
            :mrs-state="mrsLoadByProject.get(filter) ?? null"
            @retry-issues="issues.reload(filter)"
          />
        </div>

        <!-- Empty focus: a sober invite (no project selected, or none registered). -->
        <div v-else class="ws-empty-focus">
          <p class="ws-empty">
            {{ projects.length === 0 ? t('workspace.noProject') : t('workspace.focusEmpty') }}
          </p>
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
.ws-root {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--cs-bg);
  color: var(--cs-text);
}

.ws-offline {
  flex: none;
  margin: 0;
  padding: 6px 20px;
  font-size: 12px;
  color: var(--cs-amber-text);
  background: var(--cs-amber-soft);
  border-bottom: 1px solid var(--cs-amber-line);
}

.ws-settings {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.ws-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
}

/* ── Focus zone: the column deck ──────────────────────────────────────── */
.ws-focus {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--cs-inset);
}

.ws-deck {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
}

.ws-col {
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.ws-col + .ws-col {
  border-left: 1px solid var(--cs-line);
}

/* ── Draft column ─────────────────────────────────────────────────────── */
.ws-draft-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 16px;
}

.ws-draft {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 560px;
  width: 100%;
  margin: 48px auto 24px;
  padding: 18px 20px;
  border: 1px solid var(--cs-line-2);
  border-radius: 12px;
  background: var(--cs-surface);
}

.ws-draft-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.ws-draft-title {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: 14.5px;
  font-weight: 700;
  color: var(--cs-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ws-draft-project {
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--cs-ghost);
}

.ws-draft-close {
  flex: none;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-family: inherit;
  line-height: 1;
  border: none;
  border-radius: 7px;
  background: transparent;
  color: var(--cs-muted);
  cursor: pointer;
}

.ws-draft-close:hover {
  background: var(--cs-hover);
  color: var(--cs-text);
}

.ws-draft-modes {
  display: inline-flex;
  border: 1px solid var(--cs-line-2);
  border-radius: 8px;
  overflow: hidden;
  align-self: flex-start;
}

.ws-draft-mode {
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  padding: 5px 11px;
  border: none;
  background: var(--cs-surface);
  color: var(--cs-muted);
  cursor: pointer;
}

.ws-draft-mode + .ws-draft-mode {
  border-left: 1px solid var(--cs-line-2);
}

/* The chosen mode is a state: green soft wash, per the doctrine. */
.ws-draft-mode--on {
  background: var(--cs-green-soft);
  color: var(--cs-text);
  cursor: default;
}

.ws-draft-warning {
  margin: 0;
  font-size: 12.5px;
  color: var(--cs-amber-text);
  border: 1px solid var(--cs-amber-line);
  border-radius: 8px;
  background: var(--cs-amber-soft);
  padding: 6px 10px;
}

.ws-draft-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

/* Branch chips: the base to fork from, or the branch worked on (+ target). */
.ws-draft-chip {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--cs-text-2);
  padding: 2px 9px;
  border: 1px solid var(--cs-line-2);
  border-radius: 999px;
  background: var(--cs-inset);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Forge board ──────────────────────────────────────────────────────── */
.ws-forge-board {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* ── Empty focus ──────────────────────────────────────────────────────── */
.ws-empty-focus {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.ws-empty {
  margin: 0;
  text-align: center;
  font-size: 13px;
  color: var(--cs-muted);
  max-width: 380px;
}

/* ── Review ───────────────────────────────────────────────────────────── */
.ws-review {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 24px 60px;
}

.ws-review-back {
  margin-bottom: 12px;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--cs-line-2);
  background: var(--cs-surface);
  color: var(--cs-text-2);
  cursor: pointer;
}

.ws-review-back:hover {
  border-color: var(--cs-muted);
}

/* Narrow desk: the projects column folds first, then the queue narrows. */
@media (max-width: 1100px) {
  .ws-body :deep(.wq-root) {
    width: 360px;
  }
}
</style>
