import { describe, expect, test } from 'bun:test'
import type { TaskRecord } from '../types'
import { taskKey, upsertRecord, type TaskStore } from './useTasks'

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
