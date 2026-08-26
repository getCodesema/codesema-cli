import { describe, expect, test } from 'bun:test'
import type { PreviewFileDiff } from '../types'
import { useFileDiffs, type FileDiffFetchFn, type FileDiffFetchOutcome } from './useFileDiffs'

const DIFF_A: PreviewFileDiff = { diff: '--- a/a.ts\n+++ b/a.ts\n', truncated: false }
const DIFF_B: PreviewFileDiff = { diff: '--- a/b.ts\n+++ b/b.ts\n', truncated: false }

/** Lets each fetch call be answered by hand, in any order. `calls` records
 *  `mrNumber path project` triples (space-joined, project '-' when absent). */
function riggedFetch(): {
  fetchDiff: FileDiffFetchFn
  calls: string[]
  answer: (n: number, diff: PreviewFileDiff) => void
  fail: (n: number, error: string) => void
} {
  const calls: string[] = []
  const pending: ((outcome: FileDiffFetchOutcome) => void)[] = []
  return {
    calls,
    fetchDiff: (mrNumber, path, project) => {
      calls.push(`${mrNumber} ${path} ${project ?? '-'}`)
      return new Promise((resolve) => pending.push(resolve))
    },
    answer: (n, diff) => pending[n]?.({ ok: true, diff }),
    fail: (n, error) => pending[n]?.({ ok: false, error }),
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('useFileDiffs', () => {
  test('an unrequested path has no state', () => {
    const store = useFileDiffs(riggedFetch().fetchDiff)
    expect(store.stateOf(42, 'a.ts')).toBeNull()
  })

  test('load() is lazy: fetches once, marks loading, then settles with the diff', async () => {
    const rig = riggedFetch()
    const store = useFileDiffs(rig.fetchDiff)

    store.load(42, 'a.ts')
    expect(store.stateOf(42, 'a.ts')).toEqual({ phase: 'loading' })
    expect(rig.calls).toEqual(['42 a.ts -'])

    rig.answer(0, DIFF_A)
    await flush()
    expect(store.stateOf(42, 'a.ts')).toEqual({ phase: 'loaded', diff: DIFF_A })
  })

  test('load() forwards the project scope in the query', () => {
    const rig = riggedFetch()
    const store = useFileDiffs(rig.fetchDiff)
    store.load(42, 'a.ts', 'my-repo')
    expect(rig.calls).toEqual(['42 a.ts my-repo'])
  })

  test('two different paths are independent: expanding one never disturbs the other', async () => {
    const rig = riggedFetch()
    const store = useFileDiffs(rig.fetchDiff)

    store.load(42, 'a.ts')
    store.load(42, 'b.ts')
    expect(rig.calls).toEqual(['42 a.ts -', '42 b.ts -'])

    rig.answer(0, DIFF_A)
    await flush()
    expect(store.stateOf(42, 'a.ts')).toEqual({ phase: 'loaded', diff: DIFF_A })
    expect(store.stateOf(42, 'b.ts')).toEqual({ phase: 'loading' })

    rig.answer(1, DIFF_B)
    await flush()
    expect(store.stateOf(42, 'b.ts')).toEqual({ phase: 'loaded', diff: DIFF_B })
  })

  test('load() never refetches a path already loaded or in flight', async () => {
    const rig = riggedFetch()
    const store = useFileDiffs(rig.fetchDiff)

    store.load(42, 'a.ts')
    store.load(42, 'a.ts') // in flight: not a second call
    expect(rig.calls).toEqual(['42 a.ts -'])

    rig.answer(0, DIFF_A)
    await flush()
    store.load(42, 'a.ts') // loaded: not a second call either
    expect(rig.calls).toEqual(['42 a.ts -'])
  })

  test('the same path under a different MR is a different cache entry', () => {
    const rig = riggedFetch()
    const store = useFileDiffs(rig.fetchDiff)
    store.load(42, 'a.ts')
    store.load(43, 'a.ts')
    expect(rig.calls).toEqual(['42 a.ts -', '43 a.ts -'])
  })

  test('the same path under a different project scope is a different cache entry', () => {
    const rig = riggedFetch()
    const store = useFileDiffs(rig.fetchDiff)
    store.load(42, 'a.ts')
    store.load(42, 'a.ts', 'my-repo')
    expect(rig.calls).toEqual(['42 a.ts -', '42 a.ts my-repo'])
  })

  test('a transport error settles as an error state, message preserved', async () => {
    const rig = riggedFetch()
    const store = useFileDiffs(rig.fetchDiff)

    store.load(42, 'a.ts')
    rig.fail(0, 'HTTP 500')
    await flush()
    expect(store.stateOf(42, 'a.ts')).toEqual({ phase: 'error', message: 'HTTP 500' })
  })

  test('load() retries a path that last ended in a transport error', async () => {
    const rig = riggedFetch()
    const store = useFileDiffs(rig.fetchDiff)

    store.load(42, 'a.ts')
    rig.fail(0, 'HTTP 500')
    await flush()

    store.load(42, 'a.ts')
    expect(rig.calls).toEqual(['42 a.ts -', '42 a.ts -'])
  })
})

describe('fetchFileDiffOf (the real implementation)', () => {
  test('an ok response is parsed as the PreviewFileDiff body, path encoded in the query', async () => {
    const previousFetch = globalThis.fetch
    let requestedUrl = ''
    globalThis.fetch = (async (url: string) => {
      requestedUrl = url
      return new Response(JSON.stringify(DIFF_A), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const { fetchFileDiffOf } = await import('./useFileDiffs')
      const outcome = await fetchFileDiffOf(42, 'src/a b.ts', 'my repo')
      expect(outcome).toEqual({ ok: true, diff: DIFF_A })
      expect(requestedUrl).toBe(
        '/api/preview/diff?source=mr&number=42&project=my%20repo&path=src%2Fa%20b.ts',
      )
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test('a non-ok response surfaces the server error message', async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'no such file' }), {
        status: 404,
      })) as unknown as typeof fetch
    try {
      const { fetchFileDiffOf } = await import('./useFileDiffs')
      const outcome = await fetchFileDiffOf(42, 'a.ts', undefined)
      expect(outcome).toEqual({ ok: false, error: 'no such file' })
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test('a network failure (fetch throws) is reported as its own message', async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    try {
      const { fetchFileDiffOf } = await import('./useFileDiffs')
      const outcome = await fetchFileDiffOf(42, 'a.ts', undefined)
      expect(outcome).toEqual({ ok: false, error: 'network down' })
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})
