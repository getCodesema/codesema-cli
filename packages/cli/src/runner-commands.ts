// `codesema runner …`: connect a workspace to a hub, inspect it, draft and
// publish a ticket by hand, or start/stop the background daemon (D21: `serve
// --detach` backgrounds it, `stop` ends it). Same shape as sync.ts's
// `syncCommand`/`linkCommand`: one action-dispatching entry point. Usage
// errors throw a plain `Error` the CLI's top-level catch prints; `stop` is
// the one action that is a no-op rather than an error when there is nothing
// to do: stopping an already-stopped daemon is success, not misuse.

import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import type { runAgent } from './agent.js'
import { loadConfig, loadGlobalConfig, runnerEnvPath, saveGlobalConfig } from './config.js'
import type { RunnerListEntry } from './contract.js'
import { tryGit } from './git.js'
import {
  claimPendingSecret,
  depositRunnerSecret,
  hubErrorMessage,
  hubRemoteUrl,
  listInFlightTickets,
  listRunners,
  listTickets,
  parseHubToken,
  registerRunnerKey,
  type InFlightTicket,
} from './hub-client.js'
import { t } from './i18n.js'
import { createMicrosandboxDriver, type SandboxDriver } from './microsandbox-driver.js'
import {
  DEFAULT_RUNBOOK_SCAN_TIMEOUT_MS,
  runRunbookScan,
  type RunbookScanOutcome,
} from './runbook-runner.js'
import { RUNBOOK_FILE } from './runbook-setup.js'
import { loadOrCreateRunnerIdentity, loadRunnerIdentity } from './runner-identity.js'
import { readRunnerPidfile, removeRunnerPidfile } from './runner-pidfile.js'
import {
  applyGitIdentity,
  applySecretsToEnvFile,
  sanitizeRunnerSecretsPayload,
  type RunnerGitIdentity,
} from './runner-secrets.js'
import {
  installRunnerService,
  uninstallRunnerService,
  type ExecCommandFn,
} from './runner-service.js'
import { formatFingerprint, runnerKeyFingerprint, seal, unseal } from './sealed-box.js'
import { loadSyncCredentials } from './sync.js'
import { microvmSecretsFromEnv } from './task-isolation.js'
import { draftAndPublishTicket } from './ticket-draft.js'
import { confirm, isInteractive, select, textInput, type SelectOption } from './tui.js'
import { ACCENT, AMBER, dim, GREEN, paint, RED, renderFieldRows, type FieldRow } from './ui.js'
import { AGENT_DEFS, defaultCommand, detectAgents } from './wizard.js'
import { isPidAlive } from './workspace-lock.js'
import { workspace } from './workspace.js'

/**
 * The one `spawn` overload `spawnDetachedRunnerServe` actually calls, pulled
 * out as its own type rather than `typeof spawn`: the real signature is a
 * dozen overloads deep, which a test fake has no reason to satisfy.
 */
type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess

/** The one shape `runner autoconfig`'s Claude-token step needs from `spawnSync`: run a command attached to the real terminal (an OAuth device flow needs to print a URL and read a code), no output captured. */
export type RunInheritedFn = (command: string, args: readonly string[]) => void

function realRunInherited(command: string, args: readonly string[]): void {
  spawnSync(command, args, { stdio: 'inherit' })
}

/** Same `execFileSync` wrapper runner-service.ts keeps private for its own systemctl calls; restated here for `gh auth token`, the one other place this module shells out to a real binary. */
function realExecCommand(command: string, args: readonly string[]): string {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

const realGitConfig = (args: readonly string[]): void => {
  realExecCommand('git', args)
}

/** Same bkctl-style result block as sync.ts's own (private there, so restated here). */
function printResult(statusMessage: string, rows: FieldRow[]): void {
  console.log('')
  console.log(`  ${paint('✔', GREEN)} ${statusMessage}`)
  for (const line of renderFieldRows(rows)) {
    console.log(`  ${line}`)
  }
}

export type RunnerCommandOptions = {
  action?: string | undefined
  cwd: string
  url?: string | undefined
  token?: string | undefined
  issue?: string | undefined
  title?: string | undefined
  prompt?: string | undefined
  /** `runner serve --detach` only: background the daemon instead of running it here. */
  detach?: boolean | undefined
  /** `runner install-service`'s EnvironmentFile=, or `runner await-secrets`'s destination env file. */
  envFile?: string | undefined
  /** `runner autoconfig` only: fingerprint of the target runner, skips the interactive picker. */
  fingerprint?: string | undefined
  /** `runner autoconfig` only: capture GH_TOKEN from `gh auth token` without asking to confirm. */
  ghTokenFromGh?: boolean | undefined
  /** `runner autoconfig` only: Claude Code OAuth token to send, skips env reuse/`claude setup-token`/paste. */
  claudeToken?: string | undefined
  /** `runner autoconfig` only: repo URL to send, skips the detected-remote confirm/paste. */
  repoUrl?: string | undefined
  /** `runner autoconfig` only: git author identity to send, skips the detected-identity confirm. Both or neither. */
  gitName?: string | undefined
  gitEmail?: string | undefined
  /** `runner await-secrets` only: seconds to poll before giving up (default 1800). */
  timeoutSeconds?: number | undefined
  /** Test seam for the delivered git identity: never touches the real global git config in tests. */
  applyGitIdentityFn?: typeof applyGitIdentity | undefined
  /** Test seam. */
  fetchImpl?: typeof fetch | undefined
  /** Test seam. */
  runAgentFn?: typeof runAgent | undefined
  /** Test seam for `runner serve --detach`: never forks a real process in tests. */
  spawnFn?: SpawnFn | undefined
  /** Test seam for `runner install-service`/`uninstall-service`/`autoconfig`'s `gh auth token`: never shells out to a real systemctl/loginctl/gh in tests. */
  execFn?: ExecCommandFn | undefined
  /** Test seam for `runner autoconfig`'s `claude setup-token`: never spawns a real inherited process in tests. */
  runInheritedFn?: RunInheritedFn | undefined
  /** Test seams for `runner autoconfig`'s prompts: never touch a real TTY in tests. */
  selectFn?: RunnerSelectFn | undefined
  textInputFn?: typeof textInput | undefined
  confirmFn?: typeof confirm | undefined
  /** Test seams for `runner stop`'s bounded poll: real 10s/200ms by default. */
  stopTimeoutMs?: number | undefined
  stopPollIntervalMs?: number | undefined
  /** Test seams for `runner await-secrets`'s poll loop: real 4s/30s by default. */
  pollIntervalMs?: number | undefined
  reminderIntervalMs?: number | undefined
}

async function runnerConnect(opts: RunnerCommandOptions): Promise<void> {
  if (!opts.url || !opts.token) {
    throw new Error(t('runner.connectMissingFlags'))
  }
  const parsed = parseHubToken(opts.token)
  if (!parsed) {
    throw new Error(t('runner.badToken'))
  }
  // Same global credentials sync.ts's createWorkspace/linkWorkspace write:
  // `codesema sync`, `codesema link` and the runner daemon share one account.
  const path = saveGlobalConfig({
    ...loadGlobalConfig(),
    syncUrl: opts.url,
    syncWorkspaceId: parsed.workspaceId,
    syncSecret: parsed.secret,
  })

  // Stable across reconnects: only ever generated once per machine, so the
  // fingerprint an operator reads here still matches the one `autoconfig`
  // recomputes later against whatever the hub reports for this same key.
  const identity = loadOrCreateRunnerIdentity()
  const creds = { url: opts.url, workspaceId: parsed.workspaceId, secret: parsed.secret }
  const registerResult = await registerRunnerKey(
    creds,
    { public_key: identity.publicKey.toString('base64'), name: hostname() },
    opts.fetchImpl ?? fetch,
  )

  printResult(t('runner.connected', { url: opts.url }), [
    { label: t('field.account'), value: parsed.workspaceId },
    { label: t('runner.fieldFingerprint'), value: formatFingerprint(identity.fingerprint) },
  ])
  console.log(`  ${t('runner.savedTo', { path })}`)
  if (!registerResult.ok) {
    console.log(
      `  ${paint(t('runner.keyRegisterFailed', { reason: hubErrorMessage(registerResult.error) }), AMBER)}`,
    )
  }
  console.log('')
}

/**
 * Local-only: clears the three credentials `runnerConnect` wrote, the same
 * destructure-and-omit `sync.ts`'s `deleteWorkspaceData` uses to drop
 * `syncWorkspaceId`/`syncSecret` (here all three, since disconnecting a hub
 * is meant to fully forget it, not just its data). No API call — the hub
 * has its own revocation, shipped separately in its dashboard Settings — so
 * this only ever touches the local file and reminds the caller to revoke
 * there too.
 */
async function runnerDisconnect(): Promise<void> {
  const config = loadGlobalConfig()
  if (!config.syncUrl && !config.syncWorkspaceId && !config.syncSecret) {
    printResult(t('runner.alreadyDisconnected'), [])
    return
  }
  const { syncUrl: _url, syncWorkspaceId: _id, syncSecret: _secret, ...rest } = config
  saveGlobalConfig(rest)
  printResult(t('runner.disconnected'), [])
  console.log(`  ${paint(t('runner.disconnectRevokeReminder'), AMBER)}`)
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

/** `{12s ago}` / `{3min ago}` / `{2h ago}` / `{5d ago}`: coarsest unit only, i18n'd via `runner.heartbeat*`. */
function formatHeartbeatAge(updatedAt: string, nowMs: number): string {
  const elapsedS = Math.max(0, Math.floor((nowMs - Date.parse(updatedAt)) / 1000))
  if (elapsedS < 60) {
    return t('runner.heartbeatSeconds', { n: elapsedS })
  }
  const elapsedMin = Math.floor(elapsedS / 60)
  if (elapsedMin < 60) {
    return t('runner.heartbeatMinutes', { n: elapsedMin })
  }
  const elapsedH = Math.floor(elapsedMin / 60)
  if (elapsedH < 24) {
    return t('runner.heartbeatHours', { n: elapsedH })
  }
  return t('runner.heartbeatDays', { n: Math.floor(elapsedH / 24) })
}

const IN_FLIGHT_TITLE_MAX = 64

function truncateInFlightTitle(title: string): string {
  return title.length > IN_FLIGHT_TITLE_MAX ? `${title.slice(0, IN_FLIGHT_TITLE_MAX - 1)}…` : title
}

/**
 * One `runner status` in-flight detail line: hub status, executor, heartbeat
 * age, the arm's own local status when the hub reports one (absent on a
 * hub build older than that field), and a `stale` tag when the claim's
 * lease has already lapsed: a ticket a dead or stuck arm is still shown as
 * holding.
 */
function inFlightDetailLine(ticket: InFlightTicket, nowMs: number): string {
  const facts = [
    ticket.status,
    ticket.executed_by ?? t('runner.fieldUnclaimed'),
    formatHeartbeatAge(ticket.updated_at, nowMs),
    ...(ticket.arm_local_status ? [ticket.arm_local_status] : []),
  ]
  const line = dim(facts.join(' · '))
  const isStale = ticket.lease_expires_at !== null && Date.parse(ticket.lease_expires_at) < nowMs
  return isStale ? `${line} ${paint(t('runner.fieldStale'), AMBER)}` : line
}

function printInFlightTickets(tickets: InFlightTicket[]): void {
  console.log('')
  console.log(`  ${paint(t('runner.inFlightHeading'), ACCENT)}`)
  const nowMs = Date.now()
  for (const ticket of tickets) {
    console.log(`    ${truncateInFlightTitle(ticket.title)}`)
    console.log(`      ${inFlightDetailLine(ticket, nowMs)}`)
  }
}

/**
 * The daemon rows for `runner status`: pid/port/uptime read off the D21
 * pidfile, or a single "not running" row. A pidfile naming a dead pid is
 * cleaned up here too, the same read-time doctrine `runnerStop` uses, so
 * neither command leaves a stale file for the other to trip over.
 */
function runnerDaemonStatusRows(cwd: string): FieldRow[] {
  const pidfile = readRunnerPidfile(cwd)
  if (!pidfile || !isPidAlive(pidfile.pid)) {
    if (pidfile) {
      removeRunnerPidfile(cwd, pidfile.pid)
    }
    return [{ label: t('runner.fieldDaemon'), value: t('runner.notRunning') }]
  }
  return [
    { label: t('runner.fieldPid'), value: String(pidfile.pid) },
    { label: t('runner.fieldPort'), value: String(pidfile.port) },
    { label: t('runner.fieldUptime'), value: formatUptime(pidfile.started_at, Date.now()) },
  ]
}

async function runnerStatus(opts: RunnerCommandOptions): Promise<void> {
  const creds = loadSyncCredentials()
  if (!creds) {
    throw new Error(t('runner.notConnected'))
  }
  const remoteUrl = hubRemoteUrl(opts.cwd)
  const rows: FieldRow[] = [
    { label: t('runner.fieldUrl'), value: creds.url },
    { label: t('field.account'), value: creds.workspaceId },
    { label: t('runner.fieldRepo'), value: remoteUrl ?? t('runner.noRemote') },
    ...runnerDaemonStatusRows(opts.cwd),
  ]
  if (!remoteUrl) {
    printResult(t('runner.statusTitle'), rows)
    return
  }
  const fetchImpl = opts.fetchImpl ?? fetch
  const result = await listTickets(creds, remoteUrl, 'published', fetchImpl)
  rows.push({
    label: t('runner.fieldReady'),
    value: result.ok ? String(result.data.length) : hubErrorMessage(result.error),
  })
  const inFlight = await listInFlightTickets(creds, remoteUrl, fetchImpl)
  rows.push({
    label: t('runner.fieldInFlight'),
    value: inFlight.ok ? String(inFlight.data.length) : hubErrorMessage(inFlight.error),
  })
  printResult(t('runner.statusTitle'), rows)
  if (inFlight.ok && inFlight.data.length > 0) {
    printInFlightTickets(inFlight.data)
  }
}

function parsePositiveInt(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

async function runnerTicket(opts: RunnerCommandOptions): Promise<void> {
  const hasIssue = opts.issue !== undefined
  const hasPromptForm = opts.title !== undefined && opts.prompt !== undefined
  if (hasIssue === hasPromptForm) {
    throw new Error(t('runner.ticketUsage'))
  }

  const seams = {
    ...(opts.runAgentFn ? { runAgentFn: opts.runAgentFn } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  }
  const outcome = hasIssue
    ? await (async () => {
        const issueNumber = opts.issue ? parsePositiveInt(opts.issue) : null
        if (issueNumber === null) {
          throw new Error(t('runner.badIssueNumber', { value: opts.issue ?? '' }))
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
    throw new Error(t('runner.draftFailed', { reason: outcome.reason }))
  }
  printResult(t('runner.ticketCreated', { title: outcome.ticket.title }), [
    { label: t('runner.fieldId'), value: outcome.ticket.id },
    { label: t('field.status'), value: outcome.ticket.status },
  ])
  console.log('')
  console.log(outcome.ticket.body)
  console.log('')
}

function runnerDaemonLogPath(cwd: string): string {
  return join(cwd, '.codesema', 'runner-daemon.log')
}

/**
 * Re-invokes THIS SAME binary as `codesema runner serve` (no --detach: that
 * flag names what the CURRENT process does, not the child, or every child
 * would refork itself), detached and unref'd so it outlives us, stdout/stderr
 * appended to a repo-local log since a detached process has no terminal to
 * write to. `process.argv[1]` is the same self-reference `index.ts`'s
 * `isProcessEntrypoint` resolves against: the bin script, whether that is
 * the built `dist/index.mjs` or a dev entry point.
 */
function spawnDetachedRunnerServe(cwd: string, spawnFn: SpawnFn): ChildProcess {
  const entry = process.argv[1]
  if (entry === undefined) {
    throw new Error(t('runner.detachSpawnFailed'))
  }
  const logPath = runnerDaemonLogPath(cwd)
  mkdirSync(dirname(logPath), { recursive: true })
  const logFd = openSync(logPath, 'a')
  try {
    const child = spawnFn(process.execPath, [entry, 'runner', 'serve'], {
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

async function runnerServe(opts: RunnerCommandOptions): Promise<void> {
  if (opts.detach) {
    const child = spawnDetachedRunnerServe(opts.cwd, opts.spawnFn ?? spawn)
    child.unref()
    if (child.pid === undefined) {
      throw new Error(t('runner.detachSpawnFailed'))
    }
    printResult(t('runner.detached', { pid: child.pid }), [
      { label: t('runner.fieldLog'), value: runnerDaemonLogPath(opts.cwd) },
    ])
    return
  }
  // workspace() (workspace.ts) has a fixed options type this module does not
  // own, with no room for a runner flag, so the signal crosses into
  // startServer (serve.ts) the same way CODESEMA_SYNC_URL/CODESEMA_DEV_VITE
  // already do in this codebase: an env var read at the one place that needs
  // it, not threaded through every caller's signature.
  process.env.CODESEMA_RUNNER_MODE = '1'
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
 * both mean "nothing to stop", reported the same way `runnerStatus` would
 * report it, and just as idempotent: calling `stop` twice never throws.
 */
async function runnerStop(opts: RunnerCommandOptions): Promise<void> {
  const pidfile = readRunnerPidfile(opts.cwd)
  if (!pidfile || !isPidAlive(pidfile.pid)) {
    if (pidfile) {
      removeRunnerPidfile(opts.cwd, pidfile.pid)
    }
    printResult(t('runner.notRunning'), [])
    return
  }
  try {
    process.kill(pidfile.pid, 'SIGTERM')
  } catch {
    // Died in the gap between the isPidAlive check above and this call.
    removeRunnerPidfile(opts.cwd, pidfile.pid)
    printResult(t('runner.notRunning'), [])
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
    console.log(`  ${t('runner.stopTimeout', { pid: pidfile.pid, seconds })}`)
    console.log('')
    return
  }
  removeRunnerPidfile(opts.cwd, pidfile.pid)
  printResult(t('runner.stopped', { pid: pidfile.pid }), [])
}

/**
 * Writes and enables the systemd --user unit (D-lifecycle): must run inside
 * the repo the daemon should serve, same as `runner serve` itself, since that
 * repo's top-level path becomes the unit's WorkingDirectory.
 */
async function runnerInstallService(opts: RunnerCommandOptions): Promise<void> {
  const repoRoot = tryGit(['rev-parse', '--show-toplevel'], opts.cwd)
  if (!repoRoot) {
    throw new Error(t('runner.serviceNotARepo'))
  }
  const result = installRunnerService({
    workingDirectory: repoRoot,
    cwd: opts.cwd,
    envFile: opts.envFile,
    execFn: opts.execFn,
  })
  const rows: FieldRow[] = [
    { label: t('runner.fieldUnit'), value: result.unitPath },
    { label: t('runner.fieldWorkingDirectory'), value: result.workingDirectory },
    { label: t('runner.fieldExecStart'), value: result.execStart },
  ]
  if (result.environmentFile) {
    rows.push({ label: t('runner.fieldEnvironmentFile'), value: result.environmentFile })
  }
  printResult(t('runner.serviceInstalled'), rows)
  if (result.lingerError) {
    console.log(`  ${paint(t('runner.lingerFailed', { reason: result.lingerError }), AMBER)}`)
  }
  console.log('')
}

/** Idempotent: no unit file on disk is success, the same "nothing to do" doctrine `runnerStop` already has for an absent pidfile. */
async function runnerUninstallService(opts: RunnerCommandOptions): Promise<void> {
  const result = uninstallRunnerService({ execFn: opts.execFn })
  if (!result.removed) {
    printResult(t('runner.serviceNotInstalled'), [])
    return
  }
  printResult(t('runner.serviceUninstalled'), [
    { label: t('runner.fieldUnit'), value: result.unitPath },
  ])
}

/** A runner that registered but never sent a heartbeat yet reports `last_seen_at: null`. */
function formatLastSeen(lastSeenAt: string | null, nowMs: number): string {
  return lastSeenAt ? formatHeartbeatAge(lastSeenAt, nowMs) : t('runner.fieldNeverSeen')
}

function printRunnerList(runners: RunnerListEntry[]): void {
  console.log('')
  console.log(`  ${paint(t('runner.listHeading'), ACCENT)}`)
  const nowMs = Date.now()
  for (const runner of runners) {
    console.log(`    ${runner.name}`)
    const facts = [
      formatFingerprint(runner.fingerprint),
      formatLastSeen(runner.last_seen_at, nowMs),
      ...(runner.has_pending_secret ? [t('runner.fieldPendingSecret')] : []),
    ]
    console.log(`      ${dim(facts.join(' · '))}`)
  }
  console.log('')
}

async function runnerList(opts: RunnerCommandOptions): Promise<void> {
  const creds = loadSyncCredentials()
  if (!creds) {
    throw new Error(t('runner.notConnected'))
  }
  const result = await listRunners(creds, opts.fetchImpl ?? fetch)
  if (!result.ok) {
    throw new Error(t('runner.listFailed', { reason: hubErrorMessage(result.error) }))
  }
  if (result.data.length === 0) {
    printResult(t('runner.listEmpty'), [])
    return
  }
  printRunnerList(result.data)
}

/**
 * The flags `runner autoconfig` needs to complete without ever prompting: one
 * to pick the runner (`--fingerprint`) and one path to at least one secret
 * (`--gh-token-from-gh` or `--claude-token`); everything else (repo URL,
 * reusing an already-set `gh`/Claude token) degrades to "not sent" rather
 * than blocking, since the final "at least one secret" check is the real
 * gate. A bare `CLAUDE_CODE_OAUTH_TOKEN` env var does not count here: reusing
 * it still asks for confirmation, which a non-interactive run cannot give.
 */
function missingAutoconfigFlags(opts: RunnerCommandOptions): string[] {
  const missing: string[] = []
  if (!opts.fingerprint) {
    missing.push('--fingerprint <fingerprint>')
  }
  if (!opts.ghTokenFromGh && !opts.claudeToken) {
    missing.push('--gh-token-from-gh and/or --claude-token <token>')
  }
  return missing
}

function findRunnerByFingerprint(
  runners: RunnerListEntry[],
  fingerprint: string,
): RunnerListEntry | null {
  const normalized = fingerprint.trim().toLowerCase()
  return runners.find((runner) => runner.fingerprint.toLowerCase() === normalized) ?? null
}

/** `select` narrowed to the one value type `runner autoconfig` ever picks from: a test fake only has to handle `RunnerListEntry`, not `select`'s full generic signature. */
type RunnerSelectFn = (opts: {
  title: string
  options: SelectOption<RunnerListEntry>[]
}) => Promise<RunnerListEntry | null>

type AutoconfigPromptSeams = {
  selectFn: RunnerSelectFn
  textInputFn: typeof textInput
  confirmFn: typeof confirm
}

/**
 * Picks the target runner, then re-derives its fingerprint from its OWN
 * public key rather than trusting `entry.fingerprint` as reported by the hub
 * (a hub that got the two out of sync is not safe to seal secrets through).
 * Supplying `--fingerprint` stands in for the interactive "does the runner
 * machine show the same fingerprint?" confirmation: typing the exact 64-hex
 * value on the command line already IS that out-of-band check.
 */
async function resolveTargetRunner(
  opts: RunnerCommandOptions,
  runners: RunnerListEntry[],
  seams: AutoconfigPromptSeams,
): Promise<RunnerListEntry> {
  let entry: RunnerListEntry
  let alreadyVerifiedByOperator: boolean
  if (opts.fingerprint) {
    const found = findRunnerByFingerprint(runners, opts.fingerprint)
    if (!found) {
      throw new Error(t('runner.autoconfigFingerprintNotFound', { fingerprint: opts.fingerprint }))
    }
    entry = found
    alreadyVerifiedByOperator = true
  } else {
    const nowMs = Date.now()
    const picked = await seams.selectFn({
      title: t('runner.autoconfigSelectRunner'),
      options: runners.map((runner) => ({
        label: runner.name,
        value: runner,
        hint: formatLastSeen(runner.last_seen_at, nowMs),
      })),
    })
    if (!picked) {
      throw new Error(t('runner.autoconfigNoRunnerSelected'))
    }
    entry = picked
    alreadyVerifiedByOperator = false
  }

  const recomputed = runnerKeyFingerprint(Buffer.from(entry.public_key, 'base64'))
  if (recomputed !== entry.fingerprint) {
    throw new Error(t('runner.autoconfigFingerprintMismatch', { name: entry.name }))
  }

  if (!alreadyVerifiedByOperator) {
    console.log(`  ${formatFingerprint(recomputed)}`)
    const confirmed = await seams.confirmFn({ title: t('runner.autoconfigConfirmFingerprint') })
    if (!confirmed) {
      throw new Error(t('runner.autoconfigFingerprintNotConfirmed'))
    }
  }

  return entry
}

function tryGhAuthToken(execFn: ExecCommandFn): string | null {
  try {
    return execFn('gh', ['auth', 'token']).trim() || null
  } catch {
    return null
  }
}

/**
 * Non-interactive without `--gh-token-from-gh` skips even the `gh auth
 * token` probe: a fully-flagged run that only wants a Claude token has no
 * business shelling out for a GH one nobody asked for, and no one is present
 * to answer the confirm/paste fallback anyway.
 */
async function resolveGhToken(
  opts: RunnerCommandOptions,
  seams: AutoconfigPromptSeams & { execFn: ExecCommandFn },
): Promise<string | undefined> {
  if (opts.ghTokenFromGh) {
    const ghToken = tryGhAuthToken(seams.execFn)
    if (!ghToken) {
      throw new Error(t('runner.autoconfigGhTokenUnavailable'))
    }
    return ghToken
  }
  if (!isInteractive()) {
    return undefined
  }
  const ghToken = tryGhAuthToken(seams.execFn)
  if (ghToken && (await seams.confirmFn({ title: t('runner.autoconfigUseGhToken') }))) {
    return ghToken
  }
  const pasted = await seams.textInputFn({ title: t('runner.autoconfigPasteGhToken'), mask: true })
  return pasted ?? undefined
}

/**
 * Non-interactive without `--claude-token` returns immediately: no one is
 * present to confirm reusing the ambient OAuth token, and `claude
 * setup-token` is an interactive device-code flow that a script invoking
 * this non-interactively must never be left blocked on.
 */
async function resolveClaudeToken(
  opts: RunnerCommandOptions,
  seams: AutoconfigPromptSeams & { runInheritedFn: RunInheritedFn },
): Promise<string | undefined> {
  if (opts.claudeToken) {
    return opts.claudeToken
  }
  if (!isInteractive()) {
    return undefined
  }
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN
  if (envToken && (await seams.confirmFn({ title: t('runner.autoconfigReuseClaudeToken') }))) {
    return envToken
  }
  seams.runInheritedFn('claude', ['setup-token'])
  const pasted = await seams.textInputFn({
    title: t('runner.autoconfigPasteClaudeToken'),
    mask: true,
  })
  return pasted ?? undefined
}

function tryGitConfig(execFn: ExecCommandFn, key: string): string | null {
  try {
    return execFn('git', ['config', key]).trim() || null
  } catch {
    return null
  }
}

/**
 * The workstation's own git identity, offered for the runner's commits: the
 * runner signs every turn itself, and a fresh server has no identity at all.
 * Non-interactive without the flags simply omits it (the runner falls back to
 * the codesema signature at commit time).
 */
async function resolveGitIdentity(
  opts: RunnerCommandOptions,
  seams: AutoconfigPromptSeams & { execFn: ExecCommandFn },
): Promise<RunnerGitIdentity | undefined> {
  if (opts.gitName || opts.gitEmail) {
    if (!opts.gitName || !opts.gitEmail) {
      throw new Error(t('runner.autoconfigGitIdentityFlagsIncomplete'))
    }
    return { name: opts.gitName, email: opts.gitEmail }
  }
  if (!isInteractive()) {
    return undefined
  }
  const name = tryGitConfig(seams.execFn, 'user.name')
  const email = tryGitConfig(seams.execFn, 'user.email')
  if (!name || !email) {
    return undefined
  }
  const confirmed = await seams.confirmFn({
    title: t('runner.autoconfigUseGitIdentity', { name, email }),
  })
  return confirmed ? { name, email } : undefined
}

async function resolveRepoUrl(
  opts: RunnerCommandOptions,
  seams: AutoconfigPromptSeams,
): Promise<string | undefined> {
  if (opts.repoUrl) {
    return opts.repoUrl
  }
  const detected = hubRemoteUrl(opts.cwd)
  if (
    detected &&
    (await seams.confirmFn({ title: t('runner.autoconfigUseDetectedRepoUrl', { url: detected }) }))
  ) {
    return detected
  }
  const pasted = await seams.textInputFn({ title: t('runner.autoconfigRepoUrl') })
  return pasted ?? undefined
}

/**
 * Picks a registered runner, collects whichever secrets the operator has for
 * it, seals them against that runner's own public key and deposits the
 * result for `runner await-secrets` to pick up. Every prompt has a flag that
 * short-circuits it, so a fully-flagged invocation never touches a TTY; a
 * non-interactive one missing a required flag fails immediately instead of
 * hanging on a prompt that can never be answered.
 */
async function runnerAutoconfig(opts: RunnerCommandOptions): Promise<void> {
  const creds = loadSyncCredentials()
  if (!creds) {
    throw new Error(t('runner.notConnected'))
  }
  if (!isInteractive()) {
    const missing = missingAutoconfigFlags(opts)
    if (missing.length > 0) {
      throw new Error(t('runner.autoconfigMissingFlags', { flags: missing.join(', ') }))
    }
  }

  const fetchImpl = opts.fetchImpl ?? fetch
  const listResult = await listRunners(creds, fetchImpl)
  if (!listResult.ok) {
    throw new Error(t('runner.listFailed', { reason: hubErrorMessage(listResult.error) }))
  }
  if (listResult.data.length === 0) {
    throw new Error(t('runner.listEmpty'))
  }

  const seams: AutoconfigPromptSeams = {
    selectFn: opts.selectFn ?? select,
    textInputFn: opts.textInputFn ?? textInput,
    confirmFn: opts.confirmFn ?? confirm,
  }
  const execFn = opts.execFn ?? realExecCommand
  const runInheritedFn = opts.runInheritedFn ?? realRunInherited

  const entry = await resolveTargetRunner(opts, listResult.data, seams)
  const ghToken = await resolveGhToken(opts, { ...seams, execFn })
  const claudeToken = await resolveClaudeToken(opts, { ...seams, runInheritedFn })
  const repoUrl = await resolveRepoUrl(opts, seams)
  const gitIdentity = await resolveGitIdentity(opts, { ...seams, execFn })

  const secrets = {
    ...(ghToken ? { GH_TOKEN: ghToken } : {}),
    ...(claudeToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeToken } : {}),
  }
  if (Object.keys(secrets).length === 0) {
    throw new Error(t('runner.autoconfigNoSecrets'))
  }

  const payload = {
    v: 1 as const,
    secrets,
    ...(repoUrl ? { repo_url: repoUrl } : {}),
    ...(gitIdentity ? { git_identity: gitIdentity } : {}),
  }
  const ciphertext = seal(
    Buffer.from(entry.public_key, 'base64'),
    Buffer.from(JSON.stringify(payload)),
  )
  const depositResult = await depositRunnerSecret(creds, entry.fingerprint, ciphertext, fetchImpl)
  if (!depositResult.ok) {
    throw new Error(
      t('runner.autoconfigDepositFailed', { reason: hubErrorMessage(depositResult.error) }),
    )
  }

  printResult(t('runner.autoconfigDone', { name: entry.name }), [])
  console.log(`  ${t('runner.autoconfigReminder')}`)
  console.log('')
}

const DEFAULT_AWAIT_TIMEOUT_S = 1800
const DEFAULT_AWAIT_POLL_INTERVAL_MS = 4000
const DEFAULT_AWAIT_REMINDER_INTERVAL_MS = 30_000

/** Malformed JSON is the same "ignore and keep polling" case as a payload that fails `sanitizeRunnerSecretsPayload`. */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Runs on the runner machine after `runner connect`: polls the hub for the
 * secret `runner autoconfig` sealed for this runner's fingerprint, decrypts
 * and validates it, then writes it to the env file the daemon reads. A
 * corrupt or malformed delivery is logged and skipped rather than treated as
 * fatal, since the hub only ever holds one pending secret per runner and a
 * bad one should not need the operator to restart this command by hand.
 * STDOUT carries nothing but the repo URL (or nothing, if none was sent) so
 * a caller can capture it directly; every other message goes to STDERR.
 */
async function runnerAwaitSecrets(opts: RunnerCommandOptions): Promise<void> {
  const creds = loadSyncCredentials()
  if (!creds) {
    throw new Error(t('runner.notConnected'))
  }
  const identity = loadRunnerIdentity()
  if (!identity) {
    throw new Error(t('runner.awaitSecretsNoIdentity'))
  }

  const envPath = opts.envFile ?? runnerEnvPath()
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = (opts.timeoutSeconds ?? DEFAULT_AWAIT_TIMEOUT_S) * 1000
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_AWAIT_POLL_INTERVAL_MS
  const reminderIntervalMs = opts.reminderIntervalMs ?? DEFAULT_AWAIT_REMINDER_INTERVAL_MS
  const formattedFingerprint = formatFingerprint(identity.fingerprint)

  const deadline = Date.now() + timeoutMs
  let lastReminder = Date.now()
  console.error(`  ${t('runner.awaitSecretsWaiting', { fingerprint: formattedFingerprint })}`)

  for (;;) {
    const claimed = await claimPendingSecret(creds, identity.fingerprint, fetchImpl)
    if (claimed.ok && claimed.data) {
      const plaintext = unseal(identity.privateKey, claimed.data.ciphertext)
      if (!plaintext) {
        console.error(`  ${t('runner.awaitSecretsUndecryptable')}`)
      } else {
        const parsed = tryParseJson(plaintext.toString('utf8'))
        const payload = parsed !== null ? sanitizeRunnerSecretsPayload(parsed) : null
        if (!payload) {
          console.error(`  ${t('runner.awaitSecretsInvalidPayload')}`)
        } else {
          applySecretsToEnvFile(envPath, payload.secrets)
          if (payload.git_identity) {
            const applyGitIdentityFn = opts.applyGitIdentityFn ?? applyGitIdentity
            applyGitIdentityFn(payload.git_identity, realGitConfig)
            console.error(
              `  ${t('runner.awaitSecretsGitIdentityApplied', { name: payload.git_identity.name })}`,
            )
          }
          if (payload.repo_url) {
            console.log(payload.repo_url)
          }
          return
        }
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(t('runner.awaitSecretsTimeout', { seconds: Math.round(timeoutMs / 1000) }))
    }
    if (Date.now() - lastReminder >= reminderIntervalMs) {
      console.error(`  ${t('runner.awaitSecretsReminder', { fingerprint: formattedFingerprint })}`)
      lastReminder = Date.now()
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}

export async function runnerCommand(opts: RunnerCommandOptions): Promise<void> {
  switch (opts.action) {
    case 'connect':
      await runnerConnect(opts)
      return
    case 'disconnect':
      await runnerDisconnect()
      return
    case 'status':
      await runnerStatus(opts)
      return
    case 'list':
      await runnerList(opts)
      return
    case 'ticket':
      await runnerTicket(opts)
      return
    case 'autoconfig':
      await runnerAutoconfig(opts)
      return
    case 'await-secrets':
      await runnerAwaitSecrets(opts)
      return
    case 'serve':
      await runnerServe(opts)
      return
    case 'stop':
      await runnerStop(opts)
      return
    case 'install-service':
      await runnerInstallService(opts)
      return
    case 'uninstall-service':
      await runnerUninstallService(opts)
      return
    case undefined:
      console.log(t('runner.usage'))
      return
    default:
      throw new Error(t('runner.unknownAction', { action: opts.action }))
  }
}

// ---------------------------------------------------------------------------
// `codesema runbook scan`: validates this repo's runbook (or lets an agent
// propose one) by actually running it in a microVM, no hub involved. English
// only, like the rest of the CLI's runner surface — this command has no
// dashboard counterpart, so there is nothing for i18n.ts to serve.
// ---------------------------------------------------------------------------

export type RunbookCommandOptions = {
  action?: string | undefined
  cwd: string
  /** `--timeout`; defaults to DEFAULT_RUNBOOK_SCAN_TIMEOUT_MS. */
  timeoutSeconds?: number | undefined
  /** Overrides the configured/detected agent command. */
  agent?: string | undefined
  /** Test seam: never a real Microsandbox VM in a test. */
  driver?: SandboxDriver | undefined
  /** Test seam. */
  runRunbookScanFn?: typeof runRunbookScan | undefined
}

/** sha256 (16 hex) of the worktree's absolute path: a stable local id when there is no hub project to name one. */
function localProjectId(worktree: string): string {
  return createHash('sha256').update(worktree).digest('hex').slice(0, 16)
}

/**
 * `--agent` > this repo's `.codesema/config.json`/global `agent` > the first
 * agent found on PATH. No TOFU dance here (unlike `codesema review`'s
 * interactive trust prompt): the proposal agent never runs on the host, it
 * runs read-only inside a disposable microVM, which is a different trust
 * boundary than a repo-provided command executed directly on the machine.
 */
async function resolveRunbookScanCommand(
  cwd: string,
  explicit: string | undefined,
): Promise<string> {
  const configured = explicit ?? loadConfig(cwd).agent
  if (configured) {
    return configured
  }
  const detected = await detectAgents(cwd)
  const first = detected[0]
  if (!first) {
    throw new Error(
      `no agent found on PATH (looked for: ${AGENT_DEFS.map((d) => d.bin).join(', ')})`,
    )
  }
  return defaultCommand(first)
}

function printRunbookScanOutcome(outcome: RunbookScanOutcome): void {
  if (outcome.status === 'completed') {
    printResult('Runbook validated.', [
      { label: 'image', value: outcome.runbook.image },
      { label: 'tests', value: String(outcome.runbook.tests.length) },
      { label: 'attempts', value: String(outcome.attempts) },
      { label: 'snapshot', value: outcome.snapshotName ?? '(none — cold boot only)' },
      { label: 'runbook_sha', value: outcome.validation.runbook_sha },
      { label: 'file', value: RUNBOOK_FILE },
    ])
    return
  }
  console.log('')
  console.log(
    `  ${paint('✘', RED)} runbook scan failed after ${outcome.attempts} attempt(s): ${outcome.error}`,
  )
  process.exitCode = 1
}

async function runbookScanCommand(opts: RunbookCommandOptions): Promise<void> {
  const worktree = opts.cwd
  const headSha = tryGit(['rev-parse', 'HEAD'], worktree)
  if (!headSha) {
    throw new Error('not a git repository (or no commits yet)')
  }
  const command = await resolveRunbookScanCommand(worktree, opts.agent)
  const driver = opts.driver ?? createMicrosandboxDriver()
  const run = opts.runRunbookScanFn ?? runRunbookScan
  const timeoutMs =
    (opts.timeoutSeconds ?? Math.round(DEFAULT_RUNBOOK_SCAN_TIMEOUT_MS / 1000)) * 1000

  console.log('')
  console.log(`  ${dim('scanning for a runbook…')}`)
  const outcome = await run({
    worktree,
    projectId: localProjectId(worktree),
    headSha,
    driver,
    command,
    timeoutMs,
    secrets: microvmSecretsFromEnv(process.env),
    onProgress: (line) => console.log(`  ${dim(line)}`),
  })
  printRunbookScanOutcome(outcome)
}

export async function runbookCommand(opts: RunbookCommandOptions): Promise<void> {
  switch (opts.action) {
    case 'scan':
      await runbookScanCommand(opts)
      return
    case undefined:
      console.log('usage: codesema runbook scan [--timeout <seconds>]')
      return
    default:
      throw new Error(`unknown runbook action: ${opts.action}`)
  }
}
