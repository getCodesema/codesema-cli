/**
 * The runbook scan: a bounded loop (proposal → boot → install → services →
 * healthchecks → tests) that accepts a runbook only after a real green
 * execution in a VM, then snapshots the project and reports to the hub.
 * Calque of `createChecksSetupRunner` (checks-setup.ts). Lot C5 implements it.
 */
import { randomBytes } from 'node:crypto'
import { collectSetupFiles, type SetupFile } from './checks-setup.js'
import {
  TASK_CHECK_TAIL_MAX,
  type RunbookConfig,
  type RunbookScan,
  type RunbookValidation,
  type TaskCheckResult,
} from './contract.js'
import {
  claimRunbookScan,
  failRunbookScan,
  hubErrorMessage,
  listRunbookScans,
  reportRunbookScanResult,
} from './hub-client.js'
import {
  sandboxName,
  type SandboxDriver,
  type SandboxExecResult,
  type SandboxHandle,
  type SandboxSpec,
} from './microsandbox-driver.js'
import { buildProjectSnapshot, type ProjectSnapshot } from './microvm-snapshot.js'
import { MICROVM_TURN_DEFAULTS, runMicrovmTurn } from './microvm-turn.js'
import {
  buildRunbookSetupPrompt,
  sanitizeRunbookProposal,
  writeRunbookConfig,
  type RunbookProposalInput,
} from './runbook-setup.js'
import type { SyncCredentials } from './sync.js'
import { DEFAULT_CHECKS_IMAGE } from './task-checks.js'
import { commandBin } from './task-isolation.js'

export const RUNBOOK_SCAN_MAX_ATTEMPTS = 5

/** The whole scan's per-command timeout when the caller does not set one (10 min). */
export const DEFAULT_RUNBOOK_SCAN_TIMEOUT_MS = 600_000

/**
 * The lease a scan claims with, bounded to the hub's own cap
 * (MAX_RUNBOOK_LEASE_SECONDS in runbook-scans.ts). A scan can run far longer
 * than any single lease (up to RUNBOOK_SCAN_MAX_ATTEMPTS attempts, each with
 * install + services + healthchecks + tests), so `runOneRunbookScan` renews
 * this lease periodically instead of claiming once and hoping the scan
 * finishes before it expires.
 */
export const RUNBOOK_SCAN_LEASE_SECONDS = 900

/** How often a healthcheck is retried before the attempt's shared deadline. */
export const RUNBOOK_HEALTHCHECK_RETRY_MS = 2_000

/** Wall-clock budget for launching one background service (the launcher itself, not the service). */
const SERVICE_LAUNCH_TIMEOUT_MS = 15_000

/** Absolute ceiling on a scan's own VM lease, whatever the runbook's command count computes to. */
const EXECUTION_MAX_DURATION_SECONDS_CAP = 6 * 3600

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function tailOf(value: string): string {
  return value.slice(-TASK_CHECK_TAIL_MAX)
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Half the lease, with a floor so a tiny test-only lease never busy-loops. */
function leaseRenewalIntervalMs(leaseSeconds: number): number {
  return Math.max(1000, Math.floor((leaseSeconds * 1000) / 2))
}

/** An abortable sleep for the lease-renewal loop: resolves early the instant `signal` aborts. */
function defaultRenewSleep(ms: number, signal: AbortSignal): Promise<void> {
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

/** Single-quotes a value for `sh -c '...'`, escaping any embedded single quote. */
function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function toCheckResult(
  command: string,
  result: SandboxExecResult,
  durationMs: number,
): TaskCheckResult {
  const tail = tailOf(result.stdout + result.stderr)
  return {
    command,
    status: result.timedOut ? 'timeout' : result.code === 0 ? 'passed' : 'failed',
    exit_code: result.code,
    duration_ms: durationMs,
    tail,
  }
}

/**
 * Generous but bounded: each command gets `timeoutMs` of its own already (the
 * exec-level ceiling); this is the VM's OWN lease, an outer backstop so a
 * runtime that ignores the exec timeout still gets reclaimed.
 */
function executionMaxDurationSeconds(runbook: RunbookConfig, timeoutMs: number): number {
  const totalCommands =
    runbook.install.length +
    runbook.services.host_up.length +
    runbook.healthchecks.length +
    runbook.tests.length +
    1
  const perCommandSeconds = Math.max(30, Math.ceil(timeoutMs / 1000))
  return Math.min(EXECUTION_MAX_DURATION_SECONDS_CAP, perCommandSeconds * totalCommands)
}

export type RunbookScanOutcome =
  | {
      status: 'completed'
      runbook: RunbookConfig
      validation: RunbookValidation
      /** null when the runbook's image cannot be snapshotted (flat root disk, Microsandbox 0.6.15). */
      snapshotName: string | null
      checks: TaskCheckResult[]
      attempts: number
    }
  | { status: 'failed'; error: string; attempts: number; lastTail: string | null }

export type RunRunbookScanOptions = {
  /** Repository checkout the scan validates (read-only for the agent). */
  worktree: string
  projectId: string
  headSha: string
  driver: SandboxDriver
  /** Agent command used for the proposal (read-only agent, e.g. `claude -p`). */
  command: string
  timeoutMs: number
  /** Egress opened for the proposal agent itself (never for install: the runbook's own egress is used there). */
  allowedDomains?: readonly string[]
  onProgress?: (line: string) => void
  signal?: AbortSignal
  /** Image the proposal VM boots from and the prompt names as the default; DEFAULT_CHECKS_IMAGE ('node:26') absent. */
  defaultImage?: string
  /** Test seam: never a real disk scan in a test. */
  collectSetupFilesFn?: (repoRoot: string) => SetupFile[]
  /** Test seam: swap the prompt builder without pulling in the real one's wording. */
  buildPromptFn?: (input: RunbookProposalInput) => string
  /** Test seam: swap the whitelist without a real agent answer to feed it. */
  sanitizeProposalFn?: typeof sanitizeRunbookProposal
  /** Test seam: never a real file write in a test; returns the runbook_sha. */
  writeRunbookConfigFn?: (worktree: string, runbook: RunbookConfig) => string
  /** Test seam: never a real snapshot build in a test. */
  buildProjectSnapshotFn?: (opts: {
    driver: SandboxDriver
    projectId: string
    worktree: string
    runbook: RunbookConfig
    timeoutMs: number
    onProgress?: (line: string) => void
  }) => Promise<ProjectSnapshot>
  /**
   * Runs the read-only proposal agent and resolves its raw text answer. The
   * default boots a disposable microVM through `driver` (via `runMicrovmTurn`)
   * and lets C2's stream-json handling produce that text; a test replaces the
   * whole VM turn with a scripted answer.
   */
  runProposalFn?: (prompt: string) => Promise<string>
  /** Test seam: no real 2s waits between healthcheck retries in a test. */
  sleepFn?: (ms: number) => Promise<void>
}

type ExecuteRunbookResult =
  { ok: true; checks: TaskCheckResult[] } | { ok: false; tail: string; checks: TaskCheckResult[] }

type RunHealthchecksInput = {
  handle: SandboxHandle
  commands: readonly string[]
  budgetMs: number
  retryMs: number
  sleepFn: (ms: number) => Promise<void>
}

async function runHealthchecks(
  input: RunHealthchecksInput,
): Promise<{ ok: true } | { ok: false; tail: string }> {
  const { handle, commands, budgetMs, retryMs, sleepFn } = input
  const deadline = Date.now() + budgetMs
  for (const command of commands) {
    let last: SandboxExecResult | null = null
    for (;;) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        return {
          ok: false,
          tail: last ? tailOf(last.stdout + last.stderr) : `healthcheck timed out: ${command}`,
        }
      }
      last = await handle.shell(command, {
        cwd: MICROVM_TURN_DEFAULTS.workDir,
        timeoutMs: Math.max(1000, Math.min(remaining, retryMs * 5)),
      })
      if (!last.timedOut && last.code === 0) {
        break
      }
      const wait = Math.min(retryMs, Math.max(0, deadline - Date.now()))
      if (wait <= 0) {
        return { ok: false, tail: tailOf(last.stdout + last.stderr) }
      }
      await sleepFn(wait)
    }
  }
  return { ok: true }
}

type ExecuteRunbookInput = {
  driver: SandboxDriver
  runbook: RunbookConfig
  worktree: string
  projectId: string
  attempt: number
  timeoutMs: number
  sleepFn: (ms: number) => Promise<void>
  onProgress?: (line: string) => void
  signal?: AbortSignal
}

/**
 * One full install → services → healthchecks → tests pass, in a single VM
 * booted from `runbook.image`. The runbook's own egress stays open for the
 * WHOLE VM lease (install, services and tests alike): a sandbox's network
 * policy is fixed at `create` and cannot change mid-lease (microsandbox-driver.ts
 * guard rails), so there is no way to close it again just for the tests here.
 * The independent verdict (lot C7) replays `runbook.tests` a second time, in
 * its own VM, with network closed — this pass only proves the runbook itself
 * is honest, not that its tests need no network.
 */
async function executeRunbook(input: ExecuteRunbookInput): Promise<ExecuteRunbookResult> {
  const { driver, runbook, worktree, projectId, attempt, timeoutMs, sleepFn, onProgress, signal } =
    input
  const name = sandboxName('checks', `${projectId}-${attempt}-${randomBytes(4).toString('hex')}`)
  const spec: SandboxSpec = {
    name,
    image: runbook.image,
    cpus: MICROVM_TURN_DEFAULTS.cpus,
    memoryMib: MICROVM_TURN_DEFAULTS.memoryMib,
    maxDurationSeconds: executionMaxDurationSeconds(runbook, timeoutMs),
    network: { allowedDomains: runbook.egress },
  }
  const handle = await driver.create(spec)
  const checks: TaskCheckResult[] = []
  try {
    onProgress?.(`booted ${name} from ${runbook.image}`)
    await handle.shell(`mkdir -p ${MICROVM_TURN_DEFAULTS.workDir}`, { timeoutMs: 30_000 })
    await handle.copyFromHost(worktree, MICROVM_TURN_DEFAULTS.workDir)

    for (const command of runbook.install) {
      const startedAt = Date.now()
      const result = await handle.shell(command, {
        cwd: MICROVM_TURN_DEFAULTS.workDir,
        timeoutMs,
        ...(signal ? { signal } : {}),
      })
      const check = toCheckResult(command, result, Date.now() - startedAt)
      if (check.status !== 'passed') {
        return { ok: false, tail: check.tail, checks }
      }
    }

    for (let i = 0; i < runbook.services.host_up.length; i += 1) {
      const command = runbook.services.host_up[i] ?? ''
      const script = `nohup sh -c ${shellSingleQuote(command)} > /tmp/codesema-service-${i}.log 2>&1 &`
      const startedAt = Date.now()
      const result = await handle.shell(script, {
        cwd: MICROVM_TURN_DEFAULTS.workDir,
        timeoutMs: SERVICE_LAUNCH_TIMEOUT_MS,
      })
      if (result.timedOut || result.code !== 0) {
        return {
          ok: false,
          tail: toCheckResult(command, result, Date.now() - startedAt).tail,
          checks,
        }
      }
    }

    if (runbook.healthchecks.length > 0) {
      const health = await runHealthchecks({
        handle,
        commands: runbook.healthchecks,
        budgetMs: timeoutMs,
        retryMs: RUNBOOK_HEALTHCHECK_RETRY_MS,
        sleepFn,
      })
      if (!health.ok) {
        return { ok: false, tail: health.tail, checks }
      }
    }

    for (const command of runbook.tests) {
      const startedAt = Date.now()
      const result = await handle.shell(command, {
        cwd: MICROVM_TURN_DEFAULTS.workDir,
        timeoutMs,
        ...(signal ? { signal } : {}),
      })
      checks.push(toCheckResult(command, result, Date.now() - startedAt))
    }

    const firstFailed = checks.find((c) => c.status !== 'passed')
    if (firstFailed) {
      return { ok: false, tail: firstFailed.tail, checks }
    }
    return { ok: true, checks }
  } finally {
    try {
      await driver.destroy(name)
    } catch (err) {
      onProgress?.(`could not destroy sandbox ${name}: ${errorMessage(err)}`)
    }
  }
}

export async function runRunbookScan(opts: RunRunbookScanOptions): Promise<RunbookScanOutcome> {
  const collectFiles = opts.collectSetupFilesFn ?? collectSetupFiles
  const buildPrompt = opts.buildPromptFn ?? buildRunbookSetupPrompt
  const sanitizeProposal = opts.sanitizeProposalFn ?? sanitizeRunbookProposal
  const writeConfig = opts.writeRunbookConfigFn ?? writeRunbookConfig
  const buildSnapshot = opts.buildProjectSnapshotFn ?? buildProjectSnapshot
  const sleepFn = opts.sleepFn ?? defaultSleep
  const defaultImage = opts.defaultImage ?? DEFAULT_CHECKS_IMAGE
  const files = collectFiles(opts.worktree)

  let attempts = 0
  let previousFailure: string | null = null
  let lastTail: string | null = null

  const runProposal =
    opts.runProposalFn ??
    ((prompt: string) =>
      runMicrovmTurn({
        taskId: `runbook-scan-${opts.projectId}-${attempts}`,
        worktree: opts.worktree,
        command: opts.command,
        prompt,
        timeoutMs: opts.timeoutMs,
        driver: opts.driver,
        snapshotName: null,
        image: defaultImage,
        runbook: null,
        secrets: [],
        ...(opts.allowedDomains ? { allowedDomains: opts.allowedDomains } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      }))

  while (attempts < RUNBOOK_SCAN_MAX_ATTEMPTS) {
    attempts += 1
    if (opts.signal?.aborted) {
      return { status: 'failed', error: 'runbook scan aborted', attempts, lastTail }
    }

    opts.onProgress?.(`runbook scan attempt ${attempts}/${RUNBOOK_SCAN_MAX_ATTEMPTS}: proposing`)
    const prompt = buildPrompt({ files, previousFailure, defaultImage })
    let rawText: string
    try {
      rawText = await runProposal(prompt)
    } catch (err) {
      lastTail = tailOf(errorMessage(err))
      previousFailure = lastTail
      opts.onProgress?.(`attempt ${attempts}: proposal agent failed: ${lastTail}`)
      continue
    }

    // `sanitizeRunbookProposal` extracts the JSON itself (runbook-setup.ts): it
    // takes the raw agent text, not an already-parsed value, or it rejects
    // every proposal with "agent output must be text" regardless of content.
    const proposal = sanitizeProposal(rawText)
    if (!proposal.ok) {
      lastTail = tailOf(`proposal rejected: ${proposal.reason}`)
      previousFailure = lastTail
      opts.onProgress?.(`attempt ${attempts}: ${lastTail}`)
      continue
    }
    const runbook = proposal.runbook

    opts.onProgress?.(`runbook scan attempt ${attempts}/${RUNBOOK_SCAN_MAX_ATTEMPTS}: executing`)
    let executed: ExecuteRunbookResult
    try {
      executed = await executeRunbook({
        driver: opts.driver,
        runbook,
        worktree: opts.worktree,
        projectId: opts.projectId,
        attempt: attempts,
        timeoutMs: opts.timeoutMs,
        sleepFn,
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      })
    } catch (err) {
      executed = { ok: false, tail: tailOf(errorMessage(err)), checks: [] }
    }
    if (!executed.ok) {
      lastTail = executed.tail
      previousFailure = executed.tail
      opts.onProgress?.(`attempt ${attempts}: execution failed: ${executed.tail}`)
      continue
    }

    opts.onProgress?.(`attempt ${attempts}: green, writing the runbook`)
    const runbookSha = writeConfig(opts.worktree, runbook)
    let snapshotName: string | null = null
    try {
      const snapshot = await buildSnapshot({
        driver: opts.driver,
        projectId: opts.projectId,
        worktree: opts.worktree,
        runbook,
        agentId: commandBin(opts.command) || 'claude',
        timeoutMs: opts.timeoutMs,
        ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
      })
      snapshotName = snapshot.kind === 'cold' ? null : snapshot.name
    } catch (err) {
      opts.onProgress?.(
        `snapshot build failed (keeping the validated runbook, cold boots only): ${errorMessage(err)}`,
      )
      snapshotName = null
    }

    const validation: RunbookValidation = {
      runbook_sha: runbookSha,
      validated_sha: opts.headSha,
      validated_at: new Date().toISOString(),
      status: 'valid',
    }
    return {
      status: 'completed',
      runbook,
      validation,
      snapshotName,
      checks: executed.checks,
      attempts,
    }
  }

  return {
    status: 'failed',
    error: previousFailure ?? 'runbook scan failed with no diagnostic output',
    attempts,
    lastTail,
  }
}

export type RunbookScanRunnerOptions = {
  creds: SyncCredentials
  driver: SandboxDriver
  command: string
  timeoutMs: number
  /** Resolves the local checkout for a hub repository id; null when the runner does not have it. */
  resolveWorktree: (
    scan: RunbookScan,
  ) => Promise<{ worktree: string; projectId: string; headSha: string } | null>
  onProgress?: (line: string) => void
  fetchImpl?: typeof fetch
  /** Test seam: isolates the claim/report plumbing from the real proposal/execution loop. */
  runRunbookScanFn?: typeof runRunbookScan
  /** Test seam: overrides RUNBOOK_SCAN_LEASE_SECONDS so a test does not wait real minutes between renewals. */
  leaseSeconds?: number
  /** Test seam: an injectable, abortable sleep instead of the real timer, driving the lease-renewal loop. */
  renewSleepFn?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * Claims one queued scan from the hub, runs it, reports the result (or the
 * failure). The claim's lease is renewed periodically (every half-lease) for
 * as long as the scan runs, since a scan can take far longer than any single
 * lease: a renewal that fails (the lease was already lost to another
 * executor) aborts the in-flight scan and skips reporting anything, since
 * this executor no longer owns the claim. Returns what it did so the daemon
 * tick can log it.
 */
export async function runOneRunbookScan(
  opts: RunbookScanRunnerOptions,
): Promise<{ claimed: false } | { claimed: true; scanId: string; outcome: RunbookScanOutcome }> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const listResult = await listRunbookScans(opts.creds, fetchImpl)
  if (!listResult.ok) {
    opts.onProgress?.(`could not list runbook scans: ${hubErrorMessage(listResult.error)}`)
    return { claimed: false }
  }

  let target: {
    scan: RunbookScan
    resolved: { worktree: string; projectId: string; headSha: string }
  } | null = null
  for (const scan of listResult.data) {
    if (scan.status !== 'queued') {
      continue
    }
    const resolved = await opts.resolveWorktree(scan)
    if (resolved) {
      target = { scan, resolved }
      break
    }
  }
  if (!target) {
    return { claimed: false }
  }

  const leaseSeconds = opts.leaseSeconds ?? RUNBOOK_SCAN_LEASE_SECONDS
  const claimResult = await claimRunbookScan(
    opts.creds,
    target.scan.id,
    { leaseSeconds },
    fetchImpl,
  )
  if (!claimResult.ok) {
    opts.onProgress?.(
      `could not claim runbook scan ${target.scan.id}: ${hubErrorMessage(claimResult.error)}`,
    )
    return { claimed: false }
  }

  const renewSleep = opts.renewSleepFn ?? defaultRenewSleep
  const renewalIntervalMs = leaseRenewalIntervalMs(leaseSeconds)
  const controller = new AbortController()
  let leaseLost = false
  const renewalLoop = (async () => {
    while (!controller.signal.aborted) {
      await renewSleep(renewalIntervalMs, controller.signal)
      if (controller.signal.aborted) {
        break
      }
      const renewed = await claimRunbookScan(
        opts.creds,
        target.scan.id,
        { leaseSeconds },
        fetchImpl,
      )
      if (!renewed.ok) {
        leaseLost = true
        opts.onProgress?.(
          `lost the lease for runbook scan ${target.scan.id}: ${hubErrorMessage(renewed.error)}`,
        )
        controller.abort()
        break
      }
    }
  })()

  const runScan = opts.runRunbookScanFn ?? runRunbookScan
  let outcome: RunbookScanOutcome
  try {
    outcome = await runScan({
      worktree: target.resolved.worktree,
      projectId: target.resolved.projectId,
      headSha: target.resolved.headSha,
      driver: opts.driver,
      command: opts.command,
      timeoutMs: opts.timeoutMs,
      signal: controller.signal,
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    })
  } finally {
    controller.abort()
    await renewalLoop
  }

  if (leaseLost) {
    opts.onProgress?.(`runbook scan ${target.scan.id}: lease lost mid-scan, not reporting a result`)
    return { claimed: true, scanId: target.scan.id, outcome }
  }

  if (outcome.status === 'completed') {
    const lastTail = outcome.checks.at(-1)?.tail
    const reportResult = await reportRunbookScanResult(
      opts.creds,
      target.scan.id,
      {
        runbook: outcome.runbook,
        validation: outcome.validation,
        ...(lastTail ? { log_tail: lastTail } : {}),
      },
      fetchImpl,
    )
    if (!reportResult.ok) {
      opts.onProgress?.(
        `could not report runbook scan ${target.scan.id}: ${hubErrorMessage(reportResult.error)}`,
      )
    }
  } else {
    const failResult = await failRunbookScan(
      opts.creds,
      target.scan.id,
      { error: outcome.error },
      fetchImpl,
    )
    if (!failResult.ok) {
      opts.onProgress?.(
        `could not report failure for runbook scan ${target.scan.id}: ${hubErrorMessage(failResult.error)}`,
      )
    }
  }

  return { claimed: true, scanId: target.scan.id, outcome }
}
