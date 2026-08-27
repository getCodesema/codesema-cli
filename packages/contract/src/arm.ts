// Hub wire contract: types and sanitizers for the tickets, transitions and
// events exchanged between the hub (the local SaaS that owns tickets) and
// the arm (this CLI, claiming and executing them). Same doctrine as the rest
// of the contract: whitelist and truncate, never throw.
//
// These shapes mirror the HUB's own wire format, not this package's usual
// style: several fields below are REQUIRED keys carrying an explicit `null`
// rather than an optional key that is simply omitted (TaskRecord's own
// convention, tasks.ts). That mirrors nullable columns in the hub's own
// store, which always sends the key. The sanitizers below preserve that
// shape rather than converting it to "absent means unknown".

import {
  TASK_EVENT_DATA_KEY_MAX,
  TASK_EVENT_DATA_KEYS_MAX,
  TASK_EVENT_DATA_STRING_MAX,
  type TaskEventData,
} from './tasks.js'
import { NON_BLANK } from './ticket.js'

/**
 * A forge issue the hub resolved a ticket from, or attached to one.
 *
 * `iid` is a STRING here, unlike `TaskIssueRef.iid` (tasks.ts, a decimal
 * integer): the hub names issues however its own forge client returns
 * them, and this contract must not assume every source it may grow to
 * support hands back a number. Gated as a pair, same doctrine as tasks.ts's
 * `sanitizeIssueRef`: a reference missing either half cannot be resolved by
 * anything downstream, so a half-populated one is worse than none.
 */
export type ArmIssueRef = {
  iid: string
  url: string
}

/**
 * A ticket proposal as the hub first raises it, before it is published.
 *
 * `status` is a plain STRING, not `ArmTicketStatus`: the proposal lifecycle
 * is the hub's own vocabulary, and this contract has no business rejecting
 * a value it does not yet recognize there. Only `ArmTicket.status`, the
 * lifecycle the arm actually acts on, is a closed enum below.
 */
export type ArmTicketRequest = {
  id: string
  repo_remote_url: string
  prompt: string
  status: string
  source_issue: ArmIssueRef | null
  created_at: string
}

/**
 * A ticket's place in the lifecycle the arm acts on: claiming, executing,
 * opening a merge request, reporting back. Unlike `ArmTicketRequest.status`,
 * an unrecognized value here is never fabricated into a plausible-looking
 * one (contrast `TaskStatus`'s own `'failed'` fallback, tasks.ts): a ticket
 * this build cannot place in its own lifecycle is not safe to act on.
 */
export type ArmTicketStatus =
  | 'proposed'
  | 'rejected'
  | 'published'
  | 'in_progress'
  | 'mr_opened'
  | 'ready_to_merge'
  | 'done'
  | 'failed'
  | 'already_implemented'

/**
 * A ticket the hub owns and the arm may claim and execute.
 *
 * `depends_on`, `executed_by`, `lease_expires_at`, `issue`, `branch`,
 * `mr_iid` and `mr_url` are all REQUIRED keys of type `string | null` (see
 * this module's own doc comment for why). `sanitizeArmTicket` always emits
 * every one of them, never omits one for being unset.
 */
export type ArmTicket = {
  id: string
  repo_remote_url: string
  title: string
  body: string
  status: ArmTicketStatus
  depends_on: string | null
  executed_by: string | null
  lease_expires_at: string | null
  issue: ArmIssueRef | null
  branch: string | null
  mr_iid: string | null
  mr_url: string | null
  created_at: string
  updated_at: string
}

/** What kind of fact an `ArmTransition` reports back to the hub about one ticket. */
export type ArmTransitionType = 'mr_opened' | 'review_result' | 'merged' | 'failed'

/**
 * One fact the arm reports back to the hub about a ticket it executed.
 *
 * `idempotency_key` is MANDATORY, unlike every other field below: the
 * hub's report endpoint uses it to tell a retried report from a second,
 * real transition apart. A transition this sanitizer cannot name one for is
 * not a degraded transition, it is unsafe to apply, so `sanitizeArmTransition`
 * refuses the whole record rather than keeping the rest of it.
 */
export type ArmTransition = {
  type: ArmTransitionType
  idempotency_key: string
  at: string
  mr_iid?: string
  mr_url?: string
  branch?: string
  /**
   * Same literal union as `Verdict` (index.ts), restated rather than
   * imported: index.ts itself re-exports this module (`export * from
   * './arm.js'`), so importing `Verdict` from index.ts here would cycle
   * straight back through it. TypeScript compares union types structurally,
   * so this stays interchangeable with `Verdict` for every caller.
   */
  verdict?: 'approve' | 'request_changes' | 'comment'
  findings_total?: number
  merge_sha?: string
  error_message?: string
  cost_ticks?: number
}

/** One line of the arm's own execution journal for a ticket run, reported to the hub. */
export type ArmEvent = {
  run_id: string
  at: string
  event_type: string
  label: string
  payload?: TaskEventData
}

/** What claiming a ticket (the hub's lease endpoint) hands back to the arm. */
export type ArmClaimResult = {
  ticket: ArmTicket
  lease_expires_at: string
}

/** What a human decided, from the dashboard, about a ticket the arm reported waiting on (D19). */
export type ArmOrderAction = 'ship' | 'reply' | 'abandon'

/**
 * The decision itself, as the hub's heartbeat response hands it back to the
 * arm: what to do, and the instruction to carry out when that is `'reply'`.
 * `instruction` and `issued_at` are REQUIRED keys, same convention as
 * `ArmTicket` above (this module's own doc comment) rather than tasks.ts's
 * usual "absent means unset": this mirrors an order that, once issued, always
 * carries all three facts together.
 */
export type ArmOrder = {
  action: ArmOrderAction
  /** The human's own words, for `'reply'`. `null` for `'ship'`/`'abandon'`. */
  instruction: string | null
  issued_at: string
}

/**
 * What the hub's heartbeat route hands back to the arm (D19): the lease
 * extension every heartbeat already grants, plus the order a human decided
 * from the dashboard while this ticket was waiting on one. `null` on every
 * ordinary tick nothing is waiting on.
 */
export type ArmHeartbeatResponse = {
  lease_expires_at: string
  order: ArmOrder | null
}

export const ARM_ID_MAX = 64
export const ARM_REPO_URL_MAX = 500
export const ARM_TITLE_MAX = 200
export const ARM_BODY_MAX = 20_000
export const ARM_PROMPT_MAX = 20_000
export const ARM_STATUS_MAX = 100
export const ARM_BRANCH_MAX = 200
export const ARM_MR_IID_MAX = 64
export const ARM_MR_URL_MAX = 2_000
export const ARM_ISSUE_IID_MAX = 64
export const ARM_ISSUE_URL_MAX = 500
/** Bound for an ISO-8601 instant read back from the wire: same figure as tasks.ts's TASK_TIMESTAMP_MAX. */
export const ARM_TIMESTAMP_MAX = 40
export const ARM_IDEMPOTENCY_KEY_MAX = 200
export const ARM_ERROR_MESSAGE_MAX = 2_000
export const ARM_RUN_ID_MAX = 64
export const ARM_EVENT_TYPE_MAX = 100
export const ARM_LABEL_MAX = 500

const ARM_TICKET_STATUSES: ReadonlySet<ArmTicketStatus> = new Set([
  'proposed',
  'rejected',
  'published',
  'in_progress',
  'mr_opened',
  'ready_to_merge',
  'done',
  'failed',
  'already_implemented',
])

const ARM_TRANSITION_TYPES: ReadonlySet<ArmTransitionType> = new Set([
  'mr_opened',
  'review_result',
  'merged',
  'failed',
])

type ArmVerdict = 'approve' | 'request_changes' | 'comment'
const ARM_VERDICTS: ReadonlySet<ArmVerdict> = new Set(['approve', 'request_changes', 'comment'])

const ARM_ORDER_ACTIONS: ReadonlySet<ArmOrderAction> = new Set(['ship', 'reply', 'abandon'])

/** A git object name: hex only, from an abbreviated 7 up to a sha256 repo's 64. Whitelisted, not merely bounded. */
const ARM_SHA_PATTERN = '^[0-9a-f]{7,64}$'
const ARM_SHA_RE = new RegExp(ARM_SHA_PATTERN)

/**
 * Trim, cut, trim AGAIN (same recipe as recap.ts's own `str`): slicing a
 * trimmed string at an arbitrary `max` can still land right after an
 * INTERNAL run of whitespace, leaving a truncated value that ends (or,
 * symmetrically, could start) with a blank the first trim never saw. Every
 * NON_BLANK-patterned field this module publishes a schema for goes through
 * this helper, so the second trim is load-bearing for the forward cross
 * test, not cosmetic.
 */
const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.trim().slice(0, max).trim() : ''

const nullableStr = (v: unknown, max: number): string | null => {
  const s = str(v, max)
  return s ? s : null
}

/**
 * `at`/`created_at`/`updated_at` doctrine: an ISO instant, bounded, falling
 * back to `fallback` when unusable. Bounded, unlike tasks.ts's own
 * `isoOrNow` (which never truncates): this module publishes JSON Schemas for
 * some of the shapes that use it, and the forward cross test in
 * arm.test.ts requires every string this sanitizer can produce to already
 * satisfy the bound the matching schema declares. Built on `str`, not a
 * separate trim+slice, so it inherits the same trim-cut-trim guarantee: a
 * value that degrades to whitespace-only after truncation falls back to
 * `fallback` rather than returning a blank string the NON_BLANK-patterned
 * schemas below would reject.
 */
const isoOr = (v: unknown, fallback: string, max: number = ARM_TIMESTAMP_MAX): string => {
  const s = str(v, max)
  return s ? s : fallback
}

const isoOrNow = (v: unknown, max: number = ARM_TIMESTAMP_MAX): string =>
  isoOr(v, new Date().toISOString(), max)

/**
 * Non-negative safe integer, `-0` refused explicitly: same predicate as
 * tasks.ts's own `optionalCostTicks`, duplicated here rather than imported
 * (that helper is private to tasks.ts, and this module otherwise has no
 * reason to widen that file's public surface). Used for both `cost_ticks`
 * and `findings_total`: absence means UNKNOWN, never `0`.
 */
const optionalNonNegativeInt = (v: unknown): number | null =>
  Number.isSafeInteger(v) && (v as number) >= 0 && !Object.is(v, -0) ? (v as number) : null

/** An issue URL is whatever `new URL()` accepts as http(s), same rule as tasks.ts's own `isHttpUrl`. */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

function sanitizeArmSha(raw: unknown): string | undefined {
  if (typeof raw !== 'string') {
    return undefined
  }
  const sha = raw.trim().toLowerCase()
  return ARM_SHA_RE.test(sha) ? sha : undefined
}

/**
 * Whitelist and gate together, same doctrine as tasks.ts's `sanitizeIssueRef`:
 * `iid` and `url` are only meaningful as a pair, so either one being unusable
 * drops the whole reference rather than keeping half of it.
 */
function sanitizeArmIssueRef(raw: unknown): ArmIssueRef | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  const iid = str(r.iid, ARM_ISSUE_IID_MAX)
  const url = str(r.url, ARM_ISSUE_URL_MAX)
  if (!iid || !url || !isHttpUrl(url)) {
    return null
  }
  return { iid, url }
}

/**
 * Revalidates a ticket proposal read off the hub's wire. `id` is the one
 * identity-bearing field, same role `id` plays for `sanitizeTaskRecord`
 * (tasks.ts): without it the object cannot be told apart from any other, so
 * the whole proposal is unusable. Every other field degrades independently.
 */
export function sanitizeArmTicketRequest(raw: unknown): ArmTicketRequest | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  const id = str(r.id, ARM_ID_MAX)
  if (!id) {
    return null
  }
  return {
    id,
    repo_remote_url: str(r.repo_remote_url, ARM_REPO_URL_MAX),
    prompt: str(r.prompt, ARM_PROMPT_MAX),
    status: str(r.status, ARM_STATUS_MAX),
    source_issue: sanitizeArmIssueRef(r.source_issue),
    created_at: isoOrNow(r.created_at),
  }
}

/**
 * Revalidates an `ArmTicket` read off the hub's wire. Two fields gate the
 * whole record: `id` (identity) and `status`. An unrecognized status is
 * never fabricated into a plausible one (contrast `TaskStatus`'s own
 * `'failed'` fallback, tasks.ts): a ticket this build cannot place in its
 * own lifecycle is not safe to claim or execute, so the whole record is
 * refused instead of half-trusted.
 */
export function sanitizeArmTicket(raw: unknown): ArmTicket | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  const id = str(r.id, ARM_ID_MAX)
  const status = ARM_TICKET_STATUSES.has(r.status as ArmTicketStatus)
    ? (r.status as ArmTicketStatus)
    : null
  if (!id || !status) {
    return null
  }
  // Whitelisted, not merely bounded: an `mr_url` nobody's browser could open
  // is worse than none, same reasoning as `isHttpUrl` everywhere else here.
  const mrUrlCandidate = nullableStr(r.mr_url, ARM_MR_URL_MAX)
  const created_at = isoOrNow(r.created_at)
  return {
    id,
    repo_remote_url: str(r.repo_remote_url, ARM_REPO_URL_MAX),
    title: str(r.title, ARM_TITLE_MAX),
    body: str(r.body, ARM_BODY_MAX),
    status,
    depends_on: nullableStr(r.depends_on, ARM_ID_MAX),
    executed_by: nullableStr(r.executed_by, ARM_ID_MAX),
    lease_expires_at: nullableStr(r.lease_expires_at, ARM_TIMESTAMP_MAX),
    issue: sanitizeArmIssueRef(r.issue),
    branch: nullableStr(r.branch, ARM_BRANCH_MAX),
    mr_iid: nullableStr(r.mr_iid, ARM_MR_IID_MAX),
    mr_url: mrUrlCandidate && isHttpUrl(mrUrlCandidate) ? mrUrlCandidate : null,
    created_at,
    updated_at: isoOr(r.updated_at, created_at),
  }
}

/**
 * Revalidates an `ArmTransition` before it is sent to, or read back from,
 * the hub's report endpoint. Two fields gate the whole record: `type`
 * (same never-fabricate rule as `ArmTicket.status`) and `idempotency_key`,
 * mandatory per this type's own doc comment. Every other field is optional
 * and degrades to absence, never to an invented placeholder.
 */
export function sanitizeArmTransition(raw: unknown): ArmTransition | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  const type = ARM_TRANSITION_TYPES.has(r.type as ArmTransitionType)
    ? (r.type as ArmTransitionType)
    : null
  const idempotency_key = str(r.idempotency_key, ARM_IDEMPOTENCY_KEY_MAX)
  if (!type || !idempotency_key) {
    return null
  }
  const mrIid = str(r.mr_iid, ARM_MR_IID_MAX)
  const mrUrl = str(r.mr_url, ARM_MR_URL_MAX)
  const branch = str(r.branch, ARM_BRANCH_MAX)
  const verdict = ARM_VERDICTS.has(r.verdict as ArmVerdict) ? (r.verdict as ArmVerdict) : null
  const findingsTotal = optionalNonNegativeInt(r.findings_total)
  const mergeSha = sanitizeArmSha(r.merge_sha)
  const errorMessage = str(r.error_message, ARM_ERROR_MESSAGE_MAX)
  const costTicks = optionalNonNegativeInt(r.cost_ticks)
  return {
    type,
    idempotency_key,
    at: isoOrNow(r.at),
    ...(mrIid ? { mr_iid: mrIid } : {}),
    ...(mrUrl && isHttpUrl(mrUrl) ? { mr_url: mrUrl } : {}),
    ...(branch ? { branch } : {}),
    ...(verdict ? { verdict } : {}),
    ...(findingsTotal !== null ? { findings_total: findingsTotal } : {}),
    ...(mergeSha ? { merge_sha: mergeSha } : {}),
    ...(errorMessage ? { error_message: errorMessage } : {}),
    ...(costTicks !== null ? { cost_ticks: costTicks } : {}),
  }
}

/**
 * Same flat-and-bounded doctrine as tasks.ts's own `sanitizeTaskEventData`
 * (private to that module, so reimplemented here rather than imported), but
 * reusing that module's own published bound constants so the two stay
 * numerically identical without this module owning the numbers twice.
 */
function sanitizeArmEventPayload(raw: unknown): TaskEventData {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {}
  }
  const out: TaskEventData = {}
  let kept = 0
  for (const [key, value] of Object.entries(raw)) {
    if (kept >= TASK_EVENT_DATA_KEYS_MAX) {
      break
    }
    const k = key.slice(0, TASK_EVENT_DATA_KEY_MAX)
    if (!k) {
      continue
    }
    if (typeof value === 'string') {
      out[k] = value.slice(0, TASK_EVENT_DATA_STRING_MAX)
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[k] = value
    } else if (typeof value === 'boolean' || value === null) {
      out[k] = value
    } else {
      continue
    }
    kept++
  }
  return out
}

/**
 * Revalidates an `ArmEvent` before it is reported to the hub. Gated on
 * `run_id`: an event this reader cannot place under a run is unusable, same
 * role `TaskEvent.seq` plays in `sanitizeTaskEvent` (tasks.ts).
 */
export function sanitizeArmEvent(raw: unknown): ArmEvent | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  const run_id = str(r.run_id, ARM_RUN_ID_MAX)
  if (!run_id) {
    return null
  }
  const payload = sanitizeArmEventPayload(r.payload)
  return {
    run_id,
    at: isoOrNow(r.at),
    event_type: str(r.event_type, ARM_EVENT_TYPE_MAX),
    label: str(r.label, ARM_LABEL_MAX),
    ...(Object.keys(payload).length > 0 ? { payload } : {}),
  }
}

/**
 * Revalidates the hub's claim/lease response. Gated on `ticket`: a claim
 * whose ticket cannot itself be trusted (see `sanitizeArmTicket`) grants
 * nothing usable, so the whole result is refused rather than handing back a
 * lease over an unreadable ticket. The lease falls back to the ticket's own
 * `lease_expires_at`, never to "now": a lease that expires at the instant it
 * was granted would make the arm drop a ticket it just validly claimed.
 */
export function sanitizeArmClaimResult(raw: unknown): ArmClaimResult | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  const ticket = sanitizeArmTicket(r.ticket)
  if (!ticket) {
    return null
  }
  const leaseExpiresAt = str(r.lease_expires_at, ARM_TIMESTAMP_MAX) || ticket.lease_expires_at
  if (!leaseExpiresAt) {
    return null
  }
  return {
    ticket,
    lease_expires_at: leaseExpiresAt,
  }
}

/**
 * Revalidates an `ArmOrder` read off the hub's heartbeat response. Gated on
 * `action`: same never-fabricate rule as `ArmTicket.status` and
 * `ArmTransition.type`, an order outside this closed set is not safe to
 * dispatch, so the whole order is refused rather than guessed at.
 * `instruction` degrades to `null`, never to an empty string, so a `'reply'`
 * that arrives with no usable instruction stays tellable from one that
 * legitimately carries none.
 */
export function sanitizeArmOrder(raw: unknown): ArmOrder | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  const action = ARM_ORDER_ACTIONS.has(r.action as ArmOrderAction)
    ? (r.action as ArmOrderAction)
    : null
  if (!action) {
    return null
  }
  return {
    action,
    instruction: nullableStr(r.instruction, ARM_PROMPT_MAX),
    issued_at: isoOrNow(r.issued_at),
  }
}

/**
 * Revalidates the hub's heartbeat response. Gated on `lease_expires_at`,
 * same reasoning as `sanitizeArmClaimResult`: a heartbeat that cannot say
 * when the lease it just renewed expires is not a usable response, and unlike
 * `created_at`/`updated_at` elsewhere in this module, a lease deadline must
 * never fall back to "now": that would either claim an already-expired lease
 * or fabricate an extension the hub never granted. A malformed `order`
 * degrades to `null` rather than sinking the whole response, the same
 * never-fabricate rule `sanitizeArmOrder` itself applies.
 */
export function sanitizeArmHeartbeatResponse(raw: unknown): ArmHeartbeatResponse | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const r = raw as Record<string, unknown>
  const leaseExpiresAt = str(r.lease_expires_at, ARM_TIMESTAMP_MAX)
  if (!leaseExpiresAt) {
    return null
  }
  return {
    lease_expires_at: leaseExpiresAt,
    order: sanitizeArmOrder(r.order),
  }
}

/**
 * JSON Schema (draft 2020-12) for an `ArmTicket`, on the same pattern as
 * `reviewRecordSchema` (index.ts), `ticketBodySchema` and `recapRecordSchema`
 * (this package): every `sanitizeArmTicket` output validates here (forward),
 * and the schema refuses every shape the sanitizer refuses (backward, tested
 * in arm.test.ts) so the two cannot silently drift apart.
 */
export const armTicketSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://codesema.com/schemas/arm-ticket.json',
  title: 'Codesema arm ticket',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'repo_remote_url',
    'title',
    'body',
    'status',
    'depends_on',
    'executed_by',
    'lease_expires_at',
    'issue',
    'branch',
    'mr_iid',
    'mr_url',
    'created_at',
    'updated_at',
  ],
  properties: {
    id: { type: 'string', maxLength: ARM_ID_MAX, pattern: NON_BLANK },
    repo_remote_url: { type: 'string', maxLength: ARM_REPO_URL_MAX },
    title: { type: 'string', maxLength: ARM_TITLE_MAX },
    body: { type: 'string', maxLength: ARM_BODY_MAX },
    status: {
      enum: [
        'proposed',
        'rejected',
        'published',
        'in_progress',
        'mr_opened',
        'ready_to_merge',
        'done',
        'failed',
        'already_implemented',
      ],
    },
    depends_on: {
      anyOf: [{ type: 'null' }, { type: 'string', maxLength: ARM_ID_MAX, pattern: NON_BLANK }],
    },
    executed_by: {
      anyOf: [{ type: 'null' }, { type: 'string', maxLength: ARM_ID_MAX, pattern: NON_BLANK }],
    },
    lease_expires_at: {
      anyOf: [
        { type: 'null' },
        { type: 'string', maxLength: ARM_TIMESTAMP_MAX, pattern: NON_BLANK },
      ],
    },
    issue: { anyOf: [{ type: 'null' }, { $ref: '#/$defs/issueRef' }] },
    branch: {
      anyOf: [{ type: 'null' }, { type: 'string', maxLength: ARM_BRANCH_MAX, pattern: NON_BLANK }],
    },
    mr_iid: {
      anyOf: [{ type: 'null' }, { type: 'string', maxLength: ARM_MR_IID_MAX, pattern: NON_BLANK }],
    },
    mr_url: {
      anyOf: [{ type: 'null' }, { type: 'string', maxLength: ARM_MR_URL_MAX, pattern: NON_BLANK }],
    },
    created_at: { type: 'string', maxLength: ARM_TIMESTAMP_MAX, pattern: NON_BLANK },
    updated_at: { type: 'string', maxLength: ARM_TIMESTAMP_MAX, pattern: NON_BLANK },
  },
  $defs: {
    issueRef: {
      type: 'object',
      additionalProperties: false,
      required: ['iid', 'url'],
      properties: {
        iid: { type: 'string', maxLength: ARM_ISSUE_IID_MAX, pattern: NON_BLANK },
        url: { type: 'string', maxLength: ARM_ISSUE_URL_MAX, pattern: NON_BLANK },
      },
    },
  },
} as const

/**
 * JSON Schema (draft 2020-12) for an `ArmTransition`, same pattern and same
 * forward/backward guarantee as `armTicketSchema` above. Every field beyond
 * `type`/`idempotency_key`/`at` is optional here exactly as it is on the
 * type: `sanitizeArmTransition` omits rather than blanks an unusable one, so
 * none of them is in `required`.
 */
export const armTransitionSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://codesema.com/schemas/arm-transition.json',
  title: 'Codesema arm transition',
  type: 'object',
  additionalProperties: false,
  required: ['type', 'idempotency_key', 'at'],
  properties: {
    type: { enum: ['mr_opened', 'review_result', 'merged', 'failed'] },
    idempotency_key: { type: 'string', maxLength: ARM_IDEMPOTENCY_KEY_MAX, pattern: NON_BLANK },
    at: { type: 'string', maxLength: ARM_TIMESTAMP_MAX, pattern: NON_BLANK },
    mr_iid: { type: 'string', maxLength: ARM_MR_IID_MAX, pattern: NON_BLANK },
    mr_url: { type: 'string', maxLength: ARM_MR_URL_MAX, pattern: NON_BLANK },
    branch: { type: 'string', maxLength: ARM_BRANCH_MAX, pattern: NON_BLANK },
    verdict: { enum: ['approve', 'request_changes', 'comment'] },
    findings_total: { type: 'integer', minimum: 0, maximum: 9_007_199_254_740_991 },
    merge_sha: { type: 'string', pattern: ARM_SHA_PATTERN },
    error_message: { type: 'string', maxLength: ARM_ERROR_MESSAGE_MAX, pattern: NON_BLANK },
    cost_ticks: { type: 'integer', minimum: 0, maximum: 9_007_199_254_740_991 },
  },
} as const

/**
 * JSON Schema (draft 2020-12) for an `ArmOrder`, same pattern and same
 * forward/backward guarantee as `armTicketSchema` above.
 */
export const armOrderSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://codesema.com/schemas/arm-order.json',
  title: 'Codesema arm order',
  type: 'object',
  additionalProperties: false,
  required: ['action', 'instruction', 'issued_at'],
  properties: {
    action: { enum: ['ship', 'reply', 'abandon'] },
    instruction: {
      anyOf: [{ type: 'null' }, { type: 'string', maxLength: ARM_PROMPT_MAX, pattern: NON_BLANK }],
    },
    issued_at: { type: 'string', maxLength: ARM_TIMESTAMP_MAX, pattern: NON_BLANK },
  },
} as const
