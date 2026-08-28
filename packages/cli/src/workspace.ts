// `codesema workspace`: starts the local agentic workspace server — the web
// UI where tasks are given in natural language and run in parallel worktrees.
// Multi-project: one process drives every repo registered in the global
// project registry (projects.ts). Launched from inside a git repo, that repo
// is auto-registered and becomes the current project; launched outside any
// repo, the workspace opens on the existing registry (possibly empty — add
// projects from the UI). The process stays in the foreground: tasks live as
// long as it runs. D21 introduces one targeted exception to that:
// `codesema runner serve --detach` (runner-commands.ts) backgrounds the runner
// daemon behind a detached child process; every other entry point (bare
// `codesema workspace`, `codesema review`, `codesema runner serve` without the
// flag) stays foreground-only. Whenever CODESEMA_RUNNER_MODE is set, a
// repo-local `<cwd>/.codesema/runner.pid` (runner-pidfile.ts) records
// {pid, port, started_at} once the port is known, so `runner stop`/`runner
// status`, run later from a different process, can find this daemon; it
// is erased on shutdown, right beside the lock below. The first
// Ctrl-C shuts down gracefully (agents SIGTERMed, the turns IN FLIGHT
// persisted 'interrupted', worktrees kept — the next boot offers them back,
// and one click on Resume in the UI restarts the turn that died; a turn that
// started never restarts on its own). Tasks that were only WAITING are left
// 'queued' in their repo's .codesema/queue.json, and the next boot picks the
// line back up — as an EXPLICIT last step (manager.startPending()), once the
// server listens and the shutdown handlers are installed, announced on the
// terminal. A second Ctrl-C during that drain force-quits. A GLOBAL
// <globalConfigDir()>/workspace.lock prevents a second workspace process from
// racing this one's registry and task stores.

import { knownAgent, type WatchdogBudgets } from './agent.js'
import {
  globalConfigPath,
  hasInvalidPositiveIntKey,
  invalidGlobalMergeKeys,
  loadConfig,
  loadGlobalConfig,
  repoGlobalOnlyIgnoredNotices,
  resolveMergeSettings,
  resolveProjectAgentCommand,
  resolveProjectConfig,
  resolveWatchdogBudgets,
  type MergeSettings,
  type ProjectConfigFlags,
} from './config.js'
import { probeForgeCli } from './degraded-mode.js'
import { createFixRunner, DEFAULT_TIMEOUT_S } from './fix.js'
import { runForgeCli } from './forge-issues.js'
import { tryGit } from './git.js'
import { t, uiLocale } from './i18n.js'
import { createMrReviewRunner } from './mr-review-runner.js'
import { openBrowser } from './open.js'
import { addProject, listProjects, type Project } from './projects.js'
import { removeRunnerPidfile, writeRunnerPidfile } from './runner-pidfile.js'
import { createSession, startServer } from './serve.js'
import {
  DEFAULT_ISOLATION_ALLOWED_DOMAINS,
  isolationDomainsFor,
  overlayIsolationProbe,
  probeIsolation,
  teardownEgressProxy,
  type IsolationProbe,
} from './task-isolation.js'
import { pendingResumeTurn } from './task-runner.js'
import { createTaskManager, type PendingQueue, type TaskManager } from './task-server.js'
import { AGENT_DEFS, defaultCommand, detectAgents } from './wizard.js'
import { acquireWorkspaceLock, type WorkspaceLockHandle } from './workspace-lock.js'

/** Registered projects at boot: the workspace names what it will drive. */
function logProjects(projects: Project[], currentId: string | null): void {
  if (projects.length === 0) {
    console.log(`  ${t('workspace.noProjects')}`)
    return
  }
  for (const project of projects) {
    const marker = project.id === currentId ? '›' : ' '
    console.log(`  ${marker} ${project.name}  ${project.path}`)
  }
}

/**
 * Tasks a previous shutdown/crash left MID-TURN: surface them at boot, all
 * projects. NOTHING re-enqueues them — restarting agents that write code and
 * commit, unattended, on a plain `codesema workspace` boot would be intrusive
 * and would burn tokens on work nobody asked for. The offer is explicit
 * instead: this line, and the "needs you" section of the web UI where one
 * click on Resume restarts the very turn that died (the resumed provider
 * session when the record kept one, the transcript replay otherwise).
 *
 * A task that was only WAITING is a different story and is NOT listed here:
 * its turn never started, nothing of it can be repeated, and its place in the
 * repo's queue.json is exactly the instruction "run me when it is my turn" —
 * startPending() honors it, and logResumedQueues says so.
 */
function logResumableTasks(manager: TaskManager): void {
  const resumable = manager
    .listAll()
    .flatMap(({ project, records }) =>
      records
        .filter((record) => pendingResumeTurn(record) !== null)
        .map((record) => ({ project, record })),
    )
  if (resumable.length === 0) {
    return
  }
  console.log('')
  console.log(t('workspace.resumable', { n: resumable.length }))
  for (const { project, record } of resumable) {
    console.log(`    ${project.name}  ${record.id}  ${record.title}`)
  }
}

/**
 * Says which projects picked their persisted queue back up, and how many tasks
 * that meant. A boot that silently starts agents is a boot the user cannot
 * audit: whatever startPending() resumed is on screen, project by project.
 */
export function logResumedQueues(resumed: readonly PendingQueue[]): void {
  if (resumed.length === 0) {
    return
  }
  console.log('')
  for (const { project, queued } of resumed) {
    console.log(t('workspace.queueResumed', { n: queued, project: project.name }))
  }
}

/**
 * The `maxParallelTasks` line a user still has in their config is DEPRECATED
 * since T1.3: `resolveMaxConcurrentAgents` still reads and honors it (as an
 * alias of `maxConcurrentAgents`, the machine-wide load cap, D4) — it is
 * never dropped in silence — but a key quietly renamed under a user's feet is
 * still a key that could confuse them, so the boot says so out loud once,
 * and only when it is actually set. Null when there is nothing to say. Fires
 * even when `maxConcurrentAgents` is ALSO set (design.md Decision 5): the
 * explicit key wins the VALUE, but the deprecated one is still named.
 */
export function maxParallelNotice(configured: number | undefined): string | null {
  return configured === undefined ? null : t('workspace.maxParallelDeprecated', { n: configured })
}

/**
 * A boot line for a machine-cap key (`maxConcurrentAgents` or its deprecated
 * alias `maxParallelTasks`) that is PRESENT in the config but not usable —
 * `0`, a negative number, a string — as opposed to simply unset. `parseConfig`
 * drops such a value in silence (whitelist and truncate, the doctrine every
 * other numeric config key gets too); this is the one case that also WARNS,
 * because the value it ignores directly controls how many heavy processes
 * this machine runs at once, and a user who typed one meant to size that
 * (adversarial review, MINEUR — invariant § 0.3 n°2's non-silence, applied to
 * the ticket's own new key). Null when both keys on the GLOBAL file are
 * either absent or usable. A repo file that sets them is a different
 * warning (`repoGlobalOnlyIgnoredNotices`, T1.4): the key is global-only, so
 * "unusable value" would mis-describe a value that is not applied at all.
 */
export function invalidLoadCapKeyNotice(repoRoot: string | null): string | null {
  const keys = ['maxConcurrentAgents', 'maxParallelTasks'] as const
  // `repoRoot` is kept so existing call sites do not drift; T1.4 stopped
  // reading the repo file here — that key is named as global-only instead.
  void repoRoot
  const bad = keys.find((key) => hasInvalidPositiveIntKey(globalConfigPath(), key))
  return bad ? t('workspace.invalidLoadCapKey', { key: bad }) : null
}

/**
 * A boot line per merge key (T3.6) that is PRESENT in the GLOBAL config but
 * not usable — `mergePolicy: "Auto"`, `allowMergeWithoutChecks: 1`. Same
 * argument as `invalidLoadCapKeyNotice`, and a sharper one here: when a typo
 * on one of these four is dropped, the SAFE default stays in place, so
 * nothing breaks and nothing is said — and someone who believed they had
 * authorized automatic merging would watch a workspace that never merges,
 * with no idea why. Empty when every merge key on the global file is absent
 * or usable.
 */
export function invalidMergeKeyNotices(): string[] {
  return invalidGlobalMergeKeys().map((key) => t('workspace.invalidMergeKey', { key }))
}

/**
 * Every boot line this ticket's config surface produces, in the order the
 * terminal shows them: the deprecation of `maxParallelTasks`, then the
 * unusable-value warning. Empty when there is nothing to say.
 *
 * Pure and exported (round 4, mineur) so the ANNOUNCEMENT is proven where the
 * two notices are actually assembled, not only inside each notice function:
 * `workspace()` cannot be called from a test (it listens on a port, takes the
 * global lock, installs real signal handlers), so nothing runtime-level can
 * observe what the boot prints. Dropping either entry from this array turns a
 * test red — and, since round 5 (MAJEUR A), so does severing the call below:
 * extracting the array left its CALL SITE unproven, and replacing the loop
 * with an empty one kept the suite at 0 fail while both notices disappeared.
 * `workspace-lifecycle.test.ts` now pins that loop by source shape too.
 */
export function bootNotices(
  config: { maxParallelTasks?: number | undefined },
  repoRoot: string | null,
): string[] {
  return [
    maxParallelNotice(config.maxParallelTasks),
    invalidLoadCapKeyNotice(repoRoot),
    ...invalidMergeKeyNotices(),
    ...repoGlobalOnlyIgnoredNotices(repoRoot),
  ].filter((line): line is string => line !== null)
}

/**
 * The machine-wide load cap in force (T1.3, D4): the explicit
 * `maxConcurrentAgents` wins when both keys are set (design.md Decision 5);
 * `maxParallelTasks` is the deprecated fallback; undefined when neither is
 * configured, which lets `createLoadCap`/`createTaskManager` apply
 * DEFAULT_MAX_CONCURRENT_AGENTS rather than baking that default in twice.
 */
export function resolveMaxConcurrentAgents(config: {
  maxConcurrentAgents?: number | undefined
  maxParallelTasks?: number | undefined
}): number | undefined {
  return config.maxConcurrentAgents ?? config.maxParallelTasks
}

/**
 * EVERY option `workspace()` builds its `createTaskManager` with — not a
 * subset spread over an inline literal (T1.3 round 4, MAJEUR 2). The previous
 * round pulled out only the three the ticket touched; the call site kept
 * `command`, `timeoutMs`, `watchdog`, `isolation` and `allowedDomains`
 * inline, so a merge resolution that dropped the spread (the T2.4 rebase
 * conflict lands EXACTLY on that line) silently removed both `shutdownSignal`
 * and `maxConcurrentAgents` from production with 2 089 tests still green. The
 * proof stopped at the door.
 *
 * Now the door is inside: `createTaskManager(workspaceTaskManagerOptions(…))`
 * has nothing of its own left, and `command`/`timeoutMs` are REQUIRED members
 * of `CreateTaskManagerOptions` — so deleting the call, or replacing it with
 * the old inline literal, no longer compiles. The typecheck gate becomes the
 * net the test suite could not be.
 *
 * What this decides, beyond passing `boot` through: the deprecated
 * `maxParallelTasks` value kept so it round-trips, the effective
 * `maxConcurrentAgents` (explicit key or its alias, `resolveMaxConcurrentAgents`,
 * design.md Decision 5), and `shutdownSignal` wired to `draining` — the same
 * AbortController `installShutdownHandlers` aborts on the first
 * SIGINT/SIGTERM, so a checks run parked on a saturated machine cap can be
 * woken by a shutdown.
 *
 * Pure and exported so a test can call it without booting a real server or
 * installing real signal handlers: `workspace()` itself starts a listening
 * server and registers `process.on`, which makes it unsafe to invoke
 * end-to-end from a test (see workspace-lifecycle for why).
 */
export function workspaceTaskManagerOptions(
  config: {
    maxParallelTasks?: number | undefined
    maxConcurrentAgents?: number | undefined
    taskRetentionCount?: number | undefined
    // T3.6: the four merge keys, resolved HERE and handed over as one settled
    // value. They are global by construction — a consent belongs to whoever
    // runs the workspace, not to a repository — so the manager receives them
    // once instead of resolving them per project.
    mergePolicy?: MergeSettings['policy'] | undefined
    mergeStrategy?: MergeSettings['strategy'] | undefined
    deleteBranchAfterMerge?: boolean | undefined
    allowMergeWithoutChecks?: boolean | undefined
  },
  draining: AbortController,
  /**
   * The boot facts this function does not compute: the resolved agent
   * command, the turn ceiling, the watchdog budgets, the isolation probe and
   * the egress allowlist. Passed in rather than re-derived so the function
   * stays pure (no config file reads, no container probe) while still being
   * the WHOLE argument of `createTaskManager`.
   */
  boot: Pick<
    Parameters<typeof createTaskManager>[0],
    | 'command'
    | 'timeoutMs'
    | 'watchdog'
    | 'isolation'
    | 'forge'
    | 'allowedDomains'
    | 'flags'
    | 'globalOnlyNoticeShown'
    | 'launchRepoPath'
  >,
): Parameters<typeof createTaskManager>[0] {
  return {
    ...boot,
    ...(config.maxParallelTasks !== undefined ? { maxParallel: config.maxParallelTasks } : {}),
    ...(resolveMaxConcurrentAgents(config) !== undefined
      ? { maxConcurrentAgents: resolveMaxConcurrentAgents(config) }
      : {}),
    ...(config.taskRetentionCount !== undefined
      ? { taskRetention: config.taskRetentionCount }
      : {}),
    mergeSettings: resolveMergeSettings(config),
    // Re-read from the global file at the moment a merge decision is made
    // (the getChecksConfig pattern): a strategy set through the settings API
    // used to stay invisible until the next restart because only the boot
    // value above was ever consulted. The boot value stays as the fallback.
    getMergeSettings: () => resolveMergeSettings(loadGlobalConfig()),
    // Named on the task's journal too, not only on the boot line: a user who
    // typed `mergePolicy: "Auto"` scrolled past the terminal long ago by the
    // time a task reaches its merge step.
    ...(invalidGlobalMergeKeys().length > 0 ? { degradedMergeKeys: invalidGlobalMergeKeys() } : {}),
    shutdownSignal: draining.signal,
  }
}

/**
 * The three per-project settings a project inherits when it declares NONE of
 * its own — resolved from the GLOBAL file plus the CLI flags, and **never**
 * from the launch repo's `.codesema/config.json`.
 *
 * This is the whole point of T1.4 restated as a function: `workspace()` is
 * launched from repo A, but the manager it builds serves every registered
 * repo, so whatever it hands over as a fallback becomes B's, C's and D's
 * default. An adversarial round measured the leak that shape invites — the
 * egress allowlist was still read off the launch repo (review MAJEUR A1), so
 * a sibling with no `isolationAllowedDomains` of its own ran its CAGED agent
 * against A's widened allowlist. That is an inter-repo widening of trust on
 * the isolation surface (invariant 3), and it was invisible because the
 * function that would have shown it did not exist.
 *
 * Exported and pure of anything but the two config reads so a test can assert
 * it directly: `workspace()` itself listens on a port, takes the global lock
 * and installs real signal handlers, and can never be called from the suite.
 */
export function workspaceBootFallbacks(flags: ProjectConfigFlags): {
  timeoutMs: number
  allowedDomains: readonly string[]
  watchdog: WatchdogBudgets
} {
  const fallback = resolveProjectConfig(null, flags).config
  return {
    timeoutMs: (fallback.timeout ?? DEFAULT_TIMEOUT_S) * 1000,
    allowedDomains: fallback.isolationAllowedDomains ?? DEFAULT_ISOLATION_ALLOWED_DOMAINS,
    watchdog: resolveWatchdogBudgets(fallback),
  }
}

/**
 * One line, every boot: either the cage is on (and what it lets out), or it is
 * off and WHY. The fallback to the host policy hardening is a downgrade of the
 * promise made to the user — it is never allowed to happen quietly.
 */
export function logIsolation(probe: IsolationProbe, domains: readonly string[]): void {
  console.log(
    probe.available
      ? t('workspace.isolationContainer', {
          runtime: probe.runtime ?? '',
          domains: domains.join(', '),
        })
      : t('workspace.isolationPolicy', { reason: probe.reason }),
  )
}

/**
 * Graceful shutdown: the first signal drains (agents SIGTERMed, the turn in
 * flight persisted 'interrupted' with {reason:'shutdown'}, worktrees KEPT for
 * resume, and the end-of-turn review awaited rather than orphaned), a second
 * signal force-quits — the classic double Ctrl-C escape hatch when an agent
 * ignores its SIGTERM. 130 = 128 + SIGINT, the conventional exit code.
 */
function installShutdownHandlers(deps: {
  manager: TaskManager
  stop: () => Promise<void>
  lock: WorkspaceLockHandle
  probe: IsolationProbe
  draining: AbortController
  cwd: string
}): void {
  const { manager, stop, lock, probe, draining, cwd } = deps
  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) {
      process.exit(130)
    }
    shuttingDown = true
    // Announced before anything else is awaited: whoever is queueing for a repo
    // lock on a cleanup path must stop queueing and let the exit through.
    draining.abort()
    console.log('')
    console.log(t('workspace.shuttingDown'))
    void (async () => {
      try {
        await manager.shutdown()
        await stop()
        // The egress proxy outlives individual tasks: it dies with the
        // workspace that started it, never before and never after.
        await teardownEgressProxy({ runtime: probe.runtime })
      } finally {
        // Exit inside finally: even a failing drain must not leave a headless
        // process holding the lock.
        lock.release()
        // Mirrors the write at lock.setPort() below: only ever written and
        // removed together, gated on the same env var.
        if (process.env.CODESEMA_RUNNER_MODE === '1') {
          removeRunnerPidfile(cwd)
        }
        process.exit(0)
      }
    })()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/**
 * Fallback agent the workspace will drive, or a loud throw: unlike review, the
 * workspace is pointless without an agent (every task would 501). TOFU for a
 * repo-provided command lives in `resolveProjectAgentCommand` — an untrusted
 * launch-repo agent no longer aborts boot; the project notices and falls back
 * instead (T1.4 review nit).
 */
async function resolveAgentCommand(
  cwd: string,
  configured: string | undefined,
  detectFn: typeof detectAgents = detectAgents,
): Promise<string> {
  // Detection only ever feeds the FALLBACK. Probing every agent binary to
  // then discard the answer is pure boot latency, and it is the reason the
  // boot touched the filesystem on a machine that has already been told which
  // agent to drive.
  const [detected] = configured ? [undefined] : await detectFn(cwd)
  const agentCommand = configured ?? (detected ? defaultCommand(detected) : undefined)
  if (!agentCommand) {
    throw new Error(t('agent.noneFound', { bins: AGENT_DEFS.map((d) => d.bin).join(', ') }))
  }
  return agentCommand
}

/**
 * Test seams of the boot itself. `workspace()` is the ONLY place the two
 * unattended housekeeping passes are wired and the only place
 * `taskRetentionCount` travels from the config to the manager — none of which
 * any other module can observe. Without these, deleting either `void
 * taskManager.…()` line below, or the `taskRetention` mapping, leaves the
 * whole suite green while the feature is gone (T1.9 review round 4, MAJEUR 4;
 * §6 quater: the ticked box that renders nothing).
 */
export type WorkspaceSeams = {
  createTaskManagerFn?: typeof createTaskManager
  startServerFn?: typeof startServer
  /**
   * The container-runtime probe. Injected so a boot test can be genuinely
   * hermetic: the boot probes with `configured: 'auto'` REGARDLESS of the
   * configured isolation (that is deliberate — the boot line must be able to
   * say a cage is available even when this repo declines it), so a configured
   * `isolation: 'policy'` does NOT keep the boot away from docker/podman.
   * On a machine with no runtime the probe is the slowest thing in the boot.
   */
  probeIsolationFn?: typeof probeIsolation
  /**
   * The agent-binary probe. Injected for the same reason: `detectAgents` runs
   * `<bin> --version` for EVERY known agent under one shared 8s window, and
   * the boot used to pay for it even when the answer was thrown away.
   */
  detectAgentsFn?: typeof detectAgents
  /**
   * The forge-CLI probe (T2.7/D9). Injected for the same reason as the two
   * above: it spawns `gh --version` then `glab --version`, and a boot test
   * must neither pay for that nor depend on what the machine happens to have
   * installed. Its answer is machine-wide and is cached on the manager —
   * `workspaceInfo()` is synchronous and must never spawn anything.
   */
  probeForgeCliFn?: typeof probeForgeCli
}

export async function workspace(
  opts: {
    port?: number | undefined
    open: boolean
    cwd: string
    agent?: string | undefined
    timeout?: number | undefined
  } & WorkspaceSeams,
): Promise<void> {
  // Launchable from anywhere: a repo auto-registers and becomes the current
  // project, a plain directory opens the workspace on the registry as-is.
  const repoRoot = tryGit(['rev-parse', '--show-toplevel'], opts.cwd)
  const config = loadConfig(repoRoot)
  const global = loadGlobalConfig()
  const flags: ProjectConfigFlags = {
    ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
  }
  // Fallback agent: CLI flag / global file / detected in cwd. The launch
  // repo's `.codesema/config.json` is NOT baked in — that would leak A's
  // TOFU-approved command onto every sibling (T1.4 review).
  const agentCommand = await resolveAgentCommand(
    opts.cwd,
    opts.agent ?? global.agent,
    opts.detectAgentsFn ?? detectAgents,
  )
  const launchAgent = resolveProjectAgentCommand(repoRoot, flags, agentCommand)
  // A custom (non claude/codex/gemini) agent command gets NO hardening flags:
  // full env, no read-only harness, no strict-mcp. The user chose it, but the
  // workspace must say so out loud once per boot.
  if (knownAgent(launchAgent.command) === null) {
    console.log(t('workspace.customAgentWarning', { command: launchAgent.command }))
  }
  if (launchAgent.warning) {
    console.log(launchAgent.warning)
  }

  // Container RUNTIME is probed ONCE at boot (T1.4): is an engine there, does
  // it answer. Per-project isolation mode and agent are overlaid at task
  // creation AND on the boot line, so a launch repo set to `policy` cannot
  // claim the cage is on. `ignoreAgent` skips the cageable-agent check — that
  // one is per-project too.
  const launchConfig = resolveProjectConfig(repoRoot, flags).config
  // What EVERY project falls back to. Read from the global file + flags only:
  // the launch repo's own allowlist/timeout/budgets are its business alone.
  const fallbacks = workspaceBootFallbacks(flags)
  // ...and what the BOOT LINE announces, which is about the launch repo and
  // must therefore name the allowlist THAT repo's caged tasks would get.
  const launchDomains =
    launchConfig.isolationAllowedDomains ?? isolationDomainsFor(launchAgent.command)
  const probe = await (opts.probeIsolationFn ?? probeIsolation)({
    configured: 'auto',
    command: agentCommand,
    ignoreAgent: true,
  })
  const bootProbe = overlayIsolationProbe(probe, {
    configured: launchConfig.isolation ?? 'auto',
    command: launchAgent.command,
  })
  // D9 (degraded-mode.ts): probed ONCE, here, and handed to the manager —
  // never re-asked per request. `--version` only: booting must not phone a
  // forge, and the answer to "can a forge CLI run at all" is the machine's,
  // not one repo's. The per-repo half (`origin`) is asked per project.
  const forgeProbe = await (opts.probeForgeCliFn ?? probeForgeCli)(
    runForgeCli,
    repoRoot ?? opts.cwd,
  )

  // The lock must be held BEFORE the manager touches any task store: its boot
  // recovery would mark another live workspace's running tasks as orphans.
  const lock = acquireWorkspaceLock()
  // Launch-repo ceiling (flags > that repo > global) for fix / MR-review,
  // which only exist for the repo we started in. The manager's fallback is
  // global+flags so a sibling without `timeout` does not inherit A's.
  const timeoutMs = (launchConfig.timeout ?? DEFAULT_TIMEOUT_S) * 1000
  // Aborted by the first SIGINT/SIGTERM, handed to the runners that wait on the
  // repo lock while cleaning up, so the exit never sits behind one.
  const draining = new AbortController()
  let currentProjectId: string | null = null
  let taskManager
  let started
  try {
    if (repoRoot !== null) {
      const added = addProject(repoRoot)
      if (!added.ok) {
        throw new Error(added.error)
      }
      currentProjectId = added.project.id
    }

    // NOTHING inline here, on purpose (T1.3 round 4, MAJEUR 2): every option
    // this manager gets comes from the tested `workspaceTaskManagerOptions`,
    // so a merge that loses the call cannot silently lose `shutdownSignal`,
    // `maxConcurrentAgents` or `taskRetention` — it stops compiling instead.
    // The call TARGET is T1.9's injection seam, which is how the boot wiring
    // is itself tested; the ARGUMENT is what carries every option. Both halves
    // are pinned by workspace-lifecycle.test.ts.
    taskManager = (opts.createTaskManagerFn ?? createTaskManager)(
      workspaceTaskManagerOptions(config, draining, {
        command: agentCommand,
        // Fallback ceiling, egress allowlist and watchdog budgets (T1.4): a
        // project that sets its own wins in context(). Global file + flags,
        // then the defaults — never the launch repo's file.
        timeoutMs: fallbacks.timeoutMs,
        watchdog: fallbacks.watchdog,
        isolation: probe,
        forge: forgeProbe,
        allowedDomains: fallbacks.allowedDomains,
        flags,
        ...(repoRoot !== null
          ? { globalOnlyNoticeShown: [repoRoot], launchRepoPath: repoRoot }
          : {}),
      }),
    )

    // The review surface (fix, MR review) stays available from the same server
    // when launched inside a repo: the workspace extends the product, it does
    // not replace the review API. Outside a repo those runners have no target.
    const session = createSession()
    started = await (opts.startServerFn ?? startServer)(session, {
      cwd: repoRoot ?? opts.cwd,
      port: opts.port ?? config.port,
      locale: uiLocale(),
      ...(repoRoot !== null
        ? {
            fixRunner: createFixRunner({
              getRecord: () => session.record(),
              cwd: repoRoot,
              command: launchAgent.command,
              timeoutMs,
            }),
            mrReviewRunner: createMrReviewRunner({
              cwd: repoRoot,
              session,
              agentCommand: launchAgent.command,
              timeoutMs,
              shutdownSignal: draining.signal,
            }),
          }
        : {}),
      taskManager,
      currentProjectId,
    })
  } catch (err) {
    // Nothing runs yet: a boot failure must not leave a lock that blocks the
    // next start until its pid dies.
    lock.release()
    throw err
  }
  lock.setPort(started.port)
  if (process.env.CODESEMA_RUNNER_MODE === '1') {
    writeRunnerPidfile(repoRoot ?? opts.cwd, process.pid, started.port)
  }

  console.log('')
  console.log(`codesema — ${t('workspace.intro')}`)
  console.log(`  ${started.url}`)
  console.log(`  ${t('review.ctrlc')}`)
  console.log('')
  logIsolation(bootProbe, launchDomains)
  for (const line of bootNotices(config, repoRoot)) {
    console.log(line)
  }
  console.log('')
  console.log(t('workspace.projects'))
  logProjects(listProjects(), currentProjectId)
  logResumableTasks(taskManager)
  if (opts.open) {
    openBrowser(started.url)
  }
  installShutdownHandlers({
    manager: taskManager,
    stop: started.stop,
    lock,
    probe,
    draining,
    cwd: repoRoot ?? opts.cwd,
  })
  // T1.9 housekeeping: orphaned HOME volumes and the retention purge of old
  // terminated tasks. Neither gates the workspace being usable (both report
  // through `notice` — the console today, see task-server.ts) and neither is
  // awaited: a slow container runtime or a large tasks/ directory must not
  // delay the line below any more than starting the queued tasks does.
  void taskManager.sweepOrphanedVolumes()
  void taskManager.applyRetention()
  // ONLY NOW do the persisted queues restart. Everything above had to be true
  // first: the server listens (a task that starts has somewhere to report),
  // the shutdown handlers are installed (a Ctrl-C drains it instead of killing
  // it mid-turn), and the boot has already said what it found. A turn that
  // started before any of that could neither be watched nor stopped.
  logResumedQueues(await taskManager.startPending())
  // The listening server keeps the event loop (and therefore the tasks) alive.
}
