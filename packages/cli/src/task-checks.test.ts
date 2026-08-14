import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { TASK_CHECK_TAIL_MAX, type TaskChecks } from './contract.js'
import {
  DEFAULT_CHECK_TIMEOUT_SECONDS,
  DEFAULT_CHECKS_IMAGE,
  detectChecks,
  detectContainerRuntime,
  planFromConfig,
  runChecks,
  type ExecFn,
  type ExecResult,
} from './task-checks.js'

// --- rigs -----------------------------------------------------------------

let worktree: string

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), 'codesema-checks-'))
})

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true })
})

const ok = (over: Partial<ExecResult> = {}): ExecResult => ({
  code: 0,
  stdout: '',
  stderr: '',
  timedOut: false,
  failure: null,
  ...over,
})

type Call = { file: string; args: string[]; timeoutMs: number }

/**
 * Scripted exec: records every host-side call and answers by rule. NEVER
 * spawns anything — that is the whole point of the seam.
 */
function fakeExec(respond: (call: Call) => ExecResult): { calls: Call[]; exec: ExecFn } {
  const calls: Call[] = []
  const exec: ExecFn = (file, args, opts) => {
    const call = { file, args, timeoutMs: opts.timeoutMs }
    calls.push(call)
    return Promise.resolve(respond(call))
  }
  return { calls, exec }
}

/** Rule: docker exists; `sh -lc <command>` steps answered per command. */
function dockerRig(byCommand: (command: string, call: Call) => ExecResult) {
  return fakeExec((call) => {
    if (call.args[0] === '--version') {
      return call.file === 'docker' ? ok({ stdout: 'Docker version 27' }) : ok({ code: 1 })
    }
    if (call.args[0] === 'kill') {
      return ok()
    }
    const command = call.args.at(-1) ?? ''
    return byCommand(command, call)
  })
}

const packageJson = (scripts: Record<string, string>) => ({ scripts })

// --- detectChecks (pure) --------------------------------------------------

describe('detectChecks', () => {
  test('bun repo: image oven/bun, frozen install, scripts mapped to bun run', () => {
    const plan = detectChecks({
      files: ['bun.lock', 'package.json', 'src'],
      packageJson: packageJson({ typecheck: 'tsc', test: 'bun test', lint: 'oxlint' }),
    })
    expect(plan).toEqual({
      image: 'oven/bun:1',
      install: 'bun install --frozen-lockfile',
      commands: ['bun run typecheck', 'bun run test', 'bun run lint'],
      network: true,
      timeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS,
    })
  })

  test('bun repo without a test script falls back to the built-in bun test', () => {
    const plan = detectChecks({
      files: ['bun.lockb', 'package.json'],
      packageJson: packageJson({ lint: 'oxlint' }),
    })
    expect(plan?.commands).toEqual(['bun test', 'bun run lint'])
  })

  test('bun repo without package.json still runs bun test', () => {
    expect(detectChecks({ files: ['bun.lock'] })?.commands).toEqual(['bun test'])
  })

  test('npm/yarn lockfiles: node:22 + npm ci + npm run for present scripts only', () => {
    const plan = detectChecks({
      files: ['package-lock.json', 'package.json'],
      packageJson: packageJson({ test: 'vitest', lint: 'eslint .' }),
    })
    expect(plan).toEqual({
      image: 'node:22',
      install: 'npm ci',
      commands: ['npm run test', 'npm run lint'],
      network: true,
      timeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS,
    })
    expect(
      detectChecks({
        files: ['yarn.lock', 'package.json'],
        packageJson: packageJson({ typecheck: 'tsc' }),
      })?.commands,
    ).toEqual(['npm run typecheck'])
  })

  test('node repo with none of the three scripts: nothing to check', () => {
    expect(
      detectChecks({
        files: ['package-lock.json', 'package.json'],
        packageJson: packageJson({ build: 'tsc -b' }),
      }),
    ).toBeNull()
  })

  test('bun wins over npm lockfiles when both are present', () => {
    const plan = detectChecks({ files: ['bun.lock', 'package-lock.json'] })
    expect(plan?.image).toBe('oven/bun:1')
  })

  test('pyproject: python + pytest only when the project declares pytest', () => {
    const plan = detectChecks({
      files: ['pyproject.toml'],
      pyproject: '[project.optional-dependencies]\ndev = ["pytest>=8"]\n',
    })
    expect(plan).toEqual({
      image: 'python:3.12',
      install: 'pip install -e .',
      commands: ['pytest'],
      network: true,
      timeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS,
    })
    expect(
      detectChecks({ files: ['pyproject.toml'], pyproject: '[project]\nname = "x"\n' }),
    ).toBeNull()
  })

  test('nothing recognizable: null (unconfigured)', () => {
    expect(detectChecks({ files: ['README.md', 'Makefile'] })).toBeNull()
    expect(detectChecks({ files: [] })).toBeNull()
  })
})

describe('planFromConfig', () => {
  test('commands are the essence: none (or only blanks) = unconfigured', () => {
    expect(planFromConfig({})).toBeNull()
    expect(planFromConfig({ image: 'node:22' })).toBeNull()
    expect(planFromConfig({ commands: ['  '] })).toBeNull()
  })

  test('defaults: fallback image, no install, no network, default timeout', () => {
    expect(planFromConfig({ commands: ['make check'] })).toEqual({
      image: DEFAULT_CHECKS_IMAGE,
      install: null,
      commands: ['make check'],
      network: false,
      timeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS,
    })
  })

  test('explicit fields pass through; a bad timeout falls back', () => {
    expect(
      planFromConfig({
        image: 'golang:1.23',
        install: 'go mod download',
        commands: ['go vet ./...', 'go test ./...'],
        network: true,
        timeoutSeconds: 60,
      }),
    ).toEqual({
      image: 'golang:1.23',
      install: 'go mod download',
      commands: ['go vet ./...', 'go test ./...'],
      network: true,
      timeoutSeconds: 60,
    })
    expect(planFromConfig({ commands: ['x'], timeoutSeconds: -5 })?.timeoutSeconds).toBe(
      DEFAULT_CHECK_TIMEOUT_SECONDS,
    )
  })
})

// --- runtime detection ----------------------------------------------------

describe('detectContainerRuntime', () => {
  test('docker first', async () => {
    const { exec } = fakeExec(() => ok())
    expect(await detectContainerRuntime(exec)).toBe('docker')
  })

  test('podman when docker is missing', async () => {
    const { exec } = fakeExec((call) =>
      call.file === 'podman' ? ok() : ok({ code: null, failure: 'spawn docker ENOENT' }),
    )
    expect(await detectContainerRuntime(exec)).toBe('podman')
  })

  test('null when neither answers', async () => {
    const { exec } = fakeExec(() => ok({ code: null, failure: 'ENOENT' }))
    expect(await detectContainerRuntime(exec)).toBeNull()
  })
})

// --- runChecks ------------------------------------------------------------

describe('runChecks', () => {
  test('caged container invocation: rw mount of the worktree only, no network, cpu/mem caps', async () => {
    writeFileSync(join(worktree, 'bun.lock'), '')
    const { calls, exec } = dockerRig(() => ok({ stdout: 'all good' }))
    const result = await runChecks({ worktree, headSha: 'abc123', execFn: exec })

    expect(result.status).toBe('passed')
    expect(result.head_sha).toBe('abc123')
    expect(result.finished_at).not.toBeNull()
    // install + bun test
    expect(result.checks.map((c) => c.command)).toEqual([
      'bun install --frozen-lockfile',
      'bun test',
    ])
    expect(result.checks.every((c) => c.status === 'passed' && c.exit_code === 0)).toBe(true)

    const testRun = calls.find((c) => c.args.at(-1) === 'bun test')
    expect(testRun?.file).toBe('docker')
    const args = testRun?.args ?? []
    expect(args.slice(0, 2)).toEqual(['run', '--rm'])
    expect(args).toContain('-v')
    expect(args[args.indexOf('-v') + 1]).toBe(`${worktree}:/work:rw`)
    expect(args[args.indexOf('-w') + 1]).toBe('/work')
    expect(args[args.indexOf('--cpus') + 1]).toBe('2')
    expect(args[args.indexOf('--memory') + 1]).toBe('2g')
    expect(args.slice(-3)).toEqual(['sh', '-lc', 'bun test'])
    // Check commands NEVER get network...
    expect(args[args.indexOf('--network') + 1]).toBe('none')
    // ...while the detected install step does (fresh worktree, registry needed).
    const install = calls.find((c) => c.args.at(-1) === 'bun install --frozen-lockfile')
    expect(install?.args).not.toContain('--network')
  })

  test('a failing check keeps a nonzero exit and does NOT skip later checks', async () => {
    writeFileSync(join(worktree, 'bun.lock'), '')
    writeFileSync(
      join(worktree, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc', lint: 'oxlint' } }),
    )
    const { exec } = dockerRig((command) =>
      command === 'bun run typecheck' ? ok({ code: 2, stderr: 'TS2322: type error' }) : ok(),
    )
    const result = await runChecks({ worktree, headSha: 'abc', execFn: exec })
    expect(result.status).toBe('failed')
    expect(result.checks.map((c) => [c.command, c.status])).toEqual([
      ['bun install --frozen-lockfile', 'passed'],
      ['bun run typecheck', 'failed'],
      ['bun test', 'passed'],
      ['bun run lint', 'passed'],
    ])
    expect(result.checks[1]?.exit_code).toBe(2)
    expect(result.checks[1]?.tail).toContain('TS2322')
  })

  test('a failing INSTALL skips every remaining check', async () => {
    writeFileSync(join(worktree, 'bun.lock'), '')
    const { exec } = dockerRig((command) =>
      command.startsWith('bun install') ? ok({ code: 1, stderr: 'lockfile mismatch' }) : ok(),
    )
    const result = await runChecks({ worktree, headSha: 'abc', execFn: exec })
    expect(result.status).toBe('failed')
    expect(result.checks.map((c) => c.status)).toEqual(['failed', 'skipped'])
    expect(result.checks[1]?.exit_code).toBeNull()
  })

  test('timeout: check marked timeout, the container is killed by name, later checks still run', async () => {
    const config = { image: 'node:22', commands: ['sleep 999', 'echo ok'], timeoutSeconds: 1 }
    const { calls, exec } = dockerRig((command) =>
      command === 'sleep 999' ? ok({ code: null, timedOut: true }) : ok(),
    )
    const result = await runChecks({ worktree, config, headSha: 'abc', execFn: exec })
    expect(result.status).toBe('failed')
    expect(result.checks.map((c) => c.status)).toEqual(['timeout', 'passed'])
    expect(result.checks[0]?.exit_code).toBeNull()

    // The per-check timeout reached the exec, and the still-running container
    // was killed by its unique --name (killing the client alone leaves it up).
    const run = calls.find((c) => c.args.at(-1) === 'sleep 999')
    expect(run?.timeoutMs).toBe(1000)
    const name = run?.args[run.args.indexOf('--name') + 1] ?? ''
    expect(name).toMatch(/^codesema-checks-[0-9a-f]{12}$/)
    const kill = calls.find((c) => c.args[0] === 'kill')
    expect(kill?.args).toEqual(['kill', name])
  })

  test('no container runtime: readable error, no check ever attempted', async () => {
    writeFileSync(join(worktree, 'bun.lock'), '')
    const { calls, exec } = fakeExec(() => ok({ code: null, failure: 'spawn docker ENOENT' }))
    const result = await runChecks({ worktree, headSha: 'abc', execFn: exec })
    expect(result.status).toBe('error')
    expect(result.error).toContain('docker or podman')
    expect(result.checks).toEqual([])
    // Only the two --version probes ran.
    expect(calls.every((c) => c.args[0] === '--version')).toBe(true)
  })

  test('a spawn failure mid-run becomes status error and skips the rest', async () => {
    const config = { image: 'node:22', commands: ['a', 'b', 'c'] }
    const { exec } = dockerRig((command) =>
      command === 'b' ? ok({ code: null, failure: 'docker daemon went away' }) : ok(),
    )
    const result = await runChecks({ worktree, config, headSha: 'abc', execFn: exec })
    expect(result.status).toBe('error')
    expect(result.error).toBe('docker daemon went away')
    expect(result.checks.map((c) => c.status)).toEqual(['passed', 'failed', 'skipped'])
  })

  test('tail keeps only the LAST ~4000 chars of stdout+stderr', async () => {
    const config = { image: 'node:22', commands: ['noisy'] }
    const { exec } = dockerRig(() =>
      ok({ code: 1, stdout: 'x'.repeat(6000), stderr: 'FINAL VERDICT' }),
    )
    const result = await runChecks({ worktree, config, headSha: 'abc', execFn: exec })
    expect(result.checks[0]?.tail.length).toBe(TASK_CHECK_TAIL_MAX)
    expect(result.checks[0]?.tail.endsWith('FINAL VERDICT')).toBe(true)
  })

  test('nothing detected and no config: unconfigured, no exec call at all', async () => {
    const { calls, exec } = fakeExec(() => ok())
    const result = await runChecks({ worktree, headSha: 'abc', execFn: exec })
    expect(result.status).toBe('unconfigured')
    expect(result.finished_at).not.toBeNull()
    expect(calls).toEqual([])
  })

  test('explicit config REPLACES detection (image, commands, network flag)', async () => {
    // The worktree looks like a bun repo, but the config says otherwise.
    writeFileSync(join(worktree, 'bun.lock'), '')
    const config = {
      image: 'golang:1.23',
      install: 'go mod download',
      commands: ['go test ./...'],
      network: false,
    }
    const { calls, exec } = dockerRig(() => ok())
    const result = await runChecks({ worktree, config, headSha: 'abc', execFn: exec })
    expect(result.status).toBe('passed')
    expect(result.checks.map((c) => c.command)).toEqual(['go mod download', 'go test ./...'])
    const install = calls.find((c) => c.args.at(-1) === 'go mod download')
    expect(install?.args).toContain(config.image)
    // network: false cages the install step too.
    expect(install?.args[install.args.indexOf('--network') + 1]).toBe('none')
  })

  test('onUpdate: initial running snapshot, then one growing snapshot per step; final only returned', async () => {
    writeFileSync(join(worktree, 'bun.lock'), '')
    const { exec } = dockerRig(() => ok())
    const snapshots: TaskChecks[] = []
    const result = await runChecks({
      worktree,
      headSha: 'abc',
      execFn: exec,
      onUpdate: (snapshot) => snapshots.push(structuredClone(snapshot)),
    })
    // install + bun test = 2 steps → 1 initial + 2 progress snapshots.
    expect(snapshots.length).toBe(3)
    expect(snapshots[0]).toMatchObject({ status: 'running', finished_at: null, checks: [] })
    expect(snapshots[1]?.checks.length).toBe(1)
    expect(snapshots[2]?.checks.length).toBe(2)
    expect(snapshots.every((s) => s.status === 'running')).toBe(true)
    expect(result.status).toBe('passed')
  })
})
