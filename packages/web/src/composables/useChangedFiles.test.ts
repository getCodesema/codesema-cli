import { describe, expect, test } from 'bun:test'
import type { PreviewResult } from '../types'
import {
  IDLE_CHANGED_FILES_STATE,
  useChangedFiles,
  type ChangedFilesFetchFn,
  type ChangedFilesFetchOutcome,
} from './useChangedFiles'

const PREVIEW: PreviewResult = {
  branch: 'feat/x',
  target: 'main',
  commits: ['first commit'],
  files: [{ path: 'a.ts', additions: 3, deletions: 1, status: 'modified' }],
  diffStats: { files: 1, additions: 3, deletions: 1 },
}

/** Lets each fetch call be answered by hand, in any order. `calls` records
 *  `mrNumber project` pairs (space-joined, project '-' when absent) so a
 *  test can assert on the target actually requested. */
function riggedFetch(): {
  fetchFiles: ChangedFilesFetchFn
  calls: string[]
  answer: (n: number, preview: PreviewResult) => void
  fail: (n: number, error: string) => void
} {
  const calls: string[] = []
  const pending: ((outcome: ChangedFilesFetchOutcome) => void)[] = []
  return {
    calls,
    fetchFiles: (mrNumber, project) => {
      calls.push(`${mrNumber} ${project ?? '-'}`)
      return new Promise((resolve) => pending.push(resolve))
    },
    answer: (n, preview) => pending[n]?.({ ok: true, preview }),
    fail: (n, error) => pending[n]?.({ ok: false, error }),
  }
}

/** Lets the promise callbacks (`.then`) actually run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('useChangedFiles', () => {
  test('a fresh store starts idle, nothing requested yet', () => {
    const store = useChangedFiles(riggedFetch().fetchFiles)
    expect(store.state.value).toEqual(IDLE_CHANGED_FILES_STATE)
  })

  test('load() is lazy: fetches once, marks loading, then settles with the result', async () => {
    const rig = riggedFetch()
    const store = useChangedFiles(rig.fetchFiles)

    store.load(42)
    expect(store.state.value).toEqual({ phase: 'loading' })
    expect(rig.calls).toEqual(['42 -'])

    rig.answer(0, PREVIEW)
    await flush()
    expect(store.state.value).toEqual({ phase: 'loaded', preview: PREVIEW })
  })

  test('load() forwards the project scope in the query', () => {
    const rig = riggedFetch()
    const store = useChangedFiles(rig.fetchFiles)
    store.load(42, 'my-repo')
    expect(rig.calls).toEqual(['42 my-repo'])
  })

  test('load() never refetches the same target already loaded or in flight', async () => {
    const rig = riggedFetch()
    const store = useChangedFiles(rig.fetchFiles)

    store.load(42)
    store.load(42) // in flight: not a second call
    expect(rig.calls).toEqual(['42 -'])

    rig.answer(0, PREVIEW)
    await flush()
    store.load(42) // loaded: not a second call either
    expect(rig.calls).toEqual(['42 -'])
  })

  test('load() with a different target refetches, even mid-flight on the old one', () => {
    const rig = riggedFetch()
    const store = useChangedFiles(rig.fetchFiles)

    store.load(42)
    store.load(43)
    expect(rig.calls).toEqual(['42 -', '43 -'])
  })

  test('a stale in-flight answer for a superseded target is ignored', async () => {
    const rig = riggedFetch()
    const store = useChangedFiles(rig.fetchFiles)

    store.load(42)
    store.load(43)
    expect(store.state.value).toEqual({ phase: 'loading' })

    // The FIRST request (for 42) answers after the target already moved on
    // to 43: its result must never overwrite the state now representing 43.
    rig.answer(0, PREVIEW)
    await flush()
    expect(store.state.value).toEqual({ phase: 'loading' })

    const other: PreviewResult = { ...PREVIEW, branch: 'feat/y' }
    rig.answer(1, other)
    await flush()
    expect(store.state.value).toEqual({ phase: 'loaded', preview: other })
  })

  test('a transport error settles as an error state, message preserved', async () => {
    const rig = riggedFetch()
    const store = useChangedFiles(rig.fetchFiles)

    store.load(42)
    rig.fail(0, 'HTTP 500')
    await flush()
    expect(store.state.value).toEqual({ phase: 'error', message: 'HTTP 500' })
  })

  test('load() retries a target that last ended in a transport error', async () => {
    const rig = riggedFetch()
    const store = useChangedFiles(rig.fetchFiles)

    store.load(42)
    rig.fail(0, 'HTTP 500')
    await flush()

    store.load(42)
    expect(rig.calls).toEqual(['42 -', '42 -'])
  })

  test('reload() always refetches, keeping the previous result visible while it does', async () => {
    const rig = riggedFetch()
    const store = useChangedFiles(rig.fetchFiles)

    store.load(42)
    rig.answer(0, PREVIEW)
    await flush()

    store.reload(42)
    expect(rig.calls).toEqual(['42 -', '42 -'])
    // The previous result stays visible while the reload is in flight.
    expect(store.state.value).toEqual({ phase: 'loading' })
  })
})

describe('fetchChangedFilesOf (the real implementation)', () => {
  test('a non-ok response surfaces the server error message', async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'no such merge request' }), {
        status: 404,
      })) as unknown as typeof fetch
    try {
      const { fetchChangedFilesOf } = await import('./useChangedFiles')
      const outcome = await fetchChangedFilesOf(999, undefined)
      expect(outcome).toEqual({ ok: false, error: 'no such merge request' })
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test('a non-ok response with an unparseable body falls back to the HTTP status', async () => {
    const previousFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response('not json', { status: 503 })) as unknown as typeof fetch
    try {
      const { fetchChangedFilesOf } = await import('./useChangedFiles')
      const outcome = await fetchChangedFilesOf(999, undefined)
      expect(outcome).toEqual({ ok: false, error: 'HTTP 503' })
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
      const { fetchChangedFilesOf } = await import('./useChangedFiles')
      const outcome = await fetchChangedFilesOf(999, undefined)
      expect(outcome).toEqual({ ok: false, error: 'network down' })
    } finally {
      globalThis.fetch = previousFetch
    }
  })

  test('an ok response is parsed as the PreviewResult body', async () => {
    const previousFetch = globalThis.fetch
    let requestedUrl = ''
    globalThis.fetch = (async (url: string) => {
      requestedUrl = url
      return new Response(JSON.stringify(PREVIEW), { status: 200 })
    }) as unknown as typeof fetch
    try {
      const { fetchChangedFilesOf } = await import('./useChangedFiles')
      const outcome = await fetchChangedFilesOf(42, 'my-repo')
      expect(outcome).toEqual({ ok: true, preview: PREVIEW })
      expect(requestedUrl).toBe('/api/preview?source=mr&number=42&project=my-repo')
    } finally {
      globalThis.fetch = previousFetch
    }
  })
})
