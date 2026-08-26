import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentRunOptions } from './agent.js'
import { brainCommand } from './brain-commands.js'
import { readBrainPidfile, writeBrainPidfile } from './brain-pidfile.js'
import { loadGlobalConfig, saveGlobalConfig } from './config.js'
import type { ArmTicket } from './contract.js'

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
})
