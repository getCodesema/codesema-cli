/**
 * One agent turn inside a disposable microVM: the `microvm` counterpart of
 * `runContainerTurn` (task-isolation.ts), same contract (raw stdout of the
 * agent, stream-json when the command is `claude -p`), same options plus the
 * driver and the project snapshot to restore from.
 *
 * The container flow bind-mounts the worktree live; a microVM sandbox has no
 * such thing (`SandboxHandle` only offers `copyFromHost`/`copyToHost`), so
 * this turn COPIES the worktree in before the run and copies it back after —
 * see the note on `syncWorktreeIn`/`syncWorktreeOut` below for what that
 * costs and what it does not do.
 *
 * Guard rails from the spike of 2026-08-28 this file exists to respect:
 * `claude --dangerously-skip-permissions` refuses root, so the turn creates
 * (or reuses) a non-root guest user and runs the agent as `su <user> -c
 * '<cmd>'` WITHOUT a dash — with a dash, `su` resets the environment, and
 * that is exactly where the substituted secret placeholders (`$MSB_<name>`)
 * live; `SSL_CERT_FILE` is never touched, Microsandbox's own CA already
 * covers the intercepted egress.
 */
import {
  AGENT_WATCHDOG_DEFAULTS,
  agentExitError,
  AgentWatchdogError,
  armStreamWatchdog,
  systemClock,
  watchdogMessage,
  type AgentClock,
  type AgentWatchdogCause,
} from './agent.js'
import {
  attachedGitCommonDir,
  CAGE_GIT_COMMON_DIR,
  gitPointerContent,
  resolveWorktreeGitLink,
  type WorktreeGitLink,
} from './container-git.js'
import type { RunbookConfig } from './contract.js'
import { t } from './i18n.js'
import {
  sandboxName,
  type SandboxDriver,
  type SandboxHandle,
  type SandboxSecret,
  type SandboxSpec,
} from './microsandbox-driver.js'
import {
  CAGE_HOME_DIR,
  CAGE_WORK_DIR,
  DEFAULT_ISOLATION_ALLOWED_DOMAINS,
  microvmNonSecretEnv,
  type RunContainerTurnOptions,
} from './task-isolation.js'

export type RunMicrovmTurnOptions = Omit<
  RunContainerTurnOptions,
  'execFn' | 'spawnFn' | 'runtime' | 'installCommand'
> & {
  driver: SandboxDriver
  /** Project snapshot to restore (image + install already done); null boots the image cold. */
  snapshotName: string | null
  /** Image to boot when there is no snapshot: the runbook image, else the resolved base image. */
  image: string
  /** The validated runbook, when the repository has one: its egress joins the allowlist. */
  runbook: RunbookConfig | null
  /** Secrets to declare on the sandbox, built from CAGE_FORWARDED_ENV; never passed as env. */
  secrets: readonly SandboxSecret[]
  /** Guest user the agent runs as (never root: `--dangerously-skip-permissions` refuses root). */
  user?: string
}

export const MICROVM_TURN_DEFAULTS = {
  cpus: 4,
  memoryMib: 4096,
  user: 'agent',
  workDir: '/work',
} as const

/** Bootstrap timeouts are generous but bounded: none of this is the run's own watchdog. */
const BOOTSTRAP_TIMEOUT_MS = 60_000

/** Quote a value for a POSIX single-quoted shell argument. */
function shellSingleQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`
}

/** `useradd -m` the guest user if it does not already exist; idempotent, safe to re-run. */
function agentUserBootstrapScript(user: string): string {
  return [
    'set -e',
    `if ! id -u ${user} >/dev/null 2>&1; then`,
    `  useradd -m -s /bin/bash ${user}`,
    'fi',
  ].join('\n')
}

/**
 * Removes what `copyToHost` must never bring back: the synthetic `.git`
 * pointer files this turn wrote (copying them over the host's REAL `.git`
 * would corrupt the worktree — the commit happens on the host, never in the
 * guest) and `node_modules` trees, which are reproducible and would otherwise
 * multiply the copy-back's size for nothing.
 */
function copyBackCleanupScript(attachments: readonly { name: string }[]): string {
  const removeGit = [
    `rm -f ${CAGE_WORK_DIR}/.git`,
    ...attachments.map((a) => `rm -f ${CAGE_WORK_DIR}/${a.name}/.git`),
  ]
  return [
    ...removeGit,
    `find ${CAGE_WORK_DIR} -type d -name node_modules -prune -exec rm -rf {} +`,
  ].join('\n')
}

/**
 * Copies the worktree (and every attached repository) into the sandbox,
 * reproducing the container flow's git-visibility trick (container-git.ts)
 * by COPY instead of bind-mount: a linked worktree's `.git` is a one-line
 * file pointing at a HOST path (`<repo>/.git/worktrees/<id>`), which means
 * nothing inside the guest — so the shared git directory is copied in too,
 * at `CAGE_GIT_COMMON_DIR`, and the worktree's `.git` is REWRITTEN to point
 * there instead. Read-only from the guest's own perspective: the turn never
 * writes an object or a ref, it only reads status/diff/log, exactly like the
 * container's read-only mount.
 */
async function syncWorktreeIn(handle: SandboxHandle, opts: RunMicrovmTurnOptions): Promise<void> {
  await handle.copyFromHost(opts.worktree, CAGE_WORK_DIR)
  const link: WorktreeGitLink | null = resolveWorktreeGitLink(opts.worktree)
  if (link) {
    await handle.copyFromHost(link.commonDir, CAGE_GIT_COMMON_DIR)
    await handle.writeFile(`${CAGE_WORK_DIR}/.git`, gitPointerContent(link))
  }
  for (const attachment of opts.attachments ?? []) {
    const attachDir = `${CAGE_WORK_DIR}/${attachment.name}`
    await handle.copyFromHost(attachment.worktree, attachDir)
    const attachLink = resolveWorktreeGitLink(attachment.worktree)
    if (attachLink) {
      const commonDir = attachedGitCommonDir(attachment.name)
      await handle.copyFromHost(attachLink.commonDir, commonDir)
      await handle.writeFile(
        `${attachDir}/.git`,
        `gitdir: ${commonDir}/${attachLink.gitDirRelative}\n`,
      )
    }
  }
}

/**
 * Copies `/work` back onto the host worktree so the runner can read (and
 * commit) whatever the agent changed — best effort, same doctrine as the
 * container flow's other cleanup steps: a copy-back failure must not hide
 * the turn's own outcome, so both calls are swallowed here and the turn's
 * result or error is what the caller actually sees.
 *
 * KNOWN GAP (documented, not fixed in this lot): `SandboxHandle.copyToHost`
 * takes no exclude filter, so this can only shrink the tree from the GUEST
 * side before copying (node_modules, the synthetic .git pointers) rather
 * than filter the copy itself — a large untracked directory the agent wrote
 * outside those two names still comes back in full. A disk-backed shared
 * volume (mounted rw by exactly one side at a time, proven in the spike's
 * criterion 2) would avoid the copy entirely; that is a driver-level change
 * (lot C1 or later), not something this turn's options can express today.
 */
async function syncWorktreeOut(handle: SandboxHandle, opts: RunMicrovmTurnOptions): Promise<void> {
  await handle
    .shell(copyBackCleanupScript(opts.attachments ?? []), {
      timeoutMs: BOOTSTRAP_TIMEOUT_MS,
      user: 'root',
    })
    .catch(() => undefined)
  await handle.copyToHost(CAGE_WORK_DIR, opts.worktree).catch(() => undefined)
}

/**
 * Runs the agent command as the non-root guest user, wired to the SAME
 * semantic watchdog as the container turn (armStreamWatchdog) and the same
 * error shapes (AgentWatchdogError, agent.timeout, agent.interrupted,
 * agentExitError) — a caller reading `runMicrovmTurn`'s rejection cannot tell
 * which isolation mode produced it.
 *
 * `SandboxHandle.exec`/`shell` already understand `timeoutMs` and `signal`
 * (SandboxExecOptions), so this does not reimplement the container flow's own
 * process-kill escalation: a watchdog expiry, an external abort, or the
 * absolute cap all abort ONE internal AbortController, which both stops the
 * driver's own exec and (via `onKill`) starts destroying the sandbox — the
 * two race, and destroy is idempotent-safe either way.
 */
type RunMicrovmExecOptions = {
  handle: SandboxHandle
  script: string
  turn: RunMicrovmTurnOptions
  clock: AgentClock
  onKill: () => void
}

function runMicrovmExec({
  handle,
  script,
  turn: opts,
  clock,
  onKill,
}: RunMicrovmExecOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = ''
    let settled = false
    let capped = false
    let aborted = false
    let killing = false
    let cut: { cause: AgentWatchdogCause; elapsedMs: number } | null = null
    const controller = new AbortController()

    const armed = armStreamWatchdog({
      command: opts.command,
      callerDecodes: false,
      budgets: opts.watchdog ?? AGENT_WATCHDOG_DEFAULTS,
      clock,
      ...(opts.onHeartbeat ? { onHeartbeat: opts.onHeartbeat } : {}),
      onExpire: (cause, elapsedMs) => {
        if (killing) {
          return
        }
        cut = { cause, elapsedMs }
        doKill()
      },
    })

    const capCancel = clock.setTimer(() => {
      if (killing) {
        return
      }
      capped = true
      doKill()
    }, opts.timeoutMs)

    function doKill(): void {
      if (killing) {
        return
      }
      killing = true
      armed.stop()
      onKill()
      controller.abort()
    }

    function onExternalAbort(): void {
      aborted = true
      doKill()
    }
    if (opts.signal?.aborted) {
      onExternalAbort()
    } else {
      opts.signal?.addEventListener('abort', onExternalAbort, { once: true })
    }

    const finish = (run: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      armed.stop()
      capCancel()
      opts.signal?.removeEventListener('abort', onExternalAbort)
      run()
    }

    const settleFromRejection = (err: unknown): void => {
      if (cut) {
        reject(new AgentWatchdogError(cut.cause, watchdogMessage(cut.cause, cut.elapsedMs)))
      } else if (aborted) {
        reject(new Error(t('agent.interrupted')))
      } else if (capped) {
        reject(new Error(t('agent.timeout', { s: Math.round(opts.timeoutMs / 1000) })))
      } else {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    }

    handle
      .shell(script, {
        timeoutMs: opts.timeoutMs,
        input: opts.prompt,
        signal: controller.signal,
        onText: (chunk) => {
          out += chunk
          armed.push(chunk)
          opts.onText?.(out)
        },
      })
      .then((result) => {
        finish(() => {
          if (cut) {
            reject(new AgentWatchdogError(cut.cause, watchdogMessage(cut.cause, cut.elapsedMs)))
          } else if (aborted) {
            reject(new Error(t('agent.interrupted')))
          } else if (capped || result.timedOut) {
            reject(new Error(t('agent.timeout', { s: Math.round(opts.timeoutMs / 1000) })))
          } else if (result.code === 0) {
            resolve(out || result.stdout)
          } else {
            reject(agentExitError(result.code, out || result.stdout, result.stderr))
          }
        })
      })
      .catch((err: unknown) => {
        finish(() => settleFromRejection(err))
      })
  })
}

/**
 * Runs ONE agent turn in its own disposable microVM and resolves the raw
 * stdout — the same contract as `runContainerTurn`. Rejects with a readable
 * message when the sandbox cannot be built or the turn dies; it never falls
 * back to another isolation mode. The sandbox is ALWAYS destroyed before this
 * settles, success or failure: a microVM turn is never reused across calls.
 */
export async function runMicrovmTurn(opts: RunMicrovmTurnOptions): Promise<string> {
  const driver = opts.driver
  const clock = opts.clock ?? systemClock
  const user = opts.user ?? MICROVM_TURN_DEFAULTS.user
  const name = sandboxName('dev', opts.taskId)
  const maxDurationSeconds = Math.ceil(opts.timeoutMs / 1000) + 60
  // Deliberately as generous as the container flow's own egress for this
  // command PLUS the runbook's install/services domains: unlike the runbook
  // runner (which opens `egress` only for install and services, then closes
  // it), a DEV turn must be able to install a package the agent decides it
  // needs mid-run, so this keeps the runbook's egress open for the whole
  // turn rather than narrowing it around specific steps.
  const allowedDomains = Array.from(
    new Set([
      ...(opts.allowedDomains ?? DEFAULT_ISOLATION_ALLOWED_DOMAINS),
      ...(opts.runbook?.egress ?? []),
    ]),
  )
  const env = opts.env ?? process.env
  const specEnv: Record<string, string> = { ...microvmNonSecretEnv(env), HOME: CAGE_HOME_DIR }

  const spec: SandboxSpec = {
    name,
    cpus: MICROVM_TURN_DEFAULTS.cpus,
    memoryMib: MICROVM_TURN_DEFAULTS.memoryMib,
    maxDurationSeconds,
    network: { allowedDomains },
    secrets: opts.secrets,
    env: specEnv,
    user,
    ...(opts.snapshotName ? { fromSnapshot: opts.snapshotName } : { image: opts.image }),
  }

  const handle = await driver.create(spec)
  // Deduped at THIS level, not left to the driver: a watchdog cut or an
  // external abort destroys the sandbox from `onKill` to actually stop a
  // hung exec, and the outer `finally` below destroys it again on every
  // other path — without the guard the two would race a redundant second
  // `driver.destroy()` call on the same name for every cut/abort/timeout.
  let destroyed = false
  const destroy = (): Promise<void> => {
    if (destroyed) {
      return Promise.resolve()
    }
    destroyed = true
    return driver.destroy(name).catch(() => undefined)
  }

  try {
    // Root only for the steps that need it: creating the non-root user,
    // preparing /work, and the `su` wrapper below that drops to it. The
    // agent itself never runs as root.
    await handle.shell(agentUserBootstrapScript(user), {
      timeoutMs: BOOTSTRAP_TIMEOUT_MS,
      user: 'root',
    })
    await handle.shell(`mkdir -p ${CAGE_WORK_DIR}`, {
      timeoutMs: BOOTSTRAP_TIMEOUT_MS,
      user: 'root',
    })
    await syncWorktreeIn(handle, opts)
    await handle.shell(`chown -R ${user}:${user} ${CAGE_WORK_DIR}`, {
      timeoutMs: BOOTSTRAP_TIMEOUT_MS,
      user: 'root',
    })

    // `su <user> -c '<cmd>'` WITHOUT a dash (spike-verified): a dash resets
    // the environment, and the substituted secret placeholders live in it.
    // The workdir is not passed to `create()` — the SDK refuses one that does
    // not already exist in the image — so `cd` happens here instead.
    const script = `cd ${CAGE_WORK_DIR} && su ${user} -c ${shellSingleQuote(opts.command)}`

    let turnError: unknown = null
    let out = ''
    try {
      out = await runMicrovmExec({
        handle,
        script,
        turn: opts,
        clock,
        onKill: () => void destroy(),
      })
    } catch (err) {
      turnError = err
    }

    await syncWorktreeOut(handle, opts)

    if (turnError !== null) {
      throw turnError
    }
    return out
  } finally {
    await destroy()
  }
}
