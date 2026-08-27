import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentRunOptions } from './agent.js'
import { brainCommand } from './brain-commands.js'
import { readBrainPidfile, writeBrainPidfile } from './brain-pidfile.js'
import { loadGlobalConfig, saveGlobalConfig } from './config.js'
import type { ArmTicket } from './contract.js'
import { t } from './i18n.js'

process.env.NO_COLOR = '1'

type Call = { url: string; init: RequestInit }

function fetchStub(status: number, body: unknown, calls: Call[]): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }) as typeof fetch
}

/** Routes a response per `status` query param, so one stub can answer both the ready and in-flight `listTickets` calls `brainStatus` makes. */
function fetchStubByStatus(
  responsesByStatus: Record<string, { tickets: unknown[] }>,
  calls: Call[],
): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url)
    calls.push({ url: urlStr, init: init ?? {} })
    const status = new URL(urlStr).searchParams.get('status') ?? ''
    const body = responsesByStatus[status] ?? { tickets: [] }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }) as typeof fetch
}

function fetchOffline(): typeof fetch {
  return (() => Promise.reject(new Error('network unreachable'))) as unknown as typeof fetch
}

/** Same pattern as summary.test.ts's own `captureLog`, made async: `brainCommand` resolves its promise after every `console.log` it makes. */
async function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '))
  }
  try {
    await fn()
  } finally {
    console.log = original
  }
  return lines
}

function initRepo(cwd: string, remoteUrl?: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd })
  execFileSync(
    'git',
    [
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'chore: init',
    ],
    { cwd },
  )
  if (remoteUrl) {
    execFileSync('git', ['remote', 'add', 'origin', remoteUrl], { cwd })
  }
}

const VALID_BODY = `**Context**

Some context.

**Goal**

Some goal.

**Scope**

packages/x.

**Acceptance criteria**

- WHEN a THE SYSTEM SHALL b [proof:command bun test]
- WHEN c THE SYSTEM SHALL d [proof:diff packages/x/thing.ts]
- WHEN e THE SYSTEM SHALL f [proof:judgment]

**Out of scope**

Nothing else.`

const validTicket: ArmTicket = {
  id: 't1',
  repo_remote_url: 'https://github.com/o/r.git',
  title: 'Add a thing',
  body: VALID_BODY,
  status: 'published',
  depends_on: null,
  executed_by: null,
  lease_expires_at: null,
  issue: null,
  branch: null,
  mr_iid: null,
  mr_url: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

function fakeRunAgent(output: string): (opts: AgentRunOptions) => Promise<string> {
  return async () => output
}

/** A pid that is certainly dead: a child that already ran to completion. */
function deadPid(): number {
  const child = spawnSync('true')
  expect(child.pid).toBeGreaterThan(0)
  return child.pid
}

/** A single real process with no custom signal handling: dies on the default SIGTERM. */
function spawnAlive(): ChildProcess {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
}

/**
 * A single real process that registers a SIGTERM listener before signalling
 * "ready" on stdout: adding any listener replaces Node's default (fatal)
 * behavior for that signal, so this one survives SIGTERM until SIGKILLed.
 * Resolves only once the handler is actually registered, so the stop-timeout
 * test below can never race a child that has not installed it yet.
 */
function spawnIgnoringSigterm(): Promise<ChildProcess> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [
      '-e',
      'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)',
    ])
    child.stdout?.once('data', () => resolve(child))
  })
}

describe('brainCommand', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string
  let cwd: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-braincmd-cfg-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
    cwd = mkdtempSync(join(tmpdir(), 'codesema-braincmd-repo-'))
  })

  afterEach(() => {
    rmSync(configDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
    if (previousConfigDir === undefined) {
      delete process.env.CODESEMA_CONFIG_DIR
    } else {
      process.env.CODESEMA_CONFIG_DIR = previousConfigDir
    }
  })

  test('no action prints usage and does not throw', async () => {
    await expect(brainCommand({ cwd })).resolves.toBeUndefined()
  })

  test('an unknown action throws', async () => {
    await expect(brainCommand({ action: 'nope', cwd })).rejects.toThrow()
  })

  describe('connect', () => {
    test('requires both --url and --token', async () => {
      await expect(brainCommand({ action: 'connect', cwd, url: 'https://x' })).rejects.toThrow()
      await expect(brainCommand({ action: 'connect', cwd, token: 'csk_a.b' })).rejects.toThrow()
    })

    test('rejects a malformed token', async () => {
      await expect(
        brainCommand({ action: 'connect', cwd, url: 'https://x', token: 'not-a-token' }),
      ).rejects.toThrow()
    })

    test('stores the same credentials shape as `codesema sync`', async () => {
      await brainCommand({
        action: 'connect',
        cwd,
        url: 'https://brain.example',
        token: 'csk_ws1.sec1',
      })
      const config = loadGlobalConfig()
      expect(config.syncUrl).toBe('https://brain.example')
      expect(config.syncWorkspaceId).toBe('ws1')
      expect(config.syncSecret).toBe('sec1')
    })
  })

  describe('disconnect', () => {
    test('is a soft no-op when nothing is connected', async () => {
      await expect(brainCommand({ action: 'disconnect', cwd })).resolves.toBeUndefined()
      expect(loadGlobalConfig().syncUrl).toBeUndefined()
    })

    test('clears syncUrl/syncWorkspaceId/syncSecret, and only those', async () => {
      await brainCommand({
        action: 'connect',
        cwd,
        url: 'https://brain.example',
        token: 'csk_ws1.sec1',
      })
      saveGlobalConfig({ ...loadGlobalConfig(), agent: 'claude -p' })

      await expect(brainCommand({ action: 'disconnect', cwd })).resolves.toBeUndefined()

      const config = loadGlobalConfig()
      expect(config.syncUrl).toBeUndefined()
      expect(config.syncWorkspaceId).toBeUndefined()
      expect(config.syncSecret).toBeUndefined()
      expect(config.agent).toBe('claude -p')
    })

    test('running it twice is fine (idempotent)', async () => {
      await brainCommand({
        action: 'connect',
        cwd,
        url: 'https://brain.example',
        token: 'csk_ws1.sec1',
      })
      await brainCommand({ action: 'disconnect', cwd })
      await expect(brainCommand({ action: 'disconnect', cwd })).resolves.toBeUndefined()
    })
  })

  describe('status', () => {
    test('throws when not connected', async () => {
      await expect(brainCommand({ action: 'status', cwd })).rejects.toThrow()
    })

    test('reports the ready ticket count when connected', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://brain.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd, 'https://github.com/o/r.git')
      const calls: Call[] = []
      await expect(
        brainCommand({
          action: 'status',
          cwd,
          fetchImpl: fetchStub(200, { tickets: [validTicket] }, calls),
        }),
      ).resolves.toBeUndefined()
      expect(calls[0]?.url).toContain('/api/cli/tickets?')
      expect(calls[0]?.url).toContain('status=published')
    })

    test('does not call the brain when the repo has no origin remote', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://brain.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd)
      const calls: Call[] = []
      await brainCommand({ action: 'status', cwd, fetchImpl: fetchStub(200, {}, calls) })
      expect(calls.length).toBe(0)
    })
  })

  describe('status: in flight tickets', () => {
    beforeEach(() => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://brain.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd, 'https://github.com/o/r.git')
    })

    test('lists an in-flight ticket with a fresh heartbeat, no stale marker', async () => {
      const freshTicket = {
        ...validTicket,
        id: 't-if-fresh',
        title: 'Fix the flaky retry test',
        status: 'in_progress',
        executed_by: 'cli-arm-01',
        updated_at: new Date(Date.now() - 12_000).toISOString(),
        lease_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        arm_local_status: 'executing',
      }
      const calls: Call[] = []
      const lines = await captureLog(async () => {
        await brainCommand({
          action: 'status',
          cwd,
          fetchImpl: fetchStubByStatus(
            { published: { tickets: [] }, in_flight: { tickets: [freshTicket] } },
            calls,
          ),
        })
      })
      const inFlightCalls = calls.filter((c) => c.url.includes('status=in_flight'))
      expect(inFlightCalls.length).toBe(1)
      expect(inFlightCalls[0]?.url).toContain('remote_url=')
      const output = lines.join('\n')
      expect(output).toContain('Fix the flaky retry test')
      expect(output).toContain('cli-arm-01')
      expect(output).toContain('executing')
      expect(output).not.toContain(t('brain.fieldStale'))
    })

    test('marks a ticket stale once its lease has lapsed', async () => {
      const staleTicket = {
        ...validTicket,
        id: 't-if-stale',
        title: 'Add retry logic',
        status: 'mr_opened',
        executed_by: 'cli-arm-02',
        updated_at: new Date(Date.now() - 3 * 60_000).toISOString(),
        lease_expires_at: new Date(Date.now() - 60_000).toISOString(),
        arm_local_status: 'awaiting_review',
      }
      const lines = await captureLog(async () => {
        await brainCommand({
          action: 'status',
          cwd,
          fetchImpl: fetchStubByStatus(
            { published: { tickets: [] }, in_flight: { tickets: [staleTicket] } },
            [],
          ),
        })
      })
      const output = lines.join('\n')
      expect(output).toContain('Add retry logic')
      expect(output).toContain(t('brain.fieldStale'))
    })

    test('degrades gracefully when the brain does not send arm_local_status (older brain)', async () => {
      const oldBrainTicket = {
        ...validTicket,
        id: 't-if-old',
        title: 'Legacy ticket from an older brain',
        status: 'in_progress',
        executed_by: null,
        updated_at: new Date(Date.now() - 5_000).toISOString(),
        lease_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        // No `arm_local_status` key at all: what an older brain, built before
        // that field existed, actually sends.
      }
      const lines = await captureLog(async () => {
        await expect(
          brainCommand({
            action: 'status',
            cwd,
            fetchImpl: fetchStubByStatus(
              { published: { tickets: [] }, in_flight: { tickets: [oldBrainTicket] } },
              [],
            ),
          }),
        ).resolves.toBeUndefined()
      })
      const output = lines.join('\n')
      expect(output).toContain('Legacy ticket from an older brain')
      expect(output).toContain(t('brain.fieldUnclaimed'))
      expect(output).not.toContain('undefined')
      expect(output).not.toContain('null')
    })

    test('an unreachable brain degrades the same way the ready count already does', async () => {
      await expect(
        brainCommand({ action: 'status', cwd, fetchImpl: fetchOffline() }),
      ).resolves.toBeUndefined()
    })
  })

  describe('ticket', () => {
    test('rejects both --issue and --title/--prompt together', async () => {
      await expect(
        brainCommand({ action: 'ticket', cwd, issue: '1', title: 'T', prompt: 'p' }),
      ).rejects.toThrow()
    })

    test('rejects neither form given', async () => {
      await expect(brainCommand({ action: 'ticket', cwd })).rejects.toThrow()
    })

    test('rejects a non-numeric --issue', async () => {
      await expect(brainCommand({ action: 'ticket', cwd, issue: 'abc' })).rejects.toThrow()
    })

    test('drafts and publishes from --title/--prompt', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://brain.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd, 'https://github.com/o/r.git')
      const calls: Call[] = []
      await expect(
        brainCommand({
          action: 'ticket',
          cwd,
          title: 'Add a thing',
          prompt: 'do the thing',
          runAgentFn: fakeRunAgent(VALID_BODY),
          fetchImpl: fetchStub(201, { ticket: validTicket }, calls),
        }),
      ).resolves.toBeUndefined()
      expect(calls[0]?.url).toBe('https://brain.example/api/cli/tickets')
    })

    test('a drafting failure surfaces as a thrown error', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://brain.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd, 'https://github.com/o/r.git')
      await expect(
        brainCommand({
          action: 'ticket',
          cwd,
          title: 'T',
          prompt: 'x',
          runAgentFn: fakeRunAgent('not a ticket'),
        }),
      ).rejects.toThrow()
    })
  })

  describe('status: daemon rows (D21)', () => {
    beforeEach(() => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://brain.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
    })

    test('no pidfile: does not throw (reported as not running)', async () => {
      initRepo(cwd, 'https://github.com/o/r.git')
      await expect(
        brainCommand({ action: 'status', cwd, fetchImpl: fetchStub(200, { tickets: [] }, []) }),
      ).resolves.toBeUndefined()
    })

    test('a pidfile naming our own (very much alive) pid: does not throw, cleans up nothing', async () => {
      initRepo(cwd, 'https://github.com/o/r.git')
      writeBrainPidfile(cwd, process.pid, 4400)
      await expect(
        brainCommand({ action: 'status', cwd, fetchImpl: fetchStub(200, { tickets: [] }, []) }),
      ).resolves.toBeUndefined()
      expect(readBrainPidfile(cwd)).toMatchObject({ pid: process.pid, port: 4400 })
    })

    test('a pidfile naming a dead (stolen) pid: does not throw, and the stale file is removed', async () => {
      initRepo(cwd, 'https://github.com/o/r.git')
      writeBrainPidfile(cwd, deadPid(), 4400)
      await expect(
        brainCommand({ action: 'status', cwd, fetchImpl: fetchStub(200, { tickets: [] }, []) }),
      ).resolves.toBeUndefined()
      expect(readBrainPidfile(cwd)).toBeNull()
    })
  })

  describe('serve --detach', () => {
    test('spawns a detached re-invocation of `brain serve` (no --detach) and reports pid + log path', async () => {
      const calls: { command: string; args: readonly string[]; options: SpawnOptions }[] = []
      const unrefCalls: number[] = []
      const spawnFn = (command: string, args: readonly string[], options: SpawnOptions) => {
        calls.push({ command, args, options })
        return {
          pid: 4242,
          unref: () => {
            unrefCalls.push(1)
          },
          on: () => {},
        } as unknown as ChildProcess
      }

      await expect(
        brainCommand({ action: 'serve', cwd, detach: true, spawnFn }),
      ).resolves.toBeUndefined()

      const call = calls[0]
      if (!call) {
        throw new Error('expected spawnFn to have been called')
      }
      expect(call.command).toBe(process.execPath)
      expect(call.args).toEqual([process.argv[1] as string, 'brain', 'serve'])
      expect(call.options.cwd).toBe(cwd)
      expect(call.options.detached).toBe(true)
      expect(unrefCalls.length).toBe(1)
      expect(existsSync(join(cwd, '.codesema', 'brain-daemon.log'))).toBe(true)
    })

    test('a spawn that never yields a pid throws (D21 never silently reports success)', async () => {
      const spawnFn = () =>
        ({ pid: undefined, unref: () => {}, on: () => {} }) as unknown as ChildProcess
      await expect(brainCommand({ action: 'serve', cwd, detach: true, spawnFn })).rejects.toThrow()
    })
  })

  describe('stop', () => {
    test('no pidfile: resolves without throwing (nothing to stop)', async () => {
      await expect(brainCommand({ action: 'stop', cwd })).resolves.toBeUndefined()
    })

    test('a pidfile naming a dead pid: resolves without throwing, and the stale file is cleaned up', async () => {
      writeBrainPidfile(cwd, deadPid(), 4400)
      await expect(brainCommand({ action: 'stop', cwd })).resolves.toBeUndefined()
      expect(readBrainPidfile(cwd)).toBeNull()
    })

    test('a live process: SIGTERM kills it, stop waits for it, then cleans up the pidfile', async () => {
      const child = spawnAlive()
      const pid = child.pid
      if (pid === undefined) {
        throw new Error('expected a real pid')
      }
      writeBrainPidfile(cwd, pid, 4400)
      try {
        await expect(
          brainCommand({ action: 'stop', cwd, stopTimeoutMs: 5000, stopPollIntervalMs: 20 }),
        ).resolves.toBeUndefined()
        expect(readBrainPidfile(cwd)).toBeNull()
      } finally {
        child.kill('SIGKILL')
      }
    })

    test('a live process that ignores SIGTERM: reports the timeout, never hangs, pidfile is left in place', async () => {
      const child = await spawnIgnoringSigterm()
      const pid = child.pid
      if (pid === undefined) {
        throw new Error('expected a real pid')
      }
      writeBrainPidfile(cwd, pid, 4400)
      try {
        await expect(
          brainCommand({ action: 'stop', cwd, stopTimeoutMs: 300, stopPollIntervalMs: 20 }),
        ).resolves.toBeUndefined()
        expect(readBrainPidfile(cwd)).toMatchObject({ pid })
      } finally {
        child.kill('SIGKILL')
      }
    })
  })

  describe('install-service / uninstall-service', () => {
    const previousXdg = process.env.XDG_CONFIG_HOME
    let xdgConfigHome: string

    function noopExecFn(calls: { command: string; args: readonly string[] }[]) {
      return (command: string, args: readonly string[]) => {
        calls.push({ command, args })
        return ''
      }
    }

    function unitPath(): string {
      return join(xdgConfigHome, 'systemd', 'user', 'codesema-brain.service')
    }

    beforeEach(() => {
      xdgConfigHome = mkdtempSync(join(tmpdir(), 'codesema-braincmd-xdg-'))
      process.env.XDG_CONFIG_HOME = xdgConfigHome
    })

    afterEach(() => {
      rmSync(xdgConfigHome, { recursive: true, force: true })
      if (previousXdg === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = previousXdg
      }
    })

    test('install-service refuses to run outside a git repository', async () => {
      await expect(
        brainCommand({ action: 'install-service', cwd, execFn: noopExecFn([]) }),
      ).rejects.toThrow()
      expect(existsSync(unitPath())).toBe(false)
    })

    test('install-service writes the unit pinned to the resolved repo root', async () => {
      initRepo(cwd)
      const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd,
        encoding: 'utf8',
      }).trim()
      const calls: { command: string; args: readonly string[] }[] = []

      await expect(
        brainCommand({ action: 'install-service', cwd, execFn: noopExecFn(calls) }),
      ).resolves.toBeUndefined()

      expect(existsSync(unitPath())).toBe(true)
      const unit = readFileSync(unitPath(), 'utf8')
      expect(unit).toContain(`WorkingDirectory=${repoRoot}`)
      expect(calls.map((c) => c.args.join(' '))).toContain(
        '--user enable --now codesema-brain.service',
      )
    })

    test('install-service surfaces a clear error when systemctl is absent, and writes nothing', async () => {
      initRepo(cwd)
      const execFn = (command: string) => {
        if (command === 'systemctl') {
          throw Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' })
        }
        return ''
      }
      await expect(brainCommand({ action: 'install-service', cwd, execFn })).rejects.toThrow(
        t('brain.systemctlNotFound'),
      )
      expect(existsSync(unitPath())).toBe(false)
    })

    test('uninstall-service is a soft no-op when nothing is installed', async () => {
      await expect(
        brainCommand({ action: 'uninstall-service', cwd, execFn: noopExecFn([]) }),
      ).resolves.toBeUndefined()
    })

    test('uninstall-service removes a previously installed unit', async () => {
      initRepo(cwd)
      await brainCommand({ action: 'install-service', cwd, execFn: noopExecFn([]) })
      expect(existsSync(unitPath())).toBe(true)

      await expect(
        brainCommand({ action: 'uninstall-service', cwd, execFn: noopExecFn([]) }),
      ).resolves.toBeUndefined()
      expect(existsSync(unitPath())).toBe(false)
    })
  })
})
