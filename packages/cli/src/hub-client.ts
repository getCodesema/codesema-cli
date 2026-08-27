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
  type ArmClaimResult,
  type ArmEvent,
  type ArmIssueRef,
  type ArmTicket,
  type ArmTicketRequest,
  type ArmTransition,
} from './contract.js'
import { tryGit } from './git.js'
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

type RequestOptions = {
  fetchImpl: typeof fetch
  /** See `HubError`'s `unavailable` doc: only a bare collection GET qualifies. */
  collectionRoute?: boolean
}

type RequestSpec<T> = RequestOptions & {
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
      headers: { 'content-type': 'application/json', ...authHeader(creds) },
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
