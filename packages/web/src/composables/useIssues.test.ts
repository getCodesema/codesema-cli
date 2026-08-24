import { describe, expect, test } from 'bun:test'
import type { ForgeIssuesResult } from '../types'
import {
  EMPTY_ISSUES_STATE,
  useIssues,
  type IssuesFetchFn,
  type IssuesFetchOutcome,
} from './useIssues'

const ISSUES: ForgeIssuesResult = {
  available: true,
  truncated: false,
  issues: [
    {
      number: 1,
      title: 'first',
      body: '',
      state: 'open',
      labels: [],
      author: 'me',
      createdAt: '2026-08-14T00:00:00Z',
      updatedAt: '2026-08-14T00:00:00Z',
      url: 'https://example.test/issues/1',
    },
  ],
}

/** Lets each fetch call be answered by hand, in any order. */
function riggedFetch(): {
  fetchIssues: IssuesFetchFn
  calls: string[]
  answer: (n: number, result: ForgeIssuesResult) => void
  fail: (n: number, status: number, error: string) => void
} {
  const calls: string[] = []
  const pending: ((outcome: IssuesFetchOutcome) => void)[] = []
  return {
    calls,
    fetchIssues: (projectId) => {
      calls.push(projectId)
      return new Promise((resolve) => pending.push(resolve))
    },
    answer: (n, result) => pending[n]?.({ ok: true, result }),
    fail: (n, status, error) => pending[n]?.({ ok: false, status, error }),
  }
}

/** Lets the promise callbacks (`.then`) actually run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('useIssues', () => {
  test('an untouched project has no result, no error and nothing in flight', () => {
    const store = useIssues(riggedFetch().fetchIssues)
    expect(store.stateOf('p1')).toEqual(EMPTY_ISSUES_STATE)
  })

  test('load() is lazy: fetches once, marks loading, then settles with the result', async () => {
    const rig = riggedFetch()
    const store = useIssues(rig.fetchIssues)

    store.load('p1')
    expect(store.stateOf('p1')).toEqual({ result: null, loading: true, error: null })
    expect(rig.calls).toEqual(['p1'])

    rig.answer(0, ISSUES)
    await flush()
    expect(store.stateOf('p1')).toEqual({ result: ISSUES, loading: false, error: null })
  })

  test('load() never refetches a project already loaded or in flight', async () => {
    const rig = riggedFetch()
    const store = useIssues(rig.fetchIssues)

    store.load('p1')
    store.load('p1') // in flight: not a second call
    expect(rig.calls).toEqual(['p1'])

    rig.answer(0, ISSUES)
    await flush()
    store.load('p1') // cached: not a second call either
    expect(rig.calls).toEqual(['p1'])
  })

  test('reload() always refetches, keeping the previous result visible while it does', async () => {
    const rig = riggedFetch()
    const store = useIssues(rig.fetchIssues)

    store.load('p1')
    rig.answer(0, ISSUES)
    await flush()

    store.reload('p1')
    expect(rig.calls).toEqual(['p1', 'p1'])
    // The stale result stays visible under the new loading flag rather than
    // flashing back to empty while the refetch is in flight.
    expect(store.stateOf('p1')).toEqual({ result: ISSUES, loading: true, error: null })

    const refreshed: ForgeIssuesResult = { available: true, truncated: false, issues: [] }
    rig.answer(1, refreshed)
    await flush()
    expect(store.stateOf('p1')).toEqual({ result: refreshed, loading: false, error: null })
  })

  test('an HTTP failure propagates as `error`, never folded into `result`', async () => {
    const rig = riggedFetch()
    const store = useIssues(rig.fetchIssues)

    store.load('p1')
    rig.fail(0, 404, 'not found')
    await flush()
    expect(store.stateOf('p1')).toEqual({ result: null, loading: false, error: 'not found' })
  })

  test('a project left in error is retried on the next load()', async () => {
    const rig = riggedFetch()
    const store = useIssues(rig.fetchIssues)

    store.load('p1')
    rig.fail(0, 500, 'boom')
    await flush()

    store.load('p1')
    expect(rig.calls).toEqual(['p1', 'p1'])
    rig.answer(1, ISSUES)
    await flush()
    expect(store.stateOf('p1')).toEqual({ result: ISSUES, loading: false, error: null })
  })

  test('a forge unavailability is propagated as-is inside `result`, never as `error`', async () => {
    const rig = riggedFetch()
    const store = useIssues(rig.fetchIssues)
    const unavailable: ForgeIssuesResult = { available: false, reason: 'no-remote' }

    store.load('p1')
    rig.answer(0, unavailable)
    await flush()
    expect(store.stateOf('p1')).toEqual({ result: unavailable, loading: false, error: null })
  })

  test('projects are cached independently', async () => {
    const rig = riggedFetch()
    const store = useIssues(rig.fetchIssues)

    store.load('p1')
    store.load('p2')
    expect(rig.calls).toEqual(['p1', 'p2'])

    rig.answer(1, ISSUES)
    await flush()
    expect(store.stateOf('p2')).toEqual({ result: ISSUES, loading: false, error: null })
    expect(store.stateOf('p1')).toEqual({ result: null, loading: true, error: null })
  })
})
