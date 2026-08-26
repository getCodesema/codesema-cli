// Fire-and-forget reporting from the arm (this CLI) back to the brain: the
// local SaaS that owns a ticket while this workspace executes it. Same
// doctrine as task-labels.ts, its closest sibling: never blocks a task
// transition on a network round trip, and a failure that could not be
// recovered by the outbox is always logged, never swallowed.
//
// The brain is reached at the SAME base URL and with the SAME bearer
// credentials as codesema.com cloud sync (sync.ts): `loadSyncCredentials()`
// and `authHeader()`. No credentials configured, or a task with no
// `brain_ticket`: every export here degrades to a no-op, never a throw, the
// same degrade-to-nothing contract as `pushReview`/`autoPushReview`.
//
// Outbox (`.codesema/brain-outbox.jsonl`): same append-only recipe as
// tasks-store.ts's events.jsonl, one JSON line per entry. A report that hit
// a network failure or a 5xx is appended here and replayed by
// `flushBrainOutbox`; a 4xx (the brain itself rejected the body, a stale
// idempotency key included, on a 409) is logged once and dropped, never
// retried: resending the exact same rejected body would only repeat the
// rejection.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureWorkDir } from './config.js'
import {
  ARM_LABEL_MAX,
  cutCodePoints,
  sanitizeArmOrder,
  type ArmEvent,
  type ArmOrder,
  type ArmTransition,
  type TaskEvent,
  type TaskRecord,
  type TaskStatus,
} from './contract.js'
import { tryGitAsync } from './git.js'
import { authHeader, loadSyncCredentials, type SyncCredentials } from './sync.js'

const BRAIN_REQUEST_TIMEOUT_MS = 10_000
const BRAIN_EVENT_BATCH_MAX = 20
const BRAIN_EVENT_BATCH_DELAY_MS = 5_000

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

function brainOutboxPath(cwd: string): string {
  return join(cwd, '.codesema', 'brain-outbox.jsonl')
}

/**
 * One entry of the outbox. `key` is a local label only (never sent to the
 * brain): it names the report in a log line and lets a caller recognise its
 * own write, never a server-side idempotency mechanism. Only
 * `ArmTransition.idempotency_key`, inside `transition`, is that.
 */
type BrainOutboxEntry =
  | { kind: 'transition'; key: string; ticket_id: string; transition: ArmTransition }
  | {
      kind: 'events'
      key: string
      run_id: string
      remote_url: string | null
      ticket_id: string
      events: ArmEvent[]
    }

function appendToOutbox(cwd: string, entry: BrainOutboxEntry): void {
  ensureWorkDir(cwd)
  try {
    const line = `${JSON.stringify(entry)}\n`
    writeFileSync(brainOutboxPath(cwd), line, { flag: 'a' })
  } catch (err) {
    // The outbox itself could not be written (disk full, permissions): the
    // report is lost, and that is said rather than silently swallowed.
    logBrainFailure(`outbox write (${entry.kind}, ${entry.key})`, errorMessage(err))
  }
}

function logBrainFailure(action: string, detail: string): void {
  console.warn(`[brain] ${action}: ${detail}`)
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
 * Same read as server-context.ts: raw, unnormalized; the brain normalizes it
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

type BrainPostOutcome =
  | { kind: 'ok'; body: unknown }
  | { kind: 'client_error'; status: number; detail: string }
  | { kind: 'retryable'; detail: string }

async function postToBrain(
  path: string,
  body: unknown,
  creds: SyncCredentials,
  fetchImpl: typeof fetch,
): Promise<BrainPostOutcome> {
  let res: Response
  try {
    res = await fetchImpl(`${creds.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeader(creds) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(BRAIN_REQUEST_TIMEOUT_MS),
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
  // 5xx: the brain itself is unwell, worth a retry once it recovers. Anything
  // else in the 4xx family: the request itself was refused (bad body, unknown
  // ticket, a 409 replay of an idempotency key already applied) and a retry
  // would only repeat the same refusal.
  return res.status >= 500
    ? { kind: 'retryable', detail }
    : { kind: 'client_error', status: res.status, detail }
}

/**
 * Reports one fact about a brain ticket's execution back to the brain:
 * `mr_opened` on ship, `review_result` on a settled review verdict, `merged`
 * on a landed merge, `failed` on a failure or an explicit interruption. A
 * no-op for a task that carries no `brain_ticket`, and for a machine with no
 * sync credentials configured.
 *
 * `idempotency_key` and `at` are computed here, never by the caller: the key
 * is `<taskId>:<type>:<turn count>`, stable for a given task, transition type
 * and turn count, which is what makes a retried report (this call, or its
 * outbox replay) land on the SAME fact rather than mint a second one, while
 * still telling apart two DIFFERENT facts of the same type on the same task
 * (`review_result` after each of several fix-loop rounds carries a genuinely
 * different verdict; a constant key would have the brain read every round
 * past the first as a duplicate of the first and drop it).
 *
 * Never throws. Offline, or a 5xx: appended to `.codesema/brain-outbox.jsonl`
 * for `flushBrainOutbox` to replay later. A 4xx: logged once and abandoned,
 * never retried.
 */
export async function reportBrainTransition(
  cwd: string,
  record: TaskRecord,
  transition: Omit<ArmTransition, 'idempotency_key' | 'at'>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const ticketId = record.brain_ticket?.id
  if (!ticketId) {
    return
  }
  const full: ArmTransition = {
    ...transition,
    idempotency_key: `${record.id}:${transition.type}:${record.turns.length}`,
    at: new Date().toISOString(),
  }
  const label = `transition '${transition.type}' for task ${record.id}`
  const creds = loadSyncCredentials()
  if (!creds) {
    logBrainFailure(label, 'no sync credentials configured')
    return
  }
  try {
    const outcome = await postToBrain(
      `/api/cli/tickets/${encodeURIComponent(ticketId)}/transitions`,
      full,
      creds,
      fetchImpl,
    )
    if (outcome.kind === 'ok') {
      return
    }
    if (outcome.kind === 'client_error') {
      logBrainFailure(
        label,
        `rejected by the brain (${outcome.status}): ${outcome.detail}; abandoned`,
      )
      return
    }
    logBrainFailure(label, `${outcome.detail}; queued for retry`)
    appendToOutbox(cwd, {
      kind: 'transition',
      key: full.idempotency_key,
      ticket_id: ticketId,
      transition: full,
    })
  } catch (err) {
    // The seam contract says postToBrain never rejects, but a fire-and-forget
    // effect must not depend on that holding forever (same discipline as
    // task-labels.ts's syncCycleLabel): caught here rather than left to
    // become an unhandled rejection.
    logBrainFailure(label, `${errorMessage(err)}; queued for retry`)
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
 * shape: `body` is `unknown` (postToBrain only ever confirms "this parsed as
 * JSON"), so this is the one narrowing step between the wire and
 * `sanitizeArmOrder`, which validates everything else about it.
 */
function orderFieldOf(body: unknown): unknown {
  return body && typeof body === 'object' && 'order' in body
    ? (body as { order: unknown }).order
    : undefined
}

/**
 * Sends a heartbeat for a task's brain ticket lease, and returns the order a
 * human decided from the dashboard while this ticket sat waiting (D19):
 * ship, reply with an instruction, or abandon. `null` on every ordinary tick
 * nothing is waiting on, and on any failure.
 *
 * No outbox: a missed heartbeat is superseded by the next one (the daemon
 * owns the 45s timer, not this module), and a stale order is superseded the
 * same way (the brain purges an order the moment it hands it back, so the
 * next heartbeat only ever carries a fresh one, or none). Retrying either is
 * never useful. Never throws.
 *
 * `localStatus`, when given, rides along as `local_status` so the brain can
 * show this ticket as waiting (or not) on its own dashboard; omitted, the
 * body is `{}`, same as before D19.
 *
 * `cwd` (unused) is kept for call-shape symmetry with this module's other
 * exports (`reportBrainTransition`, `queueBrainEvent`), all of which the
 * daemon calls the same way; a heartbeat needs only the ticket id.
 */
export async function heartbeatBrainTicket(
  _cwd: string,
  record: TaskRecord,
  localStatus?: TaskStatus,
  fetchImpl: typeof fetch = fetch,
): Promise<ArmOrder | null> {
  const ticketId = record.brain_ticket?.id
  if (!ticketId) {
    return null
  }
  const creds = loadSyncCredentials()
  if (!creds) {
    return null
  }
  const label = `heartbeat for task ${record.id}`
  try {
    const outcome = await postToBrain(
      `/api/cli/tickets/${encodeURIComponent(ticketId)}/heartbeat`,
      localStatus ? { local_status: localStatus } : {},
      creds,
      fetchImpl,
    )
    if (outcome.kind !== 'ok') {
      logBrainFailure(label, outcome.detail)
      return null
    }
    return sanitizeArmOrder(orderFieldOf(outcome.body))
  } catch (err) {
    logBrainFailure(label, errorMessage(err))
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

/** The label a journal line carries to the brain: its own message, its own name, or its bare type. */
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
    // Bounded HERE, not only by the brain's schema: one oversized label (a
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
    logBrainFailure(label, 'no sync credentials configured')
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
    const outcome = await postToBrain('/api/cli/events', body, creds, fetchImpl)
    if (outcome.kind === 'ok') {
      return
    }
    if (outcome.kind === 'client_error') {
      logBrainFailure(
        label,
        `rejected by the brain (${outcome.status}): ${outcome.detail}; abandoned`,
      )
      return
    }
    logBrainFailure(label, `${outcome.detail}; queued for retry`)
    enqueueForRetry()
  } catch (err) {
    logBrainFailure(label, `${errorMessage(err)}; queued for retry`)
    enqueueForRetry()
  }
}

/**
 * Queues one task journal line for the brain, batched with its task's other
 * pending lines into ONE `POST /api/cli/events`, sent once 20 events have
 * queued, or 5s after the first one did, whichever comes first. Meant to be
 * called only for a task that carries a `brain_ticket` (`tasks-store.ts`'s
 * `appendTaskEvent` is the one caller, gated on that); `ticketId` is taken
 * from it directly rather than re-derived, so this module never has to load
 * a task record to do its job. Never throws.
 */
export function queueBrainEvent(opts: {
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
    if (existing.events.length >= BRAIN_EVENT_BATCH_MAX) {
      void flushEventBatch(key, fetchImpl)
    }
    return
  }
  const timer = setTimeout(() => {
    void flushEventBatch(key, fetchImpl)
  }, BRAIN_EVENT_BATCH_DELAY_MS)
  // A pending batch must never keep the process alive on its own: shutdown
  // must not wait out a 5s timer nobody else is blocking on.
  timer.unref?.()
  pendingEventBatches.set(key, { cwd, runId: taskId, ticketId, events: [armEvent], timer })
}

/**
 * Test hygiene: drops every pending batch and its timer, and the cached
 * origin-remote reads alongside it. Never used in production code.
 */
export function resetPendingBrainEventBatches(): void {
  for (const batch of pendingEventBatches.values()) {
    clearTimeout(batch.timer)
  }
  pendingEventBatches.clear()
  originRemoteUrlCache.clear()
}

// --- outbox replay -----------------------------------------------------------

function outboxRequest(entry: BrainOutboxEntry): { path: string; body: unknown } {
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
 * Replays every entry `.codesema/brain-outbox.jsonl` holds, in file order,
 * and rewrites the file with only what still could not be sent. A line this
 * process cannot parse (a hand edit, a crash-truncated tail) is dropped
 * rather than kept forever unreadable, the same tolerance
 * `tasks-store.ts`'s own journal reader gives a corrupt event line. A 4xx on
 * replay (a 409 included: the brain already applied this idempotency key)
 * drops the entry for good, same rule as a fresh send. Never throws.
 */
export async function flushBrainOutbox(
  cwd: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const path = brainOutboxPath(cwd)
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
  const remaining: BrainOutboxEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue
    }
    let entry: BrainOutboxEntry
    try {
      entry = JSON.parse(line) as BrainOutboxEntry
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
      const outcome = await postToBrain(requestPath, body, creds, fetchImpl)
      if (outcome.kind === 'retryable') {
        logBrainFailure(label, `${outcome.detail}; kept for retry`)
        remaining.push(entry)
      } else if (outcome.kind === 'client_error') {
        logBrainFailure(
          label,
          `rejected by the brain (${outcome.status}): ${outcome.detail}; abandoned`,
        )
      }
      // 'ok': dropped in silence, a successful replay is not news.
    } catch (err) {
      logBrainFailure(label, `${errorMessage(err)}; kept for retry`)
      remaining.push(entry)
    }
  }
  writeFileSync(path, remaining.map((entry) => `${JSON.stringify(entry)}\n`).join(''))
}
