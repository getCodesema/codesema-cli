// `codesema brain …`: connect a workspace to a brain, inspect it, draft and
// publish a ticket by hand, or start/stop the background daemon (D21: `serve
// --detach` backgrounds it, `stop` ends it). Same shape as sync.ts's
// `syncCommand`/`linkCommand`: one action-dispatching entry point. Usage
// errors throw a plain `Error` the CLI's top-level catch prints; `stop` is
// the one action that is a no-op rather than an error when there is nothing
// to do: stopping an already-stopped daemon is success, not misuse.

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { runAgent } from './agent.js'
import {
  brainErrorMessage,
  brainRemoteUrl,
  listInFlightTickets,
  listTickets,
  parseBrainToken,
  type InFlightTicket,
} from './brain-client.js'
import { draftAndPublishTicket } from './brain-draft.js'
import { readBrainPidfile, removeBrainPidfile } from './brain-pidfile.js'
import { installBrainService, uninstallBrainService, type ExecCommandFn } from './brain-service.js'
import { loadGlobalConfig, saveGlobalConfig } from './config.js'
import { tryGit } from './git.js'
import { t } from './i18n.js'
import { loadSyncCredentials } from './sync.js'
import { ACCENT, AMBER, dim, GREEN, paint, renderFieldRows, type FieldRow } from './ui.js'
import { isPidAlive } from './workspace-lock.js'
import { workspace } from './workspace.js'

/**
 * The one `spawn` overload `spawnDetachedBrainServe` actually calls, pulled
 * out as its own type rather than `typeof spawn`: the real signature is a
 * dozen overloads deep, which a test fake has no reason to satisfy.
 */
type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

/** Same bkctl-style result block as sync.ts's own (private there, so restated here). */
function printResult(statusMessage: string, rows: FieldRow[]): void {
  console.log('')
  console.log(`  ${paint('✔', GREEN)} ${statusMessage}`)
  for (const line of renderFieldRows(rows)) {
    console.log(`  ${line}`)
  }
}

export type BrainCommandOptions = {
  action?: string | undefined
  cwd: string
  url?: string | undefined
  token?: string | undefined
  issue?: string | undefined
  title?: string | undefined
  prompt?: string | undefined
  /** `brain serve --detach` only: background the daemon instead of running it here. */
  detach?: boolean | undefined
  /** `brain install-service` only: EnvironmentFile= for the generated systemd unit. */
  envFile?: string | undefined
  /** Test seam. */
  fetchImpl?: typeof fetch | undefined
  /** Test seam. */
  runAgentFn?: typeof runAgent | undefined
  /** Test seam for `brain serve --detach`: never forks a real process in tests. */
  spawnFn?: SpawnFn | undefined
  /** Test seam for `brain install-service`/`uninstall-service`: never shells out to a real systemctl/loginctl in tests. */
  execFn?: ExecCommandFn | undefined
  /** Test seams for `brain stop`'s bounded poll: real 10s/200ms by default. */
  stopTimeoutMs?: number | undefined
  stopPollIntervalMs?: number | undefined
}

async function brainConnect(opts: BrainCommandOptions): Promise<void> {
  if (!opts.url || !opts.token) {
    throw new Error(t('brain.connectMissingFlags'))
  }
  const parsed = parseBrainToken(opts.token)
  if (!parsed) {
    throw new Error(t('brain.badToken'))
  }
  // Same global credentials sync.ts's createWorkspace/linkWorkspace write:
  // `codesema sync`, `codesema link` and the brain daemon share one account.
  const path = saveGlobalConfig({
    ...loadGlobalConfig(),
    syncUrl: opts.url,
    syncWorkspaceId: parsed.workspaceId,
    syncSecret: parsed.secret,
  })
  printResult(t('brain.connected', { url: opts.url }), [
    { label: t('field.account'), value: parsed.workspaceId },
  ])
  console.log(`  ${t('brain.savedTo', { path })}`)
  console.log('')
}

/**
 * Local-only: clears the three credentials `brainConnect` wrote, the same
 * destructure-and-omit `sync.ts`'s `deleteWorkspaceData` uses to drop
 * `syncWorkspaceId`/`syncSecret` (here all three, since disconnecting a brain
 * is meant to fully forget it, not just its data). No API call — the brain
 * has its own revocation, shipped separately in its dashboard Settings — so
 * this only ever touches the local file and reminds the caller to revoke
 * there too.
 */
async function brainDisconnect(): Promise<void> {
  const config = loadGlobalConfig()
  if (!config.syncUrl && !config.syncWorkspaceId && !config.syncSecret) {
    printResult(t('brain.alreadyDisconnected'), [])
    return
  }
  const { syncUrl: _url, syncWorkspaceId: _id, syncSecret: _secret, ...rest } = config
  saveGlobalConfig(rest)
  printResult(t('brain.disconnected'), [])
  console.log(`  ${paint(t('brain.disconnectRevokeReminder'), AMBER)}`)
  console.log('')
}

/** `{2h14m}` / `{6m03s}` / `{9s}`: coarsest-first, no leading zero on the coarsest unit. */
function formatUptime(startedAt: string, nowMs: number): string {
  const elapsedS = Math.max(0, Math.floor((nowMs - Date.parse(startedAt)) / 1000))
  const h = Math.floor(elapsedS / 3600)
  const m = Math.floor((elapsedS % 3600) / 60)
  const s = elapsedS % 60
  if (h > 0) {
    return `${h}h${String(m).padStart(2, '0')}m`
  }
  if (m > 0) {
    return `${m}m${String(s).padStart(2, '0')}s`
  }
  return `${s}s`
}

/** `{12s ago}` / `{3min ago}` / `{2h ago}` / `{5d ago}`: coarsest unit only, i18n'd via `brain.heartbeat*`. */
function formatHeartbeatAge(updatedAt: string, nowMs: number): string {
  const elapsedS = Math.max(0, Math.floor((nowMs - Date.parse(updatedAt)) / 1000))
  if (elapsedS < 60) {
    return t('brain.heartbeatSeconds', { n: elapsedS })
  }
  const elapsedMin = Math.floor(elapsedS / 60)
  if (elapsedMin < 60) {
    return t('brain.heartbeatMinutes', { n: elapsedMin })
  }
  const elapsedH = Math.floor(elapsedMin / 60)
  if (elapsedH < 24) {
    return t('brain.heartbeatHours', { n: elapsedH })
  }
  return t('brain.heartbeatDays', { n: Math.floor(elapsedH / 24) })
}

const IN_FLIGHT_TITLE_MAX = 64

function truncateInFlightTitle(title: string): string {
  return title.length > IN_FLIGHT_TITLE_MAX ? `${title.slice(0, IN_FLIGHT_TITLE_MAX - 1)}…` : title
}

/**
 * One `brain status` in-flight detail line: brain status, executor, heartbeat
 * age, the arm's own local status when the brain reports one (absent on a
 * brain build older than that field), and a `stale` tag when the claim's
 * lease has already lapsed: a ticket a dead or stuck arm is still shown as
 * holding.
 */
function inFlightDetailLine(ticket: InFlightTicket, nowMs: number): string {
  const facts = [
    ticket.status,
    ticket.executed_by ?? t('brain.fieldUnclaimed'),
    formatHeartbeatAge(ticket.updated_at, nowMs),
    ...(ticket.arm_local_status ? [ticket.arm_local_status] : []),
  ]
  const line = dim(facts.join(' · '))
  const isStale = ticket.lease_expires_at !== null && Date.parse(ticket.lease_expires_at) < nowMs
  return isStale ? `${line} ${paint(t('brain.fieldStale'), AMBER)}` : line
}

function printInFlightTickets(tickets: InFlightTicket[]): void {
  console.log('')
  console.log(`  ${paint(t('brain.inFlightHeading'), ACCENT)}`)
  const nowMs = Date.now()
  for (const ticket of tickets) {
    console.log(`    ${truncateInFlightTitle(ticket.title)}`)
    console.log(`      ${inFlightDetailLine(ticket, nowMs)}`)
  }
}

/**
 * The daemon rows for `brain status`: pid/port/uptime read off the D21
 * pidfile, or a single "not running" row. A pidfile naming a dead pid is
 * cleaned up here too, the same read-time doctrine `brainStop` uses, so
 * neither command leaves a stale file for the other to trip over.
 */
function brainDaemonStatusRows(cwd: string): FieldRow[] {
  const pidfile = readBrainPidfile(cwd)
  if (!pidfile || !isPidAlive(pidfile.pid)) {
    if (pidfile) {
      removeBrainPidfile(cwd, pidfile.pid)
    }
    return [{ label: t('brain.fieldDaemon'), value: t('brain.notRunning') }]
  }
  return [
    { label: t('brain.fieldPid'), value: String(pidfile.pid) },
    { label: t('brain.fieldPort'), value: String(pidfile.port) },
    { label: t('brain.fieldUptime'), value: formatUptime(pidfile.started_at, Date.now()) },
  ]
}

async function brainStatus(opts: BrainCommandOptions): Promise<void> {
  const creds = loadSyncCredentials()
  if (!creds) {
    throw new Error(t('brain.notConnected'))
  }
  const remoteUrl = brainRemoteUrl(opts.cwd)
  const rows: FieldRow[] = [
    { label: t('brain.fieldUrl'), value: creds.url },
    { label: t('field.account'), value: creds.workspaceId },
    { label: t('brain.fieldRepo'), value: remoteUrl ?? t('brain.noRemote') },
    ...brainDaemonStatusRows(opts.cwd),
  ]
  if (!remoteUrl) {
    printResult(t('brain.statusTitle'), rows)
    return
  }
  const fetchImpl = opts.fetchImpl ?? fetch
  const result = await listTickets(creds, remoteUrl, 'published', fetchImpl)
  rows.push({
    label: t('brain.fieldReady'),
    value: result.ok ? String(result.data.length) : brainErrorMessage(result.error),
  })
  const inFlight = await listInFlightTickets(creds, remoteUrl, fetchImpl)
  rows.push({
    label: t('brain.fieldInFlight'),
    value: inFlight.ok ? String(inFlight.data.length) : brainErrorMessage(inFlight.error),
  })
  printResult(t('brain.statusTitle'), rows)
  if (inFlight.ok && inFlight.data.length > 0) {
    printInFlightTickets(inFlight.data)
  }
}

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

async function brainTicket(opts: BrainCommandOptions): Promise<void> {
  const hasIssue = opts.issue !== undefined
  const hasPromptForm = opts.title !== undefined && opts.prompt !== undefined
  if (hasIssue === hasPromptForm) {
    throw new Error(t('brain.ticketUsage'))
  }

  const seams = {
    ...(opts.runAgentFn ? { runAgentFn: opts.runAgentFn } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  }
  const outcome = hasIssue
    ? await (async () => {
        const issueNumber = opts.issue ? parsePositiveInt(opts.issue) : null
        if (issueNumber === null) {
          throw new Error(t('brain.badIssueNumber', { value: opts.issue ?? '' }))
        }
        return draftAndPublishTicket({ kind: 'issue', cwd: opts.cwd, issueNumber }, seams)
      })()
    : await draftAndPublishTicket(
        {
          kind: 'prompt',
          cwd: opts.cwd,
          title: opts.title as string,
          prompt: opts.prompt as string,
        },
        seams,
      )

  if (!outcome.ok) {
    throw new Error(t('brain.draftFailed', { reason: outcome.reason }))
  }
  printResult(t('brain.ticketCreated', { title: outcome.ticket.title }), [
    { label: t('brain.fieldId'), value: outcome.ticket.id },
    { label: t('field.status'), value: outcome.ticket.status },
  ])
  console.log('')
  console.log(outcome.ticket.body)
  console.log('')
}

function brainDaemonLogPath(cwd: string): string {
  return join(cwd, '.codesema', 'brain-daemon.log')
}

/**
 * Re-invokes THIS SAME binary as `codesema brain serve` (no --detach: that
 * flag names what the CURRENT process does, not the child, or every child
 * would refork itself), detached and unref'd so it outlives us, stdout/stderr
 * appended to a repo-local log since a detached process has no terminal to
 * write to. `process.argv[1]` is the same self-reference `index.ts`'s
 * `isProcessEntrypoint` resolves against: the bin script, whether that is
 * the built `dist/index.mjs` or a dev entry point.
 */
function spawnDetachedBrainServe(cwd: string, spawnFn: SpawnFn): ChildProcess {
  const entry = process.argv[1]
  if (entry === undefined) {
    throw new Error(t('brain.detachSpawnFailed'))
  }
  const logPath = brainDaemonLogPath(cwd)
  mkdirSync(dirname(logPath), { recursive: true })
  const logFd = openSync(logPath, 'a')
  try {
    const child = spawnFn(process.execPath, [entry, 'brain', 'serve'], {
      cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
    // Without a listener, an async spawn failure (e.g. the exec itself
    // failing after the fork) would throw as an uncaught 'error' event,
    // long after this command has already printed success and returned.
    child.on('error', () => {})
    return child
  } finally {
    closeSync(logFd)
  }
}

async function brainServe(opts: BrainCommandOptions): Promise<void> {
  if (opts.detach) {
    const child = spawnDetachedBrainServe(opts.cwd, opts.spawnFn ?? spawn)
    child.unref()
    if (child.pid === undefined) {
      throw new Error(t('brain.detachSpawnFailed'))
    }
    printResult(t('brain.detached', { pid: child.pid }), [
      { label: t('brain.fieldLog'), value: brainDaemonLogPath(opts.cwd) },
    ])
    return
  }
  // workspace() (workspace.ts) has a fixed options type this module does not
  // own, with no room for a brain flag, so the signal crosses into
  // startServer (serve.ts) the same way CODESEMA_SYNC_URL/CODESEMA_DEV_VITE
  // already do in this codebase: an env var read at the one place that needs
  // it, not threaded through every caller's signature.
  process.env.CODESEMA_BRAIN_MODE = '1'
  await workspace({ cwd: opts.cwd, open: true, port: undefined })
}

const DEFAULT_STOP_TIMEOUT_MS = 10_000
const DEFAULT_STOP_POLL_INTERVAL_MS = 200

/** Polls until `pid` is gone or `timeoutMs` runs out. Never rejects. */
async function waitForPidDeath(
  pid: number,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
  return true
}

/**
 * SIGTERM, then a bounded wait (default ~10s) for the pid to actually exit,
 * never an infinite hang. An absent pidfile or one naming an already-dead pid
 * both mean "nothing to stop", reported the same way `brainStatus` would
 * report it, and just as idempotent: calling `stop` twice never throws.
 */
async function brainStop(opts: BrainCommandOptions): Promise<void> {
  const pidfile = readBrainPidfile(opts.cwd)
  if (!pidfile || !isPidAlive(pidfile.pid)) {
    if (pidfile) {
      removeBrainPidfile(opts.cwd, pidfile.pid)
    }
    printResult(t('brain.notRunning'), [])
    return
  }
  try {
    process.kill(pidfile.pid, 'SIGTERM')
  } catch {
    // Died in the gap between the isPidAlive check above and this call.
    removeBrainPidfile(opts.cwd, pidfile.pid)
    printResult(t('brain.notRunning'), [])
    return
  }
  const died = await waitForPidDeath(
    pidfile.pid,
    opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
    opts.stopPollIntervalMs ?? DEFAULT_STOP_POLL_INTERVAL_MS,
  )
  if (!died) {
    const seconds = Math.round((opts.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS) / 1000)
    console.log('')
    console.log(`  ${t('brain.stopTimeout', { pid: pidfile.pid, seconds })}`)
    console.log('')
    return
  }
  removeBrainPidfile(opts.cwd, pidfile.pid)
  printResult(t('brain.stopped', { pid: pidfile.pid }), [])
}

/**
 * Writes and enables the systemd --user unit (D-lifecycle): must run inside
 * the repo the daemon should serve, same as `brain serve` itself, since that
 * repo's top-level path becomes the unit's WorkingDirectory.
 */
async function brainInstallService(opts: BrainCommandOptions): Promise<void> {
  const repoRoot = tryGit(['rev-parse', '--show-toplevel'], opts.cwd)
  if (!repoRoot) {
    throw new Error(t('brain.serviceNotARepo'))
  }
  const result = installBrainService({
    workingDirectory: repoRoot,
    cwd: opts.cwd,
    envFile: opts.envFile,
    execFn: opts.execFn,
  })
  const rows: FieldRow[] = [
    { label: t('brain.fieldUnit'), value: result.unitPath },
    { label: t('brain.fieldWorkingDirectory'), value: result.workingDirectory },
    { label: t('brain.fieldExecStart'), value: result.execStart },
  ]
  if (result.environmentFile) {
    rows.push({ label: t('brain.fieldEnvironmentFile'), value: result.environmentFile })
  }
  printResult(t('brain.serviceInstalled'), rows)
  if (result.lingerError) {
    console.log(`  ${paint(t('brain.lingerFailed', { reason: result.lingerError }), AMBER)}`)
  }
  console.log('')
}

/** Idempotent: no unit file on disk is success, the same "nothing to do" doctrine `brainStop` already has for an absent pidfile. */
async function brainUninstallService(opts: BrainCommandOptions): Promise<void> {
  const result = uninstallBrainService({ execFn: opts.execFn })
  if (!result.removed) {
    printResult(t('brain.serviceNotInstalled'), [])
    return
  }
  printResult(t('brain.serviceUninstalled'), [
    { label: t('brain.fieldUnit'), value: result.unitPath },
  ])
}

export async function brainCommand(opts: BrainCommandOptions): Promise<void> {
  switch (opts.action) {
    case 'connect':
      await brainConnect(opts)
      return
    case 'disconnect':
      await brainDisconnect()
      return
    case 'status':
      await brainStatus(opts)
      return
    case 'ticket':
      await brainTicket(opts)
      return
    case 'serve':
      await brainServe(opts)
      return
    case 'stop':
      await brainStop(opts)
      return
    case 'install-service':
      await brainInstallService(opts)
      return
    case 'uninstall-service':
      await brainUninstallService(opts)
      return
    case undefined:
      console.log(t('brain.usage'))
      return
    default:
      throw new Error(t('brain.unknownAction', { action: opts.action }))
  }
}
