import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sanitizeRecord } from './contract.js'
import type { ForgeMrsResult } from './forge-mrs.js'
import { parsePartialReview } from './partial.js'
import { addProject } from './projects.js'
import {
  createSession,
  isLoopbackHost,
  resolveProjectCwd,
  resolveStaticPath,
  startServer,
  type LiveSession,
  type SessionEvent,
} from './serve.js'

describe('isLoopbackHost', () => {
  test('accepts loopback hosts, with and without a port', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('localhost:4400')).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.0.0.1:4400')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('[::1]:4400')).toBe(true)
  })

  test('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(isLoopbackHost('LOCALHOST:4400')).toBe(true)
    expect(isLoopbackHost(' localhost ')).toBe(true)
  })

  test('rejects a missing or empty header', () => {
    expect(isLoopbackHost(undefined)).toBe(false)
    expect(isLoopbackHost('')).toBe(false)
  })

  test('rejects external and loopback-lookalike domains', () => {
    expect(isLoopbackHost('evil.com')).toBe(false)
    expect(isLoopbackHost('evil.com:4400')).toBe(false)
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false)
    expect(isLoopbackHost('localhost.evil.com')).toBe(false)
  })

  test('rejects non-loopback ipv6 hosts', () => {
    expect(isLoopbackHost('[2001:db8::1]')).toBe(false)
    expect(isLoopbackHost('[2001:db8::1]:4400')).toBe(false)
  })
})

describe('resolveStaticPath', () => {
  const root = '/srv/web-dist'

  test('maps a pathname to a file inside the root', () => {
    expect(resolveStaticPath(root, '/assets/app.js')).toBe('/srv/web-dist/assets/app.js')
    expect(resolveStaticPath(root, '/index.html')).toBe('/srv/web-dist/index.html')
  })

  test('decodes percent-encoded segments', () => {
    expect(resolveStaticPath(root, '/assets/app%20v2.js')).toBe('/srv/web-dist/assets/app v2.js')
  })

  test('rejects traversal, raw and encoded', () => {
    expect(resolveStaticPath(root, '/../secrets.txt')).toBeNull()
    expect(resolveStaticPath(root, '/assets/../../secrets.txt')).toBeNull()
    expect(resolveStaticPath(root, '/%2e%2e/secrets.txt')).toBeNull()
    expect(resolveStaticPath(root, '/assets/%2e%2e/%2e%2e/secrets.txt')).toBeNull()
  })

  test('rejects a sibling directory sharing the root prefix', () => {
    expect(resolveStaticPath(root, '/../web-dist-evil/app.js')).toBeNull()
  })

  test('rejects null bytes and undecodable paths', () => {
    expect(resolveStaticPath(root, '/app%00.js')).toBeNull()
    expect(resolveStaticPath(root, '/%zz')).toBeNull()
  })
})

describe('createSession dual mode', () => {
  const partial = parsePartialReview('{"summary":"wip"}')!

  test('mode and judging phase flow through status events', () => {
    const session = createSession()
    const events: SessionEvent[] = []
    session.subscribe((e) => events.push(e))

    session.setMode('dual')
    expect(session.status().mode).toBe('dual')

    session.setJudging(5)
    expect(session.status().phase).toBe('judging')
    expect(session.judge()).toEqual({ total: 5, decisions: [] })
    expect(events.filter((e) => e.name === 'status').length).toBeGreaterThanOrEqual(2)
  })

  test('lane B partial is stored and emitted separately from lane A', () => {
    const session = createSession()
    const events: SessionEvent[] = []
    session.subscribe((e) => events.push(e))

    session.setPartial(partial)
    session.setPartialB({ ...partial, summary: 'prosecutor wip' })

    expect(session.partial()?.summary).toBe('wip')
    expect(session.partialB()?.summary).toBe('prosecutor wip')
    expect(events.map((e) => e.name)).toEqual(['partial', 'partial_b'])
  })

  test('judge decisions accumulate and are readable back', () => {
    const session = createSession()
    session.setJudging(3)
    session.setJudge({ total: 3, decisions: [{ id: 'A0', action: 'keep' }] })
    expect(session.judge()?.decisions).toHaveLength(1)
  })

  test('reset clears the record and partials and returns to a fresh reviewing phase', () => {
    const record = sanitizeRecord({
      meta: { title: 't', branch: 'feature/x', target: 'develop' },
      review: { verdict: 'approve', summary: 'looks good' },
    })
    const session = createSession({ record: record! })
    session.setPartial(partial)
    session.setJudging(2)
    expect(session.status().phase).toBe('judging')

    session.reset()

    expect(session.record()).toBeNull()
    expect(session.partial()).toBeNull()
    expect(session.judge()).toBeNull()
    expect(session.status().phase).toBe('reviewing')
  })
})

const WEB_DIST = fileURLToPath(new URL('../web-dist', import.meta.url))

type RawResponse = { status: number; contentType: string; nosniff: string; body: string }

function rawRequest(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  return new Promise((resolveResponse, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers: opts.headers },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () =>
          resolveResponse({
            status: res.statusCode ?? 0,
            contentType: res.headers['content-type'] ?? '',
            nosniff: (res.headers['x-content-type-options'] as string | undefined) ?? '',
            body,
          }),
        )
      },
    )
    req.on('error', reject)
    if (opts.body !== undefined) {
      req.write(opts.body)
    }
    req.end()
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('timed out waiting for condition')
    }
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('startServer', () => {
  let session: LiveSession
  let port: number
  let stop: () => Promise<void>
  let repoDir: string
  let configDir: string
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR

  beforeAll(async () => {
    repoDir = mkdtempSync(join(tmpdir(), 'codesema-serve-repo-'))
    configDir = mkdtempSync(join(tmpdir(), 'codesema-serve-config-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
    session = createSession()
    const started = await startServer(session, { cwd: repoDir, port: 4901 })
    port = started.port
    stop = started.stop
  })

  afterAll(async () => {
    await stop()
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(configDir, { recursive: true, force: true })
  })

  test('serves the embedded index at the root', async () => {
    const res = await rawRequest(port, '/')
    expect(res.status).toBe(200)
    expect(res.contentType).toBe('text/html; charset=utf-8')
    expect(res.body.toLowerCase()).toContain('<!doctype html>')
  })

  test('serves bundled assets with their MIME type', async () => {
    const assets = readdirSync(join(WEB_DIST, 'assets'))
    const script = assets.find((f) => f.endsWith('.js'))
    const stylesheet = assets.find((f) => f.endsWith('.css'))
    expect(script).toBeDefined()
    expect(stylesheet).toBeDefined()

    const scriptRes = await rawRequest(port, `/assets/${script}`)
    expect(scriptRes.status).toBe(200)
    expect(scriptRes.contentType).toBe('text/javascript; charset=utf-8')

    const styleRes = await rawRequest(port, `/assets/${stylesheet}`)
    expect(styleRes.status).toBe(200)
    expect(styleRes.contentType).toBe('text/css; charset=utf-8')
  })

  test('returns 404 for unknown static paths', async () => {
    const res = await rawRequest(port, '/nope.txt')
    expect(res.status).toBe(404)
  })

  test('returns 404 for traversal attempts, raw and encoded', async () => {
    expect((await rawRequest(port, '/../package.json')).status).toBe(404)
    expect((await rawRequest(port, '/%2e%2e/package.json')).status).toBe(404)
    expect((await rawRequest(port, '/assets/%2e%2e/%2e%2e/package.json')).status).toBe(404)
  })

  test('rejects non-GET methods', async () => {
    const res = await rawRequest(port, '/api/status', { method: 'POST' })
    expect(res.status).toBe(405)
  })

  test('reports the fix endpoint as unavailable without a runner', async () => {
    const status = await rawRequest(port, '/api/fix/status')
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body)).toEqual({ available: false })

    const start = await rawRequest(port, '/api/fix', { method: 'POST', body: '{"findings":[0]}' })
    expect(start.status).toBe(501)
  })

  test('reports the MR review endpoint as unavailable without a runner', async () => {
    const status = await rawRequest(port, '/api/mrs/review/status')
    expect(status.status).toBe(200)
    expect(JSON.parse(status.body)).toEqual({ available: false })

    const start = await rawRequest(port, '/api/mrs/review', {
      method: 'POST',
      body: '{"source":{"kind":"mr","number":1},"mode":"simple"}',
    })
    expect(start.status).toBe(501)
  })

  test('rejects any request whose Host is not loopback', async () => {
    expect((await rawRequest(port, '/api/status', { headers: { host: 'evil.com' } })).status).toBe(
      403,
    )
    expect((await rawRequest(port, '/', { headers: { host: 'evil.com' } })).status).toBe(403)
  })

  test('sends nosniff on every response', async () => {
    const html = await rawRequest(port, '/')
    const json = await rawRequest(port, '/api/status')
    expect(html.nosniff).toBe('nosniff')
    expect(json.nosniff).toBe('nosniff')
  })

  test('reports the live status as json', async () => {
    const res = await rawRequest(port, '/api/status')
    expect(res.status).toBe(200)
    expect(res.contentType).toBe('application/json; charset=utf-8')
    const status = JSON.parse(res.body) as { phase: string; partial: unknown }
    expect(status.phase).toBe('reviewing')
    expect(status.partial).toBeNull()
  })

  test('answers 202 before the record exists, 200 after', async () => {
    const before = await rawRequest(port, '/api/review')
    expect(before.status).toBe(202)

    const record = sanitizeRecord({
      meta: { title: 'test', branch: 'feature/x', target: 'develop' },
      review: { verdict: 'approve', summary: 'looks good' },
    })
    expect(record).not.toBeNull()
    session.setDone(record!)

    const after = await rawRequest(port, '/api/review')
    expect(after.status).toBe(200)
    const body = JSON.parse(after.body) as { review: { verdict: string } }
    expect(body.review.verdict).toBe('approve')
  })

  test('secures and routes the fix endpoint when a runner is attached', async () => {
    const calls: number[][] = []
    let startResult: { ok: true } | { ok: false; code: number; error: string } = { ok: true }
    const runner = {
      status: () => ({
        available: true as const,
        phase: 'idle' as const,
        selected: [],
        head_moved: false,
      }),
      start: (ids: number[]) => {
        calls.push(ids)
        return startResult
      },
    }
    const fixSession = createSession()
    const started = await startServer(fixSession, { cwd: repoDir, port: 4921, fixRunner: runner })
    try {
      const html = await rawRequest(started.port, '/')
      const tokenMatch = /__CODESEMA_FIX_TOKEN__="([a-f0-9]{32})"/.exec(html.body)
      expect(tokenMatch).not.toBeNull()
      const token = tokenMatch![1]!

      const status = await rawRequest(started.port, '/api/fix/status')
      expect(JSON.parse(status.body)).toMatchObject({ available: true, phase: 'idle' })

      const noToken = await rawRequest(started.port, '/api/fix', {
        method: 'POST',
        body: '{"findings":[0]}',
      })
      expect(noToken.status).toBe(403)
      const badToken = await rawRequest(started.port, '/api/fix', {
        method: 'POST',
        headers: { 'x-codesema-fix-token': 'wrong' },
        body: '{"findings":[0]}',
      })
      expect(badToken.status).toBe(403)
      expect(calls).toHaveLength(0)

      const badBody = await rawRequest(started.port, '/api/fix', {
        method: 'POST',
        headers: { 'x-codesema-fix-token': token },
        body: '{"findings":["a"]}',
      })
      expect(badBody.status).toBe(400)

      const ok = await rawRequest(started.port, '/api/fix', {
        method: 'POST',
        headers: { 'x-codesema-fix-token': token },
        body: '{"findings":[0,2]}',
      })
      expect(ok.status).toBe(202)
      expect(calls).toEqual([[0, 2]])

      startResult = { ok: false, code: 409, error: 'a fix is already running' }
      const busy = await rawRequest(started.port, '/api/fix', {
        method: 'POST',
        headers: { 'x-codesema-fix-token': token },
        body: '{"findings":[1]}',
      })
      expect(busy.status).toBe(409)
    } finally {
      await started.stop()
    }
  })

  test('secures and routes the MR review endpoint when a runner is attached', async () => {
    const calls: { source: unknown; mode: string }[] = []
    let startResult: { ok: true } | { ok: false; code: number; error: string } = { ok: true }
    const runner = {
      status: () => ({ available: true as const, phase: 'idle' as const }),
      start: async (source: unknown, mode: 'simple' | 'dual') => {
        calls.push({ source, mode })
        return startResult
      },
    }
    const mrSession = createSession()
    const started = await startServer(mrSession, {
      cwd: repoDir,
      port: 4931,
      mrReviewRunner: runner,
    })
    try {
      const html = await rawRequest(started.port, '/')
      const tokenMatch = /__CODESEMA_MRREVIEW_TOKEN__="([a-f0-9]{32})"/.exec(html.body)
      expect(tokenMatch).not.toBeNull()
      const token = tokenMatch![1]!

      const status = await rawRequest(started.port, '/api/mrs/review/status')
      expect(JSON.parse(status.body)).toMatchObject({ available: true, phase: 'idle' })

      const noToken = await rawRequest(started.port, '/api/mrs/review', {
        method: 'POST',
        body: '{"source":{"kind":"mr","number":1},"mode":"simple"}',
      })
      expect(noToken.status).toBe(403)
      const badToken = await rawRequest(started.port, '/api/mrs/review', {
        method: 'POST',
        headers: { 'x-codesema-mrreview-token': 'wrong' },
        body: '{"source":{"kind":"mr","number":1},"mode":"simple"}',
      })
      expect(badToken.status).toBe(403)
      expect(calls).toHaveLength(0)

      const badBody = await rawRequest(started.port, '/api/mrs/review', {
        method: 'POST',
        headers: { 'x-codesema-mrreview-token': token },
        body: '{"source":{"kind":"mr","number":"1"},"mode":"simple"}',
      })
      expect(badBody.status).toBe(400)

      const badMode = await rawRequest(started.port, '/api/mrs/review', {
        method: 'POST',
        headers: { 'x-codesema-mrreview-token': token },
        body: '{"source":{"kind":"mr","number":1},"mode":"bogus"}',
      })
      expect(badMode.status).toBe(400)

      const ok = await rawRequest(started.port, '/api/mrs/review', {
        method: 'POST',
        headers: { 'x-codesema-mrreview-token': token },
        body: '{"source":{"kind":"mr","number":1},"mode":"dual"}',
      })
      expect(ok.status).toBe(202)
      expect(calls).toEqual([{ source: { kind: 'mr', number: 1 }, mode: 'dual' }])

      const branchOk = await rawRequest(started.port, '/api/mrs/review', {
        method: 'POST',
        headers: { 'x-codesema-mrreview-token': token },
        body: '{"source":{"kind":"branch","name":"feature/x"},"mode":"simple"}',
      })
      expect(branchOk.status).toBe(202)
      expect(calls[1]).toEqual({ source: { kind: 'branch', name: 'feature/x' }, mode: 'simple' })

      startResult = { ok: false, code: 409, error: 'a review is already running' }
      const busy = await rawRequest(started.port, '/api/mrs/review', {
        method: 'POST',
        headers: { 'x-codesema-mrreview-token': token },
        body: '{"source":{"kind":"mr","number":2},"mode":"simple"}',
      })
      expect(busy.status).toBe(409)
    } finally {
      await started.stop()
    }
  })

  test('reports the effective repo config as json', async () => {
    const res = await rawRequest(port, '/api/config')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ rulesContent: '', syncAutoPush: false })
  })

  test('rejects config mutations without a valid config token', async () => {
    const noToken = await rawRequest(port, '/api/config/rules', {
      method: 'PUT',
      body: '{"content":"- rule"}',
    })
    expect(noToken.status).toBe(403)
    const badToken = await rawRequest(port, '/api/config/sync-auto-push', {
      method: 'PUT',
      headers: { 'x-codesema-config-token': 'wrong' },
      body: '{"enabled":true}',
    })
    expect(badToken.status).toBe(403)
  })

  test('writes rules content and toggles sync-auto-push through the config token', async () => {
    const html = await rawRequest(port, '/')
    const tokenMatch = /__CODESEMA_CONFIG_TOKEN__="([a-f0-9]{32})"/.exec(html.body)
    expect(tokenMatch).not.toBeNull()
    const token = tokenMatch![1]!

    const badBody = await rawRequest(port, '/api/config/rules', {
      method: 'PUT',
      headers: { 'x-codesema-config-token': token },
      body: '{"content":42}',
    })
    expect(badBody.status).toBe(400)

    const tooLarge = await rawRequest(port, '/api/config/rules', {
      method: 'PUT',
      headers: { 'x-codesema-config-token': token },
      body: JSON.stringify({ content: 'x'.repeat(200 * 1024) }),
    })
    expect(tooLarge.status).toBe(400)

    const written = await rawRequest(port, '/api/config/rules', {
      method: 'PUT',
      headers: { 'x-codesema-config-token': token },
      body: JSON.stringify({ content: '- no any\n- errors carry a cause\n' }),
    })
    expect(written.status).toBe(200)
    expect(readFileSync(join(repoDir, '.codesema', 'RULES.md'), 'utf8')).toBe(
      '- no any\n- errors carry a cause\n',
    )

    const afterWrite = await rawRequest(port, '/api/config')
    expect(JSON.parse(afterWrite.body)).toMatchObject({
      rulesContent: '- no any\n- errors carry a cause\n',
    })

    const badToggle = await rawRequest(port, '/api/config/sync-auto-push', {
      method: 'PUT',
      headers: { 'x-codesema-config-token': token },
      body: '{"enabled":"yes"}',
    })
    expect(badToggle.status).toBe(400)

    const toggled = await rawRequest(port, '/api/config/sync-auto-push', {
      method: 'PUT',
      headers: { 'x-codesema-config-token': token },
      body: '{"enabled":true}',
    })
    expect(toggled.status).toBe(200)
    expect(JSON.parse(toggled.body)).toEqual({ ok: true, syncAutoPush: true })

    const afterToggle = await rawRequest(port, '/api/config')
    expect(JSON.parse(afterToggle.body)).toMatchObject({ syncAutoPush: true })
  })

  test('reports the open MRs as unavailable when the repo has no remote', async () => {
    const res = await rawRequest(port, '/api/mrs')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ available: false, reason: 'no-remote' })
  })

  test('reports no local branches outside a git repo', async () => {
    const res = await rawRequest(port, '/api/branches')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual([])
  })

  test('rejects a malformed preview source', async () => {
    expect((await rawRequest(port, '/api/preview')).status).toBe(400)
    expect((await rawRequest(port, '/api/preview?source=branch')).status).toBe(400)
    expect((await rawRequest(port, '/api/preview?source=mr&number=abc')).status).toBe(400)
    expect((await rawRequest(port, '/api/preview/diff?source=branch&name=x')).status).toBe(400)
  })

  test('404s a preview for a branch that does not exist', async () => {
    const res = await rawRequest(port, '/api/preview?source=branch&name=nope')
    expect(res.status).toBe(404)
  })

  test('streams session events over SSE', async () => {
    const chunks: string[] = []
    const req = request({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        chunks.push(chunk)
      })
    })
    req.end()

    await waitFor(() => chunks.join('').includes('event: status'))

    const partial = parsePartialReview('{"summary":"streaming"}')
    expect(partial).not.toBeNull()
    session.setPartial(partial!)

    await waitFor(() => chunks.join('').includes('event: partial'))
    const stream = chunks.join('')
    expect(stream).toContain('data: {"summary":"streaming"')
    req.destroy()
  })
})

describe('preview and branches endpoints', () => {
  let previewRepo: string
  let previewPort: number
  let previewStop: () => Promise<void>

  function runGit(args: string[]): void {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: previewRepo,
      stdio: 'ignore',
    })
  }

  beforeAll(async () => {
    previewRepo = mkdtempSync(join(tmpdir(), 'codesema-preview-repo-'))
    runGit(['init', '-b', 'main'])
    writeFileSync(join(previewRepo, 'a.txt'), 'base\n')
    runGit(['add', '-A'])
    runGit(['commit', '-m', 'init'])
    runGit(['checkout', '-b', 'feature/x'])
    writeFileSync(join(previewRepo, 'a.txt'), 'changed\n')
    runGit(['add', '-A'])
    runGit(['commit', '-m', 'feat: change'])
    runGit(['checkout', 'main'])

    const started = await startServer(createSession(), { cwd: previewRepo, port: 4941 })
    previewPort = started.port
    previewStop = started.stop
  })

  afterAll(async () => {
    await previewStop()
    rmSync(previewRepo, { recursive: true, force: true })
  })

  test('lists local branches with isCurrent and worktreePath', async () => {
    const res = await rawRequest(previewPort, '/api/branches')
    expect(res.status).toBe(200)
    const branches = JSON.parse(res.body) as {
      name: string
      isCurrent: boolean
      worktreePath: string | null
    }[]
    const main = branches.find((b) => b.name === 'main')
    const feature = branches.find((b) => b.name === 'feature/x')
    expect(main).toMatchObject({ isCurrent: true })
    expect(main?.worktreePath).not.toBeNull()
    expect(feature).toMatchObject({ isCurrent: false, worktreePath: null })
  })

  test('builds a deterministic preview for a local branch, without the full diff', async () => {
    const res = await rawRequest(previewPort, '/api/preview?source=branch&name=feature/x')
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as {
      branch: string
      target: string
      commits: string[]
      files: { path: string; additions: number; deletions: number; status: string }[]
      diffStats: { files: number; additions: number; deletions: number }
      diff?: unknown
    }
    expect(body.branch).toBe('feature/x')
    expect(body.target).toBe('main')
    expect(body.commits).toEqual(['feat: change'])
    expect(body.files).toEqual([{ path: 'a.txt', additions: 1, deletions: 1, status: 'modified' }])
    expect(body.diffStats).toEqual({ files: 1, additions: 1, deletions: 1 })
    expect(body.diff).toBeUndefined()
  })

  test('returns the diff of a single file from the preview', async () => {
    const res = await rawRequest(
      previewPort,
      '/api/preview/diff?source=branch&name=feature/x&path=a.txt',
    )
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { diff: string; truncated: boolean }
    expect(body.diff).toContain('-base')
    expect(body.diff).toContain('+changed')
    expect(body.truncated).toBe(false)
  })

  test('rejects a file path that is not part of the diff', async () => {
    const res = await rawRequest(
      previewPort,
      '/api/preview/diff?source=branch&name=feature/x&path=nope.txt',
    )
    expect(res.status).toBe(404)
  })
})

describe('resolveProjectCwd', () => {
  test('falls back to the launch cwd when the param is absent or blank', () => {
    expect(resolveProjectCwd(new URLSearchParams(), '/launch')).toEqual({ cwd: '/launch' })
    expect(resolveProjectCwd(new URLSearchParams('project='), '/launch')).toEqual({
      cwd: '/launch',
    })
    expect(resolveProjectCwd(new URLSearchParams('project=%20%20'), '/launch')).toEqual({
      cwd: '/launch',
    })
  })

  test('404s an id that is not a registered project, malformed ids included', () => {
    expect(resolveProjectCwd(new URLSearchParams('project=deadbeef'), '/launch')).toEqual({
      error: 404,
    })
    expect(resolveProjectCwd(new URLSearchParams('project=../etc'), '/launch')).toEqual({
      error: 404,
    })
  })
})

describe('project-scoped repo routes (?project=)', () => {
  let configDir: string
  let repoA: string
  let repoB: string
  let projectAId: string
  let projectBId: string
  let projectBPath: string
  let scopedPort: number
  let scopedStop: () => Promise<void>
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  const mrsCalls: string[] = []
  const stubMrs: ForgeMrsResult = {
    available: true,
    mrs: [
      {
        number: 7,
        title: 'stubbed',
        author: 'me',
        sourceBranch: 'codesema/task-x',
        targetBranch: 'main',
        updatedAt: '2026-08-14T00:00:00Z',
        url: 'https://example.test/mr/7',
        state: 'open',
        isDraft: false,
        labels: [],
        additions: null,
        deletions: null,
        changedFiles: null,
        checks: null,
        reviewers: [],
        assignees: [],
        milestone: null,
        mergeable: null,
        commits: null,
        body: null,
      },
    ],
    truncated: false,
  }

  function runGit(cwd: string, args: string[]): void {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd,
      stdio: 'ignore',
    })
  }

  function makeRepo(prefix: string, branch: string, file: string, content: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    runGit(dir, ['init', '-b', 'main'])
    writeFileSync(join(dir, file), 'base\n')
    runGit(dir, ['add', '-A'])
    runGit(dir, ['commit', '-m', 'init'])
    runGit(dir, ['checkout', '-b', branch])
    writeFileSync(join(dir, file), content)
    runGit(dir, ['add', '-A'])
    runGit(dir, ['commit', '-m', `feat: ${branch}`])
    runGit(dir, ['checkout', 'main'])
    return dir
  }

  beforeAll(async () => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-scoped-config-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
    repoA = makeRepo('codesema-scoped-a-', 'feature/alpha', 'a.txt', 'alpha\n')
    repoB = makeRepo('codesema-scoped-b-', 'feature/beta', 'b.txt', 'beta\n')
    const addedA = addProject(repoA)
    const addedB = addProject(repoB)
    if (!addedA.ok || !addedB.ok) {
      throw new Error('failed to register test repos')
    }
    projectAId = addedA.project.id
    projectBId = addedB.project.id
    projectBPath = addedB.project.path

    const started = await startServer(createSession(), {
      cwd: repoA,
      port: 4951,
      listMrs: (cwd) => {
        mrsCalls.push(cwd)
        return Promise.resolve(stubMrs)
      },
    })
    scopedPort = started.port
    scopedStop = started.stop
  })

  afterAll(async () => {
    await scopedStop()
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
    rmSync(repoA, { recursive: true, force: true })
    rmSync(repoB, { recursive: true, force: true })
  })

  test('404s an unknown project on every scoped route', async () => {
    expect((await rawRequest(scopedPort, '/api/mrs?project=deadbeef')).status).toBe(404)
    expect((await rawRequest(scopedPort, '/api/branches?project=deadbeef')).status).toBe(404)
    expect(
      (await rawRequest(scopedPort, '/api/preview?project=deadbeef&source=branch&name=main'))
        .status,
    ).toBe(404)
    expect(
      (
        await rawRequest(
          scopedPort,
          '/api/preview/diff?project=deadbeef&source=branch&name=main&path=a.txt',
        )
      ).status,
    ).toBe(404)
  })

  test('lists the branches of the project named by ?project=', async () => {
    const resB = await rawRequest(scopedPort, `/api/branches?project=${projectBId}`)
    expect(resB.status).toBe(200)
    const namesB = (JSON.parse(resB.body) as { name: string }[]).map((b) => b.name)
    expect(namesB).toContain('feature/beta')
    expect(namesB).not.toContain('feature/alpha')

    const resA = await rawRequest(scopedPort, `/api/branches?project=${projectAId}`)
    const namesA = (JSON.parse(resA.body) as { name: string }[]).map((b) => b.name)
    expect(namesA).toContain('feature/alpha')
    expect(namesA).not.toContain('feature/beta')
  })

  test('keeps the launch-cwd behavior when the param is absent', async () => {
    const res = await rawRequest(scopedPort, '/api/branches')
    const names = (JSON.parse(res.body) as { name: string }[]).map((b) => b.name)
    expect(names).toContain('feature/alpha')
    expect(names).not.toContain('feature/beta')
  })

  test('builds the preview and file diff against the scoped project repo', async () => {
    const preview = await rawRequest(
      scopedPort,
      `/api/preview?project=${projectBId}&source=branch&name=feature/beta`,
    )
    expect(preview.status).toBe(200)
    const body = JSON.parse(preview.body) as { branch: string; files: { path: string }[] }
    expect(body.branch).toBe('feature/beta')
    expect(body.files.map((f) => f.path)).toEqual(['b.txt'])

    const diff = await rawRequest(
      scopedPort,
      `/api/preview/diff?project=${projectBId}&source=branch&name=feature/beta&path=b.txt`,
    )
    expect(diff.status).toBe(200)
    expect((JSON.parse(diff.body) as { diff: string }).diff).toContain('+beta')

    // feature/beta only exists in repo B: scoping the same preview to repo A must 404.
    const wrongRepo = await rawRequest(
      scopedPort,
      `/api/preview?project=${projectAId}&source=branch&name=feature/beta`,
    )
    expect(wrongRepo.status).toBe(404)
  })

  test('runs the MR listing in the scoped project repo, launch cwd when absent', async () => {
    mrsCalls.length = 0
    const scoped = await rawRequest(scopedPort, `/api/mrs?project=${projectBId}`)
    expect(scoped.status).toBe(200)
    expect(JSON.parse(scoped.body)).toEqual(stubMrs)
    expect(mrsCalls).toEqual([projectBPath])

    const unscoped = await rawRequest(scopedPort, '/api/mrs')
    expect(unscoped.status).toBe(200)
    expect(mrsCalls).toHaveLength(2)
    expect(mrsCalls[1]).toBe(repoA)
  })
})
