// Typed HTTP client for the hub (the local SaaS that owns arm tickets).
// Same base URL and bearer credentials as codesema.com cloud sync (sync.ts):
// a hub and a sync workspace are the same account, on whichever host
// `codesema runner connect` (or `codesema sync`) last pointed at. Every method
// here returns a HubResult rather than throwing, so a caller (a command, a
// daemon tick) always decides for itself whether an error is worth retrying,
// without a try/catch of its own.

import {
  ARM_STATUS_MAX,
  sanitizeArmClaimResult,
  sanitizeArmTicket,
  sanitizeArmTicketRequest,
  sanitizeRunbookConfig,
  sanitizeRunbookScan,
  sanitizeRunbookValidation,
  sanitizeRunnerListEntry,
  sanitizeSealedSecretBlob,
  type ArmClaimResult,
  type ArmEvent,
  type ArmIssueRef,
  type ArmTicket,
  type ArmTicketRequest,
  type ArmTransition,
  type RunbookConfig,
  type RunbookScan,
  type RunbookValidation,
  type RunnerListEntry,
  type TaskVerification,
} from './contract.js'
import { tryGit } from './git.js'
import { runnerIdentityHeader } from './runner-identity.js'
import { authHeader, type SyncCredentials } from './sync.js'

const HUB_REQUEST_TIMEOUT_MS = 10_000

export type HubError =
  | { kind: 'http'; status: number; error: string }
  | { kind: 'network' }
  /**
   * A 404 on a route this client treats as always-present on a well-behaved
   * hub (a bare collection GET, which answers an empty list rather than
   * 404ing on "nothing found"): the hub reached is simply older than this
   * route. Never produced for a by-id lookup, where a 404 is a normal,
   * meaningful "not found" and stays a `kind: 'http'` error.
   */
  | { kind: 'unavailable' }

export type HubResult<T> = { ok: true; data: T } | { ok: false; error: HubError }

/** Same read as server-context.ts: raw, unnormalized; the hub normalizes it server-side. */
export function hubRemoteUrl(cwd: string): string | null {
  return tryGit(['remote', 'get-url', 'origin'], cwd)
}

export function hubErrorMessage(error: HubError): string {
  if (error.kind === 'network') {
    return 'could not reach the hub: check your connection or the hub URL'
  }
  if (error.kind === 'unavailable') {
    return 'this hub build does not support that route yet'
  }
  return `hub rejected the request (${error.status}): ${error.error}`
}

/**
 * `csk_<workspaceId>.<secret>`, the exact string `authHeader` (sync.ts)
 * builds. Split on the FIRST dot only, so a secret that itself carries a dot
 * is not truncated.
 */
export function parseHubToken(token: string): { workspaceId: string; secret: string } | null {
  const match = /^csk_([^.]+)\.(.+)$/s.exec(token.trim())
  if (!match) {
    return null
  }
  const [, workspaceId, secret] = match
  return workspaceId && secret ? { workspaceId, secret } : null
}

/** Same all-or-nothing doctrine as server-context.ts's `parseArray`: one bad item refuses the whole list. */
function sanitizeList<T>(
  body: unknown,
  key: string,
  sanitize: (raw: unknown) => T | null,
): T[] | null {
  if (!body || typeof body !== 'object') {
    return null
  }
  const raw = (body as Record<string, unknown>)[key]
  if (!Array.isArray(raw)) {
    return null
  }
  const items: T[] = []
  for (const entry of raw) {
    const parsed = sanitize(entry)
    if (parsed === null) {
      return null
    }
    items.push(parsed)
  }
  return items
}

function field(body: unknown, key: string): unknown {
  return body && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined
}

/** Every mutation whose response carries nothing this client needs back. */
function ack(): Record<string, never> {
  return {}
}

type RequestOptions<T> = {
  fetchImpl: typeof fetch
  /** See `HubError`'s `unavailable` doc: only a bare collection GET qualifies. */
  collectionRoute?: boolean
  /**
   * A route where a plain 404 means "nothing to report" rather than an
   * error (checking whether a claim is pending): resolves as
   * `{ ok: true, data: notFoundValue }` instead of a `kind: 'http'` error.
   * No route needs both this and `collectionRoute` at once.
   */
  notFoundValue?: T
}

type RequestSpec<T> = RequestOptions<T> & {
  method: string
  path: string
  body?: unknown
  parse: (body: unknown) => T | null
}

async function request<T>(creds: SyncCredentials, spec: RequestSpec<T>): Promise<HubResult<T>> {
  const { method, path, body, parse } = spec
  let res: Response
  try {
    res = await spec.fetchImpl(`${creds.url}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...authHeader(creds),
        ...runnerIdentityHeader(),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body ?? {}) }),
      signal: AbortSignal.timeout(HUB_REQUEST_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, error: { kind: 'network' } }
  }
  const parsedBody: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 404 && spec.collectionRoute) {
      return { ok: false, error: { kind: 'unavailable' } }
    }
    if (res.status === 404 && spec.notFoundValue !== undefined) {
      return { ok: true, data: spec.notFoundValue }
    }
    const errorField = field(parsedBody, 'error')
    const message = typeof errorField === 'string' ? errorField : `HTTP ${res.status}`
    return { ok: false, error: { kind: 'http', status: res.status, error: message } }
  }
  const parsed = parse(parsedBody)
  if (parsed === null) {
    return {
      ok: false,
      error: { kind: 'http', status: res.status, error: 'malformed response body' },
    }
  }
  return { ok: true, data: parsed }
}

export async function listTicketRequests(
  creds: SyncCredentials,
  remoteUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<ArmTicketRequest[]>> {
  const qs = new URLSearchParams({ remote_url: remoteUrl, status: 'queued' })
  return request(creds, {
    method: 'GET',
    path: `/api/cli/ticket-requests?${qs.toString()}`,
    parse: (body) => sanitizeList(body, 'requests', sanitizeArmTicketRequest),
    fetchImpl,
    collectionRoute: true,
  })
}

export async function claimTicketRequest(
  creds: SyncCredentials,
  requestId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<ArmTicketRequest>> {
  return request(creds, {
    method: 'POST',
    path: `/api/cli/ticket-requests/${encodeURIComponent(requestId)}/claim`,
    body: {},
    parse: (body) => sanitizeArmTicketRequest(field(body, 'request')),
    fetchImpl,
  })
}

export type TicketDraftInput = { title: string; body: string; dependsOnIndex?: number }

export async function submitTicketRequestTickets(
  creds: SyncCredentials,
  requestId: string,
  tickets: TicketDraftInput[],
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<ArmTicket[]>> {
  return request(creds, {
    method: 'POST',
    path: `/api/cli/ticket-requests/${encodeURIComponent(requestId)}/tickets`,
    body: {
      tickets: tickets.map((ticket) => ({
        title: ticket.title,
        body: ticket.body,
        ...(ticket.dependsOnIndex !== undefined ? { depends_on_index: ticket.dependsOnIndex } : {}),
      })),
    },
    parse: (body) => sanitizeList(body, 'tickets', sanitizeArmTicket),
    fetchImpl,
  })
}

export async function failTicketRequest(
  creds: SyncCredentials,
  requestId: string,
  errorMessage: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<Record<string, never>>> {
  return request(creds, {
    method: 'POST',
    path: `/api/cli/ticket-requests/${encodeURIComponent(requestId)}/fail`,
    body: { error_message: errorMessage },
    parse: ack,
    fetchImpl,
  })
}

export async function createTicket(
  creds: SyncCredentials,
  input: { remoteUrl: string; title: string; body: string; sourceIssue?: ArmIssueRef },
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<ArmTicket>> {
  return request(creds, {
    method: 'POST',
    path: '/api/cli/tickets',
    body: {
      remote_url: input.remoteUrl,
      title: input.title,
      body: input.body,
      ...(input.sourceIssue
        ? { source_issue: { iid: input.sourceIssue.iid, url: input.sourceIssue.url } }
        : {}),
    },
    parse: (body) => sanitizeArmTicket(field(body, 'ticket')),
    fetchImpl,
  })
}

export async function listTickets(
  creds: SyncCredentials,
  remoteUrl: string,
  status: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<ArmTicket[]>> {
  const qs = new URLSearchParams({ remote_url: remoteUrl, status })
  return request(creds, {
    method: 'GET',
    path: `/api/cli/tickets?${qs.toString()}`,
    parse: (body) => sanitizeList(body, 'tickets', sanitizeArmTicket),
    fetchImpl,
    collectionRoute: true,
  })
}

/**
 * An `ArmTicket` still in flight (in_progress/mr_opened/ready_to_merge, the
 * `status=in_flight` alias the hub resolves server-side), plus the one
 * extra field `runner status` needs that `ArmTicket` itself does not carry:
 * the arm's own last-reported local reconciliation status for this ticket.
 * `arm_local_status` is `null` on a hub build that predates that field,
 * same degrade-not-break doctrine as every sanitizer in ./contract.js,
 * applied here instead since the field is not (yet) part of the published
 * wire contract.
 */
export type InFlightTicket = ArmTicket & { arm_local_status: string | null }

function sanitizeInFlightTicket(raw: unknown): InFlightTicket | null {
  const ticket = sanitizeArmTicket(raw)
  if (!ticket) {
    return null
  }
  const rawLocalStatus = field(raw, 'arm_local_status')
  const armLocalStatus =
    typeof rawLocalStatus === 'string' ? rawLocalStatus.trim().slice(0, ARM_STATUS_MAX).trim() : ''
  return { ...ticket, arm_local_status: armLocalStatus || null }
}

/** Same collection-route doctrine as `listTickets`; `status=in_flight` is the alias the hub resolves to in_progress/mr_opened/ready_to_merge. */
export async function listInFlightTickets(
  creds: SyncCredentials,
  remoteUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<InFlightTicket[]>> {
  const qs = new URLSearchParams({ remote_url: remoteUrl, status: 'in_flight' })
  return request(creds, {
    method: 'GET',
    path: `/api/cli/tickets?${qs.toString()}`,
    parse: (body) => sanitizeList(body, 'tickets', sanitizeInFlightTicket),
    fetchImpl,
    collectionRoute: true,
  })
}

export async function getTicket(
  creds: SyncCredentials,
  ticketId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<ArmTicket>> {
  return request(creds, {
    method: 'GET',
    path: `/api/cli/tickets/${encodeURIComponent(ticketId)}`,
    parse: (body) => sanitizeArmTicket(field(body, 'ticket')),
    fetchImpl,
  })
}

export async function claimTicket(
  creds: SyncCredentials,
  ticketId: string,
  opts: { leaseSeconds?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<ArmClaimResult>> {
  return request(creds, {
    method: 'POST',
    path: `/api/cli/tickets/${encodeURIComponent(ticketId)}/claim`,
    body: opts.leaseSeconds !== undefined ? { lease_seconds: opts.leaseSeconds } : {},
    parse: sanitizeArmClaimResult,
    fetchImpl,
  })
}

export async function heartbeat(
  creds: SyncCredentials,
  ticketId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<Record<string, never>>> {
  return request(creds, {
    method: 'POST',
    path: `/api/cli/tickets/${encodeURIComponent(ticketId)}/heartbeat`,
    body: {},
    parse: ack,
    fetchImpl,
  })
}

export async function transition(
  creds: SyncCredentials,
  ticketId: string,
  input: ArmTransition,
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<Record<string, never>>> {
  return request(creds, {
    method: 'POST',
    path: `/api/cli/tickets/${encodeURIComponent(ticketId)}/transitions`,
    body: input,
    parse: ack,
    fetchImpl,
  })
}

export async function pushEvents(
  creds: SyncCredentials,
  input: { remoteUrl: string | null; runId: string; ticketId: string; events: ArmEvent[] },
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<Record<string, never>>> {
  return request(creds, {
    method: 'POST',
    path: '/api/cli/events',
    body: {
      remote_url: input.remoteUrl,
      run_id: input.runId,
      ticket_id: input.ticketId,
      events: input.events,
    },
    parse: ack,
    fetchImpl,
  })
}

export async function registerRunnerKey(
  creds: SyncCredentials,
  input: { public_key: string; name: string },
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<{ fingerprint: string }>> {
  return request(creds, {
    method: 'POST',
    path: '/api/cli/runners',
    body: { public_key: input.public_key, name: input.name },
    parse: (body) => {
      const fingerprint = field(body, 'fingerprint')
      return typeof fingerprint === 'string' && fingerprint.trim() ? { fingerprint } : null
    },
    fetchImpl,
  })
}

/**
 * Unlike every other list* function in this file, an entry this sanitizer
 * cannot place DROPS ONLY THAT ENTRY rather than refusing the whole
 * collection (contrast `sanitizeList`'s all-or-nothing doctrine, used by
 * `listTickets`/`listTicketRequests`/`listInFlightTickets`): this listing is
 * read by a human deciding which runner to push a secret to, or by the
 * daemon checking pending state, and one malformed row (a hub built for a
 * newer runner shape than this client understands) must not hide every
 * other legitimately usable runner from view.
 */
export async function listRunners(
  creds: SyncCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<RunnerListEntry[]>> {
  return request(creds, {
    method: 'GET',
    path: '/api/cli/runners',
    parse: (body) => {
      const raw = field(body, 'runners')
      if (!Array.isArray(raw)) {
        return null
      }
      const entries: RunnerListEntry[] = []
      for (const item of raw) {
        const entry = sanitizeRunnerListEntry(item)
        if (entry) {
          entries.push(entry)
        }
      }
      return entries
    },
    fetchImpl,
    collectionRoute: true,
  })
}

export async function depositRunnerSecret(
  creds: SyncCredentials,
  fingerprint: string,
  ciphertext: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<void>> {
  return request(creds, {
    method: 'POST',
    path: `/api/cli/runners/${encodeURIComponent(fingerprint)}/secret`,
    body: { ciphertext },
    parse: () => undefined,
    fetchImpl,
  })
}

/**
 * Claims whatever secret blob the hub is currently holding for this runner,
 * for the daemon's own rotation tick to unseal and apply. A 404 (nothing
 * pending) is the routine, expected outcome of most ticks and resolves as
 * `{ ok: true, data: null }` via `notFoundValue`, never as an error the
 * caller has to special-case out of `HubError`.
 */
export async function claimPendingSecret(
  creds: SyncCredentials,
  fingerprint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<{ ciphertext: string } | null>> {
  return request(creds, {
    method: 'POST',
    path: `/api/cli/runners/${encodeURIComponent(fingerprint)}/secret/claim`,
    body: {},
    notFoundValue: null,
    parse: (body) => {
      const blob = sanitizeSealedSecretBlob(field(body, 'secret'))
      return blob ? { ciphertext: blob.ciphertext } : null
    },
    fetchImpl,
  })
}

// ---------------------------------------------------------------------------
// Runbook scans and mechanical verifications (plan microVM 2026-08-28).
// ---------------------------------------------------------------------------

export async function verification(
  creds: SyncCredentials,
  ticketId: string,
  input: TaskVerification & { idempotency_key: string },
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<{ id: string; created: boolean }>> {
  return request(creds, {
    method: 'POST',
    path: `/api/cli/tickets/${encodeURIComponent(ticketId)}/verification`,
    body: input,
    parse: (body) => {
      const id = field(body, 'id')
      const created = field(body, 'created')
      return typeof id === 'string' && typeof created === 'boolean' ? { id, created } : null
    },
    fetchImpl,
  })
}

export async function listRunbookScans(
  creds: SyncCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<RunbookScan[]>> {
  return request(creds, {
    method: 'GET',
    path: '/api/cli/runbook-scans',
    collectionRoute: true,
    parse: (body) => {
      const scans = field(body, 'scans')
      if (!Array.isArray(scans)) {
        return null
      }
      return scans
        .map((item) => sanitizeRunbookScan(item))
        .filter((s): s is RunbookScan => s !== null)
    },
    fetchImpl,
  })
}

export async function claimRunbookScan(
  creds: SyncCredentials,
  scanId: string,
  opts: { leaseSeconds?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<{ scan: RunbookScan; lease_expires_at: string }>> {
  return request(creds, {
    method: 'POST',
    path: `/api/cli/runbook-scans/${encodeURIComponent(scanId)}/claim`,
    body: opts.leaseSeconds !== undefined ? { lease_seconds: opts.leaseSeconds } : {},
    parse: (body) => {
      const scan = sanitizeRunbookScan(field(body, 'scan'))
      const lease = field(body, 'lease_expires_at')
      return scan && typeof lease === 'string' ? { scan, lease_expires_at: lease } : null
    },
    fetchImpl,
  })
}

export async function reportRunbookScanResult(
  creds: SyncCredentials,
  scanId: string,
  input: { runbook: RunbookConfig; validation: RunbookValidation; log_tail?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<{ runbook_id: string; already_recorded: boolean }>> {
  return request(creds, {
    method: 'POST',
    path: `/api/cli/runbook-scans/${encodeURIComponent(scanId)}/result`,
    body: input,
    parse: (body) => {
      const runbookId = field(body, 'runbook_id')
      const already = field(body, 'already_recorded')
      return typeof runbookId === 'string' && typeof already === 'boolean'
        ? { runbook_id: runbookId, already_recorded: already }
        : null
    },
    fetchImpl,
  })
}

export async function failRunbookScan(
  creds: SyncCredentials,
  scanId: string,
  input: { error: string },
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<Record<string, never>>> {
  return request(creds, {
    method: 'POST',
    path: `/api/cli/runbook-scans/${encodeURIComponent(scanId)}/fail`,
    body: input,
    parse: ack,
    fetchImpl,
  })
}

export async function currentRunbook(
  creds: SyncCredentials,
  repoId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<HubResult<{ runbook: RunbookConfig | null; validation: RunbookValidation | null }>> {
  return request(creds, {
    method: 'GET',
    path: `/api/cli/repos/${encodeURIComponent(repoId)}/runbook`,
    parse: (body) => {
      if (!body || typeof body !== 'object') {
        return null
      }
      const rawRunbook = field(body, 'runbook')
      const rawValidation = field(body, 'validation')
      const runbook = rawRunbook === null ? null : sanitizeRunbookConfig(rawRunbook)
      const validation = rawValidation === null ? null : sanitizeRunbookValidation(rawValidation)
      if (
        (rawRunbook !== null && runbook === null) ||
        (rawValidation !== null && validation === null)
      ) {
        return null
      }
      return { runbook, validation }
    },
    fetchImpl,
  })
}
