import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { AgentWatchdogError, type AgentClock } from './agent.js'
import { CAGE_GIT_COMMON_DIR } from './container-git.js'
import type { RunbookConfig } from './contract.js'
import type {
  SandboxDriver,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxSecret,
  SandboxSpec,
} from './microsandbox-driver.js'
import { AGENT_INSTALL_DOMAINS } from './microvm-bootstrap.js'
import {
  MICROVM_TURN_DEFAULTS,
  runMicrovmTurn,
  type RunMicrovmTurnOptions,
} from './microvm-turn.js'
import { CAGE_WORK_DIR, DEFAULT_ISOLATION_ALLOWED_DOMAINS } from './task-isolation.js'

// --- rigs -------------------------------------------------------------------

const cleanups: string[] = []

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeDir(prefix = 'codesema-microvm-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}

/**
 * Drains the microtask queue: a macrotask boundary only fires once every
 * queued `.then`/`await` has run, however many bootstrap steps
 * (`create`, two `shell` calls, `copyFromHost`, `chown`) chain before
 * `runMicrovmTurn` reaches the one `shell()` call this rig leaves pending
 * (the turn itself) — a fixed number of `await Promise.resolve()` ticks
 * would silently under-count the moment that chain grows.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** A real repo plus a LINKED worktree, same shape every task gets. */
function makeLinkedWorktree(): { repo: string; worktree: string } {
  const root = makeDir('codesema-microvm-git-')
  const repo = join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  const run = (args: string[]): void => {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
      cwd: repo,
      stdio: 'ignore',
    })
  }
  run(['init', '-b', 'main'])
  writeFileSync(join(repo, 'base.txt'), 'a\n')
  run(['add', '-A'])
  run(['commit', '-m', 'init'])
  const worktree = join(root, 'wt')
  run(['worktree', 'add', worktree, '-b', 'codesema/task-x'])
  return { repo, worktree }
}

type ShellCall = { script: string; opts: SandboxExecOptions }

/**
 * Fake `SandboxHandle` + `SandboxDriver` pair. Every `shell()` call resolves
 * immediately EXCEPT the one that wraps the agent command in `su <user> -c`:
 * that one is the controllable "turn" call, resolved/rejected/pushed to by
 * the test. Nothing here spawns a real process or SDK.
 */
/**
 * `controlDestroy: true` makes `driver.destroy()` return a promise the test
 * settles itself via `resolveDestroy()`, instead of resolving immediately —
 * needed to observe ordering/sequencing around destroy (F15). Off by default
 * so every pre-existing test (which never calls `resolveDestroy`) keeps
 * working unchanged.
 *
 * `shellResponder`, when given, overrides the default `{ code: 0 }` answer
 * for a specific non-turn script (bootstrap: useradd, the agent-install
 * probe/install) — undefined for a script it does not care about falls
 * through to the default, so most tests never need it.
 */
function fakeMicrovmDriver(
  rigOptions: {
    controlDestroy?: boolean
    shellResponder?: (script: string) => Partial<SandboxExecResult> | undefined
  } = {},
) {
  const shellCalls: ShellCall[] = []
  const copyFromHostCalls: Array<[string, string]> = []
  const copyToHostCalls: Array<[string, string]> = []
  const writeFileCalls: Array<[string, string]> = []
  const destroyedNames: string[] = []
  const callOrder: string[] = []
  const destroyResolvers: Array<() => void> = []
  let createdSpec: SandboxSpec | null = null
  let turnResolve: ((r: SandboxExecResult) => void) | null = null
  let turnReject: ((e: unknown) => void) | null = null
  let turnAborted = false
  let turnOnText: ((chunk: string) => void) | undefined

  const notUsed =
    (name: string) =>
    (...args: unknown[]): never => {
      throw new Error(
        `fake SandboxHandle.${name} not used by runMicrovmTurn (args: ${JSON.stringify(args)})`,
      )
    }

  const handle: SandboxHandle = {
    get name() {
      return createdSpec?.name ?? 'unknown'
    },
    exec: notUsed('exec') as unknown as SandboxHandle['exec'],
    shell: (script, opts) => {
      shellCalls.push({ script, opts })
      const isTurn = /\bsu\s+\S+\s+-c\s/.test(script)
      if (!isTurn) {
        const overridden = rigOptions.shellResponder?.(script)
        return Promise.resolve({
          code: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
          ...overridden,
        })
      }
      turnOnText = opts.onText
      opts.signal?.addEventListener('abort', () => {
        turnAborted = true
      })
      return new Promise<SandboxExecResult>((resolve, reject) => {
        turnResolve = resolve
        turnReject = reject
      })
    },
    copyFromHost: (hostPath, guestPath) => {
      copyFromHostCalls.push([hostPath, guestPath])
      return Promise.resolve()
    },
    copyToHost: (guestPath, hostPath) => {
      copyToHostCalls.push([guestPath, hostPath])
      callOrder.push('copyToHost')
      return Promise.resolve()
    },
    writeFile: (guestPath, content) => {
      writeFileCalls.push([guestPath, content])
      return Promise.resolve()
    },
    readFile: notUsed('readFile') as unknown as SandboxHandle['readFile'],
    metrics: () =>
      Promise.resolve({ memoryHostResidentBytes: null, memoryBytes: null, cpuPercent: null }),
    stop: () => Promise.resolve(),
  }

  const driver: SandboxDriver = {
    kind: 'fake',
    probe: () => Promise.resolve({ available: true, reason: null, version: 'fake' }),
    create: (spec) => {
      createdSpec = spec
      return Promise.resolve(handle)
    },
    snapshot: notUsed('snapshot') as unknown as SandboxDriver['snapshot'],
    listSandboxes: () => Promise.resolve([]),
    listSnapshots: () => Promise.resolve([]),
    destroy: (name) => {
      destroyedNames.push(name)
      callOrder.push('destroy')
      if (!rigOptions.controlDestroy) {
        return Promise.resolve()
      }
      return new Promise<void>((resolve) => {
        destroyResolvers.push(resolve)
      })
    },
    removeSnapshot: () => Promise.resolve(),
    ensureVolume: () => Promise.resolve(),
    removeVolume: () => Promise.resolve(),
  }

  return {
    driver,
    handle,
    shellCalls,
    copyFromHostCalls,
    copyToHostCalls,
    writeFileCalls,
    destroyedNames,
    callOrder,
    getSpec: () => createdSpec,
    pushText: (chunk: string) => turnOnText?.(chunk),
    resolveTurn: (r: Partial<SandboxExecResult> = {}) =>
      turnResolve?.({ code: 0, stdout: '', stderr: '', timedOut: false, ...r }),
    rejectTurn: (e: unknown) => turnReject?.(e),
    isTurnAborted: () => turnAborted,
    turnShellCall: () => shellCalls.find((c) => /\bsu\s+\S+\s+-c\s/.test(c.script)),
    resolveDestroy: () => destroyResolvers.shift()?.(),
  }
}

/** Virtual time: no test waits out a real watchdog budget. */
function fakeClock(): AgentClock & { advance: (ms: number) => void } {
  let now = 1_000_000
  let nextId = 1
  const timers = new Map<number, { due: number; fn: () => void }>()
  return {
    now: () => now,
    setTimer(fn, ms) {
      const id = nextId++
      timers.set(id, { due: now + ms, fn })
      return () => timers.delete(id)
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        let pick: [number, { due: number; fn: () => void }] | null = null
        for (const entry of timers) {
          if (entry[1].due <= target && (pick === null || entry[1].due < pick[1].due)) {
            pick = entry
          }
        }
        if (pick === null) {
          break
        }
        timers.delete(pick[0])
        now = pick[1].due
        pick[1].fn()
      }
      now = target
    },
  }
}

const SECRETS: SandboxSecret[] = [
  {
    env: 'CLAUDE_CODE_OAUTH_TOKEN',
    value: 'tok-secret',
    allowedHosts: DEFAULT_ISOLATION_ALLOWED_DOMAINS,
  },
]

function baseOptions(
  over: Partial<RunMicrovmTurnOptions> = {},
  rigOptions: Parameters<typeof fakeMicrovmDriver>[0] = {},
): {
  opts: RunMicrovmTurnOptions
  rig: ReturnType<typeof fakeMicrovmDriver>
} {
  const rig = fakeMicrovmDriver(rigOptions)
  const opts: RunMicrovmTurnOptions = {
    taskId: 'a1b2c3d4e5f6',
    worktree: makeDir(),
    command: 'claude -p --dangerously-skip-permissions',
    prompt: 'do the thing',
    timeoutMs: 10 * 60_000,
    driver: rig.driver,
    snapshotName: null,
    image: 'node:26',
    runbook: null,
    secrets: SECRETS,
    env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret' },
    ...over,
  }
  return { opts, rig }
}

// --- tests -------------------------------------------------------------------

describe('runMicrovmTurn: sandbox spec', () => {
  test('never omits a network policy, and defaults it to the standard allowlist plus the agent install domain (cold boot)', async () => {
    const { opts, rig } = baseOptions()
    const promise = runMicrovmTurn(opts)
    await flush()
    const spec = rig.getSpec()
    expect(spec?.network.allowedDomains).toEqual([
      ...DEFAULT_ISOLATION_ALLOWED_DOMAINS,
      ...AGENT_INSTALL_DOMAINS,
    ])
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })

  test('a snapshot restore does not open the agent install domain', async () => {
    const { opts, rig } = baseOptions({ snapshotName: 'snap-abc' })
    const promise = runMicrovmTurn(opts)
    await flush()
    expect(rig.getSpec()?.network.allowedDomains).toEqual([...DEFAULT_ISOLATION_ALLOWED_DOMAINS])
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })

  describe('agent bootstrap', () => {
    test('a cold boot npm-installs the agent derived from the command when the guest PATH probe finds it missing', async () => {
      const { opts, rig } = baseOptions(
        { command: 'opencode run --model x' },
        {
          shellResponder: (script) =>
            script === 'command -v opencode' ? { code: 1, stderr: 'not found' } : undefined,
        },
      )
      const promise = runMicrovmTurn(opts)
      await flush()
      const install = rig.shellCalls.find((c) => c.script.includes('npm install -g'))
      expect(install?.script).toContain('opencode-ai')
      expect(install?.opts.user).toBe('root')
      rig.resolveTurn({ stdout: 'ok' })
      await promise
    })

    test('a cold boot never installs when the guest PATH probe already finds the agent', async () => {
      const { opts, rig } = baseOptions()
      const promise = runMicrovmTurn(opts)
      await flush()
      expect(rig.shellCalls.some((c) => c.script.includes('npm install -g'))).toBe(false)
      rig.resolveTurn({ stdout: 'ok' })
      await promise
    })

    test('a snapshot boot never installs, and rejects with a readable error when the agent is missing', async () => {
      const { opts, rig } = baseOptions(
        { snapshotName: 'snap-abc' },
        {
          shellResponder: (script) =>
            script === 'command -v claude' ? { code: 1, stderr: 'not found' } : undefined,
        },
      )
      await expect(runMicrovmTurn(opts)).rejects.toThrow(/not installed in this microVM/)
      expect(rig.shellCalls.some((c) => c.script.includes('npm install -g'))).toBe(false)
    })
  })

  test('a validated runbook joins its egress to the allowlist for the whole turn', async () => {
    const runbook: RunbookConfig = {
      version: 1,
      image: 'node:26',
      install: [],
      services: { host_up: [], compose_file: null },
      healthchecks: [],
      tests: ['true'],
      egress: ['registry.npmjs.org'],
      depends_on_files: [],
    }
    const { opts, rig } = baseOptions({ runbook })
    const promise = runMicrovmTurn(opts)
    await flush()
    expect(rig.getSpec()?.network.allowedDomains).toContain('registry.npmjs.org')
    for (const domain of DEFAULT_ISOLATION_ALLOWED_DOMAINS) {
      expect(rig.getSpec()?.network.allowedDomains).toContain(domain)
    }
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })

  test('secrets are declared on the spec, and their values never leak into plain env', async () => {
    const { opts, rig } = baseOptions()
    const promise = runMicrovmTurn(opts)
    await flush()
    const spec = rig.getSpec()
    expect(spec?.secrets).toBe(SECRETS)
    expect(Object.values(spec?.env ?? {})).not.toContain('tok-secret')
    expect(JSON.stringify(spec?.env ?? {})).not.toContain('tok-secret')
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })

  test('non-secret provider config (base url, model) is forwarded as plain env', async () => {
    const { opts, rig } = baseOptions({
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: 'tok-secret',
        ANTHROPIC_BASE_URL: 'https://proxy.example.com',
        ANTHROPIC_MODEL: 'claude-opus',
      },
    })
    const promise = runMicrovmTurn(opts)
    await flush()
    expect(rig.getSpec()?.env).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://proxy.example.com',
      ANTHROPIC_MODEL: 'claude-opus',
    })
    expect(rig.getSpec()?.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })

  test('never sets SSL_CERT_FILE: Microsandbox already covers the intercepted egress', async () => {
    const { opts, rig } = baseOptions()
    const promise = runMicrovmTurn(opts)
    await flush()
    expect(rig.getSpec()?.env?.SSL_CERT_FILE).toBeUndefined()
    for (const call of rig.shellCalls) {
      expect(call.script).not.toContain('SSL_CERT_FILE')
    }
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })

  test('a snapshot restores instead of booting the image cold', async () => {
    const { opts, rig } = baseOptions({ snapshotName: 'snap-abc' })
    const promise = runMicrovmTurn(opts)
    await flush()
    expect(rig.getSpec()?.fromSnapshot).toBe('snap-abc')
    expect(rig.getSpec()?.image).toBeUndefined()
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })

  test('no snapshot boots the given image cold', async () => {
    const { opts, rig } = baseOptions({ snapshotName: null, image: 'node:26' })
    const promise = runMicrovmTurn(opts)
    await flush()
    expect(rig.getSpec()?.image).toBe('node:26')
    expect(rig.getSpec()?.fromSnapshot).toBeUndefined()
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })

  test('never passes a workdir to create: the SDK refuses one that does not exist yet', async () => {
    const { opts, rig } = baseOptions()
    const promise = runMicrovmTurn(opts)
    await flush()
    expect(rig.getSpec()?.workdir).toBeUndefined()
    expect(rig.shellCalls.some((c) => c.script.includes(`mkdir -p ${CAGE_WORK_DIR}`))).toBe(true)
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })
})

describe('runMicrovmTurn: non-root user and the su wrapper', () => {
  test('creates the guest user idempotently, as root, before anything else runs', async () => {
    const { opts, rig } = baseOptions()
    const promise = runMicrovmTurn(opts)
    await flush()
    const bootstrap = rig.shellCalls[0]
    expect(bootstrap?.script).toContain('id -u agent')
    expect(bootstrap?.script).toContain('useradd -m -s /bin/bash agent')
    expect(bootstrap?.opts.user).toBe('root')
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })

  test('never sets a boot user on the sandbox spec: the guest user does not exist until useradd runs, so a boot user makes the SDK fail BootStart', async () => {
    const { opts, rig } = baseOptions()
    const promise = runMicrovmTurn(opts)
    await flush()
    expect(rig.getSpec()?.user).toBeUndefined()
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })

  test('chowns the copied worktree to the guest user before the turn runs', async () => {
    const { opts, rig } = baseOptions()
    const promise = runMicrovmTurn(opts)
    await flush()
    const chown = rig.shellCalls.find((c) => c.script.startsWith('chown -R agent:agent'))
    expect(chown).toBeDefined()
    expect(chown?.opts.user).toBe('root')
    const chownIndex = rig.shellCalls.indexOf(chown as ShellCall)
    const turnIndex = rig.shellCalls.findIndex((c) => /\bsu\s+agent\s+-c\s/.test(c.script))
    expect(chownIndex).toBeLessThan(turnIndex)
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })

  test('runs the agent as `su agent -c` WITHOUT a dash: a dash resets the substituted secret env', async () => {
    const { opts, rig } = baseOptions({ command: 'claude -p --dangerously-skip-permissions' })
    const promise = runMicrovmTurn(opts)
    await flush()
    const turn = rig.turnShellCall()
    expect(turn?.script).toContain(`cd ${CAGE_WORK_DIR} && su agent -c `)
    expect(turn?.script).not.toContain('su - agent')
    expect(turn?.script).toContain("'claude -p --dangerously-skip-permissions'")
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })

  test('a command carrying a single quote is escaped, not broken', async () => {
    const { opts, rig } = baseOptions({ command: `claude -p --append-system-prompt "it's fine"` })
    const promise = runMicrovmTurn(opts)
    await flush()
    const turn = rig.turnShellCall()
    expect(turn?.script).toContain(`'claude -p --append-system-prompt "it'\\''s fine"'`)
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })

  test('a custom guest user is honored end to end', async () => {
    const { opts, rig } = baseOptions({ user: 'runner' })
    const promise = runMicrovmTurn(opts)
    await flush()
    expect(rig.shellCalls[0]?.script).toContain('useradd -m -s /bin/bash runner')
    expect(rig.turnShellCall()?.script).toContain('su runner -c ')
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })

  test('the default guest user matches MICROVM_TURN_DEFAULTS.user', async () => {
    const { opts, rig } = baseOptions()
    const promise = runMicrovmTurn(opts)
    await flush()
    expect(rig.shellCalls[0]?.script).toContain(
      `useradd -m -s /bin/bash ${MICROVM_TURN_DEFAULTS.user}`,
    )
    expect(rig.turnShellCall()?.script).toContain(`su ${MICROVM_TURN_DEFAULTS.user} -c `)
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })
})

describe('runMicrovmTurn: worktree copy in and out', () => {
  test('copies the worktree in and the changed tree back out', async () => {
    const worktree = makeDir()
    const { opts, rig } = baseOptions({ worktree })
    const promise = runMicrovmTurn(opts)
    await flush()
    expect(rig.copyFromHostCalls).toContainEqual([worktree, CAGE_WORK_DIR])
    rig.resolveTurn({ stdout: 'ok' })
    await promise
    expect(rig.copyToHostCalls).toContainEqual([CAGE_WORK_DIR, worktree])
  })

  test('the copy-back cleanup removes node_modules and the synthetic .git pointer first', async () => {
    const { opts, rig } = baseOptions()
    const promise = runMicrovmTurn(opts)
    await flush()
    rig.resolveTurn({ stdout: 'ok' })
    await promise
    const cleanup = rig.shellCalls.find((c) => c.script.includes('node_modules'))
    expect(cleanup?.script).toContain(`rm -f ${CAGE_WORK_DIR}/.git`)
    expect(cleanup?.script).toContain('-prune -exec rm -rf {} +')
    expect(cleanup?.opts.user).toBe('root')
    const cleanupIndex = rig.shellCalls.indexOf(cleanup as ShellCall)
    const copyBackIndex = rig.copyToHostCalls.length > 0 ? rig.shellCalls.length : -1
    expect(cleanupIndex).toBeGreaterThan(-1)
    expect(copyBackIndex).toBeGreaterThan(-1)
  })

  test('a linked worktree: the shared git dir is copied in and .git is rewritten to a GUEST path', async () => {
    const { worktree } = makeLinkedWorktree()
    const { opts, rig } = baseOptions({ worktree })
    const promise = runMicrovmTurn(opts)
    await flush()
    expect(rig.copyFromHostCalls.some(([, guest]) => guest === CAGE_GIT_COMMON_DIR)).toBe(true)
    const pointer = rig.writeFileCalls.find(([path]) => path === `${CAGE_WORK_DIR}/.git`)
    expect(pointer?.[1]).toBe(`gitdir: ${CAGE_GIT_COMMON_DIR}/worktrees/wt\n`)
    expect(pointer?.[1]).not.toContain(worktree)
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })

  test('a plain directory with no git state copies through with no common-dir call', async () => {
    const worktree = makeDir()
    const { opts, rig } = baseOptions({ worktree })
    const promise = runMicrovmTurn(opts)
    await flush()
    expect(rig.copyFromHostCalls.some(([, guest]) => guest === CAGE_GIT_COMMON_DIR)).toBe(false)
    expect(rig.writeFileCalls).toHaveLength(0)
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })

  test('an attached repository gets its own guest directory, common dir and pointer', async () => {
    const { worktree } = makeLinkedWorktree()
    const attached = makeLinkedWorktree()
    const { opts, rig } = baseOptions({
      worktree,
      attachments: [{ name: 'sibling', worktree: attached.worktree }],
    })
    const promise = runMicrovmTurn(opts)
    await flush()
    expect(rig.copyFromHostCalls).toContainEqual([attached.worktree, `${CAGE_WORK_DIR}/sibling`])
    const attachedCommonDir = rig.copyFromHostCalls.find(
      ([host]) => host === attached.repo || host.endsWith('.git'),
    )
    expect(attachedCommonDir).toBeDefined()
    const pointer = rig.writeFileCalls.find(([path]) => path === `${CAGE_WORK_DIR}/sibling/.git`)
    expect(pointer?.[1]).toContain('gitdir: ')
    expect(pointer?.[1]).not.toContain(attached.worktree)
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })
})

describe('runMicrovmTurn: prompt, stdout, and the sandbox lifecycle', () => {
  test('the prompt is written to stdin, and stdout is resolved as the raw text', async () => {
    const { opts, rig } = baseOptions({ prompt: 'do the thing' })
    const promise = runMicrovmTurn(opts)
    await flush()
    expect(rig.turnShellCall()?.opts.input).toBe('do the thing')
    rig.pushText('{"type":"system"}\n')
    rig.pushText('{"type":"result"}\n')
    rig.resolveTurn({ code: 0 })
    const out = await promise
    expect(out).toBe('{"type":"system"}\n{"type":"result"}\n')
  })

  test('onText receives the CUMULATIVE text, the same contract as the container turn', async () => {
    const onTextCalls: string[] = []
    const { opts, rig } = baseOptions({ onText: (text) => onTextCalls.push(text) })
    const promise = runMicrovmTurn(opts)
    await flush()
    rig.pushText('a')
    rig.pushText('b')
    expect(onTextCalls).toEqual(['a', 'ab'])
    rig.resolveTurn({ stdout: 'ab' })
    await promise
  })

  test('a non-zero exit is a readable error, carrying stdout and stderr', async () => {
    const { opts, rig } = baseOptions()
    const promise = runMicrovmTurn(opts)
    await flush()
    rig.resolveTurn({ code: 1, stderr: 'boom' })
    await expect(promise).rejects.toThrow(/exit/i)
  })

  test('the sandbox is ALWAYS destroyed, on a clean success', async () => {
    const { opts, rig } = baseOptions()
    const promise = runMicrovmTurn(opts)
    await flush()
    rig.resolveTurn({ stdout: 'ok' })
    await promise
    expect(rig.destroyedNames).toEqual([rig.getSpec()!.name])
  })

  test('the sandbox is destroyed even when the exec rejects outright', async () => {
    const { opts, rig } = baseOptions()
    const promise = runMicrovmTurn(opts)
    await flush()
    rig.rejectTurn(new Error('sdk exploded'))
    await expect(promise).rejects.toThrow('sdk exploded')
    expect(rig.destroyedNames).toEqual([rig.getSpec()!.name])
  })

  test('the sandbox is destroyed even when a bootstrap step (useradd) itself fails', async () => {
    const rig = fakeMicrovmDriver()
    const originalShell = rig.handle.shell.bind(rig.handle)
    let failed = false
    rig.handle.shell = (script, o) => {
      if (!failed && script.includes('useradd')) {
        failed = true
        return Promise.reject(new Error('useradd: permission denied'))
      }
      return originalShell(script, o)
    }
    const opts: RunMicrovmTurnOptions = {
      taskId: 'a1b2c3d4e5f6',
      worktree: makeDir(),
      command: 'claude -p',
      prompt: 'p',
      timeoutMs: 60_000,
      driver: rig.driver,
      snapshotName: null,
      image: 'node:26',
      runbook: null,
      secrets: [],
      env: {},
    }
    await expect(runMicrovmTurn(opts)).rejects.toThrow(/permission denied/)
    expect(rig.destroyedNames).toEqual([rig.getSpec()!.name])
  })

  test('sandbox names are namespaced by task id under the dev role', async () => {
    const { opts, rig } = baseOptions({ taskId: 'deadbeefcafe' })
    const promise = runMicrovmTurn(opts)
    await flush()
    expect(rig.getSpec()?.name).toBe('codesema-dev-deadbeefcafe')
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })

  test('maxDurationSeconds covers the turn timeout plus a margin', async () => {
    const { opts, rig } = baseOptions({ timeoutMs: 120_000 })
    const promise = runMicrovmTurn(opts)
    await flush()
    expect(rig.getSpec()?.maxDurationSeconds).toBe(180)
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })
})

describe('runMicrovmTurn: watchdog, timeout and abort (T1.7 parity)', () => {
  const BUDGETS = { inactivityMs: 30 * 60_000, toolBudgetMs: 120 * 60_000, heartbeatMs: 30_000 }

  test('a mute turn is cut with inactivity_timeout, and the sandbox is still destroyed', async () => {
    const clock = fakeClock()
    const { opts, rig } = baseOptions({ clock, watchdog: BUDGETS, timeoutMs: 10 * 60 * 60_000 })
    const promise = runMicrovmTurn(opts)
    await flush()
    clock.advance(30 * 60_000)
    expect(rig.isTurnAborted()).toBe(true)
    rig.rejectTurn(new Error('aborted'))
    await expect(promise).rejects.toBeInstanceOf(AgentWatchdogError)
    expect(rig.destroyedNames).toEqual([rig.getSpec()!.name])
  })

  test('the absolute timeoutMs cap fires even with no watchdog expiry', async () => {
    const clock = fakeClock()
    const { opts, rig } = baseOptions({ clock, timeoutMs: 60_000 })
    const promise = runMicrovmTurn(opts)
    await flush()
    rig.pushText('{"type":"system"}\n')
    clock.advance(60_000)
    expect(rig.isTurnAborted()).toBe(true)
    rig.rejectTurn(new Error('aborted'))
    await expect(promise).rejects.toThrow(/timed out/)
    expect(rig.destroyedNames).toEqual([rig.getSpec()!.name])
  })

  test('an external abort signal interrupts the turn and destroys the sandbox', async () => {
    const controller = new AbortController()
    const { opts, rig } = baseOptions({ signal: controller.signal })
    const promise = runMicrovmTurn(opts)
    await flush()
    controller.abort()
    expect(rig.isTurnAborted()).toBe(true)
    rig.rejectTurn(new Error('aborted'))
    await expect(promise).rejects.toThrow('interrupted')
    expect(rig.destroyedNames).toEqual([rig.getSpec()!.name])
  })

  test('a heartbeat fires while the turn is alive but silent, within budget', async () => {
    const clock = fakeClock()
    const beats: unknown[] = []
    const { opts, rig } = baseOptions({
      clock,
      watchdog: BUDGETS,
      timeoutMs: 10 * 60 * 60_000,
      onHeartbeat: (beat) => beats.push(beat),
    })
    const promise = runMicrovmTurn(opts)
    await flush()
    clock.advance(30_000)
    expect(beats.length).toBeGreaterThan(0)
    expect(rig.isTurnAborted()).toBe(false)
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })
})

describe('runMicrovmTurn: destroy sequencing after a kill (F15)', () => {
  const BUDGETS = { inactivityMs: 30 * 60_000, toolBudgetMs: 120 * 60_000, heartbeatMs: 30_000 }

  test('the worktree is copied back BEFORE the sandbox is destroyed, after a watchdog cut', async () => {
    const clock = fakeClock()
    const { opts, rig } = baseOptions(
      { clock, watchdog: BUDGETS, timeoutMs: 10 * 60 * 60_000 },
      { controlDestroy: true },
    )
    const promise = runMicrovmTurn(opts)
    await flush()
    clock.advance(30 * 60_000)
    expect(rig.isTurnAborted()).toBe(true)
    rig.rejectTurn(new Error('aborted'))
    await flush()
    expect(rig.copyToHostCalls).toContainEqual([CAGE_WORK_DIR, opts.worktree])
    expect(rig.destroyedNames).toEqual([rig.getSpec()!.name])
    expect(rig.callOrder.indexOf('copyToHost')).toBeLessThan(rig.callOrder.indexOf('destroy'))
    rig.resolveDestroy()
    await expect(promise).rejects.toBeInstanceOf(AgentWatchdogError)
  })

  test('the worktree is copied back BEFORE the sandbox is destroyed, after the absolute timeout cap', async () => {
    const clock = fakeClock()
    const { opts, rig } = baseOptions({ clock, timeoutMs: 60_000 }, { controlDestroy: true })
    const promise = runMicrovmTurn(opts)
    await flush()
    clock.advance(60_000)
    expect(rig.isTurnAborted()).toBe(true)
    rig.rejectTurn(new Error('aborted'))
    await flush()
    expect(rig.copyToHostCalls).toContainEqual([CAGE_WORK_DIR, opts.worktree])
    expect(rig.callOrder.indexOf('copyToHost')).toBeLessThan(rig.callOrder.indexOf('destroy'))
    rig.resolveDestroy()
    await expect(promise).rejects.toThrow(/timed out/)
  })

  test('an external abort does not let the turn settle before the (single) destroy call actually resolves', async () => {
    const controller = new AbortController()
    const { opts, rig } = baseOptions({ signal: controller.signal }, { controlDestroy: true })
    const promise = runMicrovmTurn(opts)
    await flush()
    controller.abort()
    expect(rig.isTurnAborted()).toBe(true)
    rig.rejectTurn(new Error('aborted'))
    await flush()
    // The copy-back already ran and destroy() has already been invoked once,
    // but its promise is still pending: the turn must not have settled yet.
    expect(rig.copyToHostCalls).toContainEqual([CAGE_WORK_DIR, opts.worktree])
    expect(rig.destroyedNames).toEqual([rig.getSpec()!.name])
    let settled = false
    promise.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await flush()
    expect(settled).toBe(false)
    rig.resolveDestroy()
    await expect(promise).rejects.toThrow('interrupted')
    expect(settled).toBe(true)
    // Only ever one real driver.destroy() call for the whole turn.
    expect(rig.destroyedNames).toEqual([rig.getSpec()!.name])
  })
})

describe('runMicrovmTurn: guest user validation (M10)', () => {
  test('rejects a guest user carrying shell metacharacters before ever touching the driver', async () => {
    const { opts, rig } = baseOptions({ user: 'agent; rm -rf /' })
    await expect(runMicrovmTurn(opts)).rejects.toThrow(/invalid guest user/)
    expect(rig.getSpec()).toBeNull()
    expect(rig.shellCalls).toHaveLength(0)
  })

  test('rejects a guest user starting with a digit or containing whitespace', async () => {
    const { opts: withDigit } = baseOptions({ user: '2agent' })
    await expect(runMicrovmTurn(withDigit)).rejects.toThrow(/invalid guest user/)
    const { opts: withSpace } = baseOptions({ user: 'agent two' })
    await expect(runMicrovmTurn(withSpace)).rejects.toThrow(/invalid guest user/)
  })

  test('accepts a guest user with digits, underscores and dashes, and uses it unmodified', async () => {
    const { opts, rig } = baseOptions({ user: 'runner-2_x' })
    const promise = runMicrovmTurn(opts)
    await flush()
    expect(rig.shellCalls[0]?.script).toContain('useradd -m -s /bin/bash runner-2_x')
    rig.resolveTurn({ stdout: 'ok' })
    await promise
  })
})
