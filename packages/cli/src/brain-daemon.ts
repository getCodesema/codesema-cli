// Background loop for `codesema workspace --brain` / `codesema brain serve`:
// on the SAME TaskManager and process as the local web server, it flushes
// anything task-brain.ts's outbox could not send earlier, drafts and submits
// any ticket request the brain has queued for this repo, and — once the
// workspace has no task already running here — claims the next published
// ticket and hands it to the task manager exactly as if it had been typed by
// hand. A claimed brain-ticket task is kept alive with a heartbeat every 45s,
// on its own schedule, independent of the main tick's backoff.

import {
  brainRemoteUrl,
  claimTicket,
  claimTicketRequest,
  listTicketRequests,
  listTickets,
} from './brain-client.js'
import { draftAndSubmitTicketRequest } from './brain-draft.js'
import { isActiveTaskStatus, type ArmTicketRequest } from './contract.js'
import { loadSyncCredentials, type SyncCredentials } from './sync.js'
import { createBrainTicketTask } from './task-brain-ticket.js'
import { flushBrainOutbox, heartbeatBrainTicket } from './task-brain.js'
import { activeTask } from './task-queue.js'
import type { TaskManager } from './task-server.js'

const DEFAULT_INTERVAL_MS = 25_000
const MAX_BACKOFF_MS = 5 * 60_000
const HEARTBEAT_INTERVAL_MS = 45_000

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Same resolution `createBrainTicketTask` (task-brain-ticket.ts) uses
 * internally (`listAll().find(path match)`), reused here rather than
 * `projects.ts`'s `projectIdFor` directly: the two must agree on which
 * project `cwd` names, and going through the manager the task itself will be
 * created on is what guarantees that instead of assuming two derivations
 * stay in step.
 */
function resolveProjectId(manager: TaskManager, cwd: string): string | null {
  return manager.listAll().find((entry) => entry.project.path === cwd)?.project.id ?? null
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
      ctx.logOnce('requests-unavailable', 'this brain has no ticket-requests route yet; skipping')
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
      'brain mode is on but this directory is not a registered project; not claiming',
    )
    return 'ok'
  }
  // A brain task parked on 'interrupted' (daemon killed mid-turn, machine
  // rebooted) would otherwise freeze the loop forever: the guard below blocks
  // new claims while nothing human ever resumes it. 24/7 means the daemon is
  // that resumer for its own tickets; human-created tasks keep their manual
  // resume affordance untouched.
  const interrupted = entry.records.find(
    (record) => record.status === 'interrupted' && record.brain_ticket,
  )
  if (interrupted) {
    const outcome = ctx.manager.resume(entry.project.id, interrupted.id)
    if (outcome.ok) {
      ctx.log(
        `resumed interrupted task ${interrupted.id} for ticket ${interrupted.brain_ticket?.id ?? ''}`,
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
      ctx.logOnce('tickets-unavailable', 'this brain has no tickets route yet; skipping')
      return 'ok'
    }
    return isRetryable(result.error) ? 'retryable' : 'ok'
  }
  const next = result.data[0]
  if (!next) {
    return 'ok'
  }
  if (
    entry.records.some(
      (record) => record.brain_ticket?.id === next.id && record.status !== 'failed',
    )
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
  const created = await createBrainTicketTask(ctx.manager, ctx.cwd, claim.data.ticket)
  ctx.log(
    created.ok
      ? `started task ${created.record.id} from ticket ${next.id}`
      : `could not start a task from ticket ${next.id}: ${created.error}`,
  )
  return 'ok'
}

async function tick(ctx: DaemonContext): Promise<TickOutcome> {
  await flushBrainOutbox(ctx.cwd, ctx.fetchImpl)

  const creds = loadSyncCredentials()
  if (!creds) {
    ctx.logOnce(
      'not-connected',
      'brain mode is on but not connected (run `codesema brain connect`)',
    )
    return 'ok'
  }
  const remoteUrl = brainRemoteUrl(ctx.cwd)
  if (!remoteUrl) {
    ctx.logOnce('no-remote', 'brain mode is on but this workspace has no git origin remote')
    return 'ok'
  }

  const requestsOutcome = await draftQueuedRequests(ctx, remoteUrl, creds)
  const ticketOutcome = await claimNextTicket(ctx, remoteUrl, creds)
  return requestsOutcome === 'retryable' || ticketOutcome === 'retryable' ? 'retryable' : 'ok'
}

async function heartbeatTick(ctx: DaemonContext): Promise<void> {
  const projectId = resolveProjectId(ctx.manager, ctx.cwd)
  if (!projectId) {
    return
  }
  const activeId = activeTask(projectId)
  if (!activeId) {
    return
  }
  const found = ctx.manager.get(projectId, activeId)
  if (!found?.record.brain_ticket) {
    return
  }
  await heartbeatBrainTicket(ctx.cwd, found.record, ctx.fetchImpl)
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

export type BrainDaemonHandle = { stop: () => Promise<void> }

export type StartBrainDaemonOptions = {
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
}

export function startBrainDaemon(opts: StartBrainDaemonOptions): BrainDaemonHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS
  const fetchImpl = opts.fetchImpl ?? fetch
  const log = opts.logFn ?? ((line: string) => console.log(`[brain] ${line}`))
  const draftFn = opts.draftFn ?? draftAndSubmitTicketRequest
  const sleepFn = opts.sleepFn ?? sleep
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
