import { execFileSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { sanitizeRecord, type RecapRecord, type ReviewRecord } from './contract.js'
import type { ForgeMrsResult } from './forge-mrs.js'
import type {
  MrReviewMode,
  MrReviewRunner,
  MrReviewScope,
  MrReviewStatus,
  ReviewSource,
} from './mr-review-runner.js'
import { parsePartialReview } from './partial.js'
import { addProject } from './projects.js'
import { archiveRecord } from './record.js'
import {
  createSession,
  devIndexHtml,
  isLoopbackHost,
  mrReviewStatusForProject,
  resolveDevViteOrigin,
  resolveProjectCwd,
  resolveStaticPath,
  startServer,
  type LiveSession,
  type SessionEvent,
} from './serve.js'
import { evidenceDir, writeTaskEvidence } from './task-evidence.js'
import { writeTaskRecap } from './task-recap.js'

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

  test('reports the effective runner settings with their resolved defaults', async () => {
    const res = await rawRequest(port, '/api/settings')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({
      runnerAutoMerge: { value: true },
      mergeStrategy: {},
      maxTaskTurns: { value: 30 },
    })
  })

  test('rejects settings mutations without a valid config token', async () => {
    const noToken = await rawRequest(port, '/api/settings', {
      method: 'PUT',
      body: '{"runnerAutoMerge":false}',
    })
    expect(noToken.status).toBe(403)
    const badToken = await rawRequest(port, '/api/settings', {
      method: 'PUT',
      headers: { 'x-codesema-config-token': 'wrong' },
      body: '{"runnerAutoMerge":false}',
    })
    expect(badToken.status).toBe(403)
  })

  test('validates every settings field and never writes a partial update', async () => {
    const html = await rawRequest(port, '/')
    const tokenMatch = /__CODESEMA_CONFIG_TOKEN__="([a-f0-9]{32})"/.exec(html.body)
    expect(tokenMatch).not.toBeNull()
    const token = tokenMatch![1]!

    const rejections = [
      '{"nope":true}',
      '{"runnerAutoMerge":"yes"}',
      '{"mergeStrategy":"fast-forward"}',
      '{"maxTaskTurns":0}',
      '{"maxTaskTurns":501}',
      '{"maxTaskTurns":1.5}',
      '{"maxTaskTurns":"30"}',
    ]
    for (const body of rejections) {
      const res = await rawRequest(port, '/api/settings', {
        method: 'PUT',
        headers: { 'x-codesema-config-token': token },
        body,
      })
      expect(res.status).toBe(400)
    }

    const stillDefault = await rawRequest(port, '/api/settings')
    expect(JSON.parse(stillDefault.body)).toEqual({
      runnerAutoMerge: { value: true },
      mergeStrategy: {},
      maxTaskTurns: { value: 30 },
    })

    const written = await rawRequest(port, '/api/settings', {
      method: 'PUT',
      headers: { 'x-codesema-config-token': token },
      body: JSON.stringify({ runnerAutoMerge: false, mergeStrategy: 'squash', maxTaskTurns: 60 }),
    })
    expect(written.status).toBe(200)
    expect(JSON.parse(written.body)).toEqual({
      runnerAutoMerge: { value: false, raw: false },
      mergeStrategy: { value: 'squash', raw: 'squash' },
      maxTaskTurns: { value: 60, raw: 60 },
    })

    const afterWrite = await rawRequest(port, '/api/settings')
    expect(JSON.parse(afterWrite.body)).toEqual(JSON.parse(written.body))

    const partial = await rawRequest(port, '/api/settings', {
      method: 'PUT',
      headers: { 'x-codesema-config-token': token },
      body: '{"runnerAutoMerge":true}',
    })
    expect(partial.status).toBe(200)
    expect(JSON.parse(partial.body)).toEqual({
      runnerAutoMerge: { value: true, raw: true },
      mergeStrategy: { value: 'squash', raw: 'squash' },
      maxTaskTurns: { value: 60, raw: 60 },
    })
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

  test('reports no worktrees outside a git repo', async () => {
    const res = await rawRequest(port, '/api/worktrees')
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

  test('lists worktrees, the main worktree included', async () => {
    const res = await rawRequest(previewPort, '/api/worktrees')
    expect(res.status).toBe(200)
    const worktrees = JSON.parse(res.body) as { path: string; branch: string | null }[]
    expect(worktrees).toHaveLength(1)
    expect(worktrees[0]?.branch).toBe('main')
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

describe('mrReviewStatusForProject', () => {
  const source: ReviewSource = { kind: 'branch', name: 'feature/x' }

  test('idle and no ?project= both pass the status through unchanged', () => {
    expect(mrReviewStatusForProject({ available: true, phase: 'idle' }, 'A')).toEqual({
      available: true,
      phase: 'idle',
    })
    const running: MrReviewStatus = {
      available: true,
      phase: 'running',
      project_id: 'A',
      source,
      mode: 'simple',
      started_at: '2026-01-01T00:00:00.000Z',
    }
    expect(mrReviewStatusForProject(running, null)).toEqual(running)
  })

  test('a status belonging to another project is hidden as idle', () => {
    const running: MrReviewStatus = {
      available: true,
      phase: 'running',
      project_id: 'A',
      source,
      mode: 'simple',
      started_at: '2026-01-01T00:00:00.000Z',
    }
    expect(mrReviewStatusForProject(running, 'B')).toEqual({ available: true, phase: 'idle' })
    expect(mrReviewStatusForProject(running, 'A')).toEqual(running)
  })

  test('a null project_id (a run started without ?project=) is hidden from a scoped query', () => {
    const done: MrReviewStatus = {
      available: true,
      phase: 'done',
      project_id: null,
      source,
      mode: 'dual',
    }
    expect(mrReviewStatusForProject(done, 'A')).toEqual({ available: true, phase: 'idle' })
    expect(mrReviewStatusForProject(done, null)).toEqual(done)
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
  let mrReviewToken: string
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  const mrsCalls: string[] = []
  const mrReviewCalls: {
    source: ReviewSource
    mode: MrReviewMode
    scope: MrReviewScope | undefined
  }[] = []
  let mrReviewStatusValue: MrReviewStatus = { available: true, phase: 'idle' }
  const mrReviewRunnerMock: MrReviewRunner = {
    status: () => mrReviewStatusValue,
    start: async (source, mode, scope) => {
      mrReviewCalls.push({ source, mode, scope })
      return { ok: true }
    },
  }
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
      mrReviewRunner: mrReviewRunnerMock,
    })
    scopedPort = started.port
    scopedStop = started.stop
    const html = await rawRequest(scopedPort, '/')
    mrReviewToken = /__CODESEMA_MRREVIEW_TOKEN__="([a-f0-9]{32})"/.exec(html.body)![1]!
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
    expect((await rawRequest(scopedPort, '/api/worktrees?project=deadbeef')).status).toBe(404)
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

  test('lists the worktrees of the project named by ?project=', async () => {
    const resB = await rawRequest(scopedPort, `/api/worktrees?project=${projectBId}`)
    expect(resB.status).toBe(200)
    const pathsB = (JSON.parse(resB.body) as { path: string }[]).map((w) => w.path)
    expect(pathsB).toContain(realpathSync(repoB))
    expect(pathsB).not.toContain(realpathSync(repoA))

    const resA = await rawRequest(scopedPort, `/api/worktrees?project=${projectAId}`)
    const pathsA = (JSON.parse(resA.body) as { path: string }[]).map((w) => w.path)
    expect(pathsA).toContain(realpathSync(repoA))
    expect(pathsA).not.toContain(realpathSync(repoB))
  })

  test('keeps the launch-cwd behavior for worktrees when the param is absent', async () => {
    const res = await rawRequest(scopedPort, '/api/worktrees')
    const paths = (JSON.parse(res.body) as { path: string }[]).map((w) => w.path)
    expect(paths).toContain(realpathSync(repoA))
    expect(paths).not.toContain(realpathSync(repoB))
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

  test('POST /api/mrs/review threads ?project= into the runner as scope, omitted when absent', async () => {
    mrReviewCalls.length = 0
    const scoped = await rawRequest(scopedPort, `/api/mrs/review?project=${projectBId}`, {
      method: 'POST',
      headers: { 'x-codesema-mrreview-token': mrReviewToken },
      body: '{"source":{"kind":"branch","name":"feature/beta"},"mode":"simple"}',
    })
    expect(scoped.status).toBe(202)
    expect(mrReviewCalls).toEqual([
      {
        source: { kind: 'branch', name: 'feature/beta' },
        mode: 'simple',
        scope: { projectId: projectBId, cwd: projectBPath },
      },
    ])

    const unscoped = await rawRequest(scopedPort, '/api/mrs/review', {
      method: 'POST',
      headers: { 'x-codesema-mrreview-token': mrReviewToken },
      body: '{"source":{"kind":"branch","name":"feature/alpha"},"mode":"simple"}',
    })
    expect(unscoped.status).toBe(202)
    expect(mrReviewCalls).toHaveLength(2)
    expect(mrReviewCalls[1]?.scope).toBeUndefined()
  })

  test('POST /api/mrs/review 404s an unknown project without starting a review', async () => {
    mrReviewCalls.length = 0
    const res = await rawRequest(scopedPort, '/api/mrs/review?project=deadbeef', {
      method: 'POST',
      headers: { 'x-codesema-mrreview-token': mrReviewToken },
      body: '{"source":{"kind":"branch","name":"feature/alpha"},"mode":"simple"}',
    })
    expect(res.status).toBe(404)
    expect(mrReviewCalls).toEqual([])
  })

  test('GET /api/mrs/review/status 404s an unknown project', async () => {
    const res = await rawRequest(scopedPort, '/api/mrs/review/status?project=deadbeef')
    expect(res.status).toBe(404)
  })

  test('GET /api/mrs/review/status isolates a running review between two projects', async () => {
    mrReviewStatusValue = {
      available: true,
      phase: 'running',
      project_id: projectAId,
      source: { kind: 'branch', name: 'feature/alpha' },
      mode: 'simple',
      started_at: new Date().toISOString(),
    }
    try {
      const forA = await rawRequest(scopedPort, `/api/mrs/review/status?project=${projectAId}`)
      expect(JSON.parse(forA.body)).toMatchObject({ phase: 'running', project_id: projectAId })

      const forB = await rawRequest(scopedPort, `/api/mrs/review/status?project=${projectBId}`)
      expect(JSON.parse(forB.body)).toEqual({ available: true, phase: 'idle' })

      const unscoped = await rawRequest(scopedPort, '/api/mrs/review/status')
      expect(JSON.parse(unscoped.body)).toMatchObject({ phase: 'running', project_id: projectAId })
    } finally {
      mrReviewStatusValue = { available: true, phase: 'idle' }
    }
  })
})

describe('task recap and evidence routes (?project=)', () => {
  let configDir: string
  let repoDir: string
  let projectId: string
  let projectPath: string
  let port: number
  let stop: () => Promise<void>
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR

  const TASK_ID = 'abcdef123456'
  const OTHER_TASK_ID = '0123456789ab'

  function minimalRecap(): RecapRecord {
    return {
      version: 1,
      summary: 'did the thing',
      changes: [],
      decisions: [],
      files: [],
      tests: [],
      branch: 'codesema/task-x',
    }
  }

  beforeAll(async () => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-evidence-config-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
    repoDir = mkdtempSync(join(tmpdir(), 'codesema-evidence-repo-'))
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' })
    const added = addProject(repoDir)
    if (!added.ok) {
      throw new Error('failed to register test repo')
    }
    projectId = added.project.id
    projectPath = added.project.path

    writeTaskRecap(projectPath, TASK_ID, minimalRecap())
    writeTaskEvidence(projectPath, TASK_ID, {
      version: 1,
      status: 'passed',
      reason: null,
      head_sha: null,
      items: [],
    })

    const dir = evidenceDir(projectPath, TASK_ID)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'shot.png'), 'a-small-png')
    writeFileSync(join(dir, 'clip.webm'), 'a-small-webm')
    writeFileSync(join(dir, 'huge.png'), Buffer.alloc(64 * 1024 * 1024 + 1))

    const started = await startServer(createSession(), { cwd: repoDir, port: 4990 })
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
    rmSync(configDir, { recursive: true, force: true })
    rmSync(repoDir, { recursive: true, force: true })
  })

  test('200s the recap of a task that has one', async () => {
    const res = await rawRequest(port, `/api/tasks/${TASK_ID}/recap?project=${projectId}`)
    expect(res.status).toBe(200)
    expect(res.contentType).toBe('application/json; charset=utf-8')
    expect(JSON.parse(res.body)).toMatchObject({ summary: 'did the thing' })
  })

  test('404s a task with no recap', async () => {
    const res = await rawRequest(port, `/api/tasks/${OTHER_TASK_ID}/recap?project=${projectId}`)
    expect(res.status).toBe(404)
  })

  test('404s an invalid task id on recap', async () => {
    const res = await rawRequest(port, `/api/tasks/not-a-task-id/recap?project=${projectId}`)
    expect(res.status).toBe(404)
  })

  test('200s the evidence record of a task that has one', async () => {
    const res = await rawRequest(port, `/api/tasks/${TASK_ID}/evidence?project=${projectId}`)
    expect(res.status).toBe(200)
    expect(res.contentType).toBe('application/json; charset=utf-8')
    expect(JSON.parse(res.body)).toMatchObject({ status: 'passed', items: [] })
  })

  test('404s a task with no evidence record', async () => {
    const res = await rawRequest(port, `/api/tasks/${OTHER_TASK_ID}/evidence?project=${projectId}`)
    expect(res.status).toBe(404)
  })

  test('404s an invalid task id on evidence', async () => {
    const res = await rawRequest(port, `/api/tasks/not-a-task-id/evidence?project=${projectId}`)
    expect(res.status).toBe(404)
  })

  test('serves a png evidence file with the right content type', async () => {
    const res = await rawRequest(
      port,
      `/api/tasks/${TASK_ID}/evidence/shot.png?project=${projectId}`,
    )
    expect(res.status).toBe(200)
    expect(res.contentType).toBe('image/png')
    expect(res.nosniff).toBe('nosniff')
  })

  test('serves a webm evidence file with the right content type', async () => {
    const res = await rawRequest(
      port,
      `/api/tasks/${TASK_ID}/evidence/clip.webm?project=${projectId}`,
    )
    expect(res.status).toBe(200)
    expect(res.contentType).toBe('video/webm')
    expect(res.nosniff).toBe('nosniff')
  })

  test('413s an evidence file over the size limit', async () => {
    const res = await rawRequest(
      port,
      `/api/tasks/${TASK_ID}/evidence/huge.png?project=${projectId}`,
    )
    expect(res.status).toBe(413)
  })

  test('404s an absent evidence file', async () => {
    const res = await rawRequest(
      port,
      `/api/tasks/${TASK_ID}/evidence/nope.png?project=${projectId}`,
    )
    expect(res.status).toBe(404)
  })

  test('404s a traversing evidence file name', async () => {
    const encoded = await rawRequest(
      port,
      `/api/tasks/${TASK_ID}/evidence/..%2Fpackage.json?project=${projectId}`,
    )
    expect(encoded.status).toBe(404)
    const nested = await rawRequest(port, `/api/tasks/${TASK_ID}/evidence/a/b?project=${projectId}`)
    expect(nested.status).toBe(404)
  })
})

// GET /api/mrs beyond the default open state (D2 states beyond open). Kept in
// its own describe/repo rather than folded into the scoped describe above:
// this one asserts on the `state` argument itself, which the scoped describe's
// seam never records.
describe('GET /api/mrs state filter', () => {
  let repo: string
  let port: number
  let stop: () => Promise<void>
  let calls: { cwd: string; state: string | undefined }[]

  const STUB_MRS: ForgeMrsResult = { available: true, mrs: [], truncated: false }

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'codesema-mrs-state-repo-'))
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' })
    calls = []
    const started = await startServer(createSession(), {
      cwd: repo,
      port: 4970,
      listMrs: (cwd, state) => {
        calls.push({ cwd, state })
        return Promise.resolve(STUB_MRS)
      },
    })
    port = started.port
    stop = started.stop
  })

  afterAll(async () => {
    await stop()
    rmSync(repo, { recursive: true, force: true })
  })

  test('absent ?state= reaches the probe as undefined, the historical behavior', async () => {
    calls.length = 0
    const res = await rawRequest(port, '/api/mrs')
    expect(res.status).toBe(200)
    expect(calls).toEqual([{ cwd: repo, state: undefined }])
  })

  test.each(['open', 'merged', 'closed', 'all'])(
    'accepts state=%s and forwards it to the probe verbatim',
    async (state) => {
      calls.length = 0
      const res = await rawRequest(port, `/api/mrs?state=${state}`)
      expect(res.status).toBe(200)
      expect(calls).toEqual([{ cwd: repo, state }])
    },
  )

  test('rejects an unknown state value instead of silently falling back to the default', async () => {
    calls.length = 0
    const res = await rawRequest(port, '/api/mrs?state=bogus')
    expect(res.status).toBe(400)
    // Refused before the probe is ever asked: a caller requesting a state
    // this server does not recognise must not be silently served 'open'.
    expect(calls).toEqual([])
  })
})

describe('GET /api/reviews*', () => {
  let configDir: string
  let repo: string
  let projectId: string
  let port: number
  let stop: () => Promise<void>
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR

  function fakeRecord(
    branch: string,
    verdict: 'approve' | 'request_changes' | 'comment',
  ): ReviewRecord {
    const record = sanitizeRecord({
      meta: { branch, target: 'main' },
      review: { verdict, summary: 's' },
    })
    if (!record) {
      throw new Error('failed to build a fixture record')
    }
    return record
  }

  beforeAll(async () => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-reviews-config-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
    repo = mkdtempSync(join(tmpdir(), 'codesema-reviews-repo-'))
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' })
    const added = addProject(repo)
    if (!added.ok) {
      throw new Error('failed to register the test repo')
    }
    projectId = added.project.id

    archiveRecord(fakeRecord('feat/reviewed', 'approve'), repo)
    archiveRecord(fakeRecord('feat/other', 'request_changes'), repo)

    const started = await startServer(createSession(), { cwd: repo, port: 4980 })
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
    rmSync(configDir, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  test('GET /api/reviews/latest lists one summary per branch, 404s an unknown project', async () => {
    const res = await rawRequest(port, `/api/reviews/latest?project=${projectId}`)
    expect(res.status).toBe(200)
    const body = JSON.parse(res.body) as { latest: { branch: string; verdict: string }[] }
    const byBranch = new Map(body.latest.map((s) => [s.branch, s]))
    expect(byBranch.get('feat/reviewed')?.verdict).toBe('approve')
    expect(byBranch.get('feat/other')?.verdict).toBe('request_changes')

    expect((await rawRequest(port, '/api/reviews/latest?project=deadbeef')).status).toBe(404)
  })

  test('GET /api/reviews lists one branch history, 400s without ?branch=, 404s an unknown project', async () => {
    const ok = await rawRequest(port, `/api/reviews?project=${projectId}&branch=feat/reviewed`)
    expect(ok.status).toBe(200)
    const body = JSON.parse(ok.body) as { branch: string; entries: { branch: string }[] }
    expect(body.branch).toBe('feat/reviewed')
    expect(body.entries.length).toBeGreaterThan(0)
    expect(body.entries.every((e) => e.branch === 'feat/reviewed')).toBe(true)

    expect((await rawRequest(port, `/api/reviews?project=${projectId}`)).status).toBe(400)
    expect(
      (await rawRequest(port, `/api/reviews?project=deadbeef&branch=feat/reviewed`)).status,
    ).toBe(404)
  })

  test('GET /api/reviews/record serves one archive by ref, scoped to its own branch', async () => {
    const list = await rawRequest(port, `/api/reviews?project=${projectId}&branch=feat/reviewed`)
    const { entries } = JSON.parse(list.body) as { entries: { ref: string }[] }
    const ref = entries[0]?.ref
    expect(ref).toBeDefined()

    const ok = await rawRequest(
      port,
      `/api/reviews/record?project=${projectId}&branch=feat/reviewed&ref=${ref}`,
    )
    expect(ok.status).toBe(200)
    const record = JSON.parse(ok.body) as ReviewRecord
    expect(record.meta.branch).toBe('feat/reviewed')
    expect(record.review.verdict).toBe('approve')

    expect(
      (await rawRequest(port, `/api/reviews/record?project=${projectId}&branch=feat/reviewed`))
        .status,
    ).toBe(400)
    expect(
      (await rawRequest(port, `/api/reviews/record?project=${projectId}&ref=${ref}`)).status,
    ).toBe(400)

    // A ref that resolves fine but belongs to a DIFFERENT branch is refused.
    const wrongBranch = await rawRequest(
      port,
      `/api/reviews/record?project=${projectId}&branch=feat/other&ref=${ref}`,
    )
    expect(wrongBranch.status).toBe(404)

    const traversal = await rawRequest(
      port,
      `/api/reviews/record?project=${projectId}&branch=feat/reviewed&ref=${encodeURIComponent('../../etc/passwd')}`,
    )
    expect(traversal.status).toBe(404)

    expect(
      (
        await rawRequest(
          port,
          `/api/reviews/record?project=deadbeef&branch=feat/reviewed&ref=${ref}`,
        )
      ).status,
    ).toBe(404)
  })
})

describe('resolveDevViteOrigin', () => {
  test('is off unless CODESEMA_DEV_VITE says otherwise', () => {
    expect(resolveDevViteOrigin(undefined)).toBeUndefined()
    expect(resolveDevViteOrigin('')).toBeUndefined()
    expect(resolveDevViteOrigin('   ')).toBeUndefined()
  })

  test('accepts loopback dev servers and keeps only the origin', () => {
    expect(resolveDevViteOrigin('http://localhost:5173')).toBe('http://localhost:5173')
    expect(resolveDevViteOrigin('http://127.0.0.1:5173/')).toBe('http://127.0.0.1:5173')
    expect(resolveDevViteOrigin('http://localhost:5173/ignored/path')).toBe('http://localhost:5173')
  })

  test.each([
    'http://evil.example.com:5173',
    'http://localhost.evil.example.com:5173',
    'file:///tmp/x',
    'javascript:alert(1)',
    'localhost:5173',
    'not a url',
  ])('refuses %s rather than injecting it as a script source', (value) => {
    // The value lands in a <script src> on the served page, so anything that is
    // not a loopback http(s) origin is a remote script against the local server.
    expect(() => resolveDevViteOrigin(value)).toThrow()
  })
})

describe('devIndexHtml', () => {
  test('loads the Vite client and the app entry from the dev server', () => {
    const html = devIndexHtml('http://localhost:5173')
    expect(html).toContain(
      '<script type="module" src="http://localhost:5173/@vite/client"></script>',
    )
    expect(html).toContain(
      '<script type="module" src="http://localhost:5173/src/main.ts"></script>',
    )
  })

  test('mirrors the shell of packages/web/index.html', () => {
    // The two shells are kept in step by hand: if the real one grows a tag, this
    // fails instead of the dev page silently rendering something else.
    const source = readFileSync(
      fileURLToPath(new URL('../../web/index.html', import.meta.url)),
      'utf8',
    )
    const shell = (html: string) =>
      html
        .replace(/<script\b[^>]*><\/script>/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    expect(shell(devIndexHtml('http://localhost:5173'))).toBe(shell(source))
  })

  test('keeps the </head> anchor startServer injects the boot script into', () => {
    expect(devIndexHtml('http://localhost:5173')).toContain('</head>')
  })
})

describe('startServer in dev mode', () => {
  let port: number
  let stop: () => Promise<void>
  let repoDir: string
  const previousDevVite = process.env.CODESEMA_DEV_VITE

  beforeAll(async () => {
    repoDir = mkdtempSync(join(tmpdir(), 'codesema-serve-dev-'))
    process.env.CODESEMA_DEV_VITE = 'http://localhost:5173'
    const started = await startServer(createSession(), { cwd: repoDir, port: 4931 })
    port = started.port
    stop = started.stop
  })

  afterAll(async () => {
    await stop()
    if (previousDevVite === undefined) {
      delete process.env.CODESEMA_DEV_VITE
    } else {
      process.env.CODESEMA_DEV_VITE = previousDevVite
    }
    rmSync(repoDir, { recursive: true, force: true })
  })

  test('serves the dev shell instead of the embedded bundle', async () => {
    const res = await rawRequest(port, '/')
    expect(res.status).toBe(200)
    expect(res.contentType).toBe('text/html; charset=utf-8')
    expect(res.body).toContain('http://localhost:5173/@vite/client')
    expect(res.body).not.toContain('/assets/')
  })

  test('still injects the boot script, so workspace mode survives HMR', async () => {
    const res = await rawRequest(port, '/')
    // Same injection as the bundled path: this is the whole point of letting the
    // CLI serve the page rather than proxying /api to Vite.
    expect(res.body).toContain('window.__CODESEMA_CONFIG_TOKEN__=')
    expect(res.body).toContain('window.__CODESEMA_LOCALE__=')
  })

  test('keeps /api on the CLI origin', async () => {
    // 202: no record yet. What matters is that the route answers from the same
    // origin as the page, so no proxy and no CORS are in the dev loop at all.
    const res = await rawRequest(port, '/api/review')
    expect(res.status).toBe(202)
  })
})
