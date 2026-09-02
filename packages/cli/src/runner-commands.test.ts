import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentRunOptions } from './agent.js'
import { loadGlobalConfig, saveGlobalConfig } from './config.js'
import { RUNBOOK_VERSION, type ArmTicket, type RunnerListEntry } from './contract.js'
import { t } from './i18n.js'
import type { RunbookScanOutcome } from './runbook-runner.js'
import { RUNBOOK_FILE } from './runbook-setup.js'
import { runbookCommand, runnerCommand } from './runner-commands.js'
import { loadOrCreateRunnerIdentity } from './runner-identity.js'
import { readRunnerPidfile, writeRunnerPidfile } from './runner-pidfile.js'
import {
  formatFingerprint,
  generateRunnerKeyPair,
  runnerKeyFingerprint,
  seal,
  unseal,
} from './sealed-box.js'

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

/** Routes a response per `status` query param, so one stub can answer both the ready and in-flight `listTickets` calls `runnerStatus` makes. */
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

/** One canned response per call, in order; the last entry repeats once exhausted (a poll loop's Nth+ call). */
function fetchSequence(
  responses: { status: number; body: unknown }[],
  calls: Call[],
): typeof fetch {
  let i = 0
  return ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} })
    const resp = responses[Math.min(i, responses.length - 1)]
    i++
    return Promise.resolve(
      new Response(JSON.stringify(resp?.body ?? {}), {
        status: resp?.status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }) as typeof fetch
}

/** Same pattern as summary.test.ts's own `captureLog`, made async: `runnerCommand` resolves its promise after every `console.log` it makes. */
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

/** Same as `captureLog`, for the STDERR-only progress/warning lines `await-secrets` prints. */
async function captureErr(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => {
    lines.push(args.join(' '))
  }
  try {
    await fn()
  } finally {
    console.error = original
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

/** A real keypair behind every fake runner entry, so the security recompute in `resolveTargetRunner` genuinely matches unless a test deliberately overrides `fingerprint`. */
function fakeRunnerEntry(overrides: Partial<RunnerListEntry> = {}): RunnerListEntry {
  const { publicKey } = generateRunnerKeyPair()
  return {
    name: 'build-box-1',
    fingerprint: runnerKeyFingerprint(publicKey),
    public_key: publicKey.toString('base64'),
    last_seen_at: new Date().toISOString(),
    has_pending_secret: false,
    ...overrides,
  }
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

describe('runnerCommand', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string
  let cwd: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-runnercmd-cfg-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
    cwd = mkdtempSync(join(tmpdir(), 'codesema-runnercmd-repo-'))
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
    await expect(runnerCommand({ cwd })).resolves.toBeUndefined()
  })

  test('an unknown action throws', async () => {
    await expect(runnerCommand({ action: 'nope', cwd })).rejects.toThrow()
  })

  describe('connect', () => {
    test('requires both --url and --token', async () => {
      await expect(runnerCommand({ action: 'connect', cwd, url: 'https://x' })).rejects.toThrow()
      await expect(runnerCommand({ action: 'connect', cwd, token: 'csk_a.b' })).rejects.toThrow()
    })

    test('rejects a malformed token', async () => {
      await expect(
        runnerCommand({ action: 'connect', cwd, url: 'https://x', token: 'not-a-token' }),
      ).rejects.toThrow()
    })

    test('stores the same credentials shape as `codesema sync`', async () => {
      await runnerCommand({
        action: 'connect',
        cwd,
        url: 'https://hub.example',
        token: 'csk_ws1.sec1',
      })
      const config = loadGlobalConfig()
      expect(config.syncUrl).toBe('https://hub.example')
      expect(config.syncWorkspaceId).toBe('ws1')
      expect(config.syncSecret).toBe('sec1')
    })
  })

  describe('connect: runner identity', () => {
    test('the fingerprint shown is stable across reconnects (keygen happens once)', async () => {
      const first = await captureLog(() =>
        runnerCommand({
          action: 'connect',
          cwd,
          url: 'https://hub.example',
          token: 'csk_ws1.sec1',
          fetchImpl: fetchStub(200, {}, []),
        }),
      )
      const second = await captureLog(() =>
        runnerCommand({
          action: 'connect',
          cwd,
          url: 'https://hub.example',
          token: 'csk_ws1.sec1',
          fetchImpl: fetchStub(200, {}, []),
        }),
      )
      const fingerprintLine = (lines: string[]) =>
        lines.find((line) => line.includes(t('runner.fieldFingerprint')))
      expect(fingerprintLine(first)).toBeDefined()
      expect(fingerprintLine(first)).toBe(fingerprintLine(second))
    })

    test('a key-registration failure warns but does not throw, and credentials are still saved', async () => {
      const lines = await captureLog(async () => {
        await expect(
          runnerCommand({
            action: 'connect',
            cwd,
            url: 'https://hub.example',
            token: 'csk_ws1.sec1',
            fetchImpl: fetchOffline(),
          }),
        ).resolves.toBeUndefined()
      })
      expect(loadGlobalConfig().syncUrl).toBe('https://hub.example')
      expect(lines.some((line) => line.includes(t('runner.fieldFingerprint')))).toBe(true)
    })
  })

  describe('disconnect', () => {
    test('is a soft no-op when nothing is connected', async () => {
      await expect(runnerCommand({ action: 'disconnect', cwd })).resolves.toBeUndefined()
      expect(loadGlobalConfig().syncUrl).toBeUndefined()
    })

    test('clears syncUrl/syncWorkspaceId/syncSecret, and only those', async () => {
      await runnerCommand({
        action: 'connect',
        cwd,
        url: 'https://hub.example',
        token: 'csk_ws1.sec1',
      })
      saveGlobalConfig({ ...loadGlobalConfig(), agent: 'claude -p' })

      await expect(runnerCommand({ action: 'disconnect', cwd })).resolves.toBeUndefined()

      const config = loadGlobalConfig()
      expect(config.syncUrl).toBeUndefined()
      expect(config.syncWorkspaceId).toBeUndefined()
      expect(config.syncSecret).toBeUndefined()
      expect(config.agent).toBe('claude -p')
    })

    test('running it twice is fine (idempotent)', async () => {
      await runnerCommand({
        action: 'connect',
        cwd,
        url: 'https://hub.example',
        token: 'csk_ws1.sec1',
      })
      await runnerCommand({ action: 'disconnect', cwd })
      await expect(runnerCommand({ action: 'disconnect', cwd })).resolves.toBeUndefined()
    })
  })

  describe('status', () => {
    test('throws when not connected', async () => {
      await expect(runnerCommand({ action: 'status', cwd })).rejects.toThrow()
    })

    test('reports the ready ticket count when connected', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://hub.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd, 'https://github.com/o/r.git')
      const calls: Call[] = []
      await expect(
        runnerCommand({
          action: 'status',
          cwd,
          fetchImpl: fetchStub(200, { tickets: [validTicket] }, calls),
        }),
      ).resolves.toBeUndefined()
      expect(calls[0]?.url).toContain('/api/cli/tickets?')
      expect(calls[0]?.url).toContain('status=published')
    })

    test('does not call the hub when the repo has no origin remote', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://hub.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd)
      const calls: Call[] = []
      await runnerCommand({ action: 'status', cwd, fetchImpl: fetchStub(200, {}, calls) })
      expect(calls.length).toBe(0)
    })
  })

  describe('status: in flight tickets', () => {
    beforeEach(() => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://hub.example',
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
        await runnerCommand({
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
      expect(output).not.toContain(t('runner.fieldStale'))
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
        await runnerCommand({
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
      expect(output).toContain(t('runner.fieldStale'))
    })

    test('degrades gracefully when the hub does not send arm_local_status (older hub)', async () => {
      const oldHubTicket = {
        ...validTicket,
        id: 't-if-old',
        title: 'Legacy ticket from an older hub',
        status: 'in_progress',
        executed_by: null,
        updated_at: new Date(Date.now() - 5_000).toISOString(),
        lease_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        // No `arm_local_status` key at all: what an older hub, built before
        // that field existed, actually sends.
      }
      const lines = await captureLog(async () => {
        await expect(
          runnerCommand({
            action: 'status',
            cwd,
            fetchImpl: fetchStubByStatus(
              { published: { tickets: [] }, in_flight: { tickets: [oldHubTicket] } },
              [],
            ),
          }),
        ).resolves.toBeUndefined()
      })
      const output = lines.join('\n')
      expect(output).toContain('Legacy ticket from an older hub')
      expect(output).toContain(t('runner.fieldUnclaimed'))
      expect(output).not.toContain('undefined')
      expect(output).not.toContain('null')
    })

    test('an unreachable hub degrades the same way the ready count already does', async () => {
      await expect(
        runnerCommand({ action: 'status', cwd, fetchImpl: fetchOffline() }),
      ).resolves.toBeUndefined()
    })
  })

  describe('ticket', () => {
    test('rejects both --issue and --title/--prompt together', async () => {
      await expect(
        runnerCommand({ action: 'ticket', cwd, issue: '1', title: 'T', prompt: 'p' }),
      ).rejects.toThrow()
    })

    test('rejects neither form given', async () => {
      await expect(runnerCommand({ action: 'ticket', cwd })).rejects.toThrow()
    })

    test('rejects a non-numeric --issue', async () => {
      await expect(runnerCommand({ action: 'ticket', cwd, issue: 'abc' })).rejects.toThrow()
    })

    test('drafts and publishes from --title/--prompt', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://hub.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd, 'https://github.com/o/r.git')
      const calls: Call[] = []
      await expect(
        runnerCommand({
          action: 'ticket',
          cwd,
          title: 'Add a thing',
          prompt: 'do the thing',
          runAgentFn: fakeRunAgent(VALID_BODY),
          fetchImpl: fetchStub(201, { ticket: validTicket }, calls),
        }),
      ).resolves.toBeUndefined()
      expect(calls[0]?.url).toBe('https://hub.example/api/cli/tickets')
    })

    test('a drafting failure surfaces as a thrown error', async () => {
      saveGlobalConfig({
        ...loadGlobalConfig(),
        syncUrl: 'https://hub.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
      initRepo(cwd, 'https://github.com/o/r.git')
      await expect(
        runnerCommand({
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
        syncUrl: 'https://hub.example',
        syncWorkspaceId: 'ws1',
        syncSecret: 'sec1',
      })
    })

    test('no pidfile: does not throw (reported as not running)', async () => {
      initRepo(cwd, 'https://github.com/o/r.git')
      await expect(
        runnerCommand({ action: 'status', cwd, fetchImpl: fetchStub(200, { tickets: [] }, []) }),
      ).resolves.toBeUndefined()
    })

    test('a pidfile naming our own (very much alive) pid: does not throw, cleans up nothing', async () => {
      initRepo(cwd, 'https://github.com/o/r.git')
      writeRunnerPidfile(cwd, process.pid, 4400)
      await expect(
        runnerCommand({ action: 'status', cwd, fetchImpl: fetchStub(200, { tickets: [] }, []) }),
      ).resolves.toBeUndefined()
      expect(readRunnerPidfile(cwd)).toMatchObject({ pid: process.pid, port: 4400 })
    })

    test('a pidfile naming a dead (stolen) pid: does not throw, and the stale file is removed', async () => {
      initRepo(cwd, 'https://github.com/o/r.git')
      writeRunnerPidfile(cwd, deadPid(), 4400)
      await expect(
        runnerCommand({ action: 'status', cwd, fetchImpl: fetchStub(200, { tickets: [] }, []) }),
      ).resolves.toBeUndefined()
      expect(readRunnerPidfile(cwd)).toBeNull()
    })
  })

  describe('serve --detach', () => {
    test('spawns a detached re-invocation of `runner serve` (no --detach) and reports pid + log path', async () => {
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
        runnerCommand({ action: 'serve', cwd, detach: true, spawnFn }),
      ).resolves.toBeUndefined()

      const call = calls[0]
      if (!call) {
        throw new Error('expected spawnFn to have been called')
      }
      expect(call.command).toBe(process.execPath)
      expect(call.args).toEqual([process.argv[1] as string, 'runner', 'serve'])
      expect(call.options.cwd).toBe(cwd)
      expect(call.options.detached).toBe(true)
      expect(unrefCalls.length).toBe(1)
      expect(existsSync(join(cwd, '.codesema', 'runner-daemon.log'))).toBe(true)
    })

    test('a spawn that never yields a pid throws (D21 never silently reports success)', async () => {
      const spawnFn = () =>
        ({ pid: undefined, unref: () => {}, on: () => {} }) as unknown as ChildProcess
      await expect(runnerCommand({ action: 'serve', cwd, detach: true, spawnFn })).rejects.toThrow()
    })
  })

  describe('stop', () => {
    test('no pidfile: resolves without throwing (nothing to stop)', async () => {
      await expect(runnerCommand({ action: 'stop', cwd })).resolves.toBeUndefined()
    })

    test('a pidfile naming a dead pid: resolves without throwing, and the stale file is cleaned up', async () => {
      writeRunnerPidfile(cwd, deadPid(), 4400)
      await expect(runnerCommand({ action: 'stop', cwd })).resolves.toBeUndefined()
      expect(readRunnerPidfile(cwd)).toBeNull()
    })

    test('a live process: SIGTERM kills it, stop waits for it, then cleans up the pidfile', async () => {
      const child = spawnAlive()
      const pid = child.pid
      if (pid === undefined) {
        throw new Error('expected a real pid')
      }
      writeRunnerPidfile(cwd, pid, 4400)
      try {
        await expect(
          runnerCommand({ action: 'stop', cwd, stopTimeoutMs: 5000, stopPollIntervalMs: 20 }),
        ).resolves.toBeUndefined()
        expect(readRunnerPidfile(cwd)).toBeNull()
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
      writeRunnerPidfile(cwd, pid, 4400)
      try {
        await expect(
          runnerCommand({ action: 'stop', cwd, stopTimeoutMs: 300, stopPollIntervalMs: 20 }),
        ).resolves.toBeUndefined()
        expect(readRunnerPidfile(cwd)).toMatchObject({ pid })
      } finally {
        child.kill('SIGKILL')
      }
    })
  })

  describe('list', () => {
    test('throws when not connected', async () => {
      await expect(runnerCommand({ action: 'list', cwd })).rejects.toThrow()
    })

    describe('connected', () => {
      beforeEach(() => {
        saveGlobalConfig({
          ...loadGlobalConfig(),
          syncUrl: 'https://hub.example',
          syncWorkspaceId: 'ws1',
          syncSecret: 'sec1',
        })
      })

      test('shows a dedicated empty state', async () => {
        const lines = await captureLog(() =>
          runnerCommand({ action: 'list', cwd, fetchImpl: fetchStub(200, { runners: [] }, []) }),
        )
        expect(lines.join('\n')).toContain(t('runner.listEmpty'))
      })

      test('lists the name, the full formatted fingerprint, heartbeat age and a pending-secret marker', async () => {
        const entry = fakeRunnerEntry({
          name: 'build-box-1',
          last_seen_at: new Date(Date.now() - 5000).toISOString(),
          has_pending_secret: true,
        })
        const lines = await captureLog(() =>
          runnerCommand({
            action: 'list',
            cwd,
            fetchImpl: fetchStub(200, { runners: [entry] }, []),
          }),
        )
        const output = lines.join('\n')
        expect(output).toContain('build-box-1')
        expect(output).toContain(formatFingerprint(entry.fingerprint))
        expect(output).toContain(t('runner.fieldPendingSecret'))
      })

      test('a runner with no pending secret does not show the pending-secret marker', async () => {
        const entry = fakeRunnerEntry({ has_pending_secret: false })
        const lines = await captureLog(() =>
          runnerCommand({
            action: 'list',
            cwd,
            fetchImpl: fetchStub(200, { runners: [entry] }, []),
          }),
        )
        expect(lines.join('\n')).not.toContain(t('runner.fieldPendingSecret'))
      })

      test('surfaces a clean error on a hub failure instead of throwing raw', async () => {
        await expect(
          runnerCommand({ action: 'list', cwd, fetchImpl: fetchOffline() }),
        ).rejects.toThrow()
      })
    })
  })

  describe('autoconfig', () => {
    test('throws when not connected', async () => {
      await expect(
        runnerCommand({ action: 'autoconfig', cwd, runInheritedFn: () => {} }),
      ).rejects.toThrow()
    })

    describe('connected, non-interactive (no TTY in this test environment)', () => {
      beforeEach(() => {
        saveGlobalConfig({
          ...loadGlobalConfig(),
          syncUrl: 'https://hub.example',
          syncWorkspaceId: 'ws1',
          syncSecret: 'sec1',
        })
      })

      test('without --fingerprint or a token flag, refuses immediately and lists what is missing', async () => {
        await expect(
          runnerCommand({ action: 'autoconfig', cwd, runInheritedFn: () => {} }),
        ).rejects.toThrow(
          t('runner.autoconfigMissingFlags', {
            flags: '--fingerprint <fingerprint>, --gh-token-from-gh and/or --claude-token <token>',
          }),
        )
      })

      test('an unknown --fingerprint is refused', async () => {
        await expect(
          runnerCommand({
            action: 'autoconfig',
            runInheritedFn: () => {},
            cwd,
            fingerprint: 'a'.repeat(64),
            ghTokenFromGh: true,
            execFn: () => 'ghp_x',
            fetchImpl: fetchSequence([{ status: 200, body: { runners: [] } }], []),
          }),
        ).rejects.toThrow()
      })

      test('a runner whose reported fingerprint does not match its own public key is refused (hub incoherent)', async () => {
        const entry = fakeRunnerEntry({ fingerprint: 'f'.repeat(64) })
        await expect(
          runnerCommand({
            action: 'autoconfig',
            runInheritedFn: () => {},
            cwd,
            fingerprint: entry.fingerprint,
            ghTokenFromGh: true,
            execFn: () => 'ghp_x',
            fetchImpl: fetchSequence([{ status: 200, body: { runners: [entry] } }], []),
          }),
        ).rejects.toThrow()
      })

      test('--gh-token-from-gh throws clearly when gh is not actually available', async () => {
        const entry = fakeRunnerEntry()
        await expect(
          runnerCommand({
            action: 'autoconfig',
            runInheritedFn: () => {},
            cwd,
            fingerprint: entry.fingerprint,
            ghTokenFromGh: true,
            execFn: () => {
              throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
            },
            fetchImpl: fetchSequence([{ status: 200, body: { runners: [entry] } }], []),
          }),
        ).rejects.toThrow(t('runner.autoconfigGhTokenUnavailable'))
      })

      test('a fully-flagged run (fingerprint + gh-token-from-gh) never prompts and deposits a sealed secret', async () => {
        const entry = fakeRunnerEntry()
        const calls: Call[] = []
        await expect(
          runnerCommand({
            action: 'autoconfig',
            runInheritedFn: () => {},
            cwd,
            fingerprint: entry.fingerprint,
            ghTokenFromGh: true,
            repoUrl: 'https://example.com/o/r.git',
            execFn: () => 'ghp_from_gh',
            fetchImpl: fetchSequence(
              [
                { status: 200, body: { runners: [entry] } },
                { status: 200, body: {} },
              ],
              calls,
            ),
          }),
        ).resolves.toBeUndefined()
        expect(calls.length).toBe(2)
      })

      test('--git-name/--git-email travel inside the sealed payload', async () => {
        const { publicKey, privateKey } = generateRunnerKeyPair()
        const entry = fakeRunnerEntry({
          public_key: publicKey.toString('base64'),
          fingerprint: runnerKeyFingerprint(publicKey),
        })
        const calls: Call[] = []
        await runnerCommand({
          action: 'autoconfig',
          runInheritedFn: () => {},
          cwd,
          fingerprint: entry.fingerprint,
          ghTokenFromGh: true,
          gitName: 'Naash',
          gitEmail: 'naash@example.com',
          execFn: () => 'ghp_from_gh',
          fetchImpl: fetchSequence(
            [
              { status: 200, body: { runners: [entry] } },
              { status: 200, body: {} },
            ],
            calls,
          ),
        })
        const deposited = JSON.parse(String(calls[1]?.init.body)) as { ciphertext: string }
        const plaintext = unseal(privateKey, deposited.ciphertext)
        expect(plaintext).not.toBeNull()
        expect(JSON.parse(plaintext?.toString('utf8') ?? '')).toEqual({
          v: 1,
          secrets: { GH_TOKEN: 'ghp_from_gh' },
          git_identity: { name: 'Naash', email: 'naash@example.com' },
        })
      })

      test('--git-name without --git-email fails before anything is sent', async () => {
        const entry = fakeRunnerEntry()
        const calls: Call[] = []
        await expect(
          runnerCommand({
            action: 'autoconfig',
            runInheritedFn: () => {},
            cwd,
            fingerprint: entry.fingerprint,
            ghTokenFromGh: true,
            gitName: 'Naash',
            execFn: () => 'ghp_from_gh',
            fetchImpl: fetchSequence([{ status: 200, body: { runners: [entry] } }], calls),
          }),
        ).rejects.toThrow(t('runner.autoconfigGitIdentityFlagsIncomplete'))
        expect(calls.length).toBe(1)
      })

      test('--claude-token alone is enough: no gh token is required', async () => {
        const entry = fakeRunnerEntry()
        await expect(
          runnerCommand({
            action: 'autoconfig',
            runInheritedFn: () => {},
            cwd,
            fingerprint: entry.fingerprint,
            claudeToken: 'claude-token-value',
            fetchImpl: fetchSequence(
              [
                { status: 200, body: { runners: [entry] } },
                { status: 200, body: {} },
              ],
              [],
            ),
          }),
        ).resolves.toBeUndefined()
      })
    })

    describe('interactive flow (seamed select/confirm/textInput, no real TTY)', () => {
      const previousStdinIsTTY = process.stdin.isTTY
      const previousStdoutIsTTY = process.stdout.isTTY
      const previousClaudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN

      beforeEach(() => {
        process.stdin.isTTY = true
        process.stdout.isTTY = true
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN
        saveGlobalConfig({
          ...loadGlobalConfig(),
          syncUrl: 'https://hub.example',
          syncWorkspaceId: 'ws1',
          syncSecret: 'sec1',
        })
      })

      afterEach(() => {
        process.stdin.isTTY = previousStdinIsTTY
        process.stdout.isTTY = previousStdoutIsTTY
        if (previousClaudeToken === undefined) {
          delete process.env.CLAUDE_CODE_OAUTH_TOKEN
        } else {
          process.env.CLAUDE_CODE_OAUTH_TOKEN = previousClaudeToken
        }
      })

      test('picks the runner via selectFn, confirms the fingerprint, and sends a pasted GH token', async () => {
        const entry = fakeRunnerEntry()
        const calls: Call[] = []
        await expect(
          runnerCommand({
            action: 'autoconfig',
            cwd,
            fetchImpl: fetchSequence(
              [
                { status: 200, body: { runners: [entry] } },
                { status: 200, body: {} },
              ],
              calls,
            ),
            selectFn: async () => entry,
            confirmFn: async () => true,
            textInputFn: async (o) =>
              o.title === t('runner.autoconfigPasteGhToken') ? 'ghp_pasted' : null,
            execFn: () => {
              throw new Error('no gh on this test machine')
            },
            runInheritedFn: () => {},
          }),
        ).resolves.toBeUndefined()
        expect(calls.length).toBe(2)
      })

      test('declining the fingerprint confirmation aborts before anything is deposited', async () => {
        const entry = fakeRunnerEntry()
        const calls: Call[] = []
        await expect(
          runnerCommand({
            action: 'autoconfig',
            runInheritedFn: () => {},
            cwd,
            fetchImpl: fetchStub(200, { runners: [entry] }, calls),
            selectFn: async () => entry,
            confirmFn: async () => false,
          }),
        ).rejects.toThrow(t('runner.autoconfigFingerprintNotConfirmed'))
        expect(calls.length).toBe(1)
      })

      test('declining every reuse offer with nothing pasted leaves no secret to send, and the command refuses', async () => {
        const entry = fakeRunnerEntry()
        await expect(
          runnerCommand({
            action: 'autoconfig',
            cwd,
            fetchImpl: fetchSequence([{ status: 200, body: { runners: [entry] } }], []),
            selectFn: async () => entry,
            confirmFn: async (o) => o.title === t('runner.autoconfigConfirmFingerprint'),
            textInputFn: async () => null,
            execFn: () => '',
            runInheritedFn: () => {},
          }),
        ).rejects.toThrow(t('runner.autoconfigNoSecrets'))
      })
    })
  })

  describe('await-secrets', () => {
    test('throws when not connected', async () => {
      await expect(runnerCommand({ action: 'await-secrets', cwd })).rejects.toThrow()
    })

    describe('connected', () => {
      beforeEach(() => {
        saveGlobalConfig({
          ...loadGlobalConfig(),
          syncUrl: 'https://hub.example',
          syncWorkspaceId: 'ws1',
          syncSecret: 'sec1',
        })
      })

      test('throws when this machine has no runner identity yet', async () => {
        await expect(
          runnerCommand({ action: 'await-secrets', cwd, timeoutSeconds: 1, pollIntervalMs: 5 }),
        ).rejects.toThrow(t('runner.awaitSecretsNoIdentity'))
      })

      describe('with a local runner identity', () => {
        let identity: ReturnType<typeof loadOrCreateRunnerIdentity>
        let envPath: string

        beforeEach(() => {
          identity = loadOrCreateRunnerIdentity()
          envPath = join(cwd, 'runner.env')
        })

        function sealedPayload(payload: unknown): string {
          return seal(identity.publicKey, Buffer.from(JSON.stringify(payload)))
        }

        test('succeeds on the very first poll, writes the env file, and STDOUT carries only the repo_url', async () => {
          const ciphertext = sealedPayload({
            v: 1,
            secrets: { GH_TOKEN: 'ghp_first_try' },
            repo_url: 'https://example.com/o/r.git',
          })
          const lines = await captureLog(async () => {
            await expect(
              runnerCommand({
                action: 'await-secrets',
                cwd,
                envFile: envPath,
                fetchImpl: fetchSequence([{ status: 200, body: { secret: { ciphertext } } }], []),
              }),
            ).resolves.toBeUndefined()
          })
          expect(lines).toEqual(['https://example.com/o/r.git'])
          expect(readFileSync(envPath, 'utf8')).toContain('GH_TOKEN=ghp_first_try')
        })

        test('a delivered git identity is applied through the seam, never the real global config', async () => {
          const ciphertext = sealedPayload({
            v: 1,
            secrets: { GH_TOKEN: 'ghp_with_identity' },
            git_identity: { name: 'Naash', email: 'naash@example.com' },
          })
          const applied: unknown[] = []
          const errLines = await captureErr(async () => {
            await runnerCommand({
              action: 'await-secrets',
              cwd,
              envFile: envPath,
              applyGitIdentityFn: (deliveredIdentity) => {
                applied.push(deliveredIdentity)
              },
              fetchImpl: fetchSequence([{ status: 200, body: { secret: { ciphertext } } }], []),
            })
          })
          expect(applied).toEqual([{ name: 'Naash', email: 'naash@example.com' }])
          expect(errLines.join('\n')).toContain(
            t('runner.awaitSecretsGitIdentityApplied', { name: 'Naash' }),
          )
        })

        test('nothing is printed on STDOUT when no repo_url was sent', async () => {
          const ciphertext = sealedPayload({ v: 1, secrets: { GH_TOKEN: 'ghp_no_repo' } })
          const lines = await captureLog(async () => {
            await runnerCommand({
              action: 'await-secrets',
              cwd,
              envFile: envPath,
              fetchImpl: fetchSequence([{ status: 200, body: { secret: { ciphertext } } }], []),
            })
          })
          expect(lines).toEqual([])
        })

        test('keeps polling past empty responses and succeeds once a secret appears', async () => {
          const ciphertext = sealedPayload({ v: 1, secrets: { GH_TOKEN: 'ghp_after_wait' } })
          const fetchImpl = fetchSequence(
            [
              { status: 404, body: {} },
              { status: 404, body: {} },
              { status: 200, body: { secret: { ciphertext } } },
            ],
            [],
          )
          await expect(
            runnerCommand({
              action: 'await-secrets',
              cwd,
              envFile: envPath,
              pollIntervalMs: 5,
              fetchImpl,
            }),
          ).resolves.toBeUndefined()
          expect(readFileSync(envPath, 'utf8')).toContain('GH_TOKEN=ghp_after_wait')
        })

        test('a corrupted delivery is logged and skipped, not fatal: a later valid one still lands', async () => {
          const ciphertext = sealedPayload({ v: 1, secrets: { GH_TOKEN: 'ghp_after_garbage' } })
          const fetchImpl = fetchSequence(
            [
              { status: 200, body: { secret: { ciphertext: 'not-a-real-sealed-blob' } } },
              { status: 200, body: { secret: { ciphertext } } },
            ],
            [],
          )
          const errLines = await captureErr(async () => {
            await expect(
              runnerCommand({
                action: 'await-secrets',
                cwd,
                envFile: envPath,
                pollIntervalMs: 5,
                fetchImpl,
              }),
            ).resolves.toBeUndefined()
          })
          expect(
            errLines.some((line) => line.includes(t('runner.awaitSecretsUndecryptable'))),
          ).toBe(true)
          expect(readFileSync(envPath, 'utf8')).toContain('GH_TOKEN=ghp_after_garbage')
        })

        test('times out cleanly when nothing ever arrives, without writing the env file', async () => {
          await expect(
            runnerCommand({
              action: 'await-secrets',
              cwd,
              envFile: envPath,
              timeoutSeconds: 0.15,
              pollIntervalMs: 10,
              fetchImpl: fetchSequence([{ status: 404, body: {} }], []),
            }),
          ).rejects.toThrow()
          expect(existsSync(envPath)).toBe(false)
        })

        test('reminds on STDERR at the configured interval while waiting', async () => {
          // Several empty polls before the secret lands, so the reminder
          // interval is guaranteed to elapse at least once: decoupled from
          // the timeout path entirely, so this never races a deadline.
          const ciphertext = sealedPayload({ v: 1, secrets: { GH_TOKEN: 'ghp_after_reminder' } })
          const fetchImpl = fetchSequence(
            [
              { status: 404, body: {} },
              { status: 404, body: {} },
              { status: 404, body: {} },
              { status: 404, body: {} },
              { status: 404, body: {} },
              { status: 200, body: { secret: { ciphertext } } },
            ],
            [],
          )
          const errLines = await captureErr(async () => {
            await expect(
              runnerCommand({
                action: 'await-secrets',
                cwd,
                envFile: envPath,
                pollIntervalMs: 5,
                reminderIntervalMs: 10,
                fetchImpl,
              }),
            ).resolves.toBeUndefined()
          })
          const expectedReminder = t('runner.awaitSecretsReminder', {
            fingerprint: formatFingerprint(identity.fingerprint),
          })
          expect(errLines.some((line) => line.includes(expectedReminder))).toBe(true)
        })
      })
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
      return join(xdgConfigHome, 'systemd', 'user', 'codesema-runner.service')
    }

    beforeEach(() => {
      xdgConfigHome = mkdtempSync(join(tmpdir(), 'codesema-runnercmd-xdg-'))
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
        runnerCommand({ action: 'install-service', cwd, execFn: noopExecFn([]) }),
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
        runnerCommand({ action: 'install-service', cwd, execFn: noopExecFn(calls) }),
      ).resolves.toBeUndefined()

      expect(existsSync(unitPath())).toBe(true)
      const unit = readFileSync(unitPath(), 'utf8')
      expect(unit).toContain(`WorkingDirectory=${repoRoot}`)
      expect(calls.map((c) => c.args.join(' '))).toContain(
        '--user enable --now codesema-runner.service',
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
      await expect(runnerCommand({ action: 'install-service', cwd, execFn })).rejects.toThrow(
        t('runner.systemctlNotFound'),
      )
      expect(existsSync(unitPath())).toBe(false)
    })

    test('uninstall-service is a soft no-op when nothing is installed', async () => {
      await expect(
        runnerCommand({ action: 'uninstall-service', cwd, execFn: noopExecFn([]) }),
      ).resolves.toBeUndefined()
    })

    test('uninstall-service removes a previously installed unit', async () => {
      initRepo(cwd)
      await runnerCommand({ action: 'install-service', cwd, execFn: noopExecFn([]) })
      expect(existsSync(unitPath())).toBe(true)

      await expect(
        runnerCommand({ action: 'uninstall-service', cwd, execFn: noopExecFn([]) }),
      ).resolves.toBeUndefined()
      expect(existsSync(unitPath())).toBe(false)
    })
  })
})

describe('runbookCommand', () => {
  const previousConfigDir = process.env.CODESEMA_CONFIG_DIR
  let configDir: string
  let cwd: string

  beforeEach(() => {
    configDir = mkdtempSync(join(tmpdir(), 'codesema-runbookcmd-cfg-'))
    process.env.CODESEMA_CONFIG_DIR = configDir
    cwd = mkdtempSync(join(tmpdir(), 'codesema-runbookcmd-repo-'))
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

  function completedOutcome(): RunbookScanOutcome {
    return {
      status: 'completed',
      runbook: {
        version: RUNBOOK_VERSION,
        image: 'node:26',
        install: [],
        services: { host_up: [], compose_file: null },
        healthchecks: [],
        tests: ['bun test', 'bun run lint'],
        egress: [],
        depends_on_files: [],
      },
      validation: {
        runbook_sha: '0123456789abcdef',
        validated_sha: 'a'.repeat(40),
        validated_at: '2026-01-01T00:00:00.000Z',
        status: 'valid',
      },
      snapshotName: 'snap1',
      checks: [],
      attempts: 2,
    }
  }

  test('no action prints usage and does not throw', async () => {
    const lines = await captureLog(() => runbookCommand({ cwd }))
    expect(lines.some((l) => l.includes('runbook scan'))).toBe(true)
  })

  test('an unknown action throws', async () => {
    await expect(runbookCommand({ action: 'nope', cwd })).rejects.toThrow(/unknown runbook action/)
  })

  test('scan outside a git repository throws', async () => {
    await expect(
      runbookCommand({
        action: 'scan',
        cwd,
        agent: 'claude -p',
        runRunbookScanFn: async () => completedOutcome(),
      }),
    ).rejects.toThrow(/not a git repository/)
  })

  test('scan passes the explicit --agent, the resolved head sha, a stable projectId and timeoutMs', async () => {
    initRepo(cwd)
    const seen: { command: string; headSha: string; projectId: string; timeoutMs: number } = {
      command: '',
      headSha: '',
      projectId: '',
      timeoutMs: 0,
    }
    await runbookCommand({
      action: 'scan',
      cwd,
      agent: 'claude -p',
      timeoutSeconds: 42,
      runRunbookScanFn: async (opts) => {
        seen.command = opts.command
        seen.headSha = opts.headSha
        seen.projectId = opts.projectId
        seen.timeoutMs = opts.timeoutMs
        return completedOutcome()
      },
    })
    expect(seen.command).toBe('claude -p')
    expect(seen.headSha).toMatch(/^[0-9a-f]{40}$/)
    expect(seen.projectId).toMatch(/^[0-9a-f]{16}$/)
    expect(seen.timeoutMs).toBe(42_000)
  })

  test('scan forwards CLAUDE_CODE_OAUTH_TOKEN from the environment as a sandbox secret, never as plain env', async () => {
    initRepo(cwd)
    const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok-secret'
    try {
      let seenSecrets: readonly { env: string; value: string; allowedHosts: readonly string[] }[] =
        []
      await runbookCommand({
        action: 'scan',
        cwd,
        agent: 'claude -p',
        runRunbookScanFn: async (opts) => {
          seenSecrets = opts.secrets ?? []
          return completedOutcome()
        },
      })
      expect(seenSecrets).toEqual([
        { env: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'tok-secret', allowedHosts: expect.any(Array) },
      ])
    } finally {
      if (previous === undefined) {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      } else {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = previous
      }
    }
  })

  test('the projectId is stable across two scans of the same worktree', async () => {
    initRepo(cwd)
    const seen: string[] = []
    const runRunbookScanFn = async (opts: { projectId: string }): Promise<RunbookScanOutcome> => {
      seen.push(opts.projectId)
      return completedOutcome()
    }
    await runbookCommand({ action: 'scan', cwd, agent: 'claude -p', runRunbookScanFn })
    await runbookCommand({ action: 'scan', cwd, agent: 'claude -p', runRunbookScanFn })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
  })

  test('with no --agent and no configured agent, falls back to .codesema/config.json', async () => {
    initRepo(cwd)
    mkdirSync(join(cwd, '.codesema'), { recursive: true })
    writeFileSync(join(cwd, '.codesema', 'config.json'), JSON.stringify({ agent: 'grok -p' }))
    const seen: { command: string } = { command: '' }
    await runbookCommand({
      action: 'scan',
      cwd,
      runRunbookScanFn: async (opts) => {
        seen.command = opts.command
        return completedOutcome()
      },
    })
    expect(seen.command).toBe('grok -p')
  })

  test('a completed scan prints the runbook summary', async () => {
    initRepo(cwd)
    const lines = await captureLog(() =>
      runbookCommand({
        action: 'scan',
        cwd,
        agent: 'claude -p',
        runRunbookScanFn: async () => completedOutcome(),
      }),
    )
    const joined = lines.join('\n')
    expect(joined).toContain('Runbook validated')
    expect(joined).toContain('node:26')
    expect(joined).toContain('snap1')
    expect(joined).toContain('0123456789abcdef')
    expect(joined).toContain(RUNBOOK_FILE)
  })

  test('a failed scan prints the error and sets a non-zero exit code', async () => {
    initRepo(cwd)
    const previousExitCode = process.exitCode
    process.exitCode = undefined
    try {
      const lines = await captureLog(() =>
        runbookCommand({
          action: 'scan',
          cwd,
          agent: 'claude -p',
          runRunbookScanFn: async () => ({
            status: 'failed',
            error: 'install always fails',
            attempts: 5,
            lastTail: 'boom',
          }),
        }),
      )
      expect(lines.join('\n')).toContain('install always fails')
      expect(process.exitCode as unknown).toBe(1)
    } finally {
      process.exitCode = previousExitCode ?? 0
    }
  })

  test('with no driver override, a real (but unused) Microsandbox driver is constructed without throwing', async () => {
    initRepo(cwd)
    await expect(
      runbookCommand({
        action: 'scan',
        cwd,
        agent: 'claude -p',
        runRunbookScanFn: async (opts) => {
          expect(opts.driver.kind).toBe('microsandbox')
          return completedOutcome()
        },
      }),
    ).resolves.toBeUndefined()
  })

  test('usage lists both scan and validate', async () => {
    const lines = await captureLog(() => runbookCommand({ cwd }))
    expect(lines.some((l) => l.includes('runbook scan|validate'))).toBe(true)
  })

  test('validate outside a git repository throws', async () => {
    await expect(
      runbookCommand({
        action: 'validate',
        cwd,
        agent: 'claude -p',
        runRunbookValidateFn: async () => completedOutcome(),
      }),
    ).rejects.toThrow(/not a git repository/)
  })

  test('validate routes to runRunbookValidateFn with the resolved head sha, a stable projectId, timeoutMs and an agentId', async () => {
    initRepo(cwd)
    const seen: {
      headSha: string
      projectId: string
      timeoutMs: number
      agentId: string
    } = { headSha: '', projectId: '', timeoutMs: 0, agentId: '' }
    await runbookCommand({
      action: 'validate',
      cwd,
      agent: 'claude -p',
      timeoutSeconds: 42,
      runRunbookValidateFn: async (opts) => {
        seen.headSha = opts.headSha
        seen.projectId = opts.projectId
        seen.timeoutMs = opts.timeoutMs
        seen.agentId = opts.agentId
        return completedOutcome()
      },
    })
    expect(seen.headSha).toMatch(/^[0-9a-f]{40}$/)
    expect(seen.projectId).toMatch(/^[0-9a-f]{16}$/)
    expect(seen.timeoutMs).toBe(42_000)
    expect(seen.agentId).toBe('claude')
  })

  test('validate and scan resolve to the same projectId for the same worktree', async () => {
    initRepo(cwd)
    const seen: string[] = []
    await runbookCommand({
      action: 'scan',
      cwd,
      agent: 'claude -p',
      runRunbookScanFn: async (opts) => {
        seen.push(opts.projectId)
        return completedOutcome()
      },
    })
    await runbookCommand({
      action: 'validate',
      cwd,
      agent: 'claude -p',
      runRunbookValidateFn: async (opts) => {
        seen.push(opts.projectId)
        return completedOutcome()
      },
    })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toBe(seen[1])
  })

  test('a completed validate prints the runbook summary', async () => {
    initRepo(cwd)
    const lines = await captureLog(() =>
      runbookCommand({
        action: 'validate',
        cwd,
        agent: 'claude -p',
        runRunbookValidateFn: async () => completedOutcome(),
      }),
    )
    const joined = lines.join('\n')
    expect(joined).toContain('Runbook validated')
    expect(joined).toContain(RUNBOOK_FILE)
  })

  test('a failed validate prints the error and sets a non-zero exit code', async () => {
    initRepo(cwd)
    const previousExitCode = process.exitCode
    process.exitCode = undefined
    try {
      const lines = await captureLog(() =>
        runbookCommand({
          action: 'validate',
          cwd,
          agent: 'claude -p',
          runRunbookValidateFn: async () => ({
            status: 'failed',
            error: 'no runbook found',
            attempts: 0,
            lastTail: null,
          }),
        }),
      )
      expect(lines.join('\n')).toContain('no runbook found')
      expect(process.exitCode as unknown).toBe(1)
    } finally {
      process.exitCode = previousExitCode ?? 0
    }
  })
})
