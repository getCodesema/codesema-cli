// `codesema workspace`: starts the local agentic workspace server — the web
// UI where tasks are given in natural language and run in parallel worktrees.
// Multi-project: one process drives every repo registered in the global
// project registry (projects.ts). Launched from inside a git repo, that repo
// is auto-registered and becomes the current project; launched outside any
// repo, the workspace opens on the existing registry (possibly empty — add
// projects from the UI). The process stays in the foreground: tasks live as
// long as it runs (no detached daemon, decision n°4 of the plan). The first
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

import { knownAgent } from './agent.js'
import { isRepoAgentTrusted, loadConfig, loadRepoConfig, resolveWatchdogBudgets } from './config.js'
import { createFixRunner, DEFAULT_TIMEOUT_S } from './fix.js'
import { tryGit } from './git.js'
import { t, uiLocale } from './i18n.js'
import { createMrReviewRunner } from './mr-review-runner.js'
import { openBrowser } from './open.js'
import { addProject, listProjects, type Project } from './projects.js'
import { createSession, startServer } from './serve.js'
import {
  DEFAULT_ISOLATION_ALLOWED_DOMAINS,
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
 * The `maxParallelTasks` line a user still has in their config does nothing
 * since T1.2: admission is per project now. A setting silently ignored is a
 * setting that lies, so the boot says it out loud — once, and only when the
 * key is actually set. Null when there is nothing to say.
 */
export function maxParallelNotice(configured: number | undefined): string | null {
  return configured === undefined ? null : t('workspace.maxParallelInert', { n: configured })
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
}): void {
  const { manager, stop, lock, probe, draining } = deps
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
        process.exit(0)
      }
    })()
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

/**
 * Agent command the workspace will drive, or a loud throw: unlike review, the
 * workspace is pointless without an agent (every task would 501). A
 * repo-provided command (TOFU surface) is never run unattended — the workspace
 * launches agents without further prompts, so it requires the explicit
 * one-time approval `codesema review` performs interactively. Outside a repo
 * there is no repo config, hence no TOFU surface to check.
 */
async function resolveAgentCommand(
  cwd: string,
  repoRoot: string | null,
  configured: string | undefined,
): Promise<string> {
  const [detected] = await detectAgents(cwd)
  const agentCommand = configured ?? (detected ? defaultCommand(detected) : undefined)
  if (!agentCommand) {
    throw new Error(t('agent.noneFound', { bins: AGENT_DEFS.map((d) => d.bin).join(', ') }))
  }
  if (repoRoot !== null) {
    const repoAgent = loadRepoConfig(repoRoot).agent
    if (repoAgent === agentCommand && !isRepoAgentTrusted(repoRoot, agentCommand)) {
      throw new Error(t('review.repoAgentUnattended', { command: agentCommand }))
    }
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
}

export async function workspace(
  opts: {
    port?: number | undefined
    open: boolean
    cwd: string
  } & WorkspaceSeams,
): Promise<void> {
  // Launchable from anywhere: a repo auto-registers and becomes the current
  // project, a plain directory opens the workspace on the registry as-is.
  const repoRoot = tryGit(['rev-parse', '--show-toplevel'], opts.cwd)
  const config = loadConfig(repoRoot)
  const agentCommand = await resolveAgentCommand(opts.cwd, repoRoot, config.agent)
  // A custom (non claude/codex/gemini) agent command gets NO hardening flags:
  // full env, no read-only harness, no strict-mcp. The user chose it, but the
  // workspace must say so out loud once per boot.
  if (agentCommand && knownAgent(agentCommand) === null) {
    console.log(t('workspace.customAgentWarning', { command: agentCommand }))
  }

  // Container cage: probed ONCE at boot (is a runtime there, does its engine
  // answer, can it run the configured agent) and handed to the manager, so
  // every task creation resolves its isolation from the same answer.
  const allowedDomains = config.isolationAllowedDomains ?? DEFAULT_ISOLATION_ALLOWED_DOMAINS
  const probe = await probeIsolation({
    configured: config.isolation ?? 'auto',
    command: agentCommand,
  })

  // The lock must be held BEFORE the manager touches any task store: its boot
  // recovery would mark another live workspace's running tasks as orphans.
  const lock = acquireWorkspaceLock()
  const timeoutMs = (config.timeout ?? DEFAULT_TIMEOUT_S) * 1000
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

    taskManager = (opts.createTaskManagerFn ?? createTaskManager)({
      command: agentCommand,
      timeoutMs,
      // What actually decides a task is dead (D3): silence with no tool out,
      // or one tool that never comes back. `timeoutMs` above is only the last
      // resort under it.
      watchdog: resolveWatchdogBudgets(config),
      isolation: probe,
      allowedDomains,
      ...(config.maxParallelTasks !== undefined ? { maxParallel: config.maxParallelTasks } : {}),
      ...(config.taskRetentionCount !== undefined
        ? { taskRetention: config.taskRetentionCount }
        : {}),
    })

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
              command: agentCommand,
              timeoutMs,
            }),
            mrReviewRunner: createMrReviewRunner({
              cwd: repoRoot,
              session,
              agentCommand,
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

  console.log('')
  console.log(`codesema — ${t('workspace.intro')}`)
  console.log(`  ${started.url}`)
  console.log(`  ${t('review.ctrlc')}`)
  console.log('')
  logIsolation(probe, allowedDomains)
  const inert = maxParallelNotice(config.maxParallelTasks)
  if (inert) {
    console.log(inert)
  }
  console.log('')
  console.log(t('workspace.projects'))
  logProjects(listProjects(), currentProjectId)
  logResumableTasks(taskManager)
  if (opts.open) {
    openBrowser(started.url)
  }
  installShutdownHandlers({ manager: taskManager, stop: started.stop, lock, probe, draining })
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
  logResumedQueues(taskManager.startPending())
  // The listening server keeps the event loop (and therefore the tasks) alive.
}
