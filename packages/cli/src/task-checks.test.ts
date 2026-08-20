import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { containerGitStateDir } from './container-git.js'
import { TASK_CHECK_TAIL_MAX, type TaskChecks } from './contract.js'
import {
  bootstrapWorktreeInstall,
  DEFAULT_CHECK_TIMEOUT_SECONDS,
  DEFAULT_CHECKS_IMAGE,
  detectChecks,
  detectContainerRuntime,
  detectFromDeclarations,
  detectInstall,
  lockfileFingerprint,
  pkgCacheVolume,
  planFromConfig,
  resolveChecksPlan,
  runChecks,
  worktreeHasDeps,
  type ExecFn,
  type ExecResult,
} from './task-checks.js'

// --- rigs -----------------------------------------------------------------

let worktree: string
/** Extra fixtures (git repos, generated pointer dirs) removed after each test. */
const cleanupDirs: string[] = []

beforeEach(() => {
  worktree = mkdtempSync(join(tmpdir(), 'codesema-checks-'))
})

afterEach(() => {
  rmSync(worktree, { recursive: true, force: true })
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
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
    if (call.args[0] === 'volume') {
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
      source: 'scripts',
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

  test('npm/yarn lockfiles: node:26 + npm ci + npm run for present scripts only', () => {
    const plan = detectChecks({
      files: ['package-lock.json', 'package.json'],
      packageJson: packageJson({ test: 'vitest', lint: 'eslint .' }),
    })
    expect(plan).toEqual({
      image: DEFAULT_CHECKS_IMAGE,
      install: 'npm ci',
      commands: ['npm run test', 'npm run lint'],
      network: true,
      timeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS,
      source: 'scripts',
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
      source: 'scripts',
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

describe('detectInstall', () => {
  test('npm lockfile with no check scripts still has an install step', () => {
    expect(
      detectInstall({
        files: ['package-lock.json', 'package.json'],
        packageJson: packageJson({ build: 'tsc -b' }),
      }),
    ).toEqual({
      image: DEFAULT_CHECKS_IMAGE,
      install: 'npm ci',
      timeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS,
    })
  })

  test('package.json without a lockfile falls back to npm install', () => {
    expect(detectInstall({ files: ['package.json'] })?.install).toBe('npm install')
  })

  test('bun lockfile wins and uses frozen install', () => {
    expect(detectInstall({ files: ['bun.lock', 'package-lock.json'] })).toEqual({
      image: 'oven/bun:1',
      install: 'bun install --frozen-lockfile',
      timeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS,
    })
  })

  test('nothing recognizable: null', () => {
    expect(detectInstall({ files: ['README.md'] })).toBeNull()
  })
})

describe('lockfileFingerprint / worktreeHasDeps', () => {
  test('hashes the first present lockfile and is stable', () => {
    writeFileSync(join(worktree, 'package-lock.json'), '{"lockfileVersion":2}')
    const a = lockfileFingerprint(worktree)
    const b = lockfileFingerprint(worktree)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(a).toBe(b)
    writeFileSync(join(worktree, 'package-lock.json'), '{"lockfileVersion":3}')
    expect(lockfileFingerprint(worktree)).not.toBe(a)
  })

  test('deps are present only when node_modules or .venv exists', () => {
    expect(worktreeHasDeps(worktree)).toBe(false)
    mkdirSync(join(worktree, 'node_modules'))
    expect(worktreeHasDeps(worktree)).toBe(true)
  })
})

describe('bootstrapWorktreeInstall', () => {
  test('unconfigured worktree never probes a runtime', async () => {
    const { calls, exec } = fakeExec(() => ok())
    const result = await bootstrapWorktreeInstall({
      worktree,
      projectId: 'aaaa1111bbbb',
      execFn: exec,
    })
    expect(result.status).toBe('unconfigured')
    expect(calls).toEqual([])
  })

  test('skips when the lockfile hash matches and node_modules is there', async () => {
    writeFileSync(join(worktree, 'package-lock.json'), '{"lockfileVersion":2}')
    mkdirSync(join(worktree, 'node_modules'))
    const hash = lockfileFingerprint(worktree)
    const { calls, exec } = dockerRig(() => ok())
    const result = await bootstrapWorktreeInstall({
      worktree,
      projectId: 'aaaa1111bbbb',
      previousFingerprint: hash,
      execFn: exec,
    })
    expect(result.status).toBe('skipped')
    expect(result.fingerprint).toBe(hash)
    expect(calls).toEqual([])
  })

  test('installs with network, cache volume, and host uid when the worktree is fresh', async () => {
    writeFileSync(join(worktree, 'package-lock.json'), '{"lockfileVersion":2}')
    const started: string[] = []
    const { calls, exec } = dockerRig(() => ok({ stdout: 'added 10 packages' }))
    const result = await bootstrapWorktreeInstall({
      worktree,
      projectId: 'projdeadbeef',
      uid: 1000,
      gid: 1000,
      execFn: exec,
      onStart: (command) => started.push(command),
    })
    expect(result.status).toBe('passed')
    expect(started).toEqual(['npm ci'])
    const volume = calls.find((c) => c.args[0] === 'volume')
    expect(volume?.args).toEqual(['volume', 'create', pkgCacheVolume('projdeadbeef')])
    const run = calls.find((c) => c.args[0] === 'run')
    expect(run?.args).toContain('npm ci')
    expect(run?.args).not.toContain('--network')
    expect(run?.args.join(' ')).toContain(`${pkgCacheVolume('projdeadbeef')}:/cache`)
    expect(run?.args).toContain('--user')
    expect(run?.args[run.args.indexOf('--user') + 1]).toBe('1000:1000')
  })

  test('reinstalls a matching hash when node_modules is gone (rebuilt worktree)', async () => {
    writeFileSync(join(worktree, 'package-lock.json'), '{"lockfileVersion":2}')
    const hash = lockfileFingerprint(worktree)
    const { calls, exec } = dockerRig(() => ok())
    const result = await bootstrapWorktreeInstall({
      worktree,
      projectId: 'projdeadbeef',
      previousFingerprint: hash,
      execFn: exec,
    })
    expect(result.status).toBe('passed')
    expect(calls.some((c) => c.args[0] === 'run')).toBe(true)
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
      source: 'config',
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
      source: 'config',
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

  // Check commands are the repo's own: hooks, version stamps and test rigs
  // shell out to git, which a LINKED worktree alone cannot answer (its `.git`
  // is a pointer at a host path outside the mount).
  test('the repo git dir is mounted read-only and safe.directory is set', async () => {
    const root = mkdtempSync(join(tmpdir(), 'codesema-checks-git-'))
    cleanupDirs.push(root)
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
    const linked = join(root, 'wt')
    run(['worktree', 'add', linked, '-b', 'task'])
    cleanupDirs.push(containerGitStateDir(linked))
    writeFileSync(join(linked, 'bun.lock'), '')

    const { calls, exec } = dockerRig(() => ok())
    await runChecks({ worktree: linked, headSha: 'abc', execFn: exec })
    const args = calls.find((c) => c.args.at(-1) === 'bun test')?.args ?? []
    expect(args).toContain(`${join(repo, '.git')}:/gitcommon:ro`)
    expect(args.some((arg) => arg.endsWith(':/work/.git:ro'))).toBe(true)
    expect(args).toContain('GIT_CONFIG_VALUE_0=/work')
  })

  test('a plain worktree adds no git mount at all', async () => {
    writeFileSync(join(worktree, 'bun.lock'), '')
    const { calls, exec } = dockerRig(() => ok())
    await runChecks({ worktree, headSha: 'abc', execFn: exec })
    const args = calls.find((c) => c.args.at(-1) === 'bun test')?.args ?? []
    expect(args.filter((arg) => arg === '-v')).toHaveLength(1)
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
    // No plan resolved: there is no provenance to claim.
    expect(result.source).toBeUndefined()
  })

  test('the run stamps the plan provenance on every snapshot', async () => {
    writeFileSync(join(worktree, 'bun.lock'), '')
    const snapshots: TaskChecks[] = []
    const { exec } = dockerRig(() => ok())
    const result = await runChecks({
      worktree,
      headSha: 'abc',
      execFn: exec,
      onUpdate: (snapshot) => snapshots.push(snapshot),
    })
    expect(result.source).toBe('scripts')
    expect(snapshots.length).toBeGreaterThan(0)
    expect(snapshots.every((s) => s.source === 'scripts')).toBe(true)
    // An explicit config relabels the same run.
    const configured = await runChecks({
      worktree,
      config: { image: 'node:22', commands: ['npm run test'] },
      headSha: 'abc',
      execFn: exec,
    })
    expect(configured.source).toBe('config')
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

// --- detectFromDeclarations (pure) ----------------------------------------

/** Verbatim copy of THIS repository's lefthook.yml — the reference fixture. */
const CODESEMA_LEFTHOOK = `pre-commit:
  commands:
    secrets:
      run: gitleaks protect --staged --redact
    format:
      glob: '*'
      run: bunx prettier --write --ignore-unknown {staged_files}
      stage_fixed: true
    lint:
      glob: '*.{ts,mjs,vue}'
      run: bunx oxlint {staged_files}

pre-push:
  commands:
    typecheck:
      run: bun run typecheck
    test:
      run: bun run test
`

describe('detectFromDeclarations', () => {
  test("this repo's lefthook.yml: pre-push commands only, gitleaks and bunx filtered out", () => {
    const declared = detectFromDeclarations([{ path: 'lefthook.yml', content: CODESEMA_LEFTHOOK }])
    // bunx is NOT bun: the first token must be an allowed binary, and the
    // lefthook `{staged_files}` template is not runnable in a container.
    expect(declared).toEqual({
      commands: ['bun run typecheck', 'bun run test'],
      source: 'lefthook',
    })
  })

  test('lefthook: pre-push before pre-commit, unknown binaries dropped, typecheck→test→lint order', () => {
    const content = `pre-commit:
  commands:
    format:
      run: bunx prettier --write {staged_files}
    lint:
      run: npm run lint
    audit:
      run: docker run --rm scanner
pre-push:
  commands:
    test:
      run: pnpm test
    types:
      run: pnpm typecheck
`
    expect(detectFromDeclarations([{ path: 'lefthook.yml', content }])).toEqual({
      commands: ['pnpm typecheck', 'pnpm test', 'npm run lint'],
      source: 'lefthook',
    })
  })

  test('lefthook: install steps and shell plumbing never become checks', () => {
    const content = `pre-push:
  commands:
    deps:
      run: bun install --frozen-lockfile
    chained:
      run: bun run build && bun test
    piped:
      run: bun test | tee out.txt
    subshell:
      run: node -e "console.log($(whoami))"
    ok:
      run: make check
`
    expect(detectFromDeclarations([{ path: 'lefthook.yml', content }])).toEqual({
      commands: ['make check'],
      source: 'lefthook',
    })
  })

  test('lefthook: deduplicated and capped at six commands', () => {
    const commands = Array.from(
      { length: 10 },
      (_, i) => `    job${i}:\n      run: make target${i}\n`,
    ).join('')
    const content = `pre-push:\n  commands:\n${commands}    dup:\n      run: make target0\n`
    const declared = detectFromDeclarations([{ path: 'lefthook.yml', content }])
    expect(declared?.commands).toEqual([
      'make target0',
      'make target1',
      'make target2',
      'make target3',
      'make target4',
      'make target5',
    ])
  })

  test('github workflow: only verification jobs, block scalars split line by line', () => {
    const content = `name: CI
on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t app .
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install
        run: npm ci
      - name: Verify
        run: |
          npm run typecheck
          npm test
      - name: Report
        run: curl -X POST https://example.com/report
  deploy:
    name: Deploy to production
    needs: [test]
    steps:
      - run: npm run deploy
`
    expect(detectFromDeclarations([{ path: '.github/workflows/ci.yml', content }])).toEqual({
      commands: ['npm run typecheck', 'npm test'],
      source: 'ci',
    })
  })

  test('github workflow: a job named "Lint & types" counts even with a neutral id', () => {
    const content = `jobs:
  quality:
    name: Lint and types
    steps:
      - run: yarn lint
  release:
    steps:
      - run: yarn publish
`
    expect(detectFromDeclarations([{ path: '.github/workflows/main.yaml', content }])).toEqual({
      commands: ['yarn lint'],
      source: 'ci',
    })
  })

  test('lefthook wins over CI when both declare commands', () => {
    const declared = detectFromDeclarations([
      {
        path: '.github/workflows/ci.yml',
        content: 'jobs:\n  test:\n    steps:\n      - run: go test ./...\n',
      },
      { path: 'lefthook.yml', content: CODESEMA_LEFTHOOK },
    ])
    expect(declared?.source).toBe('lefthook')
  })

  test('unreadable or irrelevant YAML yields null instead of guesses', () => {
    expect(
      detectFromDeclarations([
        { path: 'lefthook.yml', content: '::: not: yaml [ at all\n\t\trun\n' },
        { path: '.github/workflows/broken.yml', content: '%%%%\n  - - - :\n' },
      ]),
    ).toBeNull()
    expect(detectFromDeclarations([])).toBeNull()
    // A file that is not a declaration file is ignored entirely.
    expect(
      detectFromDeclarations([{ path: 'docs/lefthook.md', content: 'run: bun test' }]),
    ).toBeNull()
  })
})

// --- resolveChecksPlan (precedence) ---------------------------------------

describe('resolveChecksPlan', () => {
  const bunRepo = (): void => {
    writeFileSync(join(worktree, 'bun.lock'), '')
    writeFileSync(
      join(worktree, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc', test: 'bun test', lint: 'oxlint' } }),
    )
  }

  test('explicit config wins over declarations and lockfiles', () => {
    bunRepo()
    writeFileSync(join(worktree, 'lefthook.yml'), CODESEMA_LEFTHOOK)
    const plan = resolveChecksPlan({
      worktree,
      config: { image: 'node:22', commands: ['npm run only-this'] },
    })
    expect(plan).toMatchObject({
      image: 'node:22',
      commands: ['npm run only-this'],
      source: 'config',
    })
  })

  test('source labels the level that produced the commands', () => {
    bunRepo()
    // Level 3 alone: the lockfile/scripts heuristic.
    expect(resolveChecksPlan({ worktree })?.source).toBe('scripts')
    // Level 2, CI flavour.
    mkdirSync(join(worktree, '.github', 'workflows'), { recursive: true })
    writeFileSync(
      join(worktree, '.github', 'workflows', 'ci.yml'),
      'jobs:\n  checks:\n    steps:\n      - run: bun run ci\n',
    )
    expect(resolveChecksPlan({ worktree })?.source).toBe('ci')
    // Level 2, lefthook flavour — which outranks CI.
    writeFileSync(join(worktree, 'lefthook.yml'), CODESEMA_LEFTHOOK)
    expect(resolveChecksPlan({ worktree })?.source).toBe('lefthook')
    // Level 1: an explicit config outranks everything.
    expect(resolveChecksPlan({ worktree, config: { commands: ['make check'] } })?.source).toBe(
      'config',
    )
  })

  test('declarations replace the detected commands but keep image and install', () => {
    bunRepo()
    writeFileSync(
      join(worktree, 'lefthook.yml'),
      'pre-push:\n  commands:\n    all:\n      run: make check\n',
    )
    expect(resolveChecksPlan({ worktree })).toEqual({
      image: 'oven/bun:1',
      install: 'bun install --frozen-lockfile',
      commands: ['make check'],
      network: true,
      timeoutSeconds: DEFAULT_CHECK_TIMEOUT_SECONDS,
      source: 'lefthook',
    })
  })

  test('CI declarations are read from .github/workflows', () => {
    bunRepo()
    mkdirSync(join(worktree, '.github', 'workflows'), { recursive: true })
    writeFileSync(
      join(worktree, '.github', 'workflows', 'ci.yml'),
      'jobs:\n  checks:\n    steps:\n      - run: bun run ci\n',
    )
    expect(resolveChecksPlan({ worktree })?.commands).toEqual(['bun run ci'])
  })

  test('without declarations the lockfile plan is untouched', () => {
    bunRepo()
    expect(resolveChecksPlan({ worktree })?.commands).toEqual([
      'bun run typecheck',
      'bun run test',
      'bun run lint',
    ])
  })

  test('declarations alone provide no image, hence no plan', () => {
    writeFileSync(join(worktree, 'lefthook.yml'), CODESEMA_LEFTHOOK)
    expect(resolveChecksPlan({ worktree })).toBeNull()
  })

  test('runChecks runs the declared commands end to end', async () => {
    bunRepo()
    writeFileSync(join(worktree, 'lefthook.yml'), CODESEMA_LEFTHOOK)
    const { calls, exec } = dockerRig(() => ok())
    const result = await runChecks({ worktree, headSha: 'abc', execFn: exec })
    expect(result.status).toBe('passed')
    expect(result.checks.map((c) => c.command)).toEqual([
      'bun install --frozen-lockfile',
      'bun run typecheck',
      'bun run test',
    ])
    expect(calls.some((c) => c.args.at(-1) === 'bun run lint')).toBe(false)
  })
})
