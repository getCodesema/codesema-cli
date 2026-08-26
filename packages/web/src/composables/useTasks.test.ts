import { describe, expect, test } from 'bun:test'
import { ref } from 'vue'
import type { ForgeMr, GitWorktree, TaskPlan, TaskRecord } from '../types'
import {
  applyTaskMetaFrame,
  taskKey,
  taskStreamHandlers,
  upsertRecord,
  useTasks,
  type PreviewTaskResult,
  type TaskState,
  type TaskStore,
} from './useTasks'

function record(partial: Partial<TaskRecord>): TaskRecord {
  return {
    version: 1,
    id: 'a1b2c3d4e5f6',
    title: 'task',
    status: 'queued',
    base: 'main',
    branch: 'codesema/task-x',
    worktree: '/tmp/w',
    agent_session_id: null,
    turns: [],
    review_ref: null,
    work_ms: 0,
    wait_ms: 0,
    auto_ship: false,
    created_at: '2026-08-13T10:00:00.000Z',
    updated_at: '2026-08-13T10:00:00.000Z',
    ...partial,
  }
}

function stored(store: TaskStore, id: string): TaskRecord {
  const state = store.get(taskKey('p1', id))
  if (!state) {
    throw new Error(`no state for ${id}`)
  }
  return state.record
}

describe('upsertRecord and the queue rank', () => {
  // T1.2: the rank is DERIVED — the server recomputes it and re-broadcasts
  // everyone still waiting whenever the head leaves. The client's only job is
  // to believe the frame it was just sent.
  test('the rank refreshes: the line moves, the card follows', () => {
    const store: TaskStore = new Map()
    upsertRecord(store, 'p1', record({ id: 'second', queue_position: 2 }))
    expect(stored(store, 'second').queue_position).toBe(2)

    // The head left; the server re-broadcast this one with its new place.
    upsertRecord(store, 'p1', record({ id: 'second', queue_position: 1 }))
    expect(stored(store, 'second').queue_position).toBe(1)
  })

  // The badge is a promise about NOW. A task that started is not waiting
  // behind anything, and a client that keeps the old rank around shows a
  // place the task no longer holds.
  test('leaving the queue drops the rank instead of freezing it', () => {
    const store: TaskStore = new Map()
    upsertRecord(store, 'p1', record({ id: 'head', queue_position: 1 }))
    upsertRecord(store, 'p1', record({ id: 'head', status: 'running' }))

    expect(stored(store, 'head').status).toBe('running')
    expect(stored(store, 'head').queue_position).toBeUndefined()
  })

  // Nothing is invented either: a queued record the server chose not to
  // decorate (a project whose queue it could not read) shows no badge at all
  // rather than a made-up one.
  test('an undecorated queued frame gets no rank invented for it', () => {
    const store: TaskStore = new Map()
    upsertRecord(store, 'p1', record({ id: 'orphan' }))

    expect(stored(store, 'orphan').queue_position).toBeUndefined()
  })
})

// Adversarial review round 3, MAJEUR 4: `liveLoadCap` was written by the
// store and read by nothing under packages/web/src — these tests exercise
// the exact function TaskConversation.vue now derives its "waiting for a
// machine slot" phrase from, and the mutation table's item 4 (dropping the
// `load_cap` guard silently erases the occupation on the next token tick).
describe('applyTaskMetaFrame (task_meta SSE frame → TaskState)', () => {
  test('a plain token tick updates liveTokens and leaves liveLoadCap untouched', () => {
    const current: Pick<TaskState, 'liveTokens' | 'liveLoadCap'> = {
      liveTokens: 0,
      liveLoadCap: null,
    }
    applyTaskMetaFrame(current, { tokens: 120 })
    expect(current.liveTokens).toBe(120)
    expect(current.liveLoadCap).toBeNull()
  })

  test('a load-cap frame sets liveLoadCap and does NOT touch the already-live token count', () => {
    const current: Pick<TaskState, 'liveTokens' | 'liveLoadCap'> = {
      liveTokens: 340,
      liveLoadCap: null,
    }
    applyTaskMetaFrame(current, {
      tokens: 0,
      load_cap: { occupied: 1, max: 1, queued: 0 },
      waiting_for_slot: true,
    })
    // The mutant this kills (MINEUR, adversarial review round 3): dropping the
    // `else` and always writing `current.liveTokens = data.tokens` would zero
    // this out — `tokens: 0` on a load-cap frame is accurate for THAT frame,
    // but must never stomp a count an earlier tick already established.
    expect(current.liveTokens).toBe(340)
    expect(current.liveLoadCap).toEqual({ occupied: 1, max: 1, queued: 0, waitingForSlot: true })
  })

  test('an ordinary tick right after a load-cap frame leaves the occupation alone', () => {
    // The mutant this kills (MAJEUR 4 mutation table, item 4): removing the
    // `if (load_cap)` guard entirely and always overwriting liveLoadCap would
    // wipe the last known occupation on the very next plain tick (AC-13).
    const current: Pick<TaskState, 'liveTokens' | 'liveLoadCap'> = {
      liveTokens: 0,
      liveLoadCap: { occupied: 1, max: 1, queued: 0, waitingForSlot: true },
    }
    applyTaskMetaFrame(current, { tokens: 40 })
    expect(current.liveLoadCap).toEqual({ occupied: 1, max: 1, queued: 0, waitingForSlot: true })
  })

  test('waiting_for_slot defaults to false when a load-cap frame omits it', () => {
    const current: Pick<TaskState, 'liveTokens' | 'liveLoadCap'> = {
      liveTokens: 0,
      liveLoadCap: null,
    }
    applyTaskMetaFrame(current, { tokens: 0, load_cap: { occupied: 1, max: 1, queued: 0 } })
    expect(current.liveLoadCap?.waitingForSlot).toBe(false)
  })
})

// Round 4, MAJEUR 4: the tests above prove `applyTaskMetaFrame` is right; they
// say nothing about the stream still CALLING it. Replacing the call with two
// direct assignments — the shape the code had before that function existed —
// left every one of them green. These drive the real SSE listeners.
describe('taskStreamHandlers (the stream wiring itself)', () => {
  function rig(): { store: TaskStore; handlers: Record<string, (e: Event) => void> } {
    const store: TaskStore = new Map()
    const handlers = taskStreamHandlers(store, new Map(), ref(false), ref(0))
    return { store, handlers }
  }

  /** A frame as EventSource delivers it: only `.data`, a JSON string. */
  const frame = (payload: unknown): Event => ({ data: JSON.stringify(payload) }) as unknown as Event

  function seeded(): { store: TaskStore; handlers: Record<string, (e: Event) => void> } {
    const { store, handlers } = rig()
    handlers.task?.(
      frame({ project_id: 'p1', task_id: 'x', event: { name: 'task', data: record({ id: 'x' }) } }),
    )
    return { store, handlers }
  }

  test('a task_meta frame goes through applyTaskMetaFrame, not straight into the state', () => {
    const { store, handlers } = seeded()
    const state = store.get(taskKey('p1', 'x'))!
    handlers.task_meta?.(
      frame({
        project_id: 'p1',
        task_id: 'x',
        event: { name: 'task_meta', data: { tokens: 500 } },
      }),
    )
    expect(state.liveTokens).toBe(500)
    // The mutant this kills: `current.liveTokens = data.tokens; current
    // .liveLoadCap = …` in the listener. A load-cap frame carries `tokens: 0`,
    // so the direct form would wipe the 500 above — the header would show a
    // turn that produced nothing, mid-turn.
    handlers.task_meta?.(
      frame({
        project_id: 'p1',
        task_id: 'x',
        event: {
          name: 'task_meta',
          data: { tokens: 0, load_cap: { occupied: 2, max: 2, queued: 1 }, waiting_for_slot: true },
        },
      }),
    )
    expect(state.liveTokens).toBe(500)
    expect(state.liveLoadCap).toEqual({ occupied: 2, max: 2, queued: 1, waitingForSlot: true })
  })

  // Round 4, MAJEUR 1, client side: the server takes a 'running' back by
  // broadcasting a NULL checks payload. A client that could not represent
  // that would keep a greyed "Re-run checks" button until the next reload.
  test('a null task_checks payload puts the conversation back to "never ran"', () => {
    const { store, handlers } = seeded()
    const state = store.get(taskKey('p1', 'x'))!
    const running = {
      head_sha: 'abc',
      started_at: '2026-08-14T10:00:00.000Z',
      finished_at: null,
      status: 'running' as const,
      checks: [],
      error: null,
    }
    handlers.task_checks?.(
      frame({ project_id: 'p1', task_id: 'x', event: { name: 'task_checks', data: running } }),
    )
    expect(state.checks?.status).toBe('running')
    handlers.task_checks?.(
      frame({ project_id: 'p1', task_id: 'x', event: { name: 'task_checks', data: null } }),
    )
    expect(state.checks).toBeNull()
  })
})

// mrsLoadByProject carries the FACT behind mrsByProject's flattened `[]`: a
// loaded (possibly empty, possibly truncated) list, a forge the CLI could not
// reach with its own motif, or the fetch itself failing. Driven through
// loadProjects()'s auto-select of the derived active card, since loadMrs
// itself is private (setActive's own lazy-fetch policy, mirrored by
// selectProject), the same wiring WorkspaceView relies on.
describe('loadMrs / mrsLoadByProject (selectProject/loadProjects lazy-fetch policy)', () => {
  type Route = { status: number; body: unknown } | 'reject'

  function mrFixture(overrides: Partial<ForgeMr> = {}): ForgeMr {
    return {
      number: 1,
      title: 'first mr',
      author: 'octocat',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      updatedAt: '2026-08-14T00:00:00.000Z',
      url: 'https://example.test/mr/1',
      state: 'open',
      isDraft: false,
      labels: [],
      additions: null,
      deletions: null,
      changedFiles: null,
      checks: null,
      reviewers: null,
      assignees: null,
      milestone: null,
      mergeable: null,
      commits: null,
      body: null,
      ...overrides,
    }
  }

  function projectsResponse(id: string): unknown {
    return {
      projects: [{ id, path: `/repo/${id}`, name: id, added_at: '2026-08-14T00:00:00.000Z' }],
      current: id,
    }
  }

  /** Routes a GET/DELETE by its pathname (query string stripped); 'reject'
   * simulates a network failure, an unrouted path is a test authoring bug. */
  function installRoutedFetch(routes: Record<string, Route>): {
    calls: string[]
    restore: () => void
  } {
    const calls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      calls.push(url)
      const path = url.split('?')[0] ?? url
      const route = routes[path]
      if (route === undefined) {
        return Promise.reject(new Error(`unrouted fetch in test: ${url}`))
      }
      if (route === 'reject') {
        return Promise.reject(new Error('network down'))
      }
      const { status, body } = route
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      } as unknown as Response)
    }) as unknown as typeof fetch
    return {
      calls,
      restore: () => {
        globalThis.fetch = original
      },
    }
  }

  /** Lets the fetch/json promise chain inside loadMrs actually settle. */
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  /** Registers project 'p1' (the API's `current`, so loadProjects derives it
   * as the active card and its lazy fetches fire on their own) and lets its
   * MR load settle. Branches are routed to an empty list unconditionally:
   * this describe block is about the MR side only. */
  async function loadedProject(
    mrsRoute: Route,
  ): Promise<{ tasks: ReturnType<typeof useTasks>; calls: string[] }> {
    const { calls, restore } = installRoutedFetch({
      '/api/projects': { status: 200, body: projectsResponse('p1') },
      '/api/branches': { status: 200, body: [] },
      '/api/mrs': mrsRoute,
    })
    try {
      const tasks = useTasks('tok-123')
      await tasks.loadProjects()
      await flush()
      return { tasks, calls }
    } finally {
      restore()
    }
  }

  test('a successful, non-truncated list: status "loaded", truncated false, the list carried over', async () => {
    const { tasks } = await loadedProject({
      status: 200,
      body: { available: true, truncated: false, mrs: [mrFixture()] },
    })
    expect(tasks.mrsLoadByProject.get('p1')).toEqual({ status: 'loaded', truncated: false })
    expect(tasks.mrsByProject.get('p1')).toEqual([mrFixture()])
  })

  test('a successful, truncated list: status "loaded", truncated true', async () => {
    const { tasks } = await loadedProject({
      status: 200,
      body: { available: true, truncated: true, mrs: [mrFixture()] },
    })
    expect(tasks.mrsLoadByProject.get('p1')).toEqual({ status: 'loaded', truncated: true })
  })

  test('a successful, empty list: status "loaded", never confused with unavailable', async () => {
    const { tasks } = await loadedProject({
      status: 200,
      body: { available: true, truncated: false, mrs: [] },
    })
    expect(tasks.mrsLoadByProject.get('p1')).toEqual({ status: 'loaded', truncated: false })
    expect(tasks.mrsByProject.get('p1')).toEqual([])
  })

  test.each(['no-remote', 'no-cli', 'cli-error'] as const)(
    'forge unavailable (%s): status "unavailable" with its motif, mrsByProject stays empty',
    async (reason) => {
      const { tasks } = await loadedProject({
        status: 200,
        body: { available: false, reason },
      })
      expect(tasks.mrsLoadByProject.get('p1')).toEqual({ status: 'unavailable', reason })
      expect(tasks.mrsByProject.get('p1')).toEqual([])
    },
  )

  test('an HTTP failure: status "error" with the server’s own words, mrsByProject stays empty', async () => {
    const { tasks } = await loadedProject({ status: 500, body: { error: 'boom' } })
    expect(tasks.mrsLoadByProject.get('p1')).toEqual({ status: 'error', error: 'boom' })
    expect(tasks.mrsByProject.get('p1')).toEqual([])
  })

  test('a transport exception: status "error" with the exception’s message', async () => {
    const { tasks } = await loadedProject('reject')
    expect(tasks.mrsLoadByProject.get('p1')).toEqual({ status: 'error', error: 'network down' })
    expect(tasks.mrsByProject.get('p1')).toEqual([])
  })

  test('removing a project purges mrsLoadByProject alongside mrsByProject', async () => {
    const { calls, restore } = installRoutedFetch({
      '/api/projects': { status: 200, body: projectsResponse('p1') },
      '/api/branches': { status: 200, body: [] },
      '/api/mrs': { status: 200, body: { available: true, truncated: false, mrs: [] } },
      '/api/projects/p1': { status: 200, body: {} },
    })
    try {
      const tasks = useTasks('tok-123')
      await tasks.loadProjects()
      await flush()
      expect(tasks.mrsLoadByProject.get('p1')).toEqual({ status: 'loaded', truncated: false })

      const result = await tasks.removeProject('p1')
      expect(result).toEqual({ ok: true })
      expect(tasks.mrsLoadByProject.get('p1')).toBeUndefined()
      expect(tasks.mrsByProject.get('p1')).toBeUndefined()
      expect(calls).toContain('/api/projects/p1')
    } finally {
      restore()
    }
  })
})

describe('loadWorktrees / worktreesByProject (selectProject/loadProjects lazy-fetch policy)', () => {
  type Route = { status: number; body: unknown } | 'reject'

  const WORKTREE: GitWorktree = { path: '/repo/p1', branch: 'main' }

  function projectsResponse(id: string): unknown {
    return {
      projects: [{ id, path: `/repo/${id}`, name: id, added_at: '2026-08-14T00:00:00.000Z' }],
      current: id,
    }
  }

  /** Routes a GET/DELETE by its pathname (query string stripped); 'reject'
   * simulates a network failure, an unrouted path is a test authoring bug. */
  function installRoutedFetch(routes: Record<string, Route>): {
    calls: string[]
    restore: () => void
  } {
    const calls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = ((url: string) => {
      calls.push(url)
      const path = url.split('?')[0] ?? url
      const route = routes[path]
      if (route === undefined) {
        return Promise.reject(new Error(`unrouted fetch in test: ${url}`))
      }
      if (route === 'reject') {
        return Promise.reject(new Error('network down'))
      }
      const { status, body } = route
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      } as unknown as Response)
    }) as unknown as typeof fetch
    return {
      calls,
      restore: () => {
        globalThis.fetch = original
      },
    }
  }

  /** Lets the fetch/json promise chain inside loadWorktrees actually settle. */
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  test('a successful load populates worktreesByProject', async () => {
    const { restore } = installRoutedFetch({
      '/api/projects': { status: 200, body: projectsResponse('p1') },
      '/api/mrs': { status: 200, body: { available: false, reason: 'no-remote' } },
      '/api/branches': { status: 200, body: [] },
      '/api/worktrees': { status: 200, body: [WORKTREE] },
    })
    try {
      const tasks = useTasks('tok-123')
      await tasks.loadProjects()
      await flush()
      expect(tasks.worktreesByProject.get('p1')).toEqual([WORKTREE])
    } finally {
      restore()
    }
  })

  test('an HTTP failure caches an empty list', async () => {
    const { restore } = installRoutedFetch({
      '/api/projects': { status: 200, body: projectsResponse('p1') },
      '/api/mrs': { status: 200, body: { available: false, reason: 'no-remote' } },
      '/api/branches': { status: 200, body: [] },
      '/api/worktrees': { status: 500, body: { error: 'boom' } },
    })
    try {
      const tasks = useTasks('tok-123')
      await tasks.loadProjects()
      await flush()
      expect(tasks.worktreesByProject.get('p1')).toEqual([])
    } finally {
      restore()
    }
  })

  test('a transport exception caches an empty list', async () => {
    const { restore } = installRoutedFetch({
      '/api/projects': { status: 200, body: projectsResponse('p1') },
      '/api/mrs': { status: 200, body: { available: false, reason: 'no-remote' } },
      '/api/branches': { status: 200, body: [] },
      '/api/worktrees': 'reject',
    })
    try {
      const tasks = useTasks('tok-123')
      await tasks.loadProjects()
      await flush()
      expect(tasks.worktreesByProject.get('p1')).toEqual([])
    } finally {
      restore()
    }
  })

  test('selecting a project as active triggers its worktrees load', async () => {
    const { calls, restore } = installRoutedFetch({
      '/api/projects': {
        status: 200,
        body: {
          projects: [
            { id: 'p1', path: '/repo/p1', name: 'p1', added_at: '2026-08-14T00:00:00.000Z' },
            { id: 'p2', path: '/repo/p2', name: 'p2', added_at: '2026-08-14T00:00:00.000Z' },
          ],
          current: 'p1',
        },
      },
      '/api/mrs': { status: 200, body: { available: false, reason: 'no-remote' } },
      '/api/branches': { status: 200, body: [] },
      '/api/worktrees': { status: 200, body: [WORKTREE] },
    })
    try {
      const tasks = useTasks('tok-123')
      await tasks.loadProjects()
      await flush()
      tasks.selectProject('p2')
      await flush()
      expect(calls).toContain('/api/worktrees?project=p2')
      expect(tasks.worktreesByProject.get('p2')).toEqual([WORKTREE])
    } finally {
      restore()
    }
  })
})

// T2.6 — the client half of the dry-run. What matters here is that it hits
// the PREVIEW route (never the creation one), carries the CSRF token, and
// leaves the store untouched whatever comes back.
describe('useTasks().preview', () => {
  type Call = { url: string; init: RequestInit }

  async function withFetch<T>(
    reply: (call: Call) => { status: number; body: unknown },
    run: (preview: (body: Record<string, unknown>) => Promise<PreviewTaskResult>) => Promise<T>,
  ): Promise<{ result: T; calls: Call[]; store: TaskStore }> {
    const calls: Call[] = []
    const original = globalThis.fetch
    globalThis.fetch = ((url: string, init: RequestInit) => {
      calls.push({ url, init })
      const { status, body } = reply({ url, init })
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      } as unknown as Response)
    }) as unknown as typeof fetch
    try {
      const tasks = useTasks('tok-123')
      const result = await run(tasks.preview)
      return { result, calls, store: tasks.store }
    } finally {
      globalThis.fetch = original
    }
  }

  const PLAN: TaskPlan = {
    mode: 'fork',
    repo: '/repo',
    title: 'Fix it',
    branch: 'codesema/task-fix-it',
    branch_certain: true,
    worktree_root: '/repo/.codesema/worktrees',
    base: 'main',
    target: 'main',
    isolation: 'policy',
    isolation_reason: 'no runtime',
    agent: 'claude -p',
    queue_position: null,
    issue: null,
    auto_ship: false,
  }

  test('posts to the preview route with the tasks token, and stores nothing', async () => {
    const { result, calls, store } = await withFetch(
      () => ({ status: 200, body: PLAN }),
      (preview) => preview({ project_id: 'p1', title: 'Fix it', prompt: 'do it' }),
    )
    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (!call) {
      throw new Error('no request was made')
    }
    // The creation route is never touched by a preview.
    expect(call.url).toBe('/api/tasks/preview')
    expect(call.init.method).toBe('POST')
    expect((call.init.headers as Record<string, string>)['x-codesema-tasks-token']).toBe('tok-123')
    expect(JSON.parse(call.init.body as string)).toEqual({
      project_id: 'p1',
      title: 'Fix it',
      prompt: 'do it',
    })
    expect(result).toEqual({ ok: true, plan: PLAN })
    // No conversation appears anywhere: nothing was created to appear.
    expect(store.size).toBe(0)
  })

  test('a refusal comes back with its status and the server’s own words', async () => {
    const { result, store } = await withFetch(
      () => ({ status: 409, body: { error: 'a conversation is already active on branch fix/x' } }),
      (preview) => preview({ project_id: 'p1', title: 't', prompt: 'p', branch: 'fix/x' }),
    )
    expect(result).toEqual({
      ok: false,
      status: 409,
      error: 'a conversation is already active on branch fix/x',
    })
    expect(store.size).toBe(0)
  })

  test('an unreadable plan is a refusal, never a half-rendered panel', async () => {
    const { result } = await withFetch(
      () => ({ status: 200, body: { mode: 'fork' } }),
      (preview) => preview({ project_id: 'p1', title: 't', prompt: 'p' }),
    )
    expect(result).toMatchObject({ ok: false })
  })
})

// Gives a scratch conversation a repo after the fact. What matters here is
// the wire shape (route, token, `repo_project_id` body) and that every
// refusal the server can send (400 malformed id, 404 unknown repo, 409 own
// repo already set or a turn in progress) reaches the caller with its status
// and words intact, never swallowed into a generic failure.
describe('useTasks().attach', () => {
  type Call = { url: string; init: RequestInit }

  async function withFetch<T>(
    reply: (call: Call) => { status: number; body: unknown },
    run: (attach: ReturnType<typeof useTasks>['attach']) => Promise<T>,
  ): Promise<{ result: T; calls: Call[] }> {
    const calls: Call[] = []
    const original = globalThis.fetch
    globalThis.fetch = ((url: string, init: RequestInit) => {
      calls.push({ url, init })
      const { status, body } = reply({ url, init })
      return Promise.resolve({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(body),
      } as unknown as Response)
    }) as unknown as typeof fetch
    try {
      const tasks = useTasks('tok-123')
      const result = await run(tasks.attach)
      return { result, calls }
    } finally {
      globalThis.fetch = original
    }
  }

  test('posts repo_project_id to the scoped attach route, with the tasks token', async () => {
    const { calls, result } = await withFetch(
      () => ({ status: 200, body: { ok: true } }),
      (attach) => attach('p1', 'task-1', 'repo-9'),
    )
    expect(calls).toHaveLength(1)
    const call = calls[0]
    if (!call) {
      throw new Error('no request was made')
    }
    expect(call.url).toBe('/api/tasks/task-1/attach?project=p1')
    expect(call.init.method).toBe('POST')
    expect((call.init.headers as Record<string, string>)['x-codesema-tasks-token']).toBe('tok-123')
    expect(JSON.parse(call.init.body as string)).toEqual({ repo_project_id: 'repo-9' })
    expect(result).toEqual({ ok: true })
  })

  test('a 409 (own repo already set, or a turn in progress) keeps the server’s words', async () => {
    const { result } = await withFetch(
      () => ({ status: 409, body: { error: 'a turn is in progress' } }),
      (attach) => attach('p1', 'task-1', 'repo-9'),
    )
    expect(result).toEqual({ ok: false, status: 409, error: 'a turn is in progress' })
  })

  test('a 404 (unknown repository) keeps the server’s words', async () => {
    const { result } = await withFetch(
      () => ({ status: 404, body: { error: 'unknown repository' } }),
      (attach) => attach('p1', 'task-1', 'ghost'),
    )
    expect(result).toEqual({ ok: false, status: 404, error: 'unknown repository' })
  })

  test('a 400 (malformed repo id) keeps its status, not folded into 404', async () => {
    const { result } = await withFetch(
      () => ({ status: 400, body: { error: 'bad request' } }),
      (attach) => attach('p1', 'task-1', 'not-an-id'),
    )
    expect(result).toEqual({ ok: false, status: 400, error: 'bad request' })
  })

  test('a network failure never throws: status 0, the thrown message as the error', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() => {
      throw new Error('fetch failed')
    }) as unknown as typeof fetch
    try {
      const tasks = useTasks('tok-123')
      const result = await tasks.attach('p1', 'task-1', 'repo-9')
      expect(result).toEqual({ ok: false, status: 0, error: 'fetch failed' })
    } finally {
      globalThis.fetch = original
    }
  })
})
