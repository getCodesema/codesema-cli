// T1.9 review round 4, MAJEUR 4: the boot WIRING of the two unattended
// housekeeping passes, and of the one config key that feeds them.
//
// `workspace()` is the only place `taskManager.sweepOrphanedVolumes()` and
// `taskManager.applyRetention()` are ever called, and the only place
// `taskRetentionCount` travels from the config to the manager. Both facts
// were structurally unobservable: deleting either `void …()` line, or the
// `taskRetention` mapping, left the entire suite green — the whole feature
// could be unplugged at boot, and `taskRetentionCount` made inert, with
// nothing going red. That is §6 quater's "ticked box that renders nothing",
// on the CLI side: tasks.md promises "at boot … list the volumes" and "read
// at boot with the rest of the config".
//
// Hermetic by INJECTION, not by configuration. Both hermeticity claims this
// header used to make were false, and the CI runner is where that showed:
//
//   * `isolation: 'policy'` does NOT keep the boot off the container runtime.
//     The boot probes with a hardcoded `configured: 'auto'` (workspace.ts), on
//     purpose — the boot line must be able to say a cage is AVAILABLE even
//     when this repo declines it. So the probe ran, and on a machine with no
//     docker/podman it is the slowest thing in the boot.
//   * a configured `agent` did NOT skip the binary probes. `detectAgents`
//     only ever feeds the FALLBACK, but it was awaited unconditionally —
//     `<bin> --version` for every known agent, under one shared 8s window,
//     its answer then discarded.
//
// Together they cost ~1s per boot on a developer machine and enough on a CI
// runner (no runtime, no agent binary) to blow this file's 5s-per-test budget.
// Both are now injected, so this suite reaches neither. The project registry
// lives in a per-test CODESEMA_CONFIG_DIR, and the manager and the HTTP server
// were already injected — no port is bound, no container is reached, no agent
// is spawned.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { saveGlobalConfig } from './config.js'
import type { LiveSession } from './serve.js'
import type { IsolationProbe } from './task-isolation.js'
import { createTaskManager, type CreateTaskManagerOptions } from './task-server.js'
import { AGENT_DEFS, type AgentDef } from './wizard.js'
import { workspace } from './workspace.js'

/** What the injected runtime probe answers: no cage, no runtime touched. */
const NO_RUNTIME: IsolationProbe = {
  available: false,
  mode: 'policy',
  reason: 'no container runtime was probed in this test',
  configured: 'auto',
  runtime: null,
}

const cleanups: string[] = []
const previousConfigDir = process.env.CODESEMA_CONFIG_DIR

beforeEach(() => {
  const configDir = mkdtempSync(join(tmpdir(), 'codesema-workspace-boot-cfg-'))
  cleanups.push(configDir)
  process.env.CODESEMA_CONFIG_DIR = configDir
})

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  if (previousConfigDir === undefined) {
    delete process.env.CODESEMA_CONFIG_DIR
  } else {
    process.env.CODESEMA_CONFIG_DIR = previousConfigDir
  }
})

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'codesema-workspace-boot-'))
  cleanups.push(repo)
  const run = (args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: repo,
      stdio: 'ignore',
    })
  }
  run(['init', '-b', 'main'])
  run(['commit', '--allow-empty', '-m', 'init'])
  return repo
}

type Boot = {
  /** Options the manager was actually built with. */
  managerOptions: CreateTaskManagerOptions
  /** Housekeeping passes the boot invoked, in the order it invoked them. */
  passes: string[]
  /** Whether the server was asked to start at all (it never binds here). */
  served: boolean
  /** Whether the boot asked the (injected) container-runtime probe at all. */
  probed: boolean
  /** Whether the boot asked the (injected) agent-binary probe at all. */
  detected: boolean
}

/**
 * One real `workspace()` boot, with the manager wrapped rather than faked:
 * everything else the boot reads off it (listAll for the resumable banner,
 * startPending for the queues) stays the genuine implementation, so this
 * cannot pass against a manager that does not really work.
 */
async function boot(cwd: string, agents: AgentDef[] = []): Promise<Boot> {
  const passes: string[] = []
  let managerOptions: CreateTaskManagerOptions | null = null
  let served = false
  let probed = false
  let detected = false
  // installShutdownHandlers registers process-wide SIGINT/SIGTERM listeners;
  // a test must not leave them behind for the rest of the file.
  const beforeSigint = process.listeners('SIGINT')
  const beforeSigterm = process.listeners('SIGTERM')
  const log = console.log
  console.log = () => {}
  try {
    await workspace({
      cwd,
      open: false,
      probeIsolationFn: () => {
        probed = true
        return Promise.resolve(NO_RUNTIME)
      },
      detectAgentsFn: () => {
        detected = true
        return Promise.resolve(agents)
      },
      createTaskManagerFn: (options) => {
        managerOptions = options
        const real = createTaskManager(options)
        return {
          ...real,
          sweepOrphanedVolumes: () => {
            passes.push('sweep')
            return Promise.resolve()
          },
          applyRetention: () => {
            passes.push('retention')
            return Promise.resolve()
          },
        }
      },
      startServerFn: (_session: LiveSession) => {
        served = true
        return Promise.resolve({
          url: 'http://127.0.0.1:0',
          port: 0,
          stop: () => Promise.resolve(),
        })
      },
    })
  } finally {
    console.log = log
    for (const listener of process.listeners('SIGINT')) {
      if (!beforeSigint.includes(listener)) {
        process.off('SIGINT', listener)
      }
    }
    for (const listener of process.listeners('SIGTERM')) {
      if (!beforeSigterm.includes(listener)) {
        process.off('SIGTERM', listener)
      }
    }
  }
  if (!managerOptions) {
    throw new Error('the boot never built a task manager')
  }
  return { managerOptions, passes, served, probed, detected }
}

describe('workspace() boot housekeeping', () => {
  test('the boot runs BOTH T1.9 passes: the orphaned-volume sweep and the retention purge', async () => {
    saveGlobalConfig({ agent: 'claude', isolation: 'policy' })

    const outcome = await boot(makeRepo())

    expect(outcome.served).toBe(true)
    expect(outcome.passes).toContain('sweep')
    expect(outcome.passes).toContain('retention')
  })

  test('taskRetentionCount reaches the manager as its retention window — the config key is not inert', async () => {
    saveGlobalConfig({ agent: 'claude', isolation: 'policy', taskRetentionCount: 7 })

    const outcome = await boot(makeRepo())

    expect(outcome.managerOptions.taskRetention).toBe(7)
  })

  // 0 is the value that separates "the key was read" from "some number was
  // passed": it is a legitimate deliberate choice (config.ts pins that), and
  // it is also falsy, so any `||`-shaped wiring silently turns it into the
  // default of 20 — a purge window twenty tasks wider than the one asked for.
  test('taskRetentionCount: 0 reaches the manager as 0, never as the default', async () => {
    saveGlobalConfig({ agent: 'claude', isolation: 'policy', taskRetentionCount: 0 })

    const outcome = await boot(makeRepo())

    expect(outcome.managerOptions.taskRetention).toBe(0)
  })

  test('an unconfigured taskRetentionCount is passed as absent, so the manager applies its own default', async () => {
    saveGlobalConfig({ agent: 'claude', isolation: 'policy' })

    const outcome = await boot(makeRepo())

    expect(outcome.managerOptions.taskRetention).toBeUndefined()
  })

  // The two seams below are what makes this file hermetic. Each is asserted
  // rather than assumed: drop the seam from workspace() and the boot reaches
  // the real probe, which is exactly the ~1s-per-boot this suite must not pay.
  test('the runtime probe is the injected one — a policy config does NOT keep the boot off it', async () => {
    saveGlobalConfig({ agent: 'claude', isolation: 'policy' })

    const outcome = await boot(makeRepo())

    expect(outcome.probed).toBe(true)
  })

  test('a configured agent skips the binary probes entirely', async () => {
    saveGlobalConfig({ agent: 'claude', isolation: 'policy' })

    const outcome = await boot(makeRepo())

    expect(outcome.detected).toBe(false)
  })

  // The mirror image, and the reason the skip above is a skip and not a
  // deletion: with nothing configured, detection is the ONLY source of an
  // agent command, and a boot without one throws rather than serving.
  test('an unconfigured agent still falls back to detection', async () => {
    saveGlobalConfig({ isolation: 'policy' })

    const outcome = await boot(makeRepo(), [AGENT_DEFS[0] as AgentDef])

    expect(outcome.detected).toBe(true)
    expect(outcome.served).toBe(true)
  })
})
