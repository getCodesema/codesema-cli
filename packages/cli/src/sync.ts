import { basename } from 'node:path'
import { loadGlobalConfig, saveGlobalConfig } from './config.js'
import type { ReviewRecord } from './contract.js'
import { repoRoot, tryGit } from './git.js'
import { t } from './i18n.js'
import { resolveRecord } from './record.js'
import { isInteractive, select } from './tui.js'
import { ACCENT, GREEN, bold, dim, paint } from './ui.js'

const DEFAULT_SYNC_URL = 'https://codesema.com'

export type SyncCredentials = { url: string; workspaceId: string; secret: string }
export type PushResult = { review_id: string; deduplicated: boolean }

export function syncBaseUrl(): string {
  return process.env.CODESEMA_SYNC_URL || loadGlobalConfig().syncUrl || DEFAULT_SYNC_URL
}

export function loadSyncCredentials(): SyncCredentials | null {
  const config = loadGlobalConfig()
  if (!config.syncWorkspaceId || !config.syncSecret) return null
  return { url: syncBaseUrl(), workspaceId: config.syncWorkspaceId, secret: config.syncSecret }
}

async function api<T>(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
): Promise<T> {
  let res: Response
  try {
    res = await fetchImpl(url, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new Error(t('sync.unreachable', { url }))
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) {
    const message = typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
    throw new Error(message)
  }
  return body as T
}

function authHeader(creds: SyncCredentials): Record<string, string> {
  return { authorization: `Bearer csk_${creds.workspaceId}.${creds.secret}` }
}

export async function createWorkspace(fetchImpl: typeof fetch = fetch): Promise<SyncCredentials> {
  const url = syncBaseUrl()
  const body = await api<{ workspace_id: string; secret: string }>(
    `${url}/api/cli/workspaces`,
    { method: 'POST' },
    fetchImpl,
  )
  saveGlobalConfig({ ...loadGlobalConfig(), syncWorkspaceId: body.workspace_id, syncSecret: body.secret })
  return { url, workspaceId: body.workspace_id, secret: body.secret }
}

export async function pushReview(
  input: { record: ReviewRecord; remoteUrl: string | null; repoName: string },
  creds: SyncCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<PushResult> {
  return api<PushResult>(
    `${creds.url}/api/cli/reviews`,
    {
      method: 'POST',
      headers: authHeader(creds),
      body: JSON.stringify({
        schema_version: 1,
        repo: { remote_url: input.remoteUrl, name: input.repoName },
        record: input.record,
      }),
    },
    fetchImpl,
  )
}

export async function linkWorkspace(
  code: string,
  creds: SyncCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<{ tenant_id: string }> {
  return api<{ tenant_id: string }>(
    `${creds.url}/api/cli/link`,
    { method: 'POST', headers: authHeader(creds), body: JSON.stringify({ code }) },
    fetchImpl,
  )
}

export async function deleteWorkspaceData(
  creds: SyncCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await api<{ ok: true }>(
    `${creds.url}/api/cli/workspaces`,
    { method: 'DELETE', headers: authHeader(creds) },
    fetchImpl,
  )
  const { syncWorkspaceId: _id, syncSecret: _secret, ...rest } = loadGlobalConfig()
  saveGlobalConfig(rest)
}

// Sync is strictly opt-in: the first run explains what leaves the machine
// (the review record INCLUDING the diff) and asks for confirmation.
async function ensureCredentials(): Promise<SyncCredentials | null> {
  const existing = loadSyncCredentials()
  if (existing) return existing
  if (!isInteractive()) {
    throw new Error(t('sync.nonInteractiveSetup'))
  }
  console.log('')
  console.log(`  ${bold(t('sync.firstRunTitle'))}`)
  console.log(`  ${dim(t('sync.firstRunDetail', { url: syncBaseUrl() }))}`)
  const choice = await select<'yes' | 'no'>({
    title: t('sync.firstRunQuestion'),
    options: [
      { label: t('sync.firstRunCancel'), hint: '', value: 'no' },
      { label: t('sync.firstRunAccept'), hint: '', value: 'yes' },
    ],
    initialIndex: 0,
  })
  if (choice !== 'yes') return null
  return createWorkspace()
}

export async function syncCommand(opts: { action?: string; cwd: string }): Promise<void> {
  if (opts.action === 'delete') {
    const creds = loadSyncCredentials()
    if (!creds) throw new Error(t('sync.noCredentials'))
    await deleteWorkspaceData(creds)
    console.log(`  ${paint('✔', GREEN)} ${t('sync.deleted')}`)
    return
  }
  if (opts.action !== undefined) {
    throw new Error(t('sync.unknownAction', { action: opts.action }))
  }
  const cwd = repoRoot(opts.cwd)
  const { record } = resolveRecord({ cwd })
  const creds = await ensureCredentials()
  if (!creds) {
    console.log(`  ${t('sync.aborted')}`)
    return
  }
  const remoteUrl = tryGit(['remote', 'get-url', 'origin'], cwd)
  const result = await pushReview({ record, remoteUrl, repoName: basename(cwd) }, creds)
  const doneKey = result.deduplicated ? 'sync.alreadySynced' : 'sync.pushed'
  console.log(`  ${paint('✔', GREEN)} ${t(doneKey, { branch: record.meta.branch })}`)
  console.log(`  ${dim(t('sync.linkHint'))}`)
}

export async function linkCommand(opts: { code?: string }): Promise<void> {
  if (!opts.code) throw new Error(t('sync.linkUsage'))
  const creds = loadSyncCredentials()
  if (!creds) throw new Error(t('sync.noCredentials'))
  await linkWorkspace(opts.code, creds)
  console.log(`  ${paint('✔', GREEN)} ${t('sync.linked', { url: paint(creds.url, ACCENT) })}`)
}
