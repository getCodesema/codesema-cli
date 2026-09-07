import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { RunbookConfig, TaskVerification } from './contract.js'
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
import {
  changedDependencyFiles,
  readTaskVerification,
  removeTaskVerification,
  verifyTask,
  writeTaskVerification,
} from './task-verification.js'
import { createTask } from './tasks-store.js'

const cleanups: string[] = []

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'codesema-task-verification-'))
  cleanups.push(repo)
  const run = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  run(['init', '-b', 'main'])
  run(['config', 'user.email', 't@t'])
  run(['config', 'user.name', 't'])
  writeFileSync(join(repo, 'package.json'), '{"name":"a"}\n')
  writeFileSync(join(repo, 'bun.lock'), 'v1\n')
  run(['add', '-A'])
  run(['commit', '-m', 'init: base'])
  return repo
}

function commitSha(repo: string): string {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
}

function baseRunbook(overrides: Partial<RunbookConfig> = {}): RunbookConfig {
  return {
    version: 1,
    image: 'node:26',
    install: ['npm install'],
    services: { host_up: [], compose_file: null },
    healthchecks: [],
    tests: ['npm test'],
    egress: ['registry.npmjs.org'],
    depends_on_files: ['package.json', 'bun.lock'],
    ...overrides,
  }
}

describe('changedDependencyFiles', () => {
  test('nothing changed since the validated sha', () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    expect(changedDependencyFiles(repo, baseRunbook(), sha)).toEqual([])
  })

  test('a modified file is reported', () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    writeFileSync(join(repo, 'package.json'), '{"name":"b"}\n')
    expect(changedDependencyFiles(repo, baseRunbook(), sha)).toEqual(['package.json'])
  })

  test('a file removed from the worktree is reported changed', () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    unlinkSync(join(repo, 'bun.lock'))
    expect(changedDependencyFiles(repo, baseRunbook(), sha)).toEqual(['bun.lock'])
  })

  test('a file absent from depends_on_files is never checked', () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    writeFileSync(join(repo, 'other.txt'), 'x\n')
    expect(changedDependencyFiles(repo, baseRunbook(), sha)).toEqual([])
  })

  test('an unresolvable validated sha counts every entry as changed', () => {
    const repo = makeRepo()
    expect(
      changedDependencyFiles(repo, baseRunbook(), '0000000000000000000000000000000000dead'),
    ).toEqual(['package.json', 'bun.lock'])
  })

  test('an empty depends_on_files list changes nothing, always', () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    expect(changedDependencyFiles(repo, baseRunbook({ depends_on_files: [] }), sha)).toEqual([])
  })
})

type FakeCall = { method: string; args: unknown[] }

function fakeDriver(
  script: (command: string, args: readonly string[], opts: SandboxExecOptions) => SandboxExecResult,
): { driver: SandboxDriver; calls: FakeCall[] } {
  const calls: FakeCall[] = []
  const handle: SandboxHandle = {
    name: 'codesema-verify-fake',
    exec: (command, args, opts) => {
      calls.push({ method: 'exec', args: [command, args] })
      return Promise.resolve(script(command, args, opts))
    },
    shell: (script_, opts) => {
      calls.push({ method: 'shell', args: [script_] })
      return Promise.resolve(script(script_, [], opts))
    },
    copyFromHost: (hostPath, guestPath) => {
      calls.push({ method: 'copyFromHost', args: [hostPath, guestPath] })
      return Promise.resolve()
    },
    copyToHost: () => Promise.resolve(),
    writeFile: () => Promise.resolve(),
    readFile: () => Promise.resolve(''),
    metrics: (): Promise<SandboxMetrics> =>
      Promise.resolve({ memoryHostResidentBytes: null, memoryBytes: null, cpuPercent: null }),
    stop: () => Promise.resolve(),
  }
  const driver: SandboxDriver = {
    kind: 'fake',
    probe: (): Promise<SandboxProbe> =>
      Promise.resolve({ available: true, reason: null, version: 'fake' }),
    create: (spec: SandboxSpec) => {
      calls.push({ method: 'create', args: [spec] })
      return Promise.resolve(handle)
    },
    snapshot: (): Promise<SnapshotInfo> => Promise.resolve({ name: 'x', sizeBytes: null }),
    listSandboxes: () => Promise.resolve([]),
    listSnapshots: () => Promise.resolve([]),
    destroy: (sandboxName: string) => {
      calls.push({ method: 'destroy', args: [sandboxName] })
      return Promise.resolve()
    },
    removeSnapshot: () => Promise.resolve(),
    ensureVolume: () => Promise.resolve(),
    removeVolume: () => Promise.resolve(),
  }
  return { driver, calls }
}

const ok = (over: Partial<SandboxExecResult> = {}): SandboxExecResult => ({
  code: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  ...over,
})

describe('verifyTask', () => {
  test('a changed dependency file refuses without ever creating a sandbox', async () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    writeFileSync(join(repo, 'package.json'), '{"name":"changed"}\n')
    const { driver, calls } = fakeDriver(() => ok())
    const result = await verifyTask({
      driver,
      worktree: repo,
      projectId: 'p1',
      taskId: 't1',
      headSha: 'headsha1',
      runbook: baseRunbook(),
      runbookSha: '0123456789abcdef',
      validatedSha: sha,
      snapshotName: 'codesema-p1-hash',
      timeoutMs: 5000,
    })
    expect(result.status).toBe('refused')
    expect(result.integrity_ok).toBe(false)
    expect(result.changed_dependency_files).toEqual(['package.json'])
    expect(result.checks).toEqual([])
    expect(calls.some((c) => c.method === 'create')).toBe(false)
  })

  test('a warm snapshot boot denies all network and skips install', async () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    const { driver, calls } = fakeDriver(() => ok())
    const result = await verifyTask({
      driver,
      worktree: repo,
      projectId: 'p1',
      taskId: 't1',
      headSha: 'headsha1',
      runbook: baseRunbook(),
      runbookSha: '0123456789abcdef',
      validatedSha: sha,
      snapshotName: 'codesema-p1-hash',
      timeoutMs: 5000,
    })
    expect(result.status).toBe('passed')
    expect(result.integrity_ok).toBe(true)
    expect(result.checks).toHaveLength(1)
    expect(result.checks[0]?.command).toBe('npm test')
    expect(result.checks[0]?.status).toBe('passed')
    const create = calls.find((c) => c.method === 'create')
    const spec = create?.args[0] as SandboxSpec
    expect(spec.fromSnapshot).toBe('codesema-p1-hash')
    expect(spec.image).toBeUndefined()
    expect(spec.network.allowedDomains).toEqual([])
    // No install command ran: only the test's shell call, plus copyFromHost.
    expect(calls.filter((c) => c.method === 'shell')).toHaveLength(1)
    expect(calls.some((c) => c.method === 'destroy')).toBe(true)
  })

  test('a cold boot runs install with the runbook egress opened', async () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    const { driver, calls } = fakeDriver(() => ok())
    const result = await verifyTask({
      driver,
      worktree: repo,
      projectId: 'p1',
      taskId: 't1',
      headSha: 'headsha1',
      runbook: baseRunbook(),
      runbookSha: '0123456789abcdef',
      validatedSha: sha,
      snapshotName: null,
      timeoutMs: 5000,
    })
    expect(result.status).toBe('passed')
    const create = calls.find((c) => c.method === 'create')
    const spec = create?.args[0] as SandboxSpec
    expect(spec.image).toBe('node:26')
    expect(spec.fromSnapshot).toBeUndefined()
    expect(spec.network.allowedDomains).toEqual(['registry.npmjs.org'])
    const shells = calls.filter((c) => c.method === 'shell').map((c) => c.args[0])
    expect(shells).toEqual(['npm install', 'npm test'])
  })

  test('a failing install step errors out before any test runs', async () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    const { driver, calls } = fakeDriver((command) =>
      command === 'npm install' ? ok({ code: 1, stderr: 'boom' }) : ok(),
    )
    const result = await verifyTask({
      driver,
      worktree: repo,
      projectId: 'p1',
      taskId: 't1',
      headSha: 'headsha1',
      runbook: baseRunbook(),
      runbookSha: '0123456789abcdef',
      validatedSha: sha,
      snapshotName: null,
      timeoutMs: 5000,
    })
    expect(result.status).toBe('error')
    expect(result.checks).toEqual([])
    expect(result.error).toContain('npm install')
    expect(result.error).toContain('boom')
    expect(calls.filter((c) => c.method === 'shell')).toHaveLength(1)
    expect(calls.some((c) => c.method === 'destroy')).toBe(true)
  })

  test('a failing test still lets the remaining tests run, and the verdict is failed', async () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    const { driver } = fakeDriver((command) => (command === 'npm test' ? ok({ code: 1 }) : ok()))
    const result = await verifyTask({
      driver,
      worktree: repo,
      projectId: 'p1',
      taskId: 't1',
      headSha: 'headsha1',
      runbook: baseRunbook({ tests: ['npm test', 'npm run lint'] }),
      runbookSha: '0123456789abcdef',
      validatedSha: sha,
      snapshotName: 'codesema-p1-hash',
      timeoutMs: 5000,
    })
    expect(result.status).toBe('failed')
    expect(result.checks).toHaveLength(2)
    expect(result.checks[0]?.status).toBe('failed')
    expect(result.checks[1]?.status).toBe('passed')
  })

  test('a timed out test is reported as timeout, not failed', async () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    const { driver } = fakeDriver(() => ok({ timedOut: true, code: null }))
    const result = await verifyTask({
      driver,
      worktree: repo,
      projectId: 'p1',
      taskId: 't1',
      headSha: 'headsha1',
      runbook: baseRunbook(),
      runbookSha: '0123456789abcdef',
      validatedSha: sha,
      snapshotName: 'codesema-p1-hash',
      timeoutMs: 5000,
    })
    expect(result.status).toBe('failed')
    expect(result.checks[0]?.status).toBe('timeout')
    expect(result.checks[0]?.exit_code).toBeNull()
  })

  test('healthchecks retry until the deadline, then error out', async () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    const { driver, calls } = fakeDriver((command) =>
      command === 'curl -f http://localhost:3000' ? ok({ code: 1, stderr: 'not up' }) : ok(),
    )
    const result = await verifyTask({
      driver,
      worktree: repo,
      projectId: 'p1',
      taskId: 't1',
      headSha: 'headsha1',
      runbook: baseRunbook({ healthchecks: ['curl -f http://localhost:3000'] }),
      runbookSha: '0123456789abcdef',
      validatedSha: sha,
      snapshotName: 'codesema-p1-hash',
      timeoutMs: 5000,
      healthcheckDeadlineMs: 10,
      healthcheckRetryDelayMs: 1,
    })
    expect(result.status).toBe('error')
    expect(result.error).toContain('curl -f http://localhost:3000')
    // The retry loop tried the healthcheck at least once, but the test step
    // never runs once healthchecks never pass.
    const shellCommands = calls.filter((c) => c.method === 'shell').map((c) => c.args[0])
    expect(shellCommands.length).toBeGreaterThan(0)
    expect(shellCommands).not.toContain('npm test')
  })

  test('a healthcheck that eventually passes lets the tests run', async () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    let attempts = 0
    const { driver } = fakeDriver((command) => {
      if (command === 'curl -f http://localhost:3000') {
        attempts += 1
        return attempts < 2 ? ok({ code: 1 }) : ok()
      }
      return ok()
    })
    const result = await verifyTask({
      driver,
      worktree: repo,
      projectId: 'p1',
      taskId: 't1',
      headSha: 'headsha1',
      runbook: baseRunbook({ healthchecks: ['curl -f http://localhost:3000'] }),
      runbookSha: '0123456789abcdef',
      validatedSha: sha,
      snapshotName: 'codesema-p1-hash',
      timeoutMs: 5000,
      healthcheckDeadlineMs: 5000,
      healthcheckRetryDelayMs: 1,
    })
    expect(result.status).toBe('passed')
    expect(attempts).toBeGreaterThanOrEqual(2)
  })

  test('a service that fails to start errors out before healthchecks or tests', async () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    const { driver, calls } = fakeDriver((command) =>
      command.includes('nohup') ? ok({ code: 1 }) : ok(),
    )
    const result = await verifyTask({
      driver,
      worktree: repo,
      projectId: 'p1',
      taskId: 't1',
      headSha: 'headsha1',
      runbook: baseRunbook({
        services: { host_up: ['docker compose up -d'], compose_file: 'docker-compose.yml' },
        healthchecks: ['curl -f http://localhost:3000'],
      }),
      runbookSha: '0123456789abcdef',
      validatedSha: sha,
      snapshotName: 'codesema-p1-hash',
      timeoutMs: 5000,
    })
    expect(result.status).toBe('error')
    expect(result.error).toContain('docker compose up -d')
    expect(calls.filter((c) => c.method === 'shell')).toHaveLength(1)
  })

  test('a service is launched in the background with nohup, one shell call per service', async () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    const { driver, calls } = fakeDriver(() => ok())
    const result = await verifyTask({
      driver,
      worktree: repo,
      projectId: 'p1',
      taskId: 't1',
      headSha: 'headsha1',
      runbook: baseRunbook({
        services: { host_up: ['npm start'], compose_file: null },
      }),
      runbookSha: '0123456789abcdef',
      validatedSha: sha,
      snapshotName: 'codesema-p1-hash',
      timeoutMs: 5000,
    })
    expect(result.status).toBe('passed')
    const shellCommands = calls.filter((c) => c.method === 'shell').map((c) => c.args[0])
    expect(shellCommands[0]).toContain('nohup')
    expect(shellCommands[0]).toContain('/tmp/codesema-service-0.log')
  })

  test('a single quote in the service command is escaped in the background script', async () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    const { driver, calls } = fakeDriver(() => ok())
    await verifyTask({
      driver,
      worktree: repo,
      projectId: 'p1',
      taskId: 't1',
      headSha: 'headsha1',
      runbook: baseRunbook({
        services: { host_up: ["echo it's up"], compose_file: null },
      }),
      runbookSha: '0123456789abcdef',
      validatedSha: sha,
      snapshotName: 'codesema-p1-hash',
      timeoutMs: 5000,
    })
    const shellCommands = calls.filter((c) => c.method === 'shell').map((c) => c.args[0])
    expect(shellCommands[0]).toBe(
      "nohup sh -c 'echo it'\\''s up' > /tmp/codesema-service-0.log 2>&1 &",
    )
  })

  test('the sandbox is created with the exact sandboxName for the task, never a generic one', async () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    const { driver, calls } = fakeDriver(() => ok())
    await verifyTask({
      driver,
      worktree: repo,
      projectId: 'p1',
      taskId: 'abc123def456',
      headSha: 'headsha1',
      runbook: baseRunbook(),
      runbookSha: '0123456789abcdef',
      validatedSha: sha,
      snapshotName: 'codesema-p1-hash',
      timeoutMs: 5000,
    })
    const create = calls.find((c) => c.method === 'create')
    const spec = create?.args[0] as SandboxSpec
    expect(spec.name).toBe('codesema-verify-abc123def456')
  })

  test('a sandbox that never boots is reported as an error, and destroy is not attempted on a handle that never existed', async () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    const calls: FakeCall[] = []
    const driver: SandboxDriver = {
      kind: 'fake',
      probe: (): Promise<SandboxProbe> =>
        Promise.resolve({ available: true, reason: null, version: 'fake' }),
      create: () => {
        calls.push({ method: 'create', args: [] })
        return Promise.reject(new Error('no /dev/kvm'))
      },
      snapshot: (): Promise<SnapshotInfo> => Promise.resolve({ name: 'x', sizeBytes: null }),
      listSandboxes: () => Promise.resolve([]),
      listSnapshots: () => Promise.resolve([]),
      destroy: (sandboxName: string) => {
        calls.push({ method: 'destroy', args: [sandboxName] })
        return Promise.resolve()
      },
      removeSnapshot: () => Promise.resolve(),
      ensureVolume: () => Promise.resolve(),
      removeVolume: () => Promise.resolve(),
    }
    const result = await verifyTask({
      driver,
      worktree: repo,
      projectId: 'p1',
      taskId: 't1',
      headSha: 'headsha1',
      runbook: baseRunbook(),
      runbookSha: '0123456789abcdef',
      validatedSha: sha,
      snapshotName: 'codesema-p1-hash',
      timeoutMs: 5000,
    })
    expect(result.status).toBe('error')
    expect(result.error).toContain('no /dev/kvm')
    expect(calls.some((c) => c.method === 'destroy')).toBe(false)
  })

  test('the sandbox is always destroyed, even after a passing run', async () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    const { driver, calls } = fakeDriver(() => ok())
    await verifyTask({
      driver,
      worktree: repo,
      projectId: 'p1',
      taskId: 't1',
      headSha: 'headsha1',
      runbook: baseRunbook(),
      runbookSha: '0123456789abcdef',
      validatedSha: sha,
      snapshotName: 'codesema-p1-hash',
      timeoutMs: 5000,
    })
    const destroy = calls.find((c) => c.method === 'destroy')
    expect(destroy?.args[0]).toBe('codesema-verify-t1')
  })

  test('captureProof runs after healthchecks pass and before runbook.tests', async () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    const { driver, calls } = fakeDriver(() => ok())
    const result = await verifyTask({
      driver,
      worktree: repo,
      projectId: 'p1',
      taskId: 't1',
      headSha: 'headsha1',
      runbook: baseRunbook({ healthchecks: ['curl -f http://localhost:3000'] }),
      runbookSha: '0123456789abcdef',
      validatedSha: sha,
      snapshotName: 'codesema-p1-hash',
      timeoutMs: 5000,
      captureProof: async (handle) => {
        await handle.shell('proof-marker', { timeoutMs: 1000, cwd: '/work' })
      },
    })
    expect(result.status).toBe('passed')
    const shellCommands = calls.filter((c) => c.method === 'shell').map((c) => c.args[0])
    expect(shellCommands).toEqual(['curl -f http://localhost:3000', 'proof-marker', 'npm test'])
  })

  test('captureProof is not called when healthchecks never pass', async () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    const { driver } = fakeDriver((command) =>
      command === 'curl -f http://localhost:3000' ? ok({ code: 1, stderr: 'not up' }) : ok(),
    )
    let called = false
    const result = await verifyTask({
      driver,
      worktree: repo,
      projectId: 'p1',
      taskId: 't1',
      headSha: 'headsha1',
      runbook: baseRunbook({ healthchecks: ['curl -f http://localhost:3000'] }),
      runbookSha: '0123456789abcdef',
      validatedSha: sha,
      snapshotName: 'codesema-p1-hash',
      timeoutMs: 5000,
      healthcheckDeadlineMs: 10,
      healthcheckRetryDelayMs: 1,
      captureProof: async () => {
        called = true
      },
    })
    expect(result.status).toBe('error')
    expect(called).toBe(false)
  })

  test('an exception from captureProof is swallowed and never changes the verdict', async () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    const { driver } = fakeDriver(() => ok())
    const result = await verifyTask({
      driver,
      worktree: repo,
      projectId: 'p1',
      taskId: 't1',
      headSha: 'headsha1',
      runbook: baseRunbook(),
      runbookSha: '0123456789abcdef',
      validatedSha: sha,
      snapshotName: 'codesema-p1-hash',
      timeoutMs: 5000,
      captureProof: async () => {
        throw new Error('proof capture boom')
      },
    })
    expect(result.status).toBe('passed')
    expect(result.checks).toHaveLength(1)
  })

  test('carries head_sha and runbook_sha through, on every status', async () => {
    const repo = makeRepo()
    const sha = commitSha(repo)
    const { driver } = fakeDriver(() => ok())
    const result = await verifyTask({
      driver,
      worktree: repo,
      projectId: 'p1',
      taskId: 't1',
      headSha: 'deadbeef00',
      runbook: baseRunbook(),
      runbookSha: 'fedcba9876543210',
      validatedSha: sha,
      snapshotName: 'codesema-p1-hash',
      timeoutMs: 5000,
    })
    expect(result.head_sha).toBe('deadbeef00')
    expect(result.runbook_sha).toBe('fedcba9876543210')
    expect(result.started_at).toBeTruthy()
    expect(result.finished_at).toBeTruthy()
  })
})

function validVerification(overrides: Partial<TaskVerification> = {}): TaskVerification {
  return {
    head_sha: 'a1b2c3d4e5',
    runbook_sha: '0123456789abcdef',
    started_at: '2026-01-01T00:00:00.000Z',
    finished_at: '2026-01-01T00:05:00.000Z',
    status: 'passed',
    checks: [],
    integrity_ok: true,
    changed_dependency_files: [],
    error: null,
    ...overrides,
  }
}

describe('readTaskVerification / writeTaskVerification / removeTaskVerification', () => {
  test('a never-run task has no verification', () => {
    const repo = makeRepo()
    const task = createTask(repo, {
      title: 'x',
      prompt: 'x',
      autoShip: false,
      base: '',
      branch: '',
      worktree: '',
      isolation: 'microvm',
    })
    expect(readTaskVerification(repo, task.id)).toBeNull()
  })

  test('write then read round-trips the sanitized verification', () => {
    const repo = makeRepo()
    const task = createTask(repo, {
      title: 'x',
      prompt: 'x',
      autoShip: false,
      base: '',
      branch: '',
      worktree: '',
      isolation: 'microvm',
    })
    const written = writeTaskVerification(repo, task.id, validVerification())
    expect(written).toEqual(validVerification())
    expect(readTaskVerification(repo, task.id)).toEqual(validVerification())
  })

  test('each write overwrites the previous run', () => {
    const repo = makeRepo()
    const task = createTask(repo, {
      title: 'x',
      prompt: 'x',
      autoShip: false,
      base: '',
      branch: '',
      worktree: '',
      isolation: 'microvm',
    })
    writeTaskVerification(repo, task.id, validVerification({ status: 'passed' }))
    writeTaskVerification(repo, task.id, validVerification({ status: 'failed' }))
    expect(readTaskVerification(repo, task.id)?.status).toBe('failed')
  })

  test('an unknown task id reads as null and refuses to write', () => {
    const repo = makeRepo()
    expect(readTaskVerification(repo, 'not-a-task-id')).toBeNull()
    expect(() => writeTaskVerification(repo, 'not-a-task-id', validVerification())).toThrow()
  })

  test('removeTaskVerification erases the file; reading it back is null', () => {
    const repo = makeRepo()
    const task = createTask(repo, {
      title: 'x',
      prompt: 'x',
      autoShip: false,
      base: '',
      branch: '',
      worktree: '',
      isolation: 'microvm',
    })
    writeTaskVerification(repo, task.id, validVerification())
    removeTaskVerification(repo, task.id)
    expect(readTaskVerification(repo, task.id)).toBeNull()
    expect(existsSync(join(repo, '.codesema', 'tasks', task.id, 'verification.json'))).toBe(false)
  })

  test('removeTaskVerification on an absent file, or an unknown id, is a silent no-op', () => {
    const repo = makeRepo()
    const task = createTask(repo, {
      title: 'x',
      prompt: 'x',
      autoShip: false,
      base: '',
      branch: '',
      worktree: '',
      isolation: 'microvm',
    })
    expect(() => removeTaskVerification(repo, task.id)).not.toThrow()
    expect(() => removeTaskVerification(repo, 'not-a-task-id')).not.toThrow()
  })

  test('a malformed file on disk reads back as null rather than throwing', () => {
    const repo = makeRepo()
    const task = createTask(repo, {
      title: 'x',
      prompt: 'x',
      autoShip: false,
      base: '',
      branch: '',
      worktree: '',
      isolation: 'microvm',
    })
    writeFileSync(join(repo, '.codesema', 'tasks', task.id, 'verification.json'), 'not json')
    expect(readTaskVerification(repo, task.id)).toBeNull()
  })
})
