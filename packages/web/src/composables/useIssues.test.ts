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

/** Lets each fetch call be answered by hand, in any order. `calls` records
 *  `projectId state` pairs (space-joined) so a test can assert on the state
 *  actually requested, not just the project. */
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
    fetchIssues: (projectId, state) => {
      calls.push(`${projectId} ${state}`)
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
    expect(rig.calls).toEqual(['p1 open'])

    rig.answer(0, ISSUES)
    await flush()
    expect(store.stateOf('p1')).toEqual({ result: ISSUES, loading: false, error: null })
  })

  test('load() never refetches a project already loaded or in flight', async () => {
    const rig = riggedFetch()
    const store = useIssues(rig.fetchIssues)

    store.load('p1')
    store.load('p1') // in flight: not a second call
    expect(rig.calls).toEqual(['p1 open'])

    rig.answer(0, ISSUES)
    await flush()
    store.load('p1') // cached: not a second call either
    expect(rig.calls).toEqual(['p1 open'])
  })

  test('reload() always refetches, keeping the previous result visible while it does', async () => {
    const rig = riggedFetch()
    const store = useIssues(rig.fetchIssues)

    store.load('p1')
    rig.answer(0, ISSUES)
    await flush()

    store.reload('p1')
    expect(rig.calls).toEqual(['p1 open', 'p1 open'])
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
    expect(rig.calls).toEqual(['p1 open', 'p1 open'])
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
    expect(rig.calls).toEqual(['p1 open', 'p2 open'])

    rig.answer(1, ISSUES)
    await flush()
    expect(store.stateOf('p2')).toEqual({ result: ISSUES, loading: false, error: null })
    expect(store.stateOf('p1')).toEqual({ result: null, loading: true, error: null })
  })

  test('stateOf/load/reload default to open, matching the pre-state-filter behavior', () => {
    const store = useIssues(riggedFetch().fetchIssues)
    expect(store.stateOf('p1')).toEqual(store.stateOf('p1', 'open'))
  })

  test('a project is cached independently per requested state: asking for closed never evicts or serves open', async () => {
    const rig = riggedFetch()
    const store = useIssues(rig.fetchIssues)
    const closedIssues: ForgeIssuesResult = {
      available: true,
      truncated: false,
      issues: [{ ...ISSUES.issues[0]!, number: 2, state: 'closed' }],
    }

    store.load('p1') // implicit 'open'
    rig.answer(0, ISSUES)
    await flush()

    store.load('p1', 'closed')
    expect(rig.calls).toEqual(['p1 open', 'p1 closed'])
    rig.answer(1, closedIssues)
    await flush()

    expect(store.stateOf('p1')).toEqual({ result: ISSUES, loading: false, error: null })
    expect(store.stateOf('p1', 'closed')).toEqual({
      result: closedIssues,
      loading: false,
      error: null,
    })
  })

  test('load() is lazy per state: a cached closed list is not refetched by a later load(closed)', async () => {
    const rig = riggedFetch()
    const store = useIssues(rig.fetchIssues)

    store.load('p1', 'closed')
    rig.answer(0, ISSUES)
    await flush()

    store.load('p1', 'closed') // cached: not a second call
    store.load('p1') // a different state ('open'): a real second call
    expect(rig.calls).toEqual(['p1 closed', 'p1 open'])
  })

  test('reload() refetches only the requested state, leaving the other cached states untouched', async () => {
    const rig = riggedFetch()
    const store = useIssues(rig.fetchIssues)

    store.load('p1')
    rig.answer(0, ISSUES)
    await flush()
    store.load('p1', 'all')
    rig.answer(1, ISSUES)
    await flush()

    store.reload('p1', 'all')
    expect(rig.calls).toEqual(['p1 open', 'p1 all', 'p1 all'])
    // The 'open' cache was never touched by the 'all' reload.
    expect(store.stateOf('p1')).toEqual({ result: ISSUES, loading: false, error: null })
  })
})
