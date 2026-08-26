import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { AgentRunOptions } from './agent.js'
import { brainCommand } from './brain-commands.js'
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
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'chore: init'], { cwd })
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

- WHEN a THE SYSTEM SHALL b
- WHEN c THE SYSTEM SHALL d
- WHEN e THE SYSTEM SHALL f

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
})
