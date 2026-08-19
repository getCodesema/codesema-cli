import { describe, expect, test } from 'bun:test'
import { ref } from 'vue'
import type { TaskRecord } from '../types'
import {
  applyTaskMetaFrame,
  taskKey,
  taskStreamHandlers,
  upsertRecord,
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
