// Client of the multi-project task workspace API: the global project registry
// (/api/projects), ONE EventSource on /api/tasks/events for every conversation
// of every repo (the server caps SSE clients, a stream per task would blow
// through it), a Map of task states keyed by (project_id, task_id), and the
// token-guarded mutations. Streamed text deltas live only here — they are
// never persisted server-side. The active project (the selected card of the
// right panel) is a localStorage-persisted single id; on first load the API's
// `current` (or the first registered project) seeds it (see
// deriveActiveProject). Open MRs are fetched LAZILY, when a card becomes
// active — the tree is their only consumer and it renders the active project
// alone — and cached per project id so switching back is instant.

import { computed, reactive, ref, type Ref } from 'vue'
import type {
  DiscoverResponse,
  ForgeMr,
  ForgeMrsResult,
  LocalBranch,
  Project,
  ProjectCandidate,
  ProjectsResponse,
  TaskChecks,
  TaskEnvelope,
  TaskEvent,
  TaskRecord,
  WorkspaceInfo,
} from '../types'
import {
  IDLE_CHECKS_SETUP,
  mergeChecksSetup,
  parseChecksSetup,
  type ChecksSetupState,
} from './useChecks'
import {
  deriveActiveProject,
  persistActiveProject,
  purgeDeadStorageKeys,
  readPersistedActiveProject,
} from './useProjects'
import { compareByActivity, mergeEvent, streamsLiveText } from './useTaskBoard'

export type TaskState = {
  /** Registry id of the repo this task lives in. */
  projectId: string
  record: TaskRecord
  /** Journal events seen so far; complete only after hydrate(projectId, id). */
  events: TaskEvent[]
  /** Cumulative streamed text of the in-flight turn (SSE only, volatile). */
  liveText: string
  /** Live token meter of the in-flight turn (task_meta frames, volatile). */
  liveTokens: number
  /** Sandboxed checks result (volatile mirror of checks.json): hydrated by
   * GET /api/tasks/:id/checks on demand, updated by 'task_checks' frames.
   * Null until either happened — which is NOT proof no checks ever ran. */
  checks: TaskChecks | null
}

export type ApiResult = { ok: true } | { ok: false; status: number; error: string }

export type CreateTaskInput = {
  title: string
  prompt: string
  autoShip: boolean
  /** Fork mode: local branch the task forks from; absent → auto-detection.
   * EXCLUSIVE with branch (the server 400s when both are sent). */
  base?: string
  /** Work-on mode: existing local branch the task works DIRECTLY on. */
  branch?: string
  /** Work-on mode only: the MR target branch, used by the server as base. */
  target?: string
}

export type CreateTaskResult =
  | { ok: true; record: TaskRecord }
  | {
      ok: false
      status: number
      error: string
      /** Set on a 409 uniqueness conflict: the branch's ACTIVE conversation.
       * The caller opens that conversation instead of showing an error. */
      existingTaskId: string | null
    }

type TaskStore = Map<string, TaskState>

/** Composite store key: task ids are only unique within one repo's store. */
export const taskKey = (projectId: string, taskId: string): string => `${projectId}/${taskId}`

function upsertRecord(store: TaskStore, projectId: string, record: TaskRecord): void {
  const current = store.get(taskKey(projectId, record.id))
  if (!current) {
    store.set(taskKey(projectId, record.id), {
      projectId,
      record,
      events: [],
      liveText: '',
      liveTokens: 0,
      checks: null,
    })
    return
  }
  const previous = current.record.status
  current.record = record
  // The stream text belongs to the turn in flight — the agent's ('running')
  // AND its automatic review ('reviewing'), which streams its own progress on
  // the same channel. Any other status settles the turn in the journal: drop
  // the volatile copy. Entering 'reviewing' drops it too, once: the agent's
  // last words are already in the journal, and leaving them under the review
  // banner until the first progress line arrives would attribute them to the
  // review.
  if (
    !streamsLiveText(record.status) ||
    (record.status === 'reviewing' && previous !== 'reviewing')
  ) {
    current.liveText = ''
  }
}

function pushEvent(store: TaskStore, projectId: string, taskId: string, event: TaskEvent): void {
  // Events for tasks we never saw a record for are dropped: the connect
  // replay always sends records first, this only skips malformed frames.
  const current = store.get(taskKey(projectId, taskId))
  if (!current) {
    return
  }
  if (event.type === 'turn_started') {
    current.liveText = ''
    current.liveTokens = 0
  }
  // The review's verdict lands as a journal card: its progress lines have
  // said everything they had to say, drop them right away rather than let
  // them linger under the card until the status frame arrives.
  if (event.type === 'review_done') {
    current.liveText = ''
  }
  mergeEvent(current.events, event)
}

function parseFrame<N extends TaskEnvelope['event']['name']>(
  e: Event,
): Extract<TaskEnvelope, { event: { name: N } }> {
  return JSON.parse((e as MessageEvent).data) as Extract<TaskEnvelope, { event: { name: N } }>
}

/** Agent-assisted checks setup, one state per PROJECT (never per task). */
type ChecksSetupStore = Map<string, ChecksSetupState>

function openStream(
  store: TaskStore,
  setups: ChecksSetupStore,
  connected: Ref<boolean>,
  connections: Ref<number>,
) {
  // The initial replay covers every task of every registered project; the
  // rail shows them all, only the right panel scopes to the active card.
  const source = new EventSource('/api/tasks/events')
  source.addEventListener('open', () => {
    connected.value = true
    connections.value++
  })
  // EventSource retries on its own; we only surface the connection state.
  source.addEventListener('error', () => {
    connected.value = false
  })
  source.addEventListener('task', (e) => {
    const envelope = parseFrame<'task'>(e)
    upsertRecord(store, envelope.project_id, envelope.event.data)
  })
  source.addEventListener('task_event', (e) => {
    const envelope = parseFrame<'task_event'>(e)
    pushEvent(store, envelope.project_id, envelope.task_id, envelope.event.data)
  })
  source.addEventListener('task_text', (e) => {
    const envelope = parseFrame<'task_text'>(e)
    const current = store.get(taskKey(envelope.project_id, envelope.task_id))
    if (current) {
      current.liveText = envelope.event.data.text
    }
  })
  source.addEventListener('task_meta', (e) => {
    const envelope = parseFrame<'task_meta'>(e)
    const current = store.get(taskKey(envelope.project_id, envelope.task_id))
    if (current) {
      current.liveTokens = envelope.event.data.tokens
    }
  })
  // Checks transitions (running → per-check update → final): each frame
  // carries the WHOLE checks.json, so replacing is always correct.
  source.addEventListener('task_checks', (e) => {
    const envelope = parseFrame<'task_checks'>(e)
    const current = store.get(taskKey(envelope.project_id, envelope.task_id))
    if (current) {
      current.checks = envelope.event.data
    }
  })
  // Agent-assisted setup: the run's progress and its final proposal. The frame
  // is project-scoped (no task_id) and its payload is parsed defensively —
  // a bare proposal object reads as "ready" just like a state envelope.
  source.addEventListener('checks_proposal', (e) => {
    const envelope = parseFrame<'checks_proposal'>(e)
    const projectId = envelope.project_id
    // Merged, not replaced: applying consumes the proposal server-side and
    // broadcasts an idle state that must not erase the local confirmation.
    setups.set(
      projectId,
      mergeChecksSetup(setups.get(projectId), parseChecksSetup(envelope.event.data)),
    )
  })
  return source
}

/**
 * Loads the current setup state of a project (idle / running / a proposal
 * waiting for validation). Any failure keeps the last known state: the setup
 * card then simply offers to run the agent.
 */
async function loadChecksSetupStore(setups: ChecksSetupStore, projectId: string): Promise<void> {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/checks-setup`)
    if (!res.ok) {
      return
    }
    setups.set(
      projectId,
      mergeChecksSetup(setups.get(projectId), parseChecksSetup(await res.json())),
    )
  } catch {
    // Local server stopped: keep the last known state.
  }
}

/** Starts the agent (read-only, a real LLM call): the proposal lands later
 * over SSE. The optimistic 'running' only survives an accepted POST. */
async function startChecksSetup(
  token: string,
  setups: ChecksSetupStore,
  projectId: string,
): Promise<ApiResult> {
  const result = await postAction(
    token,
    `/api/projects/${encodeURIComponent(projectId)}/checks-setup`,
  )
  if (result.ok) {
    const previous = setups.get(projectId) ?? IDLE_CHECKS_SETUP
    setups.set(projectId, { ...previous, status: 'running', error: null, applied: false })
  }
  return result
}

/**
 * Writes the proposal under review into the repo's .codesema/config.json —
 * the ONLY path that ever touches the file. The applied plan stays in the
 * client state so the card can confirm what was written.
 */
async function applyChecksSetup(
  token: string,
  setups: ChecksSetupStore,
  projectId: string,
): Promise<ApiResult> {
  const proposal = setups.get(projectId)?.proposal ?? null
  const result = await postAction(
    token,
    `/api/projects/${encodeURIComponent(projectId)}/checks-apply`,
  )
  if (result.ok) {
    setups.set(projectId, {
      status: 'idle',
      proposal: null,
      error: null,
      current: proposal,
      applied: true,
    })
  }
  return result
}

/**
 * Loads the persisted checks result of one task. 404 = never launched: the
 * state keeps its null without erasing anything a live frame already set.
 */
async function hydrateChecksStore(store: TaskStore, projectId: string, id: string): Promise<void> {
  try {
    const res = await fetch(
      `/api/tasks/${encodeURIComponent(id)}/checks?project=${encodeURIComponent(projectId)}`,
    )
    if (!res.ok) {
      return
    }
    const checks = (await res.json()) as TaskChecks
    const current = store.get(taskKey(projectId, id))
    if (current) {
      current.checks = checks
    }
  } catch {
    // Local server stopped: keep the last known state, the stream will retry.
  }
}

/** Loads the full journal of one task (the stream only carries live events). */
async function hydrateStore(store: TaskStore, projectId: string, id: string): Promise<void> {
  try {
    const res = await fetch(
      `/api/tasks/${encodeURIComponent(id)}?project=${encodeURIComponent(projectId)}`,
    )
    if (!res.ok) {
      return
    }
    const body = (await res.json()) as { record: TaskRecord; events: TaskEvent[] }
    upsertRecord(store, projectId, body.record)
    const current = store.get(taskKey(projectId, body.record.id))
    if (!current) {
      return
    }
    for (const event of body.events) {
      mergeEvent(current.events, event)
    }
  } catch {
    // Local server stopped: keep the last known state, the stream will retry.
  }
}

async function errorFrom(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null
  return body?.error ?? `HTTP ${res.status}`
}

const headers = (token: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-codesema-tasks-token': token,
})

async function postAction(token: string, path: string, body?: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: headers(token),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (res.ok) {
      return { ok: true }
    }
    return { ok: false, status: res.status, error: await errorFrom(res) }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

async function createTask(
  token: string,
  store: TaskStore,
  projectId: string,
  input: CreateTaskInput,
): Promise<CreateTaskResult> {
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ ...input, project_id: projectId }),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: string
        existing_task_id?: string
      } | null
      return {
        ok: false,
        status: res.status,
        error: body?.error ?? `HTTP ${res.status}`,
        // Only the 409 uniqueness guard carries the existing conversation.
        existingTaskId:
          res.status === 409 && typeof body?.existing_task_id === 'string'
            ? body.existing_task_id
            : null,
      }
    }
    const record = (await res.json()) as TaskRecord
    // The stream will broadcast it too, but upserting now makes the new
    // conversation openable without waiting for the next frame.
    upsertRecord(store, projectId, record)
    return { ok: true, record }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: e instanceof Error ? e.message : String(e),
      existingTaskId: null,
    }
  }
}

/** Scoped mutation path: every task route carries its project id. */
const actionPath = (projectId: string, id: string, action: string): string =>
  `/api/tasks/${encodeURIComponent(id)}/${action}?project=${encodeURIComponent(projectId)}`

/** DELETE /api/projects/:id — unregisters only, never touches the disk. */
async function deleteProject(token: string, id: string): Promise<ApiResult> {
  try {
    const res = await fetch(`/api/projects/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: headers(token),
    })
    if (res.ok) {
      return { ok: true }
    }
    return { ok: false, status: res.status, error: await errorFrom(res) }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Global project registry client: list, active card, add, remove. */
function useProjectRegistry(token: string, store: TaskStore) {
  const projects = ref<Project[]>([])
  // The selected card of the right panel: composer target and tree scope.
  const activeProject = ref<string | null>(null)
  // Open MRs per project id, fetched when a card becomes active and on
  // demand. A repo without a forge (or a stopped CLI) caches an empty list
  // silently: the tree then degrades to branch nodes only.
  const mrsByProject = reactive(new Map<string, ForgeMr[]>())
  // Local branches per project id, fetched alongside the MRs when a card
  // becomes active: the tree's "Branches (N)" disclosure and the draft
  // columns are the consumers. Errors cache an empty list silently.
  const branchesByProject = reactive(new Map<string, LocalBranch[]>())
  // Git repos detected around the launch directory, refreshed on demand when
  // the add-project form opens: one-click registration instead of typing paths.
  const candidates = ref<ProjectCandidate[]>([])
  // Process-wide isolation facts, answered by the same GET /api/projects.
  // Null until the first successful load (and on older CLIs that never send
  // it): the UI then claims nothing about containment.
  const workspace = ref<WorkspaceInfo | null>(null)
  // First derivation reads localStorage (and migrates the retired keys);
  // later registry reloads only re-derive when the active card disappears.
  let activeSeeded = false

  async function loadMrs(projectId: string): Promise<void> {
    try {
      const res = await fetch(`/api/mrs?project=${encodeURIComponent(projectId)}`)
      if (!res.ok) {
        mrsByProject.set(projectId, [])
        return
      }
      const body = (await res.json()) as ForgeMrsResult
      mrsByProject.set(projectId, body.available ? body.mrs : [])
    } catch {
      mrsByProject.set(projectId, [])
    }
  }

  async function loadBranches(projectId: string): Promise<void> {
    try {
      const res = await fetch(`/api/branches?project=${encodeURIComponent(projectId)}`)
      branchesByProject.set(projectId, res.ok ? ((await res.json()) as LocalBranch[]) : [])
    } catch {
      branchesByProject.set(projectId, [])
    }
  }

  /** Re-fetches the open MRs (and local branches) of the active project. */
  async function refreshMrs(): Promise<void> {
    if (activeProject.value !== null) {
      // Both feed the same tree: refresh them together.
      await Promise.all([loadMrs(activeProject.value), loadBranches(activeProject.value)])
    }
  }

  function setActive(id: string | null): void {
    activeProject.value = id
    if (id !== null) {
      persistActiveProject(id)
      // Lazy fetch policy: the card becoming active is the only trigger.
      void loadMrs(id)
      void loadBranches(id)
    }
  }

  function selectProject(id: string): void {
    if (id === activeProject.value || !projects.value.some((project) => project.id === id)) {
      return
    }
    setActive(id)
  }

  async function discoverCandidates(): Promise<void> {
    try {
      const res = await fetch('/api/projects/discover')
      if (!res.ok) {
        return
      }
      const body = (await res.json()) as DiscoverResponse
      candidates.value = body.candidates
    } catch {
      candidates.value = []
    }
  }

  function applyRegistry(next: Project[], apiCurrent: string | null): void {
    projects.value = next
    if (!activeSeeded) {
      activeSeeded = true
      const persisted = readPersistedActiveProject()
      purgeDeadStorageKeys()
      setActive(deriveActiveProject(persisted, apiCurrent, next))
      return
    }
    // Later reloads: an active card gone from the registry (or a first
    // project appearing) re-derives instead of pointing at nothing.
    if (!next.some((project) => project.id === activeProject.value)) {
      setActive(deriveActiveProject(null, apiCurrent, next))
    }
  }

  async function loadProjects(): Promise<void> {
    try {
      const res = await fetch('/api/projects')
      if (!res.ok) {
        return
      }
      const body = (await res.json()) as ProjectsResponse
      workspace.value = body.workspace ?? null
      applyRegistry(body.projects, body.current)
    } catch {
      // Local server stopped: keep the last known registry.
    }
  }

  async function addProject(path: string): Promise<ApiResult> {
    const result = await postAction(token, '/api/projects', { path })
    if (result.ok) {
      // Re-fetch instead of trusting a response shape: the server normalizes
      // the path to the git toplevel, the registry is the source of truth.
      const before = new Set(projects.value.map((project) => project.id))
      await loadProjects()
      const added = projects.value.find((project) => !before.has(project.id))
      if (added) {
        // A freshly added project becomes the active card: its conversations
        // are what the user came for.
        selectProject(added.id)
      }
      // The registered flags of the open picker are stale now: refresh them.
      if (candidates.value.length > 0) {
        void discoverCandidates()
      }
    }
    return result
  }

  async function removeProject(id: string): Promise<ApiResult> {
    const result = await deleteProject(token, id)
    if (!result.ok) {
      return result
    }
    // Unregistering never touches the repo's disk; its task states are only
    // dropped from the client store (the stream stops carrying them).
    for (const [key, state] of store) {
      if (state.projectId === id) {
        store.delete(key)
      }
    }
    mrsByProject.delete(id)
    branchesByProject.delete(id)
    await loadProjects()
    return { ok: true }
  }

  return {
    projects,
    activeProject,
    mrsByProject,
    branchesByProject,
    candidates,
    workspace,
    loadProjects,
    discoverCandidates,
    selectProject,
    refreshMrs,
    addProject,
    removeProject,
  }
}

export function useTasks(token: string) {
  // reactive(Map) tracks set/get natively; states are mutated in place.
  const store = reactive(new Map<string, TaskState>())
  // Checks setup states keyed by project id: the proposal belongs to the
  // repo, every conversation of that repo reads the same one.
  const checksSetup = reactive(new Map<string, ChecksSetupState>())
  const connected = ref(false)
  // Bumped on every (re)open: watchers re-hydrate the open conversation, since
  // events emitted while disconnected are not replayed by the stream.
  const connections = ref(0)
  let source: EventSource | null = null

  const registry = useProjectRegistry(token, store)

  const states = computed(() =>
    [...store.values()].toSorted((a, b) => compareByActivity(a.record, b.record)),
  )

  function start(): void {
    void registry.loadProjects()
    source ??= openStream(store, checksSetup, connected, connections)
  }

  function stop(): void {
    source?.close()
    source = null
    connected.value = false
  }

  return {
    store,
    states,
    connected,
    connections,
    ...registry,
    start,
    stop,
    hydrate: (projectId: string, id: string) => hydrateStore(store, projectId, id),
    create: (projectId: string, input: CreateTaskInput) =>
      createTask(token, store, projectId, input),
    reply: (projectId: string, id: string, message: string) =>
      postAction(token, actionPath(projectId, id, 'reply'), { message }),
    interrupt: (projectId: string, id: string) =>
      postAction(token, actionPath(projectId, id, 'interrupt')),
    ship: (projectId: string, id: string) => postAction(token, actionPath(projectId, id, 'ship')),
    // Cleanup: removes the worktree (and, for forked tasks, the branch).
    abandon: (projectId: string, id: string) =>
      postAction(token, actionPath(projectId, id, 'abandon')),
    hydrateChecks: (projectId: string, id: string) => hydrateChecksStore(store, projectId, id),
    // Manual re-run of the sandboxed checks (409 while running or commit-less).
    runChecks: (projectId: string, id: string) =>
      postAction(token, actionPath(projectId, id, 'checks')),
    // ── Agent-assisted checks setup, per project ──────────────────────────
    checksSetup,
    loadChecksSetup: (projectId: string) => loadChecksSetupStore(checksSetup, projectId),
    runChecksSetup: (projectId: string) => startChecksSetup(token, checksSetup, projectId),
    applyChecksProposal: (projectId: string) => applyChecksSetup(token, checksSetup, projectId),
    /** "Dismiss": drops the proposal from THIS client's view only — nothing
     * was written, and the server keeps whatever it holds. */
    dismissChecksProposal: (projectId: string): void => {
      const previous = checksSetup.get(projectId) ?? IDLE_CHECKS_SETUP
      checksSetup.set(projectId, { ...previous, status: 'idle', proposal: null, error: null })
    },
  }
}
