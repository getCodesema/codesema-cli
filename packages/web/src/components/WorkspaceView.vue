<script setup lang="ts">
// Workspace shell: a global 52px header (search, attention bell, agents
// counter), the projects column on the left, the conversations column in the
// center-left, and the focus zone on the right. The focus zone shows ONE
// thing at a time, named by a single FocusView value (useWorkspaceNav, pure)
// rather than deduced from several independent refs. Owns the single
// useTasks stream; every child stays presentational and derives from pure
// functions.
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import {
  buildCodeReviewRows,
  codeReviewRowKey,
  filterCodeReviewRows,
  type CodeReviewRow,
} from '../composables/useCodeReview'
import { useForgePrefs } from '../composables/useForgePrefs'
import { useIssues } from '../composables/useIssues'
import {
  countProjectActivity,
  isolationForProject,
  isTrunkBranch,
  resolveBranchClick,
} from '../composables/useProjects'
import {
  RAIL_LIST_WIDTH_DEFAULT,
  RAIL_LIST_WIDTH_MAX,
  RAIL_LIST_WIDTH_MIN,
  readRailPrefs,
  writeRailPrefs,
} from '../composables/useRailPrefs'
import {
  buildBranchRows,
  buildRepositoryTiles,
  filterBranchRows,
  sortBranchRows,
  type BranchRow,
  type BranchSortKey,
} from '../composables/useRepository'
import { useReviewSession } from '../composables/useReviewSession'
import { agentCounts, oldestWaiting } from '../composables/useTaskBoard'
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
  openRepository,
  openReviewRun,
  openReviewTarget,
  promoteDraft,
  promoteReviewRun,
  openReview as reviewView,
  sameReviewSource,
  scratchDraft,
  switchRepoTab,
  workonDraft,
  type DraftTarget,
  type FocusView,
  type NavCategory,
  type RepoTab,
} from '../composables/useWorkspaceNav'
import { t } from '../i18n'
import type {
  AgentOption,
  ForgeMr,
  MrReviewMode,
  ReviewArchiveSummary,
  ReviewRecord,
} from '../types'
import ForgeSplitter from './forge/ForgeSplitter.vue'
import CodeReviewList from './rail/CodeReviewList.vue'
import ConversationsList from './rail/ConversationsList.vue'
import RepositoriesList from './rail/RepositoriesList.vue'
import WorkspaceNavRail from './rail/WorkspaceNavRail.vue'
import RepoSettings from './RepoSettings.vue'
import BranchTable from './repository/BranchTable.vue'
import RepositoryTiles from './repository/RepositoryTiles.vue'
import RepositoryView from './repository/RepositoryView.vue'
import ReviewTargetPanel from './review/ReviewTargetPanel.vue'
import ReviewLive from './ReviewLive.vue'
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
  worktreesByProject,
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

// ── The selected repository: what the Repository category points at ───────
// Selecting one also makes it the registry's active card, which lazily loads
// its MRs, branches and worktrees.
const filter = ref<string | null>(null)

function selectRepository(id: string): void {
  filter.value = id
  selectProject(id)
  issues.load(id)
  focus.value = openRepository(id, railPrefs.activeRepoTab)
}

// ── Header: live counters over every conversation ─────────────────────────
const counters = computed(() => agentCounts(states.value))

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

/** Every conversation, all projects: the list column groups them by project
 * and searches them itself. */
const queueStates = computed(() => states.value)

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
  const state = oldestWaiting(states.value)
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
 * the repository list uses too): the per-action closures capture the ids
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

// ── Repository list: per-project activity counters ────────────────────────
const activity = computed(() => countProjectActivity(states.value))

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

// ── Navigation rail and list column, persisted as one blob ────────────────
const railPrefs = reactive(readRailPrefs())
watch(railPrefs, (next) => writeRailPrefs({ ...next }), { deep: true })

function selectCategory(category: NavCategory): void {
  railPrefs.category = category
  if (category === 'codeReview') {
    // Lazy, and only the badges: the per-row history waits for an expand.
    for (const project of repoProjects.value) {
      if (!reviewArchives.value.has(project.id)) {
        void loadReviewArchives(project.id)
      }
    }
  }
}

type SearchableList = { focusSearch: () => void }
const conversationsList = ref<SearchableList | null>(null)
const repositoriesList = ref<SearchableList | null>(null)

/** ⌘K / Ctrl+K focuses the list column's own search — the shell owns the
 * shortcut because which list is up is the shell's own state. */
function onGlobalKeydown(e: KeyboardEvent): void {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    conversationsList.value?.focusSearch()
    repositoriesList.value?.focusSearch()
    codeReviewList.value?.focusSearch()
  }
}

onMounted(() => window.addEventListener('keydown', onGlobalKeydown))
onUnmounted(() => window.removeEventListener('keydown', onGlobalKeydown))

/** The repository the stage is showing, null when it is showing anything
 * else. Its tab rides with it so switching away and back comes back to the
 * tab that was open. */
const repositoryEntry = computed(() => (focus.value.kind === 'repository' ? focus.value : null))

function selectRepoTab(tab: RepoTab): void {
  railPrefs.activeRepoTab = tab
  focus.value = switchRepoTab(focus.value, tab)
}

// ── Code review: the cross-project list, its history, and the runner ─────
//
// The session lives here rather than in the list: the runner is process-wide
// (one review at a time), so its status and its SSE stream outlive whichever
// row or view is on screen, and survive navigating away and back.
const reviewSession = useReviewSession()

const reviewTarget = computed(() => (focus.value.kind === 'reviewTarget' ? focus.value : null))
const reviewRun = computed(() => (focus.value.kind === 'reviewRun' ? focus.value : null))

const codeReviewRows = computed<CodeReviewRow[]>(() =>
  buildCodeReviewRows({
    projects: repoProjects.value.map((project) => ({
      project,
      mrs: mrsOf(project.id, mrsStateFilter.value),
      branches: branchesByProject.get(project.id) ?? [],
      archives: reviewArchives.value.get(project.id) ?? [],
    })),
    ...(reviewSession.mrReviewStatus.value !== null && {
      running: reviewSession.mrReviewStatus.value,
    }),
  }),
)

/** Latest archive per branch, per project: feeds the row badges. */
const reviewArchives = ref(new Map<string, ReviewArchiveSummary[]>())
const reviewHistory = ref(new Map<string, ReviewArchiveSummary[]>())
const reviewHistoryErrors = ref(new Map<string, string>())
const reviewQuery = ref('')

/** Absent from BOTH maps means "never requested": the list reads that as
 * loading, which is what an expand always starts. */
function clearHistoryState(key: string): void {
  const entries = new Map(reviewHistory.value)
  const errors = new Map(reviewHistoryErrors.value)
  entries.delete(key)
  errors.delete(key)
  reviewHistory.value = entries
  reviewHistoryErrors.value = errors
}
const expandedReviewRows = ref<ReadonlySet<string>>(new Set())

async function loadReviewArchives(projectId: string): Promise<void> {
  try {
    const res = await fetch(`/api/reviews/latest?project=${encodeURIComponent(projectId)}`)
    const body = res.ok ? ((await res.json()) as { latest: ReviewArchiveSummary[] }) : null
    reviewArchives.value = new Map(reviewArchives.value).set(projectId, body?.latest ?? [])
  } catch {
    reviewArchives.value = new Map(reviewArchives.value).set(projectId, [])
  }
}

async function loadReviewHistory(row: CodeReviewRow): Promise<void> {
  const key = codeReviewRowKey(row)
  const branch = row.kind === 'mr' ? row.mr.sourceBranch : row.branch.name
  clearHistoryState(key)
  const query = `project=${encodeURIComponent(row.projectId)}&branch=${encodeURIComponent(branch)}`
  try {
    const res = await fetch(`/api/reviews?${query}`)
    if (!res.ok) {
      reviewHistoryErrors.value = new Map(reviewHistoryErrors.value).set(key, String(res.status))
      return
    }
    const body = (await res.json()) as { entries: ReviewArchiveSummary[] }
    reviewHistory.value = new Map(reviewHistory.value).set(key, body.entries)
  } catch (err) {
    reviewHistoryErrors.value = new Map(reviewHistoryErrors.value).set(key, String(err))
  }
}

function toggleReviewRow(key: string): void {
  const next = new Set(expandedReviewRows.value)
  if (next.delete(key)) {
    expandedReviewRows.value = next
    return
  }
  next.add(key)
  expandedReviewRows.value = next
  const row = codeReviewRows.value.find((candidate) => codeReviewRowKey(candidate) === key)
  if (row && !reviewHistory.value.has(key) && !reviewHistoryErrors.value.has(key)) {
    void loadReviewHistory(row)
  }
}

function openReviewTargetRow(row: CodeReviewRow): void {
  selectProject(row.projectId)
  focus.value = openReviewTarget(row.projectId, row.source)
}

async function onRunReview(mode: MrReviewMode): Promise<void> {
  const target = reviewTarget.value
  if (target === null) {
    return
  }
  reviewSession.setProjectId(target.projectId)
  const launched = await reviewSession.runReview(target.source, mode)
  if (launched) {
    focus.value = openReviewRun(target.projectId, target.source, mode, focus.value)
  }
}

async function openArchivedReview(
  projectId: string,
  branch: string,
  archiveRef: string,
): Promise<void> {
  const query = `project=${encodeURIComponent(projectId)}&branch=${encodeURIComponent(branch)}&ref=${encodeURIComponent(archiveRef)}`
  try {
    const res = await fetch(`/api/reviews/record?${query}`)
    if (res.ok) {
      openReview((await res.json()) as ReviewRecord)
    }
  } catch {
    // An unreadable archive leaves the view where it was: the list already
    // says what it could read.
  }
}

const visibleCodeReviewRows = computed(() =>
  filterCodeReviewRows(codeReviewRows.value, reviewQuery.value),
)

const codeReviewList = ref<SearchableList | null>(null)

const selectedReviewRowKey = computed<string | null>(() => {
  const view = focus.value
  if (view.kind !== 'reviewTarget' && view.kind !== 'reviewRun') {
    return null
  }
  const row = codeReviewRows.value.find(
    (candidate) =>
      candidate.projectId === view.projectId && sameReviewSource(candidate.source, view.source),
  )
  return row ? codeReviewRowKey(row) : null
})

/** The row the staged target names, for the panel's own props. Null when the
 * list has not caught up with the focus yet (a project still loading). */
const stagedReviewRow = computed<CodeReviewRow | null>(() => {
  const view = reviewTarget.value
  if (view === null) {
    return null
  }
  return (
    codeReviewRows.value.find(
      (row) => row.projectId === view.projectId && sameReviewSource(row.source, view.source),
    ) ?? null
  )
})

const reviewTargetProps = computed(() => {
  const row = stagedReviewRow.value
  if (row === null) {
    return null
  }
  const key = codeReviewRowKey(row)
  return {
    projectId: row.projectId,
    projectName: row.projectName,
    target:
      row.kind === 'mr'
        ? ({ kind: 'mr', mr: row.mr } as const)
        : ({ kind: 'branch', name: row.branch.name } as const),
    history: reviewHistory.value.get(key) ?? null,
    historyError: reviewHistoryErrors.value.get(key) ?? null,
    runStatus: reviewSession.mrReviewStatus.value,
    starting: false,
    startError: reviewSession.mrReviewStartError.value,
  }
})

function onOpenArchive(row: CodeReviewRow, archiveRef: string): void {
  const branch = row.kind === 'mr' ? row.mr.sourceBranch : row.branch.name
  void openArchivedReview(row.projectId, branch, archiveRef)
}

function onOpenArchiveFromPanel(archiveRef: string): void {
  const row = stagedReviewRow.value
  if (row) {
    onOpenArchive(row, archiveRef)
  }
}

/** The runner is process-wide: "open the running review" means whichever
 * target it is actually on, not the one being looked at. */
function onOpenRunningReview(): void {
  const status = reviewSession.mrReviewStatus.value
  if (status?.available !== true || status.phase !== 'running') {
    return
  }
  focus.value = openReviewRun(status.project_id ?? '', status.source, status.mode, focus.value)
}

// A finished run only takes the stage from the reader who was watching THAT
// run; anyone else keeps what they were looking at and learns it from the
// row's own badge.
watch(
  () => reviewSession.record.value,
  (record) => {
    const view = reviewRun.value
    if (record && view) {
      focus.value = promoteReviewRun(focus.value, view.projectId, view.source, record)
    }
  },
)

// ── The Branches tab: its own toolbar state, and the rows it derives ──────
const branchQuery = ref('')
const branchSort = ref<BranchSortKey>('status')
const expandedBranchRows = ref<ReadonlySet<string>>(new Set())

function toggleBranchRow(key: string): void {
  const next = new Set(expandedBranchRows.value)
  if (!next.delete(key)) {
    next.add(key)
  }
  expandedBranchRows.value = next
}

const repositoryRows = computed<BranchRow[]>(() => {
  const entry = repositoryEntry.value
  if (entry === null) {
    return []
  }
  return buildBranchRows({
    repoProjectId: entry.projectId,
    branches: branchesByProject.get(entry.projectId) ?? [],
    worktrees: worktreesByProject.get(entry.projectId) ?? [],
    mrs: mrsByProject.get(entry.projectId) ?? [],
    states: states.value,
  })
})

const repositoryVisibleRows = computed(() =>
  sortBranchRows(filterBranchRows(repositoryRows.value, branchQuery.value), branchSort.value),
)

const repositoryTiles = computed(() =>
  buildRepositoryTiles(repositoryRows.value, states.value, repositoryEntry.value?.projectId ?? ''),
)

/** A branch row's create action: the same routing a branch click has always
 * had (open the conversation that already holds it, else draft one). */
function onNewConversationOnRow(row: BranchRow): void {
  const entry = repositoryEntry.value
  if (entry === null || row.kind !== 'branch') {
    return
  }
  onBranchClick(entry.projectId, row.name, row.openMr)
}

// ── Forge preferences: sorts, filters and label selections of the two
// forge tabs, plus the collapse state of their controls rail (now inside the
// repository view, no longer a column of the desk). ───────────────────────
const {
  prefs: forgePrefs,
  railWidth,
  railCollapsed,
  listWidth,
  issuesSort,
  mrsSort,
  mrsStateFilter,
  mrsDraftOnly,
  toggleIssueLabel,
  toggleMrLabel,
  clearIssueFilters,
  clearMrFilters,
} = useForgePrefs()

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
</script>

<template>
  <div class="ws-root">
    <WorkspaceHeader
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
      <WorkspaceNavRail
        :category="railPrefs.category"
        :collapsed="railPrefs.navCollapsed"
        :needs-you="counters.needsYou"
        @update:category="selectCategory"
        @update:collapsed="(v) => (railPrefs.navCollapsed = v)"
        @settings="toggleSettings"
      />

      <aside class="ws-list" :style="{ '--ws-list-w': `${railPrefs.listWidth}px` }">
        <ConversationsList
          v-if="railPrefs.category === 'conversations'"
          ref="conversationsList"
          :states="queueStates"
          :project-names="projectNameById"
          :focused-keys="focusedKeys"
          @select="(state) => openConversation(state.projectId, state.record.id)"
          @create="onNewConversation"
        />
        <CodeReviewList
          v-else-if="railPrefs.category === 'codeReview'"
          ref="codeReviewList"
          :rows="codeReviewRows"
          :visible-rows="visibleCodeReviewRows"
          :query="reviewQuery"
          :running="reviewSession.mrReviewStatus.value"
          :selected-key="selectedReviewRowKey"
          :expanded="expandedReviewRows"
          :history="reviewHistory"
          :history-errors="reviewHistoryErrors"
          @update:query="(v: string) => (reviewQuery = v)"
          @select="openReviewTargetRow"
          @toggle-expanded="toggleReviewRow"
          @open-archive="onOpenArchive"
        />
        <RepositoriesList
          v-else
          ref="repositoriesList"
          :projects="repoProjects"
          :selected="filter"
          :activity="activity"
          :add-busy="addBusy"
          :add-error="addError"
          :remove-error="removeError"
          :candidates="candidates"
          @select="selectRepository"
          @add="onAddProject"
          @remove="onRemoveProject"
          @discover="() => void discoverCandidates()"
        />
      </aside>

      <ForgeSplitter
        :model-value="railPrefs.listWidth"
        :min="RAIL_LIST_WIDTH_MIN"
        :max="RAIL_LIST_WIDTH_MAX"
        :default-width="RAIL_LIST_WIDTH_DEFAULT"
        :ariaLabel="t('rail.resizeAria')"
        @update:model-value="(v: number) => (railPrefs.listWidth = v)"
      />

      <main class="ws-focus">
        <!-- Review view: the existing guided review, over the focus zone. -->
        <div v-if="reviewRecord" class="ws-review">
          <button class="ws-review-back" @click="backFromReview">{{ t('workspace.back') }}</button>
          <ReviewShell :record="reviewRecord" />
        </div>

        <!-- The focus zone: one conversation, or one draft composer. -->
        <div v-else-if="focusEntry" class="ws-stage">
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
                v-if="draftEntry.draft.mode === 'workon' && isTrunkBranch(draftEntry.draft.branch)"
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

        <!-- A repository's own view: its branches and worktrees, its issues
             and its merge requests, under one tab bar. Keyed on the project
             so switching repositories remounts the forge board's internal
             selection instead of carrying it into another repository's
             items. -->
        <RepositoryView
          v-else-if="repositoryEntry"
          :key="repositoryEntry.projectId"
          :project-name="
            projectNameById.get(repositoryEntry.projectId) ?? repositoryEntry.projectId
          "
          :tab="repositoryEntry.tab"
          :controls-collapsed="railCollapsed"
          :controls-width="railWidth"
          :issues-state="issues.stateOf(repositoryEntry.projectId)"
          :issues-sort="issuesSort"
          :issues-labels="forgePrefs.issuesLabels"
          :mrs="mrsOf(repositoryEntry.projectId, mrsStateFilter)"
          :mrs-state="mrsLoadOf(repositoryEntry.projectId, mrsStateFilter)"
          :mrs-sort="mrsSort"
          :mrs-state-filter="mrsStateFilter"
          :mrs-draft-only="mrsDraftOnly"
          :mrs-labels="forgePrefs.mrsLabels"
          :list-width="listWidth"
          @update:tab="selectRepoTab"
          @update:controls-collapsed="(v: boolean) => (railCollapsed = v)"
          @update:controls-width="(v: number) => (railWidth = v)"
          @update:issues-sort="(v) => (issuesSort = v)"
          @update:mrs-sort="(v) => (mrsSort = v)"
          @update:mrs-state-filter="(v) => (mrsStateFilter = v)"
          @update:mrs-draft-only="(v) => (mrsDraftOnly = v)"
          @update:list-width="(v: number) => (listWidth = v)"
          @toggle-issue-label="toggleIssueLabel"
          @toggle-mr-label="toggleMrLabel"
          @retry-issues="issues.reload(repositoryEntry.projectId)"
          @clear-issue-filters="clearIssueFilters"
          @clear-mr-filters="clearMrFilters"
        >
          <template #branches>
            <RepositoryTiles :tiles="repositoryTiles" />
            <BranchTable
              :rows="repositoryRows"
              :project-names="projectNameById"
              :visible-rows="repositoryVisibleRows"
              :query="branchQuery"
              :sort="branchSort"
              :expanded="expandedBranchRows"
              :loading="false"
              @update:query="(v: string) => (branchQuery = v)"
              @update:sort="(v: BranchSortKey) => (branchSort = v)"
              @refresh="() => void refreshMrs()"
              @toggle-expanded="toggleBranchRow"
              @open-conversation="(state) => openConversation(state.projectId, state.record.id)"
              @new-conversation="onNewConversationOnRow"
            />
          </template>
        </RepositoryView>

        <!-- A live review: the run is process-wide, so this branch renders
             whatever the session is streaming, whichever row started it. -->
        <ReviewLive
          v-else-if="reviewRun && reviewSession.status.value"
          :status="reviewSession.status.value"
          :partial="reviewSession.partial.value"
          :partial-b="reviewSession.partialB.value"
          :judge="reviewSession.judge.value"
        />

        <!-- A review target: its detail, its launch controls, its archives. -->
        <ReviewTargetPanel
          v-else-if="reviewTargetProps"
          v-bind="reviewTargetProps"
          @run="onRunReview"
          @open-archive="onOpenArchiveFromPanel"
          @open-running="onOpenRunningReview"
          @close="focus = EMPTY_FOCUS"
        />

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

/* Zone 2: the list column. The nav rail (zone 1) sizes itself; this one is
   dragged, so its width is the one layout value the desk owns. */
.ws-list {
  flex: 0 0 var(--ws-list-w);
  width: var(--ws-list-w);
  min-height: 0;
  min-width: 0;
  display: flex;
  border-right: 1px solid var(--cs-line-2);
}

/* ── Zone 3: the stage ────────────────────────────────────────────────── */
.ws-focus {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--cs-inset);
}

.ws-stage {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* ── Draft panel ──────────────────────────────────────────────────────── */
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

/* Both list components fill the column the desk gives them; `min-width: 0`
   on `.ws-focus` is what absorbs a narrow desk instead of squeezing them. */
.ws-list > * {
  flex: 1;
  min-width: 0;
}
</style>
