import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { loadGlobalConfig, saveGlobalConfig } from './config.js'
import { subprocessEnv } from './git.js'
import {
  buildServerContext,
  parseServerContextPayload,
  type ServerContextPayload,
} from './server-context.js'

const AUTH_PATTERN = /^Bearer csk_[^.]+\.[^.]+$/

type StubServer = {
  url: string
  requests: { path: string; search: URLSearchParams; headers: Record<string, string> }[]
  close: () => Promise<void>
}

/** GET /api/cli/context stub: a handler decides the response per test. */
function startStubServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<StubServer> {
  const requests: StubServer['requests'] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub.local')
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key] = Array.isArray(value) ? value.join(',') : (value ?? '')
    }
    requests.push({ path: url.pathname, search: url.searchParams, headers })
    handler(req, res)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((res) => server.close(() => res())),
      })
    })
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Same guard as git.ts's own subprocessEnv(): a pre-push hook (this CLI's own,
// including from a worktree) sets GIT_DIR/GIT_WORK_TREE, which would otherwise
// redirect these calls away from the throwaway `cwd` repo made in makeRepo().
function runGit(args: string[], cwd: string): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd,
    stdio: 'ignore',
    env: subprocessEnv(),
  })
}

function headSha(cwd: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    env: subprocessEnv(),
  }).trim()
}

const ORIGIN_REMOTE_URL = 'https://example.com/acme/widgets.git'

/** A repo with an `origin` remote by default: buildServerContext derives remote_url from it. */
function makeRepo(opts: { withRemote?: boolean } = {}): string {
  const repo = mkdtempSync(join(tmpdir(), 'codesema-context-repo-'))
  runGit(['init', '-b', 'main'], repo)
  runGit(['commit', '--allow-empty', '-m', 'chore: init'], repo)
  if (opts.withRemote !== false) {
    runGit(['remote', 'add', 'origin', ORIGIN_REMOTE_URL], repo)
  }
  return repo
}

const VALID_PAYLOAD: ServerContextPayload = {
  version: 1,
  repo: { remote_url: 'git@github.com:acme/widgets.git' },
  freshness: { scan_sha: null, scanned_at: null },
  conventions: [{ id: 'c1', rule: 'no any', category: 'types', scope: 'src/**' }],
  learned_rules: [{ id: 'l1', rule: 'prefer composables' }],
  facts: ['uses Elysia'],
}

describe('parseServerContextPayload', () => {
  test('accepts a well-shaped payload', () => {
    expect(parseServerContextPayload(VALID_PAYLOAD)).toEqual(VALID_PAYLOAD)
  })

  test('accepts a payload without freshness', () => {
    const payload = { ...VALID_PAYLOAD, freshness: null }
    expect(parseServerContextPayload(payload)).toEqual(payload)
  })

  const invalidPayloads: [string, unknown][] = [
    ['not an object', 'nope'],
    ['null', null],
    ['wrong version', { ...VALID_PAYLOAD, version: 2 }],
    ['missing repo', { ...VALID_PAYLOAD, repo: undefined }],
    ['non-string remote_url', { ...VALID_PAYLOAD, repo: { remote_url: 42 } }],
    ['conventions not an array', { ...VALID_PAYLOAD, conventions: 'x' }],
    [
      'a convention missing rule',
      { ...VALID_PAYLOAD, conventions: [{ id: 'c1', category: null, scope: null }] },
    ],
    ['a learned_rule missing id', { ...VALID_PAYLOAD, learned_rules: [{ rule: 'x' }] }],
    ['facts holding a non-string', { ...VALID_PAYLOAD, facts: ['ok', 42] }],
    [
      'freshness with a non-string scan_sha',
      { ...VALID_PAYLOAD, freshness: { scan_sha: 1, scanned_at: null } },
    ],
  ]
  for (const [label, raw] of invalidPayloads) {
    test(`rejects: ${label}`, () => {
      expect(parseServerContextPayload(raw)).toBeNull()
    })
  }
})

describe('buildServerContext', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string
  let repo: string
  let stub: StubServer | null

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-context-config-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
    repo = makeRepo()
    stub = null
  })

  afterEach(async () => {
    if (stub) {
      await stub.close()
    }
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
    rmSync(configDir, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  function seedCredentials(url: string): void {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncUrl: url,
      syncWorkspaceId: 'ws-1',
      syncSecret: 'secret-1',
    })
  }

  test('no stored credentials: no request goes out, degrades to null', async () => {
    let called = false
    stub = await startStubServer((_req, res) => {
      called = true
      sendJson(res, 200, VALID_PAYLOAD)
    })

    const context = await buildServerContext(repo, fetch)

    expect(context).toBeNull()
    expect(called).toBe(false)
  })

  test('nominal: authorized GET returns the payload with a null stale_warning when there is no freshness', async () => {
    stub = await startStubServer((_req, res) => sendJson(res, 200, VALID_PAYLOAD))
    seedCredentials(stub.url)

    const context = await buildServerContext(repo, fetch)

    expect(context).toEqual({ ...VALID_PAYLOAD, stale_warning: null })
    expect(stub.requests[0]?.path).toBe('/api/cli/context')
    expect(AUTH_PATTERN.test(stub.requests[0]?.headers.authorization ?? '')).toBe(true)
  })

  // The real route (GET /api/cli/context) resolves the repo by remote_url and
  // rejects the request without it: the CLI must send the origin remote it
  // already knows from prep, exactly like autoPushReview does for pushReview.
  test('sends the origin remote as a remote_url query param', async () => {
    stub = await startStubServer((_req, res) => sendJson(res, 200, VALID_PAYLOAD))
    seedCredentials(stub.url)

    await buildServerContext(repo, fetch)

    expect(stub.requests[0]?.path).toBe('/api/cli/context')
    expect(stub.requests[0]?.search.get('remote_url')).toBe(ORIGIN_REMOTE_URL)
  })

  test('no origin remote configured locally: no request goes out, degrades to null', async () => {
    const repoNoRemote = makeRepo({ withRemote: false })
    let called = false
    stub = await startStubServer((_req, res) => {
      called = true
      sendJson(res, 200, VALID_PAYLOAD)
    })
    seedCredentials(stub.url)

    try {
      const context = await buildServerContext(repoNoRemote, fetch)

      expect(context).toBeNull()
      expect(called).toBe(false)
    } finally {
      rmSync(repoNoRemote, { recursive: true, force: true })
    }
  })

  // The route's `remote_url` query param is required (t.String({ minLength: 1
  // })) and rejects an unresolved repo with a plain 400: same degrade-to-null
  // contract as the 403 unlinked-workspace case below, never a throw.
  test('400 from the server (e.g. missing or unresolved remote_url): degrades to null, never throws', async () => {
    stub = await startStubServer((_req, res) => sendJson(res, 400, { error: 'unknown repo' }))
    seedCredentials(stub.url)

    const context = await buildServerContext(repo, fetch)

    expect(context).toBeNull()
  })

  test('freshness ancestor of HEAD: no staleness warning', async () => {
    const sha = headSha(repo)
    const payload: ServerContextPayload = {
      ...VALID_PAYLOAD,
      freshness: { scan_sha: sha, scanned_at: '2026-08-01T00:00:00.000Z' },
    }
    stub = await startStubServer((_req, res) => sendJson(res, 200, payload))
    seedCredentials(stub.url)

    const context = await buildServerContext(repo, fetch)

    expect(context?.stale_warning).toBeNull()
  })

  test('403 on an unlinked workspace: degrades to null, never throws', async () => {
    stub = await startStubServer((_req, res) =>
      sendJson(res, 403, { error: 'workspace not linked' }),
    )
    seedCredentials(stub.url)

    const context = await buildServerContext(repo, fetch)

    expect(context).toBeNull()
  })

  test('network error (nothing listening): degrades to null, never throws', async () => {
    seedCredentials('http://127.0.0.1:1')

    const context = await buildServerContext(repo, fetch)

    expect(context).toBeNull()
  })

  test('stale sha (not an ancestor of HEAD): prefixes an explicit warning naming scanned_at', async () => {
    const payload: ServerContextPayload = {
      ...VALID_PAYLOAD,
      freshness: {
        scan_sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        scanned_at: '2026-07-30T09:00:00.000Z',
      },
    }
    stub = await startStubServer((_req, res) => sendJson(res, 200, payload))
    seedCredentials(stub.url)

    const context = await buildServerContext(repo, fetch)

    expect(context?.stale_warning).toContain('STALE')
    expect(context?.stale_warning).toContain('2026-07-30T09:00:00.000Z')
    // The rest of the context still reaches the agent, only flagged as advisory.
    expect(context?.conventions).toEqual(VALID_PAYLOAD.conventions)
  })

  test('a malformed 200 body degrades to null instead of forwarding a half-shaped context', async () => {
    stub = await startStubServer((_req, res) => sendJson(res, 200, { version: 1 }))
    seedCredentials(stub.url)

    const context = await buildServerContext(repo, fetch)

    expect(context).toBeNull()
  })

  test('timeout: a response slower than the deadline degrades to null, never hangs the review', async () => {
    stub = await startStubServer((_req, res) => {
      setTimeout(() => sendJson(res, 200, VALID_PAYLOAD), 200)
    })
    seedCredentials(stub.url)

    const context = await buildServerContext(repo, fetch, 20)

    expect(context).toBeNull()
  })
})
