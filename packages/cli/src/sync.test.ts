import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { loadGlobalConfig, saveGlobalConfig } from './config.js'
import type { ReviewRecord } from './contract.js'
import {
  autoPushReview,
  createWorkspace,
  deleteWorkspaceData,
  linkWorkspace,
  loadSyncCredentials,
  pushReview,
  syncBaseUrl,
} from './sync.js'

type Call = { url: string; init: RequestInit }

function fetchStub(status: number, body: unknown, calls: Call[]): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }) as typeof fetch
}

const record: ReviewRecord = {
  version: 1,
  meta: {
    title: 'Add sync',
    branch: 'feat/sync',
    target: 'main',
    merge_base: 'abc',
    head_sha: 'deadbeef',
    repo_root: '/repo',
    created_at: '2026-07-12T10:00:00.000Z',
  },
  commits: ['deadbeef'],
  diff: 'diff',
  review: { verdict: 'approve', summary: 'ok', findings: [], narrative: null },
}

describe('sync http client', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  const previousSyncUrl = process.env.CODESEMA_SYNC_URL
  let configDir: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-sync-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
    delete process.env.CODESEMA_SYNC_URL
  })

  afterEach(() => {
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
  })

  test('syncBaseUrl: env > config > default', () => {
    expect(syncBaseUrl()).toBe('https://codesema.com')
    saveGlobalConfig({ syncUrl: 'http://config:1' })
    expect(syncBaseUrl()).toBe('http://config:1')
    process.env.CODESEMA_SYNC_URL = 'http://env:2'
    expect(syncBaseUrl()).toBe('http://env:2')
  })

  test('createWorkspace stores credentials in the global config', async () => {
    const calls: Call[] = []
    const creds = await createWorkspace(
      fetchStub(200, { workspace_id: 'ws-1', secret: 's3cret' }, calls),
    )
    expect(calls[0]!.url).toBe('https://codesema.com/api/cli/workspaces')
    expect(creds).toEqual({ url: 'https://codesema.com', workspaceId: 'ws-1', secret: 's3cret' })
    expect(loadGlobalConfig()).toMatchObject({ syncWorkspaceId: 'ws-1', syncSecret: 's3cret' })
  })

  test('createWorkspace pins the base URL used at creation', async () => {
    process.env.CODESEMA_SYNC_URL = 'http://staging:9080'
    await createWorkspace(fetchStub(200, { workspace_id: 'ws-1', secret: 's3cret' }, []))
    delete process.env.CODESEMA_SYNC_URL
    expect(loadGlobalConfig().syncUrl).toBe('http://staging:9080')
    expect(loadSyncCredentials()).toEqual({
      url: 'http://staging:9080',
      workspaceId: 'ws-1',
      secret: 's3cret',
    })
  })

  test('credentials stay bound to their creation host when the env later changes', async () => {
    await createWorkspace(fetchStub(200, { workspace_id: 'ws-1', secret: 's3cret' }, []))
    process.env.CODESEMA_SYNC_URL = 'http://other-host:1'
    expect(loadSyncCredentials()?.url).toBe('https://codesema.com')
  })

  test('legacy credentials without a stored url fall back to the resolved base url', () => {
    saveGlobalConfig({ syncWorkspaceId: 'ws-1', syncSecret: 's3cret' })
    process.env.CODESEMA_SYNC_URL = 'http://env:2'
    expect(loadSyncCredentials()?.url).toBe('http://env:2')
  })

  test('a malformed 2xx creation response fails instead of storing broken credentials', async () => {
    await expect(createWorkspace(fetchStub(200, {}, []))).rejects.toThrow(
      'unexpected response from',
    )
    expect(loadGlobalConfig().syncWorkspaceId).toBeUndefined()
    expect(loadGlobalConfig().syncSecret).toBeUndefined()
  })

  test('a creation response with empty fields is rejected too', async () => {
    await expect(
      createWorkspace(fetchStub(200, { workspace_id: '', secret: '' }, [])),
    ).rejects.toThrow('unexpected response from')
  })

  test('autoPushReview: disabled without stored credentials, no request goes out', async () => {
    const calls: Call[] = []
    const outcome = await autoPushReview(record, configDir, fetchStub(200, {}, calls))
    expect(outcome).toEqual({ status: 'disabled' })
    expect(calls).toHaveLength(0)
  })

  test('autoPushReview: credentials without the auto-push opt-in stay local', async () => {
    saveGlobalConfig({ syncWorkspaceId: 'ws-1', syncSecret: 's3cret' })
    const calls: Call[] = []
    const outcome = await autoPushReview(record, configDir, fetchStub(200, {}, calls))
    expect(outcome).toEqual({ status: 'disabled' })
    expect(calls).toHaveLength(0)
  })

  test('autoPushReview: pushes the fresh review with the workspace bearer token', async () => {
    saveGlobalConfig({ syncWorkspaceId: 'ws-1', syncSecret: 's3cret', syncAutoPush: true })
    const calls: Call[] = []
    const outcome = await autoPushReview(
      record,
      configDir,
      fetchStub(200, { review_id: 'r1', deduplicated: false }, calls),
    )
    expect(outcome).toEqual({ status: 'pushed', deduplicated: false })
    expect(calls[0]!.url).toContain('/api/cli/reviews')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer csk_ws-1.s3cret')
  })

  test('autoPushReview: reports dedup when the server already holds the review', async () => {
    saveGlobalConfig({ syncWorkspaceId: 'ws-1', syncSecret: 's3cret', syncAutoPush: true })
    const outcome = await autoPushReview(
      record,
      configDir,
      fetchStub(200, { review_id: 'r1', deduplicated: true }, []),
    )
    expect(outcome).toEqual({ status: 'pushed', deduplicated: true })
  })

  test('autoPushReview: a diff carrying a secret is held back, nothing leaves the machine', async () => {
    saveGlobalConfig({ syncWorkspaceId: 'ws-1', syncSecret: 's3cret', syncAutoPush: true })
    const calls: Call[] = []
    const secretDiff =
      'diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -0,0 +1 @@\n+AWS_SECRET=1\n'
    const outcome = await autoPushReview(
      { ...record, diff: secretDiff },
      configDir,
      fetchStub(200, {}, calls),
    )
    expect(outcome.status).toBe('blocked_secrets')
    expect(calls).toHaveLength(0)
  })

  test('autoPushReview: a server failure reports without throwing', async () => {
    saveGlobalConfig({ syncWorkspaceId: 'ws-1', syncSecret: 's3cret', syncAutoPush: true })
    const outcome = await autoPushReview(record, configDir, fetchStub(500, { error: 'boom' }, []))
    expect(outcome).toEqual({ status: 'failed', message: 'boom' })
  })

  test('pushReview sends the bearer token and the ingest payload', async () => {
    const calls: Call[] = []
    const result = await pushReview(
      { record, remoteUrl: 'git@gitlab.com:acme/api.git', repoName: 'api' },
      { url: 'https://codesema.com', workspaceId: 'ws-1', secret: 's3cret' },
      fetchStub(200, { review_id: 'r1', deduplicated: false }, calls),
    )
    expect(result).toEqual({ review_id: 'r1', deduplicated: false })
    expect(calls[0]!.url).toBe('https://codesema.com/api/cli/reviews')
    const headers = calls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer csk_ws-1.s3cret')
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      schema_version: number
      repo: { remote_url: string }
    }
    expect(body.schema_version).toBe(1)
    expect(body.repo.remote_url).toBe('git@gitlab.com:acme/api.git')
  })

  test('pushReview strips the local repo path from the payload', async () => {
    const calls: Call[] = []
    await pushReview(
      { record, remoteUrl: null, repoName: 'api' },
      { url: 'https://codesema.com', workspaceId: 'ws-1', secret: 's3cret' },
      fetchStub(200, { review_id: 'r1', deduplicated: false }, calls),
    )
    const body = JSON.parse(String(calls[0]!.init.body)) as { record: ReviewRecord }
    expect(body.record.meta.repo_root).toBe('')
    expect(record.meta.repo_root).toBe('/repo')
  })

  test('pushReview rejects a 2xx response missing the result fields', async () => {
    await expect(
      pushReview(
        { record, remoteUrl: null, repoName: 'api' },
        { url: 'https://codesema.com', workspaceId: 'ws-1', secret: 's3cret' },
        fetchStub(200, { review_id: 'r1' }, []),
      ),
    ).rejects.toThrow('unexpected response from')
  })

  test('linkWorkspace rejects a 2xx response missing tenant_id', async () => {
    await expect(
      linkWorkspace(
        'ABCD2345',
        { url: 'https://codesema.com', workspaceId: 'ws-1', secret: 's3cret' },
        fetchStub(200, {}, []),
      ),
    ).rejects.toThrow('unexpected response from')
  })

  test('linkWorkspace posts the pairing code', async () => {
    const calls: Call[] = []
    const result = await linkWorkspace(
      'ABCD2345',
      { url: 'https://codesema.com', workspaceId: 'ws-1', secret: 's3cret' },
      fetchStub(200, { tenant_id: 't-1' }, calls),
    )
    expect(result).toEqual({ tenant_id: 't-1' })
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ code: 'ABCD2345' })
  })

  test('deleteWorkspaceData clears stored credentials on success', async () => {
    saveGlobalConfig({ syncWorkspaceId: 'ws-1', syncSecret: 's3cret', syncAutoPush: true })
    await deleteWorkspaceData(
      { url: 'https://codesema.com', workspaceId: 'ws-1', secret: 's3cret' },
      fetchStub(200, { ok: true }, []),
    )
    const config = loadGlobalConfig()
    expect(config.syncWorkspaceId).toBeUndefined()
    expect(config.syncSecret).toBeUndefined()
  })

  test('deleteWorkspaceData keeps credentials when the server does not confirm', async () => {
    saveGlobalConfig({ syncWorkspaceId: 'ws-1', syncSecret: 's3cret', syncAutoPush: true })
    await expect(
      deleteWorkspaceData(
        { url: 'https://codesema.com', workspaceId: 'ws-1', secret: 's3cret' },
        fetchStub(200, { ok: false }, []),
      ),
    ).rejects.toThrow('unexpected response from')
    expect(loadGlobalConfig()).toMatchObject({ syncWorkspaceId: 'ws-1', syncSecret: 's3cret' })
  })

  test('an http error surfaces the server message', async () => {
    await expect(
      linkWorkspace(
        'BAD',
        { url: 'https://codesema.com', workspaceId: 'ws-1', secret: 's3cret' },
        fetchStub(404, { error: 'invalid or expired pairing code' }, []),
      ),
    ).rejects.toThrow('invalid or expired pairing code')
  })
})
