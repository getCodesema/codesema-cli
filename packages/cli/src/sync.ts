import { basename } from 'node:path'
import { loadGlobalConfig, saveGlobalConfig } from './config.js'
import { detectDiffSecrets, type ReviewRecord, type SecretMatch } from './contract.js'
import { repoRoot, tryGit } from './git.js'
import { t } from './i18n.js'
import { resolveRecord } from './record.js'
import { isInteractive, select } from './tui.js'
import { GREEN, bold, dim, paint, renderFieldRows, type FieldRow } from './ui.js'

/**
 * bkctl-style operation result: a blank line, a status line, an indented detail
 * block. No trailing blank: separation from whatever follows (menu redraw, hint
 * line, shell prompt) is owned by the caller, so loops never double up.
 */
function printOperationResult(statusMessage: string, rows: FieldRow[]): void {
  console.log('')
  console.log(`  ${paint('✔', GREEN)} ${statusMessage}`)
  for (const line of renderFieldRows(rows)) console.log(`  ${line}`)
}

// The diff carried by a review record is uploaded verbatim on sync. A committed
// secret would leave the machine, so hold it back and let the user decide.
function secretsBlockedMessage(matches: SecretMatch[]): string {
  const lines = matches.map(
    (m) => `    - ${m.file}  (${m.reason === 'filename' ? t('sync.secretFilenameTag') : m.detail})`,
  )
  return [t('sync.secretsBlocked'), ...lines, `  ${t('sync.secretsHint')}`].join('\n')
}

const DEFAULT_SYNC_URL = 'https://codesema.com'

export type SyncCredentials = { url: string; workspaceId: string; secret: string }
export type PushResult = { review_id: string; deduplicated: boolean }

export function syncBaseUrl(): string {
  return process.env.CODESEMA_SYNC_URL || loadGlobalConfig().syncUrl || DEFAULT_SYNC_URL
}

export function loadSyncCredentials(): SyncCredentials | null {
  const config = loadGlobalConfig()
  if (!config.syncWorkspaceId || !config.syncSecret) return null
  // The secret is a bearer token: it is only ever sent to the host it was
  // created against (stored syncUrl), so a later CODESEMA_SYNC_URL change
  // cannot redirect it to another server. Credentials saved before the URL
  // was persisted fall back to the resolved base URL.
  return { url: config.syncUrl || syncBaseUrl(), workspaceId: config.syncWorkspaceId, secret: config.syncSecret }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

async function api<T>(
  url: string,
  init: RequestInit,
  parse: (body: Record<string, unknown>) => T | null,
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
  const parsed = parse(body)
  if (parsed === null) throw new Error(t('sync.badResponse', { url }))
  return parsed
}

function authHeader(creds: SyncCredentials): Record<string, string> {
  return { authorization: `Bearer csk_${creds.workspaceId}.${creds.secret}` }
}

export async function createWorkspace(fetchImpl: typeof fetch = fetch): Promise<SyncCredentials> {
  const url = syncBaseUrl()
  const body = await api(
    `${url}/api/cli/workspaces`,
    { method: 'POST' },
    (raw) =>
      nonEmptyString(raw.workspace_id) && nonEmptyString(raw.secret)
        ? { workspaceId: raw.workspace_id, secret: raw.secret }
        : null,
    fetchImpl,
  )
  saveGlobalConfig({ ...loadGlobalConfig(), syncUrl: url, syncWorkspaceId: body.workspaceId, syncSecret: body.secret })
  return { url, workspaceId: body.workspaceId, secret: body.secret }
}

export async function pushReview(
  input: { record: ReviewRecord; remoteUrl: string | null; repoName: string },
  creds: SyncCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<PushResult> {
  return api(
    `${creds.url}/api/cli/reviews`,
    {
      method: 'POST',
      headers: authHeader(creds),
      body: JSON.stringify({
        schema_version: 1,
        repo: { remote_url: input.remoteUrl, name: input.repoName },
        // repo_root is the user's absolute local path (home dir, username):
        // useful in the local archive, never sent over the wire.
        record: { ...input.record, meta: { ...input.record.meta, repo_root: '' } },
      }),
    },
    (raw) =>
      nonEmptyString(raw.review_id) && typeof raw.deduplicated === 'boolean'
        ? { review_id: raw.review_id, deduplicated: raw.deduplicated }
        : null,
    fetchImpl,
  )
}

export async function linkWorkspace(
  code: string,
  creds: SyncCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<{ tenant_id: string }> {
  return api(
    `${creds.url}/api/cli/link`,
    { method: 'POST', headers: authHeader(creds), body: JSON.stringify({ code }) },
    (raw) => (nonEmptyString(raw.tenant_id) ? { tenant_id: raw.tenant_id } : null),
    fetchImpl,
  )
}

export async function deleteWorkspaceData(
  creds: SyncCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await api(
    `${creds.url}/api/cli/workspaces`,
    { method: 'DELETE', headers: authHeader(creds) },
    (raw) => (raw.ok === true ? { ok: true as const } : null),
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

// Deleting remote data is irreversible: every interactive path (menu or direct
// `codesema sync delete`) confirms first; non-interactive runs stay scriptable.
async function confirmSyncDelete(): Promise<boolean> {
  if (!isInteractive()) return true
  const choice = await select<'cancel' | 'delete'>({
    title: t('menu.syncDeleteConfirm'),
    options: [
      { label: t('menu.syncDeleteConfirmCancel'), hint: '', value: 'cancel' },
      { label: t('menu.syncDeleteConfirmDelete'), hint: t('menu.syncDeleteConfirmDeleteHint'), value: 'delete' },
    ],
    initialIndex: 0,
    summary: false,
  })
  return choice === 'delete'
}

export async function syncCommand(opts: { action?: string; cwd: string; force?: boolean }): Promise<void> {
  if (opts.action === 'delete') {
    const creds = loadSyncCredentials()
    if (!creds) throw new Error(t('sync.noCredentials'))
    if (!(await confirmSyncDelete())) return
    await deleteWorkspaceData(creds)
    printOperationResult(t('sync.deleted'), [])
    return
  }
  if (opts.action !== undefined) {
    throw new Error(t('sync.unknownAction', { action: opts.action }))
  }
  const cwd = repoRoot(opts.cwd)
  const { record } = resolveRecord({ cwd })
  const secrets = detectDiffSecrets(record.diff)
  if (secrets.length > 0 && !opts.force) {
    throw new Error(secretsBlockedMessage(secrets))
  }
  const creds = await ensureCredentials()
  if (!creds) {
    console.log(`  ${t('sync.aborted')}`)
    return
  }
  if (secrets.length > 0) console.log(`  ${dim(t('sync.secretsForced'))}`)
  const remoteUrl = tryGit(['remote', 'get-url', 'origin'], cwd)
  const result = await pushReview({ record, remoteUrl, repoName: basename(cwd) }, creds)
  const doneKey = result.deduplicated ? 'sync.alreadySynced' : 'sync.pushed'
  printOperationResult(t(doneKey, { branch: record.meta.branch }), [
    { label: t('field.branch'), value: record.meta.branch },
    { label: t('field.status'), value: result.deduplicated ? t('sync.statusExisting') : t('sync.statusNew') },
  ])
  console.log('')
  console.log(`  ${dim(t('sync.linkHint'))}`)
}

export async function linkCommand(opts: { code?: string }): Promise<void> {
  if (!opts.code) throw new Error(t('sync.linkUsage'))
  const creds = loadSyncCredentials()
  if (!creds) throw new Error(t('sync.noCredentials'))
  const { tenant_id } = await linkWorkspace(opts.code, creds)
  printOperationResult(t('sync.linked', { url: creds.url }), [{ label: t('field.account'), value: tenant_id }])
}
