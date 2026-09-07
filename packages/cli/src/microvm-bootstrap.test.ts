import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { SandboxExecOptions, SandboxExecResult, SandboxHandle } from './microsandbox-driver.js'
import {
  assertValidGuestUser,
  ensureAgentCredentials,
  ensureAgentInstalled,
  ensureGuestUser,
} from './microvm-bootstrap.js'
import { CAGE_HOME_DIR } from './task-isolation.js'

const cleanups: string[] = []

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeCredentialsFile(content = '{"token":"secret-token-value"}'): string {
  const dir = mkdtempSync(join(tmpdir(), 'codesema-microvm-bootstrap-'))
  cleanups.push(dir)
  const path = join(dir, 'credentials.json')
  writeFileSync(path, content)
  return path
}

type ShellCall = { script: string; opts: SandboxExecOptions }

function fakeHandle(shellResponder?: (script: string) => Partial<SandboxExecResult> | undefined): {
  handle: SandboxHandle
  shellCalls: ShellCall[]
  writeFileCalls: Array<[string, string]>
} {
  const shellCalls: ShellCall[] = []
  const writeFileCalls: Array<[string, string]> = []
  const handle: SandboxHandle = {
    name: 'fake',
    exec: () => {
      throw new Error('exec should never be used for the credentials bootstrap')
    },
    shell: (script, opts) => {
      shellCalls.push({ script, opts })
      return Promise.resolve({
        code: 0,
        stdout: '',
        stderr: '',
        timedOut: false,
        ...shellResponder?.(script),
      })
    },
    copyFromHost: () => Promise.resolve(),
    copyToHost: () => Promise.resolve(),
    writeFile: (guestPath, content) => {
      writeFileCalls.push([guestPath, content])
      return Promise.resolve()
    },
    readFile: () => Promise.resolve(''),
    metrics: () =>
      Promise.resolve({ memoryHostResidentBytes: null, memoryBytes: null, cpuPercent: null }),
    stop: () => Promise.resolve(),
  }
  return { handle, shellCalls, writeFileCalls }
}

describe('assertValidGuestUser', () => {
  test('accepts a useradd-shaped name', () => {
    expect(() => assertValidGuestUser('agent')).not.toThrow()
  })

  test('rejects anything that could break out of a spliced shell script', () => {
    expect(() => assertValidGuestUser('agent; rm -rf /')).toThrow()
    expect(() => assertValidGuestUser('')).toThrow()
    expect(() => assertValidGuestUser('Agent')).toThrow()
  })
})

describe('ensureGuestUser', () => {
  test('creates the user as root, idempotently', async () => {
    const { handle, shellCalls } = fakeHandle()
    await ensureGuestUser(handle, 'agent')
    expect(shellCalls).toHaveLength(1)
    expect(shellCalls[0]?.opts.user).toBe('root')
    expect(shellCalls[0]?.script).toContain('useradd -m -s /bin/bash agent')
  })

  test('refuses an invalid user before any shell call', async () => {
    const { handle, shellCalls } = fakeHandle()
    await expect(ensureGuestUser(handle, 'not a user')).rejects.toThrow()
    expect(shellCalls).toHaveLength(0)
  })
})

describe('ensureAgentInstalled', () => {
  test('a found agent never installs', async () => {
    const { handle, shellCalls } = fakeHandle(() => ({ code: 0 }))
    await ensureAgentInstalled(handle, 'claude', { install: true })
    expect(shellCalls).toHaveLength(1)
    expect(shellCalls[0]?.script).toBe('command -v claude')
  })

  test('a missing agent installs on a cold boot', async () => {
    const { handle, shellCalls } = fakeHandle((script) =>
      script === 'command -v claude' ? { code: 1, stderr: 'not found' } : { code: 0 },
    )
    await ensureAgentInstalled(handle, 'claude', { install: true })
    expect(shellCalls).toHaveLength(2)
    expect(shellCalls[1]?.opts.user).toBe('root')
  })

  test('a missing agent on a hot boot (snapshot) refuses instead of installing', async () => {
    const { handle, shellCalls } = fakeHandle(() => ({ code: 1, stderr: 'not found' }))
    await expect(ensureAgentInstalled(handle, 'claude', { install: false })).rejects.toThrow(
      /not installed in this microVM/,
    )
    expect(shellCalls).toHaveLength(1)
  })
})

describe('ensureAgentCredentials', () => {
  test('claude, no oauth token, a readable credentials file: written through writeFile, chmod 600, chowned to the guest user, never in a shell command', async () => {
    const credentialsPath = makeCredentialsFile('{"token":"secret-token-value"}')
    const { handle, shellCalls, writeFileCalls } = fakeHandle()

    await ensureAgentCredentials(handle, 'agent', 'claude', { env: {}, credentialsPath })

    expect(writeFileCalls).toEqual([
      [`${CAGE_HOME_DIR}/.claude/.credentials.json`, '{"token":"secret-token-value"}'],
    ])
    expect(shellCalls.some((c) => c.script.includes(`mkdir -p ${CAGE_HOME_DIR}/.claude`))).toBe(
      true,
    )
    const chmodChown = shellCalls.find((c) => c.script.includes('chmod 600'))
    expect(chmodChown?.script).toBe(
      `chmod 600 ${CAGE_HOME_DIR}/.claude/.credentials.json && chown -R agent:agent ${CAGE_HOME_DIR}/.claude`,
    )
    expect(chmodChown?.opts.user).toBe('root')
    for (const call of shellCalls) {
      expect(call.script).not.toContain('secret-token-value')
    }
  })

  test('CLAUDE_CODE_OAUTH_TOKEN set: nothing is read from disk, nothing is written', async () => {
    const credentialsPath = makeCredentialsFile()
    const { handle, shellCalls, writeFileCalls } = fakeHandle()

    await ensureAgentCredentials(handle, 'agent', 'claude', {
      env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
      credentialsPath,
    })

    expect(writeFileCalls).toHaveLength(0)
    expect(shellCalls).toHaveLength(0)
  })

  test('an unreadable or absent credentials file: no write, no error', async () => {
    const missingPath = join(
      mkdtempSync(join(tmpdir(), 'codesema-microvm-bootstrap-')),
      'nope.json',
    )
    cleanups.push(missingPath)
    const { handle, shellCalls, writeFileCalls } = fakeHandle()

    await expect(
      ensureAgentCredentials(handle, 'agent', 'claude', { env: {}, credentialsPath: missingPath }),
    ).resolves.toBeUndefined()

    expect(writeFileCalls).toHaveLength(0)
    expect(shellCalls).toHaveLength(0)
  })

  test('a non-claude agent (e.g. opencode) is never touched: its own auth.json is a separate concern', async () => {
    const credentialsPath = makeCredentialsFile()
    const { handle, shellCalls, writeFileCalls } = fakeHandle()

    await ensureAgentCredentials(handle, 'agent', 'opencode', { env: {}, credentialsPath })

    expect(writeFileCalls).toHaveLength(0)
    expect(shellCalls).toHaveLength(0)
  })

  test('refuses an invalid guest user before touching the file or the sandbox', async () => {
    const credentialsPath = makeCredentialsFile()
    const { handle, shellCalls, writeFileCalls } = fakeHandle()

    await expect(
      ensureAgentCredentials(handle, 'not a user', 'claude', { env: {}, credentialsPath }),
    ).rejects.toThrow()

    expect(writeFileCalls).toHaveLength(0)
    expect(shellCalls).toHaveLength(0)
  })
})
