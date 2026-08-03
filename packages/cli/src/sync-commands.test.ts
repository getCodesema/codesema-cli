import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { loadGlobalConfig, saveGlobalConfig } from './config.js'
import type { ReviewRecord } from './contract.js'
import { subprocessEnv } from './git.js'
import { t } from './i18n.js'
import { linkCommand, syncCommand } from './sync.js'

const PAIRING_CODE = 'ABCD2345'
const LINK_REQUEST_CODE = 'LNKR2345'
const AUTH_PATTERN = /^Bearer csk_[^.]+\.[^.]+$/

type RecordedRequest = {
  method: string
  path: string
  headers: Record<string, string>
  body: unknown
}

type StubServer = {
  url: string
  requests: RecordedRequest[]
  /** Poll answers for GET /api/cli/link-requests/:code; the last one repeats. */
  linkRequestStatuses: string[]
  close: () => Promise<void>
}

function readRequestBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(raw))
      } catch {
        resolve(undefined)
      }
    })
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * Mirrors the Phase 1 `/api/cli` contract closely enough to exercise the CLI's
 * command layer end to end: real in-memory review dedup keyed on
 * branch+head_sha+content hash (commits+diff+review), and a bearer-token
 * shape check on every workspace-authenticated route.
 */
function startStubServer(): Promise<StubServer> {
  const requests: RecordedRequest[] = []
  const dedupedKeys = new Set<string>()
  let reviewCounter = 0
  const linkRequestStatuses = ['pending', 'confirmed']

  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readRequestBody(req)
      const path = new URL(req.url ?? '/', 'http://stub.local').pathname
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key] = Array.isArray(value) ? value.join(',') : (value ?? '')
      }
      requests.push({ method: req.method ?? '', path, headers, body })
      const authorized = AUTH_PATTERN.test(headers.authorization ?? '')

      if (req.method === 'POST' && path === '/api/cli/workspaces') {
        sendJson(res, 200, { workspace_id: 'ws-stub-1', secret: 'secret-stub-1' })
        return
      }

      if (req.method === 'POST' && path === '/api/cli/reviews') {
        if (!authorized) {
          sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        const payload = body as {
          record?: {
            commits?: ReviewRecord['commits']
            diff?: ReviewRecord['diff']
            review?: ReviewRecord['review']
            meta?: { branch?: string; head_sha?: string }
          }
        }
        const meta = payload.record?.meta ?? {}
        const contentHash = createHash('sha256')
          .update(
            JSON.stringify({
              commits: payload.record?.commits,
              diff: payload.record?.diff,
              review: payload.record?.review,
            }),
          )
          .digest('hex')
        const key = `${meta.branch ?? ''}|${meta.head_sha ?? ''}|${contentHash}`
        const deduplicated = dedupedKeys.has(key)
        dedupedKeys.add(key)
        reviewCounter += 1
        sendJson(res, 200, { review_id: `review-${reviewCounter}`, deduplicated })
        return
      }

      if (req.method === 'POST' && path === '/api/cli/link-requests') {
        if (!authorized) {
          sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        sendJson(res, 200, {
          code: LINK_REQUEST_CODE,
          verify_url: `http://dashboard.stub.local/link-cli?code=${LINK_REQUEST_CODE}`,
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        })
        return
      }

      if (req.method === 'GET' && path === `/api/cli/link-requests/${LINK_REQUEST_CODE}`) {
        if (!authorized) {
          sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        const status =
          linkRequestStatuses.length > 1 ? linkRequestStatuses.shift() : linkRequestStatuses[0]
        sendJson(res, 200, { status })
        return
      }

      if (req.method === 'POST' && path === '/api/cli/link') {
        if (!authorized) {
          sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        const payload = body as { code?: string }
        if (payload.code === PAIRING_CODE) {
          sendJson(res, 200, { tenant_id: 'tenant-stub-1' })
        } else {
          sendJson(res, 404, { error: 'invalid or expired pairing code' })
        }
        return
      }

      if (req.method === 'DELETE' && path === '/api/cli/workspaces') {
        if (!authorized) {
          sendJson(res, 401, { error: 'unauthorized' })
          return
        }
        sendJson(res, 200, { ok: true })
        return
      }

      sendJson(res, 404, { error: `no stub route for ${req.method ?? ''} ${path}` })
    })()
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        linkRequestStatuses,
        close: () => new Promise((res) => server.close(() => res())),
      })
    })
  })
}

function runGit(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: subprocessEnv() })
}

async function withoutTTY(run: () => Promise<void>): Promise<void> {
  const previousStdinIsTTY = process.stdin.isTTY
  const previousStdoutIsTTY = process.stdout.isTTY
  process.stdin.isTTY = false
  process.stdout.isTTY = false
  try {
    await run()
  } finally {
    process.stdin.isTTY = previousStdinIsTTY
    process.stdout.isTTY = previousStdoutIsTTY
  }
}

type ArchivedRepo = { repoDir: string; remoteUrl: string; record: ReviewRecord }

function makeRepoWithArchivedReview(): ArchivedRepo {
  const repoDir = mkdtempSync(join(tmpdir(), 'codesema-sync-repo-'))
  const remoteUrl = 'git@github.com:acme/widgets.git'
  runGit(['init', '--initial-branch=main'], repoDir)
  runGit(['config', 'user.email', 'test@example.com'], repoDir)
  runGit(['config', 'user.name', 'Codesema Test'], repoDir)
  runGit(['remote', 'add', 'origin', remoteUrl], repoDir)
  writeFileSync(join(repoDir, 'README.md'), '# widgets\n')
  runGit(['add', 'README.md'], repoDir)
  runGit(['commit', '-m', 'chore: init'], repoDir)

  const record: ReviewRecord = {
    version: 1,
    meta: {
      title: 'Add widget sync',
      branch: 'feat/x',
      target: 'main',
      merge_base: 'basecommit0000',
      head_sha: 'deadbeef123',
      repo_root: repoDir,
      created_at: '2026-07-13T10:00:00.000Z',
    },
    commits: ['deadbeef123'],
    diff: '--- a/widget.ts\n+++ b/widget.ts\n',
    review: { verdict: 'approve', summary: 'looks good', findings: [], narrative: null },
  }

  const reviewsDir = join(repoDir, '.codesema', 'reviews')
  mkdirSync(reviewsDir, { recursive: true })
  writeFileSync(join(reviewsDir, 'feat-x-20260713-100000.json'), JSON.stringify(record, null, 2))

  return { repoDir, remoteUrl, record }
}

function setArchivedDiff(repoDir: string, diff: string): void {
  const archivePath = join(repoDir, '.codesema', 'reviews', 'feat-x-20260713-100000.json')
  const archived = JSON.parse(readFileSync(archivePath, 'utf8')) as ReviewRecord
  archived.diff = diff
  writeFileSync(archivePath, JSON.stringify(archived, null, 2))
}

const SECRET_DIFF =
  'diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -0,0 +1 @@\n+AWS_SECRET=1\n'

describe('sync and link commands', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  const previousSyncUrl = process.env.CODESEMA_SYNC_URL
  let configDir: string
  let repoDir: string
  let stub: StubServer

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-sync-config-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
    stub = await startStubServer()
    process.env.CODESEMA_SYNC_URL = stub.url
    repoDir = makeRepoWithArchivedReview().repoDir
  })

  afterEach(async () => {
    await stub.close()
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
    if (previousSyncUrl === undefined) {
      delete process.env.CODESEMA_SYNC_URL
    } else {
      process.env.CODESEMA_SYNC_URL = previousSyncUrl
    }
    rmSync(configDir, { recursive: true, force: true })
    rmSync(repoDir, { recursive: true, force: true })
  })

  function seedCredentials(): void {
    saveGlobalConfig({
      ...loadGlobalConfig(),
      syncWorkspaceId: 'ws-seed-1',
      syncSecret: 'secret-seed-1',
    })
  }

  test('syncCommand pushes the archived review to the stub server', async () => {
    seedCredentials()

    await withoutTTY(async () => {
      await syncCommand({ cwd: repoDir })
    })

    const pushed = stub.requests.find((r) => r.method === 'POST' && r.path === '/api/cli/reviews')
    expect(pushed).toBeDefined()
    expect(pushed!.headers.authorization).toBe('Bearer csk_ws-seed-1.secret-seed-1')
    const payload = pushed!.body as {
      schema_version: number
      repo: { remote_url: string | null }
      record: { meta: { branch: string } }
    }
    expect(payload.schema_version).toBe(1)
    expect(payload.repo.remote_url).toBe('git@github.com:acme/widgets.git')
    expect(payload.record.meta.branch).toBe('feat/x')
  })

  test('syncCommand run twice reports dedup on the second push without throwing', async () => {
    seedCredentials()
    const logged: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => {
      logged.push(args.join(' '))
    }

    try {
      await withoutTTY(async () => {
        await syncCommand({ cwd: repoDir })
        await expect(syncCommand({ cwd: repoDir })).resolves.toBeUndefined()
      })
    } finally {
      console.log = originalLog
    }

    const pushes = stub.requests.filter((r) => r.method === 'POST' && r.path === '/api/cli/reviews')
    expect(pushes.length).toBe(2)
    const firstBody = pushes[0]!.body as {
      record: { meta: { branch: string; head_sha?: string; created_at: string } }
    }
    const secondBody = pushes[1]!.body as {
      record: { meta: { branch: string; head_sha?: string; created_at: string } }
    }
    expect(secondBody.record.meta).toEqual(firstBody.record.meta)
    expect(
      logged.some((line) => line.includes(t('sync.alreadySynced', { branch: 'feat/x' }))),
    ).toBe(true)
  })

  test('a re-push of the same review with a different created_at is reported as deduplicated', async () => {
    seedCredentials()
    const archivePath = join(repoDir, '.codesema', 'reviews', 'feat-x-20260713-100000.json')
    const logged: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => {
      logged.push(args.join(' '))
    }

    try {
      await withoutTTY(async () => {
        await syncCommand({ cwd: repoDir })

        const archived = JSON.parse(readFileSync(archivePath, 'utf8')) as ReviewRecord
        archived.meta.created_at = '2026-07-13T11:30:00.000Z'
        writeFileSync(archivePath, JSON.stringify(archived, null, 2))

        await syncCommand({ cwd: repoDir })
      })
    } finally {
      console.log = originalLog
    }

    const pushes = stub.requests.filter((r) => r.method === 'POST' && r.path === '/api/cli/reviews')
    expect(pushes.length).toBe(2)
    const firstBody = pushes[0]!.body as { record: { meta: { created_at: string } } }
    const secondBody = pushes[1]!.body as { record: { meta: { created_at: string } } }
    expect(secondBody.record.meta.created_at).not.toBe(firstBody.record.meta.created_at)
    expect(
      logged.some((line) => line.includes(t('sync.alreadySynced', { branch: 'feat/x' }))),
    ).toBe(true)
  })

  test('syncCommand without credentials and without a TTY throws the non-interactive setup error', async () => {
    await withoutTTY(async () => {
      await expect(syncCommand({ cwd: repoDir })).rejects.toThrow(t('sync.nonInteractiveSetup'))
    })
    const pushed = stub.requests.find((r) => r.path === '/api/cli/reviews')
    expect(pushed).toBeUndefined()
  })

  test('linkCommand posts the pairing code with the workspace token', async () => {
    seedCredentials()

    await linkCommand({ code: PAIRING_CODE })

    const linked = stub.requests.find((r) => r.method === 'POST' && r.path === '/api/cli/link')
    expect(linked).toBeDefined()
    expect(linked!.headers.authorization).toBe('Bearer csk_ws-seed-1.secret-seed-1')
    expect(linked!.body).toEqual({ code: PAIRING_CODE })
  })

  test('linkCommand prints the workspace url once, not duplicated across the status line and a field row', async () => {
    seedCredentials()
    const logged: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => {
      logged.push(args.join(' '))
    }

    try {
      await linkCommand({ code: PAIRING_CODE })
    } finally {
      console.log = originalLog
    }

    const occurrences = logged.filter((line) => line.includes(stub.url)).length
    expect(occurrences).toBe(1)
  })

  test('linkCommand surfaces the server error message for a wrong code', async () => {
    seedCredentials()

    await expect(linkCommand({ code: 'WRONGCODE' })).rejects.toThrow(
      'invalid or expired pairing code',
    )
  })

  test('linkCommand without a code opens the browser page and polls until confirmed', async () => {
    seedCredentials()
    const opened: string[] = []

    await linkCommand({ openUrl: (url) => opened.push(url), pollIntervalMs: 5 })

    expect(opened).toEqual([`http://dashboard.stub.local/link-cli?code=${LINK_REQUEST_CODE}`])
    const created = stub.requests.find(
      (r) => r.method === 'POST' && r.path === '/api/cli/link-requests',
    )
    expect(created).toBeDefined()
    expect(created!.headers.authorization).toBe('Bearer csk_ws-seed-1.secret-seed-1')
    const polls = stub.requests.filter(
      (r) => r.method === 'GET' && r.path === `/api/cli/link-requests/${LINK_REQUEST_CODE}`,
    )
    expect(polls.length).toBeGreaterThanOrEqual(2)
  })

  test('linkCommand without a code fails cleanly when the request expires unconfirmed', async () => {
    seedCredentials()
    stub.linkRequestStatuses.length = 0
    stub.linkRequestStatuses.push('pending', 'expired')

    await expect(linkCommand({ openUrl: () => {}, pollIntervalMs: 5 })).rejects.toThrow(
      t('sync.linkExpired'),
    )
  })

  test('linkCommand without a code and without credentials refuses outside a TTY', async () => {
    await withoutTTY(async () => {
      await expect(linkCommand({ openUrl: () => {} })).rejects.toThrow(
        t('sync.nonInteractiveSetup'),
      )
    })
    expect(stub.requests.find((r) => r.path === '/api/cli/link-requests')).toBeUndefined()
  })

  test('syncCommand delete calls DELETE with the token and clears stored credentials', async () => {
    seedCredentials()

    await withoutTTY(() => syncCommand({ action: 'delete', cwd: repoDir }))

    const deleted = stub.requests.find(
      (r) => r.method === 'DELETE' && r.path === '/api/cli/workspaces',
    )
    expect(deleted).toBeDefined()
    expect(deleted!.headers.authorization).toBe('Bearer csk_ws-seed-1.secret-seed-1')
    const config = loadGlobalConfig()
    expect(config.syncWorkspaceId).toBeUndefined()
    expect(config.syncSecret).toBeUndefined()
  })

  test('an unknown sync action throws', async () => {
    await expect(syncCommand({ action: 'wat', cwd: repoDir })).rejects.toThrow(
      t('sync.unknownAction', { action: 'wat' }),
    )
  })

  test('syncCommand refuses to push a diff that looks like it holds secrets', async () => {
    seedCredentials()
    setArchivedDiff(repoDir, SECRET_DIFF)

    await expect(syncCommand({ cwd: repoDir })).rejects.toThrow(t('sync.secretsBlocked'))

    const pushed = stub.requests.find((r) => r.path === '/api/cli/reviews')
    expect(pushed).toBeUndefined()
  })

  test('syncCommand --force pushes a diff with secrets anyway', async () => {
    seedCredentials()
    setArchivedDiff(repoDir, SECRET_DIFF)

    await withoutTTY(async () => {
      await syncCommand({ cwd: repoDir, force: true })
    })

    const pushed = stub.requests.find((r) => r.method === 'POST' && r.path === '/api/cli/reviews')
    expect(pushed).toBeDefined()
  })
})
