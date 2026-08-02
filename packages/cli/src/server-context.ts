import { isAncestor } from './git.js'
import { authHeader, loadSyncCredentials } from './sync.js'

export type ServerConvention = {
  id: string
  rule: string
  category: string | null
  scope: string | null
}
export type ServerLearnedRule = { id: string; rule: string }

/**
 * Wire shape of `GET /api/cli/context`, frozen here: the server implements
 * the same shape (backend chunk C2 of the context API plan). Never trust a
 * partial match: parseServerContextPayload drops the whole payload rather
 * than forward a half-shaped context to the agent.
 */
export type ServerContextPayload = {
  version: 1
  repo: { remote_url: string | null }
  freshness: { scan_sha: string | null; scanned_at: string | null } | null
  conventions: ServerConvention[]
  learned_rules: ServerLearnedRule[]
  facts: string[]
}

/** What actually reaches the agent: the wire payload plus a locally computed staleness warning. */
export type ServerContext = ServerContextPayload & { stale_warning: string | null }

const SERVER_CONTEXT_TIMEOUT_MS = 3_000

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

function isNullableString(v: unknown): v is string | null {
  return v === null || isString(v)
}

function parseConvention(raw: unknown): ServerConvention | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  if (
    !isString(r.id) ||
    !isString(r.rule) ||
    !isNullableString(r.category) ||
    !isNullableString(r.scope)
  ) {
    return null
  }
  return { id: r.id, rule: r.rule, category: r.category, scope: r.scope }
}

function parseLearnedRule(raw: unknown): ServerLearnedRule | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  if (!isString(r.id) || !isString(r.rule)) {
    return null
  }
  return { id: r.id, rule: r.rule }
}

function parseFact(raw: unknown): string | null {
  return isString(raw) ? raw : null
}

function parseArray<T>(raw: unknown, parseItem: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(raw)) {
    return null
  }
  const items: T[] = []
  for (const item of raw) {
    const parsed = parseItem(item)
    if (parsed === null) {
      return null
    }
    items.push(parsed)
  }
  return items
}

/** Strict validation of the raw JSON body; any field out of shape rejects the whole payload. */
export function parseServerContextPayload(raw: unknown): ServerContextPayload | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  if (r.version !== 1) {
    return null
  }
  if (!r.repo || typeof r.repo !== 'object') {
    return null
  }
  const repo = r.repo as Record<string, unknown>
  if (!isNullableString(repo.remote_url)) {
    return null
  }

  let freshness: ServerContextPayload['freshness'] = null
  if (r.freshness !== null && r.freshness !== undefined) {
    if (typeof r.freshness !== 'object') {
      return null
    }
    const f = r.freshness as Record<string, unknown>
    if (!isNullableString(f.scan_sha) || !isNullableString(f.scanned_at)) {
      return null
    }
    freshness = { scan_sha: f.scan_sha, scanned_at: f.scanned_at }
  }

  const conventions = parseArray(r.conventions, parseConvention)
  const learnedRules = parseArray(r.learned_rules, parseLearnedRule)
  const facts = parseArray(r.facts, parseFact)
  if (conventions === null || learnedRules === null || facts === null) {
    return null
  }

  return {
    version: 1,
    repo: { remote_url: repo.remote_url },
    freshness,
    conventions,
    learned_rules: learnedRules,
    facts,
  }
}

/**
 * Best-effort GET, gated by loadSyncCredentials() exactly like pushReview: no
 * stored workspace credentials, no request. Any network error, non-200 or
 * malformed body silently degrades to null; this function never throws.
 */
async function fetchServerContextPayload(
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ServerContextPayload | null> {
  const creds = loadSyncCredentials()
  if (!creds) {
    return null
  }
  try {
    const res = await fetchImpl(`${creds.url}/api/cli/context`, {
      method: 'GET',
      headers: authHeader(creds),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      return null
    }
    const body = await res.json().catch(() => null)
    return parseServerContextPayload(body)
  } catch {
    return null
  }
}

/**
 * A stale context must present itself as stale: when the server's last scan
 * commit is not an ancestor of HEAD (including when it is unknown to this
 * local repo), every field below it is only advisory.
 */
function staleWarning(payload: ServerContextPayload, cwd: string): string | null {
  const sha = payload.freshness?.scan_sha
  if (!sha) {
    return null
  }
  if (isAncestor(sha, 'HEAD', cwd)) {
    return null
  }
  const scannedAt = payload.freshness?.scanned_at
  const scannedAtNote = scannedAt ? ` (scanned at ${scannedAt})` : ''
  return `STALE SERVER CONTEXT${scannedAtNote}: the last server scan is not an ancestor of the current HEAD. Treat conventions, learned_rules and facts below as possibly outdated, never as ground truth about the current diff.`
}

/**
 * Never blocking, never throwing: offline, unlinked workspace (403), a
 * non-200, a timeout or a malformed response all silently degrade to null,
 * same contract as autoPushReview (sync.ts). `.codesema/RULES.md` is loaded
 * and applied entirely separately (rules.ts) and always takes precedence.
 */
export async function buildServerContext(
  cwd: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = SERVER_CONTEXT_TIMEOUT_MS,
): Promise<ServerContext | null> {
  const payload = await fetchServerContextPayload(fetchImpl, timeoutMs)
  if (!payload) {
    return null
  }
  return { ...payload, stale_warning: staleWarning(payload, cwd) }
}
