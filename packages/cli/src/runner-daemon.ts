// Background loop for `codesema workspace --runner` / `codesema runner serve`:
// on the SAME TaskManager and process as the local web server, it flushes
// anything task-hub.ts's outbox could not send earlier, drafts and submits
// any ticket request the hub has queued for this repo, and — once the
// workspace has no task already running here — claims the next published
// ticket and hands it to the task manager exactly as if it had been typed by
// hand. A claimed hub-ticket task is kept alive with a heartbeat every 45s,
// on its own schedule, independent of the main tick's backoff, and a
// decision a human made from the dashboard while that ticket sat waiting
// (D19) rides back on that same heartbeat and is applied here: ship, reply,
// or abandon.

import { runnerEnvPath } from './config.js'
import { isActiveTaskStatus, type ArmOrder, type ArmTicketRequest } from './contract.js'
import {
  claimPendingSecret,
  claimTicket,
  claimTicketRequest,
  hubRemoteUrl,
  listTicketRequests,
  listTickets,
} from './hub-client.js'
import { loadRunnerIdentity } from './runner-identity.js'
import { applySecretsToEnvFile, sanitizeRunnerSecretsPayload } from './runner-secrets.js'
import { unseal } from './sealed-box.js'
import { loadSyncCredentials, type SyncCredentials } from './sync.js'
import { createHubTicketTask } from './task-hub-ticket.js'
import { flushHubOutbox, heartbeatHubTicket } from './task-hub.js'
import type { TaskActionResult } from './task-runner.js'
import type { TaskManager } from './task-server.js'
import { draftAndSubmitTicketRequest } from './ticket-draft.js'

const DEFAULT_INTERVAL_MS = 25_000
const MAX_BACKOFF_MS = 5 * 60_000
const HEARTBEAT_INTERVAL_MS = 45_000

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type DraftRequestFn = (
  request: ArmTicketRequest,
  cwd: string,
  seams: { fetchImpl?: typeof fetch },
) => ReturnType<typeof draftAndSubmitTicketRequest>

type DaemonContext = {
  manager: TaskManager
  cwd: string
  fetchImpl: typeof fetch
  draftFn: DraftRequestFn
  log: (line: string) => void
  /** Once per distinct `key` for the whole daemon lifetime, never per tick. */
  logOnce: (key: string, line: string) => void
  loadIdentityFn: typeof loadRunnerIdentity
  claimSecretFn: typeof claimPendingSecret
  unsealFn: typeof unseal
  sanitizeSecretsFn: typeof sanitizeRunnerSecretsPayload
  applySecretsFn: typeof applySecretsToEnvFile
}

/** Whether this half-tick saw a network failure or a 5xx: the ONLY conditions that back off the next tick. */
type TickOutcome = 'ok' | 'retryable'

function isRetryable(
  error: { kind: 'http'; status: number } | { kind: 'network' } | { kind: 'unavailable' },
): boolean {
  return error.kind === 'network' || (error.kind === 'http' && error.status >= 500)
}

async function draftQueuedRequests(
  ctx: DaemonContext,
  remoteUrl: string,
  creds: SyncCredentials,
): Promise<TickOutcome> {
  const result = await listTicketRequests(creds, remoteUrl, ctx.fetchImpl)
  if (!result.ok) {
    if (result.error.kind === 'unavailable') {
      ctx.logOnce('requests-unavailable', 'this hub has no ticket-requests route yet; skipping')
      return 'ok'
    }
    return isRetryable(result.error) ? 'retryable' : 'ok'
  }
  for (const request of result.data) {
    const claimed = await claimTicketRequest(creds, request.id, ctx.fetchImpl)
    if (!claimed.ok) {
      // A 409 (claimed by another arm first) is routine, not worth a line.
      if (claimed.error.kind === 'http' && claimed.error.status !== 409) {
        ctx.log(`could not claim ticket request ${request.id}: ${claimed.error.error}`)
      }
      continue
    }
    ctx.log(`drafting a ticket for request ${request.id}`)
    const drafted = await ctx.draftFn(claimed.data, ctx.cwd, { fetchImpl: ctx.fetchImpl })
    ctx.log(
      drafted.ok
        ? `published ${drafted.tickets.length} ticket(s) from request ${request.id}`
        : `request ${request.id} failed: ${drafted.reason}`,
    )
  }
  return 'ok'
}

async function claimNextTicket(
  ctx: DaemonContext,
  remoteUrl: string,
  creds: SyncCredentials,
): Promise<TickOutcome> {
  // Guarded on the PERSISTED records, not on `activeTask()`: the in-memory
  // slot is only taken at admission, so a task still `queued` (or parked on
  // `waiting_for_you`) would leave the slot free while the claim below is
  // idempotent for this executor, and every tick would mint one more task
  // for the very same ticket. Fail-closed when the directory is not a
  // registered project: claiming a ticket no task could be created for
  // would strand it until its lease expires.
  const entry = ctx.manager.listAll().find((candidate) => candidate.project.path === ctx.cwd)
  if (!entry) {
    ctx.logOnce(
      'no-project',
      'runner mode is on but this directory is not a registered project; not claiming',
    )
    return 'ok'
  }
  // A hub-ticket task parked on 'interrupted' (daemon killed mid-turn, machine
  // rebooted) would otherwise freeze the loop forever: the guard below blocks
  // new claims while nothing human ever resumes it. 24/7 means the daemon is
  // that resumer for its own tickets; human-created tasks keep their manual
  // resume affordance untouched.
  const interrupted = entry.records.find(
    (record) => record.status === 'interrupted' && record.hub_ticket,
  )
  if (interrupted) {
    const outcome = ctx.manager.resume(entry.project.id, interrupted.id)
    if (outcome.ok) {
      ctx.log(
        `resumed interrupted task ${interrupted.id} for ticket ${interrupted.hub_ticket?.id ?? ''}`,
      )
      return 'ok'
    }
    // An interruption can land BETWEEN turns (the review or the ship was cut,
    // the turn itself completed): there is no turn to resume, only a cycle to
    // re-enter. A reply opens a fresh turn whose checks/review/ship run again.
    const replied = ctx.manager.reply(
      entry.project.id,
      interrupted.id,
      'The previous turn completed but its review or ship was interrupted. Verify the work in the worktree still satisfies every acceptance criterion, fix anything missing, and finish.',
    )
    ctx.log(
      replied.ok
        ? `re-entered interrupted task ${interrupted.id} with a continuation turn`
        : `could not resume task ${interrupted.id}: resume says "${outcome.error}", reply says "${replied.error}"`,
    )
    return 'ok'
  }
  if (entry.records.some((record) => isActiveTaskStatus(record.status))) {
    return 'ok'
  }
  const result = await listTickets(creds, remoteUrl, 'published', ctx.fetchImpl)
  if (!result.ok) {
    if (result.error.kind === 'unavailable') {
      ctx.logOnce('tickets-unavailable', 'this hub has no tickets route yet; skipping')
      return 'ok'
    }
    return isRetryable(result.error) ? 'retryable' : 'ok'
  }
  const next = result.data[0]
  if (!next) {
    return 'ok'
  }
  if (
    entry.records.some((record) => record.hub_ticket?.id === next.id && record.status !== 'failed')
  ) {
    ctx.logOnce(
      `ticket-${next.id}`,
      `ticket ${next.id} already has a local task; not claiming it again`,
    )
    return 'ok'
  }
  const claim = await claimTicket(creds, next.id, {}, ctx.fetchImpl)
  if (!claim.ok) {
    if (claim.error.kind === 'http' && claim.error.status !== 409) {
      ctx.log(`could not claim ticket ${next.id}: ${claim.error.error}`)
    }
    return isRetryable(claim.error) ? 'retryable' : 'ok'
  }
  const created = await createHubTicketTask(ctx.manager, ctx.cwd, claim.data.ticket)
  ctx.log(
    created.ok
      ? `started task ${created.record.id} from ticket ${next.id}`
      : `could not start a task from ticket ${next.id}: ${created.error}`,
  )
  return 'ok'
}

/**
 * Claims and applies whatever secret the hub is holding for this machine's
 * runner identity, as steady-state rotation, distinct from the one-time
 * provisioning at `codesema runner connect`. Every failure mode short of a
 * programming error degrades to a no-op: no local identity yet (the machine
 * never registered as a runner), no pending secret (the routine case on
 * almost every tick), an unreadable blob (undecryptable, not valid JSON, or
 * failing payload validation), or a network failure (the main tick's own
 * backoff already covers reachability, so this stays silent rather than
 * doubling up on it). Only the unreadable-blob failures are worth a log
 * line, since those point at a misconfigured hub or runner rather than
 * routine network flakiness.
 */
async function checkPendingSecretRotation(
  ctx: DaemonContext,
  creds: SyncCredentials,
): Promise<void> {
  const identity = ctx.loadIdentityFn()
  if (!identity) {
    ctx.logOnce(
      'no-runner-identity',
      'runner mode is on but this machine has no runner identity yet',
    )
    return
  }
  const claimed = await ctx.claimSecretFn(creds, identity.fingerprint, ctx.fetchImpl)
  if (!claimed.ok || !claimed.data) {
    return
  }
  const plaintext = ctx.unsealFn(identity.privateKey, claimed.data.ciphertext)
  if (!plaintext) {
    ctx.log('could not decrypt the pending runner secret; skipping this rotation')
    return
  }
  let parsedPlaintext: unknown
  try {
    parsedPlaintext = JSON.parse(plaintext.toString('utf8'))
  } catch {
    ctx.log('the decrypted runner secret is not valid JSON; skipping this rotation')
    return
  }
  const payload = ctx.sanitizeSecretsFn(parsedPlaintext)
  if (!payload) {
    ctx.log('the decrypted runner secret failed validation; skipping this rotation')
    return
  }
  ctx.applySecretsFn(runnerEnvPath(), payload.secrets)
  Object.assign(process.env, payload.secrets)
  const appliedKeys = Object.keys(payload.secrets)
  if (appliedKeys.length > 0) {
    ctx.log(`applied rotated runner secret(s): ${appliedKeys.join(', ')}`)
  }
}

async function tick(ctx: DaemonContext): Promise<TickOutcome> {
  await flushHubOutbox(ctx.cwd, ctx.fetchImpl)

  const creds = loadSyncCredentials()
  if (!creds) {
    ctx.logOnce(
      'not-connected',
      'runner mode is on but not connected (run `codesema runner connect`)',
    )
    return 'ok'
  }

  await checkPendingSecretRotation(ctx, creds)

  const remoteUrl = hubRemoteUrl(ctx.cwd)
  if (!remoteUrl) {
    ctx.logOnce('no-remote', 'runner mode is on but this workspace has no git origin remote')
    return 'ok'
  }

  const requestsOutcome = await draftQueuedRequests(ctx, remoteUrl, creds)
  const ticketOutcome = await claimNextTicket(ctx, remoteUrl, creds)
  return requestsOutcome === 'retryable' || ticketOutcome === 'retryable' ? 'retryable' : 'ok'
}

function dispatchArmOrder(
  manager: TaskManager,
  projectId: string,
  id: string,
  order: ArmOrder,
): Promise<TaskActionResult> {
  if (order.action === 'ship') {
    return manager.ship(projectId, id)
  }
  if (order.action === 'abandon') {
    return manager.abandon(projectId, id)
  }
  return Promise.resolve(manager.reply(projectId, id, order.instruction ?? ''))
}

/**
 * Applies a decision a human made from the dashboard while this ticket sat
 * waiting (D19): ship, reply with the human's instruction, or abandon. A
 * refusal from the manager (its own status guards: already shipped, a ship
 * already in flight, and so on) is JOURNALED here, never retried: the same
 * order rides the next heartbeat only if the hub still has it to hand
 * back, and a manager guard is what keeps a duplicate delivery from
 * double-applying anything.
 */
async function applyArmOrder(
  ctx: DaemonContext,
  projectId: string,
  id: string,
  order: ArmOrder,
): Promise<void> {
  const outcome = await dispatchArmOrder(ctx.manager, projectId, id, order)
  ctx.log(
    outcome.ok
      ? `applied arm order '${order.action}' for task ${id}`
      : `arm order '${order.action}' for task ${id} refused: ${outcome.error}`,
  )
}

/**
 * Keyed on the PERSISTED status (`isActiveTaskStatus`, the same predicate
 * `claimNextTicket` gates new claims on), not on the in-memory active-task
 * slot: that slot empties the moment a turn's promise settles
 * (task-runner.ts), so a task parked on `waiting_for_you` would otherwise go
 * silently un-heartbeat for as long as it waits on a human. This is the fix
 * for the "24 invisible minutes" the 2026-08-26 bench run traced back to
 * this function. `isActiveTaskStatus` counts `waiting_for_you` as active,
 * which is exactly the status this exists to keep beating for.
 */
async function heartbeatTick(ctx: DaemonContext): Promise<void> {
  const entry = ctx.manager.listAll().find((candidate) => candidate.project.path === ctx.cwd)
  if (!entry) {
    return
  }
  const found = entry.records.find(
    (record) => record.hub_ticket && isActiveTaskStatus(record.status),
  )
  if (!found) {
    return
  }
  const order = await heartbeatHubTicket(ctx.cwd, found, found.status, ctx.fetchImpl)
  if (order) {
    await applyArmOrder(ctx, entry.project.id, found.id, order)
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

export type RunnerDaemonHandle = { stop: () => Promise<void> }

export type StartRunnerDaemonOptions = {
  manager: TaskManager
  cwd: string
  intervalMs?: number
  fetchImpl?: typeof fetch
  /** Test seam. */
  logFn?: (line: string) => void
  /** Test seam. */
  draftFn?: DraftRequestFn
  /** Test seam: an injectable, abortable sleep instead of the real timers. */
  sleepFn?: (ms: number, signal: AbortSignal) => Promise<void>
  /** Test seam. */
  loadIdentityFn?: typeof loadRunnerIdentity
  /** Test seam. */
  claimSecretFn?: typeof claimPendingSecret
  /** Test seam. */
  unsealFn?: typeof unseal
  /** Test seam. */
  sanitizeSecretsFn?: typeof sanitizeRunnerSecretsPayload
  /** Test seam. */
  applySecretsFn?: typeof applySecretsToEnvFile
}

export function startRunnerDaemon(opts: StartRunnerDaemonOptions): RunnerDaemonHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const fetchImpl = opts.fetchImpl ?? fetch
  const log = opts.logFn ?? ((line: string) => console.log(`[runner] ${line}`))
  const draftFn = opts.draftFn ?? draftAndSubmitTicketRequest
  const sleepFn = opts.sleepFn ?? sleep
  const loadIdentityFn = opts.loadIdentityFn ?? loadRunnerIdentity
  const claimSecretFn = opts.claimSecretFn ?? claimPendingSecret
  const unsealFn = opts.unsealFn ?? unseal
  const sanitizeSecretsFn = opts.sanitizeSecretsFn ?? sanitizeRunnerSecretsPayload
  const applySecretsFn = opts.applySecretsFn ?? applySecretsToEnvFile
  const controller = new AbortController()
  const loggedOnce = new Set<string>()

  const ctx: DaemonContext = {
    manager: opts.manager,
    cwd: opts.cwd,
    fetchImpl,
    draftFn,
    log,
    logOnce: (key, line) => {
      if (loggedOnce.has(key)) {
        return
      }
      loggedOnce.add(key)
      log(line)
    },
    loadIdentityFn,
    claimSecretFn,
    unsealFn,
    sanitizeSecretsFn,
    applySecretsFn,
  }

  let backoffMs = intervalMs
  const mainLoop = (async () => {
    while (!controller.signal.aborted) {
      let outcome: TickOutcome = 'ok'
      try {
        outcome = await tick(ctx)
      } catch (err) {
        log(`tick failed: ${errorMessage(err)}`)
        outcome = 'retryable'
      }
      backoffMs = outcome === 'ok' ? intervalMs : Math.min(backoffMs * 2, MAX_BACKOFF_MS)
      await sleepFn(backoffMs, controller.signal)
    }
  })()

  const heartbeatLoop = (async () => {
    while (!controller.signal.aborted) {
      await sleepFn(HEARTBEAT_INTERVAL_MS, controller.signal)
      if (controller.signal.aborted) {
        break
      }
      try {
        await heartbeatTick(ctx)
      } catch (err) {
        log(`heartbeat failed: ${errorMessage(err)}`)
      }
    }
  })()

  return {
    stop: async () => {
      controller.abort()
      await Promise.allSettled([mainLoop, heartbeatLoop])
    },
  }
}
