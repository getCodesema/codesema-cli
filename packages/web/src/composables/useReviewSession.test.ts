import { describe, expect, test } from 'bun:test'
import { ref } from 'vue'
import type { JudgeLive, LiveStatus, PartialReview, ReviewRecord } from '../types'
import { reviewStreamHandlers, useReviewSession } from './useReviewSession'

const RECORD: ReviewRecord = {
  version: 1,
  meta: {
    title: 'Fix the thing',
    branch: 'feature/x',
    target: 'main',
    merge_base: 'abc123',
    repo_root: '/repo',
    created_at: '2026-08-20T09:00:00.000Z',
  },
  commits: ['abc123'],
  diff: '',
  review: {
    verdict: 'approve',
    summary: 'looks good',
    findings: [],
    narrative: null,
  },
}

/** Lets the promise callbacks (`.then`) actually run. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

type Route = { status: number; body: unknown } | 'reject'

/** Routes a fetch call by its pathname (query string stripped) to the next
 *  entry of that path's sequence (the last entry repeats once exhausted).
 *  `requests` keeps the full url (query string included) plus init, so a
 *  test can assert both the exact wire shape and the `?project=` targeting. */
function installRoutedFetch(routes: Record<string, Route[]>): {
  requests: { url: string; init: RequestInit | undefined }[]
  restore: () => void
} {
  const requests: { url: string; init: RequestInit | undefined }[] = []
  const cursors: Record<string, number> = {}
  const original = globalThis.fetch
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    requests.push({ url, init })
    const path = url.split('?')[0] ?? url
    const sequence = routes[path]
    if (!sequence || sequence.length === 0) {
      return Promise.reject(new Error(`unrouted fetch in test: ${url}`))
    }
    const index = cursors[path] ?? 0
    const route = sequence[Math.min(index, sequence.length - 1)]!
    cursors[path] = index + 1
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
    requests,
    restore: () => {
      globalThis.fetch = original
    },
  }
}

/** A fake EventSource: captures listeners per event name and lets a test
 *  fire them by hand with a `{ data }` payload, exactly like the real thing
 *  delivers one. Never performs any real network I/O. */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  readonly url: string
  closed = false
  private listeners = new Map<string, ((e: Event) => void)[]>()

  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, handler: (e: Event) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  close(): void {
    this.closed = true
  }

  dispatch(type: string, data?: unknown): void {
    const event = { data: JSON.stringify(data ?? null) } as unknown as Event
    for (const handler of this.listeners.get(type) ?? []) {
      handler(event)
    }
  }
}

function installFakeEventSource(): { restore: () => void } {
  const target = globalThis as { EventSource?: unknown }
  const original = target.EventSource
  FakeEventSource.instances = []
  target.EventSource = FakeEventSource
  return {
    restore: () => {
      target.EventSource = original
    },
  }
}

function installWindowToken(token: string): { restore: () => void } {
  const target = globalThis as { window?: unknown }
  const original = target.window
  target.window = { __CODESEMA_MRREVIEW_TOKEN__: token }
  return {
    restore: () => {
      target.window = original
    },
  }
}

/** Stubs setInterval/clearInterval so a test never leaves a real 1.5s timer
 *  running past its own assertions, and can inspect start/stop calls. */
function installFakeTimers(): {
  state: { setIntervalCalls: number; clearedHandles: unknown[] }
  restore: () => void
} {
  const originalSetInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  let nextHandle = 1
  const state = { setIntervalCalls: 0, clearedHandles: [] as unknown[] }
  globalThis.setInterval = ((..._args: unknown[]) => {
    state.setIntervalCalls++
    return nextHandle++ as unknown as ReturnType<typeof setInterval>
  }) as unknown as typeof setInterval
  globalThis.clearInterval = ((handle: unknown) => {
    state.clearedHandles.push(handle)
  }) as unknown as typeof clearInterval
  return {
    state,
    restore: () => {
      globalThis.setInterval = originalSetInterval
      globalThis.clearInterval = originalClearInterval
    },
  }
}

describe('load()/start(): archived record vs. live SSE', () => {
  test('an already-archived record loads directly, no SSE opened', async () => {
    const fetchRig = installRoutedFetch({ '/api/review': [{ status: 200, body: RECORD }] })
    try {
      const session = useReviewSession()
      await session.load()
      expect(session.record.value).toEqual(RECORD)
      expect(session.error.value).toBeNull()
      expect(fetchRig.requests.map((r) => r.url)).toEqual(['/api/review'])
    } finally {
      fetchRig.restore()
    }
  })

  test('a 202 opens the SSE stream, whose frames update the live refs', async () => {
    const fetchRig = installRoutedFetch({ '/api/review': [{ status: 202, body: null }] })
    const sseRig = installFakeEventSource()
    try {
      const session = useReviewSession()
      await session.load()
      expect(session.record.value).toBeNull()
      expect(FakeEventSource.instances).toHaveLength(1)
      expect(FakeEventSource.instances[0]!.url).toBe('/api/events')

      FakeEventSource.instances[0]!.dispatch('status', { phase: 'reviewing', started_at: 't0' })
      expect(session.status.value).toEqual({ phase: 'reviewing', started_at: 't0' })
    } finally {
      sseRig.restore()
      fetchRig.restore()
    }
  })

  test('a done frame closes the stream and reloads the record', async () => {
    const fetchRig = installRoutedFetch({
      '/api/review': [
        { status: 202, body: null },
        { status: 200, body: RECORD },
      ],
    })
    const sseRig = installFakeEventSource()
    try {
      const session = useReviewSession()
      await session.load()
      const source = FakeEventSource.instances[0]!
      expect(source.closed).toBe(false)

      source.dispatch('done')
      await flush()

      expect(source.closed).toBe(true)
      expect(session.record.value).toEqual(RECORD)
      expect(fetchRig.requests.map((r) => r.url)).toEqual(['/api/review', '/api/review'])
    } finally {
      sseRig.restore()
      fetchRig.restore()
    }
  })
})

describe('runReview()', () => {
  test('sends the token and the expected body, and resolves true on success', async () => {
    const windowRig = installWindowToken('tok-abc')
    const timersRig = installFakeTimers()
    const fetchRig = installRoutedFetch({
      '/api/mrs/review': [{ status: 200, body: {} }],
      '/api/mrs/review/status': [{ status: 200, body: { available: true, phase: 'idle' } }],
      '/api/review': [{ status: 200, body: RECORD }],
    })
    try {
      const session = useReviewSession()
      const ok = await session.runReview({ kind: 'mr', number: 7 }, 'simple')
      expect(ok).toBe(true)

      const launch = fetchRig.requests.find((r) => r.url === '/api/mrs/review')
      expect(launch).toBeDefined()
      expect(launch!.init?.method).toBe('POST')
      expect((launch!.init!.headers as Record<string, string>)['x-codesema-mrreview-token']).toBe(
        'tok-abc',
      )
      expect((launch!.init!.headers as Record<string, string>)['content-type']).toBe(
        'application/json',
      )
      expect(JSON.parse(launch!.init?.body as string)).toEqual({
        source: { kind: 'mr', number: 7 },
        mode: 'simple',
      })
      expect(session.mrReviewStartError.value).toBeNull()
    } finally {
      fetchRig.restore()
      timersRig.restore()
      windowRig.restore()
    }
  })

  test('a 409 (already running) lands in mrReviewStartError, never thrown', async () => {
    const windowRig = installWindowToken('tok-abc')
    const fetchRig = installRoutedFetch({
      '/api/mrs/review': [{ status: 409, body: { error: 'a review is already running' } }],
    })
    try {
      const session = useReviewSession()
      const ok = await session.runReview({ kind: 'branch', name: 'feat/x' }, 'dual')
      expect(ok).toBe(false)
      expect(session.mrReviewStartError.value).toBe('a review is already running')
      // The failure path returns before touching the record: nothing to show got wiped.
      expect(session.record.value).toBeNull()
    } finally {
      fetchRig.restore()
      windowRig.restore()
    }
  })

  test('no project set: the launch and its status poll hit the bare paths', async () => {
    const windowRig = installWindowToken('tok-abc')
    const timersRig = installFakeTimers()
    const fetchRig = installRoutedFetch({
      '/api/mrs/review': [{ status: 200, body: {} }],
      '/api/mrs/review/status': [{ status: 200, body: { available: true, phase: 'idle' } }],
      '/api/review': [{ status: 200, body: RECORD }],
    })
    try {
      const session = useReviewSession()
      await session.runReview({ kind: 'mr', number: 1 }, 'simple')
      const urls = fetchRig.requests.map((r) => r.url)
      expect(urls).toContain('/api/mrs/review')
      expect(urls).toContain('/api/mrs/review/status')
    } finally {
      fetchRig.restore()
      timersRig.restore()
      windowRig.restore()
    }
  })

  test('a project set with setProjectId: both endpoints carry ?project=<id>', async () => {
    const windowRig = installWindowToken('tok-abc')
    const timersRig = installFakeTimers()
    const fetchRig = installRoutedFetch({
      '/api/mrs/review': [{ status: 200, body: {} }],
      '/api/mrs/review/status': [{ status: 200, body: { available: true, phase: 'idle' } }],
      '/api/review': [{ status: 200, body: RECORD }],
    })
    try {
      const session = useReviewSession()
      session.setProjectId('proj-9')
      await session.runReview({ kind: 'mr', number: 1 }, 'simple')
      const urls = fetchRig.requests.map((r) => r.url)
      expect(urls).toContain('/api/mrs/review?project=proj-9')
      expect(urls).toContain('/api/mrs/review/status?project=proj-9')
    } finally {
      fetchRig.restore()
      timersRig.restore()
      windowRig.restore()
    }
  })
})

describe('stop()', () => {
  test('closes the SSE connection and clears the poll timer', async () => {
    const sseRig = installFakeEventSource()
    const timersRig = installFakeTimers()
    const fetchRig = installRoutedFetch({
      '/api/review': [{ status: 202, body: null }],
      '/api/mrs/review/status': [
        {
          status: 200,
          body: {
            available: true,
            phase: 'running',
            project_id: null,
            source: { kind: 'mr', number: 3 },
            mode: 'simple',
            started_at: '2026-08-20T09:00:00.000Z',
          },
        },
      ],
    })
    try {
      const session = useReviewSession()
      session.start()
      await flush()

      expect(FakeEventSource.instances).toHaveLength(1)
      expect(FakeEventSource.instances[0]!.closed).toBe(false)
      expect(timersRig.state.setIntervalCalls).toBe(1)
      expect(session.mrReviewRunning.value).toBe(true)
      expect(session.runningSource.value).toEqual({ kind: 'mr', number: 3 })

      session.stop()

      expect(FakeEventSource.instances[0]!.closed).toBe(true)
      expect(timersRig.state.clearedHandles).toHaveLength(1)
    } finally {
      fetchRig.restore()
      timersRig.restore()
      sseRig.restore()
    }
  })
})

describe('reviewStreamHandlers', () => {
  test('each named event feeds its target ref; done only calls back', () => {
    const status = ref<LiveStatus | null>(null)
    const partial = ref<PartialReview | null>(null)
    const partialB = ref<PartialReview | null>(null)
    const judge = ref<JudgeLive | null>(null)
    let doneCalls = 0
    const handlers = reviewStreamHandlers({ status, partial, partialB, judge }, () => {
      doneCalls += 1
    })
    const send = (name: string, data: unknown): void =>
      handlers[name]!({ data: JSON.stringify(data) } as unknown as Event)

    send('status', { phase: 'reviewing' })
    send('partial', { findings: [{ file: 'a.ts' }] })
    send('partial_b', { findings: [{ file: 'b.ts' }] })
    send('judge', { merged: 1 })

    expect(status.value).toEqual({ phase: 'reviewing' } as unknown as LiveStatus)
    expect(partial.value).toEqual({ findings: [{ file: 'a.ts' }] } as unknown as PartialReview)
    expect(partialB.value).toEqual({ findings: [{ file: 'b.ts' }] } as unknown as PartialReview)
    expect(judge.value).toEqual({ merged: 1 } as unknown as JudgeLive)
    expect(doneCalls).toBe(0)

    handlers['done']!({} as Event)
    expect(doneCalls).toBe(1)
  })
})
