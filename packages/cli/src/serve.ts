import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ReviewRecord } from './contract.js'
import { t } from './i18n.js'
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

const MIME_BY_EXTENSION: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

/**
 * Maps a URL pathname to an absolute file path inside root. Returns null when the
 * decoded path escapes root (traversal), carries a null byte, or is not decodable.
 */
export function resolveStaticPath(root: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const resolved = resolve(root, '.' + decoded)
  if (resolved !== root && !resolved.startsWith(root + sep)) return null
  return resolved
}

const MAX_SSE_CLIENTS = 16

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-content-type-options': 'nosniff' })
  res.end(html)
}

function serveEvents(session: LiveSession, req: IncomingMessage, res: ServerResponse, onClose: () => void): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-content-type-options': 'nosniff',
  })

  let eventId = 0
  const send = (event: SessionEvent) => {
    res.write(`event: ${event.name}\nid: ${eventId++}\ndata: ${JSON.stringify(event.data)}\n\n`)
  }

  const unsubscribe = session.subscribe(send)
  const heartbeat = setInterval(() => {
    res.write('event: ping\ndata: \n\n')
  }, 15000)

  send({ name: 'status', data: session.status() })
  const partial = session.partial()
  if (partial) send({ name: 'partial', data: partial })
  if (session.status().phase === 'done') send({ name: 'done', data: {} })

  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
    onClose()
  })
}

async function serveStaticFile(res: ServerResponse, pathname: string): Promise<void> {
  const filePath = resolveStaticPath(WEB_DIST, pathname)
  if (!filePath) return sendText(res, 404, 'not found')
  let content: Buffer
  try {
    content = await readFile(filePath)
  } catch {
    return sendText(res, 404, 'not found')
  }
  const mime = MIME_BY_EXTENSION[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': mime, 'x-content-type-options': 'nosniff' })
  res.end(content)
}

function createRequestHandler(session: LiveSession, indexHtml: string) {
  let sseClients = 0

  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET') return sendText(res, 405, 'method not allowed')

    // The server only binds to loopback, but a malicious site could still reach
    // 127.0.0.1 via DNS rebinding (a domain that later resolves to loopback) and
    // read the diff/review. Accept only requests whose Host header is loopback, so
    // a rebound domain is rejected.
    if (!isLoopbackHost(req.headers.host)) return sendText(res, 403, 'forbidden')

    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      return sendText(res, 400, 'bad request')
    }

    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/status') {
        return sendJson(res, 200, { ...session.status(), partial: session.partial() })
      }
      if (pathname === '/api/review') {
        const record = session.record()
        if (!record) return sendJson(res, 202, session.status())
        return sendJson(res, 200, record)
      }
      if (pathname === '/api/events') {
        if (sseClients >= MAX_SSE_CLIENTS) return sendText(res, 503, 'too many event streams')
        sseClients++
        return serveEvents(session, req, res, () => {
          sseClients--
        })
      }
      return sendText(res, 404, 'not found')
    }

    if (pathname === '/') return sendHtml(res, indexHtml)
    void serveStaticFile(res, pathname)
  }
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  startPort: number,
): Promise<{ server: Server; port: number }> {
  for (let port = startPort; port < startPort + 20; port++) {
    const server = createServer(handler)
    const ok = await new Promise<boolean>((resolveListen) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        server.close()
        if (err.code !== 'EADDRINUSE') console.error(err.message)
        resolveListen(false)
      })
      server.listen(port, '127.0.0.1', () => resolveListen(true))
    })
    if (ok) return { server, port }
  }
  throw new Error(t('serve.noFreePort', { start: startPort, end: startPort + 19 }))
}

export async function startServer(
  session: LiveSession,
  opts: { port?: number; locale?: string },
): Promise<{ url: string; port: number; stop: () => Promise<void> }> {
  if (!existsSync(join(WEB_DIST, 'index.html'))) {
    throw new Error(t('serve.noWebUi', { path: WEB_DIST }))
  }
  const localeScript = `<script>window.__CODESEMA_LOCALE__=${JSON.stringify(opts.locale ?? 'en')}</script>`
  const indexHtml = readFileSync(join(WEB_DIST, 'index.html'), 'utf8').replace('</head>', `${localeScript}</head>`)

  const { server, port } = await listen(createRequestHandler(session, indexHtml), opts.port ?? 4400)
  const stop = () =>
    new Promise<void>((resolveClose) => {
      server.closeAllConnections()
      server.close(() => resolveClose())
    })
  return { url: `http://localhost:${port}`, port, stop }
}
