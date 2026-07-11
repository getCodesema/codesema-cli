import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import type { ReviewRecord } from './contract.js'
import type { PartialReview } from './partial.js'

const WEB_DIST = fileURLToPath(new URL('../web-dist', import.meta.url))

export type LivePhase = 'reviewing' | 'done' | 'error'

export type LiveInput = {
  branch: string
  target: string
  commits: string[]
  files: { path: string; additions: number; deletions: number }[]
  additions: number
  deletions: number
  incremental: boolean
}

export type LiveStatus = {
  phase: LivePhase
  started_at: string
  agent?: string
  input?: LiveInput
  error?: string
}

export type SessionEvent =
  | { name: 'status'; data: LiveStatus }
  | { name: 'partial'; data: PartialReview }
  | { name: 'done'; data: Record<string, never> }

export type LiveSession = {
  status: () => LiveStatus
  record: () => ReviewRecord | null
  partial: () => PartialReview | null
  setAgent: (agent: string) => void
  setInput: (input: LiveInput) => void
  setPartial: (partial: PartialReview) => void
  setDone: (record: ReviewRecord) => void
  setError: (message: string) => void
  subscribe: (listener: (event: SessionEvent) => void) => () => void
}

export function createSession(initial?: { record?: ReviewRecord }): LiveSession {
  const listeners = new Set<(event: SessionEvent) => void>()
  let record: ReviewRecord | null = initial?.record ?? null
  let partial: PartialReview | null = null
  let status: LiveStatus = {
    phase: record ? 'done' : 'reviewing',
    started_at: new Date().toISOString(),
  }

  const emit = (event: SessionEvent) => {
    for (const listener of listeners) listener(event)
  }
  const emitStatus = () => emit({ name: 'status', data: status })

  return {
    status: () => status,
    record: () => record,
    partial: () => partial,
    setAgent(agent) {
      status = { ...status, agent }
      emitStatus()
    },
    setInput(input) {
      status = { ...status, input }
      emitStatus()
    },
    setPartial(next) {
      partial = next
      emit({ name: 'partial', data: next })
    },
    setDone(next) {
      record = next
      status = { ...status, phase: 'done' }
      emitStatus()
      emit({ name: 'done', data: {} })
    },
    setError(message) {
      status = { ...status, phase: 'error', error: message }
      emitStatus()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** Whether the Host header points to loopback (hostname before the port, IPv6 in brackets). */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false
  const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host.trim())
  if (!match) return false
  return LOOPBACK_HOSTNAMES.has(match[1]!.toLowerCase())
}

async function listen(app: Hono, startPort: number): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    const ok = await new Promise<boolean>((resolve) => {
      const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => resolve(true))
      server.on('error', (err: NodeJS.ErrnoException) => {
        server.close()
        if (err.code !== 'EADDRINUSE') console.error(err.message)
        resolve(false)
      })
    })
    if (ok) return port
  }
  throw new Error(`no free port between ${startPort} and ${startPort + 19}`)
}

export async function startServer(session: LiveSession, opts: { port?: number }): Promise<{ url: string; port: number }> {
  if (!existsSync(join(WEB_DIST, 'index.html'))) {
    throw new Error(`embedded web UI not found at ${WEB_DIST} — broken install/build`)
  }
  const indexHtml = readFileSync(join(WEB_DIST, 'index.html'), 'utf8')

  const app = new Hono()

  // The server only binds to loopback, but a malicious site could still reach
  // 127.0.0.1 via DNS rebinding (a domain that later resolves to loopback) and
  // read the diff/review. Accept only requests whose Host header is loopback, so
  // a rebound domain is rejected.
  app.use('/api/*', async (c, next) => {
    if (!isLoopbackHost(c.req.header('host'))) return c.text('forbidden', 403)
    await next()
  })

  app.get('/api/status', (c) => c.json({ ...session.status(), partial: session.partial() }))

  app.get('/api/review', (c) => {
    const record = session.record()
    if (!record) return c.json(session.status(), 202)
    return c.json(record)
  })

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let eventId = 0
      const send = (event: SessionEvent) =>
        stream.writeSSE({ event: event.name, data: JSON.stringify(event.data), id: String(eventId++) })

      const unsubscribe = session.subscribe((event) => {
        void send(event)
      })
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: 'ping', data: '' })
      }, 15000)

      await send({ name: 'status', data: session.status() })
      const partial = session.partial()
      if (partial) await send({ name: 'partial', data: partial })
      if (session.status().phase === 'done') await send({ name: 'done', data: {} })

      await new Promise<void>((resolve) => {
        stream.onAbort(() => resolve())
      })
      clearInterval(heartbeat)
      unsubscribe()
    }),
  )

  app.get('/', (c) => c.html(indexHtml))
  app.use('/*', serveStatic({ root: WEB_DIST }))

  const port = await listen(app, opts.port ?? 4400)
  return { url: `http://localhost:${port}`, port }
}
