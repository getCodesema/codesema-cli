import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ReviewRecord } from './contract.js'
import type { JudgeDecision } from './dual.js'
import type { FixRunner } from './fix.js'
import { t } from './i18n.js'
import type { PartialReview } from './partial.js'

const WEB_DIST = fileURLToPath(new URL('../web-dist', import.meta.url))

export type LivePhase = 'reviewing' | 'judging' | 'done' | 'error'
export type LiveMode = 'simple' | 'dual'

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
  mode?: LiveMode
  agent?: string
  input?: LiveInput
  error?: string
}

export type JudgeLive = {
  total: number
  decisions: JudgeDecision[]
}

export type SessionEvent =
  | { name: 'status'; data: LiveStatus }
  | { name: 'partial'; data: PartialReview }
  | { name: 'partial_b'; data: PartialReview }
  | { name: 'judge'; data: JudgeLive }
  | { name: 'done'; data: Record<string, never> }

export type LiveSession = {
  status: () => LiveStatus
  record: () => ReviewRecord | null
  partial: () => PartialReview | null
  partialB: () => PartialReview | null
  judge: () => JudgeLive | null
  setAgent: (agent: string) => void
  setMode: (mode: LiveMode) => void
  setInput: (input: LiveInput) => void
  setPartial: (partial: PartialReview) => void
  setPartialB: (partial: PartialReview) => void
  setJudging: (total: number) => void
  setJudge: (judge: JudgeLive) => void
  setDone: (record: ReviewRecord) => void
  setError: (message: string) => void
  subscribe: (listener: (event: SessionEvent) => void) => () => void
}

export function createSession(initial?: { record?: ReviewRecord }): LiveSession {
  const listeners = new Set<(event: SessionEvent) => void>()
  let record: ReviewRecord | null = initial?.record ?? null
  let partial: PartialReview | null = null
  let partialB: PartialReview | null = null
  let judge: JudgeLive | null = null
  let status: LiveStatus = {
    phase: record ? 'done' : 'reviewing',
    started_at: new Date().toISOString(),
  }

  const emit = (event: SessionEvent) => {
    for (const listener of listeners) {
      listener(event)
    }
  }
  const emitStatus = () => emit({ name: 'status', data: status })

  return {
    status: () => status,
    record: () => record,
    partial: () => partial,
    partialB: () => partialB,
    judge: () => judge,
    setAgent(agent) {
      status = { ...status, agent }
      emitStatus()
    },
    setMode(mode) {
      status = { ...status, mode }
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
    setPartialB(next) {
      partialB = next
      emit({ name: 'partial_b', data: next })
    },
    setJudging(total) {
      judge = { total, decisions: [] }
      status = { ...status, phase: 'judging' }
      emitStatus()
      emit({ name: 'judge', data: judge })
    },
    setJudge(next) {
      judge = next
      emit({ name: 'judge', data: next })
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
  if (!host) {
    return false
  }
  const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host.trim())
  if (!match) {
    return false
  }
  return LOOPBACK_HOSTNAMES.has((match[1] ?? '').toLowerCase())
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
  if (decoded.includes('\0')) {
    return null
  }
  const resolved = resolve(root, '.' + decoded)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    return null
  }
  return resolved
}

const MAX_SSE_CLIENTS = 16

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff',
  })
  res.end(html)
}

function serveEvents(
  session: LiveSession,
  req: IncomingMessage,
  res: ServerResponse,
  onClose: () => void,
): void {
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
  if (partial) {
    send({ name: 'partial', data: partial })
  }
  const partialB = session.partialB()
  if (partialB) {
    send({ name: 'partial_b', data: partialB })
  }
  const judge = session.judge()
  if (judge) {
    send({ name: 'judge', data: judge })
  }
  if (session.status().phase === 'done') {
    send({ name: 'done', data: {} })
  }

  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
    onClose()
  })
}

const MAX_FIX_BODY_BYTES = 64 * 1024

function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolveBody, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

type FixEndpoint = { runner: FixRunner; token: string }

/**
 * POST /api/fix triggers an agent that EDITS the working tree, so it needs more
 * than the loopback + Host guards: a per-server random token (injected into the
 * served page, unreadable cross-origin) blocks blind CSRF posts to 127.0.0.1.
 */
async function handleFixStart(
  req: IncomingMessage,
  res: ServerResponse,
  fix: FixEndpoint | undefined,
): Promise<void> {
  if (!fix) {
    return sendJson(res, 501, { error: 'fix runner unavailable' })
  }
  if (req.headers['x-codesema-fix-token'] !== fix.token) {
    return sendText(res, 403, 'forbidden')
  }
  let body: unknown
  try {
    body = await readJsonBody(req, MAX_FIX_BODY_BYTES)
  } catch {
    return sendText(res, 400, 'bad request')
  }
  const findings = (body as { findings?: unknown } | null)?.findings
  if (!Array.isArray(findings) || !findings.every((n) => typeof n === 'number')) {
    return sendText(res, 400, 'bad request')
  }
  const started = fix.runner.start(findings)
  if (!started.ok) {
    return sendJson(res, started.code, { error: started.error })
  }
  return sendJson(res, 202, { ok: true })
}

async function serveStaticFile(res: ServerResponse, pathname: string): Promise<void> {
  const filePath = resolveStaticPath(WEB_DIST, pathname)
  if (!filePath) {
    return sendText(res, 404, 'not found')
  }
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

function createRequestHandler(session: LiveSession, indexHtml: string, fix?: FixEndpoint) {
  let sseClients = 0

  return (req: IncomingMessage, res: ServerResponse): void => {
    // The server only binds to loopback, but a malicious site could still reach
    // 127.0.0.1 via DNS rebinding (a domain that later resolves to loopback) and
    // read the diff/review. Accept only requests whose Host header is loopback, so
    // a rebound domain is rejected.
    if (!isLoopbackHost(req.headers.host)) {
      return sendText(res, 403, 'forbidden')
    }

    let pathname: string
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    } catch {
      return sendText(res, 400, 'bad request')
    }

    if (req.method === 'POST') {
      if (pathname === '/api/fix') {
        return void handleFixStart(req, res, fix)
      }
      return sendText(res, 405, 'method not allowed')
    }
    if (req.method !== 'GET') {
      return sendText(res, 405, 'method not allowed')
    }

    if (pathname.startsWith('/api/')) {
      if (pathname === '/api/status') {
        return sendJson(res, 200, { ...session.status(), partial: session.partial() })
      }
      if (pathname === '/api/review') {
        const record = session.record()
        if (!record) {
          return sendJson(res, 202, session.status())
        }
        return sendJson(res, 200, record)
      }
      if (pathname === '/api/fix/status') {
        if (!fix) {
          return sendJson(res, 200, { available: false })
        }
        return sendJson(res, 200, fix.runner.status())
      }
      if (pathname === '/api/events') {
        if (sseClients >= MAX_SSE_CLIENTS) {
          return sendText(res, 503, 'too many event streams')
        }
        sseClients++
        return serveEvents(session, req, res, () => {
          sseClients--
        })
      }
      return sendText(res, 404, 'not found')
    }

    if (pathname === '/') {
      return sendHtml(res, indexHtml)
    }
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
        if (err.code !== 'EADDRINUSE') {
          console.error(err.message)
        }
        resolveListen(false)
      })
      server.listen(port, '127.0.0.1', () => resolveListen(true))
    })
    if (ok) {
      return { server, port }
    }
  }
  throw new Error(t('serve.noFreePort', { start: startPort, end: startPort + 19 }))
}

export async function startServer(
  session: LiveSession,
  opts: {
    port?: number | undefined
    locale?: string | undefined
    fixRunner?: FixRunner | undefined
  },
): Promise<{ url: string; port: number; stop: () => Promise<void> }> {
  if (!existsSync(join(WEB_DIST, 'index.html'))) {
    throw new Error(t('serve.noWebUi', { path: WEB_DIST }))
  }
  const fix: FixEndpoint | undefined = opts.fixRunner
    ? { runner: opts.fixRunner, token: randomBytes(16).toString('hex') }
    : undefined
  const bootScript = [
    `window.__CODESEMA_LOCALE__=${JSON.stringify(opts.locale ?? 'en')}`,
    ...(fix ? [`window.__CODESEMA_FIX_TOKEN__=${JSON.stringify(fix.token)}`] : []),
  ].join(';')
  const indexHtml = readFileSync(join(WEB_DIST, 'index.html'), 'utf8').replace(
    '</head>',
    `<script>${bootScript}</script></head>`,
  )

  const { server, port } = await listen(
    createRequestHandler(session, indexHtml, fix),
    opts.port ?? 4400,
  )
  const stop = () =>
    new Promise<void>((resolveClose) => {
      server.closeAllConnections()
      server.close(() => resolveClose())
    })
  return { url: `http://localhost:${port}`, port, stop }
}
