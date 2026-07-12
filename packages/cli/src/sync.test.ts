import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadGlobalConfig, saveGlobalConfig } from './config.js'
import { createWorkspace, deleteWorkspaceData, linkWorkspace, pushReview, syncBaseUrl } from './sync.js'
import type { ReviewRecord } from './contract.js'

type Call = { url: string; init: RequestInit }

function fetchStub(status: number, body: unknown, calls: Call[]): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
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
    if (previousConfigDir === undefined) delete process.env.CODESEMA_CONFIG_DIR
    else process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    if (previousSyncUrl === undefined) delete process.env.CODESEMA_SYNC_URL
    else process.env.CODESEMA_SYNC_URL = previousSyncUrl
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
    const creds = await createWorkspace(fetchStub(200, { workspace_id: 'ws-1', secret: 's3cret' }, calls))
    expect(calls[0]!.url).toBe('https://codesema.com/api/cli/workspaces')
    expect(creds).toEqual({ url: 'https://codesema.com', workspaceId: 'ws-1', secret: 's3cret' })
    expect(loadGlobalConfig()).toMatchObject({ syncWorkspaceId: 'ws-1', syncSecret: 's3cret' })
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
    const body = JSON.parse(String(calls[0]!.init.body)) as { schema_version: number; repo: { remote_url: string } }
    expect(body.schema_version).toBe(1)
    expect(body.repo.remote_url).toBe('git@gitlab.com:acme/api.git')
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
    saveGlobalConfig({ syncWorkspaceId: 'ws-1', syncSecret: 's3cret' })
    await deleteWorkspaceData(
      { url: 'https://codesema.com', workspaceId: 'ws-1', secret: 's3cret' },
      fetchStub(200, { ok: true }, []),
    )
    const config = loadGlobalConfig()
    expect(config.syncWorkspaceId).toBeUndefined()
    expect(config.syncSecret).toBeUndefined()
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
