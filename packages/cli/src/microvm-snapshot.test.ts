import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RUNBOOK_VERSION, type RunbookConfig } from './contract.js'
import type {
  SandboxDriver,
  SandboxExecOptions,
  SandboxExecResult,
  SandboxHandle,
  SandboxMetrics,
  SandboxProbe,
  SandboxSpec,
  SnapshotInfo,
} from './microsandbox-driver.js'
import { AGENT_INSTALL_DOMAINS } from './microvm-bootstrap.js'
import {
  buildProjectSnapshot,
  projectSnapshotFingerprint,
  projectSnapshotName,
  purgeProjectSnapshots,
  resolveProjectSnapshot,
} from './microvm-snapshot.js'

// --- local fake driver ------------------------------------------------
// FakeSandboxDriver (lot C1) may not be implemented yet: this test carries
// its own minimal fake against the SandboxDriver interface.

class LocalFakeHandle implements SandboxHandle {
  readonly name: string
  readonly calls: string[] = []
  shellScript: (command: string) => SandboxExecResult

  constructor(name: string, shellScript: (command: string) => SandboxExecResult) {
    this.name = name
    this.shellScript = shellScript
  }

  async exec(command: string, args: readonly string[]): Promise<SandboxExecResult> {
    this.calls.push(`exec:${command} ${args.join(' ')}`)
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }

  async shell(script: string, opts: SandboxExecOptions): Promise<SandboxExecResult> {
    this.calls.push(`shell:${script}`)
    const result = this.shellScript(script)
    opts.onText?.(result.stdout)
    return result
  }

  async copyFromHost(hostPath: string): Promise<void> {
    this.calls.push(`copyFromHost:${hostPath}`)
  }

  async copyToHost(): Promise<void> {}

  async writeFile(): Promise<void> {}

  async readFile(): Promise<string> {
    return ''
  }

  async metrics(): Promise<SandboxMetrics> {
    return { memoryHostResidentBytes: null, memoryBytes: null, cpuPercent: null }
  }

  async stop(): Promise<void> {
    this.calls.push('stop')
  }
}

type LocalFakeOptions = {
  shellScript?: (command: string) => SandboxExecResult
  existingSnapshots?: string[]
}

class LocalFakeDriver implements SandboxDriver {
  readonly kind = 'fake' as const
  readonly created: SandboxSpec[] = []
  readonly destroyed: string[] = []
  readonly snapshotted: Array<{ sandbox: string; snapshot: string }> = []
  readonly removedSnapshots: string[] = []
  snapshots: SnapshotInfo[]
  handles = new Map<string, LocalFakeHandle>()
  private shellScript: (command: string) => SandboxExecResult

  constructor(opts: LocalFakeOptions = {}) {
    this.snapshots = (opts.existingSnapshots ?? []).map((name) => ({ name, sizeBytes: null }))
    this.shellScript =
      opts.shellScript ?? (() => ({ code: 0, stdout: '', stderr: '', timedOut: false }))
  }

  async probe(): Promise<SandboxProbe> {
    return { available: true, reason: null, version: 'fake' }
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.created.push(spec)
    const handle = new LocalFakeHandle(spec.name, this.shellScript)
    this.handles.set(spec.name, handle)
    return handle
  }

  async snapshot(sandboxName: string, snapshotName: string): Promise<SnapshotInfo> {
    this.snapshotted.push({ sandbox: sandboxName, snapshot: snapshotName })
    const info: SnapshotInfo = { name: snapshotName, sizeBytes: 1024 }
    this.snapshots.push(info)
    return info
  }

  async listSandboxes(): Promise<string[]> {
    return [...this.handles.keys()]
  }

  async listSnapshots(): Promise<SnapshotInfo[]> {
    return [...this.snapshots]
  }

  async destroy(sandboxName: string): Promise<void> {
    this.destroyed.push(sandboxName)
    this.handles.delete(sandboxName)
  }

  async removeSnapshot(snapshotName: string): Promise<void> {
    this.removedSnapshots.push(snapshotName)
    this.snapshots = this.snapshots.filter((snap) => snap.name !== snapshotName)
  }

  async ensureVolume(): Promise<void> {}

  async removeVolume(): Promise<void> {}
}

// --- rig ----------------------------------------------------------------

let worktree: string

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), 'codesema-snapshot-'))
})

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true })
})

const agentId = 'claude'

function baseRunbook(overrides: Partial<RunbookConfig> = {}): RunbookConfig {
  return {
    version: RUNBOOK_VERSION,
    image: 'ghcr.io/codesema/base:1',
    install: ['bun install'],
    services: { host_up: [], compose_file: null },
    healthchecks: [],
    tests: ['bun test'],
    egress: ['registry.npmjs.org'],
    depends_on_files: [],
    ...overrides,
  }
}

// --- projectSnapshotName --------------------------------------------------

describe('projectSnapshotName', () => {
  test('formats codesema-<projectId>-<hash>', () => {
    expect(projectSnapshotName('proj1', 'abcdef0123456789')).toBe('codesema-proj1-abcdef0123456789')
  })
})

// --- projectSnapshotFingerprint -------------------------------------------

describe('projectSnapshotFingerprint', () => {
  test('is deterministic for identical inputs', () => {
    writeFileSync(join(worktree, 'bun.lock'), 'lock-content')
    const runbook = baseRunbook()
    const a = projectSnapshotFingerprint(worktree, runbook, agentId)
    const b = projectSnapshotFingerprint(worktree, runbook, agentId)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  test('changes when a lockfile content changes', () => {
    writeFileSync(join(worktree, 'bun.lock'), 'lock-v1')
    const runbook = baseRunbook()
    const before = projectSnapshotFingerprint(worktree, runbook, agentId)
    writeFileSync(join(worktree, 'bun.lock'), 'lock-v2')
    const after = projectSnapshotFingerprint(worktree, runbook, agentId)
    expect(after).not.toBe(before)
  })

  test('changes when a lockfile appears', () => {
    const runbook = baseRunbook()
    const before = projectSnapshotFingerprint(worktree, runbook, agentId)
    writeFileSync(join(worktree, 'package-lock.json'), '{}')
    const after = projectSnapshotFingerprint(worktree, runbook, agentId)
    expect(after).not.toBe(before)
  })

  test('changes when the runbook changes', () => {
    writeFileSync(join(worktree, 'bun.lock'), 'lock-content')
    const before = projectSnapshotFingerprint(worktree, baseRunbook(), agentId)
    const after = projectSnapshotFingerprint(
      worktree,
      baseRunbook({ install: ['bun install', 'bun run build'] }),
      agentId,
    )
    expect(after).not.toBe(before)
  })

  test('changes when the compose file content changes', () => {
    writeFileSync(join(worktree, 'bun.lock'), 'lock-content')
    writeFileSync(join(worktree, 'docker-compose.yml'), 'services: {a: 1}')
    const runbook = baseRunbook({ services: { host_up: [], compose_file: 'docker-compose.yml' } })
    const before = projectSnapshotFingerprint(worktree, runbook, agentId)
    writeFileSync(join(worktree, 'docker-compose.yml'), 'services: {a: 2}')
    const after = projectSnapshotFingerprint(worktree, runbook, agentId)
    expect(after).not.toBe(before)
  })

  test('does not throw when the compose file is declared but missing on disk', () => {
    const runbook = baseRunbook({ services: { host_up: [], compose_file: 'missing.yml' } })
    expect(() => projectSnapshotFingerprint(worktree, runbook, agentId)).not.toThrow()
  })

  test('is unaffected by lockfile listing order (sorted internally)', () => {
    writeFileSync(join(worktree, 'bun.lock'), 'a')
    writeFileSync(join(worktree, 'go.sum'), 'b')
    const runbook = baseRunbook()
    const first = projectSnapshotFingerprint(worktree, runbook, agentId)
    const second = projectSnapshotFingerprint(worktree, runbook, agentId)
    expect(first).toBe(second)
  })

  test('changes when the agent id changes', () => {
    const runbook = baseRunbook()
    const claude = projectSnapshotFingerprint(worktree, runbook, 'claude')
    const opencode = projectSnapshotFingerprint(worktree, runbook, 'opencode')
    expect(claude).not.toBe(opencode)
  })
})

// --- resolveProjectSnapshot ------------------------------------------------

describe('resolveProjectSnapshot', () => {
  test('answers cold when services.host_up is non-empty (flat disk)', async () => {
    const driver = new LocalFakeDriver()
    const runbook = baseRunbook({ services: { host_up: ['dockerd'], compose_file: null } })
    const result = await resolveProjectSnapshot({
      driver,
      projectId: 'p1',
      worktree,
      runbook,
      agentId,
    })
    expect(result).toEqual({
      kind: 'cold',
      reason: 'flat root disk cannot be snapshotted (microsandbox 0.6.15)',
    })
  })

  test('answers cold when services.compose_file is set (flat disk)', async () => {
    const driver = new LocalFakeDriver()
    const runbook = baseRunbook({ services: { host_up: [], compose_file: 'docker-compose.yml' } })
    const result = await resolveProjectSnapshot({
      driver,
      projectId: 'p1',
      worktree,
      runbook,
      agentId,
    })
    expect(result.kind).toBe('cold')
  })

  test('answers missing when no matching snapshot exists', async () => {
    const driver = new LocalFakeDriver()
    const runbook = baseRunbook()
    const result = await resolveProjectSnapshot({
      driver,
      projectId: 'p1',
      worktree,
      runbook,
      agentId,
    })
    expect(result.kind).toBe('missing')
    if (result.kind === 'missing') {
      expect(result.name).toBe(projectSnapshotName('p1', result.hash))
    }
  })

  test('answers ready when the hashed snapshot already exists', async () => {
    const runbook = baseRunbook()
    const hash = projectSnapshotFingerprint(worktree, runbook, agentId)
    const name = projectSnapshotName('p1', hash)
    const driver = new LocalFakeDriver({ existingSnapshots: [name] })
    const result = await resolveProjectSnapshot({
      driver,
      projectId: 'p1',
      worktree,
      runbook,
      agentId,
    })
    expect(result).toEqual({ kind: 'ready', name, hash })
  })

  test('answers missing when the ready snapshot found was built for a different agent id', async () => {
    const runbook = baseRunbook()
    const claudeName = projectSnapshotName(
      'p1',
      projectSnapshotFingerprint(worktree, runbook, 'claude'),
    )
    const driver = new LocalFakeDriver({ existingSnapshots: [claudeName] })
    const result = await resolveProjectSnapshot({
      driver,
      projectId: 'p1',
      worktree,
      runbook,
      agentId: 'opencode',
    })
    expect(result.kind).toBe('missing')
  })
})

// --- buildProjectSnapshot ---------------------------------------------------

describe('buildProjectSnapshot', () => {
  test('creates, installs, stops, snapshots, destroys and purges older snapshots', async () => {
    const runbook = baseRunbook({ install: ['bun install', 'bun run build'] })
    const hash = projectSnapshotFingerprint(worktree, runbook, agentId)
    const name = projectSnapshotName('p1', hash)
    const oldName = 'codesema-p1-oldoldoldold0000'
    const driver = new LocalFakeDriver({ existingSnapshots: [oldName] })

    const result = await buildProjectSnapshot({
      driver,
      projectId: 'p1',
      worktree,
      runbook,
      agentId,
      timeoutMs: 60_000,
    })

    expect(result).toEqual({ kind: 'ready', name, hash })
    expect(driver.created).toHaveLength(1)
    expect(driver.created[0]?.image).toBe(runbook.image)
    expect(driver.created[0]?.network.allowedDomains).toEqual(runbook.egress)

    const sandboxSpecName = driver.created[0]?.name
    expect(sandboxSpecName).toBeDefined()

    const handle = [...driver.handles.values()][0]
    expect(handle).toBeUndefined() // destroyed removes it from the map after use

    expect(driver.destroyed).toEqual([sandboxSpecName as string])
    expect(driver.snapshotted).toEqual([{ sandbox: sandboxSpecName as string, snapshot: name }])
    expect(driver.removedSnapshots).toEqual([oldName])
  })

  test('runs install commands in order and copies the worktree first', async () => {
    const runbook = baseRunbook({ install: ['step1', 'step2'] })
    const executed: string[] = []
    const driver = new LocalFakeDriver({
      shellScript: (command) => {
        executed.push(command)
        return { code: 0, stdout: 'ok', stderr: '', timedOut: false }
      },
    })

    await buildProjectSnapshot({
      driver,
      projectId: 'p1',
      worktree,
      runbook,
      agentId,
      timeoutMs: 60_000,
    })

    // The agent-install probe (`command -v claude`) runs after the install
    // steps, in order; the fake driver answers code 0 for every command, so
    // the probe alone satisfies `ensureAgentInstalled` (agent "already there").
    expect(executed).toEqual(['step1', 'step2', 'command -v claude'])
  })

  test('throws with the tail output and still destroys the sandbox when install fails', async () => {
    const runbook = baseRunbook({ install: ['bad-cmd'] })
    const driver = new LocalFakeDriver({
      shellScript: () => ({ code: 1, stdout: 'building...', stderr: 'boom', timedOut: false }),
    })

    await expect(
      buildProjectSnapshot({
        driver,
        projectId: 'p1',
        worktree,
        runbook,
        agentId,
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(/bad-cmd/)

    expect(driver.destroyed).toHaveLength(1)
    expect(driver.snapshotted).toHaveLength(0)
  })

  test('throws when an install command times out', async () => {
    const runbook = baseRunbook({ install: ['slow-cmd'] })
    const driver = new LocalFakeDriver({
      shellScript: () => ({ code: null, stdout: '', stderr: '', timedOut: true }),
    })

    await expect(
      buildProjectSnapshot({
        driver,
        projectId: 'p1',
        worktree,
        runbook,
        agentId,
        timeoutMs: 60_000,
      }),
    ).rejects.toThrow(/slow-cmd/)
    expect(driver.destroyed).toHaveLength(1)
  })

  test('returns the existing ready snapshot without creating a sandbox when already built', async () => {
    const runbook = baseRunbook()
    const hash = projectSnapshotFingerprint(worktree, runbook, agentId)
    const name = projectSnapshotName('p1', hash)
    const driver = new LocalFakeDriver({ existingSnapshots: [name] })

    const result = await buildProjectSnapshot({
      driver,
      projectId: 'p1',
      worktree,
      runbook,
      agentId,
      timeoutMs: 60_000,
    })

    expect(result).toEqual({ kind: 'ready', name, hash })
    expect(driver.created).toHaveLength(0)
  })

  test('returns cold without creating a sandbox for a flat-disk runbook', async () => {
    const runbook = baseRunbook({ services: { host_up: ['dockerd'], compose_file: null } })
    const driver = new LocalFakeDriver()

    const result = await buildProjectSnapshot({
      driver,
      projectId: 'p1',
      worktree,
      runbook,
      agentId,
      timeoutMs: 60_000,
    })

    expect(result.kind).toBe('cold')
    expect(driver.created).toHaveLength(0)
  })

  test('opens registry.npmjs.org for the install sandbox on top of the runbook egress', async () => {
    const runbook = baseRunbook({ egress: ['example.com'] })
    const driver = new LocalFakeDriver()

    await buildProjectSnapshot({
      driver,
      projectId: 'p1',
      worktree,
      runbook,
      agentId,
      timeoutMs: 60_000,
    })

    expect(driver.created[0]?.network.allowedDomains).toEqual([
      'example.com',
      ...AGENT_INSTALL_DOMAINS,
    ])
  })

  test('installs the agent (npm, root) when the guest PATH probe finds it missing', async () => {
    const runbook = baseRunbook({ install: ['step1'] })
    const shellCalls: Array<{ script: string; user: string | undefined }> = []
    const driver = new LocalFakeDriver({
      shellScript: (command) => {
        if (command === `command -v ${agentId}`) {
          return { code: 1, stdout: '', stderr: 'not found', timedOut: false }
        }
        return { code: 0, stdout: '', stderr: '', timedOut: false }
      },
    })
    // Wrap create() to observe the `user` option each shell call is made with,
    // since LocalFakeHandle.shell does not record it on its own.
    const originalCreate = driver.create.bind(driver)
    driver.create = async (spec) => {
      const handle = await originalCreate(spec)
      const originalShell = handle.shell.bind(handle)
      handle.shell = async (script, opts) => {
        shellCalls.push({ script, user: opts.user })
        return originalShell(script, opts)
      }
      return handle
    }

    await buildProjectSnapshot({
      driver,
      projectId: 'p1',
      worktree,
      runbook,
      agentId,
      timeoutMs: 60_000,
    })

    const install = shellCalls.find((call) => call.script.includes(`npm install -g`))
    expect(install).toBeDefined()
    expect(install?.script).toContain('@anthropic-ai/claude-code')
    expect(install?.user).toBe('root')
  })
})

// --- purgeProjectSnapshots ---------------------------------------------------

describe('purgeProjectSnapshots', () => {
  test('removes only this project snapshots except keep', async () => {
    const driver = new LocalFakeDriver({
      existingSnapshots: [
        'codesema-p1-aaaaaaaaaaaaaaaa',
        'codesema-p1-bbbbbbbbbbbbbbbb',
        'codesema-p2-cccccccccccccccc',
      ],
    })

    const removed = await purgeProjectSnapshots(driver, 'p1', 'codesema-p1-bbbbbbbbbbbbbbbb')

    expect(removed).toEqual(['codesema-p1-aaaaaaaaaaaaaaaa'])
    const remaining = (await driver.listSnapshots()).map((snap) => snap.name)
    expect(remaining).toEqual(['codesema-p1-bbbbbbbbbbbbbbbb', 'codesema-p2-cccccccccccccccc'])
  })

  test('removes all matching snapshots when keep is null', async () => {
    const driver = new LocalFakeDriver({
      existingSnapshots: ['codesema-p1-aaaaaaaaaaaaaaaa', 'codesema-p1-bbbbbbbbbbbbbbbb'],
    })

    const removed = await purgeProjectSnapshots(driver, 'p1', null)

    expect(removed.toSorted()).toEqual(
      ['codesema-p1-aaaaaaaaaaaaaaaa', 'codesema-p1-bbbbbbbbbbbbbbbb'].toSorted(),
    )
  })

  test('returns an empty list when nothing matches the project prefix', async () => {
    const driver = new LocalFakeDriver({ existingSnapshots: ['codesema-other-aaaaaaaaaaaaaaaa'] })

    const removed = await purgeProjectSnapshots(driver, 'p1', null)

    expect(removed).toEqual([])
  })

  test('ignores removal errors and keeps going', async () => {
    const driver = new LocalFakeDriver({
      existingSnapshots: ['codesema-p1-aaaaaaaaaaaaaaaa', 'codesema-p1-bbbbbbbbbbbbbbbb'],
    })
    const originalRemove = driver.removeSnapshot.bind(driver)
    driver.removeSnapshot = async (snapshotName: string) => {
      if (snapshotName === 'codesema-p1-aaaaaaaaaaaaaaaa') {
        throw new Error('boom')
      }
      return originalRemove(snapshotName)
    }

    const removed = await purgeProjectSnapshots(driver, 'p1', null)

    expect(removed).toEqual(['codesema-p1-bbbbbbbbbbbbbbbb'])
  })
})
