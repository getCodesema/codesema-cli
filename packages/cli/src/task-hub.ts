// Fire-and-forget reporting from the arm (this CLI) back to the hub: the
// local SaaS that owns a ticket while this workspace executes it. Same
// doctrine as task-labels.ts, its closest sibling: never blocks a task
// transition on a network round trip, and a failure that could not be
// recovered by the outbox is always logged, never swallowed.
//
// The hub is reached at the SAME base URL and with the SAME bearer
// credentials as codesema.com cloud sync (sync.ts): `loadSyncCredentials()`
// and `authHeader()`. No credentials configured, or a task with no
// `hub_ticket`: every export here degrades to a no-op, never a throw, the
// same degrade-to-nothing contract as `pushReview`/`autoPushReview`.
//
// Outbox (`.codesema/hub-outbox.jsonl`): same append-only recipe as
// tasks-store.ts's events.jsonl, one JSON line per entry. A report that hit
// a network failure or a 5xx is appended here and replayed by
// `flushHubOutbox`; a 4xx (the hub itself rejected the body, a stale
// idempotency key included, on a 409) is logged once and dropped, never
// retried: resending the exact same rejected body would only repeat the
// rejection.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureWorkDir } from './config.js'
import {
  ARM_LABEL_MAX,
  cutCodePoints,
  isLegalTicketTransition,
  sanitizeArmOrder,
  sanitizeArmTicket,
  sanitizeArmTransition,
  targetTicketStatus,
  type ArmEvent,
  type ArmOrder,
  type ArmTransition,
  type TaskEvent,
  type TaskRecord,
  type TaskStatus,
} from './contract.js'
import { tryGitAsync } from './git.js'
import { authHeader, loadSyncCredentials, type SyncCredentials } from './sync.js'

const HUB_REQUEST_TIMEOUT_MS = 10_000
const HUB_EVENT_BATCH_MAX = 20
const HUB_EVENT_BATCH_DELAY_MS = 5_000

/**
 * A separator that cannot appear in a `cwd` (an absolute path) or a 12-hex
 * task id: NUL, built at RUNTIME with `fromCharCode` rather than written as
 * a literal escape in a template string, because source-shape.test.ts
 * requires every source file to stay byte-for-byte plain text, and a literal
 * escape here risks being saved as the raw byte instead (same runtime
 * character, but a file `rg` then treats as binary and silently stops
 * scanning).
 */
const KEY_SEP = String.fromCharCode(0)

function hubOutboxPath(cwd: string): string {
  return join(cwd, '.codesema', 'hub-outbox.jsonl')
}

function legacyOutboxPath(cwd: string): string {
  return join(cwd, '.codesema', 'brain-outbox.jsonl')
}

// Pre-rename `brain-outbox.jsonl` is migrated to `hub-outbox.jsonl` on first access; failure leaves the legacy file in place.
function migrateLegacyOutbox(cwd: string): void {
  const legacyPath = legacyOutboxPath(cwd)
  const path = hubOutboxPath(cwd)
  if (existsSync(legacyPath) && !existsSync(path)) {
    try {
      renameSync(legacyPath, path)
    } catch {
      // Best-effort: an unwritable directory just leaves the legacy file in place.
    }
  }
}

/**
 * One entry of the outbox. `key` is a local label only (never sent to the
 * hub): it names the report in a log line and lets a caller recognise its
 * own write, never a server-side idempotency mechanism. Only
 * `ArmTransition.idempotency_key`, inside `transition`, is that.
 */
type HubOutboxEntry =
  | { kind: 'transition'; key: string; ticket_id: string; transition: ArmTransition }
  | {
      kind: 'events'
      key: string
      run_id: string
      remote_url: string | null
      ticket_id: string
      events: ArmEvent[]
    }

function appendToOutbox(cwd: string, entry: HubOutboxEntry): void {
  ensureWorkDir(cwd)
  migrateLegacyOutbox(cwd)
  try {
    const line = `${JSON.stringify(entry)}\n`
    writeFileSync(hubOutboxPath(cwd), line, { flag: 'a' })
  } catch (err) {
    // The outbox itself could not be written (disk full, permissions): the
    // report is lost, and that is said rather than silently swallowed.
    logHubFailure(`outbox write (${entry.kind}, ${entry.key})`, errorMessage(err))
  }
}

function logHubFailure(action: string, detail: string): void {
  console.warn(`[hub] ${action}: ${detail}`)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Cached per `cwd` for the life of the process: a working tree's origin
 * remote does not change mid-run, and `flushEventBatch` calls this on every
 * event-batch flush, potentially several per task per session. The cache
 * stores the PROMISE itself, not its resolved value: two flushes for the
 * same `cwd` racing before the first read finishes must share the one git
 * call in flight rather than each start their own.
 */
const originRemoteUrlCache = new Map<string, Promise<string | null>>()

/**
 * Same read as server-context.ts: raw, unnormalized; the hub normalizes it
 * server-side. `tryGitAsync`, never the synchronous `tryGit`: this runs on
 * every event-batch flush, and a synchronous git call would block the WHOLE
 * process for its duration (git.ts's own doc comment on `tryGitAsync`
 * describes exactly this pool-blocking scenario).
 */
function originRemoteUrl(cwd: string): Promise<string | null> {
  const cached = originRemoteUrlCache.get(cwd)
  if (cached) {
    return cached
  }
  const promise = tryGitAsync(['remote', 'get-url', 'origin'], cwd)
  originRemoteUrlCache.set(cwd, promise)
  return promise
}

type HubPostOutcome =
  | { kind: 'ok'; body: unknown }
  | { kind: 'client_error'; status: number; detail: string }
  | { kind: 'retryable'; detail: string }

async function postToHub(
  path: string,
  body: unknown,
  creds: SyncCredentials,
  fetchImpl: typeof fetch,
): Promise<HubPostOutcome> {
  let res: Response
  try {
    res = await fetchImpl(`${creds.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(creds) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(HUB_REQUEST_TIMEOUT_MS),
    })
  } catch (err) {
    return { kind: 'retryable', detail: errorMessage(err) }
  }
  if (res.ok) {
    // Tolerant on purpose: most callers post to routes that answer with no
    // body at all, and JSON.parse on an empty string throws rather than
    // returning something falsy, so a route that DOES answer with a body
    // (the heartbeat's `order`, D19) is read the same tolerant way instead
    // of every other caller needing its own empty-body special case.
    const responseBody = await res.json().catch(() => undefined)
    return { kind: 'ok', body: responseBody }
  }
  const parsed = (await res.json().catch(() => ({}))) as { error?: unknown }
  const detail = typeof parsed.error === 'string' ? parsed.error : `HTTP ${res.status}`
  // 5xx: the hub itself is unwell, worth a retry once it recovers. Anything
  // else in the 4xx family: the request itself was refused (bad body, unknown
  // ticket, a 409 replay of an idempotency key already applied) and a retry
  // would only repeat the same refusal.
  return res.status >= 500
    ? { kind: 'retryable', detail }
    : { kind: 'client_error', status: res.status, detail }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/**
 * What a caller hands `reportHubTransition`: an `ArmTransition` minus the
 * two fields it computes itself. Distributive on purpose: a plain `Omit`
 * over the union would flatten the per-type proof requirements away, and the
 * compiler is the first gate the doctrine leans on (`mr_opened` demands
 * `mr_url`, `merged` demands `merge_sha`, at every call site).
 */
export type ArmTransitionDraft = DistributiveOmit<ArmTransition, 'idempotency_key' | 'at'>

/**
 * Remembers the ticket status the hub itself just answered with, so the next
 * report can be checked against the shared transition table. Load, mutate
 * and save have no await between them, so no concurrent record write can
 * interleave. Best-effort by design: an unreadable body or a vanished record
 * leaves the last known status in place, and the table guard treats absence
 * as "unknown, let the hub decide".
 */
async function rememberHubTicketStatus(cwd: string, taskId: string, body: unknown): Promise<void> {
  // Dynamic on purpose: tasks-store.ts statically imports this module
  // (queueHubEvent), so a static import back would be a module cycle.
  const { loadTask, saveTask } = await import('./tasks-store.js')
  const ticket = sanitizeArmTicket((body as { ticket?: unknown } | undefined)?.ticket)
  if (!ticket) {
    return
  }
  const current = loadTask(cwd, taskId)
  if (!current?.hub_ticket || current.hub_ticket_status === ticket.status) {
    return
  }
  saveTask(cwd, { ...current, hub_ticket_status: ticket.status })
}

/**
 * Reports one fact about a hub ticket's execution back to the hub:
 * `mr_opened` on ship, `review_result` on a settled review verdict, `merged`
 * on a landed merge, `failed` on a failure or an explicit interruption. A
 * no-op for a task that carries no `hub_ticket`, and for a machine with no
 * sync credentials configured.
 *
 * `idempotency_key` and `at` are computed here, never by the caller: the key
 * is `<taskId>:<type>:<turn count>`, stable for a given task, transition type
 * and turn count, which is what makes a retried report (this call, or its
 * outbox replay) land on the SAME fact rather than mint a second one, while
 * still telling apart two DIFFERENT facts of the same type on the same task
 * (`review_result` after each of several fix-loop rounds carries a genuinely
 * different verdict; a constant key would have the hub read every round
 * past the first as a duplicate of the first and drop it).
 *
 * Never throws. Offline, or a 5xx: appended to `.codesema/hub-outbox.jsonl`
 * for `flushHubOutbox` to replay later. A 4xx: logged once and abandoned,
 * never retried.
 *
 * Two refusals happen HERE, before anything is posted (recovery doctrine,
 * rule 3: both sides refuse an out-of-table transition): a report without
 * its proof (`sanitizeArmTransition` returns null), and a report whose
 * claimed status is not a legal move from the last status the hub itself
 * answered with (`hub_ticket_status`, remembered below on every successful
 * round trip; unknown on legacy records, which then pass: the hub
 * revalidates every report anyway).
 */
export async function reportHubTransition(
  cwd: string,
  record: TaskRecord,
  transition: ArmTransitionDraft,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const ticketId = record.hub_ticket?.id
  if (!ticketId) {
    return
  }
  const label = `transition '${transition.type}' for task ${record.id}`
  // The same sanitizer the hub-facing schema mirrors: a proof-less claim
  // (mr_opened without mr_url, merged without merge_sha) comes back null and
  // is never posted. Refusing here is the whole point: a phantom state on
  // the hub is worse than a missing report (the forge webhook reconciles).
  const full = sanitizeArmTransition({
    ...transition,
    idempotency_key: `${record.id}:${transition.type}:${record.turns.length}`,
    at: new Date().toISOString(),
  })
  if (!full) {
    logHubFailure(
      label,
      'refused before posting: a state requires its proof and this report carries none',
    )
    return
  }
  const claimed = targetTicketStatus(full.type, full.verdict)
  const lastKnown = record.hub_ticket_status
  if (claimed && lastKnown && !isLegalTicketTransition(lastKnown, claimed)) {
    logHubFailure(
      label,
      `refused before posting: ${lastKnown} → ${claimed} is not in the shared transition table`,
    )
    return
  }
  const creds = loadSyncCredentials()
  if (!creds) {
    logHubFailure(label, 'no sync credentials configured')
    return
  }
  try {
    const outcome = await postToHub(
      `/api/cli/tickets/${encodeURIComponent(ticketId)}/transitions`,
      full,
      creds,
      fetchImpl,
    )
    if (outcome.kind === 'ok') {
      await rememberHubTicketStatus(cwd, record.id, outcome.body)
      return
    }
    if (outcome.kind === 'client_error') {
      logHubFailure(label, `rejected by the hub (${outcome.status}): ${outcome.detail}; abandoned`)
      return
    }
    logHubFailure(label, `${outcome.detail}; queued for retry`)
    appendToOutbox(cwd, {
      kind: 'transition',
      key: full.idempotency_key,
      ticket_id: ticketId,
      transition: full,
    })
  } catch (err) {
    // The seam contract says postToHub never rejects, but a fire-and-forget
    // effect must not depend on that holding forever (same discipline as
    // task-labels.ts's syncCycleLabel): caught here rather than left to
    // become an unhandled rejection.
    logHubFailure(label, `${errorMessage(err)}; queued for retry`)
    appendToOutbox(cwd, {
      kind: 'transition',
      key: full.idempotency_key,
      ticket_id: ticketId,
      transition: full,
    })
  }
}

/**
 * Reads the `order` field off a heartbeat response body without assuming its
 * shape: `body` is `unknown` (postToHub only ever confirms "this parsed as
 * JSON"), so this is the one narrowing step between the wire and
 * `sanitizeArmOrder`, which validates everything else about it.
 */
function orderFieldOf(body: unknown): unknown {
  return body && typeof body === 'object' && 'order' in body
    ? (body as { order: unknown }).order
    : undefined
}

/**
 * Sends a heartbeat for a task's hub ticket lease, and returns the order a
 * human decided from the dashboard while this ticket sat waiting (D19):
 * ship, reply with an instruction, or abandon. `null` on every ordinary tick
 * nothing is waiting on, and on any failure.
 *
 * No outbox: a missed heartbeat is superseded by the next one (the daemon
 * owns the 45s timer, not this module), and a stale order is superseded the
 * same way (the hub purges an order the moment it hands it back, so the
 * next heartbeat only ever carries a fresh one, or none). Retrying either is
 * never useful. Never throws.
 *
 * `localStatus`, when given, rides along as `local_status` so the hub can
 * show this ticket as waiting (or not) on its own dashboard; omitted, the
 * body is `{}`, same as before D19.
 *
 * `cwd` (unused) is kept for call-shape symmetry with this module's other
 * exports (`reportHubTransition`, `queueHubEvent`), all of which the
 * daemon calls the same way; a heartbeat needs only the ticket id.
 */
export async function heartbeatHubTicket(
  _cwd: string,
  record: TaskRecord,
  localStatus?: TaskStatus,
  fetchImpl: typeof fetch = fetch,
): Promise<ArmOrder | null> {
  const ticketId = record.hub_ticket?.id
  if (!ticketId) {
    return null
  }
  const creds = loadSyncCredentials()
  if (!creds) {
    return null
  }
  const label = `heartbeat for task ${record.id}`
  try {
    const outcome = await postToHub(
      `/api/cli/tickets/${encodeURIComponent(ticketId)}/heartbeat`,
      localStatus ? { local_status: localStatus } : {},
      creds,
      fetchImpl,
    )
    if (outcome.kind !== 'ok') {
      logHubFailure(label, outcome.detail)
      return null
    }
    return sanitizeArmOrder(orderFieldOf(outcome.body))
  } catch (err) {
    logHubFailure(label, errorMessage(err))
    return null
  }
}

// --- events: batched per task ----------------------------------------------

type PendingEventBatch = {
  cwd: string
  runId: string
  ticketId: string
  events: ArmEvent[]
  timer: ReturnType<typeof setTimeout>
}

const pendingEventBatches = new Map<string, PendingEventBatch>()

/** The label a journal line carries to the hub: its own message, its own name, or its bare type. */
function armEventLabel(event: TaskEvent): string {
  const data = event.data as Record<string, unknown> | undefined
  if (typeof data?.message === 'string' && data.message) {
    return data.message
  }
  if (typeof data?.name === 'string' && data.name) {
    return data.name
  }
  return event.type
}

function armEventFrom(taskId: string, event: TaskEvent): ArmEvent {
  return {
    run_id: taskId,
    at: event.at,
    event_type: event.type,
    // Bounded HERE, not only by the hub's schema: one oversized label (a
    // forge CLI dumping its usage text into a message) must degrade to a cut
    // label, never poison its whole batch with a 422.
    label: cutCodePoints(armEventLabel(event), ARM_LABEL_MAX) || event.type,
    ...(event.data && Object.keys(event.data).length > 0 ? { payload: event.data } : {}),
  }
}

async function flushEventBatch(key: string, fetchImpl: typeof fetch): Promise<void> {
  const batch = pendingEventBatches.get(key)
  if (!batch) {
    return
  }
  pendingEventBatches.delete(key)
  clearTimeout(batch.timer)
  const label = `${batch.events.length} event(s) for task ${batch.runId}`
  const creds = loadSyncCredentials()
  if (!creds) {
    logHubFailure(label, 'no sync credentials configured')
    return
  }
  const remoteUrl = await originRemoteUrl(batch.cwd)
  const body = {
    remote_url: remoteUrl,
    run_id: batch.runId,
    ticket_id: batch.ticketId,
    events: batch.events,
  }
  const enqueueForRetry = (): void => {
    appendToOutbox(batch.cwd, {
      kind: 'events',
      key: `${batch.runId}:event:${batch.events.length}`,
      run_id: batch.runId,
      remote_url: remoteUrl,
      ticket_id: batch.ticketId,
      events: batch.events,
    })
  }
  try {
    const outcome = await postToHub('/api/cli/events', body, creds, fetchImpl)
    if (outcome.kind === 'ok') {
      return
    }
    if (outcome.kind === 'client_error') {
      logHubFailure(label, `rejected by the hub (${outcome.status}): ${outcome.detail}; abandoned`)
      return
    }
    logHubFailure(label, `${outcome.detail}; queued for retry`)
    enqueueForRetry()
  } catch (err) {
    logHubFailure(label, `${errorMessage(err)}; queued for retry`)
    enqueueForRetry()
  }
}

/**
 * Queues one task journal line for the hub, batched with its task's other
 * pending lines into ONE `POST /api/cli/events`, sent once 20 events have
 * queued, or 5s after the first one did, whichever comes first. Meant to be
 * called only for a task that carries a `hub_ticket` (`tasks-store.ts`'s
 * `appendTaskEvent` is the one caller, gated on that); `ticketId` is taken
 * from it directly rather than re-derived, so this module never has to load
 * a task record to do its job. Never throws.
 */
export function queueHubEvent(opts: {
  cwd: string
  taskId: string
  ticketId: string
  event: TaskEvent
  fetchImpl?: typeof fetch
}): void {
  const { cwd, taskId, ticketId, event, fetchImpl = fetch } = opts
  const armEvent = armEventFrom(taskId, event)
  const key = `${cwd}${KEY_SEP}${taskId}`
  const existing = pendingEventBatches.get(key)
  if (existing) {
    existing.events.push(armEvent)
    if (existing.events.length >= HUB_EVENT_BATCH_MAX) {
      void flushEventBatch(key, fetchImpl)
    }
    return
  }
  const timer = setTimeout(() => {
    void flushEventBatch(key, fetchImpl)
  }, HUB_EVENT_BATCH_DELAY_MS)
  // A pending batch must never keep the process alive on its own: shutdown
  // must not wait out a 5s timer nobody else is blocking on.
  timer.unref?.()
  pendingEventBatches.set(key, { cwd, runId: taskId, ticketId, events: [armEvent], timer })
}

/**
 * Test hygiene: drops every pending batch and its timer, and the cached
 * origin-remote reads alongside it. Never used in production code.
 */
export function resetPendingHubEventBatches(): void {
  for (const batch of pendingEventBatches.values()) {
    clearTimeout(batch.timer)
  }
  pendingEventBatches.clear()
  originRemoteUrlCache.clear()
}

// --- outbox replay -----------------------------------------------------------

function outboxRequest(entry: HubOutboxEntry): { path: string; body: unknown } {
  if (entry.kind === 'transition') {
    return {
      path: `/api/cli/tickets/${encodeURIComponent(entry.ticket_id)}/transitions`,
      body: entry.transition,
    }
  }
  return {
    path: '/api/cli/events',
    body: {
      remote_url: entry.remote_url,
      run_id: entry.run_id,
      ticket_id: entry.ticket_id,
      events: entry.events,
    },
  }
}

/**
 * Replays every entry `.codesema/hub-outbox.jsonl` holds, in file order,
 * and rewrites the file with only what still could not be sent. A line this
 * process cannot parse (a hand edit, a crash-truncated tail) is dropped
 * rather than kept forever unreadable, the same tolerance
 * `tasks-store.ts`'s own journal reader gives a corrupt event line. A 4xx on
 * replay (a 409 included: the hub already applied this idempotency key)
 * drops the entry for good, same rule as a fresh send. Never throws.
 */
export async function flushHubOutbox(cwd: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  migrateLegacyOutbox(cwd)
  const path = hubOutboxPath(cwd)
  if (!existsSync(path)) {
    return
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  const creds = loadSyncCredentials()
  const remaining: HubOutboxEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue
    }
    let entry: HubOutboxEntry
    try {
      entry = JSON.parse(line) as HubOutboxEntry
    } catch {
      continue
    }
    if (!creds) {
      remaining.push(entry)
      continue
    }
    const { path: requestPath, body } = outboxRequest(entry)
    const label = `outbox replay (${entry.kind}, ${entry.key})`
    try {
      const outcome = await postToHub(requestPath, body, creds, fetchImpl)
      if (outcome.kind === 'retryable') {
        logHubFailure(label, `${outcome.detail}; kept for retry`)
        remaining.push(entry)
      } else if (outcome.kind === 'client_error') {
        logHubFailure(
          label,
          `rejected by the hub (${outcome.status}): ${outcome.detail}; abandoned`,
        )
      }
      // 'ok': dropped in silence, a successful replay is not news.
    } catch (err) {
      logHubFailure(label, `${errorMessage(err)}; kept for retry`)
      remaining.push(entry)
    }
  }
  writeFileSync(path, remaining.map((entry) => `${JSON.stringify(entry)}\n`).join(''))
}
