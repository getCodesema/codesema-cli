<script setup lang="ts">
// Workspace shell: a global 52px header (search, attention bell, agents
// counter), the projects column on the left, the conversations column in the
// center-left, and the focus zone on the right. The focus zone shows ONE
// thing at a time, named by a single FocusView value (useWorkspaceNav, pure)
// rather than deduced from several independent refs. Owns the single
// useTasks stream; every child stays presentational and derives from pure
// functions.
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useForgePrefs } from '../composables/useForgePrefs'
import { EMPTY_ISSUES_STATE, useIssues } from '../composables/useIssues'
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
import {
  closeReview,
  openConversation as conversationView,
  draftBranch,
  draftKey,
  EMPTY_FOCUS,
  focusFromBranchResolution,
  forkDraft,
  promoteDraft,
  openReview as reviewView,
  scratchDraft,
  workonDraft,
  type DraftTarget,
  type FocusView,
} from '../composables/useWorkspaceNav'
import { t } from '../i18n'
import type { AgentOption, ForgeMr, ReviewRecord } from '../types'
import ConversationsColumn from './conversations/ConversationsColumn.vue'
import ForgeBoard from './forge/ForgeBoard.vue'
import ForgeControlsPanel from './forge/ForgeControlsPanel.vue'
import {
  FORGE_CONTROLS_WIDTH_DEFAULT,
  FORGE_CONTROLS_WIDTH_MAX,
  FORGE_CONTROLS_WIDTH_MIN,
} from './forge/ForgePrefs'
import ForgeSplitter from './forge/ForgeSplitter.vue'
import ProjectsNav from './ProjectsNav.vue'
import RepoSettings from './RepoSettings.vue'
import ReviewShell from './ReviewShell.vue'
import TaskComposer from './TaskComposer.vue'
import TaskConversation from './TaskConversation.vue'
import WorkspaceHeader from './WorkspaceHeader.vue'

const props = defineProps<{ token: string }>()

const {
  store,
  states,
  connected,
  connections,
  projects,
  mrsByProject,
  mrsOf,
  mrsLoadOf,
  loadMrsState,
  branchesByProject,
  start,
  stop,
  hydrate,
  create,
  reply,
  attach,
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
const projectKindById = computed(
  () => new Map(projects.value.map((project) => [project.id, project.kind])),
)
// The attach picker's options: every registered repo, for every scratch
// conversation alike, never scoped to one conversation's own attachments.
const repoProjects = computed(() => projects.value.filter((project) => project.kind === 'repo'))

/** The scratch project, which the server synthesizes on every read of
 * GET /api/projects — null only before that first read has landed. */
const scratchProjectId = computed(
  () => projects.value.find((project) => project.kind === 'scratch')?.id ?? null,
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

// ── Focus zone: one view at a time ───────────────────────────────────────
const focus = ref<FocusView>(EMPTY_FOCUS)

/** The open item, for the lists that tint their selected row. At most one. */
const focusedKeys = computed<string[]>(() => {
  const view = focus.value
  if (view.kind === 'conversation') {
    return [taskKey(view.projectId, view.taskId)]
  }
  if (view.kind === 'draft') {
    return [draftKey(view.projectId, view.draft)]
  }
  return []
})

/** What the focus zone renders: the conversation with its live state (a
 * stale id renders nothing rather than an empty shell), or the draft
 * composer. Flattened here so the template stays cast-free. */
type FocusEntry =
  | { kind: 'task'; key: string; projectId: string; taskId: string; state: TaskState }
  | { kind: 'draft'; key: string; projectId: string; draft: DraftTarget }

const focusEntry = computed<FocusEntry | null>(() => {
  const view = focus.value
  if (view.kind === 'conversation') {
    const key = taskKey(view.projectId, view.taskId)
    const state = store.get(key)
    return state
      ? { kind: 'task', key, projectId: view.projectId, taskId: view.taskId, state }
      : null
  }
  if (view.kind === 'draft') {
    return {
      kind: 'draft',
      key: draftKey(view.projectId, view.draft),
      projectId: view.projectId,
      draft: view.draft,
    }
  }
  return null
})

/** Narrowed halves of `focusEntry`: the template needs a value it can
 * v-if on directly, since a discriminant read off a computed does not
 * narrow the computed itself for the accesses that follow. */
const taskEntry = computed(() => {
  const entry = focusEntry.value
  return entry !== null && entry.kind === 'task' ? entry : null
})

const draftEntry = computed(() => {
  const entry = focusEntry.value
  return entry !== null && entry.kind === 'draft' ? entry : null
})

/** Every prop of the open conversation, bound in one object (the shape
 * ProjectsNav already uses below): the per-action closures capture the ids
 * once here, where the entry is narrowed, instead of in template callbacks
 * that would each have to re-check it. */
const conversationProps = computed(() => {
  const entry = taskEntry.value
  if (entry === null) {
    return null
  }
  const { projectId, taskId, key, state } = entry
  return {
    key,
    state,
    projectName: projectNameById.value.get(projectId) ?? projectId,
    projectKind: projectKindById.value.get(projectId) ?? 'repo',
    repoProjects: repoProjects.value,
    reply: (message: string) => reply(projectId, taskId, message),
    attach: (repoProjectId: string) => attach(projectId, taskId, repoProjectId),
    interrupt: () => interrupt(projectId, taskId),
    resume: () => resume(projectId, taskId),
    ship: () => ship(projectId, taskId),
    abandon: () => abandon(projectId, taskId),
    runChecks: () => runChecks(projectId, taskId),
    loadChecks: () => hydrateChecks(projectId, taskId),
    checksSetup: checksSetup.get(projectId),
    loadChecksSetup: () => loadChecksSetup(projectId),
    runChecksSetup: () => runChecksSetup(projectId),
    applyChecksProposal: () => applyChecksProposal(projectId),
    dismissChecksProposal: () => dismissChecksProposal(projectId),
  }
})

/** The draft handlers the template binds: reading `draftEntry` here rather
 * than closing over it in the template keeps every callback narrowed. */
function onFocusDraftClose(): void {
  const entry = draftEntry.value
  if (entry) {
    closeDraft(entry.projectId, entry.draft)
  }
}

function onFocusToggleDraftMode(): void {
  const entry = draftEntry.value
  if (entry) {
    toggleDraftMode(entry.projectId, entry.draft)
  }
}

function onFocusDraftCreate(input: CreateTaskInput): void {
  const entry = draftEntry.value
  if (entry) {
    void onDraftCreate(entry.projectId, entry.draft, input)
  }
}

function onFocusPlanInput(input: PlanComposerInput): void {
  const entry = draftEntry.value
  if (entry) {
    onPlanInput(entry.projectId, entry.draft, input)
  }
}

function onFocusDraftRetarget(branch: string, prompt: string): void {
  const entry = draftEntry.value
  if (entry) {
    onDraftRetarget(entry.projectId, entry.draft, branch, prompt)
  }
}

/** The project the focus zone belongs to, null when it belongs to none. */
const focusProjectId = computed<string | null>(() => {
  const view = focus.value
  if (view.kind === 'conversation' || view.kind === 'draft' || view.kind === 'repository') {
    return view.projectId
  }
  return null
})

function openConversation(projectId: string, taskId: string): void {
  focus.value = conversationView(projectId, taskId)
  void hydrate(projectId, taskId)
}

// Events emitted while the stream was down are not replayed: re-hydrate the
// open conversation on each reconnect (a draft has nothing to fetch).
watch(connections, () => {
  const view = focus.value
  if (view.kind === 'conversation') {
    void hydrate(view.projectId, view.taskId)
  }
})

// ── Draft: an empty composer in scratch, fork or work-on mode ─────────────
type DraftRun = { creating: boolean; error: string | null }

/** Per-column create state, keyed by the draft column's identity. */
const draftRuns = reactive(new Map<string, DraftRun>())

function runOf(projectId: string, draft: DraftTarget): DraftRun {
  return draftRuns.get(draftKey(projectId, draft)) ?? { creating: false, error: null }
}

// ── T2.6: the plan of what a draft WOULD create ───────────────────────────
//
// The machinery (debounce, per-column run token, the states themselves) lives
// in useTaskPlan.ts: this component cannot be mounted in a test — its setup
// builds `useTasks` — so a rule kept HERE is a rule nothing exercises. All
// that is left in the view is the mapping from a column to its key.
const planRequests = createPlanRequests((body) => preview(body))

function planOf(projectId: string, draft: DraftTarget): DraftPlan {
  return planRequests.planOf(draftKey(projectId, draft))
}

/**
 * Asks the server what this draft would create. NEVER a creation: the route
 * it calls writes nothing at all, so a human typing in the composer costs
 * reads and nothing else.
 */
function onPlanInput(projectId: string, draft: DraftTarget, input: PlanComposerInput): void {
  planRequests.request(
    draftKey(projectId, draft),
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
  const from = draftKey(projectId, draft)
  planRequests.forget(from)
  draftRuns.delete(from)
  focus.value = { kind: 'draft', projectId, draft: next }
  planRequests.carry(draftKey(projectId, next), prompt)
}

function openDraft(projectId: string, draft: DraftTarget): void {
  focus.value = { kind: 'draft', projectId, draft }
  draftRuns.delete(draftKey(projectId, draft))
  planRequests.forget(draftKey(projectId, draft))
}

/** The draft's mode switch: work-on <-> fork-from, same column slot. When
 * flipping to work-on, an open MR of the branch contributes its target. */
function toggleDraftMode(projectId: string, draft: DraftTarget): void {
  const branch = draftBranch(draft)
  if (branch === null) {
    return
  }
  const other =
    draft.mode === 'fork'
      ? workonDraft(
          branch,
          (mrsByProject.get(projectId) ?? []).find((m) => m.sourceBranch === branch)
            ?.targetBranch ?? null,
        )
      : forkDraft(branch)
  draftRuns.delete(draftKey(projectId, draft))
  planRequests.forget(draftKey(projectId, draft))
  focus.value = { kind: 'draft', projectId, draft: other }
}

function closeDraft(projectId: string, draft: DraftTarget): void {
  draftRuns.delete(draftKey(projectId, draft))
  planRequests.forget(draftKey(projectId, draft))
  focus.value = EMPTY_FOCUS
}

/** Every branch/MR click of the projects column routes through the pure
 * resolveBranchClick: open the branch's active conversation, or draft. */
function onBranchClick(projectId: string, branch: string, mr: ForgeMr | null): void {
  const projectStates = states.value.filter((state) => state.projectId === projectId)
  const next = focusFromBranchResolution(projectId, resolveBranchClick(branch, mr, projectStates))
  if (next.kind === 'conversation') {
    openConversation(next.projectId, next.taskId)
    return
  }
  if (next.kind === 'draft') {
    openDraft(next.projectId, next.draft)
  }
}

/**
 * [+ new conversation]: always the repo-less scratch project, never a
 * repository and never a guessed base. A conversation that has not been
 * given any code costs no branch and no worktree, and the repository it
 * ends up needing is attached from the conversation itself once it exists.
 * Deriving a target from the filtered project is what used to open every
 * new conversation on a fork of that repo's current branch.
 */
function onNewConversation(): void {
  const projectId = scratchProjectId.value
  if (projectId === null) {
    return
  }
  openDraft(projectId, scratchDraft())
}

/** A scratch draft names NO repository, so it sends neither base nor branch:
 * POST /api/tasks answers 400 on either one for a repo-less project. */
function draftPayload(draft: DraftTarget, input: CreateTaskInput): CreateTaskInput {
  if (draft.mode === 'scratch') {
    return input
  }
  return draft.mode === 'fork'
    ? { ...input, base: draft.base }
    : { ...input, branch: draft.branch, ...(draft.target !== null && { target: draft.target }) }
}

/** Launches the real conversation from the draft: the POST carries base
 * (fork) or branch+target (work-on), or neither for a scratch draft; on
 * success — or on the 409 "already has a conversation" — the focus zone
 * becomes that conversation IN PLACE. */
async function onDraftCreate(
  projectId: string,
  draft: DraftTarget,
  input: CreateTaskInput,
): Promise<void> {
  const key = draftKey(projectId, draft)
  if (draftRuns.get(key)?.creating) {
    return
  }
  draftRuns.set(key, { creating: true, error: null })
  const payload: CreateTaskInput = draftPayload(draft, input)
  const result = await create(projectId, payload)
  if (!result.ok) {
    if (result.existingTaskId !== null) {
      // 409 uniqueness guard: the branch's ACTIVE conversation takes the slot.
      draftRuns.delete(key)
      focus.value = promoteDraft(focus.value, result.existingTaskId)
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
  focus.value = promoteDraft(focus.value, result.record.id)
  void hydrate(projectId, result.record.id)
}

// ── Review view: full screen over the focus zone only ─────────────────────
const reviewRecord = computed(() => (focus.value.kind === 'review' ? focus.value.record : null))

function openReview(record: ReviewRecord): void {
  focus.value = reviewView(record, focus.value)
}

function backFromReview(): void {
  // The view underneath was carried along: closing lands back on it.
  focus.value = closeReview(focus.value)
}

/**
 * Mirrors the forge board's own `v-else-if` below exactly: the board takes
 * the full width of the desk only in the one focus-zone branch it actually
 * renders in, since review and the deck both take priority over it, same as
 * in the template. The work queue hides for exactly this branch and
 * reappears everywhere else.
 *
 * It also decides WHERE the project menu is mounted. With the board up the
 * desk is three columns, not four: the menu moves into the head of the
 * board's rail, so navigation and controls share one column (this mirrors
 * the reference interface, whose left rail carries its filter accordions).
 * Everywhere else the menu is the desk's own left column, as before.
 */
const boardVisible = computed(
  () =>
    reviewRecord.value === null &&
    focusEntry.value === null &&
    filter.value !== null &&
    projects.value.length > 0,
)

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
  // Its store states are gone: drop its filter and its open view too.
  if (filter.value === id) {
    filter.value = null
  }
  if (focusProjectId.value === id) {
    focus.value = EMPTY_FOCUS
  }
}

// ── The permanent left rail ───────────────────────────────────────────────
// The rail is on screen at all times: it carries the project menu whether or
// not a board is up, and grows its filter sections only when one is. That
// permanence is the point. When the menu was mounted inside the board it
// moved and resized the instant a project was picked, so the screen jumped
// under the pointer for what is supposed to be a plain navigation click.
const {
  prefs: forgePrefs,
  activeSection,
  railWidth,
  railCollapsed,
  listWidth,
  issuesSort,
  mrsSort,
  mrsStateFilter,
  mrsDraftOnly,
  railPanelWidth,
  toggleIssueLabel,
  toggleMrLabel,
  clearIssueFilters,
  clearMrFilters,
} = useForgePrefs()

/** True only while the rail's handle is under the pointer. The width
 * transition is switched off for exactly that window: animating a width that
 * is being rewritten every frame makes the rail lag behind the cursor. Every
 * OTHER width change -- collapsing with the button, the keyboard step -- is a
 * jump from one width to another, and those animate. */
const railDragging = ref(false)

/** The rail's collapsed band needs something to name itself with. With a
 * project selected that is the project; with none it is the menu's own
 * label, never an empty band. */
const railLabel = computed(() =>
  filter.value === null
    ? t('workspace.projectLabel')
    : (projectNameById.value.get(filter.value) ?? filter.value),
)

// The forge data the rail's sections read. They are only rendered when a
// board is up, but the props are always bound, so these fall back to the
// same empty values the composables use rather than to invented ones.
const railIssuesState = computed(() =>
  filter.value === null ? EMPTY_ISSUES_STATE : issues.stateOf(filter.value),
)
const railMrs = computed(() =>
  filter.value === null ? [] : mrsOf(filter.value, mrsStateFilter.value),
)
const railMrsState = computed(() =>
  filter.value === null ? null : mrsLoadOf(filter.value, mrsStateFilter.value),
)

// Fetching the chosen state is lazy and idempotent: `loadMrsState` is a
// no-op for a pair already loaded or in flight, so firing it on every change
// of project OR state costs one request per pair and never a duplicate.
watch(
  [filter, mrsStateFilter],
  ([projectId, state]) => {
    if (projectId !== null) {
      loadMrsState(projectId, state)
    }
  },
  { immediate: true },
)

// ── The project menu's bindings, grouped ──────────────────────────────────
// The menu is mounted in one of two places depending on `boardVisible` (the
// desk's own left column, or the head of the board's rail). Grouping its ten
// props and seven handlers here keeps that a one-line mount on each side:
// spelling all seventeen out twice would mean every future prop has to be
// added in two places, and the day someone updates only one of them the two
// mounts drift apart silently.
const projectsNavProps = computed(() => ({
  projects: projects.value,
  selected: filter.value,
  activity: activity.value,
  tree: tree.value,
  extraBranches: extraBranches.value,
  focusedKeys: focusedKeys.value,
  addBusy: addBusy.value,
  addError: addError.value,
  removeError: removeError.value,
  candidates: candidates.value,
}))

const projectsNavHandlers = {
  select: selectFilter,
  add: onAddProject,
  remove: onRemoveProject,
  discover: () => void discoverCandidates(),
  'refresh-mrs': () => void refreshMrs(),
  'open-task': (state: { projectId: string; record: { id: string } }) =>
    openConversation(state.projectId, state.record.id),
  'branch-click': ({
    projectId,
    branch,
    mr,
  }: {
    projectId: string
    branch: string
    mr: ForgeMr | null
  }) => onBranchClick(projectId, branch, mr),
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
      <!-- The permanent left rail. It is on screen at all times and always
           looks the same: the project menu sits in its head, and the board's
           filter sections appear underneath only when a board is up. Picking
           a project therefore adds sections below the menu instead of moving
           or resizing the menu itself. -->
      <aside
        class="ws-rail"
        :class="{ 'ws-rail--dragging': railDragging }"
        :style="{ '--ws-rail-w': `${railPanelWidth}px` }"
      >
        <ForgeControlsPanel
          :has-board="boardVisible"
          :active-section="activeSection"
          :collapsed="railCollapsed"
          :project-name="railLabel"
          :issues-state="railIssuesState"
          :issues-sort="issuesSort"
          :issues-labels="forgePrefs.issuesLabels"
          :mrs="railMrs"
          :mrs-state="railMrsState"
          :mrs-sort="mrsSort"
          :mrs-state-filter="mrsStateFilter"
          :mrs-draft-only="mrsDraftOnly"
          :mrs-labels="forgePrefs.mrsLabels"
          @update:active-section="(v) => (activeSection = v)"
          @update:collapsed="(v) => (railCollapsed = v)"
          @update:issues-sort="(v) => (issuesSort = v)"
          @update:mrs-sort="(v) => (mrsSort = v)"
          @update:mrs-state-filter="(v) => (mrsStateFilter = v)"
          @update:mrs-draft-only="(v) => (mrsDraftOnly = v)"
          @toggle-issue-label="toggleIssueLabel"
          @toggle-mr-label="toggleMrLabel"
        >
          <template #top>
            <ProjectsNav v-bind="projectsNavProps" v-on="projectsNavHandlers" />
          </template>
        </ForgeControlsPanel>
      </aside>

      <ForgeSplitter
        v-if="!railCollapsed"
        :model-value="railWidth"
        :min="FORGE_CONTROLS_WIDTH_MIN"
        :max="FORGE_CONTROLS_WIDTH_MAX"
        :default-width="FORGE_CONTROLS_WIDTH_DEFAULT"
        :ariaLabel="t('forge.resizeControlsAria')"
        @update:model-value="(v) => (railWidth = v)"
        @update:dragging="(v) => (railDragging = v)"
      />

      <!-- Hidden while the forge board is the focus zone's content: the
           board then takes the full remaining width (rail / list / detail,
           three columns). -->
      <ConversationsColumn
        v-if="!boardVisible"
        :states="queueStates"
        :project-names="projectNameById"
        :focused-keys="focusedKeys"
        @select="(state) => openConversation(state.projectId, state.record.id)"
        @create="onNewConversation"
      />

      <main class="ws-focus">
        <!-- Review view: the existing guided review, over the focus zone. -->
        <div v-if="reviewRecord" class="ws-review">
          <button class="ws-review-back" @click="backFromReview">{{ t('workspace.back') }}</button>
          <ReviewShell :record="reviewRecord" />
        </div>

        <!-- The focus zone: one conversation, or one draft composer. -->
        <div v-else-if="focusEntry" class="ws-deck">
          <div class="ws-col">
            <TaskConversation
              v-if="conversationProps"
              v-bind="conversationProps"
              @open-review="openReview"
            />

            <!-- Draft: a composer with no repository at all (scratch), or in
                 fork mode (a new branch from a base), or in work-on mode
                 (directly on an existing branch); the create turns this into
                 the real conversation, in place. -->
            <div v-else-if="draftEntry" class="ws-draft-wrap">
              <div class="ws-draft">
                <header class="ws-draft-head">
                  <h2 class="ws-draft-title">
                    {{
                      draftEntry.draft.mode === 'scratch'
                        ? t('workspace.draftScratchTitle')
                        : draftEntry.draft.mode === 'fork'
                          ? t('workspace.draftForkTitle', { base: draftEntry.draft.base })
                          : t('workspace.draftWorkonTitle', { branch: draftEntry.draft.branch })
                    }}
                  </h2>
                  <span class="ws-draft-project">
                    {{ projectNameById.get(draftEntry.projectId) ?? draftEntry.projectId }}
                  </span>
                  <button
                    class="ws-draft-close"
                    :aria-label="t('workspace.addProjectCancel')"
                    :title="t('workspace.addProjectCancel')"
                    @click="onFocusDraftClose"
                  >
                    ✕
                  </button>
                </header>
                <!-- No repository at all: neither a work-on/fork mode nor a
                     branch/base chip means anything, so this scratch draft
                     shows none of it (only the composer's own sober notice). -->
                <div
                  v-if="draftEntry.draft.mode !== 'scratch'"
                  class="ws-draft-modes"
                  role="group"
                  :aria-label="t('workspace.draftModeLabel')"
                >
                  <button
                    class="ws-draft-mode"
                    :class="{ 'ws-draft-mode--on': draftEntry.draft.mode === 'workon' }"
                    type="button"
                    @click="draftEntry.draft.mode === 'fork' && onFocusToggleDraftMode()"
                  >
                    {{ t('workspace.draftModeWorkon') }}
                  </button>
                  <button
                    class="ws-draft-mode"
                    :class="{ 'ws-draft-mode--on': draftEntry.draft.mode === 'fork' }"
                    type="button"
                    @click="draftEntry.draft.mode === 'workon' && onFocusToggleDraftMode()"
                  >
                    {{ t('workspace.draftModeFork') }}
                  </button>
                </div>
                <p
                  v-if="
                    draftEntry.draft.mode === 'workon' && isTrunkBranch(draftEntry.draft.branch)
                  "
                  class="ws-draft-warning"
                >
                  {{ t('workspace.draftTrunkWarning', { branch: draftEntry.draft.branch }) }}
                </p>
                <div v-if="draftEntry.draft.mode !== 'scratch'" class="ws-draft-chips">
                  <span
                    class="ws-draft-chip"
                    :title="
                      draftEntry.draft.mode === 'fork'
                        ? t('workspace.draftBaseHint', { branch: draftEntry.draft.base })
                        : t('workspace.draftWorkonHint', { branch: draftEntry.draft.branch })
                    "
                  >
                    <span aria-hidden="true">⎇</span>
                    {{
                      draftEntry.draft.mode === 'fork'
                        ? draftEntry.draft.base
                        : draftEntry.draft.branch
                    }}
                  </span>
                  <!-- Work-on from an MR node: the merge target rides along. -->
                  <span
                    v-if="draftEntry.draft.mode === 'workon' && draftEntry.draft.target !== null"
                    class="ws-draft-chip"
                    :title="t('workspace.draftTargetHint', { target: draftEntry.draft.target })"
                  >
                    <span aria-hidden="true">→</span> {{ draftEntry.draft.target }}
                  </span>
                </div>
                <TaskComposer
                  compact
                  :creating="runOf(draftEntry.projectId, draftEntry.draft).creating"
                  :error="runOf(draftEntry.projectId, draftEntry.draft).error"
                  :agents="agents"
                  :current-agent="
                    isolationForProject(draftEntry.projectId, projects, workspace)?.agent ??
                    currentAgent
                  "
                  :isolation="
                    isolationForProject(draftEntry.projectId, projects, workspace)
                      ?.isolation_default ?? null
                  "
                  :project-kind="projectKindById.get(draftEntry.projectId) ?? 'repo'"
                  :draft="draftEntry.draft"
                  :plan="planOf(draftEntry.projectId, draftEntry.draft).plan"
                  :plan-error="planOf(draftEntry.projectId, draftEntry.draft).error"
                  :plan-pending="planOf(draftEntry.projectId, draftEntry.draft).pending"
                  :initial-prompt="planRequests.promptOf(draftEntry.key)"
                  @create="onFocusDraftCreate"
                  @plan-input="onFocusPlanInput"
                  @retarget="onFocusDraftRetarget"
                />
              </div>
            </div>
          </div>
        </div>

        <!-- Forge board: the selected project's open issues/MRs, in place of
             the sober empty-state once a project is actually chosen. -->
        <!-- Kept as the literal condition (not `boardVisible`, which mirrors
             it exactly for the work queue's own gate below): a computed
             boolean loses the `filter !== null` narrowing Vue's template
             compiler needs to type `filter` as `string` for the children
             below (:key, issues.stateOf, mrsByProject.get, …). -->
        <div v-else-if="filter !== null && projects.length > 0" class="ws-forge-board">
          <!-- Keyed on the project: remounts the board (and its internal
               selection/section state, not just its persisted prefs) on
               every project switch, so a detail-panel selection never
               survives into a different project's items. -->
          <ForgeBoard
            :key="filter"
            :section="activeSection"
            :issues-state="issues.stateOf(filter)"
            :issues-sort="issuesSort"
            :issues-labels="forgePrefs.issuesLabels"
            :mrs="mrsOf(filter, mrsStateFilter)"
            :mrs-state="mrsLoadOf(filter, mrsStateFilter)"
            :mrs-sort="mrsSort"
            :mrs-draft-only="mrsDraftOnly"
            :mrs-labels="forgePrefs.mrsLabels"
            :list-width="listWidth"
            @retry-issues="issues.reload(filter)"
            @clear-issue-filters="clearIssueFilters"
            @clear-mr-filters="clearMrFilters"
            @update:list-width="(v) => (listWidth = v)"
          />
        </div>

        <!-- Empty focus: a sober invite (no project selected, or none registered). -->
        <div v-else class="ws-empty-focus">
          <p class="ws-empty">
            {{ t('workspace.focusEmpty') }}
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

/* The permanent left rail. Its width is the ONE thing about it that ever
   changes, and it changes only when the user drags the handle or collapses
   it, never because a project was picked. */
.ws-rail {
  flex: 0 0 var(--ws-rail-w);
  width: var(--ws-rail-w);
  min-height: 0;
  border-right: 1px solid var(--cs-line-2);
  transition:
    flex-basis var(--cs-duration-base) var(--cs-ease-in),
    width var(--cs-duration-base) var(--cs-ease-in);
}

/* Dragging: no transition at all, or the rail trails the pointer. */
.ws-rail--dragging {
  transition: none;
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

/* The conversations column sets its own 260px width but, by its own header
   comment, leaves the flex behaviour to whoever mounts it, the same split
   ForgeBoard.vue already has with ForgeSplitter.vue. Without this the column
   would shrink under flex's default alongside the focus zone; `min-width: 0`
   on `.ws-focus` is what absorbs a narrow desk instead. */
.ws-body :deep(.cvc-root) {
  flex: none;
}
</style>
