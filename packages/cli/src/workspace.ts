// `codesema workspace`: starts the local agentic workspace server — the web
// UI where tasks are given in natural language and run in parallel worktrees.
// Multi-project: one process drives every repo registered in the global
// project registry (projects.ts). Launched from inside a git repo, that repo
// is auto-registered and becomes the current project; launched outside any
// repo, the workspace opens on the existing registry (possibly empty — add
// projects from the UI). The process stays in the foreground: tasks live as
// long as it runs (no detached daemon, decision n°4 of the plan). The first
// Ctrl-C shuts down gracefully (agents SIGTERMed, tasks persisted
// 'interrupted', worktrees kept — the next boot offers them back, and one
// click on Resume in the UI restarts the turn that died; nothing ever
// restarts on its own); a second Ctrl-C during that drain force-quits. A GLOBAL
// <globalConfigDir()>/workspace.lock prevents a second workspace process from
// racing this one's registry and task stores.

import { knownAgent } from './agent.js'
import { isRepoAgentTrusted, loadConfig, loadRepoConfig } from './config.js'
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
import { createTaskManager, type TaskManager } from './task-server.js'
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
 * Tasks a previous shutdown/crash left mid-turn: surface them at boot, all
 * projects. NOTHING re-enqueues them — restarting agents that write code and
 * commit, unattended, on a plain `codesema workspace` boot would be intrusive
 * and would burn tokens on work nobody asked for. The offer is explicit
 * instead: this line, and the "needs you" section of the web UI where one
 * click on Resume restarts the very turn that died (the resumed provider
 * session when the record kept one, the transcript replay otherwise).
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
 * Graceful shutdown: the first signal drains (agents SIGTERMed, 'interrupted'
 * persisted with {reason:'shutdown'}, worktrees KEPT for resume), a second
 * signal force-quits — the classic double Ctrl-C escape hatch when an agent
 * ignores its SIGTERM. 130 = 128 + SIGINT, the conventional exit code.
 */
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

function installShutdownHandlers(
  manager: TaskManager,
  stop: () => Promise<void>,
  lock: WorkspaceLockHandle,
  probe: IsolationProbe,
): void {
  let shuttingDown = false
  const shutdown = (): void => {
    if (shuttingDown) {
      process.exit(130)
    }
    shuttingDown = true
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
function resolveAgentCommand(
  cwd: string,
  repoRoot: string | null,
  configured: string | undefined,
): string {
  const [detected] = detectAgents(cwd)
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

export async function workspace(opts: {
  port?: number | undefined
  open: boolean
  cwd: string
}): Promise<void> {
  // Launchable from anywhere: a repo auto-registers and becomes the current
  // project, a plain directory opens the workspace on the registry as-is.
  const repoRoot = tryGit(['rev-parse', '--show-toplevel'], opts.cwd)
  const config = loadConfig(repoRoot)
  const agentCommand = resolveAgentCommand(opts.cwd, repoRoot, config.agent)
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

    taskManager = createTaskManager({
      command: agentCommand,
      timeoutMs,
      isolation: probe,
      allowedDomains,
      ...(config.maxParallelTasks !== undefined ? { maxParallel: config.maxParallelTasks } : {}),
    })

    // The review surface (fix, MR review) stays available from the same server
    // when launched inside a repo: the workspace extends the product, it does
    // not replace the review API. Outside a repo those runners have no target.
    const session = createSession()
    started = await startServer(session, {
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
  console.log('')
  console.log(t('workspace.projects'))
  logProjects(listProjects(), currentProjectId)
  logResumableTasks(taskManager)
  if (opts.open) {
    openBrowser(started.url)
  }
  installShutdownHandlers(taskManager, started.stop, lock, probe)
  // The listening server keeps the event loop (and therefore the tasks) alive.
}
