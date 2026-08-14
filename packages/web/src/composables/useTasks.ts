// Client of the multi-project task workspace API: the global project registry
// (/api/projects), ONE EventSource on /api/tasks/events for every conversation
// of every repo (the server caps SSE clients, a stream per task would blow
// through it), a Map of task states keyed by (project_id, task_id), and the
// token-guarded mutations. Streamed text deltas live only here — they are
// never persisted server-side. The selected projects are a localStorage-
// persisted set; on first load the API's `current` (or the whole registry)
// seeds it (see deriveSelection). Open MRs are cached per selected project so
// the sidebar tree can attach shipped conversations under their MR.

import { computed, reactive, ref, type Ref } from 'vue'
import type {
  DiscoverResponse,
  ForgeMr,
  ForgeMrsResult,
  Project,
  ProjectCandidate,
  ProjectsResponse,
  TaskEnvelope,
  TaskEvent,
  TaskRecord,
} from '../types'
import { deriveSelection, persistSelection, readPersistedSelection } from './useProjects'
import { compareByActivity, mergeEvent } from './useTaskBoard'

export type TaskState = {
  /** Registry id of the repo this task lives in. */
  projectId: string
  record: TaskRecord
  /** Journal events seen so far; complete only after hydrate(projectId, id). */
  events: TaskEvent[]
  /** Cumulative streamed text of the in-flight turn (SSE only, volatile). */
  liveText: string
}

export type ApiResult = { ok: true } | { ok: false; status: number; error: string }

export type CreateTaskInput = {
  title: string
  prompt: string
  autoShip: boolean
}

export type CreateTaskResult =
  { ok: true; record: TaskRecord } | { ok: false; status: number; error: string }

type TaskStore = Map<string, TaskState>

/** Composite store key: task ids are only unique within one repo's store. */
export const taskKey = (projectId: string, taskId: string): string => `${projectId}/${taskId}`

function upsertRecord(store: TaskStore, projectId: string, record: TaskRecord): void {
  const current = store.get(taskKey(projectId, record.id))
  if (!current) {
    store.set(taskKey(projectId, record.id), { projectId, record, events: [], liveText: '' })
    return
  }
  current.record = record
  // The stream text belongs to the running turn: once the task leaves
  // 'running' the turn is settled in the journal, drop the volatile copy.
  if (record.status !== 'running') {
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
  }
  mergeEvent(current.events, event)
}

function parseFrame<N extends TaskEnvelope['event']['name']>(
  e: Event,
): Extract<TaskEnvelope, { event: { name: N } }> {
  return JSON.parse((e as MessageEvent).data) as Extract<TaskEnvelope, { event: { name: N } }>
}

function openStream(store: TaskStore, connected: Ref<boolean>, connections: Ref<number>) {
  // The initial replay covers every task of every registered project; the
  // client filters by selected projects at render time, never at the stream.
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
  return source
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
      return { ok: false, status: res.status, error: await errorFrom(res) }
    }
    const record = (await res.json()) as TaskRecord
    // The stream will broadcast it too, but upserting now makes the new
    // conversation openable without waiting for the next frame.
    upsertRecord(store, projectId, record)
    return { ok: true, record }
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) }
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

/** Global project registry client: list, multi-selection, add, remove. */
function useProjectRegistry(token: string, store: TaskStore) {
  const projects = ref<Project[]>([])
  const selectedProjects = ref<ReadonlySet<string>>(new Set())
  // Open MRs per project id, refreshed on selection and on demand. A repo
  // without a forge (or a stopped CLI) caches an empty list silently: the
  // sidebar tree then degrades to branch nodes only.
  const mrsByProject = reactive(new Map<string, ForgeMr[]>())
  // Git repos detected around the launch directory, refreshed on demand when
  // the add-project form opens: one-click registration instead of typing paths.
  const candidates = ref<ProjectCandidate[]>([])
  // First derivation reads localStorage; later registry reloads only prune,
  // so an explicit empty selection is never "helpfully" refilled.
  let selectionSeeded = false

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

  /** Re-fetches the open MRs of every selected project (refresh button). */
  async function refreshMrs(): Promise<void> {
    await Promise.all([...selectedProjects.value].map((id) => loadMrs(id)))
  }

  function setSelection(ids: string[]): void {
    const previous = selectedProjects.value
    selectedProjects.value = new Set(ids)
    persistSelection(ids)
    // A project entering the selection gets its MRs (re)fetched right away.
    for (const id of ids) {
      if (!previous.has(id)) {
        void loadMrs(id)
      }
    }
  }

  function toggleProject(id: string): void {
    if (!projects.value.some((project) => project.id === id)) {
      return
    }
    const next = new Set(selectedProjects.value)
    if (next.has(id)) {
      next.delete(id)
    } else {
      next.add(id)
    }
    // Registry order keeps the persisted array (and the board) deterministic.
    setSelection(projects.value.map((p) => p.id).filter((pid) => next.has(pid)))
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
    if (!selectionSeeded) {
      selectionSeeded = true
      setSelection(deriveSelection(readPersistedSelection(), apiCurrent, next))
      return
    }
    // Later reloads only prune: a selected project gone from the registry is
    // dropped, but a deliberately empty selection stays empty.
    const known = new Set(next.map((project) => project.id))
    const kept = [...selectedProjects.value].filter((id) => known.has(id))
    if (kept.length !== selectedProjects.value.size) {
      setSelection(kept)
    }
  }

  async function loadProjects(): Promise<void> {
    try {
      const res = await fetch('/api/projects')
      if (!res.ok) {
        return
      }
      const body = (await res.json()) as ProjectsResponse
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
      if (added && !selectedProjects.value.has(added.id)) {
        // A freshly added project joins the selection: its board is what the
        // user came for.
        toggleProject(added.id)
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
    await loadProjects()
    return { ok: true }
  }

  return {
    projects,
    selectedProjects,
    mrsByProject,
    candidates,
    loadProjects,
    discoverCandidates,
    toggleProject,
    refreshMrs,
    addProject,
    removeProject,
  }
}

export function useTasks(token: string) {
  // reactive(Map) tracks set/get natively; states are mutated in place.
  const store = reactive(new Map<string, TaskState>())
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
    source ??= openStream(store, connected, connections)
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
  }
}
